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
  throw new Error('Missing SUPABASE env for strategyStatsRecorder');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const COST = 25;

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function parse(compareResult) {
  const rows = [];

  for (const period of compareResult || []) {
    for (const g of period.groups || []) {
      const key =
        g?.strategy_key ||
        g?.meta?.strategy_key ||
        g?.key;

      if (!key) continue;

      const hit = toNum(g.hit_count, 0);
      const reward = hit >= 4 ? 1000 : hit === 3 ? 75 : 0;
      const cost = COST;
      const profit = reward - cost;

      rows.push({
        strategy_key: key,
        hit,
        cost,
        reward,
        profit
      });
    }
  }

  return rows;
}

function group(rows) {
  const map = new Map();

  for (const r of rows) {
    if (!map.has(r.strategy_key)) {
      map.set(r.strategy_key, {
        strategy_key: r.strategy_key,
        total_rounds: 0,
        total_hits: 0,
        hit0: 0,
        hit1: 0,
        hit2: 0,
        hit3: 0,
        hit4: 0,
        total_cost: 0,
        total_reward: 0,
        total_profit: 0
      });
    }

    const m = map.get(r.strategy_key);

    m.total_rounds += 1;
    m.total_hits += r.hit;
    m.total_cost += r.cost;
    m.total_reward += r.reward;
    m.total_profit += r.profit;

    if (r.hit === 0) m.hit0++;
    else if (r.hit === 1) m.hit1++;
    else if (r.hit === 2) m.hit2++;
    else if (r.hit === 3) m.hit3++;
    else m.hit4++;
  }

  return [...map.values()];
}

export async function recordStrategyCompareResult(compareResult) {
  try {
    const rows = parse(compareResult);
    if (!rows.length) return { ok: false };

    const grouped = group(rows);

    for (const g of grouped) {
      const { data: existing } = await supabase
        .from('strategy_stats')
        .select('*')
        .eq('strategy_key', g.strategy_key)
        .maybeSingle();

      if (!existing) {
        await supabase.from('strategy_stats').insert({
          strategy_key: g.strategy_key,
          total_rounds: g.total_rounds,
          total_hits: g.total_hits,
          hit0: g.hit0,
          hit1: g.hit1,
          hit2: g.hit2,
          hit3: g.hit3,
          hit4: g.hit4,
          total_cost: g.total_cost,
          total_reward: g.total_reward,
          total_profit: g.total_profit,
          roi: g.total_cost > 0 ? (g.total_profit / g.total_cost) * 100 : 0,
          updated_at: new Date().toISOString()
        });
      } else {
        await supabase
          .from('strategy_stats')
          .update({
            total_rounds: existing.total_rounds + g.total_rounds,
            total_hits: existing.total_hits + g.total_hits,
            hit0: existing.hit0 + g.hit0,
            hit1: existing.hit1 + g.hit1,
            hit2: existing.hit2 + g.hit2,
            hit3: existing.hit3 + g.hit3,
            hit4: existing.hit4 + g.hit4,
            total_cost: existing.total_cost + g.total_cost,
            total_reward: existing.total_reward + g.total_reward,
            total_profit: existing.total_profit + g.total_profit,
            roi:
              existing.total_cost + g.total_cost > 0
                ? ((existing.total_profit + g.total_profit) /
                    (existing.total_cost + g.total_cost)) *
                  100
                : 0,
            updated_at: new Date().toISOString()
          })
          .eq('strategy_key', g.strategy_key);
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
