/**
 * auto-train.js - V0629-3
 *
 * ★ V0629-3更新(6/29)：配合board-combo-revalidate V0629-3三項智慧升級
 * 1. fetchComboWeights補讀best_zm_strategy（ZM盤面匹配最佳策略）
 *    方向三連勝連敗動態組數已直接存入max_combos，不需要額外改動
 * 2. fetchRecentPredictions補讀zm_bias_type，供方向二ZM盤面匹配使用
 *
 * ★ V0628-1更新(6/28)：
 * 1. 加入熱號錨點策略（streak_anchor）——空窗期改用連續2期以上熱號組合出手
 * 2. comparePending加入streak_anchor的比對
 * 原本空窗期完全不出手，現在用錨點策略填補空窗，累積真實命中率資料
 * 原本15筆在E_false_momentum連續霸佔時，同盤面命中率計算樣本太少，容易誤判冷場
 * 30筆讓回饋迴路有更穩定的記憶，不被短期冷場誤判
 * 封印機制已完全拆除（V0626-3），靈魂異常警示改為緊急警告（V0626-3）
 * emergency_alert在連續虧損18期以上時觸發，回傳給前端顯示紅色橫幅
 *
 * ★ V0623-2更新(6/23)：fetchRecentPredictions新增board_state和selection_strategy欄位，
 * limit從5提升到10。目的：供buildBingoV1Strategies.js的回饋迴路使用，讓系統能計算
 * 「近期同一盤面的命中率」，實現有記憶的動態出手調整（冷場盤面自動降為4組觀望）。
 *
 * ★ V0621-2更新(6/21)：fetchRecentPredictions新增total_qualified欄位，供
 * buildBingoV1Strategies.js計算「TQ急跌」軌跡訊號使用(比較這期TQ跟上一期TQ，
 * 急跌超過4視為偏差警訊，6/21用SQL驗證前後兩段穩定性測試通過)。groups_json
 * 本來就有被查詢進來、裡面包著meta.total_qualified，這次只是把它從.map()裡
 * 額外取出來，不需要更動SELECT查詢語句，風險低。
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
import { buildBingoGroups, buildStreakAnchorGroups } from '../lib/buildBingoV1Strategies.js';
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

async function fetchRecentPredictions(db, limit = 30) { // ★ V0627-1：limit從15提升到30，讓回饋迴路有更長記憶，不被短期冷場誤判
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
    total_qualified: p.groups_json?.[0]?.meta?.total_qualified ?? null,
    board_state: p.groups_json?.[0]?.meta?.board_state || '', // ★ V0623-2新增：供回饋迴路計算近期盤面成績
    selection_strategy: p.groups_json?.[0]?.meta?.selection_strategy || '', // ★ V0623-2新增：供回饋迴路追蹤各策略近期表現
    zm_bias_type: p.groups_json?.[0]?.meta?.zm_bias_type || '', // ★ V0629-3：供ZM盤面匹配感知使用
  }));
}

// ★ 靈魂核心：讀取近期表現，計算自動微調信號
// 過濾掉verdict='anomaly'的異常期(系統bug造成的不正常資料)
async function fetchRecentPerformance(db) {
  const { data, error } = await db
    .from(PREDICTIONS_TABLE)
    .select('groups_json, compare_result_json, created_at')
    .eq('mode', MODE)
    .eq('status', 'compared')
    .eq('compare_status', 'done')
    .neq('verdict', 'anomaly')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error || !data || data.length === 0) {
    return { avgPnl30: -84, avgPnl10: -84, consecutiveLoss: 0, modeStats: {} };
  }

  // 各mode統計(用全部500筆)
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

  const cleanPeriods = data.length;
  const oldestDate = new Date(data[data.length - 1]?.created_at);
  const daysPassed = (Date.now() - oldestDate) / (1000 * 60 * 60 * 24);
  // ★ V0626-3：封印機制已拆除，移除isSealBroken/sealStatus計算和輸出

  // 近30期用於信心等級判斷(avgPnl30維持跨天，反映較長期的整體趨勢)
  const recent30 = data.slice(0, 30);
  const pnlList = recent30.map(p => {
    const detail = p.compare_result_json?.detail || [];
    return detail.reduce((sum, e) => {
      const hit = toNum(e?.hit, 0);
      return sum + (hit === 3 ? 500 : hit === 2 ? 50 : 0);
    }, 0) - 200;
  });

  const avgPnl30 = pnlList.length > 0
    ? pnlList.reduce((a, b) => a + b, 0) / pnlList.length : -84;

  // ★ V0618-2修正：avgPnl10改為只計算「當天(台北時間)」範圍的資料
  // 根因：V0618-1只修正了consecutiveLoss的當日限制，但calcConfidenceLevel裡
  // 判斷conservative用的`avgPnl10 < -150`條件，沒有同步修正，依然會用跨天的舊資料，
  // 導致即使consecutiveLoss已經正常(只看今天)，avgPnl10仍可能因為昨天的爛資料觸發conservative，
  // 這是V0618-1修正不完整造成的漏洞，今天才意識到要把today範圍的計算統一起來，不要顧此失彼。
  const todayTaipeiDateStr = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const todayPnlList = [];
  for (const p of recent30) {
    const pTaipeiDateStr = new Date(new Date(p.created_at).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (pTaipeiDateStr !== todayTaipeiDateStr) break; // 超出今天範圍，停止收集
    const pnl = (p.compare_result_json?.detail || []).reduce((sum, e) => {
      const hit = toNum(e?.hit, 0);
      return sum + (hit === 3 ? 500 : hit === 2 ? 50 : 0);
    }, 0) - 200;
    todayPnlList.push(pnl);
  }
  const avgPnl10 = todayPnlList.slice(0, 10).length > 0
    ? todayPnlList.slice(0, 10).reduce((a, b) => a + b, 0) / todayPnlList.slice(0, 10).length : 0;

  let consecutiveLoss = 0;
  for (const pnl of todayPnlList) {
    if (pnl < 0) consecutiveLoss++;
    else break;
  }

  return { avgPnl30, avgPnl10, consecutiveLoss, modeStats };
}

// ★ 靈魂決策：根據近期表現決定信心等級
// ★★★ V0618-3：暫停靈魂第二階段 ★★★
// 用戶決定：第二階段(信心等級判斷)這幾天反覆出現邏輯bug(統計頁倒扣假象、
// 連續虧損跨天污染、avgPnl10同樣漏洞)，暫停運作，回到「只看訊號計數器決定
// 要不要出手」的單純狀態。第三階段(signal_weights)維持運作不受影響。
// 停用方式：函數保留、所有呼叫端完全不變，只是內部邏輯永遠回傳'normal'，
// 這樣soul_blocked永遠不會被觸發，meta/log寫入結構也都不需要跟著修改，風險最小。
// 如果之後想重新啟用，只需把下面這行return提早的部分移除即可，原邏輯都還在。
function calcConfidenceLevel(perf) {
  // ★ V0626-3：封印機制已拆除。
  // 原本需要100期+strong模式20期才能解封，但strong模式幾乎不觸發，
  // 系統一直卡在learning封印狀態，是過時的設計，直接移除。
  return 'normal';

  /* ↓↓↓ 以下為原邏輯，暫停期間不會被執行到，保留供之後重新啟用參考 ↓↓↓
  if (consecutiveLoss >= 13) {
    console.log(`[靈魂] 今日連續虧損${consecutiveLoss}期，進入冷靜期，只允許strong/ultra出手`);
    return 'cautious';
  }

  if (consecutiveLoss >= 8 || avgPnl10 < -150) {
    console.log(`[靈魂] 今日連續虧損${consecutiveLoss}期或近10期avg=${avgPnl10.toFixed(0)}，進入保守模式`);
    return 'conservative';
  }

  if (avgPnl30 > 0) {
    console.log(`[靈魂] 近30期avg=${avgPnl30.toFixed(0)}，維持積極模式`);
    return 'aggressive';
  }

  console.log(`[靈魂] 近30期avg=${avgPnl30.toFixed(0)}，維持正常模式`);
  return 'normal';
  */
}

