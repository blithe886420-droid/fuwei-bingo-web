import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function generatePredictionId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  try {
    const { mode = 'formal', groups = [] } = req.body || {};

    const { data: draw } = await supabase
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(1)
      .single();

    const targetPeriods = mode === 'formal' ? 4 : 2;

    const { data } = await supabase
      .from('bingo_predictions')
      .insert({
        id: generatePredictionId(),
        mode,
        status: 'created',
        source_draw_no: String(draw.draw_no),
        target_periods: targetPeriods,
        groups_json: groups,
        created_at: new Date().toISOString()
      })
      .select('*')
      .single();

    return res.status(200).json({ ok: true, row: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
