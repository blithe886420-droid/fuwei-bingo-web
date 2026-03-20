import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  try {
    const { data: draw } = await supabase
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(1)
      .single();

    if (!draw) {
      return res.status(200).json({ ok: true, message: 'no draw' });
    }

    const { data: strategies } = await supabase
      .from('strategy_pool')
      .select('*')
      .eq('status', 'active')
      .limit(4);

    const groups = (strategies || []).map((s, idx) => ({
      key: s.strategy_key || `s_${idx}`,
      nums: [1 + idx, 2 + idx, 3 + idx, 4 + idx]
    }));

    const { data: prediction } = await supabase
      .from('bingo_predictions')
      .insert({
        mode: 'test',
        status: 'created',
        source_draw_no: String(draw.draw_no),
        target_periods: 2,
        groups_json: groups,
        created_at: new Date().toISOString()
      })
      .select('*')
      .single();

    const payload = buildComparePayload({
      prediction,
      groups,
      drawRows: [draw],
      costPerGroupPerPeriod: 25
    });

    await supabase
      .from('bingo_predictions')
      .update({
        status: 'compared',
        compare_status: 'done',
        hit_count: payload.hitCount,
        compare_result: payload.compareResult,
        compared_at: new Date().toISOString()
      })
      .eq('id', prediction.id);

    await recordStrategyCompareResult(payload.compareResult);

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
