import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function weightedPick(strategies, count = 4) {
  const result = [];

  const totalWeight = strategies.reduce(
    (sum, s) => sum + (s.weight || 1),
    0
  );

  for (let i = 0; i < count; i++) {
    let r = Math.random() * totalWeight;

    for (const s of strategies) {
      r -= s.weight || 1;
      if (r <= 0) {
        result.push(s);
        break;
      }
    }
  }

  return result;
}

export default async function handler(req, res) {
  try {
    const { data: strategies } = await supabase
      .from('strategy_pool')
      .select('*')
      .eq('status', 'active');

    const picked = weightedPick(strategies, 4);

    const groups = picked.map((s, i) => ({
      key: `g${i}`,
      nums: s.numbers || [],
      meta: { strategy_key: s.strategy_key }
    }));

    const { data: prediction } = await supabase
      .from('bingo_predictions')
      .insert({
        groups_json: groups,
        created_at: new Date().toISOString(),
        status: 'created'
      })
      .select()
      .single();

    // 🔥 假設你有 compare function
    const compareResult = {
      groups: groups.map((g) => ({
        ...g,
        total_hit_count: Math.floor(Math.random() * 5),
        roi: Math.random() * 100 - 50
      }))
    };

    await recordStrategyCompareResult(compareResult);

    // 🔥 自動淘汰
    for (const s of strategies) {
      if (s.weight < 0.3) {
        await supabase
          .from('strategy_pool')
          .update({ status: 'retired' })
          .eq('strategy_key', s.strategy_key);
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
