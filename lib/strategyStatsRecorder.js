import { createClient } from '@supabase/supabase-js';

const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';

const DISABLE_RULES = {
  minRoundsA: 10,
  roiFloorA: -0.5,

  minRoundsB: 8,
  recent50RoiFloorB: -0.2,
  avgHitFloorB: 1.0,

  minRoundsC: 15,
  recent50RoiFloorC: -0.35,
  hitRateFloorC: 0.12,

  minRoundsD: 20,
  roiFloorD: -0.3,
  avgHitFloorD: 1.1
};

const PROTECTED_STATUS = new Set(['protected']);
const TERMINAL_STATUS = new Set(['disabled', 'retired']);

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE env');
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

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

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function calcStableScore({
  roi,
  avg_hit,
  recent_50_roi,
  recent_50_hit_rate,
  total_rounds,
  hit2,
  hit3,
  hit4
}) {
  const roiClamped = clamp(roi, -1.2, 1.8);
  const recentRoiClamped = clamp(recent_50_roi, -1.2, 1.8);
  const avgHitDelta = clamp(avg_hit - 1, -1, 2.5);
  const hitRateClamped = clamp(recent_50_hit_rate, 0, 1);
  const roundsClamped = Math.min(40, Math.max(0, total_rounds));

  const roiPart = roiClamped * 120;
  const avgHitPart = avgHitDelta * 90;
  const recentRoiPart = recentRoiClamped * 85;
  const recentHitRatePart = hitRateClamped * 55;
  const roundsBonus = roundsClamped * 2.2;

  const hitBonus =
    toNum(hit2, 0) * 4 +
    toNum(hit3, 0) * 12 +
    toNum(hit4, 0) * 30;

  return round4(
    roiPart +
      avgHitPart +
      recentRoiPart +
      recentHitRatePart +
      roundsBonus +
      hitBonus
  );
}

function shouldDisableStrategy(row = {}) {
  const roi = toNum(row?.roi);
  const avgHit = toNum(row?.avg_hit);
  const recent50Roi = toNum(row?.recent_50_roi);
  const recent50HitRate = toNum(row?.recent_50_hit_rate);
  const totalRounds = toNum(row?.total_rounds);

  if (
    totalRounds >= DISABLE_RULES.minRoundsA &&
    roi < DISABLE_RULES.roiFloorA
  ) {
    return {
      shouldDisable: true,
      reason: `roi_below_${DISABLE_RULES.roiFloorA}_after_${DISABLE_RULES.minRoundsA}`
    };
  }

  if (
    totalRounds >= DISABLE_RULES.minRoundsB &&
    recent50Roi < DISABLE_RULES.recent50RoiFloorB &&
    avgHit < DISABLE_RULES.avgHitFloorB
  ) {
    return {
      shouldDisable: true,
      reason: `recent50_roi_below_${DISABLE_RULES.recent50RoiFloorB}_and_avg_hit_below_${DISABLE_RULES.avgHitFloorB}`
    };
  }

  if (
    totalRounds >= DISABLE_RULES.minRoundsC &&
    recent50Roi < DISABLE_RULES.recent50RoiFloorC &&
    recent50HitRate < DISABLE_RULES.hitRateFloorC
  ) {
    return {
      shouldDisable: true,
      reason: `recent50_roi_below_${DISABLE_RULES.recent50RoiFloorC}_and_hit_rate_below_${DISABLE_RULES.hitRateFloorC}`
    };
  }

  if (
    totalRounds >= DISABLE_RULES.minRoundsD &&
    roi < DISABLE_RULES.roiFloorD &&
    avgHit < DISABLE_RULES.avgHitFloorD
  ) {
    return {
      shouldDisable: true,
      reason: `roi_below_${DISABLE_RULES.roiFloorD}_and_avg_hit_below_${DISABLE_RULES.avgHitFloorD}`
    };
  }

  return {
    shouldDisable: false,
    reason: ''
  };
}

