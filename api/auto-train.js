/**
 * auto-train.js - v20 純覆蓋效率版
 *
 * 流程：
 * 1. 取得最新開獎號碼
 * 2. 用覆蓋效率邏輯選出8組號碼
 * 3. 存入 bingo_predictions（status=created）
 * 4. 比對上一期的預測結果
 * 5. 寫入 strategy_stats
 */

import { createClient } from '@supabase/supabase-js';
import { buildBingoGroups } from '../lib/buildBingoV1Strategies.js';
import { buildComparePayload } from '../lib/buildComparePayload.js';

// ── 常數 ─────────────────────────────────────────
const PREDICTIONS_TABLE  = 'bingo_predictions';
const STRATEGY_STATS_TABLE = 'strategy_stats';
const DRAWS_TABLE        = 'bingo_draws';
const MODE               = 'formal_3star';
const COST_PER_GROUP     = 25;

// ── Supabase ──────────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE env');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── 工具函數 ──────────────────────────────────────
function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round4(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

// ── 取得最新開獎 ──────────────────────────────────
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

// ── 取得最近20期 ──────────────────────────────────
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
    hit2_groups: Array.isArray(p.compare_result_json?.detail)
      ? p.compare_result_json.detail.filter(d => d?.hit === 2).length
      : 0,
  }));
}

// ── 取得下一期開獎資料（用來比對） ────────────────
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

// ── 純隨機選號（對照組）────────────────────────────
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

// ── 建立預測 ──────────────────────────────────────
async function createPrediction(db, latestDrawNo, groups, latestDrawNumbers) {
  // 確認此期是否已有預測
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

// ── 比對待比對的預測 ──────────────────────────────
async function comparePending(db) {
  // 取得所有待比對的預測
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

    // 找下一期開獎資料
    const nextDraw = await fetchNextDraw(db, sourceDrawNo);
    if (!nextDraw) {
      console.log(`[comparePending] draw_no=${sourceDrawNo} 下一期尚未開獎，等待`);
      continue;
    }

    // 比對
    const groups = Array.isArray(prediction.groups_json) ? prediction.groups_json : [];
    const { compareResult } = buildComparePayload({
      groups,
      drawRows: [nextDraw],
      costPerGroupPerPeriod: COST_PER_GROUP,
      starMode: 3,
    });

    const bestHit = toNum(compareResult?.best_hit, 0);
    const verdict = compareResult?.best_reward > 0 ? 'good' : 'bad';

    // 只存摘要，不存完整 compare_result_json（避免幾百組 JSON 太大）
    const resultSummary = {
      best_hit: compareResult?.best_hit || 0,
      best_reward: compareResult?.best_reward || 0,
      total_cost: compareResult?.total_cost || 0,
      total_reward: compareResult?.total_reward || 0,
      roi: compareResult?.roi || 0,
      groups_count: groups.length,
      // detail 只存有中3的組
      detail: (compareResult?.detail || []).slice(0, 20),
    };

    // 更新 bingo_predictions
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

    // 四週期全排列版本組數太多，跳過 strategy_stats 寫入
    // await updateStrategyStats(db, compareResult);

    processed++;
    console.log(`[comparePending] draw_no=${sourceDrawNo} 比對完成 best_hit=${bestHit} verdict=${verdict}`);
  }

  return { processed };
}

