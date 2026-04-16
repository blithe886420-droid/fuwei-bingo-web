import { createClient } from '@supabase/supabase-js';

const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';

/**
 * 命中品質導向淘汰版（第四刀：直接開殺）
 * 目標：
 * 1. 讓不會中3的策略更快出局
 * 2. 讓只會保2、但拉不起中3的策略提早被清掉
 * 3. 保留真正有 hit4 / 近期 hit3 爆發能力的策略
 *
 * D版補強：
 * 4. 增加盤型記憶層（phase_stats_json）
 * 5. 每次 compare 後，同步記錄該策略在 continuation / rotation / bias / chaos 下的表現
 * 6. v2：phase 無法辨識時，不丟棄，改歸 continuation 避免統計斷流
 */
const DISABLE_RULES = {
  minRoundsA: 5,
  roiFloorA: -0.5,
  minRoundsB: 4,
  recent50RoiFloorB: -0.2,
  avgHitFloorB: 1.0,
  minRoundsC: 6,
  recent50RoiFloorC: -0.35,
  hitRateFloorC: 0.12,
  minRoundsD: 8,
  roiFloorD: -0.3,
  avgHitFloorD: 1.1,
  minRoundsE: 3,
  roiFloorE: -0.5,
  minRoundsF: 3,
  avgHitFloorF: 0.8,
  recent50RoiFloorF: -0.4,
  minRoundsG: 6,
  hit3RateFloorG: 0.08,
  recent50RoiFloorG: -0.05,
  avgHitFloorG: 1.2,
  minRoundsH: 10,
  hit3CountFloorH: 0,
  hit4CountFloorH: 0,
  roiFloorH: -0.02,
  minRoundsI: 5,
  recent50Hit3RateFloorI: 0.03,
  recent50RoiFloorI: -0.05,
  recent50HitRateFloorI: 0.16,
  minRoundsJ: 8,
  hit2RateCeilJ: 0.28,
  hit3RateFloorJ: 0.05,
  recent50RoiFloorJ: -0.03,
  minRoundsK: 8,
  recent50HitRateFloorK: 0.18,
  recent50Hit3RateFloorK: 0.01,
  roiFloorK: -0.03,
  minRoundsL: 5,
  hit3CountFloorL: 0,
  recent50RoiFloorL: -0.01,
  minRoundsM: 8,
  recent50Hit3RateFloorM: 0,
  hit4CountFloorM: 0,
  avgHitFloorM: 1.25
};

const PROTECTED_STATUS = new Set(['protected']);
const TERMINAL_STATUS = new Set(['disabled', 'retired']);
const VALID_PHASES = ['continuation', 'rotation', 'bias', 'chaos'];
const PHASE_RECENT_WINDOW = 20;

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

function safeObjectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
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

function calcShortWindowStats(recentHits = [], windowSize = 10) {
  const arr = tail(Array.isArray(recentHits) ? recentHits : [], windowSize);
  if (!arr.length) {
    return {
      avg_hit: 0,
      hit2_rate: 0,
      hit3_rate: 0,
      hit4_rate: 0,
      zero_one_rate: 1,
      strong_round_rate: 0
    };
  }

  const total = arr.length;
  const sumHits = arr.reduce((acc, value) => acc + toNum(value, 0), 0);
  const hit2Rate = arr.filter((x) => toNum(x) >= 2).length / total;
  const hit3Rate = arr.filter((x) => toNum(x) >= 3).length / total;
  const hit4Rate = arr.filter((x) => toNum(x) >= 4).length / total;
  const zeroOneRate = arr.filter((x) => toNum(x) <= 1).length / total;
  const strongRoundRate = arr.filter((x) => toNum(x) >= 2).length / total;

  return {
    avg_hit: sumHits / total,
    hit2_rate: hit2Rate,
    hit3_rate: hit3Rate,
    hit4_rate: hit4Rate,
    zero_one_rate: zeroOneRate,
    strong_round_rate: strongRoundRate
  };
}

function normalizeMarketPhase(rawPhase = '') {
  const phase = String(rawPhase || '').trim().toLowerCase();
  return VALID_PHASES.includes(phase) ? phase : 'unknown';
}

