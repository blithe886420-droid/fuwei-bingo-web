import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function tail(arr = [], size = 50) {
  return (Array.isArray(arr) ? arr : []).slice(-size);
}

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult?.detail) return;

  for (const row of compareResult.detail) {
    const key = String(row.strategy_key || '').trim();
    if (!key) continue;

    const hit = toNum(row.hit);
    const cost = toNum(row.cost);
    const reward = toNum(row.reward);
    const profit = reward - cost;

    const { data: old } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    const total_rounds = toNum(old?.total_rounds) + 1;
    const total_hits = toNum(old?.total_hits) + hit;
    const total_cost = toNum(old?.total_cost) + cost;
    const total_reward = toNum(old?.total_reward) + reward;
    const total_profit = total_reward - total_cost;

    const avg_hit = total_hits / total_rounds;
    const roi = total_cost > 0 ? total_profit / total_cost : 0;

    const recent_hits = tail([...(old?.recent_hits || []), hit]);
    const recent_profit = tail([...(old?.recent_profit || []), profit]);
    const recent_cost = tail([...(old?.recent_cost || []), cost]);

    const sumRecentProfit = recent_profit.reduce((a, b) => a + toNum(b), 0);
    const sumRecentCost = recent_cost.reduce((a, b) => a + toNum(b), 0);

    const recent_50_roi = sumRecentCost > 0 ? sumRecentProfit / sumRecentCost : 0;
    const recent_50_hit_rate =
      recent_hits.length > 0
        ? recent_hits.filter((x) => x >= 2).length / recent_hits.length
        : 0;

    // 🔥 穩定版評分（重視近期 + 穩定）
    const score =
      roi * 300 +
      avg_hit * 200 +
      recent_50_roi * 400 +
      recent_50_hit_rate * 200 +
      Math.min(total_rounds, 200);

    await supabase
      .from('strategy_stats')
      .upsert(
        {
          strategy_key: key,
          total_rounds,
          total_hits,
          total_cost,
          total_reward,
          total_profit,
          avg_hit,
          roi,
          recent_hits,
          recent_profit,
          recent_cost,
          recent_50_roi,
          recent_50_hit_rate,
          score,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'strategy_key' }
      );
  }
}
