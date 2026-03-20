import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

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

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_POOL_TABLE = 'strategy_pool';

const MODE = 'test';
const TARGET_PERIODS = 2;
const GROUP_COUNT = 4;
const COST_PER_GROUP_PER_PERIOD = 25;

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => Number(String(s).trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function stableHash(text = '') {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function rotateList(source = [], offset = 0) {
  if (!Array.isArray(source) || source.length === 0) return [];
  const len = source.length;
  const safeOffset = ((offset % len) + len) % len;
  return [...source.slice(safeOffset), ...source.slice(0, safeOffset)];
}

function buildFallbackGroups(latestNumbers = []) {
  const basePool = uniqueAsc([
    ...latestNumbers,
    1, 2, 3, 4, 7, 9, 12, 15, 18, 22, 26, 31, 36, 42, 50, 57, 63, 71
  ]);

  const safe = basePool.length >= 16 ? basePool : Array.from({ length: 20 }, (_, i) => i + 1);

  return Array.from({ length: GROUP_COUNT }, (_, idx) => ({
    key: `fallback_${idx + 1}`,
    label: `Fallback ${idx + 1}`,
    nums: uniqueAsc(rotateList(safe, idx * 3).slice(0, 4)),
    reason: 'auto-train fallback',
    meta: {
      strategy_key: `fallback_${idx + 1}`,
      strategy_name: `Fallback ${idx + 1}`
    }
  }));
}

async function getLatestDraw() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getRecentDraws(limitCount = 40) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getActiveStrategies(limitCount = GROUP_COUNT) {
  const { data, error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function buildGroupsFromStrategies(strategies = [], recentDraws = []) {
  const latestNumbers = parseDrawNumbers(recentDraws?.[0]?.numbers);
  const allNumbers = recentDraws.flatMap((row) => parseDrawNumbers(row?.numbers));

  const freq = new Map();
  for (let i = 1; i <= 80; i += 1) freq.set(i, 0);
  for (const n of allNumbers) freq.set(n, (freq.get(n) || 0) + 1);

  const hottest = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const coldest = [...freq.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  const rows = (strategies || []).slice(0, GROUP_COUNT);

  const groups = rows.map((strategy, idx) => {
    const key = String(strategy.strategy_key || `strategy_${idx + 1}`);
    const label = String(strategy.strategy_name || key);
    const seed = stableHash(`${key}_${idx}`);

    const nums = uniqueAsc([
      ...rotateList(latestNumbers, seed % 5).slice(0, 1),
      ...rotateList(hottest, seed % 11).slice(0, 6),
      ...rotateList(coldest, seed % 7).slice(0, 3)
    ]).slice(0, 4);

    return {
      key,
      label,
      nums,
      reason: 'auto-train strategy',
      meta: {
        strategy_key: key,
        strategy_name: label
      }
    };
  });

  const valid = groups.filter((g) => Array.isArray(g.nums) && g.nums.length === 4);
  if (valid.length === GROUP_COUNT) return valid;

  return buildFallbackGroups(latestNumbers);
}

async function getExistingPrediction(sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', MODE)
    .eq('source_draw_no', String(sourceDrawNo))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function generatePredictionId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

async function savePrediction(sourceDrawNo, groups) {
  const existing = await getExistingPrediction(sourceDrawNo);
  const nowIso = new Date().toISOString();

  if (existing?.id) {
    const { data, error } = await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        mode: MODE,
        status: 'created',
        source_draw_no: String(sourceDrawNo),
        target_periods: TARGET_PERIODS,
        groups_json: groups,
        compare_result: null,
        compare_status: null,
        verdict: null,
        hit_count: null,
        compared_at: null,
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
      mode: MODE,
      status: 'created',
      source_draw_no: String(sourceDrawNo),
      target_periods: TARGET_PERIODS,
      groups_json: groups,
      created_at: nowIso
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function updateComparedPrediction(predictionId, payload) {
  const { error } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'compared',
      compare_status: 'done',
      hit_count: Number(payload?.hitCount || 0),
      compare_result: payload?.compareResult || null,
      verdict: payload?.verdict || null,
      compared_at: new Date().toISOString()
    })
    .eq('id', predictionId);

  if (error) throw error;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const latestDraw = await getLatestDraw();

    if (!latestDraw?.draw_no) {
      return res.status(200).json({
        ok: true,
        message: 'no draw'
      });
    }

    const recentDraws = await getRecentDraws(40);
    const strategies = await getActiveStrategies(GROUP_COUNT);

    const groups =
      strategies.length >= GROUP_COUNT
        ? buildGroupsFromStrategies(strategies, recentDraws)
        : buildFallbackGroups(parseDrawNumbers(latestDraw.numbers));

    if (groups.length !== GROUP_COUNT || groups.some((g) => g.nums.length !== 4)) {
      return res.status(500).json({
        ok: false,
        error: 'failed to build groups'
      });
    }

    const prediction = await savePrediction(latestDraw.draw_no, groups);

    const payload = buildComparePayload({
      prediction,
      groups,
      drawRows: [latestDraw],
      costPerGroupPerPeriod: COST_PER_GROUP_PER_PERIOD
    });

    await updateComparedPrediction(prediction.id, payload);
    await recordStrategyCompareResult(payload.compareResult);

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