function normalizePhaseBucket(value) {
  const source = safeObjectValue(value);
  const recentHits = tail(safeArrayValue(source.recent_hits), PHASE_RECENT_WINDOW);
  const recentProfit = tail(safeArrayValue(source.recent_profit), PHASE_RECENT_WINDOW);
  const recentCost = tail(safeArrayValue(source.recent_cost), PHASE_RECENT_WINDOW);

  const rounds = toNum(source.rounds, 0);
  const totalHits = toNum(source.total_hits, 0);
  const totalCost = toNum(source.total_cost, 0);
  const totalReward = toNum(source.total_reward, 0);
  const totalProfit = toNum(source.total_profit, totalReward - totalCost);

  const hit0 = toNum(source.hit0, 0);
  const hit1 = toNum(source.hit1, 0);
  const hit2 = toNum(source.hit2, 0);
  const hit3 = toNum(source.hit3, 0);
  const hit4 = toNum(source.hit4, 0);

  const sumRecentProfit = recentProfit.reduce((a, b) => a + toNum(b, 0), 0);
  const sumRecentCost = recentCost.reduce((a, b) => a + toNum(b, 0), 0);

  return {
    rounds,
    total_hits: totalHits,
    total_cost: totalCost,
    total_reward: totalReward,
    total_profit: totalProfit,
    hit0,
    hit1,
    hit2,
    hit3,
    hit4,
    avg_hit: round4(rounds > 0 ? totalHits / rounds : 0),
    roi: round4(totalCost > 0 ? totalProfit / totalCost : 0),
    hit2_rate: round4(calcRate(hit2, rounds)),
    hit3_rate: round4(calcRate(hit3, rounds)),
    hit4_rate: round4(calcRate(hit4, rounds)),
    recent_hits: recentHits,
    recent_profit: recentProfit,
    recent_cost: recentCost,
    recent_20_hit_rate: round4(calcRecentHitRate(recentHits)),
    recent_20_hit3_rate: round4(calcRecentHit3Rate(recentHits)),
    recent_20_hit4_rate: round4(calcRecentHit4Rate(recentHits)),
    recent_20_roi: round4(sumRecentCost > 0 ? sumRecentProfit / sumRecentCost : 0)
  };
}

function normalizePhaseStatsJson(value) {
  const source = safeObjectValue(value);
  const result = {};
  for (const phase of VALID_PHASES) {
    result[phase] = normalizePhaseBucket(source[phase]);
  }
  return result;
}

function updatePhaseStatsJson(oldValue, marketPhase, hit, cost, reward, profit) {
  const phase = normalizeMarketPhase(marketPhase);
  const phaseStats = normalizePhaseStatsJson(oldValue);

  let finalPhase = phase;
  if (!VALID_PHASES.includes(finalPhase)) {
    finalPhase = 'continuation';
  }

  const bucket = normalizePhaseBucket(phaseStats[finalPhase] || {});
  bucket.rounds += 1;
  bucket.total_hits += toNum(hit, 0);
  bucket.total_cost += toNum(cost, 0);
  bucket.total_reward += toNum(reward, 0);
  bucket.total_profit = bucket.total_reward - bucket.total_cost;

  const safeHit = toNum(hit, 0);
  if (safeHit <= 0) bucket.hit0 += 1;
  if (safeHit === 1) bucket.hit1 += 1;
  if (safeHit >= 2) bucket.hit2 += 1;
  if (safeHit >= 3) bucket.hit3 += 1;
  if (safeHit >= 4) bucket.hit4 += 1;

  bucket.recent_hits = tail([...(bucket.recent_hits || []), safeHit], PHASE_RECENT_WINDOW);
  bucket.recent_profit = tail([...(bucket.recent_profit || []), toNum(profit, 0)], PHASE_RECENT_WINDOW);
  bucket.recent_cost = tail([...(bucket.recent_cost || []), toNum(cost, 0)], PHASE_RECENT_WINDOW);

  phaseStats[finalPhase] = normalizePhaseBucket(bucket);
  return phaseStats;
}

function calcPhaseBestJson(phaseStatsJson = {}) {
  const phaseStats = normalizePhaseStatsJson(phaseStatsJson);
  const phaseScores = {};

  for (const phase of VALID_PHASES) {
    const bucket = phaseStats[phase];
    const rounds = toNum(bucket.rounds, 0);
    const score =
      bucket.avg_hit * 120 +
      bucket.hit2_rate * 220 +
      bucket.hit3_rate * 420 +
      bucket.hit4_rate * 700 +
      bucket.recent_20_hit_rate * 180 +
      bucket.recent_20_hit3_rate * 320 +
      bucket.recent_20_hit4_rate * 520 +
      bucket.recent_20_roi * 80 +
      Math.min(rounds, 20) * 3;

    phaseScores[phase] = round4(score);
  }

  const bestEntry = Object.entries(phaseScores).sort((a, b) => toNum(b[1], 0) - toNum(a[1], 0))[0] || ['unknown', 0];

  return {
    best_phase: bestEntry[0],
    best_score: round4(bestEntry[1]),
    phase_scores: phaseScores
  };
}