// ── 寫入 strategy_stats ───────────────────────────
async function updateStrategyStats(db, compareResult) {
  const detail = Array.isArray(compareResult?.strategy_detail)
    ? compareResult.strategy_detail
    : [];

  if (detail.length === 0) return;

  for (const sd of detail) {
    const key = String(sd?.strategy_key || '');
    if (!key) continue;

    const hit3Count = toNum(sd?.hit3, 0);
    const hit2Count = toNum(sd?.hit2, 0);
    const hit1Count = toNum(sd?.hit1, 0);
    const hit0Count = toNum(sd?.hit0, 0);
    const totalHits = toNum(sd?.total_hits, 0);
    const totalCost = toNum(sd?.total_cost, 0);
    const totalReward = toNum(sd?.total_reward, 0);
    const totalProfit = totalReward - totalCost;

    // 先讀現有數據
    const { data: existing } = await db
      .from(STRATEGY_STATS_TABLE)
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    const prev = existing || {};
    const prevRounds   = toNum(prev.total_rounds, 0);
    const newRounds    = prevRounds + 1;
    const newHits      = toNum(prev.total_hits, 0) + totalHits;
    const newHit0      = toNum(prev.hit0, 0) + hit0Count;
    const newHit1      = toNum(prev.hit1, 0) + hit1Count;
    const newHit2      = toNum(prev.hit2, 0) + hit2Count;
    const newHit3      = toNum(prev.hit3, 0) + hit3Count;
    const newCost      = toNum(prev.total_cost, 0) + totalCost;
    const newReward    = toNum(prev.total_reward, 0) + totalReward;
    const newProfit    = toNum(prev.total_profit, 0) + totalProfit;

    const avgHit  = newRounds > 0 ? round4(newHits / newRounds) : 0;
    const hitRate = newRounds > 0 ? round4((newHit2 + newHit3) / newRounds) : 0;
    const roi     = newCost > 0 ? round4(newProfit / newCost) : 0;

    // recent_hits：保留最近50筆
    const recentHits = Array.isArray(prev.recent_hits) ? prev.recent_hits : [];
    recentHits.push(totalHits);
    if (recentHits.length > 50) recentHits.shift();

    const recent50Hit3Rate = recentHits.length > 0
      ? round4(recentHits.filter(h => h >= 3).length / recentHits.length)
      : 0;

    const recentProfit = Array.isArray(prev.recent_profit) ? prev.recent_profit : [];
    recentProfit.push(totalProfit);
    if (recentProfit.length > 50) recentProfit.shift();

    const recentCost50 = recentProfit.length * COST_PER_GROUP;
    const recentProfit50Total = recentProfit.reduce((a, b) => a + b, 0);
    const recent50Roi = recentCost50 > 0 ? round4(recentProfit50Total / recentCost50) : 0;

    await db
      .from(STRATEGY_STATS_TABLE)
      .upsert({
        strategy_key: key,
        strategy_name: key,
        total_rounds: newRounds,
        total_hits: newHits,
        hit0: newHit0,
        hit1: newHit1,
        hit2: newHit2,
        hit3: newHit3,
        hit4: 0,
        avg_hit: avgHit,
        hit_rate: hitRate,
        hit3_rate: newRounds > 0 ? round4(newHit3 / newRounds) : 0,
        total_cost: newCost,
        total_reward: newReward,
        total_profit: newProfit,
        roi,
        recent_hits: recentHits,
        recent_profit: recentProfit,
        recent_50_hit_rate: recent50Hit3Rate,
        recent_50_roi: recent50Roi,
        recent_50_hit3_rate: recent50Hit3Rate,
        last_result_draw_no: toNum(compareResult?.draw_detail?.[0]?.draw_no, 0),
        last_updated: new Date().toISOString(),
      }, { onConflict: 'strategy_key' });
  }

  console.log(`[updateStrategyStats] 寫入 ${detail.length} 筆策略統計`);
}

// ── 主 handler ────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // 台灣時間 00:00~07:00 停止訓練
  const taipeiHour = (new Date().getUTCHours() + 8) % 24;
  if (taipeiHour >= 0 && taipeiHour < 7) {
    console.log(`[auto-train] 非營業時間 ${taipeiHour}:xx，跳過`);
    return res.status(200).json({ ok: true, skipped: true, reason: '非營業時間' });
  }

  try {
    const db = getSupabase();

    // Step 1: 比對待比對的預測（先比對再選號，避免同一期重複）
    const compareResult = await comparePending(db);

    // Step 2: 取得最新開獎
    const latestDraw = await fetchLatestDraw(db);
    if (!latestDraw) {
      return res.status(200).json({ ok: false, error: '無法取得最新開獎資料' });
    }

    const latestDrawNo = toNum(latestDraw.draw_no, 0);
    const latestDrawNumbers = String(latestDraw.numbers || '');

    // Step 3: 取得最近30期和最近3期預測，建立選號
    const recent30 = await fetchRecent30(db);
    const recent3Predictions = await fetchRecent3Predictions(db);
    const groups = buildBingoGroups(recent30, latestDrawNo, recent3Predictions);

    // Step 4: 存入預測（groups 為空時建立跳過記錄）
    if (groups.length === 0) {
      console.log(`[auto-train] 本期無符合條件熱號，跳過 draw_no=${latestDrawNo}`);
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
        reason: '四週期熱號不足',
      });
    }

    const prediction = await createPrediction(db, latestDrawNo, groups, latestDrawNumbers);

    // 同時跑純隨機對照組
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
