import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    const { groups, source_draw_no, target_periods = 2, mode = 'test' } = req.body;

    const { data } = await supabase
      .from('bingo_predictions')
      .insert({
        id: Date.now(),
        mode,
        status: 'created',
        source_draw_no: String(source_draw_no),
        target_periods,
        groups_json: groups,
        created_at: new Date().toISOString()
      })
      .select('*')
      .single();

    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