function getMarketPhaseFromCompareResult(compareResult = {}) {
  const phaseFromContext = String(compareResult?.phase_context?.market_phase || '').trim().toLowerCase();
  if (VALID_PHASES.includes(phaseFromContext)) return phaseFromContext;

  const directPhase = String(compareResult?.market_phase || '').trim().toLowerCase();
  if (VALID_PHASES.includes(directPhase)) return directPhase;

  return 'unknown';
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
  recent_50_hit4_rate,
  recent_hits = []
}) {
  const roiClamped = clamp(roi, -1.2, 1.2);
  const recentRoiClamped = clamp(recent_50_roi, -1.2, 1.2);
  const avgHitDelta = clamp(avg_hit - 1, -1, 2.5);
  const hitRateClamped = clamp(recent_50_hit_rate, 0, 1);
  const hit2RateClamped = clamp(hit2_rate, 0, 1);
  const hit3RateClamped = clamp(hit3_rate, 0, 1);
  const hit4RateClamped = clamp(hit4_rate, 0, 1);
  const recentHit3RateClamped = clamp(recent_50_hit3_rate, 0, 1);
  const recentHit4RateClamped = clamp(recent_50_hit4_rate, 0, 1);
  const roundsClamped = Math.min(40, Math.max(0, total_rounds));

  const recent10 = calcShortWindowStats(recent_hits, 10);
  const recent20 = calcShortWindowStats(recent_hits, 20);

  const recent10Avg = clamp(recent10.avg_hit, 0, 4);
  const recent20Avg = clamp(recent20.avg_hit, 0, 4);
  const recent10Hit2 = clamp(recent10.hit2_rate, 0, 1);
  const recent20Hit2 = clamp(recent20.hit2_rate, 0, 1);
  const recent10Hit3 = clamp(recent10.hit3_rate, 0, 1);
  const recent20Hit3 = clamp(recent20.hit3_rate, 0, 1);
  const recent10Hit4 = clamp(recent10.hit4_rate, 0, 1);
  const recent20Hit4 = clamp(recent20.hit4_rate, 0, 1);
  const recent10ZeroOne = clamp(recent10.zero_one_rate, 0, 1);
  const recent20ZeroOne = clamp(recent20.zero_one_rate, 0, 1);

  const roiPart = roiClamped * 10;
  const recentRoiPart = recentRoiClamped * 8;
  const avgHitPart = avgHitDelta * 70;
  const roundsBonus = roundsClamped * 0.8;

  const lifetimeQualityPart =
    hit2RateClamped * 25 +
    hit3RateClamped * 180 +
    hit4RateClamped * 320 +
    recentHit3RateClamped * 140 +
    recentHit4RateClamped * 240 +
    hitRateClamped * 20;

  const recentTruthPart =
    recent10Avg * 140 +
    recent20Avg * 110 +
    recent10Hit2 * 260 +
    recent20Hit2 * 180 +
    recent10Hit3 * 560 +
    recent20Hit3 * 420 +
    recent10Hit4 * 720 +
    recent20Hit4 * 520;

  const countPart = toNum(hit2, 0) * 0.8 + toNum(hit3, 0) * 9 + toNum(hit4, 0) * 28;

  let honestyAdjustment = 0;
  if (recent10Hit2 >= 0.3) honestyAdjustment += 70;
  if (recent10Hit2 >= 0.5) honestyAdjustment += 55;
  if (recent20Hit2 >= 0.35) honestyAdjustment += 45;
  if (recent10Hit3 >= 0.08) honestyAdjustment += 120;
  if (recent10Hit3 >= 0.15) honestyAdjustment += 90;
  if (recent20Hit3 >= 0.08) honestyAdjustment += 80;
  if (recent10Hit4 > 0) honestyAdjustment += 140;
  if (recent10ZeroOne >= 0.8) honestyAdjustment -= 220;
  if (recent20ZeroOne >= 0.75) honestyAdjustment -= 180;
  if (recent10Hit2 <= 0.1) honestyAdjustment -= 120;
  if (recent20Hit2 <= 0.15) honestyAdjustment -= 90;
  if (recent10Hit3 <= 0.01) honestyAdjustment -= 80;
  if (recent20Hit3 <= 0.01) honestyAdjustment -= 60;
  if (recentRoiClamped < -0.6 && recent20Hit2 < 0.2 && recent20Hit3 <= 0.01) {
    honestyAdjustment -= 140;
  }

  return round4(
    roiPart +
      recentRoiPart +
      avgHitPart +
      roundsBonus +
      lifetimeQualityPart +
      recentTruthPart +
      countPart +
      honestyAdjustment
  );
}

