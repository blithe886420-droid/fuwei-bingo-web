import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const { data: list } = await supabase
      .from('bingo_predictions')
      .select('*')
      .eq('status', 'created')
      .limit(20);

    for (const p of list || []) {
      const { data: draws } = await supabase
        .from('bingo_draws')
        .select('*')
        .gt('draw_no', p.source_draw_no)
        .order('draw_no', { ascending: true })
        .limit(p.target_periods);

      if (!draws || draws.length < p.target_periods) continue;

      const payload = buildComparePayload({
        groups: p.groups_json,
        drawRows: draws,
        costPerGroupPerPeriod: 25
      });

      await supabase
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

      await recordStrategyCompareResult(payload.compareResult);
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
