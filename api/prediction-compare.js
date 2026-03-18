import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
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

const DRAW_NO_COL = 'draw_no';
const DRAW_TIME_COL = 'draw_time';
const DRAW_NUMBERS_COL = 'numbers';

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueAsc(nums) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function buildMarketSignalFromNumbers(numbers = []) {
  const nums = uniqueAsc(numbers);

  if (!nums.length) {
    return {
      sum: 0,
      span: 0,
      sum_tail: 0,
      odd_count: 0,
      even_count: 0,
      big_count: 0,
      small_count: 0,
      zone_1_count: 0,
      zone_2_count: 0,
      zone_3_count: 0,
      zone_4_count: 0
    };
  }

  const sum = nums.reduce((acc, n) => acc + n, 0);
  const span = nums[nums.length - 1] - nums[0];

  let oddCount = 0;
  let evenCount = 0;
  let bigCount = 0;
  let smallCount = 0;
  let zone1 = 0;
  let zone2 = 0;
  let zone3 = 0;
  let zone4 = 0;

  for (const n of nums) {
    if (n % 2 === 0) evenCount += 1;
    else oddCount += 1;

    if (n >= 41) bigCount += 1;
    else smallCount += 1;

    if (n >= 1 && n <= 20) zone1 += 1;
    else if (n <= 40) zone2 += 1;
    else if (n <= 60) zone3 += 1;
    else zone4 += 1;
  }

  return {
    sum,
    span,
    sum_tail: sum % 10,
    odd_count: oddCount,
    even_count: evenCount,
    big_count: bigCount,
    small_count: smallCount,
    zone_1_count: zone1,
    zone_2_count: zone2,
    zone_3_count: zone3,
    zone_4_count: zone4
  };
}

function buildCompareMarketSnapshot(drawRows = []) {
  const normalized = (Array.isArray(drawRows) ? drawRows : []).map((row) => {
    const numbers = parseDrawNumbers(row?.[DRAW_NUMBERS_COL]);
    return {
      draw_no: toInt(row?.[DRAW_NO_COL], 0),
      draw_time: row?.[DRAW_TIME_COL] || null,
      numbers,
      signal: buildMarketSignalFromNumbers(numbers)
    };
  });

  const latest = normalized[0] || null;
  const prev = normalized[1] || null;

  return {
    latest: latest
      ? {
          draw_no: latest.draw_no,
          draw_time: latest.draw_time,
          numbers: latest.numbers,
          ...latest.signal
        }
      : null,
    prev: prev
      ? {
          draw_no: prev.draw_no,
          draw_time: prev.draw_time,
          numbers: prev.numbers,
          ...prev.signal
        }
      : null
  };
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
  const sourceDrawNo = toInt(prediction.source_draw_no);
  const targetPeriods = toInt(prediction.target_periods || 2);

  const start = sourceDrawNo + 1;
  const end = sourceDrawNo + targetPeriods;

  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select(`${DRAW_NO_COL}, ${DRAW_TIME_COL}, ${DRAW_NUMBERS_COL}`)
    .gte(DRAW_NO_COL, start)
    .lte(DRAW_NO_COL, end)
    .order(DRAW_NO_COL, { ascending: true });

  if (error) throw error;

  return (data || []).filter((row) => parseDrawNumbers(row[DRAW_NUMBERS_COL]).length > 0);
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
        error: 'Prediction not found'
      });
    }

    const groups = parsePredictionGroups(prediction, 4);
    if (!groups.length) {
      return res.status(400).json({
        ok: false,
        error: 'groups_json 解析失敗'
      });
    }

    const drawRows = await getDrawRowsForPrediction(prediction);
    const targetPeriods = toInt(prediction.target_periods || 2);

    if (drawRows.length < targetPeriods) {
      const sourceDrawNo = toInt(prediction.source_draw_no);
      return res.status(200).json({
        ok: false,
        waiting: true,
        error: `尚未收齊第 ${sourceDrawNo + 1} 期到第 ${sourceDrawNo + targetPeriods} 期開獎資料`
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

    const marketSnapshot = buildCompareMarketSnapshot(drawRows);

    const { error } = await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'compared',
        compare_status: 'done',
        compared_at: new Date().toISOString(),
        compared_draw_count: built.comparedDrawCount,
        compare_result: built.compareResult,
        compare_result_json: built.compareResultJson,
        compare_history_json: [
          {
            compared_at: new Date().toISOString(),
            compare_draw_no: built.compareDrawNo || 0,
            compared_draw_count: built.comparedDrawCount || 0,
            verdict: built.verdict || null,
            hit_count: built.hitCount || 0,
            best_single_hit: built.bestSingleHit || 0,
            market_snapshot: marketSnapshot
          }
        ],
        verdict: built.verdict,
        hit_count: built.hitCount,
        best_single_hit: built.bestSingleHit,
        market_snapshot_json: marketSnapshot
      })
      .eq('id', predictionId);

    if (error) throw error;

    let strategyStatsResult = null;

    try {
      strategyStatsResult = await recordStrategyCompareResult(built.compareResult);
      console.log('recordStrategyCompareResult result:', strategyStatsResult);
    } catch (err) {
      console.error('recordStrategyCompareResult error:', err?.message || err);
    }

    return res.status(200).json({
      ok: true,
      result: built.resultForApp,
      compare_result: built.compareResult,
      strategyStatsResult
    });
  } catch (error) {
    console.error('prediction-compare error:', error);

    return res.status(500).json({
      ok: false,
      error: error?.message || 'prediction compare failed'
    });
  }
}
