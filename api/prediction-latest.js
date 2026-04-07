import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-latest-market-role-v6-ui-compare-bridge-v4-appsync-summary-sync-v2';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';
const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';

const FORMAL_BATCH_LIMIT = 3;
const TEST_MODE = 'test';
const FORMAL_MODE = 'formal';
const FORMAL_CANDIDATE_MODE = 'formal_candidate';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round4(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map((n) => Number(n)).filter(Number.isFinite))]
    .filter((n) => n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return uniqueAsc(value);
  }

  if (typeof value === 'string') {
    return uniqueAsc(
      value
        .replace(/[{}[\]]/g, ' ')
        .split(/[,\s|/]+/)
        .map(Number)
    );
  }

  if (value && typeof value === 'object') {
    return parseDrawNumbers(
      value.numbers ||
        value.draw_numbers ||
        value.result_numbers ||
        value.open_numbers ||
        value.nums ||
        []
    );
  }

  return [];
}

function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return [];

  return groups
    .map((g, idx) => {
      if (Array.isArray(g)) {
        const nums = uniqueAsc(g).slice(0, 4);
        if (nums.length !== 4) return null;

        return {
          key: `group_${idx + 1}`,
          label: `第${idx + 1}組`,
          nums,
          reason: '',
          meta: {}
        };
      }

      if (!g || typeof g !== 'object') return null;

      const nums = uniqueAsc(
        Array.isArray(g.nums)
          ? g.nums
          : Array.isArray(g.numbers)
            ? g.numbers
            : Array.isArray(g.values)
              ? g.values
              : []
      ).slice(0, 4);

      if (nums.length !== 4) return null;

      const meta = g.meta && typeof g.meta === 'object' ? g.meta : {};

      return {
        key: g.key || meta.strategy_key || `group_${idx + 1}`,
        label: g.label || g.name || meta.strategy_name || `第${idx + 1}組`,
        nums,
        reason: g.reason || meta.strategy_name || '',
        meta
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function parseGroupsJson(value) {
  if (Array.isArray(value)) return normalizeGroups(value);

  if (typeof value === 'string') {
    try {
      return normalizeGroups(JSON.parse(value));
    } catch {
      return [];
    }
  }

  if (value && typeof value === 'object') {
    return normalizeGroups(value);
  }

  return [];
}


function safeJsonParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeCompareHistory(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizePredictionRow(row) {
  if (!row || typeof row !== 'object') return null;

  const groups = parseGroupsJson(
    row.groups_json ||
      row.groups ||
      row.prediction_groups ||
      row.strategies ||
      []
  );

  const compareResult =
    safeJsonParse(row.compare_result_json, null) ||
    safeJsonParse(row.compare_result, null) ||
    null;

  const compareHistory = normalizeCompareHistory(row.compare_history_json);

  return {
    ...row,
    mode: String(row.mode || '').trim().toLowerCase(),
    status: String(row.status || '').trim().toLowerCase() || 'created',
    source_draw_no: toInt(row.source_draw_no, 0),
    target_periods: toInt(row.target_periods, 1),
    hit_count: toInt(row.hit_count, toInt(compareResult?.hit_count, 0)),
    compare_status: row.compare_status || null,
    verdict: row.verdict || null,
    compare_result_json: compareResult,
    compare_history_json: compareHistory,
    groups_json: groups,
    groups,
    prediction_groups: groups,
    group_count: groups.length
  };
}


function getCompareDrawNo(row) {
  if (!row || typeof row !== 'object') return 0;

  const compareResult =
    row.compare_result_json && typeof row.compare_result_json === 'object'
      ? row.compare_result_json
      : safeJsonParse(row.compare_result_json, null);

  const detail = Array.isArray(compareResult?.detail) ? compareResult.detail : [];
  const firstDetail = detail.length && detail[0] && typeof detail[0] === 'object' ? detail[0] : null;

  return toInt(
    row?.draw_no ||
      row?.target_draw_no ||
      compareResult?.draw_no ||
      compareResult?.target_draw_no ||
      firstDetail?.draw_no ||
      firstDetail?.target_draw_no,
    0
  );
}

function buildRecentDrawSummary(rows = [], limit = 10) {
  const safeLimit = Math.max(1, Math.min(30, toInt(limit, 10)));
  const summaryMap = new Map();

  (Array.isArray(rows) ? rows : []).forEach((rawRow) => {
    const row = normalizePredictionRow(rawRow);
    if (!row) return;

    const drawNo = getCompareDrawNo(row);
    if (!drawNo) return;

    const current = summaryMap.get(drawNo) || {
      draw_no: drawNo,
      hit0_count: 0,
      hit1_count: 0,
      hit2_count: 0,
      hit3_count: 0,
      hit4_count: 0,
      row_count: 0,
      latest_created_at: row?.created_at || null
    };

    const hit = toInt(row?.hit_count, 0);
    current.row_count += 1;
    if (!current.latest_created_at || new Date(row?.created_at || 0).getTime() > new Date(current.latest_created_at || 0).getTime()) {
      current.latest_created_at = row?.created_at || current.latest_created_at;
    }

    if (hit <= 0) current.hit0_count += 1;
    else if (hit === 1) current.hit1_count += 1;
    else if (hit === 2) current.hit2_count += 1;
    else if (hit === 3) current.hit3_count += 1;
    else current.hit4_count += 1;

    summaryMap.set(drawNo, current);
  });

  return [...summaryMap.values()]
    .sort((a, b) => b.draw_no - a.draw_no)
    .slice(0, safeLimit);
}

function normalizeLeaderboardRow(row, poolRow = null) {
  if (!row || !row.strategy_key) return null;

  return {
    strategy_key: String(row.strategy_key || ''),
    strategy_name:
      poolRow?.strategy_name ||
      String(row.strategy_key || '')
        .split('_')
        .filter(Boolean)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' '),
    status: poolRow?.status || 'active',
    protected_rank: Boolean(poolRow?.protected_rank),
    avg_hit: round4(row.avg_hit),
    roi: round4(row.roi),
    recent_50_roi: round4(row.recent_50_roi),
    total_rounds: toInt(row.total_rounds, 0),
    hit2: toInt(row.hit2, 0),
    hit3: toInt(row.hit3, 0),
    hit4: toInt(row.hit4, 0),
    score: round4(row.score)
  };
}

async function getLatestRowByMode(mode) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', mode)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return normalizePredictionRow(data);
}

async function getLatestFormalSourceDrawNo() {
  const latestFormal = await getLatestRowByMode(FORMAL_MODE);
  if (latestFormal?.source_draw_no) return latestFormal.source_draw_no;

  const latestTest = await getLatestRowByMode(TEST_MODE);
  return latestTest?.source_draw_no || 0;
}

async function getFormalRowsBySourceDrawNo(sourceDrawNo) {
  if (!sourceDrawNo) return [];

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', FORMAL_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (Array.isArray(data) ? data : [])
    .map(normalizePredictionRow)
    .filter(Boolean)
    .map((row, idx) => ({
      ...row,
      formal_batch_no: idx + 1
    }));
}


async function getRecentComparedRows(limit = 10) {
  const safeLimit = Math.max(10, Math.min(50, toInt(limit, 10)));
  const fetchLimit = Math.max(5000, safeLimit * 100);

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('status', 'compared')
    .not('compare_result_json', 'is', null)
    .order('created_at', { ascending: false })
    .limit(fetchLimit);

  if (error) throw error;

  return (Array.isArray(data) ? data : [])
    .map(normalizePredictionRow)
    .filter(Boolean);
}

async function getStrategyLeaderboard(limit = 50) {
  const [{ data: statsRows, error: statsError }, { data: poolRows, error: poolError }] = await Promise.all([
    supabase
      .from(STRATEGY_STATS_TABLE)
      .select('strategy_key, avg_hit, roi, recent_50_roi, total_rounds, hit2, hit3, hit4, score')
      .order('score', { ascending: false })
      .limit(limit),
    supabase
      .from(STRATEGY_POOL_TABLE)
      .select('strategy_key, strategy_name, status, protected_rank')
  ]);

  if (statsError) throw statsError;
  if (poolError) throw poolError;

  const poolMap = new Map();
  for (const row of Array.isArray(poolRows) ? poolRows : []) {
    if (row?.strategy_key) {
      poolMap.set(row.strategy_key, row);
    }
  }

  return (Array.isArray(statsRows) ? statsRows : [])
    .map((row) => normalizeLeaderboardRow(row, poolMap.get(row.strategy_key) || null))
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.recent_50_roi !== a.recent_50_roi) return b.recent_50_roi - a.recent_50_roi;
      if (b.avg_hit !== a.avg_hit) return b.avg_hit - a.avg_hit;
      return b.total_rounds - a.total_rounds;
    })
    .slice(0, limit);
}

