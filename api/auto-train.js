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
  throw new Error('Missing SUPABASE_URL or SUPABASE service role key');
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

function uniqueAsc(nums) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function stableHash(text = '') {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function rotateList(source, offset = 0) {
  if (!Array.isArray(source) || source.length === 0) return [];
  const len = source.length;
  const safeOffset = ((offset % len) + len) % len;
  return [...source.slice(safeOffset), ...source.slice(0, safeOffset)];
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

function buildRecentAnalysis(rows = []) {
  const parsedRows = (Array.isArray(rows) ? rows : []).map((row) => ({
    draw_no: toNum(row?.draw_no, 0),
    draw_time: row?.draw_time || null,
    numbers: parseDrawNumbers(row?.numbers)
  }));

  const latestDraw = parsedRows[0]?.numbers || [];
  const allNums = parsedRows.flatMap((row) => row.numbers);

  const freq = new Map();
  for (let i = 1; i <= 80; i += 1) freq.set(i, 0);
  for (const n of allNums) freq.set(n, (freq.get(n) || 0) + 1);

  const hottest = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const coldest = [...freq.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  return {
    hottest,
    coldest,
    latestDraw
  };
}

function buildGroupsFromStrategies(strategies = [], recentRows = []) {
  const analysis = buildRecentAnalysis(recentRows);

  return strategies.map((row, idx) => {
    const key = row.strategy_key || `strategy_${idx + 1}`;
    const seed = stableHash(`${key}_${idx}`);
    const hotPool = rotateList(analysis.hottest, seed % 17);
    const latestPool = rotateList(analysis.latestDraw, seed % 5);
    const coldPool = rotateList(analysis.coldest, seed % 11);

    const nums = uniqueAsc([
      ...latestPool.slice(0, 1),
      ...hotPool.slice(0, 5),
      ...coldPool.slice(0, 2)
    ]).slice(0, 4);

    return {
      key,
      label: row.strategy_name || key,
      nums,
      reason: '',
      meta: {
        strategy_key: key,
        strategy_name: row.strategy_name || key
      }
    };
  });
}

function getFallbackStrategies() {
  return [
    { strategy_key: 'hot_balanced', strategy_name: 'Hot Balanced' },
    { strategy_key: 'balanced_zone', strategy_name: 'Balanced Zone' },
    { strategy_key: 'hot_chase', strategy_name: 'Hot Chase' },
    { strategy_key: 'repeat_guard', strategy_name: 'Repeat Guard' }
  ];
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

async function getLastPredictionDrawNo() {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('source_draw_no')
    .eq('mode', CURRENT_MODE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return toNum(data?.source_draw_no, 0);
}

async function getRecentDrawRows(limitCount = RECENT_ANALYSIS_LIMIT) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function tryEnsureStrategyPoolStrategies() {
  try {
    const mod = await import('../lib/ensureStrategyPoolStrategies.js');
    if (typeof mod.ensureStrategyPoolStrategies === 'function') {
      await mod.ensureStrategyPoolStrategies({
        strategyKeys: [
          'hot_balanced',
          'balanced_zone',
          'hot_chase',
          'repeat_guard'
        ],
        sourceType: 'seed',
        status: 'active'
      });
    }
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'ensureStrategyPoolStrategies failed'
    };
  }
}

async function getActiveStrategies() {
  const { data, error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return getFallbackStrategies();
  return rows.slice(0, PICK_COUNT);
}

async function insertPrediction(latestDrawNo, groups) {
  const insertPayload = {
    id: Date.now(),
    mode: CURRENT_MODE,
    status: 'created',
    source_draw_no: String(latestDrawNo),
    target_periods: DRAW_COMPARE_LIMIT,
    groups_json: groups,
    created_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert(insertPayload)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function updateComparedPrediction(predictionId, payload) {
  const { error } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      compare_result: payload.compareResult ?? null,
      compare_status: 'done',
      status: 'compared',
      compared_at: new Date().toISOString(),
      verdict: payload.verdict ?? null,
      hit_count: toNum(payload.hitCount, 0)
    })
    .eq('id', predictionId);

  if (error) throw error;
}

async function tryBuildComparePayload(input) {
  const mod = await import('../lib/buildComparePayload.js');
  if (typeof mod.buildComparePayload !== 'function') {
    throw new Error('buildComparePayload not found');
  }
  return mod.buildComparePayload(input);
}

async function tryRecordStrategyCompareResult(compareResult) {
  try {
    const mod = await import('../lib/strategyStatsRecorder.js');
    if (typeof mod.recordStrategyCompareResult === 'function') {
      await mod.recordStrategyCompareResult(compareResult);
      return { ok: true, error: null };
    }
    return { ok: false, error: 'recordStrategyCompareResult not found' };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'recordStrategyCompareResult failed'
    };
  }
}

async function tryEvolveStrategies() {
  try {
    const mod = await import('../lib/strategyEvolutionEngine.js');
    if (typeof mod.evolveStrategies === 'function') {
      await mod.evolveStrategies();
      return { ok: true, error: null };
    }
    return { ok: false, error: 'evolveStrategies not found' };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'evolveStrategies failed'
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const ensureResult = await tryEnsureStrategyPoolStrategies();

    const latestDraw = await getLatestDraw();
    if (!latestDraw) {
      return res.status(200).json({
        ok: true,
        message: 'no draw',
        ensureOk: ensureResult.ok,
        ensureError: ensureResult.error
      });
    }

    const lastProcessed = await getLastPredictionDrawNo();

    if (toNum(latestDraw.draw_no) === lastProcessed) {
      return res.status(200).json({
        ok: true,
        message: 'already processed',
        draw_no: toNum(latestDraw.draw_no, 0),
        ensureOk: ensureResult.ok,
        ensureError: ensureResult.error
      });
    }

    const strategies = await getActiveStrategies();
    const recentRows = await getRecentDrawRows();
    const groups = buildGroupsFromStrategies(strategies, recentRows);

    if (!groups.length || groups.some((g) => !Array.isArray(g.nums) || g.nums.length !== 4)) {
      return res.status(200).json({
        ok: false,
        error: 'failed to build groups',
        ensureOk: ensureResult.ok,
        ensureError: ensureResult.error
      });
    }

    const prediction = await insertPrediction(latestDraw.draw_no, groups);
    const compareRows = recentRows.slice(0, DRAW_COMPARE_LIMIT);

    const payload = await tryBuildComparePayload({
      prediction,
      groups,
      drawRows: compareRows,
      drawNoCol: 'draw_no',
      drawTimeCol: 'draw_time',
      drawNumbersCol: 'numbers',
      costPerGroupPerPeriod: 25
    });

    await updateComparedPrediction(prediction.id, payload);

    let statsResult = { ok: false, error: null };
    if (payload?.compareResult?.groups?.length) {
      statsResult = await tryRecordStrategyCompareResult(payload.compareResult);
    }

    const evolutionResult = await tryEvolveStrategies();

    return res.status(200).json({
      ok: true,
      prediction_id: prediction.id,
      draw_no: toNum(latestDraw.draw_no, 0),
      ensureOk: ensureResult.ok,
      ensureError: ensureResult.error,
      statsRecorded: statsResult.ok,
      statsError: statsResult.error,
      evolutionOk: evolutionResult.ok,
      evolutionError: evolutionResult.error
    });
  } catch (error) {
    console.error('auto-train error:', error);
    return res.status(500).json({
      ok: false,
      error: error?.message || 'fail'
    });
  }
}