// ★ V0626-1：讀取board_combo_weights表，取得各盤面+four_count組合的動態出手組數和最佳策略
// V0626-1升級：回傳物件格式 {max_combos, best_strategy}，支援策略自動切換
async function fetchComboWeights(db) {
  const { data, error } = await db
    .from('board_combo_weights')
    .select('combo_key, board_state, four_count, max_combos, history_json');
  if (error || !data) {
    console.log('[board_combo_weights] 讀取失敗，使用預設8組');
    return {};
  }
  const result = {};
  for (const row of data) {
    // 從history_json的最新一筆取得best_strategy和best_zm_strategy
    const lastHistory = Array.isArray(row.history_json) && row.history_json.length > 0
      ? row.history_json[row.history_json.length - 1]
      : null;
    const bestStrategy = lastHistory?.best_strategy || null;
    const bestZmStrategy = lastHistory?.best_zm_strategy || null; // ★ V0629-3：ZM盤面匹配最佳策略
    result[row.combo_key] = {
      max_combos: row.max_combos,
      best_strategy: bestStrategy,
      best_zm_strategy: bestZmStrategy, // ★ V0629-3：供buildBingoGroups的ZM盤面匹配使用
    };
  }
  return result;
}

// ★ V0616-4：讀取signal_weights表，組成傳給buildBingoGroups的開關物件
async function fetchSignalEnabled(db) {
  const { data, error } = await db
    .from('signal_weights')
    .select('signal_key, is_enabled');
  if (error || !data) {
    console.log('[signal_weights] 讀取失敗，全部訊號預設啟用');
    return {};
  }
  const result = {};
  for (const row of data) {
    result[row.signal_key] = row.is_enabled !== false;
  }
  return result;
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
    .in('mode', [MODE, 'random_test', 'streak_anchor'])
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

    // ★ V0626-3：移除靈魂狀態log，封印機制已拆除，confidenceLevel永遠是normal

    // ★ V0626-3：異常警示改為「緊急警告」，移除「靈魂」字眼
    // 連續虧損超過18期代表可能有系統問題，主動提醒人工檢查
    const emergencyAlert = perf.consecutiveLoss >= 18
      ? `⚠️ 緊急警告：已連續虧損${perf.consecutiveLoss}期，請人工檢查系統狀態`
      : null;
    if (emergencyAlert) {
      console.warn(`[緊急警告] ${emergencyAlert}`);
    }

    // 4. 取得開獎資料和預測歷史
    const recent30 = await fetchRecent30Draws(db);
    const recentPredictions = await fetchRecentPredictions(db, 30);

    // 4.5 ★ V0616-4：讀取訊號開關狀態(由signal-revalidate.js定期更新)
    const signalEnabled = await fetchSignalEnabled(db);

    // 4.6 ★ V0625-1：讀取盤面組合動態出手組數(由board-combo-revalidate.js每小時更新)
    const comboWeights = await fetchComboWeights(db);

    // 5. 選號（★ V0625-1：加入comboWeights供動態出手組數使用）
    const groups = buildBingoGroups(recent30, latestDrawNo, recentPredictions, signalEnabled, comboWeights);

    // 6. ★ 靈魂：根據信心等級決定是否出手
    const activeMode = groups[0]?.meta?.active_mode || 'standard';
    const totalSignals = toNum(groups[0]?.meta?.total_signals, 0);

    let shouldOutput = groups.length > 0;
    // ★ V0626-3：封印機制已拆除，confidenceLevel永遠是normal，不再有learning/cautious/conservative分支
    // normal/aggressive：不額外限制，buildBingoGroups自己的skip條件已處理

    if (!shouldOutput || groups.length === 0) {
      const skipReason = groups.length === 0 ? 'no_signal' : 'soul_blocked';
      console.log(`[auto-train] 本期不出手 draw_no=${latestDrawNo} mode=${activeMode} confidence=${confidenceLevel} reason=${skipReason}`);

      // ★ V0628-1：空窗期改用熱號錨點策略出手（streak_anchor）
      // 連續2期以上出現的號碼當錨點，按組合邏輯產生4-8組
      const streakGroups = buildStreakAnchorGroups(recent30);
      if (streakGroups.length > 0) {
        console.log(`[auto-train] 空窗期熱號錨點策略出手 draw_no=${latestDrawNo} anchors=${streakGroups[0]?.meta?.anchor_nums?.join('/')} groups=${streakGroups.length}`);
        const { data: existingStreak } = await db
          .from(PREDICTIONS_TABLE)
          .select('id')
          .eq('mode', 'streak_anchor')
          .eq('source_draw_no', String(latestDrawNo))
          .maybeSingle();

        if (!existingStreak?.id) {
          await db.from(PREDICTIONS_TABLE).insert({
            mode: 'streak_anchor',
            status: 'created',
            source_draw_no: String(latestDrawNo),
            target_periods: 1,
            groups_json: streakGroups,
            compare_status: 'pending',
            latest_draw_numbers: latestDrawNumbers,
            created_at: new Date().toISOString(),
          });
        }
      }

      const { data: existing } = await db
        .from(PREDICTIONS_TABLE)
        .select('id')
        .eq('mode', MODE)
        .eq('source_draw_no', String(latestDrawNo))
        .maybeSingle();

      if (!existing?.id) {
        const skipDiagnostics = groups.__skipDiagnostics || {};
        await db.from(PREDICTIONS_TABLE).insert({
          mode: MODE,
          status: 'skipped',
          source_draw_no: String(latestDrawNo),
          target_periods: 1,
          groups_json: [{ key: 'skip_meta', label: 'skip_meta', nums: [], meta: {
            ...skipDiagnostics,
            active_mode: activeMode,
            total_signals: totalSignals,
            confidence_level: confidenceLevel,
            skip_reason: skipReason,
          } }],
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
        streak_anchor_groups: streakGroups.length,
        skipped: true,
        reason: skipReason === 'no_signal' ? '選號條件不符' : `靈魂封鎖(${confidenceLevel})`,
        confidence_level: confidenceLevel,
        avg_pnl_30: Math.round(perf.avgPnl30),
        avg_pnl_10: Math.round(perf.avgPnl10),
        consecutive_loss: perf.consecutiveLoss,
      });
    }

    // 7. ★ V0616-3：把靈魂的confidence_level注入第一組的meta，讓前端能顯示
    if (groups[0]?.meta) {
      groups[0].meta.confidence_level = confidenceLevel;
    }
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
      emergency_alert: emergencyAlert, // ★ V0626-3：緊急警告，前端第一頁頂端顯示
    });

  } catch (error) {
    console.error('[auto-train] error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