async function getRecentDrawRows(limit = 20) {
  const safeLimit = Math.max(5, Math.min(50, toInt(limit, 20)));

  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(safeLimit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function buildMarketStreakBuckets(drawRows = []) {
  const rows = (Array.isArray(drawRows) ? drawRows : [])
    .map((row) => ({
      draw_no: toInt(row?.draw_no, 0),
      draw_time: row?.draw_time || null,
      numbers: parseDrawNumbers(row?.numbers)
    }))
    .filter((row) => row.draw_no > 0);

  if (!rows.length) {
    return {
      lookback: 0,
      latest_draw_no: null,
      latest_draw_time: null,
      streak2: [],
      streak3: [],
      streak4: []
    };
  }

  const streakMap = new Map();

  for (let num = 1; num <= 80; num += 1) {
    let streak = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const nums = rows[i]?.numbers || [];
      if (nums.includes(num)) {
        streak += 1;
      } else {
        break;
      }
    }

    if (streak >= 2) {
      streakMap.set(num, streak);
    }
  }

  const toItems = (min, max = Infinity) =>
    [...streakMap.entries()]
      .filter(([, streak]) => streak >= min && streak <= max)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([num, streak]) => ({ num, streak }));

  return {
    lookback: rows.length,
    latest_draw_no: rows[0]?.draw_no || null,
    latest_draw_time: rows[0]?.draw_time || null,
    streak2: toItems(2, 2),
    streak3: toItems(3, 3),
    streak4: toItems(4, Infinity)
  };
}

