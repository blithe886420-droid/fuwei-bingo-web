/**
 * auto-train.js - v36 SQL驗證優化版
 */

import { createClient } from '@supabase/supabase-js';
import { buildBingoGroups } from '../lib/buildBingoV1Strategies.js';
import { buildComparePayload } from '../lib/buildComparePayload.js';

const PREDICTIONS_TABLE  = 'bingo_predictions';
const STRATEGY_STATS_TABLE = 'strategy_stats';
const DRAWS_TABLE        = 'bingo_draws';
const MODE               = 'formal_3star';
const COST_PER_GROUP     = 25;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE env');
  return createClient(url, key, { auth: { persistSession: false } });
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round4(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

async function fetchLatestDraw(db) {
  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchRecent30(db) {
  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('draw_no, numbers')
    .order('draw_no', { ascending: false })
    .limit(30);
  if (error) throw error;
  return data || [];
}

async function fetchRecent3Predictions(db) {
  const { data, error } = await db
    .from(PREDICTIONS_TABLE)
    .select('status, hit_count, groups_json, compare_result_json')
    .eq('mode', MODE)
    .order('created_at', { ascending: false })
    .limit(3);
  if (error) throw error;
  return (data || []).map(p => ({
    status: p.status,
    hit_count: p.hit_count || 0,
    groups_count: Array.isArray(p.groups_json) ? p.groups_json.length : 0,
    pool_size: p.groups_json?.[0]?.meta?.hot_pool_size || 0,
    // ★ 傳入 position 和 action 給策略函數判斷連續爆發次數
    position: p.groups_json?.[0]?.meta?.position || '',
    action: p.groups_json?.[0]?.meta?.action || '',
    hot_pool: p.groups_json?.[0]?.meta?.hot_pool || '',
    hit2_groups: Array.isArray(p.compare_result_json?.detail)
      ? p.compare_result_json.detail.filter(d => d?.hit === 2).length
      : 0,
  }));
}

async function fetchNextDraw(db, sourceDrawNo) {
  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .gt('draw_no', sourceDrawNo)
    .order('draw_no', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function buildRandomGroups() {
  const pool = Array.from({length: 80}, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const selected = pool.slice(0, 5);
  const groups = [];
  for (let i = 0; i < selected.length; i++)
    for (let j = i+1; j < selected.length; j++)
      for (let k = j+1; k < selected.length; k++) {
        const nums = [selected[i], selected[j], selected[k]].sort((a,b)=>a-b);
        const key = `r${nums[0]}_${nums[1]}_${nums[2]}`;
        groups.push({ key, label: key, nums, meta: { type: 'random', strategy_key: key } });
      }
  return groups;
}

async function createPrediction(db, latestDrawNo, groups, latestDrawNumbers) {
  const { data: existing } = await db
    .from(PREDICTIONS_TABLE)
    .select('id, status')
    .eq('mode', MODE)
    .eq('source_draw_no', String(latestDrawNo))
    .maybeSingle();

  if (existing?.id) {
    console.log(`[auto-train] draw_no=${latestDrawNo} 已有預測，跳過`);
    return null;
  }

  const { data, error } = await db
    .from(PREDICTIONS_TABLE)
    .insert({
      mode: MODE,
      status: 'created',
      source_draw_no: String(latestDrawNo),
      target_periods: 1,
      groups_json: groups,
      compare_status: 'pending',
      latest_draw_numbers: latestDrawNumbers,
      created_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();

  if (error) throw error;
  console.log(`[auto-train] 新預測建立 draw_no=${latestDrawNo} id=${data?.id}`);
  return data;
}

async function comparePending(db) {
  const { data: predictions, error } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .in('mode', [MODE, 'random_test'])
    .eq('status', 'created')
    .eq('compare_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) throw error;
  if (!predictions || predictions.length === 0) return { processed: 0 };

  let processed = 0;

  for (const prediction of predictions) {
    const sourceDrawNo = toNum(prediction.source_draw_no, 0);
    if (!sourceDrawNo) continue;

    const nextDraw = await fetchNextDraw(db, sourceDrawNo);
    if (!nextDraw) {
      console.log(`[comparePending] draw_no=${sourceDrawNo} 下一期尚未開獎，等待`);
      continue;
    }

    const groups = Array.isArray(prediction.groups_json) ? prediction.groups_json : [];
    const { compareResult } = buildComparePayload({
      groups,
      drawRows: [nextDraw],
      costPerGroupPerPeriod: COST_PER_GROUP,
      starMode: 3,
    });

    const bestHit = toNum(compareResult?.best_hit, 0);
    const verdict = compareResult?.best_reward > 0 ? 'good' : 'bad';

    const resultSummary = {
      best_hit: compareResult?.best_hit || 0,
      best_reward: compareResult?.best_reward || 0,
      total_cost: compareResult?.total_cost || 0,
      total_reward: compareResult?.total_reward || 0,
      roi: compareResult?.roi || 0,
      groups_count: groups.length,
      draw_nums: compareResult?.draw_nums || [],
      detail: [
        ...(compareResult?.detail || []).filter(d => d?.hit >= 3),
        ...(compareResult?.detail || []).filter(d => d?.hit === 2),
        ...(compareResult?.detail || []).filter(d => d?.hit <= 1),
      ].slice(0, 20),
    };

    await db
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'compared',
        compare_status: 'done',
        compare_result_json: resultSummary,
        hit_count: bestHit,
        best_single_hit: bestHit,
        verdict,
        compared_at: new Date().toISOString(),
      })
      .eq('id', prediction.id);

    processed++;
    console.log(`[comparePending] draw_no=${sourceDrawNo} 比對完成 best_hit=${bestHit} verdict=${verdict}`);
  }

  return { processed };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const taipeiHour = (new Date().getUTCHours() + 8) % 24;
  if (taipeiHour >= 0 && taipeiHour < 7) {
    console.log(`[auto-train] 非營業時間 ${taipeiHour}:xx，跳過`);
    return res.status(200).json({ ok: true, skipped: true, reason: '非營業時間' });
  }

  try {
    const db = getSupabase();

    const compareResult = await comparePending(db);

    const latestDraw = await fetchLatestDraw(db);
    if (!latestDraw) {
      return res.status(200).json({ ok: false, error: '無法取得最新開獎資料' });
    }

    const latestDrawNo = toNum(latestDraw.draw_no, 0);
    const latestDrawNumbers = String(latestDraw.numbers || '');

    const recent30 = await fetchRecent30(db);
    // ★ fetchRecent3Predictions 現在也回傳 position 和 action
    const recent3Predictions = await fetchRecent3Predictions(db);
    const groups = buildBingoGroups(recent30, latestDrawNo, recent3Predictions);

    if (groups.length === 0) {
      console.log(`[auto-train] 本期無符合條件，跳過 draw_no=${latestDrawNo}`);
      const { data: existing } = await db
        .from(PREDICTIONS_TABLE)
        .select('id')
        .eq('mode', MODE)
        .eq('source_draw_no', String(latestDrawNo))
        .maybeSingle();

      if (!existing?.id) {
        await db.from(PREDICTIONS_TABLE).insert({
          mode: MODE,
          status: 'skipped',
          source_draw_no: String(latestDrawNo),
          target_periods: 1,
          groups_json: [],
          compare_status: 'skipped',
          latest_draw_numbers: latestDrawNumbers,
          created_at: new Date().toISOString(),
        });
      }
      return res.status(200).json({
        ok: true,
        latest_draw_no: latestDrawNo,
        compared_count: toNum(compareResult?.processed, 0),
        created_count: 0,
        groups_count: 0,
        skipped: true,
        reason: '冷場期',
      });
    }

    const prediction = await createPrediction(db, latestDrawNo, groups, latestDrawNumbers);

    const randomGroups = buildRandomGroups();
    const { data: existingRandom } = await db
      .from(PREDICTIONS_TABLE)
      .select('id')
      .eq('mode', 'random_test')
      .eq('source_draw_no', String(latestDrawNo))
      .maybeSingle();
    if (!existingRandom?.id) {
      await db.from(PREDICTIONS_TABLE).insert({
        mode: 'random_test',
        status: 'created',
        source_draw_no: String(latestDrawNo),
        target_periods: 1,
        groups_json: randomGroups,
        compare_status: 'pending',
        latest_draw_numbers: latestDrawNumbers,
        created_at: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      ok: true,
      latest_draw_no: latestDrawNo,
      compared_count: toNum(compareResult?.processed, 0),
      created_count: prediction ? 1 : 0,
      groups_count: groups.length,
    });

  } catch (error) {
    console.error('[auto-train] error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
