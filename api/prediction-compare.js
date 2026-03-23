import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

let supabase = null;

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

export default async function handler(req, res) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({
        ok: false,
        error: 'Missing SUPABASE env'
      });
    }

    if (!supabase) {
      supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false }
      });
    }

    const COST = 25;

    const { data: predictions, error: pError } = await supabase
      .from('bingo_predictions')
      .select('*')
      .eq('status', 'created')
      .order('created_at', { ascending: true })
      .limit(10);

    if (pError) throw pError;

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    const errorDetails = [];
    const disabledKeysAll = [];

    for (const p of safeArray(predictions)) {
      try {
        const sourceDrawNo = toNum(p.source_draw_no);
        const targetPeriods = toNum(p.target_periods);

        if (!sourceDrawNo || !targetPeriods) {
          skipped++;
          errorDetails.push({
            id: p?.id || null,
            source_draw_no: p?.source_draw_no || null,
            reason: 'invalid source_draw_no or target_periods'
          });
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
          errorDetails.push({
            id: p?.id || null,
            source_draw_no: p?.source_draw_no || null,
            reason: 'not enough future draws yet'
          });
          continue;
        }

        const groups = safeArray(p.groups_json);

        if (groups.length === 0) {
          skipped++;
          errorDetails.push({
            id: p?.id || null,
            source_draw_no: p?.source_draw_no || null,
            reason: 'groups_json empty'
          });
          continue;
        }

        const payload = buildComparePayload({
          groups,
          drawRows: draws,
          costPerGroupPerPeriod: COST
        });

        if (!payload || !payload.compareResult) {
          failed++;
          errorDetails.push({
            id: p?.id || null,
            source_draw_no: p?.source_draw_no || null,
            reason: 'buildComparePayload returned empty compareResult'
          });
          continue;
        }

        const compareResult = payload.compareResult;
        const compareDetail = Array.isArray(compareResult.detail) ? compareResult.detail : [];

        if (compareDetail.length === 0) {
          failed++;
          errorDetails.push({
            id: p?.id || null,
            source_draw_no: p?.source_draw_no || null,
            reason: 'compareResult.detail empty'
          });
          continue;
        }

        const { error: uError } = await supabase
          .from('bingo_predictions')
          .update({
            status: 'compared',
            compare_status: 'done',
            hit_count: toNum(payload.hitCount),
            compare_result: compareResult,
            verdict: payload.verdict || 'bad',
            compared_at: new Date().toISOString()
          })
          .eq('id', p.id);

        if (uError) throw uError;

        try {
          const statsResult = await recordStrategyCompareResult(compareResult);

          if (Array.isArray(statsResult?.disabled_keys) && statsResult.disabled_keys.length > 0) {
            disabledKeysAll.push(...statsResult.disabled_keys);
          }
        } catch (statsError) {
          console.error('recordStrategyCompareResult failed:', {
            prediction_id: p?.id || null,
            source_draw_no: p?.source_draw_no || null,
            mode: p?.mode || null,
            error: statsError?.message || String(statsError)
          });

          errorDetails.push({
            id: p?.id || null,
            source_draw_no: p?.source_draw_no || null,
            reason: `recordStrategyCompareResult failed: ${statsError?.message || String(statsError)}`
          });

          throw statsError;
        }

        processed++;
      } catch (err) {
        failed++;

        console.error('prediction-compare item failed:', {
          id: p?.id || null,
          source_draw_no: p?.source_draw_no || null,
          mode: p?.mode || null,
          error: err?.message || String(err)
        });

        errorDetails.push({
          id: p?.id || null,
          source_draw_no: p?.source_draw_no || null,
          reason: err?.message || String(err)
        });
      }
    }

    return res.status(200).json({
      ok: true,
      processed,
      skipped,
      failed,
      disabled_keys: [...new Set(disabledKeysAll)],
      error_details: errorDetails.slice(0, 20)
    });
  } catch (e) {
    console.error('prediction-compare fatal error:', e);

    return res.status(200).json({
      ok: false,
      error: e?.message || 'error'
    });
  }
}
