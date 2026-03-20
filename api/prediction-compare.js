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
    const { predictionId } = req.body;

    const { data: prediction } = await supabase
      .from('bingo_predictions')
      .select('*')
      .eq('id', predictionId)
      .single();

    const { data: draws } = await supabase
      .from('bingo_draws')
      .select('*')
      .gt('draw_no', prediction.source_draw_no)
      .limit(prediction.target_periods);

    const payload = buildComparePayload({
      prediction,
      groups: prediction.groups_json,
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
        compared_at: new Date().toISOString()
      })
      .eq('id', predictionId);

    await recordStrategyCompareResult(payload.compareResult);

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
