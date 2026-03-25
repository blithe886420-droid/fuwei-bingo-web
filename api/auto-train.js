import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';
import { buildRecentMarketSignalSnapshot } from '../lib/marketSignalEngine.js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const TEST_MODE = 'test';
const FORMAL_MODE = 'formal';
const COMPARE_MODES = [TEST_MODE, FORMAL_MODE];

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 1;
const COMPARE_BATCH_LIMIT = 50;
const MARKET_LOOKBACK_LIMIT = 160;
const COST_PER_GROUP_PER_PERIOD = 25;

// 真進化版：允許持續建立新 test prediction，但防止 created 爆量
const MAX_CREATED_PREDICTIONS = 20;
const ALLOW_CREATE_WHEN_EXISTING = true;

const DEFAULT_STRATEGY_KEYS = [
  'hot_balanced',
  'balanced_zone',
  'mix_zone_3',
  'warm_gap',
  'mix_repeat',
  'zone_gap',
  'tail_repeat',
  'gap_mix',
  'chase_balanced_2',
  'odd_even_gap',
  'gap_cluster',
  'reverse_hot',
  'gap_chase',
  'gap_cluster_2',
  'tail_mix',
  'hot_zone',
  'warm_balanced',
  'repeat_guard',
  'zone_split',
  'pattern_mix',
  'cluster_hot',
  'cluster_chase',
  'spread_zone_rotation',
  'mix_gap',
  'chase_skip',
  'pattern_gap',
  'gap_balanced',
  'zone_rotation_gap',
  'zone_cold',
  'gap_cold',
  'skip_hot',
  'mix_balanced_2',
  'balanced_skip_4'
];

const DECISION_CONFIG = {
  hardRejectRoi: -0.85,
  hardRejectScore: -400,
  softRejectRoi: -0.5,
  minAvgHitPreferred: 1.2,
  minRoundsForTrust: 6,
  strongScoreFloor: 80,
  usableScoreFloor: 10
};

const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';
const PROTECTED_STATUS = new Set(['protected']);
const TERMINAL_STATUS = new Set(['disabled', 'retired']);