function buildCurrentTopStrategies(leaderboard = []) {
  return leaderboard.slice(0, 4).map((row, idx) => ({
    rank: idx + 1,
    strategyKey: row.strategy_key,
    strategyName: row.strategy_name,
    avgHit: row.avg_hit,
    roi: row.roi,
    recent50Roi: row.recent_50_roi,
    score: row.score
  }));
}

function buildDecisionSummary(leaderboard = [], formalBatchCount = 0, formalSourceDrawNo = null) {
  const topFour = leaderboard.slice(0, 4);
  const topOne = topFour[0] || null;
  const currentTopStrategies = buildCurrentTopStrategies(leaderboard);

  const hasFormalSourceDraw = toInt(formalSourceDrawNo, 0) > 0;
  const underBatchLimit = toInt(formalBatchCount, 0) < FORMAL_BATCH_LIMIT;
  const canPressFormal = hasFormalSourceDraw && underBatchLimit;

  if (!topOne) {
    return {
      assistantMode: 'decision_support',
      readyForFormal: canPressFormal,
      adviceLevel: canPressFormal ? 'ready' : 'watch',
      summaryLabel: canPressFormal ? '可正式下注' : '暫無資料',
      summaryText: canPressFormal
        ? '目前已取得可下注期別，且 formal 批次尚未達上限，可手動建立正式下注組合。'
        : '目前尚未取得有效的策略排行資料。',
      currentTopStrategies,
      formalBatchCount,
      formalRemainingBatchCount: Math.max(0, FORMAL_BATCH_LIMIT - formalBatchCount),
      formalSourceDrawNo
    };
  }

  let summaryLabel = '可小試';
  let summaryText = '目前前段策略已有一定穩定度，可用小額方式觀察分工組合表現。';
  let readyForFormal = false;
  let adviceLevel = 'watch';

  if (canPressFormal) {
    summaryLabel = '可正式下注';
    summaryText = '目前已取得可下注期別，且 formal 批次尚未達上限，可手動建立正式下注組合。';
    readyForFormal = true;
    adviceLevel = 'ready';
  } else if (formalBatchCount >= FORMAL_BATCH_LIMIT) {
    summaryLabel = '本期已滿';
    summaryText = '本期 formal 批次已達上限，等待下一期再重新建立正式下注組合。';
    readyForFormal = false;
    adviceLevel = 'watch';
  } else if (topOne.avg_hit >= 2.0 && topOne.recent_50_roi > 0) {
    summaryLabel = '可正式下注';
    summaryText = '目前前段策略表現偏強，可採固定四組分工觀察中三突破。';
    readyForFormal = true;
    adviceLevel = 'ready';
  } else if (topOne.avg_hit >= 1.5) {
    summaryLabel = '可小試';
    summaryText = '目前前段策略已有一定穩定度，可用小額方式觀察分工組合表現。';
    readyForFormal = false;
    adviceLevel = 'near_ready';
  } else {
    summaryLabel = '暫不建議正式下注';
    summaryText = '目前前段策略穩定度仍不足，建議先以訓練與觀察為主。';
    readyForFormal = false;
    adviceLevel = 'watch';
  }

  return {
    assistantMode: 'decision_support',
    readyForFormal,
    adviceLevel,
    summaryLabel,
    summaryText,
    currentTopStrategies,
    formalBatchCount,
    formalRemainingBatchCount: Math.max(0, FORMAL_BATCH_LIMIT - formalBatchCount),
    formalSourceDrawNo
  };
}

