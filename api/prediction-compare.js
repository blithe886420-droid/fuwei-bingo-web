import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { evolveStrategies } from '../lib/strategyEvolutionEngine.js';
import {
  parsePredictionGroups,
  buildComparePayload,
  parseDrawNumbers
} from '../lib/buildComparePayload.js';

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
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const COST_PER_GROUP_PER_PERIOD = 25;

const DRAW_NO_COL = 'draw_no';
const DRAW_TIME_COL = 'draw_time';
const DRAW_NUMBERS_COL = 'numbers';

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function getPredictionById(predictionId) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('id', predictionId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getDrawRowsForPrediction(prediction) {
  const sourceDrawNo = toInt(prediction?.source_draw_no);
  const targetPeriods = toInt(prediction?.target_periods || 1, 1);

  const start = sourceDrawNo + 1;
  const end = sourceDrawNo + targetPeriods;

  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select(`${DRAW_NO_COL}, ${DRAW_TIME_COL}, ${DRAW_NUMBERS_COL}`)
    .gte(DRAW_NO_COL, start)
    .lte(DRAW_NO_COL, end)
    .order(DRAW_NO_COL, { ascending: true });

  if (error) throw error;

  return (data || []).filter((row) => {
    const nums = parseDrawNumbers(row?.[DRAW_NUMBERS_COL]);
    return nums.length > 0;
  });
}

async function updatePredictionCompared(predictionId, built) {
  const payload = {
    status: 'compared',
    compare_status: 'done',
    compared_at: new Date().toISOString(),
    compare_result: built?.compareResult || null,
    verdict: built?.verdict || null,
    hit_count: toInt(built?.hitCount, 0)
  };

  const { error } = await supabase
    .from(PREDICTIONS_TABLE)
    .update(payload)
    .eq('id', predictionId);

  if (error) throw error;
}

function findGroupHitCount(group = {}) {
  return toInt(
    group.hit_count ??
      group.hitCount ??
      group.total_hit_count ??
      group.totalHits ??
      group.hits,
    0
  );
}

function findGroupReward(group = {}, hitCount = 0) {
  const candidates = [
    group.reward,
    group.total_reward,
    group.totalReward,
    group.prize,
    group.win_amount,
    group.winAmount
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  if (hitCount >= 4) return 1000;
  if (hitCount === 3) return 75;
  if (hitCount === 2) return 0;
  if (hitCount === 1) return 0;
  return 0;
}

function buildStatsRowsFromCompareResult(compareResult) {
  if (!Array.isArray(compareResult)) return [];

  const rows = [];

  for (const period of compareResult) {
    const drawNo = toInt(period?.draw_no ?? period?.drawNo, 0);
    const groups = Array.isArray(period?.groups) ? period.groups : [];

    for (const group of groups) {
      const strategyKey =
        group?.strategy_key ||
        group?.strategyKey ||
        group?.meta?.strategy_key ||
        group?.key ||
        null;

      if (!strategyKey) continue;

      const strategyLabel =
        group?.strategy_label ||
        group?.strategyLabel ||
        group?.label ||
        group?.name ||
        null;

      const hitCount = findGroupHitCount(group);
      const cost = COST_PER_GROUP_PER_PERIOD;
      const reward = findGroupReward(group, hitCount);
      const profit = reward - cost;

      rows.push({
        draw_no: drawNo,
        strategy_key: String(strategyKey),
        strategy_label: strategyLabel ? String(strategyLabel) : null,
        hit_count: hitCount,
        cost,
        reward,
        profit
      });
    }
  }

  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const predictionId = req.body?.predictionId;

    if (!predictionId) {
      return res.status(400).json({
        ok: false,
        error: 'predictionId is required'
      });
    }

    const prediction = await getPredictionById(predictionId);

    if (!prediction) {
      return res.status(404).json({
        ok: false,
        error: 'prediction not found'
      });
    }

    const groups = parsePredictionGroups(prediction, 4);

    if (!groups.length) {
      return res.status(400).json({
        ok: false,
        error: 'prediction groups not found'
      });
    }

    const drawRows = await getDrawRowsForPrediction(prediction);

    if (drawRows.length === 0) {
      return res.status(200).json({
        ok: false,
        waiting: true,
        error: 'draw rows not ready yet'
      });
    }

    const built = buildComparePayload({
      prediction,
      groups,
      drawRows,
      drawNoCol: DRAW_NO_COL,
      drawTimeCol: DRAW_TIME_COL,
      drawNumbersCol: DRAW_NUMBERS_COL
    });

    if (!built || !built.compareResult) {
      return res.status(500).json({
        ok: false,
        error: 'buildComparePayload failed'
      });
    }

    await updatePredictionCompared(predictionId, built);

    let statsRecorded = false;
    let statsError = null;
    let statsRows = [];

    try {
      statsRows = buildStatsRowsFromCompareResult(built.compareResult);
      await recordStrategyCompareResult(statsRows);
      statsRecorded = true;
    } catch (e) {
      statsRecorded = false;
      statsError = e?.message || 'recordStrategyCompareResult failed';
      console.error('recordStrategyCompareResult error:', e);
    }

    let evolutionResult = null;
    let evolutionError = null;

    try {
      evolutionResult = await evolveStrategies();
    } catch (e) {
      evolutionError = e?.message || 'evolveStrategies failed';
      console.error('evolveStrategies error:', e);
    }

    return res.status(200).json({
      ok: true,
      result: built.resultForApp || null,
      compareResult: built.compareResult || null,
      statsRecorded,
      statsError,
      statsRows,
      evolution: evolutionResult,
      evolutionError
    });
  } catch (error) {
    console.error('prediction-compare error:', error);
    return res.status(500).json({
      ok: false,
      error: error?.message || 'prediction compare failed'
    });
  }
}
