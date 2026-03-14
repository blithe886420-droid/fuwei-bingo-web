import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import {
  parsePredictionGroups,
  buildComparePayload,
  parseDrawNumbers
} from '../lib/buildComparePayload.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';

const DRAW_NO_COL = 'draw_no';
const DRAW_TIME_COL = 'draw_time';
const DRAW_NUMBERS_COL = 'numbers';

function toInt(value, fallback = 0) {
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

    const { error } = await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'compared',
        compare_status: 'done',
        compared_at: new Date().toISOString(),
        compared_draw_count: built.comparedDrawCount,
        compare_result: built.compareResult,
        compare_result_json: built.compareResultJson,
        compare_history_json: [],
        verdict: built.verdict,
        hit_count: built.hitCount,
        best_single_hit: built.bestSingleHit
      })
      .eq('id', predictionId);

    if (error) throw error;

    let strategyStatsResult = null;

    try {
      strategyStatsResult = await recordStrategyCompareResult({
        drawNo: built.compareDrawNo,
        compareResult: built.resultForApp
      });
      console.log('recordStrategyCompareResult result:', strategyStatsResult);
    } catch (err) {
      console.error('recordStrategyCompareResult error:', err.message);
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
      error: error.message || 'prediction compare failed'
    });
  }
}
