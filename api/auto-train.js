/**
 * auto-train.js - V0615-3
 *
 * ★ V0615-3 重大升級：加入「近期表現感知」自動微調靈魂
 *
 * 靈魂機制：
 * 1. 每次觸發時，先讀取最近30期的實際結果
 * 2. 計算各mode(ultra/strong/standard)的近期avg_pnl
 * 3. 根據近期表現動態調整信心等級：
 *    - 近30期avg_pnl > 0 → 正常出手
 *    - 近30期avg_pnl < -150 → 保守模式(只出ultra/strong)
 *    - 近10期連續虧損 → 冷靜期(skip 2期再恢復)
 * 4. 把感知結果傳給buildBingoGroups，讓選號邏輯知道當前狀態
 */

import { createClient } from '@supabase/supabase-js';
import { buildBingoGroups } from '../lib/buildBingoV1Strategies.js';
import { buildComparePayload } from '../lib/buildComparePayload.js';

const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';
const MODE = 'formal_3star';
const COST_PER_GROUP = 25;

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

async function fetchRecent30Draws(db) {
  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('draw_no, numbers')
    .order('draw_no', { ascending: false })
    .limit(30);
  if (error) throw error;
  return data || [];
}

async function fetchRecentPredictions(db, limit = 5) {
  const { data, error } = await db
    .from(PREDICTIONS_TABLE)
    .select('status, hit_count, groups_json, compare_result_json')
    .eq('mode', MODE)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(p => ({
    status: p.status,
    hit_count: p.hit_count || 0,
    groups_count: Array.isArray(p.groups_json) ? p.groups_json.length : 0,
    position: p.groups_json?.[0]?.meta?.position || '',
    action: p.groups_json?.[0]?.meta?.action || '',
    hot_pool: p.groups_json?.[0]?.meta?.hot_pool || '',
    hit2_groups: Array.isArray(p.compare_result_json?.detail)
      ? p.compare_result_json.detail.filter(d => d?.hit === 2).length
      : 0,
  }));
}

// ★ 靈魂核心：讀取近期表現，計算自動微調信號
async function fetchRecentPerformance(db) {
  const { data, error } = await db
    .from(PREDICTIONS_TABLE)
    .select('groups_json, compare_result_json')
    .eq('mode', MODE)
    .eq('status', 'compared')
    .eq('compare_status', 'done')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error || !data || data.length === 0) {
    return { avgPnl30: -84, avgPnl10: -84, consecutiveLoss: 0, modeStats: {} };
  }

  // 計算每期淨利
  const pnlList = data.map(p => {
    const detail = p.compare_result_json?.detail || [];
    return detail.reduce((sum, e) => {
      const hit = toNum(e?.hit, 0);
      return sum + (hit === 3 ? 500 : hit === 2 ? 50 : 0);
    }, 0) - 200;
  });

  const avgPnl30 = pnlList.length > 0
    ? pnlList.reduce((a, b) => a + b, 0) / pnlList.length : -84;
  const avgPnl10 = pnlList.slice(0, 10).length > 0
    ? pnlList.slice(0, 10).reduce((a, b) => a + b, 0) / pnlList.slice(0, 10).length : -84;

  // 計算連續虧損期數
  let consecutiveLoss = 0;
  for (const pnl of pnlList) {
    if (pnl < 0) consecutiveLoss++;
    else break;
  }

  // 各mode近期表現
  const modeStats = {};
  for (const p of data) {
    const mode = p.groups_json?.[0]?.meta?.active_mode || 'standard';
    const detail = p.compare_result_json?.detail || [];
    const pnl = detail.reduce((sum, e) => {
      const hit = toNum(e?.hit, 0);
      return sum + (hit === 3 ? 500 : hit === 2 ? 50 : 0);
    }, 0) - 200;
    if (!modeStats[mode]) modeStats[mode] = { total: 0, count: 0 };
    modeStats[mode].total += pnl;
    modeStats[mode].count++;
  }

  return { avgPnl30, avgPnl10, consecutiveLoss, modeStats };
}

