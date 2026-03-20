import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult?.detail) return;

  for (const row of compareResult.detail) {
    const key = row.strategy_key;

    const { data: existing } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    const totalRounds = (existing?.total_rounds || 0) + 1;
    const totalHits = (existing?.total_hits || 0) + row.hit;

    const totalCost = (existing?.total_cost || 0) + row.cost;
    const totalReward = (existing?.total_reward || 0) + row.reward;

    const totalProfit = totalReward - totalCost;
    const roi = totalCost > 0 ? totalProfit / totalCost : 0;

    const avgHit = totalRounds > 0 ? totalHits / totalRounds : 0;
    const hitRate = avgHit / 4;

    await supabase.from('strategy_stats').upsert({
      strategy_key: key,
      total_rounds: totalRounds,
      total_hits: totalHits,
      total_cost: totalCost,
      total_reward: totalReward,
      total_profit: totalProfit,
      roi,
      avg_hit: avgHit,
      hit_rate: hitRate,
      updated_at: new Date().toISOString()
    });
  }
}
