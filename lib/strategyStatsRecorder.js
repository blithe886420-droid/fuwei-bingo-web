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
  if (!compareResult?.groups?.length) return;

  for (const g of compareResult.groups) {
    const key =
      g?.meta?.strategy_key ||
      g?.strategy_key ||
      g?.key;

    if (!key) continue;

    const hit = toNum(g.hit_count, 0);

    const { data: existing } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    if (!existing) {
      await supabase
        .from('strategy_stats')
        .insert({
          strategy_key: key,
          total_rounds: 1,
          total_hits: hit,
          hit0: hit === 0 ? 1 : 0,
          hit1: hit === 1 ? 1 : 0,
          hit2: hit === 2 ? 1 : 0,
          hit3: hit === 3 ? 1 : 0,
          hit4: hit >= 4 ? 1 : 0,
          avg_hit: hit,
          hit_rate: hit > 0 ? 1 : 0,
          total_profit: toNum(g.profit, 0)
        });
      continue;
    }

    const totalRounds = toNum(existing.total_rounds) + 1;
    const totalHits = toNum(existing.total_hits) + hit;

    await supabase
      .from('strategy_stats')
      .update({
        total_rounds: totalRounds,
        total_hits: totalHits,
        hit0: toNum(existing.hit0) + (hit === 0 ? 1 : 0),
        hit1: toNum(existing.hit1) + (hit === 1 ? 1 : 0),
        hit2: toNum(existing.hit2) + (hit === 2 ? 1 : 0),
        hit3: toNum(existing.hit3) + (hit === 3 ? 1 : 0),
        hit4: toNum(existing.hit4) + (hit >= 4 ? 1 : 0),
        avg_hit: totalHits / totalRounds,
        hit_rate: totalHits / (totalRounds * 4),
        total_profit: toNum(existing.total_profit) + toNum(g.profit, 0)
      })
      .eq('strategy_key', key);
  }
}
