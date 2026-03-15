import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

const PREDICTIONS_TABLE = 'bingo_predictions';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueAsc(nums) {
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

      const nums = uniqueAsc(Array.isArray(g.nums) ? g.nums : []).slice(0, 4);
      if (nums.length !== 4) return null;

      return {
        key: g.key || `group_${idx + 1}`,
        label: g.label || `第${idx + 1}組`,
        nums,
        reason: g.reason || '',
        meta: g.meta || {}
      };
    })
    .filter(Boolean)
    .slice(0, 4);
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
  const targetPeriods = toInt(
    row.target_periods,
    mode === 'formal' ? 4 : 2
  );

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
    compare_result_json: row.compare_result_json || null,
    compare_status: row.compare_status || null,
    compared_at: row.compared_at || null
  };
}

function normalizeLeaderboardRow(row) {
  if (!row) return null;

  const totalRounds = toNum(row.total_rounds, 0);
  const avgHit = Number(row.avg_hit ?? 0);
  const roi = Number(row.roi ?? 0);
  const recent50Roi = Number(row.recent_50_roi ?? 0);
  const hitRate = Number(row.hit_rate ?? 0);
  const hit3 = toNum(row.hit3, 0);
  const hit4 = toNum(row.hit4, 0);

  const score =
    (recent50Roi * 0.45) +
    (roi * 0.2) +
    (avgHit * 18) +
    (hitRate * 0.12) +
    (Math.min(totalRounds, 500) * 0.02) +
    (hit4 * 8) +
    (hit3 * 3);

  return {
    key: row.strategy_key || '',
    label: row.strategy_key || '',
    strategy_key: row.strategy_key || '',
    total_rounds: totalRounds,
    total_hits: toNum(row.total_hits, 0),
    hit0: toNum(row.hit0, 0),
    hit1: toNum(row.hit1, 0),
    hit2: toNum(row.hit2, 0),
    hit3: hit3,
    hit4: hit4,
    avg_hit: Number.isFinite(avgHit) ? Number(avgHit.toFixed(6)) : 0,
    hit_rate: Number.isFinite(hitRate) ? Number(hitRate.toFixed(6)) : 0,
    total_profit: Number.isFinite(Number(row.total_profit))
      ? Number(Number(row.total_profit).toFixed(6))
      : 0,
    roi: Number.isFinite(roi) ? Number(roi.toFixed(6)) : 0,
    recent_50_hit_rate: Number.isFinite(Number(row.recent_50_hit_rate))
      ? Number(Number(row.recent_50_hit_rate).toFixed(6))
      : 0,
    recent_50_roi: Number.isFinite(recent50Roi)
      ? Number(recent50Roi.toFixed(6))
      : 0,
    last_result_draw_no: toNum(row.last_result_draw_no, 0),
    total_cost: Number.isFinite(Number(row.total_cost))
      ? Number(Number(row.total_cost).toFixed(6))
      : 0,
    total_reward: Number.isFinite(Number(row.total_reward))
      ? Number(Number(row.total_reward).toFixed(6))
      : 0,
    last_updated: row.last_updated || null,
    score: Number.isFinite(score) ? Number(score.toFixed(4)) : 0
  };
}

async function getLatestCreatedByMode(mode) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', mode)
    .eq('status', 'created')
    .order('source_draw_no', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getLatestAnyByMode(mode) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', mode)
    .order('source_draw_no', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getLatestPredictionByMode(mode) {
  const createdRow = await getLatestCreatedByMode(mode);
  if (createdRow) return normalizePredictionRow(createdRow);

  const anyRow = await getLatestAnyByMode(mode);
  return normalizePredictionRow(anyRow);
}

async function getLeaderboard(limit = 50) {
  let source = 'strategy_stats_latest_first';
  let rows = [];

  const { data: latestRows, error: latestError } = await supabase
    .from('strategy_stats_latest_first')
    .select('*')
    .limit(limit);

  if (!latestError && Array.isArray(latestRows) && latestRows.length > 0) {
    rows = latestRows;
  } else {
    source = 'strategy_stats';

    const { data: statsRows, error: statsError } = await supabase
      .from('strategy_stats')
      .select('*')
      .limit(limit);

    if (statsError) throw statsError;
    rows = Array.isArray(statsRows) ? statsRows : [];
  }

  const leaderboard = rows
    .map(normalizeLeaderboardRow)
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.recent_50_roi !== a.recent_50_roi) return b.recent_50_roi - a.recent_50_roi;
      if (b.roi !== a.roi) return b.roi - a.roi;
      return b.total_rounds - a.total_rounds;
    })
    .slice(0, limit);

  return {
    source,
    leaderboard
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
    const [trainingPrediction, formalPrediction, rankingResult] = await Promise.all([
      getLatestPredictionByMode('test'),
      getLatestPredictionByMode('formal'),
      getLeaderboard(50)
    ]);

    const rows = [trainingPrediction, formalPrediction].filter(Boolean);

    return res.status(200).json({
      ok: true,

      training: trainingPrediction,
      formal: formalPrediction,
      ai_train: trainingPrediction,

      rows,

      leaderboard: rankingResult.leaderboard,
      leaderboard_source: rankingResult.source
    });
  } catch (error) {
    console.error('prediction-latest error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'prediction-latest failed'
    });
  }
}