async function getPoolStatusMap(supabase, strategyKeys = []) {
  const safeKeys = [...new Set((Array.isArray(strategyKeys) ? strategyKeys : []).filter(Boolean))];
  if (!safeKeys.length) return new Map();

  const { data, error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('strategy_key, status, protected_rank')
    .in('strategy_key', safeKeys);

  if (error) {
    throw new Error(`strategy_pool select failed: ${error.message || error}`);
  }

  return new Map(
    (data || []).map((row) => [
      String(row?.strategy_key || '').trim(),
      {
        status: String(row?.status || '').trim().toLowerCase(),
        protected_rank: Boolean(row?.protected_rank)
      }
    ])
  );
}

async function disableStrategies(supabase, strategyKeys = [], reasonMap = {}) {
  const finalKeys = [...new Set((Array.isArray(strategyKeys) ? strategyKeys : []).filter(Boolean))];
  if (!finalKeys.length) {
    return {
      updated: 0,
      disabled_keys: []
    };
  }

  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .update({
      status: 'disabled',
      updated_at: nowIso
    })
    .in('strategy_key', finalKeys);

  if (error) {
    throw new Error(`strategy_pool disable update failed: ${error.message || error}`);
  }

  return {
    updated: finalKeys.length,
    disabled_keys: finalKeys,
    disabled_reason_map: reasonMap
  };
}

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult || typeof compareResult !== 'object') {
    throw new Error('compareResult missing or invalid');
  }

  const supabase = getSupabase();

  const detail = Array.isArray(compareResult.detail) ? compareResult.detail : [];
  if (detail.length === 0) {
    throw new Error('compareResult.detail missing or empty');
  }

  const uniqueKeys = [...new Set(
    detail
      .map((row) => String(row?.strategy_key || '').trim())
      .filter(Boolean)
  )];

  const poolStatusMap = await getPoolStatusMap(supabase, uniqueKeys);

  const updatedKeys = [];
  const disabledKeys = [];
  const disabledReasonMap = {};

  for (const row of detail) {
    const key = String(row?.strategy_key || '').trim();

    if (!key) {
      throw new Error(
        `strategy_key missing in compareResult.detail row: ${JSON.stringify(row)}`
      );
    }

    const poolInfo = poolStatusMap.get(key) || {
      status: '',
      protected_rank: false
    };

    const currentStatus = String(poolInfo.status || '').trim().toLowerCase();

    // 已淘汰 / 已退休的策略不再累積，避免幽靈復活
    if (TERMINAL_STATUS.has(currentStatus)) {
      continue;
    }

    const hit = toNum(row?.hit);
    const cost = toNum(row?.cost);
    const reward = toNum(row?.reward);
    const profit = reward - cost;

    const hit2Add = hit >= 2 ? 1 : 0;
    const hit3Add = hit >= 3 ? 1 : 0;
    const hit4Add = hit >= 4 ? 1 : 0;

    const { data: old, error: oldError } = await supabase
      .from(STRATEGY_STATS_TABLE)
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    if (oldError) {
      throw new Error(
        `strategy_stats select failed for ${key}: ${oldError.message || oldError}`
      );
    }

    const oldRecentHits = safeArrayValue(old?.recent_hits);
    const oldRecentProfit = safeArrayValue(old?.recent_profit);
    const oldRecentCost = safeArrayValue(old?.recent_cost);

    const total_rounds = toNum(old?.total_rounds) + 1;
    const total_hits = toNum(old?.total_hits) + hit;
    const total_cost = toNum(old?.total_cost) + cost;
    const total_reward = toNum(old?.total_reward) + reward;
    const total_profit = total_reward - total_cost;

    const hit2 = toNum(old?.hit2) + hit2Add;
    const hit3 = toNum(old?.hit3) + hit3Add;
    const hit4 = toNum(old?.hit4) + hit4Add;

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
      total_rounds,
      hit2,
      hit3,
      hit4
    });

    const payload = {
      strategy_key: key,
      total_rounds,
      total_hits,
      total_cost,
      total_reward,
      total_profit,
      avg_hit: round4(avg_hit),
      roi: round4(roi),
      recent_hits,
      recent_profit,
      recent_cost,
      recent_50_roi: round4(recent_50_roi),
      recent_50_hit_rate: round4(recent_50_hit_rate),
      hit2,
      hit3,
      hit4,
      score,
      updated_at: new Date().toISOString()
    };

    const { error: upsertError } = await supabase
      .from(STRATEGY_STATS_TABLE)
      .upsert(payload, { onConflict: 'strategy_key' });

    if (upsertError) {
      throw new Error(
        `strategy_stats upsert failed for ${key}: ${upsertError.message || upsertError}`
      );
    }

    updatedKeys.push(key);

    // protected 策略不淘汰
    if (poolInfo.protected_rank || PROTECTED_STATUS.has(currentStatus)) {
      continue;
    }

    const disableCheck = shouldDisableStrategy(payload);

    if (disableCheck.shouldDisable) {
      disabledKeys.push(key);
      disabledReasonMap[key] = disableCheck.reason;
    }
  }

  const finalDisabledKeys = [...new Set(disabledKeys)];
  let disableResult = {
    updated: 0,
    disabled_keys: [],
    disabled_reason_map: {}
  };

  if (finalDisabledKeys.length > 0) {
    disableResult = await disableStrategies(
      supabase,
      finalDisabledKeys,
      disabledReasonMap
    );
  }

  return {
    ok: true,
    updated_keys: [...new Set(updatedKeys)],
    disabled_keys: disableResult.disabled_keys || [],
    disabled_reason_map: disableResult.disabled_reason_map || {},
    disabled_count: toNum(disableResult.updated, 0)
  };
}
