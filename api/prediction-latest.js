import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-latest-batch-v5-instant-ready';

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
  return Number.isFinite(n) ? n : fallback;
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
  return [...new Set((Array.isArray(nums) ? nums : []).map((n) => Number(n)).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
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
            : []
      ).slice(0, 4);

      if (nums.length !== 4) return null;

      return {
        key: g.key || `group_${idx + 1}`,
        label: g.label || g.name || g.strategy_name || `第${idx + 1}組`,
        nums,
        reason: g.reason || '',
        meta: g.meta || {}
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

function normalizePredictionRow(row) {
  if (!row) return null;

  const mode = String(row.mode || '').toLowerCase();
  const sourceDrawNo = toInt(row.source_draw_no, 0);
  const targetPeriods = toInt(row.target_periods, 1);
  const groups = parseGroupsJson(row.groups_json);

  return {
    id: row.id,
    mode,
    status: row.status || 'created',
    created_at: row.created_at || null,
    source_draw_no: sourceDrawNo,
    target_periods: targetPeriods,
    sourceDrawNo,
    targetPeriods,
    targetDrawNo: sourceDrawNo ? sourceDrawNo + targetPeriods : 0,
    groups_json: groups,
    groups,
    prediction_groups: groups,
    compare_result: row.compare_result || null,
    compare_status: row.compare_status || null,
    compared_at: row.compared_at || null,
    verdict: row.verdict || null,
    hit_count: toInt(row.hit_count, 0),
    group_count: groups.length
  };
}

function normalizeLeaderboardRow(row, poolRow = null) {
  if (!row || !row.strategy_key) return null;

  const pool = poolRow && typeof poolRow === 'object' ? poolRow : {};

  return {
    strategy_key: String(row.strategy_key || ''),
    strategy_name: pool.strategy_name || row.strategy_name || row.strategy_key,
    avg_hit: round4(row.avg_hit),
    roi: round4(row.roi),
    recent_50_roi: round4(row.recent_50_roi),
    total_rounds: toInt(row.total_rounds, 0),
    hit2: toInt(row.hit2, 0),
    hit3: toInt(row.hit3, 0),
    hit4: toInt(row.hit4, 0),
    strategy_score: round4(row.score ?? row.strategy_score ?? 0),
    score: round4(row.score ?? row.strategy_score ?? 0),
    status: pool.status || 'active',
    protected_rank: Boolean(pool.protected_rank)
  };
}

async function getLatestPrediction(mode) {
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
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('source_draw_no')
    .eq('mode', FORMAL_MODE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return toInt(data?.source_draw_no, 0);
}

async function getFormalBatchRows(sourceDrawNo) {
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

function buildDecisionSummary(leaderboard = []) {
  const topFour = leaderboard.slice(0, 4);
  const topOne = topFour[0] || null;

  if (!topOne) {
    return {
      assistantMode: 'manual_control',
      readyForFormal: true,
      adviceLevel: 'manual',
      decisionPhase: 'manual_control',
      summaryLabel: '自行決定',
      summaryText: '目前策略資料不足，但正式下注改由你手動決定；請自行評估是否進場。',
      currentTopStrategies: []
    };
  }

  return {
    assistantMode: 'manual_control',
    readyForFormal: true,
    adviceLevel: 'manual',
    decisionPhase: 'manual_control',
    summaryLabel: '自行決定',
    summaryText: 'AI 仍提供排行與分析，但正式下注是否進場，改由你手動決定。',
    currentTopStrategies: topFour
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const [trainingPrediction, formalPrediction, instantFormal, leaderboard, latestFormalSourceDrawNo] =
      await Promise.all([
        getLatestPrediction(TEST_MODE),
        getLatestPrediction(FORMAL_MODE),
        getLatestPrediction(FORMAL_CANDIDATE_MODE),
        getStrategyLeaderboard(50),
        getLatestFormalSourceDrawNo()
      ]);

    const rows = [trainingPrediction, formalPrediction].filter(Boolean);
    const decision = buildDecisionSummary(leaderboard);

    const latestFormalDrawNo =
      latestFormalSourceDrawNo ||
      formalPrediction?.source_draw_no ||
      0;

    const latestTrainingDrawNo = toInt(trainingPrediction?.source_draw_no, 0);
    let formalSourceDrawNo = latestFormalDrawNo;

    if (latestTrainingDrawNo > 0) {
      if (!formalSourceDrawNo || latestTrainingDrawNo > formalSourceDrawNo) {
        formalSourceDrawNo = latestTrainingDrawNo;
      }
    }

    let formalBatchRows = await getFormalBatchRows(formalSourceDrawNo);
    let formalBatchCount = formalBatchRows.length;
    const formalRemainingBatchCount = Math.max(0, FORMAL_BATCH_LIMIT - formalBatchCount);

    return res.status(200).json({
      ok: true,
      api_version: API_VERSION,

      training: {
        row: trainingPrediction,
        rows: trainingPrediction ? [trainingPrediction] : []
      },

      formal: {
        row: formalPrediction,
        rows: formalPrediction ? [formalPrediction] : []
      },

      instant_formal: instantFormal,

      ai_train: {
        row: trainingPrediction,
        rows: trainingPrediction ? [trainingPrediction] : []
      },

      training_row: trainingPrediction,
      formal_row: formalPrediction,
      row: trainingPrediction || formalPrediction || null,
      rows,

      leaderboard,
      leaderboard_source: 'strategy_stats+strategy_pool',

      assistantMode: decision.assistantMode,
      readyForFormal: decision.readyForFormal,
      adviceLevel: decision.adviceLevel,
      decisionPhase: decision.decisionPhase,
      summaryLabel: decision.summaryLabel,
      summaryText: decision.summaryText,
      currentTopStrategies: decision.currentTopStrategies,

      formal_batch_limit: FORMAL_BATCH_LIMIT,
      formal_batch_count: formalBatchCount,
      formal_remaining_batch_count: formalRemainingBatchCount,
      formal_source_draw_no: formalSourceDrawNo || null,
      formal_batches: formalBatchRows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      api_version: API_VERSION,
      error: error?.message || 'prediction-latest failed'
    });
  }
}
