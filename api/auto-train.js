import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function genNums(seed) {
  const base = (seed * 131) % 80;
  return [
    (base % 80) + 1,
    ((base + 9) % 80) + 1,
    ((base + 21) % 80) + 1,
    ((base + 37) % 80) + 1
  ];
}

export default async function handler(req, res) {
  try {
    const { data: latest } = await supabase
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(1);

    if (!latest || latest.length === 0) {
      return res.json({ ok: true });
    }

    const draw = latest[0];

    const groups = Array.from({ length: 4 }, (_, i) => ({
      key: `g_${i + 1}`,
      nums: genNums(Date.now() + i),
      meta: { strategy_key: `g_${i + 1}` }
    }));

    await supabase.from('bingo_predictions').insert({
      id: Date.now(),
      mode: 'test',
      status: 'created',
      source_draw_no: draw.draw_no,
      target_periods: 2,
      groups_json: groups,
      created_at: new Date().toISOString()
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