// ★ 靈魂決策：根據近期表現決定信心等級
function calcConfidenceLevel(perf) {
  const { avgPnl30, avgPnl10, consecutiveLoss } = perf;

  // 連續虧損10期以上 → 冷靜期，只允許ultra出手
  if (consecutiveLoss >= 10) {
    console.log(`[靈魂] 連續虧損${consecutiveLoss}期，進入冷靜期，只允許ultra出手`);
    return 'cautious';
  }

  // 近10期嚴重虧損 → 保守模式，只允許strong/ultra出手
  if (avgPnl10 < -150) {
    console.log(`[靈魂] 近10期avg=${avgPnl10.toFixed(0)}，進入保守模式`);
    return 'conservative';
  }

  // 近30期表現良好 → 積極模式，所有模式都出手
  if (avgPnl30 > 0) {
    console.log(`[靈魂] 近30期avg=${avgPnl30.toFixed(0)}，維持積極模式`);
    return 'aggressive';
  }

  // 正常模式
  console.log(`[靈魂] 近30期avg=${avgPnl30.toFixed(0)}，維持正常模式`);
  return 'normal';
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
  const pool = Array.from({ length: 80 }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const selected = pool.slice(0, 5);
  const groups = [];
  for (let i = 0; i < selected.length; i++)
    for (let j = i + 1; j < selected.length; j++)
      for (let k = j + 1; k < selected.length; k++) {
        const nums = [selected[i], selected[j], selected[k]].sort((a, b) => a - b);
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

    // 1. 先比對待處理的預測
    const compareResult = await comparePending(db);

    // 2. 取得最新開獎
    const latestDraw = await fetchLatestDraw(db);
    if (!latestDraw) {
      return res.status(200).json({ ok: false, error: '無法取得最新開獎資料' });
    }

    const latestDrawNo = toNum(latestDraw.draw_no, 0);
    const latestDrawNumbers = String(latestDraw.numbers || '');

    // 3. ★ 靈魂：讀取近期表現，計算信心等級
    const perf = await fetchRecentPerformance(db);
    const confidenceLevel = calcConfidenceLevel(perf);

    console.log(`[靈魂狀態] level=${confidenceLevel} avg30=${perf.avgPnl30.toFixed(0)} avg10=${perf.avgPnl10.toFixed(0)} 連虧=${perf.consecutiveLoss}期`);
    console.log(`[靈魂modeStats] ${JSON.stringify(Object.entries(perf.modeStats).map(([k,v]) => `${k}:${(v.total/v.count).toFixed(0)}(${v.count}筆)`))}`);

    // 4. 取得開獎資料和預測歷史
    const recent30 = await fetchRecent30Draws(db);
    const recentPredictions = await fetchRecentPredictions(db, 5);

    // 5. 選號
    const groups = buildBingoGroups(recent30, latestDrawNo, recentPredictions);

    // 6. ★ 靈魂：根據信心等級決定是否出手
    const activeMode = groups[0]?.meta?.active_mode || 'standard';
    const totalSignals = toNum(groups[0]?.meta?.total_signals, 0);

    let shouldOutput = groups.length > 0;

    if (confidenceLevel === 'cautious') {
      // 冷靜期：只允許ultra(4+訊號)出手
      shouldOutput = activeMode === 'ultra';
      if (!shouldOutput) console.log(`[靈魂] 冷靜期封鎖 mode=${activeMode}，只允許ultra`);
    } else if (confidenceLevel === 'conservative') {
      // 保守期：只允許strong/ultra出手
      shouldOutput = ['ultra', 'strong'].includes(activeMode);
      if (!shouldOutput) console.log(`[靈魂] 保守期封鎖 mode=${activeMode}，只允許strong/ultra`);
    }
    // normal/aggressive：不額外限制，buildBingoGroups自己的skip條件已處理

    if (!shouldOutput || groups.length === 0) {
      console.log(`[auto-train] 本期不出手 draw_no=${latestDrawNo} mode=${activeMode} confidence=${confidenceLevel}`);

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
        reason: groups.length === 0 ? '選號條件不符' : `靈魂封鎖(${confidenceLevel})`,
        confidence_level: confidenceLevel,
        avg_pnl_30: Math.round(perf.avgPnl30),
        avg_pnl_10: Math.round(perf.avgPnl10),
        consecutive_loss: perf.consecutiveLoss,
      });
    }

    // 7. 建立預測
    const prediction = await createPrediction(db, latestDrawNo, groups, latestDrawNumbers);

    // 8. 同步建立隨機對照組
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
      active_mode: activeMode,
      total_signals: totalSignals,
      confidence_level: confidenceLevel,
      avg_pnl_30: Math.round(perf.avgPnl30),
      avg_pnl_10: Math.round(perf.avgPnl10),
      consecutive_loss: perf.consecutiveLoss,
    });

  } catch (error) {
    console.error('[auto-train] error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
