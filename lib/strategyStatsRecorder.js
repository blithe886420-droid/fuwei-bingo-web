import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase env');
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

function safeNum(n, d = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : d;
}

function pushRecent(arr = [], value, limit = 50) {
  const next = [...arr, value];
  return next.slice(-limit);
}

export async function recordStrategyCompareResult(compareResult) {
  const supabase = getSupabase();

  if (!compareResult?.groups?.length) return;

  for (const g of compareResult.groups) {
    const strategyKey = g?.meta?.strategy_key;
    if (!strategyKey) continue;

    const totalCost = safeNum(g.total_cost);
    const totalReward = safeNum(g.total_reward);
    const profit = safeNum(g.total_profit);
    const hitCount = safeNum(g.total_hit_count);

    const { data: old } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', strategyKey)
      .maybeSingle();

    const totalRounds = safeNum(old?.total_rounds) + 1;

    const newTotalCost = safeNum(old?.total_cost) + totalCost;
    const newTotalReward = safeNum(old?.total_reward) + totalReward;
    const newTotalProfit = safeNum(old?.total_profit) + profit;
    const newTotalHits = safeNum(old?.total_hits) + hitCount;

    const newAvgHit =
      totalRounds > 0
        ? (safeNum(old?.avg_hit) * safeNum(old?.total_rounds) + hitCount) /
          totalRounds
        : hitCount;

    const newRoi =
      newTotalCost > 0 ? (newTotalProfit / newTotalCost) * 100 : 0;

    const hit0 = safeNum(old?.hit0) + (g.hit0_count || 0);
    const hit1 = safeNum(old?.hit1) + (g.hit1_count || 0);
    const hit2 = safeNum(old?.hit2) + (g.hit2_count || 0);
    const hit3 = safeNum(old?.hit3) + (g.hit3_count || 0);
    const hit4 = safeNum(old?.hit4) + (g.hit4_count || 0);

    const hitRate =
      totalRounds > 0 ? (newTotalHits / totalRounds) : 0;

    const recentHits = pushRecent(old?.recent_hits || [], hitCount);
    const recentProfit = pushRecent(old?.recent_profit || [], profit);

    await supabase.from('strategy_stats').upsert({
      strategy_key: strategyKey,
      total_rounds: totalRounds,
      total_hits: newTotalHits,

      total_cost: newTotalCost,
      total_reward: newTotalReward,
      total_profit: newTotalProfit,

      avg_hit: newAvgHit,
      roi: newRoi,
      hit_rate: hitRate,

      hit0,
      hit1,
      hit2,
      hit3,
      hit4,

      recent_hits: recentHits,
      recent_profit: recentProfit,

      updated_at: new Date().toISOString()
    });
  }
}
