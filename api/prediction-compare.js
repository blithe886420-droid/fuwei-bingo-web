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
  return Array.isArray(v) ? v : [];
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
  try {
    const { data: predictions, error: pError } = await supabase
      .from('bingo_predictions')
      .select('*')
      .eq('status', 'created')
      .order('created_at', { ascending: true })
      .limit(100);

    if (pError) throw pError;

    let processed = 0;
    let skipped = 0;

    for (const p of safeArray(predictions)) {
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

      if (!draws || draws.length < targetPeriods) {
        skipped++;
        continue;
      }

      const groups = safeArray(p.groups_json);

      const payload = buildComparePayload({
        groups,
        drawRows: draws,
        costPerGroupPerPeriod: COST
      });

      const { error: uError } = await supabase
        .from('bingo_predictions')
        .update({
          status: 'compared',
          compare_status: 'done',
          hit_count: payload.hitCount,
          compare_result: payload.compareResult,
          verdict: payload.verdict,
          compared_at: new Date().toISOString()
        })
        .eq('id', p.id);

      if (uError) throw uError;

      await recordStrategyCompareResult(payload.compareResult);

      processed++;
    }

    return res.status(200).json({
      ok: true,
      processed,
      skipped
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