/**
 * 主動淘汰規則（與 strategyStatsRecorder 的快速淘汰精神一致）
 * 目的：即使本輪 compare 沒觸發，也能在 auto-train 週期內主動清理弱策略
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
  recent50RoiFloorF: -0.4
};

let supabase = null;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE env');
  }

  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });
  }

  return supabase;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function uniqueSorted(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))]
    .filter((n) => n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseNums(value) {
  if (Array.isArray(value)) {
    return uniqueSorted(value);
  }

  if (typeof value === 'string') {
    return uniqueSorted(
      value
        .replace(/[{}[\]]/g, ' ')
        .split(/[,\s|/]+/)
        .map(Number)
    );
  }

  if (value && typeof value === 'object') {
    return parseNums(
      value.numbers ||
      value.draw_numbers ||
      value.result_numbers ||
      value.open_numbers ||
      value.nums ||
      []
    );
  }

  return [];
}

function isDuplicateDrawModeError(error) {
  const msg = String(error?.message || '');
  const details = String(error?.details || '');
  const code = String(error?.code || '');

  return (
    code === '23505' ||
    msg.includes('unique_draw_mode') ||
    details.includes('unique_draw_mode') ||
    msg.includes('duplicate key value violates unique constraint')
  );
}

function tokenizeStrategyKey(strategyKey = '') {
  return String(strategyKey || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token));
}

function strategyLabel(strategyKey = '') {
  return String(strategyKey || '')
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function pickFromPool(pool = [], selectedSet = new Set(), seed = 0) {
  const candidates = uniqueSorted(pool).filter((n) => !selectedSet.has(n));
  if (!candidates.length) return null;
  const index = Math.abs(toNum(seed, 0)) % candidates.length;
  return candidates[index];
}

function fillToFour(base = [], fallbackPools = [], seed = 0) {
  const result = uniqueSorted(base).slice(0, 4);
  const selected = new Set(result);
  let cursor = 0;

  for (const pool of fallbackPools) {
    while (result.length < 4 && cursor < 220) {
      const value = pickFromPool(pool, selected, seed + cursor);
      cursor += 1;
      if (value == null) break;
      selected.add(value);
      result.push(value);
    }
    if (result.length >= 4) break;
  }

  if (result.length < 4) {
    const allNums = Array.from({ length: 80 }, (_, i) => i + 1);
    while (result.length < 4 && cursor < 500) {
      const value = pickFromPool(allNums, selected, seed + cursor);
      cursor += 1;
      if (value == null) break;
      selected.add(value);
      result.push(value);
    }
  }

  return uniqueSorted(result).slice(0, 4);
}

function getZoneIndex(n) {
  return Math.floor((n - 1) / 20);
}

function buildMarketState(drawRows = []) {
  const rows = Array.isArray(drawRows) ? drawRows : [];
  const parsedRows = rows.map((row) => ({
    draw_no: toNum(row?.draw_no, 0),
    numbers: parseNums(
      row?.numbers ??
      row?.draw_numbers ??
      row?.result_numbers ??
      row?.open_numbers
    )
  }));

  const latest = parsedRows[0]?.numbers || [];
  const recent20 = parsedRows.slice(0, 20);
  const recent50 = parsedRows.slice(0, 50);
  const recent80 = parsedRows.slice(0, 80);

  const freq20 = new Map();
  const freq50 = new Map();
  const freq80 = new Map();
  const lastSeenIndex = new Map();
  const tailFreq20 = new Map();
  const zoneFreq20 = new Map();

  for (let i = 1; i <= 80; i += 1) {
    freq20.set(i, 0);
    freq50.set(i, 0);
    freq80.set(i, 0);
  }

  recent20.forEach((row, idx) => {
    for (const n of row.numbers) {
      freq20.set(n, toNum(freq20.get(n), 0) + 1);
      if (!lastSeenIndex.has(n)) lastSeenIndex.set(n, idx);
      const tail = n % 10;
      tailFreq20.set(tail, toNum(tailFreq20.get(tail), 0) + 1);
      const zone = getZoneIndex(n);
      zoneFreq20.set(zone, toNum(zoneFreq20.get(zone), 0) + 1);
    }
  });

  recent50.forEach((row) => {
    for (const n of row.numbers) {
      freq50.set(n, toNum(freq50.get(n), 0) + 1);
    }
  });

  recent80.forEach((row) => {
    for (const n of row.numbers) {
      freq80.set(n, toNum(freq80.get(n), 0) + 1);
    }
  });

  const hot = [...freq20.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const cold = [...freq20.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  const warm = [...freq50.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const stable = [...freq80.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const gap = Array.from({ length: 80 }, (_, idx) => idx + 1)
    .sort((a, b) => {
      const gapA = lastSeenIndex.has(a) ? lastSeenIndex.get(a) : 999;
      const gapB = lastSeenIndex.has(b) ? lastSeenIndex.get(b) : 999;
      return gapB - gapA || a - b;
    });

  const tailsHot = [...tailFreq20.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([tail]) => tail);

  const zoneOrder = [...zoneFreq20.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([zone]) => zone);

  const allNums = Array.from({ length: 80 }, (_, i) => i + 1);
  const odd = allNums.filter((n) => n % 2 === 1);
  const even = allNums.filter((n) => n % 2 === 0);

  const oddCountLatest = latest.filter((n) => n % 2 === 1).length;
  const evenCountLatest = latest.length - oddCountLatest;
  const zoneCountLatest = latest.reduce((acc, n) => {
    const z = getZoneIndex(n);
    acc[z] = toNum(acc[z], 0) + 1;
    return acc;
  }, {});

  const marketBias = {
    oddHeavy: oddCountLatest > evenCountLatest,
    evenHeavy: evenCountLatest > oddCountLatest,
    compressedZones: Object.values(zoneCountLatest).some((v) => toNum(v, 0) >= 7)
  };

  return {
    latest,
    hot,
    cold,
    warm,
    stable,
    gap,
    odd,
    even,
    tailsHot,
    zoneOrder,
    recent20,
    recent50,
    recent80,
    marketBias,
    allNums
  };
}

function normalizeMarketSnapshot(snapshot = {}) {
  return {
    latest: snapshot?.latest || null,
    prev: snapshot?.prev || null,
    third: snapshot?.third || null,
    trend: snapshot?.trend || {
      sum_delta_1: 0,
      span_delta_1: 0,
      tail_changed: false
    }
  };
}

function getStrategyMarketBoost(strategyKey = '', marketSnapshot = {}) {
  const key = String(strategyKey || '').toLowerCase();
  const latestSummary = marketSnapshot?.latest?.summary || null;
  const trend = marketSnapshot?.trend || {};

  if (!latestSummary) {
    return {
      boost: 1,
      reason: 'market_neutral'
    };
  }

  let boost = 1;
  const reasons = [];

  if (latestSummary.odd_even_bias === 'odd' && key.includes('odd')) {
    boost += 0.16;
    reasons.push('odd_bias_match');
  }

  if (latestSummary.odd_even_bias === 'even' && key.includes('even')) {
    boost += 0.16;
    reasons.push('even_bias_match');
  }

  if (latestSummary.big_small_bias === 'big' && (key.includes('hot') || key.includes('chase'))) {
    boost += 0.1;
    reasons.push('big_bias_hot');
  }

  if (latestSummary.big_small_bias === 'small' && (key.includes('cold') || key.includes('guard'))) {
    boost += 0.1;
    reasons.push('small_bias_cold');
  }

  if (latestSummary.compactness === 'tight' && (key.includes('pattern') || key.includes('cluster'))) {
    boost += 0.15;
    reasons.push('tight_pattern');
  }

  if (latestSummary.compactness === 'wide' && (key.includes('gap') || key.includes('chase'))) {
    boost += 0.15;
    reasons.push('wide_gap');
  }

  if ((latestSummary.hot_zone === 1 || latestSummary.hot_zone === 4) && key.includes('zone')) {
    boost += 0.09;
    reasons.push('zone_focus');
  }

  if (latestSummary.sum_band === 'high' && (key.includes('hot') || key.includes('mix'))) {
    boost += 0.08;
    reasons.push('high_sum_hot');
  }

  if (latestSummary.sum_band === 'low' && (key.includes('cold') || key.includes('gap'))) {
    boost += 0.08;
    reasons.push('low_sum_cold');
  }

  if (trend.tail_changed && key.includes('tail')) {
    boost += 0.06;
    reasons.push('tail_changed');
  }

  if (toNum(trend.span_delta_1, 0) >= 8 && key.includes('gap')) {
    boost += 0.05;
    reasons.push('span_expanding');
  }

  if (toNum(trend.span_delta_1, 0) <= -8 && (key.includes('pattern') || key.includes('cluster'))) {
    boost += 0.05;
    reasons.push('span_shrinking');
  }

  boost = clamp(boost, 0.82, 1.28);

  return {
    boost,
    reason: reasons.length ? reasons.join('|') : 'market_neutral'
  };
}

function numbersByTail(tail, allNums = []) {
  return allNums.filter((n) => n % 10 === tail);
}

function numbersByZone(zoneIndex, allNums = []) {
  const start = zoneIndex * 20 + 1;
  const end = start + 19;
  return allNums.filter((n) => n >= start && n <= end);
}

function buildStrategyNums(strategyKey, market, seed = 0) {
  const tokens = tokenizeStrategyKey(strategyKey);
  const selected = [];

  const {
    latest,
    hot,
    cold,
    warm,
    stable,
    gap,
    odd,
    even,
    tailsHot,
    zoneOrder,
    allNums,
    marketBias
  } = market;

  const fallbackPools = [hot, warm, stable, gap, cold, allNums];
  const has = (token) => tokens.includes(token);

  if (has('repeat')) {
    selected.push(...latest.slice(0, 2));
  }

  if (has('hot')) {
    selected.push(...hot.slice(0, 3));
  }

  if (has('cold')) {
    selected.push(...cold.slice(0, 3));
  }

  if (has('warm')) {
    selected.push(...warm.slice(1, 5));
  }

  if (has('gap') || has('jump') || has('chase')) {
    selected.push(...gap.slice(0, 4));
  }

  if (has('tail')) {
    const topTail = tailsHot[0] ?? 0;
    const secondTail = tailsHot[1] ?? ((topTail + 4) % 10);
    selected.push(...numbersByTail(topTail, allNums).slice(0, 2));
    selected.push(...numbersByTail(secondTail, allNums).slice(0, 1));
  }

  if (has('zone') || has('split') || has('spread') || has('rotation')) {
    const z1 = zoneOrder[0] ?? 0;
    const z2 = zoneOrder[1] ?? 1;
    selected.push(...numbersByZone(z1, allNums).slice(0, 2));
    selected.push(...numbersByZone(z2, allNums).slice(0, 2));
  }

  if (has('balanced') || has('balance')) {
    selected.push(...odd.slice(0, 2));
    selected.push(...even.slice(0, 2));
  }

  if (has('odd')) {
    selected.push(...odd.slice(0, 4));
  }

  if (has('even')) {
    selected.push(...even.slice(0, 4));
  }

  if (has('cluster')) {
    const base = hot[0] ?? 10;
    selected.push(base);
    if (base + 1 <= 80) selected.push(base + 1);
    if (base + 2 <= 80) selected.push(base + 2);
  }

  if (has('mix') || has('pattern') || has('structure')) {
    selected.push(hot[0], warm[1], gap[1], stable[2]);
  }

  if (has('guard')) {
    selected.push(cold[0], gap[0]);
  }

  if (has('reverse')) {
    selected.push(...cold.slice(0, 2));
    selected.push(...gap.slice(0, 2));
  }

  if (has('rotation')) {
    selected.push(...stable.slice(2, 5));
  }

  if (has('skip')) {
    selected.push(...gap.slice(0, 2), ...cold.slice(0, 2));
  }

  if (marketBias.oddHeavy && (has('balanced') || has('mix'))) {
    selected.push(...even.slice(0, 2));
  }

  if (marketBias.evenHeavy && (has('balanced') || has('mix'))) {
    selected.push(...odd.slice(0, 2));
  }

  if (marketBias.compressedZones && (has('spread') || has('zone') || has('rotation'))) {
    const safeZone = zoneOrder[2] ?? 2;
    selected.push(...numbersByZone(safeZone, allNums).slice(0, 2));
  }

  let nums = fillToFour(selected, fallbackPools, seed);

  if (has('balanced') || has('balance')) {
    const oddNums = nums.filter((n) => n % 2 === 1);
    const evenNums = nums.filter((n) => n % 2 === 0);

    if (oddNums.length === 0 || evenNums.length === 0) {
      nums = fillToFour(
        [...odd.slice(0, 2), ...even.slice(0, 2), ...nums],
        fallbackPools,
        seed + 17
      );
    }
  }

  if (has('zone') || has('split') || has('spread') || has('rotation')) {
    const zones = new Set(nums.map((n) => getZoneIndex(n)));
    if (zones.size < 2) {
      const extraZone = zoneOrder[1] ?? 1;
      nums = fillToFour(
        [...nums, ...numbersByZone(extraZone, allNums).slice(0, 2)],
        fallbackPools,
        seed + 29
      );
    }
  }

  return uniqueSorted(nums).slice(0, 4);
}

function normalizeHitRate(raw) {
  const value = toNum(raw, 0);
  if (value <= 0) return 0;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return 1;
}

function evaluateStrategyDecision(poolRow = {}, statRow = {}, marketSnapshot = {}) {
  const totalRounds = toNum(statRow?.total_rounds, 0);
  const avgHit = toNum(statRow?.avg_hit, 0);
  const roi = toNum(statRow?.roi, 0);
  const score = toNum(statRow?.score, 0);
  const hitRate = normalizeHitRate(statRow?.hit_rate);
  const recent50HitRate = normalizeHitRate(statRow?.recent_50_hit_rate);
  const recent50Roi = toNum(statRow?.recent_50_roi, 0);
  const generation = Math.max(1, toNum(poolRow?.generation, 1));
  const marketFit = getStrategyMarketBoost(poolRow?.strategy_key, marketSnapshot);

  let decision = 'candidate';

  if (
    totalRounds >= DECISION_CONFIG.minRoundsForTrust &&
    (roi <= DECISION_CONFIG.hardRejectRoi || score <= DECISION_CONFIG.hardRejectScore)
  ) {
    decision = 'reject';
  } else if (
    totalRounds >= DECISION_CONFIG.minRoundsForTrust &&
    roi <= DECISION_CONFIG.softRejectRoi &&
    avgHit < DECISION_CONFIG.minAvgHitPreferred
  ) {
    decision = 'weak';
  } else if (
    score >= DECISION_CONFIG.strongScoreFloor ||
    avgHit >= 2 ||
    recent50HitRate >= 0.35 ||
    recent50Roi > 0
  ) {
    decision = 'strong';
  } else if (
    score >= DECISION_CONFIG.usableScoreFloor ||
    avgHit >= DECISION_CONFIG.minAvgHitPreferred ||
    hitRate >= 0.2
  ) {
    decision = 'usable';
  }

  let weight = 0;

  if (decision === 'strong') {
    weight = 1000;
  } else if (decision === 'usable') {
    weight = 220;
  } else if (decision === 'candidate') {
    weight = totalRounds < DECISION_CONFIG.minRoundsForTrust ? 60 : 12;
  } else if (decision === 'weak') {
    weight = 1;
  } else {
    weight = 0;
  }

  weight += Math.max(0, score * 0.08);
  weight += avgHit * 25;
  weight += hitRate * 35;
  weight += recent50HitRate * 55;
  weight += Math.max(0, recent50Roi) * 25;
  weight += Math.min(totalRounds, 120) * 0.05;
  weight += generation * 0.4;

  if (String(poolRow?.protected_rank) === 'true' || poolRow?.protected_rank === true) {
    weight += 20;
  }

  if (roi < 0) {
    weight += roi * 12;
  }

  weight = Math.round(Math.max(0, weight * marketFit.boost));

  return {
    decision,
    weight,
    totalRounds,
    avgHit,
    roi,
    score,
    hitRate,
    recent50HitRate,
    recent50Roi,
    generation,
    marketBoost: marketFit.boost,
    marketReason: marketFit.reason,
    decisionScore:
      score * marketFit.boost +
      avgHit * 26 +
      recent50Roi * 22 +
      recent50HitRate * 30 +
      totalRounds * 0.12
  };
}

function byPowerDesc(a, b) {
  return (
    toNum(b.decision_score, 0) - toNum(a.decision_score, 0) ||
    toNum(b.weight, 0) - toNum(a.weight, 0) ||
    toNum(b.market_boost, 1) - toNum(a.market_boost, 1) ||
    toNum(b.score, 0) - toNum(a.score, 0) ||
    toNum(b.avg_hit, 0) - toNum(a.avg_hit, 0) ||
    toNum(b.total_rounds, 0) - toNum(a.total_rounds, 0) ||
    String(a.strategy_key).localeCompare(String(b.strategy_key))
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

  if (
    totalRounds >= DISABLE_RULES.minRoundsE &&
    roi < DISABLE_RULES.roiFloorE
  ) {
    return {
      shouldDisable: true,
      reason: `early_fail_roi_below_${DISABLE_RULES.roiFloorE}_after_${DISABLE_RULES.minRoundsE}`
    };
  }

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

  return {
    shouldDisable: false,
    reason: ''
  };
}

async function getPoolStatusMap(supabaseClient, strategyKeys = []) {
  const safeKeys = [...new Set((Array.isArray(strategyKeys) ? strategyKeys : []).filter(Boolean))];
  if (!safeKeys.length) return new Map();

  const { data, error } = await supabaseClient
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

async function disableStrategies(supabaseClient, strategyKeys = [], reasonMap = {}) {
  const finalKeys = [...new Set((Array.isArray(strategyKeys) ? strategyKeys : []).filter(Boolean))];
  if (!finalKeys.length) {
    return {
      updated: 0,
      disabled_keys: [],
      disabled_reason_map: {}
    };
  }

  const nowIso = new Date().toISOString();

  const { error } = await supabaseClient
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

async function runSync() {
  return { ok: true };
}

async function runCatchup() {
  return { ok: true };
}

async function countCreatedPredictions(db) {
  const { count, error } = await db
    .from('bingo_predictions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'created');

  if (error) throw error;
  return toNum(count, 0);
}

async function runCompare(db) {
  const { data: predictions, error: predError } = await db
    .from('bingo_predictions')
    .select('*')
    .in('mode', COMPARE_MODES)
    .eq('status', 'created')
    .order('created_at', { ascending: true })
    .limit(COMPARE_BATCH_LIMIT);

  if (predError) throw predError;

  if (!predictions || !predictions.length) {
    return {
      ok: true,
      processed: 0,
      waiting: 0,
      processed_by_mode: {
        test: 0,
        formal: 0
      },
      waiting_by_mode: {
        test: 0,
        formal: 0
      },
      total_candidates: 0,
      compare_modes: [...COMPARE_MODES],
      disabled_keys: []
    };
  }

  let processed = 0;
  let waiting = 0;

  const processedByMode = {
    test: 0,
    formal: 0
  };

  const waitingByMode = {
    test: 0,
    formal: 0
  };

  const disabledKeysAll = [];

  for (const prediction of predictions) {
    const mode =
      String(prediction?.mode || '').toLowerCase() === FORMAL_MODE
        ? FORMAL_MODE
        : TEST_MODE;

    const sourceDrawNo = toNum(prediction?.source_draw_no, 0);
    const targetPeriods = Math.max(
      1,
      toNum(prediction?.target_periods, mode === FORMAL_MODE ? 4 : TARGET_PERIODS)
    );
    const groups = Array.isArray(prediction?.groups_json) ? prediction.groups_json : [];

    if (!sourceDrawNo || groups.length === 0) {
      waiting += 1;
      waitingByMode[mode] += 1;
      continue;
    }

    const { data: drawRows, error: drawError } = await db
      .from('bingo_draws')
      .select('*')
      .gt('draw_no', sourceDrawNo)
      .order('draw_no', { ascending: true })
      .limit(targetPeriods);

    if (drawError) throw drawError;

    if (!drawRows || drawRows.length < targetPeriods) {
      waiting += 1;
      waitingByMode[mode] += 1;
      continue;
    }

    const payload = buildComparePayload({
      groups,
      drawRows,
      costPerGroupPerPeriod: COST_PER_GROUP_PER_PERIOD
    });

    if (!payload || !payload.compareResult) {
      waiting += 1;
      waitingByMode[mode] += 1;
      continue;
    }

    const comparedAt = new Date().toISOString();

    const { error: updateError } = await db
      .from('bingo_predictions')
      .update({
        status: 'compared',
        compare_status: 'done',
        hit_count: toNum(payload.hitCount, 0),
        compare_result: payload.compareResult,
        verdict: payload.verdict || 'bad',
        compared_at: comparedAt
      })
      .eq('id', prediction.id);

    if (updateError) throw updateError;

    const statsResult = await recordStrategyCompareResult(payload.compareResult);

    if (Array.isArray(statsResult?.disabled_keys) && statsResult.disabled_keys.length) {
      disabledKeysAll.push(...statsResult.disabled_keys);
    }

    processed += 1;
    processedByMode[mode] += 1;
  }

  return {
    ok: true,
    processed,
    waiting,
    processed_by_mode: processedByMode,
    waiting_by_mode: waitingByMode,
    total_candidates: predictions.length,
    compare_modes: [...COMPARE_MODES],
    disabled_keys: [...new Set(disabledKeysAll)]
  };
}

async function fetchMarketRows(db) {
  const { data, error } = await db
    .from('bingo_draws')
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(MARKET_LOOKBACK_LIMIT);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function fetchStrategyCandidates(db, marketSnapshot = {}) {
  await ensureStrategyPoolStrategies();

  const { data: poolRows, error: poolError } = await db
    .from('strategy_pool')
    .select('*')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  if (poolError) throw poolError;

  const strategyKeys = (poolRows || [])
    .map((row) => String(row?.strategy_key || '').trim().toLowerCase())
    .filter(Boolean);

  if (!strategyKeys.length) {
    throw new Error('No active strategy_pool rows');
  }

  const { data: statsRows, error: statsError } = await db
    .from('strategy_stats')
    .select('*')
    .in('strategy_key', strategyKeys);

  if (statsError) throw statsError;

  const statsMap = new Map(
    (statsRows || []).map((row) => [String(row?.strategy_key || '').trim().toLowerCase(), row])
  );

  const merged = (poolRows || []).map((row) => {
    const stat = statsMap.get(String(row?.strategy_key || '').trim().toLowerCase()) || {};
    const evaluation = evaluateStrategyDecision(row, stat, marketSnapshot);

    return {
      ...row,
      stats: stat,
      decision: evaluation.decision,
      weight: evaluation.weight,
      avg_hit: evaluation.avgHit,
      roi: evaluation.roi,
      score: evaluation.score,
      total_rounds: evaluation.totalRounds,
      hit_rate: evaluation.hitRate,
      recent_50_hit_rate: evaluation.recent50HitRate,
      recent_50_roi: evaluation.recent50Roi,
      market_boost: evaluation.marketBoost,
      market_reason: evaluation.marketReason,
      decision_score: evaluation.decisionScore
    };
  });

  const strong = merged.filter((row) => row.decision === 'strong').sort(byPowerDesc);
  const usable = merged.filter((row) => row.decision === 'usable').sort(byPowerDesc);
  const candidate = merged.filter((row) => row.decision === 'candidate').sort(byPowerDesc);
  const weak = merged.filter((row) => row.decision === 'weak').sort(byPowerDesc);

  let finalRows = [...strong, ...usable, ...candidate];

  if (finalRows.length < BET_GROUP_COUNT) {
    finalRows = [...finalRows, ...weak];
  }

  finalRows = finalRows
    .filter((row) => toNum(row.weight, 0) > 0)
    .sort(byPowerDesc);

  if (!finalRows.length) {
    throw new Error('No usable strategy candidates after decision filter');
  }

  return {
    all: finalRows,
    strong,
    usable,
    candidate,
    weak
  };
}

function detectMarketType(marketSnapshot = {}) {
  const s = marketSnapshot?.latest?.summary;
  if (!s) return 'UNKNOWN';

  const { sum_band, big_small_bias, hot_zone, compactness } = s;

  if (sum_band === 'high' && big_small_bias === 'big' && hot_zone === 4) {
    return 'HIGH_BIG_ZONE4';
  }

  if (sum_band === 'low' && big_small_bias === 'small' && hot_zone === 1) {
    return 'LOW_SMALL_ZONE1';
  }

  if (compactness === 'wide') {
    return 'WIDE_SPREAD';
  }

  if (compactness === 'tight') {
    return 'TIGHT_CLUSTER';
  }

  return 'NORMAL';
}

function filterStrategiesByMarket(strategies = [], marketType = '') {
  return strategies.map((s) => {
    let boost = 1;

    if (marketType === 'HIGH_BIG_ZONE4') {
      if (String(s.strategy_key || '').includes('hot') || String(s.strategy_key || '').includes('chase')) {
        boost *= 1.3;
      }
    }

    if (marketType === 'LOW_SMALL_ZONE1') {
      if (String(s.strategy_key || '').includes('cold') || String(s.strategy_key || '').includes('guard')) {
        boost *= 1.3;
      }
    }

    if (marketType === 'WIDE_SPREAD') {
      if (String(s.strategy_key || '').includes('gap') || String(s.strategy_key || '').includes('chase')) {
        boost *= 1.25;
      }
    }

    if (marketType === 'TIGHT_CLUSTER') {
      if (String(s.strategy_key || '').includes('pattern') || String(s.strategy_key || '').includes('cluster')) {
        boost *= 1.25;
      }
    }

    return {
      ...s,
      final_weight: Math.round((s.weight || 0) * boost),
      market_type: marketType,
      market_boost: boost
    };
  });
}

function buildPredictionGroups(candidatePack = {}, market = {}, marketSnapshot = {}, seed = Date.now()) {
  const marketType = detectMarketType(marketSnapshot);

  let strategies = Array.isArray(candidatePack?.all) ? candidatePack.all : [];

  strategies = filterStrategiesByMarket(strategies, marketType);

  strategies = strategies
    .filter((s) => (s.final_weight || 0) > 0)
    .sort((a, b) =>
      (b.final_weight - a.final_weight) ||
      (b.avg_hit - a.avg_hit) ||
      (b.roi - a.roi)
    );

  const used = new Set();
  const groups = [];

  for (let i = 0; i < strategies.length && groups.length < BET_GROUP_COUNT; i += 1) {
    const s = strategies[i];
    if (used.has(s.strategy_key)) continue;

    used.add(s.strategy_key);

    groups.push({
      key: s.strategy_key,
      label: s.strategy_name || strategyLabel(s.strategy_key),
      nums: buildStrategyNums(s.strategy_key, market, seed + i * 77),
      meta: {
        strategy_key: s.strategy_key,
        strategy_name: s.strategy_name,
        decision: s.decision,
        weight: s.weight,
        final_weight: s.final_weight,
        market_type: marketType,
        market_boost: s.market_boost,
        avg_hit: s.avg_hit,
        roi: s.roi
      }
    });
  }

  return groups.slice(0, BET_GROUP_COUNT);
}

async function runStrategyReaper(db) {
  const { data: statsRows, error: statsError } = await db
    .from(STRATEGY_STATS_TABLE)
    .select('*');

  if (statsError) {
    throw new Error(`strategy_stats scan failed: ${statsError.message || statsError}`);
  }

  const rows = Array.isArray(statsRows) ? statsRows : [];
  if (!rows.length) {
    return {
      ok: true,
      scanned: 0,
      disabled_count: 0,
      disabled_keys: [],
      disabled_reason_map: {}
    };
  }

  const keys = rows
    .map((row) => String(row?.strategy_key || '').trim())
    .filter(Boolean);

  const poolStatusMap = await getPoolStatusMap(db, keys);

  const disabledKeys = [];
  const disabledReasonMap = {};

  for (const row of rows) {
    const key = String(row?.strategy_key || '').trim();
    if (!key) continue;

    const poolInfo = poolStatusMap.get(key) || {
      status: '',
      protected_rank: false
    };

    const currentStatus = String(poolInfo.status || '').trim().toLowerCase();

    if (poolInfo.protected_rank || PROTECTED_STATUS.has(currentStatus)) {
      continue;
    }

    if (TERMINAL_STATUS.has(currentStatus)) {
      continue;
    }

    const disableCheck = shouldDisableStrategy(row);

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
    disableResult = await disableStrategies(db, finalDisabledKeys, disabledReasonMap);
  }

  return {
    ok: true,
    scanned: rows.length,
    disabled_count: toNum(disableResult.updated, 0),
    disabled_keys: disableResult.disabled_keys || [],
    disabled_reason_map: disableResult.disabled_reason_map || {}
  };
}

export default async function handler(req, res) {
  try {
    const db = getSupabase();

    const compareBeforeCreate = await runCompare(db);
    const catchup = await runCatchup(db);
    const sync = await runSync(db);

    const pipeline = {
      compare_before_create: compareBeforeCreate,
      catchup,
      sync
    };

    const { data: latestDrawRows, error: latestError } = await db
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(1);

    if (latestError) throw latestError;

    if (!latestDrawRows || !latestDrawRows.length) {
      const reaperResult = await runStrategyReaper(db);

      return res.status(200).json({
        ok: true,
        compare_modes: [...COMPARE_MODES],
        pipeline: {
          ...pipeline,
          reaper: reaperResult
        },
        market_snapshot: null,
        compared_count: toNum(compareBeforeCreate?.processed, 0),
        compared_by_mode: compareBeforeCreate?.processed_by_mode || {
          test: 0,
          formal: 0
        },
        created_count: 0,
        created_by_mode: {
          test: 0,
          formal: 0
        },
        created_current_open_count: await countCreatedPredictions(db),
        disabled_keys: reaperResult.disabled_keys || [],
        active_created_prediction: null,
        train: {
          ok: true,
          skipped: true,
          reason: 'No bingo_draws'
        }
      });
    }

    const latestDraw = latestDrawRows[0];
    const sourceDrawNoRaw = Number(latestDraw.draw_no) - TARGET_PERIODS;

    if (sourceDrawNoRaw <= 0) {
      const reaperResult = await runStrategyReaper(db);

      return res.status(200).json({
        ok: true,
        compare_modes: [...COMPARE_MODES],
        pipeline: {
          ...pipeline,
          reaper: reaperResult
        },
        market_snapshot: null,
        compared_count: toNum(compareBeforeCreate?.processed, 0),
        compared_by_mode: compareBeforeCreate?.processed_by_mode || {
          test: 0,
          formal: 0
        },
        created_count: 0,
        created_by_mode: {
          test: 0,
          formal: 0
        },
        created_current_open_count: await countCreatedPredictions(db),
        disabled_keys: reaperResult.disabled_keys || [],
        active_created_prediction: null,
        train: {
          ok: true,
          skipped: true,
          reason: 'draw_no too small'
        }
      });
    }

    const sourceDrawNo = String(sourceDrawNoRaw);

    let createdCount = 0;
    let activeCreatedPrediction = null;
    let marketSnapshot = null;

    const createdNowCount = await countCreatedPredictions(db);

    const shouldCreatePrediction =
      createdNowCount < MAX_CREATED_PREDICTIONS;

    if (shouldCreatePrediction) {
      const { data: existingPrediction, error: existingError } = await db
        .from('bingo_predictions')
        .select('*')
        .eq('mode', TEST_MODE)
        .eq('source_draw_no', sourceDrawNo)
        .eq('status', 'created')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingError) throw existingError;

      const allowCreateNow =
        ALLOW_CREATE_WHEN_EXISTING || !existingPrediction;

      if (allowCreateNow) {
        const marketRows = await fetchMarketRows(db);
        const market = buildMarketState(marketRows);
        marketSnapshot = normalizeMarketSnapshot(
          buildRecentMarketSignalSnapshot(marketRows, 'numbers')
        );

        const strategyCandidates = await fetchStrategyCandidates(db, marketSnapshot);
        const groups = buildPredictionGroups(
          strategyCandidates,
          market,
          marketSnapshot,
          Date.now()
        );

        if (!groups.length) {
          throw new Error('Failed to build prediction groups from strategy_pool');
        }

        const now = Date.now();
        const payload = {
          id: now,
          mode: TEST_MODE,
          status: 'created',
          source_draw_no: sourceDrawNo,
          target_periods: TARGET_PERIODS,
          groups_json: groups,
          market_snapshot_json: marketSnapshot,
          created_at: new Date().toISOString()
        };

        const { data: inserted, error: insertError } = await db
          .from('bingo_predictions')
          .insert(payload)
          .select('*')
          .single();

        if (insertError) {
          if (isDuplicateDrawModeError(insertError)) {
            const { data: existingAfterDup } = await db
              .from('bingo_predictions')
              .select('*')
              .eq('mode', TEST_MODE)
              .eq('source_draw_no', sourceDrawNo)
              .eq('status', 'created')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            activeCreatedPrediction = existingAfterDup || null;
          } else {
            throw insertError;
          }
        } else {
          createdCount = 1;
          activeCreatedPrediction = inserted;
        }
      }
    }

    const compareAfterCreate = await runCompare(db);
    pipeline.compare_after_create = compareAfterCreate;

    const reaperResult = await runStrategyReaper(db);
    pipeline.reaper = reaperResult;

    let finalActiveCreatedPrediction = activeCreatedPrediction;

    if (finalActiveCreatedPrediction?.id) {
      const { data: refreshedPrediction } = await db
        .from('bingo_predictions')
        .select('*')
        .eq('id', finalActiveCreatedPrediction.id)
        .maybeSingle();

      finalActiveCreatedPrediction = refreshedPrediction || finalActiveCreatedPrediction;
    }

    const comparedBefore = toNum(compareBeforeCreate?.processed, 0);
    const comparedAfter = toNum(compareAfterCreate?.processed, 0);

    const beforeByMode = compareBeforeCreate?.processed_by_mode || { test: 0, formal: 0 };
    const afterByMode = compareAfterCreate?.processed_by_mode || { test: 0, formal: 0 };

    const disabledKeys = [
      ...(Array.isArray(compareBeforeCreate?.disabled_keys) ? compareBeforeCreate.disabled_keys : []),
      ...(Array.isArray(compareAfterCreate?.disabled_keys) ? compareAfterCreate.disabled_keys : []),
      ...(Array.isArray(reaperResult?.disabled_keys) ? reaperResult.disabled_keys : [])
    ];

    const createdRemaining = await countCreatedPredictions(db);

    return res.status(200).json({
      ok: true,
      compare_modes: [...COMPARE_MODES],
      pipeline,
      market_snapshot: marketSnapshot,
      compared_count: comparedBefore + comparedAfter,
      compared_by_mode: {
        test: toNum(beforeByMode?.test, 0) + toNum(afterByMode?.test, 0),
        formal: toNum(beforeByMode?.formal, 0) + toNum(afterByMode?.formal, 0)
      },
      created_count: createdCount,
      created_by_mode: {
        test: createdCount,
        formal: 0
      },
      created_current_open_count: createdRemaining,
      disabled_keys: [...new Set(disabledKeys)],
      active_created_prediction: finalActiveCreatedPrediction,
      reaper: reaperResult,
      train: {
        ok: true,
        skipped: createdCount === 0,
        reason:
          createdCount === 0
            ? (createdNowCount >= MAX_CREATED_PREDICTIONS
                ? 'created pool reached limit'
                : 'Prediction already exists')
            : undefined,
        existing: createdCount === 0 ? finalActiveCreatedPrediction : undefined
      }
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || 'auto-train failed'
    });
  }
}
