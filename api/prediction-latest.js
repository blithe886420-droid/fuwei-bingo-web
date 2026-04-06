import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-latest-market-role-v8-force-correct-10';

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

function normalizePredictionRow(row) {
  if (!row || typeof row !== 'object') return null;

  const compareResult =
    safeJsonParse(row.compare_result_json, null) ||
    safeJsonParse(row.compare_result, null) ||
    null;

  return {
    ...row,
    mode: String(row.mode || '').trim().toLowerCase(),
    status: String(row.status || '').trim().toLowerCase() || 'created',
    hit_count: toInt(row.hit_count, toInt(compareResult?.hit_count, 0)),
    compare_result_json: compareResult
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

async function getRecentComparedRows(limit = 10) {
  const safeLimit = Math.max(10, Math.min(30, toInt(limit, 10)));

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('status', 'compared')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;

  const rows = (Array.isArray(data) ? data : [])
    .map(normalizePredictionRow)
    .filter(Boolean);

  const finalRows = [];

  const used = new Set();

  for (const row of rows) {
    if (finalRows.length >= safeLimit) break;

    const key = `${row.created_at}_${row.mode}`;
    if (used.has(key)) continue;

    finalRows.push(row);
    used.add(key);
  }

  return finalRows.slice(0, safeLimit);
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
      recentDrawRows,
      recentComparedRows
    ] = await Promise.all([
      getLatestRowByMode(TEST_MODE),
      getLatestRowByMode(FORMAL_MODE),
      getLatestRowByMode(FORMAL_CANDIDATE_MODE),
      getRecentDrawRows(20),
      getRecentComparedRows(10)
    ]);

    return res.status(200).json({
      ok: true,
      api_version: API_VERSION,

      training: { row: trainingRow },
      formal: { row: latestFormalRow },
      formal_candidate: { row: formalCandidateRow },

      recent_draw_rows: recentDrawRows,

      predictions: recentComparedRows,
      recent_prediction_rows: recentComparedRows,
      recent_compared_rows: recentComparedRows,
      compare_history_rows: recentComparedRows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Unknown error'
    });
  }
}
