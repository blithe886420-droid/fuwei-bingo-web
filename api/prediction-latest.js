import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-latest-batch-v3';

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

function buildStrategyScore(row) {
  const totalRounds = toNum(row.total_rounds, 0);
  const avgHit = toNum(row.avg_hit, 0);
  const roi = toNum(row.roi, 0);
  const recent50Roi = toNum(row.recent_50_roi, 0);
  const hitRate = toNum(row.hit_rate, 0);
  const recent50HitRate = toNum(row.recent_50_hit_rate, 0);
  const hit2 = toNum(row.hit2, 0);
  const hit3 = toNum(row.hit3, 0);
  const hit4 = toNum(row.hit4, 0);
  const protectedBonus = row?.protected_rank ? 9999 : 0;
  const matureBonus = totalRounds >= 30 ? 25 : totalRounds >= 15 ? 10 : 0;

  return (
    protectedBonus +
    avgHit * 55 +
    recent50Roi * 45 +
    roi * 10 +
    hitRate * 18 +
    recent50HitRate * 12 +
    hit2 * 2 +
    hit3 * 8 +
    hit4 * 20 +
    matureBonus
  );
}

function normalizeLeaderboardRow(row, poolRow = null) {
  if (!row) return null;

  const totalRounds = toNum(row.total_rounds, 0);
  const avgHit = toNum(row.avg_hit, 0);
  const roi = toNum(row.roi, 0);
  const recent50Roi = toNum(row.recent_50_roi, 0);
  const hitRate = toNum(row.hit_rate, 0);
  const recent50HitRate = toNum(row.recent_50_hit_rate, 0);

  const merged = {
    ...poolRow,
    ...row
  };

  const score = buildStrategyScore(merged);

  return {
    key: merged.strategy_key || '',
    label:
      merged.strategy_label ||
      merged.strategy_name ||
      merged.strategy_key ||
      '',
    strategy_key: merged.strategy_key || '',
    strategy_name:
      merged.strategy_name ||
      merged.strategy_label ||
      merged.strategy_key ||
      '',
    total_rounds: totalRounds,
    total_hits: toNum(merged.total_hits, 0),
    avg_hit: round4(avgHit),
    hit_rate: round4(hitRate),
    recent_50_hit_rate: round4(recent50HitRate),
    total_profit: round4(merged.total_profit),
    roi: round4(roi),
    recent_50_roi: round4(recent50Roi),
    total_cost: round4(merged.total_cost),
    total_reward: round4(merged.total_reward),
    hit2: toNum(merged.hit2, 0),
    hit3: toNum(merged.hit3, 0),
    hit4: toNum(merged.hit4, 0),
    protected_rank: Boolean(merged.protected_rank),
    pool_status: merged.status || null,
    updated_at: merged.updated_at || merged.last_updated || null,
    score: round4(score)
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
  return normalizePredictionRow(data || null);
}

async function getLatestFormalSourceDrawNo() {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('source_draw_no, created_at')
    .eq('mode', 'formal')
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
    .eq('mode', 'formal')
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (Array.isArray(data) ? data : []).map((row, idx) => ({
    ...normalizePredictionRow(row),
    formal_batch_no: idx + 1
  }));
}

async function getStrategyLeaderboard(limit = 50) {
  const [{ data: statsRows, error: statsError }, { data: poolRows, error: poolError }] =
    await Promise.all([
      supabase.from(STRATEGY_STATS_TABLE).select('*'),
      supabase.from(STRATEGY_POOL_TABLE).select('*')
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
      assistantMode: 'decision_support',
      readyForFormal: false,
      adviceLevel: 'stop',
      decisionPhase: 'no_data',
      summaryLabel: '資料不足',
      summaryText: '目前沒有足夠的策略排行資料，先不要正式下注。',
      currentTopStrategies: []
    };
  }

  const strongShortTerm =
    topOne.avg_hit >= 1.8 && topOne.recent_50_roi >= 0;
  const usableShortTerm =
    topOne.avg_hit >= 1.5 && topOne.recent_50_roi >= -0.2;

  if (strongShortTerm) {
    return {
      assistantMode: 'decision_support',
      readyForFormal: true,
      adviceLevel: 'go_small',
      decisionPhase: 'ready_small_bet',
      summaryLabel: '可小試',
      summaryText: '目前前段策略表現偏穩，可採單期、小額方式測試。',
      currentTopStrategies: topFour
    };
  }

  if (usableShortTerm) {
    return {
      assistantMode: 'decision_support',
      readyForFormal: false,
      adviceLevel: 'watch',
      decisionPhase: 'watch_only',
      summaryLabel: '可觀察',
      summaryText: '目前有可參考策略，但建議先觀察排行與近期成績。',
      currentTopStrategies: topFour
    };
  }

  return {
    assistantMode: 'decision_support',
    readyForFormal: false,
    adviceLevel: 'avoid',
    decisionPhase: 'avoid_entry',
    summaryLabel: '暫不建議',
    summaryText: '目前前段策略偏弱，不建議急著正式下注。',
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
    const [trainingPrediction, formalPrediction, leaderboard, latestFormalSourceDrawNo] =
      await Promise.all([
        getLatestPrediction('test'),
        getLatestPrediction('formal'),
        getStrategyLeaderboard(50),
        getLatestFormalSourceDrawNo()
      ]);

    const rows = [trainingPrediction, formalPrediction].filter(Boolean);
    const decision = buildDecisionSummary(leaderboard);

    const formalSourceDrawNo =
      latestFormalSourceDrawNo ||
      formalPrediction?.source_draw_no ||
      0;

    const formalBatchRows = await getFormalBatchRows(formalSourceDrawNo);

    const formalBatchCount = formalBatchRows.length;
    const formalRemainingBatchCount = Math.max(
      0,
      FORMAL_BATCH_LIMIT - formalBatchCount
    );

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
