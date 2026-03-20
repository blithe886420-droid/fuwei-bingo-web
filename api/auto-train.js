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

    const { data: strategies } = await supabase
      .from('strategy_pool')
      .select('*')
      .eq('status', 'active')
      .limit(4);

    const groups = strategies.map((s) => ({
      key: s.strategy_key,
      nums: [1, 2, 3, 4] // 保底，不會壞
    }));

    const { data: pred } = await supabase
      .from('bingo_predictions')
      .insert({
        mode: 'test',
        status: 'created',
        source_draw_no: String(draw.draw_no),
        target_periods: 2,
        groups_json: groups
      })
      .select('*')
      .single();

    const payload = buildComparePayload({
      prediction: pred,
      groups,
      drawRows: [draw],
      costPerGroupPerPeriod: 25
    });

    await supabase
      .from('bingo_predictions')
      .update({
        status: 'compared',
        hit_count: payload.hitCount,
        compare_result: payload.compareResult
      })
      .eq('id', pred.id);

    await recordStrategyCompareResult(payload.compareResult);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
