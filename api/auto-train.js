import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const CURRENT_MODE = 'test';
const PICK_COUNT = 4;
const DRAW_COMPARE_LIMIT = 2;
const RECENT_ANALYSIS_LIMIT = 20;

const STRATEGY_POOL_TABLE = 'strategy_pool';
const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDrawNumbers(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function uniqueAsc(arr) {
  return [...new Set(arr)].sort((a, b) => a - b);
}

function stableHash(text = '') {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h;
}

function rotate(arr, offset) {
  if (!arr.length) return [];
  const i = offset % arr.length;
  return [...arr.slice(i), ...arr.slice(0, i)];
}

function buildGroups(strategies, draws) {
  const allNums = draws.flatMap((d) => parseDrawNumbers(d.numbers));

  const freq = new Map();
  for (let i = 1; i <= 80; i++) freq.set(i, 0);
  for (const n of allNums) freq.set(n, (freq.get(n) || 0) + 1);

  const hot = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const cold = [...freq.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);

  const latest = parseDrawNumbers(draws[0]?.numbers);

  return strategies.map((s, idx) => {
    const key = s.strategy_key;
    const seed = stableHash(key);

    const nums = uniqueAsc([
      ...rotate(latest, seed % 3).slice(0, 1),
      ...rotate(hot, seed % 7).slice(0, 3),
      ...rotate(cold, seed % 5).slice(0, 2)
    ]).slice(0, 4);

    return {
      key,
      label: s.strategy_name,
      nums,
      meta: {
        strategy_key: key,
        strategy_name: s.strategy_name
      }
    };
  });
}

async function getLatestDraw() {
  const { data } = await supabase
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

async function getRecentDraws() {
  const { data } = await supabase
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(RECENT_ANALYSIS_LIMIT);

  return data || [];
}

async function getStrategies() {
  const { data } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active');

  return (data || []).slice(0, PICK_COUNT);
}

async function insertPrediction(drawNo, groups) {
  const { data } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert({
      id: Date.now(),
      mode: CURRENT_MODE,
      status: 'created',
      source_draw_no: String(drawNo),
      target_periods: DRAW_COMPARE_LIMIT,
      groups_json: groups,
      created_at: new Date().toISOString()
    })
    .select()
    .single();

  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false });
  }

  try {
    const latest = await getLatestDraw();
    if (!latest) return res.json({ ok: true, msg: 'no draw' });

    const recent = await getRecentDraws();
    const strategies = await getStrategies();

    const groups = buildGroups(strategies, recent);

    const prediction = await insertPrediction(latest.draw_no, groups);

    // 🔥 compare
    const { buildComparePayload } = await import('../lib/buildComparePayload.js');

    const payload = buildComparePayload({
      prediction,
      groups,
      drawRows: recent.slice(0, DRAW_COMPARE_LIMIT)
    });

    // 🔥 update prediction
    await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        compare_result: payload.compareResult,
        status: 'compared',
        verdict: payload.verdict,
        hit_count: payload.hitCount,
        compared_at: new Date().toISOString()
      })
      .eq('id', prediction.id);

    // 🔥 stats
    const { recordStrategyCompareResult } = await import('../lib/strategyStatsRecorder.js');
    await recordStrategyCompareResult(payload.compareResult);

    // 🔥 evolve
    const { evolveStrategies } = await import('../lib/strategyEvolutionEngine.js');
    await evolveStrategies();

    return res.json({
      ok: true,
      prediction_id: prediction.id
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
