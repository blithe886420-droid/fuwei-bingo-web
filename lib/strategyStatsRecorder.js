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

  return createClient(url, key, { auth: { persistSession: false } });
}

function safeNum(n, d = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : d;
}

export async function recordStrategyCompareResult(compareResult) {
  const supabase = getSupabase();

  for (const g of compareResult.groups || []) {
    const key = g.meta?.strategy_key;
    if (!key) continue;

    const roi = safeNum(g.roi);
    const hit = safeNum(g.total_hit_count);

    const { data: existing } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    const totalRounds = safeNum(existing?.total_rounds) + 1;

    const newAvgHit =
      (safeNum(existing?.avg_hit) * safeNum(existing?.total_rounds) + hit) /
      totalRounds;

    const newRoi =
      (safeNum(existing?.roi) * safeNum(existing?.total_rounds) + roi) /
      totalRounds;

    await supabase.from('strategy_stats').upsert({
      strategy_key: key,
      total_rounds: totalRounds,
      avg_hit: newAvgHit,
      roi: newRoi,
      updated_at: new Date().toISOString()
    });

    // 🔥 核心：調整權重
    const { data: pool } = await supabase
      .from('strategy_pool')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    let weight = safeNum(pool?.weight, 1);

    if (roi > 0) weight += 0.2;
    else if (roi < -30) weight -= 0.3;
    else weight -= 0.05;

    weight = Math.max(0.1, Math.min(5, weight));

    await supabase
      .from('strategy_pool')
      .update({
        weight,
        updated_at: new Date().toISOString()
      })
      .eq('strategy_key', key);
  }
}
