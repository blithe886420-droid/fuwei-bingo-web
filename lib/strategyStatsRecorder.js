import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult?.groups?.length) return { ok: false };

  const results = [];

  for (const g of compareResult.groups) {
    const key =
      g?.meta?.strategy_key ||
      g?.strategy_key ||
      g?.key;

    if (!key) continue;

    const hit = toNum(g.total_hit_count ?? g.hit_count, 0);
    const rounds = toNum(g.rounds?.length, 1);
    const profit = toNum(g.total_profit ?? g.profit, 0);

    const { data: existing } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    if (!existing) {
      const { data, error } = await supabase
        .from('strategy_stats')
        .insert({
          strategy_key: key,
          total_rounds: rounds,
          total_hits: hit,
          hit0: hit === 0 ? rounds : 0,
          hit1: hit === 1 ? rounds : 0,
          hit2: hit === 2 ? rounds : 0,
          hit3: hit === 3 ? rounds : 0,
          hit4: hit >= 4 ? rounds : 0,
          avg_hit: rounds > 0 ? hit / rounds : 0,
          hit_rate: rounds > 0 ? hit / (rounds * 4) : 0,
          total_profit: profit
        });

      results.push({ key, action: 'insert', error });
      continue;
    }

    const totalRounds = toNum(existing.total_rounds) + rounds;
    const totalHits = toNum(existing.total_hits) + hit;

    const { error } = await supabase
      .from('strategy_stats')
      .update({
        total_rounds: totalRounds,
        total_hits: totalHits,
        hit0: toNum(existing.hit0) + (hit === 0 ? rounds : 0),
        hit1: toNum(existing.hit1) + (hit === 1 ? rounds : 0),
        hit2: toNum(existing.hit2) + (hit === 2 ? rounds : 0),
        hit3: toNum(existing.hit3) + (hit === 3 ? rounds : 0),
        hit4: toNum(existing.hit4) + (hit >= 4 ? rounds : 0),
        avg_hit: totalRounds > 0 ? totalHits / totalRounds : 0,
        hit_rate: totalRounds > 0 ? totalHits / (totalRounds * 4) : 0,
        total_profit: toNum(existing.total_profit) + profit
      })
      .eq('strategy_key', key);

    results.push({ key, action: 'update', error });
  }

  return {
    ok: true,
    results
  };
}
