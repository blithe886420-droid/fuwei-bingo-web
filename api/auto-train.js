import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import {
  buildComparePayload,
  parseDrawNumbers
} from '../lib/buildComparePayload.js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';
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
    latestDraw,
    numbers1to80: Array.from({ length: 80 }, (_, i) => i + 1)
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

async function getActiveStrategies() {
  await ensureStrategyPoolStrategies({
    strategyKeys: [
      'hot_balanced',
      'balanced_zone',
      'hot_chase',
      'repeat_guard'
    ],
    sourceType: 'seed',
    status: 'active'
  });

  const { data, error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const latestDraw = await getLatestDraw();

    if (!latestDraw) {
      return res.status(200).json({
        ok: true,
        message: 'no draw'
      });
    }

    const lastProcessed = await getLastPredictionDrawNo();

    if (toNum(latestDraw.draw_no) === lastProcessed) {
      return res.status(200).json({
        ok: true,
        message: 'already processed',
        draw_no: toNum(latestDraw.draw_no, 0)
      });
    }

    const strategies = await getActiveStrategies();

    if (!strategies.length) {
      return res.status(200).json({
        ok: false,
        error: 'no active strategies'
      });
    }

    const recentRows = await getRecentDrawRows();
    const groups = buildGroupsFromStrategies(strategies, recentRows);

    if (!groups.length || groups.some((g) => !Array.isArray(g.nums) || g.nums.length !== 4)) {
      return res.status(200).json({
        ok: false,
        error: 'failed to build groups'
      });
    }

    const prediction = await insertPrediction(latestDraw.draw_no, groups);

    const compareRows = recentRows.slice(0, DRAW_COMPARE_LIMIT);

    const payload = buildComparePayload({
      prediction,
      groups,
      drawRows: compareRows,
      drawNoCol: 'draw_no',
      drawTimeCol: 'draw_time',
      drawNumbersCol: 'numbers',
      costPerGroupPerPeriod: 25
    });

    await updateComparedPrediction(prediction.id, payload);

    let statsRecorded = false;
    let statsError = null;

    try {
      if (payload?.compareResult?.groups?.length) {
        await recordStrategyCompareResult(payload.compareResult);
        statsRecorded = true;
      }
    } catch (error) {
      statsError = error?.message || 'recordStrategyCompareResult failed';
      console.error('auto-train stats error:', error);
    }

    let evolutionOk = false;
    let evolutionError = null;

    try {
      await evolveStrategies();
      evolutionOk = true;
    } catch (error) {
      evolutionError = error?.message || 'evolveStrategies failed';
      console.error('auto-train evolve error:', error);
    }

    return res.status(200).json({
      ok: true,
      prediction_id: prediction.id,
      draw_no: toNum(latestDraw.draw_no, 0),
      statsRecorded,
      statsError,
      evolutionOk,
      evolutionError
    });
  } catch (error) {
    console.error('auto-train error:', error);
    return res.status(500).json({
      ok: false,
      error: error?.message || 'fail'
    });
  }
}
