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

export default async function handler(req, res) {
  try {
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

        const groups = safeArray(p.groups_json);

        if (groups.length === 0) {
          skipped++;
          continue;
        }

        const payload = buildComparePayload({
          groups,
          drawRows: draws,
          costPerGroupPerPeriod: COST
        });

        if (!payload || !payload.compareResult) {
          failed++;
          continue;
        }

        const { error: uError } = await supabase
          .from('bingo_predictions')
          .update({
            status: 'compared',
            compare_status: 'done',
            hit_count: toNum(payload.hitCount),
            compare_result: payload.compareResult,
            verdict: payload.verdict || 'bad',
            compared_at: new Date().toISOString()
          })
          .eq('id', p.id);

        if (uError) throw uError;

        try {
          await recordStrategyCompareResult(payload.compareResult);
        } catch (err) {
          // 不影響主流程
        }

        processed++;
      } catch (err) {
        failed++;
        continue;
      }
    }

    return res.status(200).json({
      ok: true,
      processed,
      skipped,
      failed
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: e?.message || 'error'
    });
  }
}
