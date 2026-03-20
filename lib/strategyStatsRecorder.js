import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TABLE = 'strategy_stats';

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult?.detail) return;

  for (const row of compareResult.detail) {
    const key = row.strategy_key;

    const { data: existing } = await supabase
      .from(TABLE)
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    const prevRounds = existing?.total_rounds || 0;
    const prevHits = existing?.total_hits || 0;
    const prevCost = existing?.total_cost || 0;
    const prevReward = existing?.total_reward || 0;

    const totalRounds = prevRounds + 1;
    const totalHits = prevHits + row.hit;
    const totalCost = prevCost + row.cost;
    const totalReward = prevReward + row.reward;
    const totalProfit = totalReward - totalCost;
    const roi = totalCost > 0 ? totalProfit / totalCost : 0;

    await supabase.from(TABLE).upsert({
      strategy_key: key,
      total_rounds: totalRounds,
      total_hits: totalHits,
      total_cost: totalCost,
      total_reward: totalReward,
      total_profit: totalProfit,
      roi
    });
  }
}