function buildFormalDisplayRow(formalBatches = []) {
  if (!Array.isArray(formalBatches) || !formalBatches.length) return null;
  return formalBatches[formalBatches.length - 1];
}

function buildLatestRowsPayload(trainingRow, formalRow, formalCandidateRow) {
  return {
    training: {
      row: trainingRow || null,
      rows: trainingRow ? [trainingRow] : []
    },
    formal: {
      row: formalRow || null,
      rows: formalRow ? [formalRow] : []
    },
    formal_candidate: {
      row: formalCandidateRow || null,
      rows: formalCandidateRow ? [formalCandidateRow] : []
    }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      api_version: API_VERSION,
      error: 'Method not allowed'
    });
  }

  try {
    const [trainingRow, latestFormalRow, formalCandidateRow, leaderboard, recentDrawRows, allRecentComparedRows] = await Promise.all([
      getLatestRowByMode(TEST_MODE),
      getLatestRowByMode(FORMAL_MODE),
      getLatestRowByMode(FORMAL_CANDIDATE_MODE),
      getStrategyLeaderboard(50),
      getRecentDrawRows(20),
      getRecentComparedRows(10)
    ]);

    const formalSourceDrawNo =
      toInt(latestFormalRow?.source_draw_no, 0) ||
      await getLatestFormalSourceDrawNo();

    const recentDrawSummary = buildRecentDrawSummary(allRecentComparedRows, 10);
    const recentComparedRows = allRecentComparedRows.slice(0, 10);
    const formalBatches = await getFormalRowsBySourceDrawNo(formalSourceDrawNo);
    const displayFormalRow = buildFormalDisplayRow(formalBatches) || latestFormalRow || null;
    const marketStreakBuckets = buildMarketStreakBuckets(recentDrawRows);
    const decisionSummary = buildDecisionSummary(
      leaderboard,
      formalBatches.length,
      formalSourceDrawNo || null
    );

    const latestRowsPayload = buildLatestRowsPayload(
      trainingRow,
      displayFormalRow,
      formalCandidateRow
    );

    return res.status(200).json({
      ok: true,
      api_version: API_VERSION,

      ...latestRowsPayload,

      display_formal_row: displayFormalRow || null,
      formal_batches: formalBatches,

      leaderboard,
      current_top_strategies: decisionSummary.currentTopStrategies,

      assistant_mode: decisionSummary.assistantMode,
      ready_for_formal: decisionSummary.readyForFormal,
      advice_level: decisionSummary.adviceLevel,

      summary_label: decisionSummary.summaryLabel,
      summary_text: decisionSummary.summaryText,

      formal_batch_limit: FORMAL_BATCH_LIMIT,
      formal_batch_count: formalBatches.length,
      formal_remaining_batch_count: Math.max(0, FORMAL_BATCH_LIMIT - formalBatches.length),
      formal_source_draw_no: formalSourceDrawNo || null,

      market_streak_buckets: marketStreakBuckets,
      recent_draw_rows: recentDrawRows,

      rows: [
        ...(displayFormalRow ? [displayFormalRow] : []),
        ...(trainingRow ? [trainingRow] : []),
        ...(formalCandidateRow ? [formalCandidateRow] : [])
      ],
      predictions: recentComparedRows,
      recent_prediction_rows: recentComparedRows,
      recent_compared_rows: recentComparedRows,
      compare_history_rows: recentComparedRows,
      recent_draw_summary: recentDrawSummary,

      auto_train_result: null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      api_version: API_VERSION,
      error: error?.message || 'Unknown error'
    });
  }
}

// 修正最新期延遲
async function getLatestDrawFixed(supabase){const {data}=await supabase.from('bingo_draws').select('*').order('draw_time',{ascending:false}).limit(2); if(!data||!data.length)return null; const now=Date.now(); const latest=data[0]; const second=data[1]; const diff=now-new Date(latest.draw_time).getTime(); if(diff<120000&&second)return second; return latest;}
