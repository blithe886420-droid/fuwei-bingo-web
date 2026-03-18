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

export async function recordStrategyCompareResult(compareResult) {
  const supabase = getSupabase();

  for (const g of compareResult.groups || []) {
    const strategyKey = g.meta?.strategy_key;
    if (!strategyKey) continue;

    const roi = safeNum(g.roi);
    const hit = safeNum(g.total_hit_count);

    const { data: old } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', strategyKey)
      .maybeSingle();

    const totalRounds = safeNum(old?.total_rounds) + 1;

    const newAvgHit =
      (safeNum(old?.avg_hit) * safeNum(old?.total_rounds) + hit) /
      totalRounds;

    const newRoi =
      (safeNum(old?.roi) * safeNum(old?.total_rounds) + roi) /
      totalRounds;

    await supabase.from('strategy_stats').upsert({
      strategy_key: strategyKey,
      total_rounds: totalRounds,
      avg_hit: newAvgHit,
      roi: newRoi,
      updated_at: new Date().toISOString()
    });
  }
}
