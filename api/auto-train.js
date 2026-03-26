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
const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';

const PROTECTED_STATUS = new Set(['protected']);
const TERMINAL_STATUS = new Set(['disabled', 'retired']);

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

const MIN_ACTIVE_STRATEGY = 30;
const TARGET_ACTIVE_STRATEGY = 60;
const MAX_ACTIVE_STRATEGY = 80;
const MAX_SPAWN_PER_RUN = 12;

const SOFT_SHRINK_TRIGGER = MAX_ACTIVE_STRATEGY + 1;
const HARD_SHRINK_TRIGGER = 120;
const EXTREME_SHRINK_TRIGGER = 160;

const KNOWN_GENES = [
  'hot',
  'cold',
  'warm',
  'zone',
  'tail',
  'mix',
  'repeat',
  'guard',
  'balanced',
  'balance',
  'chase',
  'jump',
  'pattern',
  'structure',
  'split',
  'cluster',
  'gap',
  'spread',
  'rotation',
  'odd',
  'even',
  'reverse',
  'skip'
];

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

function normalizeStrategyKey(raw = '') {
  return String(raw || '').trim().toLowerCase();
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

function byWeaknessDesc(a, b) {
  return (
    toNum(a.decision_rank, 99) - toNum(b.decision_rank, 99) ||
    toNum(a.decision_score, 0) - toNum(b.decision_score, 0) ||
    toNum(a.weight, 0) - toNum(b.weight, 0) ||
    toNum(a.roi, 0) - toNum(b.roi, 0) ||
    toNum(a.recent_50_roi, 0) - toNum(b.recent_50_roi, 0) ||
    toNum(a.avg_hit, 0) - toNum(b.avg_hit, 0) ||
    toNum(a.total_rounds, 0) - toNum(b.total_rounds, 0) ||
    String(a.strategy_key).localeCompare(String(b.strategy_key))
  );
}

function getDecisionRank(decision = '') {
  const d = String(decision || '').toLowerCase();

  if (d === 'reject') return 0;
  if (d === 'weak') return 1;
  if (d === 'candidate') return 2;
  if (d === 'usable') return 3;
  if (d === 'strong') return 4;
  return 5;
}

function buildAdaptiveDisableRules(activeCount = 999) {
  if (activeCount <= 34) {
    return {
      ...DISABLE_RULES,
      roiFloorA: -0.8,
      recent50RoiFloorB: -0.45,
      recent50RoiFloorC: -0.55,
      roiFloorD: -0.55,
      roiFloorE: -0.8,
      recent50RoiFloorF: -0.65
    };
  }

  if (activeCount <= 45) {
    return {
      ...DISABLE_RULES,
      roiFloorA: -0.65,
      recent50RoiFloorB: -0.32,
      recent50RoiFloorC: -0.45,
      roiFloorD: -0.42,
      roiFloorE: -0.65,
      recent50RoiFloorF: -0.52
    };
  }

  if (activeCount >= EXTREME_SHRINK_TRIGGER) {
    return {
      ...DISABLE_RULES,
      roiFloorA: -0.28,
      recent50RoiFloorB: -0.08,
      recent50RoiFloorC: -0.18,
      roiFloorD: -0.2,
      roiFloorE: -0.3,
      recent50RoiFloorF: -0.22,
      avgHitFloorB: 1.08,
      avgHitFloorD: 1.18,
      avgHitFloorF: 0.95,
      hitRateFloorC: 0.18
    };
  }

  if (activeCount >= HARD_SHRINK_TRIGGER) {
    return {
      ...DISABLE_RULES,
      roiFloorA: -0.35,
      recent50RoiFloorB: -0.12,
      recent50RoiFloorC: -0.24,
      roiFloorD: -0.24,
      roiFloorE: -0.38,
      recent50RoiFloorF: -0.28,
      avgHitFloorB: 1.04,
      avgHitFloorD: 1.14,
      avgHitFloorF: 0.9,
      hitRateFloorC: 0.15
    };
  }

  if (activeCount >= SOFT_SHRINK_TRIGGER) {
    return {
      ...DISABLE_RULES,
      roiFloorA: -0.42,
      recent50RoiFloorB: -0.16,
      recent50RoiFloorC: -0.28,
      roiFloorD: -0.26,
      roiFloorE: -0.44,
      recent50RoiFloorF: -0.34,
      avgHitFloorB: 1.02,
      avgHitFloorD: 1.12,
      avgHitFloorF: 0.86,
      hitRateFloorC: 0.13
    };
  }

  return { ...DISABLE_RULES };
}

function shouldDisableStrategy(row = {}, activeCount = 999) {
  const rules = buildAdaptiveDisableRules(activeCount);

  const roi = toNum(row?.roi);
  const avgHit = toNum(row?.avg_hit);
  const recent50Roi = toNum(row?.recent_50_roi);
  const recent50HitRate = toNum(row?.recent_50_hit_rate);
  const totalRounds = toNum(row?.total_rounds);

  if (
    totalRounds >= rules.minRoundsA &&
    roi < rules.roiFloorA
  ) {
    return {
      shouldDisable: true,
      reason: `roi_below_${rules.roiFloorA}_after_${rules.minRoundsA}`
    };
  }

  if (
    totalRounds >= rules.minRoundsB &&
    recent50Roi < rules.recent50RoiFloorB &&
    avgHit < rules.avgHitFloorB
  ) {
    return {
      shouldDisable: true,
      reason: `recent50_roi_below_${rules.recent50RoiFloorB}_and_avg_hit_below_${rules.avgHitFloorB}`
    };
  }

  if (
    totalRounds >= rules.minRoundsC &&
    recent50Roi < rules.recent50RoiFloorC &&
    recent50HitRate < rules.hitRateFloorC
  ) {
    return {
      shouldDisable: true,
      reason: `recent50_roi_below_${rules.recent50RoiFloorC}_and_hit_rate_below_${rules.hitRateFloorC}`
    };
  }

  if (
    totalRounds >= rules.minRoundsD &&
    roi < rules.roiFloorD &&
    avgHit < rules.avgHitFloorD
  ) {
    return {
      shouldDisable: true,
      reason: `roi_below_${rules.roiFloorD}_and_avg_hit_below_${rules.avgHitFloorD}`
    };
  }

  if (
    totalRounds >= rules.minRoundsE &&
    roi < rules.roiFloorE
  ) {
    return {
      shouldDisable: true,
      reason: `early_fail_roi_below_${rules.roiFloorE}_after_${rules.minRoundsE}`
    };
  }

  if (
    totalRounds >= rules.minRoundsF &&
    avgHit < rules.avgHitFloorF &&
    recent50Roi < rules.recent50RoiFloorF
  ) {
    return {
      shouldDisable: true,
      reason: `early_fail_avg_hit_below_${rules.avgHitFloorF}_and_recent50_roi_below_${rules.recent50RoiFloorF}`
    };
  }

  return {
    shouldDisable: false,
    reason: ''
  };
}

function inferGenesFromStrategyKey(strategyKey = '') {
  const tokens = tokenizeStrategyKey(strategyKey);
  const genes = tokens.filter((t) => KNOWN_GENES.includes(t));

  return {
    gene_a: genes[0] || 'mix',
    gene_b: genes[1] || 'balanced'
  };
}

function uniqueTokens(tokens = []) {
  return [...new Set((Array.isArray(tokens) ? tokens : []).filter(Boolean))];
}

function buildStrategyKeyFromTokens(tokens = []) {
  return normalizeStrategyKey(uniqueTokens(tokens).slice(0, 3).join('_'));
}

function buildChildStrategyKey(parentAKey = '', parentBKey = '', mode = 'crossover', seq = 0) {
  const tokensA = tokenizeStrategyKey(parentAKey);
  const tokensB = tokenizeStrategyKey(parentBKey);

  if (mode === 'exploration') {
    const a = KNOWN_GENES[seq % KNOWN_GENES.length];
    const b = KNOWN_GENES[(seq + 7) % KNOWN_GENES.length];
    const c = KNOWN_GENES[(seq + 13) % KNOWN_GENES.length];
    return buildStrategyKeyFromTokens([a, b, c]);
  }

  if (mode === 'mutation') {
    const base = tokensA.length ? [...tokensA] : ['mix', 'balanced'];
    const extra = KNOWN_GENES[(seq + base.length) % KNOWN_GENES.length];
    return buildStrategyKeyFromTokens([...base, extra]);
  }

  const a1 = tokensA[0] || 'mix';
  const a2 = tokensA[1] || '';
  const b1 = tokensB[0] || 'balanced';
  const b2 = tokensB[1] || '';

  return buildStrategyKeyFromTokens([a1, b1, a2 || b2].filter(Boolean));
}

function chooseSpawnSourceType(index = 0, activeCount = 0) {
  if (activeCount < 36) {
    return index % 3 === 0 ? 'exploration' : 'evolved';
  }

  if (index % 4 === 0) return 'exploration';
  if (index % 2 === 0) return 'crossover';
  return 'evolved';
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

async function getPoolRows(db) {
  const { data, error } = await db
    .from(STRATEGY_POOL_TABLE)
    .select('*');

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function countActiveStrategies(db) {
  const { count, error } = await db
    .from(STRATEGY_POOL_TABLE)
    .select('strategy_key', { count: 'exact', head: true })
    .eq('status', 'active');

  if (error) throw error;
  return toNum(count, 0);
}

function getShrinkPlan(activeCount = 0) {
  if (activeCount <= MAX_ACTIVE_STRATEGY) {
    return {
      shrinkMode: 'off',
      overTarget: Math.max(0, activeCount - TARGET_ACTIVE_STRATEGY),
      overMax: 0,
      extraDisableTarget: 0,
      maxDisablePerRun: 8
    };
  }

  const overTarget = Math.max(0, activeCount - TARGET_ACTIVE_STRATEGY);
  const overMax = Math.max(0, activeCount - MAX_ACTIVE_STRATEGY);

  if (activeCount >= EXTREME_SHRINK_TRIGGER) {
    return {
      shrinkMode: 'extreme',
      overTarget,
      overMax,
      extraDisableTarget: Math.min(overTarget, 30),
      maxDisablePerRun: 30
    };
  }

  if (activeCount >= HARD_SHRINK_TRIGGER) {
    return {
      shrinkMode: 'hard',
      overTarget,
      overMax,
      extraDisableTarget: Math.min(overTarget, 22),
      maxDisablePerRun: 22
    };
  }

  if (activeCount >= 100) {
    return {
      shrinkMode: 'medium',
      overTarget,
      overMax,
      extraDisableTarget: Math.min(overTarget, 16),
      maxDisablePerRun: 16
    };
  }

  return {
    shrinkMode: 'soft',
    overTarget,
    overMax,
    extraDisableTarget: Math.min(overTarget, 10),
    maxDisablePerRun: 10
  };
}

function buildCombatReadiness({
  activeStrategyCount = 0,
  comparedCount = 0,
  reaperResult = {},
  spawnerResult = {},
  createdRemaining = 0
} = {}) {
  const readyFlags = {
    compare_running: comparedCount > 0,
    pool_below_max: activeStrategyCount <= MAX_ACTIVE_STRATEGY,
    pool_close_to_target: activeStrategyCount <= TARGET_ACTIVE_STRATEGY + 10,
    reaper_alive: Boolean(reaperResult?.ok),
    spawner_alive: Boolean(spawnerResult?.ok),
    created_pool_not_overloaded: createdRemaining < MAX_CREATED_PREDICTIONS
  };

  let phase = 'not_ready';
  let readyForFormal = false;
  let advice = '繼續縮池，先不要把正式下注當成穩定回本模式。';

  if (
    readyFlags.compare_running &&
    readyFlags.pool_below_max &&
    readyFlags.reaper_alive &&
    readyFlags.spawner_alive &&
    readyFlags.created_pool_not_overloaded
  ) {
    phase = 'watch';
    advice = '可小額觀察實戰，但仍以測試與監控為主。';
  }

  if (
    readyFlags.compare_running &&
    readyFlags.pool_close_to_target &&
    readyFlags.reaper_alive &&
    readyFlags.spawner_alive &&
    readyFlags.created_pool_not_overloaded
  ) {
    phase = 'near_ready';
    advice = '已接近正式下注門檻，可用固定四組四期做小額觀察。';
  }

  if (
    readyFlags.compare_running &&
    activeStrategyCount <= TARGET_ACTIVE_STRATEGY &&
    readyFlags.reaper_alive &&
    readyFlags.spawner_alive &&
    readyFlags.created_pool_not_overloaded
  ) {
    phase = 'ready';
    readyForFormal = true;
    advice = '已進入可正式上場區，但仍應控資金與追蹤 ROI。';
  }

  return {
    ready_for_formal: readyForFormal,
    phase,
    flags: readyFlags,
    advice
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
    .from(PREDICTIONS_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('status', 'created');

  if (error) throw error;
  return toNum(count, 0);
}

async function runCompare(db) {
  const { data: predictions, error: predError } = await db
    .from(PREDICTIONS_TABLE)
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
      .from(DRAWS_TABLE)
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
      .from(PREDICTIONS_TABLE)
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
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(MARKET_LOOKBACK_LIMIT);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function fetchStrategyCandidates(db, marketSnapshot = {}) {
  await ensureStrategyPoolStrategies();

  const { data: poolRows, error: poolError } = await db
    .from(STRATEGY_POOL_TABLE)
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
    .from(STRATEGY_STATS_TABLE)
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

function mergePoolWithStats(poolRows = [], statsRows = [], marketSnapshot = {}) {
  const statsMap = new Map(
    (Array.isArray(statsRows) ? statsRows : []).map((row) => [
      normalizeStrategyKey(row?.strategy_key),
      row
    ])
  );

  return (Array.isArray(poolRows) ? poolRows : []).map((row) => {
    const stat = statsMap.get(normalizeStrategyKey(row?.strategy_key)) || {};
    const evaluation = evaluateStrategyDecision(row, stat, marketSnapshot);

    return {
      ...row,
      stats: stat,
      decision: evaluation.decision,
      decision_rank: getDecisionRank(evaluation.decision),
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
}

async function runStrategyReaper(db, marketSnapshot = {}) {
  const { data: statsRows, error: statsError } = await db
    .from(STRATEGY_STATS_TABLE)
    .select('*');

  if (statsError) {
    throw new Error(`strategy_stats scan failed: ${statsError.message || statsError}`);
  }

  const poolRows = await getPoolRows(db);
  const activeRows = poolRows.filter(
    (row) => String(row?.status || '').toLowerCase() === 'active'
  );
  const activeCount = activeRows.length;
  const shrinkPlan = getShrinkPlan(activeCount);

  if (!activeRows.length) {
    return {
      ok: true,
      scanned: 0,
      active_count: 0,
      min_active_strategy: MIN_ACTIVE_STRATEGY,
      disabled_count: 0,
      disabled_keys: [],
      disabled_reason_map: {},
      skipped: true,
      reason: 'no_active_rows',
      shrink: {
        mode: shrinkPlan.shrinkMode,
        extra_disable_target: shrinkPlan.extraDisableTarget,
        max_disable_per_run: shrinkPlan.maxDisablePerRun
      }
    };
  }

  if (activeCount <= MIN_ACTIVE_STRATEGY) {
    return {
      ok: true,
      scanned: activeRows.length,
      active_count: activeCount,
      min_active_strategy: MIN_ACTIVE_STRATEGY,
      disabled_count: 0,
      disabled_keys: [],
      disabled_reason_map: {},
      skipped: true,
      reason: 'protect_min_active_strategy',
      shrink: {
        mode: shrinkPlan.shrinkMode,
        extra_disable_target: shrinkPlan.extraDisableTarget,
        max_disable_per_run: shrinkPlan.maxDisablePerRun
      }
    };
  }

  const activeKeys = activeRows
    .map((row) => normalizeStrategyKey(row?.strategy_key))
    .filter(Boolean);

  const activeStatsRows = (Array.isArray(statsRows) ? statsRows : []).filter((row) =>
    activeKeys.includes(normalizeStrategyKey(row?.strategy_key))
  );

  const mergedActiveRows = mergePoolWithStats(activeRows, activeStatsRows, marketSnapshot);

  const poolStatusMap = await getPoolStatusMap(
    db,
    mergedActiveRows.map((row) => String(row?.strategy_key || '').trim()).filter(Boolean)
  );

  const forcedDisableKeys = [];
  const forcedReasonMap = {};

  const shrinkCandidates = [];

  for (const row of mergedActiveRows) {
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

    const disableCheck = shouldDisableStrategy(row, activeCount);
    if (disableCheck.shouldDisable) {
      forcedDisableKeys.push(key);
      forcedReasonMap[key] = disableCheck.reason;
    }

    shrinkCandidates.push({
      ...row,
      protected_rank: Boolean(poolInfo.protected_rank)
    });
  }

  const extraShrinkPool = shrinkCandidates
    .filter((row) => !forcedDisableKeys.includes(String(row?.strategy_key || '').trim()))
    .filter((row) => !Boolean(row?.protected_rank))
    .filter((row) => {
      const decision = String(row?.decision || '').toLowerCase();

      if (shrinkPlan.shrinkMode === 'extreme') {
        return decision !== 'strong';
      }

      if (shrinkPlan.shrinkMode === 'hard') {
        return decision === 'reject' || decision === 'weak' || decision === 'candidate' || row.roi < 0;
      }

      if (shrinkPlan.shrinkMode === 'medium') {
        return decision === 'reject' || decision === 'weak' || decision === 'candidate';
      }

      if (shrinkPlan.shrinkMode === 'soft') {
        return decision === 'reject' || decision === 'weak';
      }

      return false;
    })
    .sort(byWeaknessDesc);

  const extraShrinkKeys = [];
  const extraReasonMap = {};

  for (const row of extraShrinkPool) {
    if (extraShrinkKeys.length >= shrinkPlan.extraDisableTarget) break;
    const key = String(row?.strategy_key || '').trim();
    if (!key) continue;

    extraShrinkKeys.push(key);
    extraReasonMap[key] = `c1_shrink_${shrinkPlan.shrinkMode}_pool_${activeCount}`;
  }

  const allPlannedKeys = [...new Set([...forcedDisableKeys, ...extraShrinkKeys])];

  const maxDisableAllowedByMinPool = Math.max(0, activeCount - MIN_ACTIVE_STRATEGY);
  const maxDisableAllowed = Math.min(maxDisableAllowedByMinPool, shrinkPlan.maxDisablePerRun);

  const finalDisableKeys = allPlannedKeys.slice(0, maxDisableAllowed);

  const finalReasonMap = {};
  for (const key of finalDisableKeys) {
    finalReasonMap[key] = forcedReasonMap[key] || extraReasonMap[key] || 'c1_shrink_disable';
  }

  let disableResult = {
    updated: 0,
    disabled_keys: [],
    disabled_reason_map: {}
  };

  if (finalDisableKeys.length > 0) {
    disableResult = await disableStrategies(db, finalDisableKeys, finalReasonMap);
  }

  return {
    ok: true,
    scanned: mergedActiveRows.length,
    active_count: activeCount,
    min_active_strategy: MIN_ACTIVE_STRATEGY,
    disabled_count: toNum(disableResult.updated, 0),
    disabled_keys: disableResult.disabled_keys || [],
    disabled_reason_map: disableResult.disabled_reason_map || {},
    skipped: false,
    shrink: {
      mode: shrinkPlan.shrinkMode,
      over_target: shrinkPlan.overTarget,
      over_max: shrinkPlan.overMax,
      extra_disable_target: shrinkPlan.extraDisableTarget,
      max_disable_per_run: shrinkPlan.maxDisablePerRun,
      forced_disable_count: forcedDisableKeys.length,
      extra_shrink_candidate_count: extraShrinkPool.length
    }
  };
}

async function runStrategySpawner(db, latestDrawNo = 0, marketSnapshot = {}) {
  const poolRows = await getPoolRows(db);

  const activeRows = poolRows.filter(
    (row) => String(row?.status || '').trim().toLowerCase() === 'active'
  );

  const activeCount = activeRows.length;
  const totalCount = poolRows.length;

  if (activeCount >= TARGET_ACTIVE_STRATEGY) {
    return {
      ok: true,
      active_count: activeCount,
      target_active_strategy: TARGET_ACTIVE_STRATEGY,
      max_active_strategy: MAX_ACTIVE_STRATEGY,
      spawned_count: 0,
      spawned_keys: [],
      skipped: true,
      reason: 'active_pool_is_enough'
    };
  }

  if (activeCount >= MAX_ACTIVE_STRATEGY) {
    return {
      ok: true,
      active_count: activeCount,
      target_active_strategy: TARGET_ACTIVE_STRATEGY,
      max_active_strategy: MAX_ACTIVE_STRATEGY,
      spawned_count: 0,
      spawned_keys: [],
      skipped: true,
      reason: 'active_pool_reached_max'
    };
  }

  const existingKeySet = new Set(
    poolRows
      .map((row) => normalizeStrategyKey(row?.strategy_key))
      .filter(Boolean)
  );

  const activeStrategyKeys = activeRows
    .map((row) => normalizeStrategyKey(row?.strategy_key))
    .filter(Boolean);

  let statsRows = [];
  if (activeStrategyKeys.length) {
    const { data, error } = await db
      .from(STRATEGY_STATS_TABLE)
      .select('*')
      .in('strategy_key', activeStrategyKeys);

    if (error) throw error;
    statsRows = Array.isArray(data) ? data : [];
  }

  const rankedActiveRows = mergePoolWithStats(activeRows, statsRows, marketSnapshot)
    .sort(byPowerDesc)
    .map((row) => ({
      ...row,
      eval: {
        decision: row.decision,
        decisionScore: row.decision_score,
        weight: row.weight,
        avgHit: row.avg_hit,
        roi: row.roi,
        score: row.score,
        totalRounds: row.total_rounds,
        marketBoost: row.market_boost
      }
    }));

  const strongParents = rankedActiveRows.slice(0, Math.max(6, Math.min(16, rankedActiveRows.length)));
  const needCount = Math.min(
    MAX_SPAWN_PER_RUN,
    TARGET_ACTIVE_STRATEGY - activeCount,
    MAX_ACTIVE_STRATEGY - activeCount
  );

  if (needCount <= 0) {
    return {
      ok: true,
      active_count: activeCount,
      target_active_strategy: TARGET_ACTIVE_STRATEGY,
      max_active_strategy: MAX_ACTIVE_STRATEGY,
      spawned_count: 0,
      spawned_keys: [],
      skipped: true,
      reason: 'spawn_need_is_zero'
    };
  }

  const insertList = [];
  let seq = 0;
  let guard = 0;

  while (insertList.length < needCount && guard < 400) {
    guard += 1;
    const parentA = strongParents[seq % strongParents.length] || rankedActiveRows[0] || null;
    const parentB = strongParents[(seq + 3) % strongParents.length] || rankedActiveRows[1] || parentA || null;

    if (!parentA) break;

    const sourceType = chooseSpawnSourceType(seq, activeCount);
    const mode =
      sourceType === 'exploration'
        ? 'exploration'
        : sourceType === 'crossover'
          ? 'crossover'
          : 'mutation';

    const childKey = buildChildStrategyKey(
      parentA?.strategy_key || '',
      parentB?.strategy_key || '',
      mode,
      seq
    );

    seq += 1;

    if (!childKey) continue;
    if (existingKeySet.has(childKey)) continue;

    existingKeySet.add(childKey);

    const genes = inferGenesFromStrategyKey(childKey);
    const parentKeys =
      sourceType === 'exploration'
        ? []
        : uniqueTokens([
            normalizeStrategyKey(parentA?.strategy_key),
            normalizeStrategyKey(parentB?.strategy_key)
          ]).slice(0, 2);

    const parentGeneration = Math.max(
      toNum(parentA?.generation, 1),
      toNum(parentB?.generation, 1),
      1
    );

    insertList.push({
      strategy_key: childKey,
      strategy_name: strategyLabel(childKey),
      gene_a: genes.gene_a,
      gene_b: genes.gene_b,
      parameters: {
        mode:
          sourceType === 'exploration'
            ? 'exploration_v6'
            : sourceType === 'crossover'
              ? 'crossover_v6'
              : 'evolution_v3',
        createdBy: 'auto_train_spawner',
        targetPool: TARGET_ACTIVE_STRATEGY
      },
      generation: sourceType === 'exploration' ? 1 : parentGeneration + 1,
      source_type: sourceType,
      parent_keys: parentKeys,
      status: 'active',
      protected_rank: false,
      incubation_until_draw: 0,
      created_draw_no: toNum(latestDrawNo, 0),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  if (insertList.length > 0) {
    const { error: insertError } = await db
      .from(STRATEGY_POOL_TABLE)
      .insert(insertList);

    if (insertError) {
      throw new Error(`strategy_pool spawn insert failed: ${insertError.message || insertError}`);
    }
  }

  return {
    ok: true,
    active_count: activeCount,
    total_count: totalCount,
    target_active_strategy: TARGET_ACTIVE_STRATEGY,
    max_active_strategy: MAX_ACTIVE_STRATEGY,
    spawned_count: insertList.length,
    spawned_keys: insertList.map((row) => row.strategy_key),
    skipped: false
  };
}

export default async function handler(req, res) {
  try {
    const db = getSupabase();

    await ensureStrategyPoolStrategies();

    const compareBeforeCreate = await runCompare(db);
    const catchup = await runCatchup(db);
    const sync = await runSync(db);

    const pipeline = {
      compare_before_create: compareBeforeCreate,
      catchup,
      sync
    };

    const { data: latestDrawRows, error: latestError } = await db
      .from(DRAWS_TABLE)
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(1);

    if (latestError) throw latestError;

    if (!latestDrawRows || !latestDrawRows.length) {
      const reaperResult = await runStrategyReaper(db, {});
      const spawnerResult = await runStrategySpawner(db, 0, {});
      const createdRemainingNoDraw = await countCreatedPredictions(db);
      const activeStrategyCountNoDraw = await countActiveStrategies(db);
      const combatReadinessNoDraw = buildCombatReadiness({
        activeStrategyCount: activeStrategyCountNoDraw,
        comparedCount: toNum(compareBeforeCreate?.processed, 0),
        reaperResult,
        spawnerResult,
        createdRemaining: createdRemainingNoDraw
      });

      return res.status(200).json({
        ok: true,
        compare_modes: [...COMPARE_MODES],
        pipeline: {
          ...pipeline,
          reaper: reaperResult,
          spawner: spawnerResult
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
        created_current_open_count: createdRemainingNoDraw,
        active_strategy_count: activeStrategyCountNoDraw,
        disabled_keys: reaperResult.disabled_keys || [],
        spawned_keys: spawnerResult.spawned_keys || [],
        active_created_prediction: null,
        combat_readiness: combatReadinessNoDraw,
        pool_control: {
          min_active_strategy: MIN_ACTIVE_STRATEGY,
          target_active_strategy: TARGET_ACTIVE_STRATEGY,
          max_active_strategy: MAX_ACTIVE_STRATEGY,
          max_spawn_per_run: MAX_SPAWN_PER_RUN,
          soft_shrink_trigger: SOFT_SHRINK_TRIGGER,
          hard_shrink_trigger: HARD_SHRINK_TRIGGER,
          extreme_shrink_trigger: EXTREME_SHRINK_TRIGGER
        },
        train: {
          ok: true,
          skipped: true,
          reason: 'No bingo_draws'
        }
      });
    }

    const latestDraw = latestDrawRows[0];
    const latestDrawNo = toNum(latestDraw?.draw_no, 0);

    // 即時型手動下注模式：直接使用最新一期當 source
    const sourceDrawNoRaw = latestDrawNo;

    if (sourceDrawNoRaw <= 0) {
      const reaperResult = await runStrategyReaper(db, {});
      const spawnerResult = await runStrategySpawner(db, latestDrawNo, {});
      const createdRemainingSmallDraw = await countCreatedPredictions(db);
      const activeStrategyCountSmallDraw = await countActiveStrategies(db);
      const combatReadinessSmallDraw = buildCombatReadiness({
        activeStrategyCount: activeStrategyCountSmallDraw,
        comparedCount: toNum(compareBeforeCreate?.processed, 0),
        reaperResult,
        spawnerResult,
        createdRemaining: createdRemainingSmallDraw
      });

      return res.status(200).json({
        ok: true,
        compare_modes: [...COMPARE_MODES],
        pipeline: {
          ...pipeline,
          reaper: reaperResult,
          spawner: spawnerResult
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
        created_current_open_count: createdRemainingSmallDraw,
        active_strategy_count: activeStrategyCountSmallDraw,
        disabled_keys: reaperResult.disabled_keys || [],
        spawned_keys: spawnerResult.spawned_keys || [],
        active_created_prediction: null,
        combat_readiness: combatReadinessSmallDraw,
        pool_control: {
          min_active_strategy: MIN_ACTIVE_STRATEGY,
          target_active_strategy: TARGET_ACTIVE_STRATEGY,
          max_active_strategy: MAX_ACTIVE_STRATEGY,
          max_spawn_per_run: MAX_SPAWN_PER_RUN,
          soft_shrink_trigger: SOFT_SHRINK_TRIGGER,
          hard_shrink_trigger: HARD_SHRINK_TRIGGER,
          extreme_shrink_trigger: EXTREME_SHRINK_TRIGGER
        },
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
    const shouldCreatePrediction = createdNowCount < MAX_CREATED_PREDICTIONS;

    if (shouldCreatePrediction) {
      const { data: existingPrediction, error: existingError } = await db
        .from(PREDICTIONS_TABLE)
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
          .from(PREDICTIONS_TABLE)
          .insert(payload)
          .select('*')
          .single();

        if (insertError) {
          if (isDuplicateDrawModeError(insertError)) {
            const { data: existingAfterDup } = await db
              .from(PREDICTIONS_TABLE)
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

    const effectiveMarketSnapshot = marketSnapshot || normalizeMarketSnapshot(
      buildRecentMarketSignalSnapshot(await fetchMarketRows(db), 'numbers')
    );

    const reaperResult = await runStrategyReaper(db, effectiveMarketSnapshot);
    pipeline.reaper = reaperResult;

    const spawnerResult = await runStrategySpawner(db, latestDrawNo, effectiveMarketSnapshot);
    pipeline.spawner = spawnerResult;

    let finalActiveCreatedPrediction = activeCreatedPrediction;

    if (finalActiveCreatedPrediction?.id) {
      const { data: refreshedPrediction } = await db
        .from(PREDICTIONS_TABLE)
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
    const activeStrategyCount = await countActiveStrategies(db);

    const combatReadiness = buildCombatReadiness({
      activeStrategyCount,
      comparedCount: comparedBefore + comparedAfter,
      reaperResult,
      spawnerResult,
      createdRemaining
    });

    return res.status(200).json({
      ok: true,
      compare_modes: [...COMPARE_MODES],
      pipeline,
      market_snapshot: effectiveMarketSnapshot,
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
      active_strategy_count: activeStrategyCount,
      disabled_keys: [...new Set(disabledKeys)],
      spawned_keys: Array.isArray(spawnerResult?.spawned_keys) ? spawnerResult.spawned_keys : [],
      active_created_prediction: finalActiveCreatedPrediction,
      combat_readiness: combatReadiness,
      pool_control: {
        min_active_strategy: MIN_ACTIVE_STRATEGY,
        target_active_strategy: TARGET_ACTIVE_STRATEGY,
        max_active_strategy: MAX_ACTIVE_STRATEGY,
        max_spawn_per_run: MAX_SPAWN_PER_RUN,
        soft_shrink_trigger: SOFT_SHRINK_TRIGGER,
        hard_shrink_trigger: HARD_SHRINK_TRIGGER,
        extreme_shrink_trigger: EXTREME_SHRINK_TRIGGER
      },
      train: {
        ok: true,
        skipped: createdCount === 0,
        reason: createdCount > 0 ? '' : 'already_exists_or_pool_limit',
        mode: TEST_MODE,
        source_draw_no: sourceDrawNo,
        latest_draw_no: latestDrawNo,
        target_periods: TARGET_PERIODS
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'auto-train failed'
    });
  }
}
