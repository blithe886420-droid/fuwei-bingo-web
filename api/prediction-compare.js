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
  const targetPeriods = toInt(prediction.target_periods || 1);

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
    return res.status(405).json({ ok: false });
  }

  try {
    const predictionId = req.body?.predictionId;
    if (!predictionId) {
      return res.status(400).json({ ok: false });
    }

    const prediction = await getPredictionById(predictionId);
    if (!prediction) {
      return res.status(404).json({ ok: false });
    }

    const groups = parsePredictionGroups(prediction, 4);
    if (!groups.length) {
      return res.status(400).json({ ok: false });
    }

    const drawRows = await getDrawRowsForPrediction(prediction);

    if (drawRows.length === 0) {
      return res.status(200).json({
        ok: false,
        waiting: true
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

    await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'compared',
        compare_status: 'done',
        compared_at: new Date().toISOString(),
        compare_result: built.compareResult,
        verdict: built.verdict,
        hit_count: built.hitCount
      })
      .eq('id', predictionId);

    // ✅ 記錄統計
    await recordStrategyCompareResult(built.compareResult);

    // ✅ 關鍵：啟動策略進化
    let evolutionResult = null;
    try {
      evolutionResult = await evolveStrategies();
    } catch (e) {
      console.error('evolveStrategies error:', e);
    }

    return res.status(200).json({
      ok: true,
      result: built.resultForApp,
      evolution: evolutionResult
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
