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

const CURRENT_MODE = 'test';
const PICK_COUNT = 4;
const DRAW_COMPARE_LIMIT = 2;
const RECENT_ANALYSIS_LIMIT = 20;

const STRATEGY_POOL_TABLE = 'strategy_pool';
const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE service role key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

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

function uniqueKeepOrder(nums) {
  const seen = new Set();
  const result = [];
  for (const n of (Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite)) {
    if (seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }
  return result;
}

function inferGenes(strategyKey = '') {
  const tokens = String(strategyKey || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean);

  return {
    gene_a: tokens[0] || 'mix',
    gene_b: tokens[1] || 'balanced'
  };
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
  for (let i = 1; i <= 80; i++) freq.set(i, 0);
  for (const n of allNums) freq.set(n, (freq.get(n) || 0) + 1);

  const hottest = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n);

  const coldest = [...freq.entries()]
    .sort((a, b) => a[1] - b[1])
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
    const key = row.strategy_key || `strategy_${idx}`;
    const seed = stableHash(key);

    const pool = rotateList(analysis.hottest, seed % 10);
    const nums = uniqueAsc(pool.slice(0, 4));

    return {
      key,
      nums,
      meta: { strategy_key: key }
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
  return data;
}

async function getLastPredictionDrawNo() {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('source_draw_no')
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
    .eq('status', 'active');

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export default async function handler(req, res) {
  try {
    const latestDraw = await getLatestDraw();
    if (!latestDraw) {
      return res.status(200).json({ ok: true, message: 'no draw' });
    }

    const lastProcessed = await getLastPredictionDrawNo();

    if (toNum(latestDraw.draw_no) === lastProcessed) {
      return res.status(200).json({
        ok: true,
        message: 'already processed'
      });
    }

    const strategies = await getActiveStrategies();
    const picked = strategies.slice(0, PICK_COUNT);

    const recentRows = await getRecentDrawRows();
    const groups = buildGroupsFromStrategies(picked, recentRows);

    const insertPayload = {
      mode: CURRENT_MODE,
      status: 'created',
      source_draw_no: String(latestDraw.draw_no),
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const { data: prediction } = await supabase
      .from(PREDICTIONS_TABLE)
      .insert(insertPayload)
      .select('*')
      .single();

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

    await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        compare_result: payload.compareResult ?? null,
        compare_status: 'done',
        status: 'compared',
        compared_at: new Date().toISOString()
      })
      .eq('id', prediction.id);

    if (payload?.compareResult?.groups?.length) {
      await recordStrategyCompareResult(payload.compareResult);
    }

    await evolveStrategies();

    return res.status(200).json({
      ok: true,
      prediction_id: prediction.id
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'fail'
    });
  }
}
