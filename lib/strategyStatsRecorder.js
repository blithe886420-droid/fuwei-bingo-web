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

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tailArray(arr = [], maxSize = 50) {
  const safe = Array.isArray(arr) ? arr : [];
  return safe.slice(Math.max(0, safe.length - maxSize));
}

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult?.detail || !Array.isArray(compareResult.detail)) return;

  for (const row of compareResult.detail) {
    const key = String(row?.strategy_key || '').trim();
    if (!key) continue;

    const hit = toNum(row?.hit, 0);
    const cost = toNum(row?.cost, 0);
    const reward = toNum(row?.reward, 0);
    const profit = reward - cost;

    const { data: existing } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    const totalRounds = toNum(existing?.total_rounds, 0) + 1;
    const totalHits = toNum(existing?.total_hits, 0) + hit;
    const totalCost = toNum(existing?.total_cost, 0) + cost;
    const totalReward = toNum(existing?.total_reward, 0) + reward;
    const totalProfit = totalReward - totalCost;

    const avgHit = totalRounds > 0 ? totalHits / totalRounds : 0;
    const hitRate = totalRounds > 0 ? totalHits / (totalRounds * 4) : 0;
    const roi = totalCost > 0 ? totalProfit / totalCost : 0;

    const recentHits = tailArray(
      [...(existing?.recent_hits || []), hit],
      50
    );

    const recentProfit = tailArray(
      [...(existing?.recent_profit || []), profit],
      50
    );

    const recentCost = tailArray(
      [...(existing?.recent_cost || []), cost],
      50
    );

    const recent50HitRate =
      recentHits.length > 0
        ? recentHits.filter((x) => x >= 2).length / recentHits.length
        : 0;

    const sumRecentProfit = recentProfit.reduce((s, x) => s + toNum(x), 0);
    const sumRecentCost = recentCost.reduce((s, x) => s + toNum(x), 0);

    const recent50Roi =
      sumRecentCost > 0 ? sumRecentProfit / sumRecentCost : 0;

    // 🔥 重寫 score（穩定優先）
    const score =
      roi * 300 +
      avgHit * 200 +
      recent50HitRate * 150 +
      recent50Roi * 300 +
      Math.min(totalRounds, 200) * 1;

    const payload = {
      strategy_key: key,
      total_rounds: totalRounds,
      total_hits: totalHits,
      avg_hit: avgHit,
      hit_rate: hitRate,
      total_cost: totalCost,
      total_reward: totalReward,
      total_profit: totalProfit,
      roi,
      recent_hits: recentHits,
      recent_profit: recentProfit,
      recent_cost: recentCost,
      recent_50_hit_rate: recent50HitRate,
      recent_50_roi: recent50Roi,
      score,
      updated_at: new Date().toISOString()
    };

    await supabase
      .from('strategy_stats')
      .upsert(payload, { onConflict: 'strategy_key' });
  }
}
