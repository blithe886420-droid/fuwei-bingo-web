import { createClient } from '@supabase/supabase-js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { evolveStrategies } from '../lib/strategyEvolutionEngine.js';

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

function uniqueAsc(arr = []) {
  return [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function stableHash(text = '') {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h;
}

function rotate(arr = [], offset = 0) {
  if (!arr.length) return [];
  const i = ((offset % arr.length) + arr.length) % arr.length;
  return [...arr.slice(i), ...arr.slice(0, i)];
}

function parseDrawNumbers(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => Number(String(s).trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function buildGroups(strategies, draws) {
  const allNums = draws.flatMap((draw) => parseDrawNumbers(draw?.numbers));
  const latest = parseDrawNumbers(draws?.[0]?.numbers);

  const freq = new Map();
  for (let i = 1; i <= 80; i += 1) {
    freq.set(i, 0);
  }

  for (const n of allNums) {
    freq.set(n, (freq.get(n) || 0) + 1);
  }

  const hot = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const cold = [...freq.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  return strategies.map((strategy, idx) => {
    const key = String(strategy.strategy_key || `strategy_${idx + 1}`);
    const label = String(strategy.strategy_name || key);
    const seed = stableHash(`${key}_${idx}`);

    const nums = uniqueAsc([
      ...rotate(latest, seed % 5).slice(0, 1),
      ...rotate(hot, seed % 7).slice(0, 4),
      ...rotate(cold, seed % 11).slice(0, 2)
    ]).slice(0, 4);

    return {
      key,
      label,
      nums,
      reason: '',
      meta: {
        strategy_key: key,
        strategy_name: label
      }
    };
  });
}

function buildFallbackStrategies() {
  return [
    { strategy_key: 'hot_balanced', strategy_name: 'Hot Balanced' },
    { strategy_key: 'balanced_zone', strategy_name: 'Balanced Zone' },
    { strategy_key: 'cluster_chase', strategy_name: 'Cluster Chase' },
    { strategy_key: 'guard_zone', strategy_name: 'Guard Zone' }
  ];
}

function generatePredictionId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

async function getLatestDraw() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getRecentDraws() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(RECENT_ANALYSIS_LIMIT);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getStrategies() {
  await ensureStrategyPoolStrategies({
    strategyKeys: [
      'hot_balanced',
      'balanced_zone',
      'cluster_chase',
      'guard_zone'
    ],
    sourceType: 'seed',
    status: 'active'
  });

  const { data, error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(PICK_COUNT);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return buildFallbackStrategies();
  return rows;
}

async function findExistingTestPrediction(drawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', CURRENT_MODE)
    .eq('source_draw_no', String(drawNo))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function saveOrUpdatePrediction(drawNo, groups) {
  const existing = await findExistingTestPrediction(drawNo);
  const nowIso = new Date().toISOString();

  if (existing?.id) {
    const { data, error } = await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        mode: CURRENT_MODE,
        status: 'created',
        compare_status: null,
        compared_at: null,
        compare_result: null,
        verdict: null,
        hit_count: null,
        source_draw_no: String(drawNo),
        target_periods: DRAW_COMPARE_LIMIT,
        groups_json: groups,
        created_at: nowIso
      })
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert({
      id: generatePredictionId(),
      mode: CURRENT_MODE,
      status: 'created',
      source_draw_no: String(drawNo),
      target_periods: DRAW_COMPARE_LIMIT,
      groups_json: groups,
      created_at: nowIso
    })
    .select('*')
    .single();

  if (error) throw error;
  if (!data?.id) throw new Error('prediction insert returned null');

  return data;
}

async function updateComparedPrediction(predictionId, payload) {
  const { error } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      compare_result: payload.compareResult ?? null,
      compare_status: 'done',
      status: 'compared',
      verdict: payload.verdict ?? null,
      hit_count: toNum(payload.hitCount, 0),
      compared_at: new Date().toISOString()
    })
    .eq('id', predictionId);

  if (error) throw error;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const latest = await getLatestDraw();
    if (!latest?.draw_no) {
      return res.status(200).json({
        ok: true,
        message: 'no draw'
      });
    }

    const recent = await getRecentDraws();
    const strategies = await getStrategies();
    const groups = buildGroups(strategies, recent);

    if (groups.length !== PICK_COUNT || groups.some((group) => group.nums.length !== 4)) {
      return res.status(500).json({
        ok: false,
        error: 'failed to build groups'
      });
    }

    const prediction = await saveOrUpdatePrediction(latest.draw_no, groups);
    if (!prediction?.id) {
      throw new Error('prediction save returned null');
    }

    const payload = buildComparePayload({
      prediction,
      groups,
      drawRows: recent.slice(0, DRAW_COMPARE_LIMIT),
      drawNoCol: 'draw_no',
      drawTimeCol: 'draw_time',
      drawNumbersCol: 'numbers',
      costPerGroupPerPeriod: 25
    });

    await updateComparedPrediction(prediction.id, payload);
    await recordStrategyCompareResult(payload.compareResult);
    await evolveStrategies();

    return res.status(200).json({
      ok: true,
      prediction_id: prediction.id,
      source_draw_no: prediction.source_draw_no
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'auto-train failed'
    });
  }
}
