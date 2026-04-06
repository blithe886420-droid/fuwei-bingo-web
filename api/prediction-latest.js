import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-latest-market-role-v7-stable-raw-compare-10';

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
  const safeLimit = Math.max(10, Math.min(30, toInt(limit, 10)));

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('status', 'compared')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) throw error;

  return (Array.isArray(data) ? data : [])
    .map(normalizePredictionRow)
    .filter(Boolean)
    .slice(0, safeLimit);
}

async function getStrategyLeaderboard(limit = 50) {
  const [{ data: statsRows }, { data: poolRows }] = await Promise.all([
    supabase
      .from(STRATEGY_STATS_TABLE)
      .select('strategy_key, avg_hit, roi, recent_50_roi, total_rounds, hit2, hit3, hit4, score')
      .order('score', { ascending: false })
      .limit(limit),
    supabase
      .from(STRATEGY_POOL_TABLE)
      .select('strategy_key, strategy_name, status, protected_rank')
  ]);

  const poolMap = new Map();
  for (const row of Array.isArray(poolRows) ? poolRows : []) {
    if (row?.strategy_key) poolMap.set(row.strategy_key, row);
  }

  return (Array.isArray(statsRows) ? statsRows : [])
    .map((row) => ({
      strategy_key: row.strategy_key,
      strategy_name: poolMap.get(row.strategy_key)?.strategy_name || row.strategy_key,
      avg_hit: round4(row.avg_hit),
      roi: round4(row.roi),
      recent_50_roi: round4(row.recent_50_roi),
      total_rounds: toInt(row.total_rounds, 0),
      hit2: toInt(row.hit2, 0),
      hit3: toInt(row.hit3, 0),
      hit4: toInt(row.hit4, 0),
      score: round4(row.score)
    }))
    .filter(Boolean)
    .slice(0, limit);
}

async function getRecentDrawRows(limit = 20) {
  const { data } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(limit);

  return Array.isArray(data) ? data : [];
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const [
      trainingRow,
      latestFormalRow,
      formalCandidateRow,
      leaderboard,
      recentDrawRows,
      recentComparedRows
    ] = await Promise.all([
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

    const formalBatches = await getFormalRowsBySourceDrawNo(formalSourceDrawNo);

    return res.status(200).json({
      ok: true,
      api_version: API_VERSION,

      training: { row: trainingRow },
      formal: { row: latestFormalRow },
      formal_candidate: { row: formalCandidateRow },

      leaderboard,
      recent_draw_rows: recentDrawRows,

      predictions: recentComparedRows,
      recent_prediction_rows: recentComparedRows,
      recent_compared_rows: recentComparedRows,
      compare_history_rows: recentComparedRows,

      formal_batches: formalBatches,
      formal_source_draw_no: formalSourceDrawNo
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Unknown error'
    });
  }
}
