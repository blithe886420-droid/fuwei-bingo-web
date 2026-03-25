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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function shouldDisableStrategy(row = {}) {
  const roi = toNum(row?.roi);
  const avgHit = toNum(row?.avg_hit);
  const recent50Roi = toNum(row?.recent_50_roi);
  const totalRounds = toNum(row?.total_rounds);

  if (roi < -0.5 && totalRounds >= 10) {
    return true;
  }

  if (recent50Roi < -0.2 && avgHit < 1 && totalRounds >= 8) {
    return true;
  }

  return false;
}

function calcStableScore({
  roi,
  avg_hit,
  recent_50_roi,
  recent_50_hit_rate,
  total_rounds
}) {
  const roiClamped = clamp(roi, -1, 1.5);
  const recentRoiClamped = clamp(recent_50_roi, -1, 1.5);
  const avgHitDelta = clamp(avg_hit - 1, -1, 2);
  const hitRateClamped = clamp(recent_50_hit_rate, 0, 1);
  const roundsClamped = Math.min(20, Math.max(0, total_rounds));

  const roiPart = roiClamped * 120;
  const avgHitPart = avgHitDelta * 90;
  const recentRoiPart = recentRoiClamped * 80;
  const recentHitRatePart = hitRateClamped * 40;
  const roundsBonus = roundsClamped * 2;

  return roiPart + avgHitPart + recentRoiPart + recentHitRatePart + roundsBonus;
}

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult || typeof compareResult !== 'object') {
    throw new Error('compareResult missing or invalid');
  }

  const detail = Array.isArray(compareResult.detail) ? compareResult.detail : [];

  if (detail.length === 0) {
    throw new Error('compareResult.detail missing or empty');
  }

  const updatedKeys = [];
  const disabledKeys = [];

  for (const row of detail) {
    const key = String(row?.strategy_key || '').trim().toLowerCase();

    if (!key) {
      throw new Error(`strategy_key missing in compareResult.detail row: ${JSON.stringify(row)}`);
    }

    const hit = toNum(row?.hit);
    const cost = toNum(row?.cost);
    const reward = toNum(row?.reward);
    const profit = reward - cost;

    const { data: old, error: oldError } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    if (oldError) {
      throw new Error(`strategy_stats select failed for ${key}: ${oldError.message || oldError}`);
    }

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

    const score = calcStableScore({
      roi,
      avg_hit,
      recent_50_roi,
      recent_50_hit_rate,
      total_rounds
    });

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

    const { error: upsertError } = await supabase
      .from('strategy_stats')
      .upsert(payload, { onConflict: 'strategy_key' });

    if (upsertError) {
      throw new Error(`strategy_stats upsert failed for ${key}: ${upsertError.message || upsertError}`);
    }

    updatedKeys.push(key);

    if (shouldDisableStrategy(payload)) {
      disabledKeys.push(key);
    }
  }

  const finalDisabledKeys = [...new Set(disabledKeys)];

  if (finalDisabledKeys.length > 0) {
    const { error: disableError } = await supabase
      .from('strategy_pool')
      .update({
        status: 'disabled',
        updated_at: new Date().toISOString()
      })
      .in('strategy_key', finalDisabledKeys);

    if (disableError) {
      throw new Error(`strategy_pool disable update failed: ${disableError.message || disableError}`);
    }
  }

  return {
    ok: true,
    updated_keys: [...new Set(updatedKeys)],
    disabled_keys: finalDisabledKeys,
    disabled_count: finalDisabledKeys.length
  };
}