function shouldDisableStrategy(row = {}) {
  const roi = toNum(row?.roi);
  const avgHit = toNum(row?.avg_hit);
  const recent50Roi = toNum(row?.recent_50_roi);
  const recent50HitRate = toNum(row?.recent_50_hit_rate);
  const recent50Hit3Rate = toNum(row?.recent_50_hit3_rate);
  const totalRounds = toNum(row?.total_rounds);
  const hit2 = toNum(row?.hit2);
  const hit3 = toNum(row?.hit3);
  const hit4 = toNum(row?.hit4);
  const hit2Rate = toNum(row?.hit2_rate);
  const hit3Rate = toNum(row?.hit3_rate);
  const hit4Rate = toNum(row?.hit4_rate);
  const recentHits = safeArrayValue(row?.recent_hits);
  const recent10 = calcShortWindowStats(recentHits, 10);
  const recent20 = calcShortWindowStats(recentHits, 20);

  if (hit4Rate >= 0.01 || recent50Hit3Rate >= 0.08 || hit3Rate >= 0.10 || avgHit >= 1.45 || recent10.hit3_rate >= 0.10 || recent20.hit3_rate >= 0.08) {
    return { shouldDisable: false, reason: '' };
  }
  if (totalRounds >= 8 && recent10.hit2_rate <= 0.1 && recent20.hit2_rate <= 0.15 && recent20.hit3_rate <= 0.01) {
    return { shouldDisable: true, reason: 'recent_low_hit2_and_no_hit3' };
  }
  if (totalRounds >= DISABLE_RULES.minRoundsA && roi < DISABLE_RULES.roiFloorA) return { shouldDisable: true, reason: `roi_below_${DISABLE_RULES.roiFloorA}_after_${DISABLE_RULES.minRoundsA}` };
  if (totalRounds >= DISABLE_RULES.minRoundsB && recent50Roi < DISABLE_RULES.recent50RoiFloorB && avgHit < DISABLE_RULES.avgHitFloorB) return { shouldDisable: true, reason: `recent50_roi_below_${DISABLE_RULES.recent50RoiFloorB}_and_avg_hit_below_${DISABLE_RULES.avgHitFloorB}` };
  if (totalRounds >= DISABLE_RULES.minRoundsC && recent50Roi < DISABLE_RULES.recent50RoiFloorC && recent50HitRate < DISABLE_RULES.hitRateFloorC) return { shouldDisable: true, reason: `recent50_roi_below_${DISABLE_RULES.recent50RoiFloorC}_and_hit_rate_below_${DISABLE_RULES.hitRateFloorC}` };
  if (totalRounds >= DISABLE_RULES.minRoundsD && roi < DISABLE_RULES.roiFloorD && avgHit < DISABLE_RULES.avgHitFloorD) return { shouldDisable: true, reason: `roi_below_${DISABLE_RULES.roiFloorD}_and_avg_hit_below_${DISABLE_RULES.avgHitFloorD}` };
  if (totalRounds >= DISABLE_RULES.minRoundsE && roi < DISABLE_RULES.roiFloorE) return { shouldDisable: true, reason: `early_fail_roi_below_${DISABLE_RULES.roiFloorE}_after_${DISABLE_RULES.minRoundsE}` };
  if (totalRounds >= DISABLE_RULES.minRoundsF && avgHit < DISABLE_RULES.avgHitFloorF && recent50Roi < DISABLE_RULES.recent50RoiFloorF) return { shouldDisable: true, reason: `early_fail_avg_hit_below_${DISABLE_RULES.avgHitFloorF}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorF}` };
  if (totalRounds >= DISABLE_RULES.minRoundsG && hit3Rate < DISABLE_RULES.hit3RateFloorG && recent50Roi < DISABLE_RULES.recent50RoiFloorG && avgHit < DISABLE_RULES.avgHitFloorG) return { shouldDisable: true, reason: `low_hit3_rate_below_${DISABLE_RULES.hit3RateFloorG}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorG}` };
  if (totalRounds >= DISABLE_RULES.minRoundsH && hit3 <= DISABLE_RULES.hit3CountFloorH && hit4 <= DISABLE_RULES.hit4CountFloorH && roi < DISABLE_RULES.roiFloorH) return { shouldDisable: true, reason: `no_hit3_hit4_after_${DISABLE_RULES.minRoundsH}_and_roi_below_${DISABLE_RULES.roiFloorH}` };
  if (totalRounds >= DISABLE_RULES.minRoundsI && recent50Hit3Rate < DISABLE_RULES.recent50Hit3RateFloorI && recent50Roi < DISABLE_RULES.recent50RoiFloorI && recent50HitRate < DISABLE_RULES.recent50HitRateFloorI) return { shouldDisable: true, reason: `recent50_hit3_rate_below_${DISABLE_RULES.recent50Hit3RateFloorI}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorI}` };
  if (totalRounds >= DISABLE_RULES.minRoundsJ && hit2Rate >= DISABLE_RULES.hit2RateCeilJ && hit3Rate < DISABLE_RULES.hit3RateFloorJ && recent50Roi < DISABLE_RULES.recent50RoiFloorJ) return { shouldDisable: true, reason: `high_hit2_rate_but_low_hit3_rate_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorJ}` };
  if (totalRounds >= DISABLE_RULES.minRoundsK && recent50HitRate >= DISABLE_RULES.recent50HitRateFloorK && recent50Hit3Rate < DISABLE_RULES.recent50Hit3RateFloorK && roi < DISABLE_RULES.roiFloorK) return { shouldDisable: true, reason: `recent50_hit_rate_ok_but_recent50_hit3_rate_too_low_and_roi_below_${DISABLE_RULES.roiFloorK}` };
  if (totalRounds >= DISABLE_RULES.minRoundsL && hit3 <= DISABLE_RULES.hit3CountFloorL && recent50Roi < DISABLE_RULES.recent50RoiFloorL) return { shouldDisable: true, reason: `hit3_still_zero_after_${DISABLE_RULES.minRoundsL}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorL}` };
  if (totalRounds >= DISABLE_RULES.minRoundsM && recent50Hit3Rate <= DISABLE_RULES.recent50Hit3RateFloorM && hit4 <= DISABLE_RULES.hit4CountFloorM && avgHit < DISABLE_RULES.avgHitFloorM) return { shouldDisable: true, reason: `no_recent_hit3_no_hit4_and_avg_hit_below_${DISABLE_RULES.avgHitFloorM}` };
  return { shouldDisable: false, reason: '' };
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
    return { updated: 0, disabled_keys: [] };
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .update({ status: 'disabled', updated_at: nowIso })
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

  const marketPhase = getMarketPhaseFromCompareResult(compareResult);
  const uniqueKeys = [...new Set(detail.map((row) => String(row?.strategy_key || '').trim()).filter(Boolean))];
  const poolStatusMap = await getPoolStatusMap(supabase, uniqueKeys);

  const updatedKeys = [];
  const disabledKeys = [];
  const disabledReasonMap = {};

  for (const row of detail) {
    const key = String(row?.strategy_key || '').trim();
    if (!key) {
      throw new Error(`strategy_key missing in compareResult.detail row: ${JSON.stringify(row)}`);
    }

    const poolInfo = poolStatusMap.get(key) || { status: '', protected_rank: false };
    const currentStatus = String(poolInfo.status || '').trim().toLowerCase();
    if (TERMINAL_STATUS.has(currentStatus)) continue;

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
      recent_50_hit4_rate,
      recent_hits
    });

    const phase_stats_json = updatePhaseStatsJson(old?.phase_stats_json, marketPhase, hit, cost, reward, profit);
    const phase_best_json = calcPhaseBestJson(phase_stats_json);

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
      phase_stats_json,
      phase_best_json,
      score,
      updated_at: new Date().toISOString()
    };

    const { error: upsertError } = await supabase
      .from(STRATEGY_STATS_TABLE)
      .upsert(payload, { onConflict: 'strategy_key' });

    if (upsertError) {
      throw new Error(`strategy_stats upsert failed for ${key}: ${upsertError.message || upsertError}`);
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
  let disableResult = { updated: 0, disabled_keys: [], disabled_reason_map: {} };
  if (finalDisabledKeys.length > 0) {
    disableResult = await disableStrategies(supabase, finalDisabledKeys, disabledReasonMap);
  }

  return {
    ok: true,
    market_phase: marketPhase,
    updated_keys: [...new Set(updatedKeys)],
    disabled_keys: disableResult.disabled_keys || [],
    disabled_reason_map: disableResult.disabled_reason_map || {},
    disabled_count: toNum(disableResult.updated, 0)
  };
}
