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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const TABLE = 'strategy_stats';

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

export async function recordStrategyCompareResult(compareResult) {
  const groups = safeArray(compareResult?.groups);

  if (!groups.length) {
    return { ok: false, error: 'no groups' };
  }

  const results = [];

  for (const g of groups) {
    // 🔥 核心修正：強制抓 strategy_key
    const strategyKey =
      g.key ||
      g.strategy_key ||
      g.meta?.strategy_key ||
      g.label;

    if (!strategyKey) continue;

    // 讀舊資料
    const { data: existing } = await supabase
      .from(TABLE)
      .select('*')
      .eq('strategy_key', strategyKey)
      .maybeSingle();

    const prev = existing || {};

    const totalRounds = toNum(prev.total_rounds) + 1;
    const totalHits = toNum(prev.total_hits) + toNum(g.total_hit_count);

    const totalCost = toNum(prev.total_cost) + toNum(g.total_cost);
    const totalReward = toNum(prev.total_reward) + toNum(g.total_reward);
    const totalProfit = toNum(prev.total_profit) + toNum(g.total_profit);

    const hit0 = toNum(prev.hit0) + toNum(g.hit0_count);
    const hit1 = toNum(prev.hit1) + toNum(g.hit1_count);
    const hit2 = toNum(prev.hit2) + toNum(g.hit2_count);
    const hit3 = toNum(prev.hit3) + toNum(g.hit3_count);
    const hit4 = toNum(prev.hit4) + toNum(g.hit4_count);

    const avgHit = totalRounds > 0 ? totalHits / totalRounds : 0;
    const hitRate = totalRounds > 0 ? (hit1 + hit2 + hit3 + hit4) / totalRounds * 100 : 0;
    const roi = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;

    const recentHits = [...safeArray(prev.recent_hits), g.best_single_hit].slice(-50);
    const recentProfit = [...safeArray(prev.recent_profit), g.total_profit].slice(-50);

    const payload = {
      strategy_key: strategyKey,
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
      last_result_draw: compareResult.compare_draw_no || 0,
      last_updated: new Date().toISOString()
    };

    const { error } = await supabase
      .from(TABLE)
      .upsert(payload, { onConflict: 'strategy_key' });

    if (error) {
      console.error('strategy upsert error:', error);
      continue;
    }

    results.push({
      strategy_key: strategyKey,
      total_rounds: totalRounds
    });
  }

  return {
    ok: true,
    updated: results.length,
    results
  };
}
