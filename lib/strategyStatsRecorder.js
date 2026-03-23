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

function safeArrayValue(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function shouldDisableStrategy(row) {
  const roi = toNum(row.roi);
  const avg_hit = toNum(row.avg_hit);
  const recent_50_roi = toNum(row.recent_50_roi);
  const total_rounds = toNum(row.total_rounds);

  if (roi < -0.5 && total_rounds >= 10) return true;
  if (recent_50_roi < -0.2 && avg_hit < 1 && total_rounds >= 8) return true;

  return false;
}

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult || typeof compareResult !== 'object') {
    throw new Error('compareResult missing or invalid');
  }

  const detail = Array.isArray(compareResult.detail) ? compareResult.detail : [];

  if (detail.length === 0) {
    throw new Error('compareResult.detail missing or empty');
  }

  const disabledKeys = [];

  for (const row of detail) {
    const key = String(row?.strategy_key || '').trim();
    if (!key) {
      throw new Error(`strategy_key missing: ${JSON.stringify(row)}`);
    }

    const hit = toNum(row.hit);
    const cost = toNum(row.cost);
    const reward = toNum(row.reward);
    const profit = reward - cost;

    const { data: old } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    const oldRecentHits = safeArrayValue(old?.recent_hits);
    const oldRecentProfit = safeArrayValue(old?.recent_profit);
    const oldRecentCost = safeArrayValue(old?.recent_cost);

    const total_rounds = toNum(old?.total_rounds) + 1;
    const total_hits = toNum(old?.total_hits) + hit;
    const total_cost = toNum(old?.total_cost) + cost;
    const total_reward = toNum(old?.total_reward) + reward;
    const total_profit = total_reward - total_cost;

    const avg_hit = total_rounds > 0 ? total_hits / total_rounds : 0;
    const roi = total_cost > 0 ? total_profit / total_cost : 0;

    const recent_hits = tail([...oldRecentHits, hit]);
    const recent_profit = tail([...oldRecentProfit, profit]);
    const recent_cost = tail([...oldRecentCost, cost]);

    const sumRecentProfit = recent_profit.reduce((a, b) => a + toNum(b), 0);
    const sumRecentCost = recent_cost.reduce((a, b) => a + toNum(b), 0);

    const recent_50_roi = sumRecentCost > 0 ? sumRecentProfit / sumRecentCost : 0;
    const recent_50_hit_rate =
      recent_hits.length > 0
        ? recent_hits.filter((x) => toNum(x) >= 2).length / recent_hits.length
        : 0;

    const score =
      roi * 300 +
      avg_hit * 200 +
      recent_50_roi * 400 +
      recent_50_hit_rate * 200 +
      Math.min(total_rounds, 200);

    const payload = {
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
    };

    await supabase
      .from('strategy_stats')
      .upsert(payload, { onConflict: 'strategy_key' });

    if (shouldDisableStrategy(payload)) {
      disabledKeys.push(key);
    }
  }

  if (disabledKeys.length) {
    await supabase
      .from('strategy_pool')
      .update({ status: 'disabled' })
      .in('strategy_key', disabledKeys);
  }

  return {
    ok: true,
    disabled_keys: disabledKeys
  };
}
