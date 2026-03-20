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

const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';
const COST = 25;
const MAX_BATCH = 100;

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

async function getPendingPredictions(limit = MAX_BATCH) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('status', 'created')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return safeArray(data);
}

async function getFutureDraws(sourceDrawNo, targetPeriods) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .gt('draw_no', sourceDrawNo)
    .order('draw_no', { ascending: true })
    .limit(targetPeriods);

  if (error) throw error;
  return safeArray(data);
}

async function updatePredictionCompared(id, payload) {
  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'compared',
      compare_status: 'done',
      hit_count: toNum(payload.hitCount, 0),
      compare_result: payload.compareResult,
      verdict: payload.verdict,
      compared_at: nowIso
    })
    .eq('id', id);

  if (error) throw error;
}

export default async function handler(req, res) {
  try {
    const list = await getPendingPredictions(MAX_BATCH);

    let processed = 0;
    let skipped = 0;

    for (const p of list) {
      const sourceDrawNo = toNum(p?.source_draw_no, 0);
      const targetPeriods = toNum(p?.target_periods, 0);

      if (!sourceDrawNo || !targetPeriods) {
        skipped += 1;
        continue;
      }

      const draws = await getFutureDraws(sourceDrawNo, targetPeriods);

      if (draws.length < targetPeriods) {
        skipped += 1;
        continue;
      }

      const payload = buildComparePayload({
        groups: safeArray(p?.groups_json),
        drawRows: draws,
        costPerGroupPerPeriod: COST
      });

      await updatePredictionCompared(p.id, payload);
      await recordStrategyCompareResult(payload.compareResult);

      processed += 1;
    }

    return res.status(200).json({
      ok: true,
      processed,
      skipped,
      total: list.length
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'compare failed'
    });
  }
}
