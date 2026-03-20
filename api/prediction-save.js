import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function generatePredictionId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

async function getBestStrategies(limit = 4) {
  const { data, error } = await supabase
    .from('strategy_stats')
    .select('*')
    .order('roi', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function pickNumbersFromStats(statsList = []) {
  // 用 strategy_stats 做 deterministic 產生（不是亂數）
  return statsList.map((s, idx) => {
    const base = Math.abs(
      [...String(s.strategy_key)].reduce((acc, c) => acc + c.charCodeAt(0), 0)
    );

    const nums = [
      (base % 80) + 1,
      ((base + 13) % 80) + 1,
      ((base + 27) % 80) + 1,
      ((base + 41) % 80) + 1
    ];

    const unique = [...new Set(nums)].slice(0, 4);

    while (unique.length < 4) {
      unique.push(((base + unique.length * 7) % 80) + 1);
    }

    return {
      key: s.strategy_key,
      nums: unique.sort((a, b) => a - b)
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  try {
    const mode = 'formal';

    const { data: draw } = await supabase
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(1)
      .single();

    if (!draw) {
      return res.status(200).json({ ok: true, message: 'no draw' });
    }

    // 🔥 核心：直接用 strategy_stats（你已驗證有數據）
    const stats = await getBestStrategies(4);

    let groups = [];

    if (stats.length >= 4) {
      groups = pickNumbersFromStats(stats);
    } else {
      // fallback（只在極端狀況）
      groups = [
        { key: 'fallback_1', nums: [1, 2, 3, 4] },
        { key: 'fallback_2', nums: [5, 6, 7, 8] },
        { key: 'fallback_3', nums: [9, 10, 11, 12] },
        { key: 'fallback_4', nums: [13, 14, 15, 16] }
      ];
    }

    const { data } = await supabase
      .from('bingo_predictions')
      .insert({
        id: generatePredictionId(),
        mode,
        status: 'created',
        source_draw_no: String(draw.draw_no),
        target_periods: 4,
        groups_json: groups,
        created_at: new Date().toISOString()
      })
      .select('*')
      .single();

    return res.status(200).json({
      ok: true,
      row: data,
      groups
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
