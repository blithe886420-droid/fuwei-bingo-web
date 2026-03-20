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
  if (!compareResult?.detail || !Array.isArray(compareResult.detail) || compareResult.detail.length === 0) {
    return;
  }

  for (const row of compareResult.detail) {
    const key = String(row?.strategy_key || '').trim();
    if (!key) continue;

    const hit = toNum(row?.hit, 0);
    const cost = toNum(row?.cost, 0);
    const reward = toNum(row?.reward, 0);
    const profit = reward - cost;

    const { data: existing, error: selectError } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    if (selectError) throw selectError;

    const totalRounds = toNum(existing?.total_rounds, 0) + 1;
    const totalHits = toNum(existing?.total_hits, 0) + hit;
    const totalCost = toNum(existing?.total_cost, 0) + cost;
    const totalReward = toNum(existing?.total_reward, 0) + reward;
    const totalProfit = totalReward - totalCost;

    const hit0 = toNum(existing?.hit0, 0) + (hit === 0 ? 1 : 0);
    const hit1 = toNum(existing?.hit1, 0) + (hit === 1 ? 1 : 0);
    const hit2 = toNum(existing?.hit2, 0) + (hit === 2 ? 1 : 0);
    const hit3 = toNum(existing?.hit3, 0) + (hit === 3 ? 1 : 0);
    const hit4 = toNum(existing?.hit4, 0) + (hit >= 4 ? 1 : 0);

    const avgHit = totalRounds > 0 ? totalHits / totalRounds : 0;
    const hitRate = totalRounds > 0 ? (hit2 + hit3 + hit4) / totalRounds : 0;
    const roi = totalCost > 0 ? totalProfit / totalCost : 0;

    const recentHits = tailArray(
      [
        ...(Array.isArray(existing?.recent_hits) ? existing.recent_hits : []),
        hit
      ],
      50
    );

    const recentProfit = tailArray(
      [
        ...(Array.isArray(existing?.recent_profit) ? existing.recent_profit : []),
        profit
      ],
      50
    );

    const recent50HitRate =
      recentHits.length > 0 ? recentHits.filter((x) => Number(x) >= 2).length / recentHits.length : 0;

    const recent50Roi =
      recentProfit.length > 0
        ? recentProfit.reduce((sum, x) => sum + toNum(x, 0), 0) / Math.max(totalCost, 1)
        : 0;

    const score =
      roi * 1000 +
      avgHit * 100 +
      hitRate * 100 +
      recent50HitRate * 50 +
      recent50Roi * 100 +
      Math.min(totalRounds, 200) * 0.5;

    const payload = {
      strategy_key: key,
      total_rounds: totalRounds,
      total_hits: totalHits,
      hit0,
      hit1,
      hit2,
      hit3,
      hit4,
      avg_hit: avgHit,
      hit_rate: hitRate,
      total_cost: totalCost,
      total_reward: totalReward,
      total_profit: totalProfit,
      roi,
      recent_hits: recentHits,
      recent_profit: recentProfit,
      recent_50_hit_rate: recent50HitRate,
      recent_50_roi: recent50Roi,
      score,
      updated_at: new Date().toISOString()
    };

    const { error: upsertError } = await supabase
      .from('strategy_stats')
      .upsert(payload, { onConflict: 'strategy_key' });

    if (upsertError) throw upsertError;
  }
}
