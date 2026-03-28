import { createClient } from '@supabase/supabase-js';

const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';

/**
 * 命中品質導向淘汰版：
 * 目標 = 不再只看 avg_hit / roi，
 * 而是把 hit3_rate / recent_hit3_rate 拉進主決策。
 */
const DISABLE_RULES = {
  // A：基本 ROI 淘汰
  minRoundsA: 5,
  roiFloorA: -0.5,

  // B：近期 ROI 差 + avg_hit 差
  minRoundsB: 4,
  recent50RoiFloorB: -0.2,
  avgHitFloorB: 1.0,

  // C：近期 ROI 差 + 命中率差（命中2以上）
  minRoundsC: 6,
  recent50RoiFloorC: -0.35,
  hitRateFloorC: 0.12,

  // D：成熟後還很差
  minRoundsD: 8,
  roiFloorD: -0.3,
  avgHitFloorD: 1.1,

  // E：超早期就明顯爆爛
  minRoundsE: 3,
  roiFloorE: -0.5,

  // F：連幾輪都非常弱
  minRoundsF: 3,
  avgHitFloorF: 0.8,
  recent50RoiFloorF: -0.4,

  // G：有跑一段時間，但 hit3 能力幾乎沒有
  minRoundsG: 12,
  hit3RateFloorG: 0.02,
  recent50RoiFloorG: -0.2,
  avgHitFloorG: 1.2,

  // H：成熟後仍然完全沒有 hit3 / hit4 爆發
  minRoundsH: 20,
  hit3CountFloorH: 0,
  hit4CountFloorH: 0,
  roiFloorH: -0.1,

  // I：近期 50 輪完全沒有 hit3，且表現又差
  minRoundsI: 10,
  recent50Hit3RateFloorI: 0.0001,
  recent50RoiFloorI: -0.25,
  recent50HitRateFloorI: 0.12
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

function calcRate(numerator, denominator) {
  if (toNum(denominator, 0) <= 0) return 0;
  return toNum(numerator, 0) / toNum(denominator, 0);
}

function calcRecentHitRate(recentHits = []) {
  const arr = Array.isArray(recentHits) ? recentHits : [];
  if (!arr.length) return 0;
  return arr.filter((x) => toNum(x) >= 2).length / arr.length;
}

function calcRecentHit3Rate(recentHits = []) {
  const arr = Array.isArray(recentHits) ? recentHits : [];
  if (!arr.length) return 0;
  return arr.filter((x) => toNum(x) >= 3).length / arr.length;
}

function calcRecentHit4Rate(recentHits = []) {
  const arr = Array.isArray(recentHits) ? recentHits : [];
  if (!arr.length) return 0;
  return arr.filter((x) => toNum(x) >= 4).length / arr.length;
}

function calcStableScore({
  roi,
  avg_hit,
  recent_50_roi,
  recent_50_hit_rate,
  total_rounds,
  hit2,
  hit3,
  hit4,
  hit2_rate,
  hit3_rate,
  hit4_rate,
  recent_50_hit3_rate,
  recent_50_hit4_rate
}) {
  const roiClamped = clamp(roi, -1.2, 1.8);
  const recentRoiClamped = clamp(recent_50_roi, -1.2, 1.8);
  const avgHitDelta = clamp(avg_hit - 1, -1, 2.5);
  const hitRateClamped = clamp(recent_50_hit_rate, 0, 1);
  const hit3RateClamped = clamp(hit3_rate, 0, 1);
  const hit4RateClamped = clamp(hit4_rate, 0, 1);
  const recentHit3RateClamped = clamp(recent_50_hit3_rate, 0, 1);
  const recentHit4RateClamped = clamp(recent_50_hit4_rate, 0, 1);
  const roundsClamped = Math.min(40, Math.max(0, total_rounds));

  const roiPart = roiClamped * 100;
  const avgHitPart = avgHitDelta * 70;
  const recentRoiPart = recentRoiClamped * 70;
  const recentHitRatePart = hitRateClamped * 35;
  const roundsBonus = roundsClamped * 1.8;

  /**
   * 保留 hit 次數加分，但不讓它壓過 rate。
   * 否則舊策略因為 round 多，容易天然灌分。
   */
  const hitCountBonus =
    toNum(hit2, 0) * 2 +
    toNum(hit3, 0) * 6 +
    toNum(hit4, 0) * 16;

  /**
   * 核心升級：
   * hit3_rate / recent_50_hit3_rate 直接拉高權重
   * 讓「中3能力」從加分項，升級成主力權重
   */
  const qualityRateBonus =
    clamp(hit2_rate, 0, 1) * 80 +
    hit3RateClamped * 260 +
    hit4RateClamped * 520 +
    recentHit3RateClamped * 220 +
    recentHit4RateClamped * 360;

  return round4(
    roiPart +
      avgHitPart +
      recentRoiPart +
      recentHitRatePart +
      roundsBonus +
      hitCountBonus +
      qualityRateBonus
  );
}

function shouldDisableStrategy(row = {}) {
  const roi = toNum(row?.roi);
  const avgHit = toNum(row?.avg_hit);
  const recent50Roi = toNum(row?.recent_50_roi);
  const recent50HitRate = toNum(row?.recent_50_hit_rate);
  const recent50Hit3Rate = toNum(row?.recent_50_hit3_rate);
  const totalRounds = toNum(row?.total_rounds);

  const hit3 = toNum(row?.hit3);
  const hit4 = toNum(row?.hit4);
  const hit3Rate = toNum(row?.hit3_rate);
  const hit4Rate = toNum(row?.hit4_rate);

  // A：基本 ROI 淘汰
  if (
    totalRounds >= DISABLE_RULES.minRoundsA &&
    roi < DISABLE_RULES.roiFloorA
  ) {
    return {
      shouldDisable: true,
      reason: `roi_below_${DISABLE_RULES.roiFloorA}_after_${DISABLE_RULES.minRoundsA}`
    };
  }

  // B：近期 ROI 差 + avg_hit 差
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

  // C：近期 ROI 差 + 命中率差
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

  // D：成熟後還很差
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

  // E：早期就明顯爆爛
  if (
    totalRounds >= DISABLE_RULES.minRoundsE &&
    roi < DISABLE_RULES.roiFloorE
  ) {
    return {
      shouldDisable: true,
      reason: `early_fail_roi_below_${DISABLE_RULES.roiFloorE}_after_${DISABLE_RULES.minRoundsE}`
    };
  }

  // F：連幾輪都非常弱
  if (
    totalRounds >= DISABLE_RULES.minRoundsF &&
    avgHit < DISABLE_RULES.avgHitFloorF &&
    recent50Roi < DISABLE_RULES.recent50RoiFloorF
  ) {
    return {
      shouldDisable: true,
      reason: `early_fail_avg_hit_below_${DISABLE_RULES.avgHitFloorF}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorF}`
    };
  }

  // G：跑了一段時間，但 hit3 能力幾乎沒有
  if (
    totalRounds >= DISABLE_RULES.minRoundsG &&
    hit3Rate < DISABLE_RULES.hit3RateFloorG &&
    recent50Roi < DISABLE_RULES.recent50RoiFloorG &&
    avgHit < DISABLE_RULES.avgHitFloorG
  ) {
    return {
      shouldDisable: true,
      reason: `low_hit3_rate_below_${DISABLE_RULES.hit3RateFloorG}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorG}`
    };
  }

  // H：成熟後仍然完全沒有爆發
  if (
    totalRounds >= DISABLE_RULES.minRoundsH &&
    hit3 <= DISABLE_RULES.hit3CountFloorH &&
    hit4 <= DISABLE_RULES.hit4CountFloorH &&
    roi < DISABLE_RULES.roiFloorH
  ) {
    return {
      shouldDisable: true,
      reason: `no_hit3_hit4_after_${DISABLE_RULES.minRoundsH}_and_roi_below_${DISABLE_RULES.roiFloorH}`
    };
  }

  // I：近期 50 輪完全沒有 hit3，且近期表現差
  if (
    totalRounds >= DISABLE_RULES.minRoundsI &&
    recent50Hit3Rate < DISABLE_RULES.recent50Hit3RateFloorI &&
    recent50Roi < DISABLE_RULES.recent50RoiFloorI &&
    recent50HitRate < DISABLE_RULES.recent50HitRateFloorI
  ) {
    return {
      shouldDisable: true,
      reason: `recent50_hit3_rate_below_${DISABLE_RULES.recent50Hit3RateFloorI}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorI}`
    };
  }

  /**
   * 額外保護：
   * hit4_rate 有料的策略，不要太早砍
   * 有些策略本來就是高波動、衝上限型
   */
  if (hit4Rate >= 0.01 || recent50Hit3Rate >= 0.08) {
    return {
      shouldDisable: false,
      reason: ''
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
    const recent_50_hit_rate = calcRecentHitRate(recent_hits);
    const recent_50_hit3_rate = calcRecentHit3Rate(recent_hits);
    const recent_50_hit4_rate = calcRecentHit4Rate(recent_hits);

    const hit2_rate = calcRate(hit2, total_rounds);
    const hit3_rate = calcRate(hit3, total_rounds);
    const hit4_rate = calcRate(hit4, total_rounds);

    const score = calcStableScore({
      roi,
      avg_hit,
      recent_50_roi,
      recent_50_hit_rate,
      total_rounds,
      hit2,
      hit3,
      hit4,
      hit2_rate,
      hit3_rate,
      hit4_rate,
      recent_50_hit3_rate,
      recent_50_hit4_rate
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
      recent_50_hit3_rate: round4(recent_50_hit3_rate),
      recent_50_hit4_rate: round4(recent_50_hit4_rate),
      hit2,
      hit3,
      hit4,
      hit2_rate: round4(hit2_rate),
      hit3_rate: round4(hit3_rate),
      hit4_rate: round4(hit4_rate),
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
