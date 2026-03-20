import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../../lib/strategyStatsRecorder.js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const COST = 25;

function safeArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseGroupsFromPredictionRow(row) {
  if (!row || typeof row !== 'object') return [];

  const candidates = [
    row.groups_json,
    row.groups,
    row.predict_groups,
    row.prediction_groups,
    row.compare_groups
  ];

  for (const value of candidates) {
    const arr = safeArray(value);
    if (arr.length > 0) return arr;
  }

  const jsonCandidates = [
    row.payload_json,
    row.prediction_json,
    row.result_json,
    row.meta_json
  ];

  for (const value of jsonCandidates) {
    if (!value) continue;

    let parsed = value;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        parsed = null;
      }
    }

    if (parsed && typeof parsed === 'object') {
      const arr = safeArray(parsed.groups);
      if (arr.length > 0) return arr;
    }
  }

  return [];
}

export default async function handler(req, res) {
  try {
    if (req.method && req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'Method not allowed'
      });
    }

    const { data: predictions, error: pError } = await supabase
      .from('bingo_predictions')
      .select('*')
      .eq('status', 'created')
      .order('created_at', { ascending: true })
      .limit(100);

    if (pError) throw pError;

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const failedIds = [];

    for (const p of safeArray(predictions)) {
      try {
        const sourceDrawNo = toNum(p.source_draw_no);
        const targetPeriods = toNum(p.target_periods);

        if (!sourceDrawNo || !targetPeriods) {
          skipped++;
          continue;
        }

        const { data: draws, error: dError } = await supabase
          .from('bingo_draws')
          .select('*')
          .gt('draw_no', sourceDrawNo)
          .order('draw_no', { ascending: true })
          .limit(targetPeriods);

        if (dError) throw dError;

        if (!Array.isArray(draws) || draws.length < targetPeriods) {
          skipped++;
          continue;
        }

        const groups = parseGroupsFromPredictionRow(p);

        if (!Array.isArray(groups) || groups.length === 0) {
          skipped++;
          continue;
        }

        const payload = buildComparePayload({
          groups,
          drawRows: draws,
          costPerGroupPerPeriod: COST
        });

        const compareResult = payload?.compareResult || {};
        const hitCount = toNum(payload?.hitCount, 0);
        const verdict = String(payload?.verdict || 'bad');

        const { error: uError } = await supabase
          .from('bingo_predictions')
          .update({
            status: 'compared',
            compare_status: 'done',
            hit_count: hitCount,
            compare_result: compareResult,
            verdict,
            compared_at: new Date().toISOString()
          })
          .eq('id', p.id);

        if (uError) throw uError;

        await recordStrategyCompareResult(compareResult);

        processed++;
      } catch (rowError) {
        failed++;
        failedIds.push(p?.id ?? null);
      }
    }

    return res.status(200).json({
      ok: true,
      processed,
      skipped,
      failed,
      failed_ids: failedIds.filter(Boolean)
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || 'prediction-compare failed'
    });
  }
}
