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

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
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

function safeArray(value) {
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

function normalizeHitRate(raw) {
  const value = toNum(raw, 0);
  if (value <= 0) return 0;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return 1;
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

function normalizeMode(rawMode = '') {
  const mode = String(rawMode || '').trim().toLowerCase();
  if (mode === 'formal_synced_from_server_prediction') return FORMAL_MODE;
  if (mode === TEST_MODE || mode === FORMAL_MODE) return mode;
  return TEST_MODE;
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
    toNum(a.hit3_rate, 0) - toNum(b.hit3_rate, 0) ||
    toNum(a.recent_50_hit3_rate, 0) - toNum(b.recent_50_hit3_rate, 0) ||
    toNum(a.hit4_rate, 0) - toNum(b.hit4_rate, 0) ||
    toNum(a.roi, 0) - toNum(b.roi, 0) ||
    toNum(a.score, 0) - toNum(b.score, 0) ||
    toNum(a.decision_score, 0) - toNum(b.decision_score, 0) ||
    toNum(a.weight, 0) - toNum(b.weight, 0) ||
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

async function getLatestDrawRows(db, limit = MARKET_LOOKBACK_LIMIT) {
  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function getShrinkPlan(activeCount = 0) {
  if (activeCount <= MAX_ACTIVE_STRATEGY) {
    return {
      shrinkMode: 'off',
      overTarget: Math.max(0, activeCount - TARGET_ACTIVE_STRATEGY),
      overMax: 0,
      extraDisableTarget: 0,
      maxDisablePerRun: 0
    };
  }

  if (activeCount >= EXTREME_SHRINK_TRIGGER) {
    const overTarget = Math.max(0, activeCount - TARGET_ACTIVE_STRATEGY);
    return {
      shrinkMode: 'extreme',
      overTarget,
      overMax: Math.max(0, activeCount - MAX_ACTIVE_STRATEGY),
      extraDisableTarget: overTarget,
      maxDisablePerRun: Math.max(10, Math.min(30, overTarget))
    };
  }

  if (activeCount >= HARD_SHRINK_TRIGGER) {
    const overTarget = Math.max(0, activeCount - TARGET_ACTIVE_STRATEGY);
    return {
      shrinkMode: 'hard',
      overTarget,
      overMax: Math.max(0, activeCount - MAX_ACTIVE_STRATEGY),
      extraDisableTarget: Math.max(8, Math.min(overTarget, 20)),
      maxDisablePerRun: Math.max(8, Math.min(20, overTarget))
    };
  }

  if (activeCount >= SOFT_SHRINK_TRIGGER) {
    const overTarget = Math.max(0, activeCount - TARGET_ACTIVE_STRATEGY);
    return {
      shrinkMode: 'soft',
      overTarget,
      overMax: Math.max(0, activeCount - MAX_ACTIVE_STRATEGY),
      extraDisableTarget: Math.max(1, overTarget),
      maxDisablePerRun: Math.max(4, Math.min(12, overTarget))
    };
  }

  return {
    shrinkMode: 'off',
    overTarget: 0,
    overMax: 0,
    extraDisableTarget: 0,
    maxDisablePerRun: 0
  };
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

    const hit2 = toNum(stat?.hit2, 0);
    const hit3 = toNum(stat?.hit3, 0);
    const hit4 = toNum(stat?.hit4, 0);
    const totalRoundsBase = Math.max(1, toNum(evaluation.totalRounds, 0));
    const hit2Rate = toNum(stat?.hit2_rate, hit2 / totalRoundsBase);
    const hit3Rate = toNum(stat?.hit3_rate, hit3 / totalRoundsBase);
    const hit4Rate = toNum(stat?.hit4_rate, hit4 / totalRoundsBase);
    const recent50Hit3Rate = normalizeHitRate(stat?.recent_50_hit3_rate);
    const recent50Hit4Rate = normalizeHitRate(stat?.recent_50_hit4_rate);

    let strategyTier = 'simulate';

    if (evaluation.decision === 'reject') {
      strategyTier = 'forbidden';
    } else if (hit4 > 0 || hit4Rate >= 0.03) {
      strategyTier = 'burst';
    } else if (hit3 >= 2 || hit3Rate >= 0.12 || evaluation.recent50Roi > 0) {
      strategyTier = 'core';
    } else if (evaluation.decision === 'strong' || evaluation.decision === 'usable') {
      strategyTier = 'balanced';
    } else {
      strategyTier = 'safe';
    }

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
      recent_50_hit3_rate: recent50Hit3Rate,
      recent_50_hit4_rate: recent50Hit4Rate,
      market_boost: evaluation.marketBoost,
      market_reason: evaluation.marketReason,
      decision_score: evaluation.decisionScore,
      hit2,
      hit3,
      hit4,
      hit2_rate: hit2Rate,
      hit3_rate: hit3Rate,
      hit4_rate: hit4Rate,
      strategy_tier: strategyTier
    };
  });
}

function buildFormalRank(row = {}) {
  return [
    toNum(row.hit3_rate, 0),
    toNum(row.recent_50_hit3_rate, 0),
    toNum(row.hit4_rate, 0),
    toNum(row.roi, 0),
    toNum(row.score, 0),
    toNum(row.decision_score, 0),
    toNum(row.weight, 0)
  ];
}

function compareRankTupleDesc(aTuple = [], bTuple = []) {
  const size = Math.max(aTuple.length, bTuple.length);
  for (let i = 0; i < size; i += 1) {
    const diff = toNum(bTuple[i], 0) - toNum(aTuple[i], 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sortByFormalSelection(a, b) {
  return (
    compareRankTupleDesc(buildFormalRank(a), buildFormalRank(b)) ||
    toNum(b.market_boost, 1) - toNum(a.market_boost, 1) ||
    String(a.strategy_key).localeCompare(String(b.strategy_key))
  );
}

function sortByForcedShrink(a, b) {
  return (
    toNum(a.hit3_rate, 0) - toNum(b.hit3_rate, 0) ||
    toNum(a.recent_50_hit3_rate, 0) - toNum(b.recent_50_hit3_rate, 0) ||
    toNum(a.hit4_rate, 0) - toNum(b.hit4_rate, 0) ||
    toNum(a.roi, 0) - toNum(b.roi, 0) ||
    toNum(a.score, 0) - toNum(b.score, 0) ||
    toNum(a.decision_score, 0) - toNum(b.decision_score, 0) ||
    toNum(a.weight, 0) - toNum(b.weight, 0) ||
    String(a.strategy_key).localeCompare(String(b.strategy_key))
  );
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
        over_target: shrinkPlan.overTarget,
        over_max: shrinkPlan.overMax,
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
        over_target: shrinkPlan.overTarget,
        over_max: shrinkPlan.overMax,
        extra_disable_target: shrinkPlan.extraDisableTarget,
        max_disable_per_run: shrinkPlan.maxDisablePerRun
      }
    };
  }

  if (shrinkPlan.shrinkMode === 'off' || shrinkPlan.extraDisableTarget <= 0) {
    return {
      ok: true,
      scanned: activeRows.length,
      active_count: activeCount,
      min_active_strategy: MIN_ACTIVE_STRATEGY,
      disabled_count: 0,
      disabled_keys: [],
      disabled_reason_map: {},
      skipped: true,
      reason: 'shrink_not_required',
      shrink: {
        mode: shrinkPlan.shrinkMode,
        over_target: shrinkPlan.overTarget,
        over_max: shrinkPlan.overMax,
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

  const extraShrinkPool = mergedActiveRows
    .filter((row) => {
      const key = String(row?.strategy_key || '').trim();
      if (!key) return false;

      const poolInfo = poolStatusMap.get(key) || {
        status: '',
        protected_rank: false
      };

      const currentStatus = String(poolInfo.status || '').trim().toLowerCase();

      if (poolInfo.protected_rank || PROTECTED_STATUS.has(currentStatus)) return false;
      if (TERMINAL_STATUS.has(currentStatus)) return false;

      return true;
    })
    .sort(sortByForcedShrink);

  const extraShrinkKeys = [];
  const extraReasonMap = {};

  for (const row of extraShrinkPool) {
    if (extraShrinkKeys.length >= shrinkPlan.extraDisableTarget) break;
    const key = String(row?.strategy_key || '').trim();
    if (!key) continue;

    extraShrinkKeys.push(key);
    extraReasonMap[key] =
      `forced_shrink_${shrinkPlan.shrinkMode}` +
      `_hit3_${round4(row.hit3_rate)}` +
      `_recentHit3_${round4(row.recent_50_hit3_rate)}` +
      `_hit4_${round4(row.hit4_rate)}` +
      `_roi_${round4(row.roi)}`;
  }

  const maxDisableAllowedByMinPool = Math.max(0, activeCount - MIN_ACTIVE_STRATEGY);
  const maxDisableAllowed = Math.min(maxDisableAllowedByMinPool, shrinkPlan.maxDisablePerRun);
  const finalDisableKeys = extraShrinkKeys.slice(0, maxDisableAllowed);

  let disableResult = {
    updated: 0,
    disabled_keys: [],
    disabled_reason_map: {}
  };

  if (finalDisableKeys.length > 0) {
    const finalReasonMap = {};
    for (const key of finalDisableKeys) {
      finalReasonMap[key] = extraReasonMap[key] || 'forced_shrink_disable';
    }

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
      candidate_count: extraShrinkPool.length
    }
  };
}

async function runStrategySpawner(db, latestDrawNo = 0, marketSnapshot = {}) {
  const poolRows = await getPoolRows(db);

  const activeRows = poolRows.filter(
    (row) => String(row?.status || '').trim().toLowerCase() === 'active'
  );

  const activeCount = activeRows.length;

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

  const { data: statsRows, error: statsError } = await db
    .from(STRATEGY_STATS_TABLE)
    .select('*');

  if (statsError) {
    throw new Error(`strategy_stats scan failed for spawn: ${statsError.message || statsError}`);
  }

  const merged = mergePoolWithStats(activeRows, statsRows || [], marketSnapshot);
  const powerRows = [...merged].sort(byPowerDesc);

  const parentA = powerRows[0] || null;
  const parentB = powerRows[1] || powerRows[0] || null;

  const spawnTarget = Math.max(
    0,
    Math.min(MAX_SPAWN_PER_RUN, TARGET_ACTIVE_STRATEGY - activeCount)
  );

  if (spawnTarget <= 0) {
    return {
      ok: true,
      active_count: activeCount,
      target_active_strategy: TARGET_ACTIVE_STRATEGY,
      max_active_strategy: MAX_ACTIVE_STRATEGY,
      spawned_count: 0,
      spawned_keys: [],
      skipped: true,
      reason: 'spawn_target_zero'
    };
  }

  const insertRows = [];
  const spawnedKeys = [];
  const nowIso = new Date().toISOString();

  for (let i = 0; i < spawnTarget; i += 1) {
    const sourceType = chooseSpawnSourceType(i, activeCount);

    let childKey = '';
    if (sourceType === 'exploration') {
      childKey = buildChildStrategyKey('', '', 'exploration', i + latestDrawNo);
    } else if (sourceType === 'crossover') {
      childKey = buildChildStrategyKey(
        parentA?.strategy_key || 'mix_balanced',
        parentB?.strategy_key || 'hot_zone',
        'crossover',
        i + latestDrawNo
      );
    } else {
      childKey = buildChildStrategyKey(
        parentA?.strategy_key || 'mix_balanced',
        '',
        'mutation',
        i + latestDrawNo
      );
    }

    childKey = normalizeStrategyKey(childKey);
    if (!childKey) continue;
    if (existingKeySet.has(childKey)) continue;

    existingKeySet.add(childKey);
    spawnedKeys.push(childKey);

    const genes = inferGenesFromStrategyKey(childKey);

    insertRows.push({
      strategy_key: childKey,
      strategy_name: strategyLabel(childKey),
      gene_a: genes.gene_a,
      gene_b: genes.gene_b,
      parameters: {
        source_type: sourceType,
        parent_a: parentA?.strategy_key || null,
        parent_b: parentB?.strategy_key || null
      },
      generation: Math.max(
        1,
        toNum(parentA?.generation, 1),
        toNum(parentB?.generation, 1)
      ) + 1,
      source_type: sourceType,
      parent_keys: [
        parentA?.strategy_key || null,
        parentB?.strategy_key || null
      ].filter(Boolean),
      status: 'active',
      protected_rank: false,
      incubation_until_draw: latestDrawNo + 1,
      created_draw_no: latestDrawNo,
      created_at: nowIso,
      updated_at: nowIso
    });
  }

  if (insertRows.length > 0) {
    const { error: insertError } = await db
      .from(STRATEGY_POOL_TABLE)
      .insert(insertRows);

    if (insertError) {
      throw new Error(`strategy_pool spawn insert failed: ${insertError.message || insertError}`);
    }
  }

  return {
    ok: true,
    active_count: activeCount,
    target_active_strategy: TARGET_ACTIVE_STRATEGY,
    max_active_strategy: MAX_ACTIVE_STRATEGY,
    spawned_count: insertRows.length,
    spawned_keys: spawnedKeys,
    skipped: false
  };
}

function normalizePredictionGroups(groups = []) {
  return (Array.isArray(groups) ? groups : [])
    .map((group, idx) => {
      if (!group || typeof group !== 'object') return null;

      const numsSource = Array.isArray(group.nums)
        ? group.nums
        : Array.isArray(group.numbers)
          ? group.numbers
          : Array.isArray(group.values)
            ? group.values
            : [];

      const nums = uniqueSorted(numsSource).slice(0, 4);
      if (nums.length !== 4) return null;

      const meta = group.meta && typeof group.meta === 'object' ? group.meta : {};

      return {
        key: String(group.key || meta.strategy_key || `group_${idx + 1}`),
        label: String(group.label || meta.strategy_name || `第${idx + 1}組`),
        nums,
        meta: {
          ...meta,
          strategy_key: String(meta.strategy_key || group.key || `group_${idx + 1}`),
          strategy_name: String(meta.strategy_name || group.label || `第${idx + 1}組`)
        }
      };
    })
    .filter(Boolean);
}

function buildFormalGroups(mergedRows = [], market = {}, latestDrawNo = 0) {
  const strong = mergedRows.filter((row) => row.decision === 'strong').sort(sortByFormalSelection);
  const usable = mergedRows.filter((row) => row.decision === 'usable').sort(sortByFormalSelection);
  const candidate = mergedRows.filter((row) => row.decision === 'candidate').sort(sortByFormalSelection);
  const weak = mergedRows.filter((row) => row.decision === 'weak').sort(sortByFormalSelection);
  const reject = mergedRows.filter((row) => row.decision === 'reject').sort(sortByFormalSelection);

  let finalRows = [...strong, ...usable, ...candidate];
  if (finalRows.length < BET_GROUP_COUNT) finalRows = [...finalRows, ...weak];
  if (finalRows.length < BET_GROUP_COUNT) finalRows = [...finalRows, ...reject];

  finalRows = finalRows
    .filter((row) => toNum(row.weight, 0) > 0)
    .slice(0, BET_GROUP_COUNT);

  return finalRows.map((row, idx) => ({
    key: String(row.strategy_key),
    label: String(row.strategy_name || strategyLabel(row.strategy_key)),
    nums: buildStrategyNums(row.strategy_key, market, latestDrawNo + idx + 11),
    meta: {
      strategy_key: String(row.strategy_key),
      strategy_name: String(row.strategy_name || strategyLabel(row.strategy_key)),
      strategy_tier: row.strategy_tier || 'formal',
      decision: row.decision,
      decision_score: round4(row.decision_score),
      market_boost: round4(row.market_boost),
      market_reason: row.market_reason || '',
      hit2: toNum(row.hit2, 0),
      hit3: toNum(row.hit3, 0),
      hit4: toNum(row.hit4, 0),
      hit2_rate: round4(row.hit2_rate),
      hit3_rate: round4(row.hit3_rate),
      hit4_rate: round4(row.hit4_rate),
      recent_50_hit3_rate: round4(row.recent_50_hit3_rate),
      recent_50_hit4_rate: round4(row.recent_50_hit4_rate),
      roi: round4(row.roi),
      avg_hit: round4(row.avg_hit),
      score: round4(row.score),
      reason: 'formal_top_ranked_by_hit3_recent_hit3_hit4_roi'
    }
  }));
}

function buildTestGroups(mergedRows = [], market = {}, latestDrawNo = 0) {
  const rows = [...mergedRows].sort(byPowerDesc);

  const explorationRows = [];
  const primaryRows = [];

  for (const row of rows) {
    if (row.decision === 'reject') continue;
    if (explorationRows.length < 2 && (row.decision === 'candidate' || row.decision === 'weak')) {
      explorationRows.push(row);
      continue;
    }
    if (primaryRows.length < BET_GROUP_COUNT) {
      primaryRows.push(row);
    }
    if (primaryRows.length >= BET_GROUP_COUNT) break;
  }

  let finalRows = [...primaryRows];

  for (const row of explorationRows) {
    if (finalRows.length >= BET_GROUP_COUNT) break;
    if (!finalRows.find((x) => x.strategy_key === row.strategy_key)) {
      finalRows.push(row);
    }
  }

  finalRows = finalRows.slice(0, BET_GROUP_COUNT);

  return finalRows.map((row, idx) => ({
    key: String(row.strategy_key),
    label: String(row.strategy_name || strategyLabel(row.strategy_key)),
    nums: buildStrategyNums(row.strategy_key, market, latestDrawNo + idx + 101),
    meta: {
      strategy_key: String(row.strategy_key),
      strategy_name: String(row.strategy_name || strategyLabel(row.strategy_key)),
      strategy_tier: row.strategy_tier || 'test',
      decision: row.decision,
      decision_score: round4(row.decision_score),
      market_boost: round4(row.market_boost),
      market_reason: row.market_reason || '',
      hit2: toNum(row.hit2, 0),
      hit3: toNum(row.hit3, 0),
      hit4: toNum(row.hit4, 0),
      hit2_rate: round4(row.hit2_rate),
      hit3_rate: round4(row.hit3_rate),
      hit4_rate: round4(row.hit4_rate),
      recent_50_hit3_rate: round4(row.recent_50_hit3_rate),
      recent_50_hit4_rate: round4(row.recent_50_hit4_rate),
      roi: round4(row.roi),
      avg_hit: round4(row.avg_hit),
      score: round4(row.score),
      reason: 'test_mix_of_power_and_exploration'
    }
  }));
}

async function buildPredictionGroupsByMode(db, mode, latestDrawNo = 0, marketSnapshot = {}) {
  const { data: poolRows, error: poolError } = await db
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active');

  if (poolError) {
    throw new Error(`strategy_pool active select failed: ${poolError.message || poolError}`);
  }

  if (!Array.isArray(poolRows) || !poolRows.length) {
    throw new Error('No active strategy_pool rows');
  }

  const strategyKeys = poolRows
    .map((row) => normalizeStrategyKey(row?.strategy_key))
    .filter(Boolean);

  const { data: statsRows, error: statsError } = await db
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .in('strategy_key', strategyKeys);

  if (statsError) {
    throw new Error(`strategy_stats select failed: ${statsError.message || statsError}`);
  }

  const marketRows = await getLatestDrawRows(db, MARKET_LOOKBACK_LIMIT);
  const market = buildMarketState(marketRows);
  const merged = mergePoolWithStats(poolRows || [], statsRows || [], marketSnapshot);

  let groups = [];
  if (normalizeMode(mode) === FORMAL_MODE) {
    groups = buildFormalGroups(merged, market, latestDrawNo);
  } else {
    groups = buildTestGroups(merged, market, latestDrawNo);
  }

  const normalizedGroups = normalizePredictionGroups(groups);

  if (!normalizedGroups.length) {
    throw new Error(`No prediction groups built for mode=${mode}`);
  }

  return normalizedGroups;
}

async function createPredictionRow(db, payload = {}) {
  const nowIso = new Date().toISOString();
  const insertPayload = {
    draw_no: toNum(payload.draw_no, 0),
    mode: normalizeMode(payload.mode),
    groups: payload.groups || [],
    group_count: toNum(payload.group_count, BET_GROUP_COUNT),
    target_periods: toNum(payload.target_periods, TARGET_PERIODS),
    cost_per_group_per_period: toNum(payload.cost_per_group_per_period, COST_PER_GROUP_PER_PERIOD),
    total_cost: toNum(payload.total_cost, 0),
    compare_status: 'pending',
    compare_result: null,
    total_hit: null,
    total_reward: null,
    total_profit: null,
    roi: null,
    created_at: nowIso,
    updated_at: nowIso
  };

  const { data, error } = await db
    .from(PREDICTIONS_TABLE)
    .insert(insertPayload)
    .select('*')
    .single();

  if (error) {
    if (isDuplicateDrawModeError(error)) {
      const { data: existing, error: fetchError } = await db
        .from(PREDICTIONS_TABLE)
        .select('*')
        .eq('draw_no', insertPayload.draw_no)
        .eq('mode', insertPayload.mode)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchError) {
        throw new Error(`prediction duplicate fetch failed: ${fetchError.message || fetchError}`);
      }

      return {
        created: false,
        duplicate: true,
        row: existing || null
      };
    }

    throw new Error(`prediction insert failed: ${error.message || error}`);
  }

  return {
    created: true,
    duplicate: false,
    row: data || null
  };
}

async function runPredictionCreator(db, latestDrawNo = 0, marketSnapshot = {}) {
  const targetDrawNo = latestDrawNo + 1;

  const { data: existingRows, error: existingError } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('draw_no', targetDrawNo)
    .in('mode', COMPARE_MODES)
    .order('created_at', { ascending: false })
    .limit(MAX_CREATED_PREDICTIONS);

  if (existingError) {
    throw new Error(`prediction existing scan failed: ${existingError.message || existingError}`);
  }

  const existingByMode = new Map();
  for (const row of existingRows || []) {
    const mode = normalizeMode(row?.mode);
    if (!existingByMode.has(mode)) {
      existingByMode.set(mode, row);
    }
  }

  const createdRows = [];
  const skippedModes = [];

  for (const mode of COMPARE_MODES) {
    if (!ALLOW_CREATE_WHEN_EXISTING && existingByMode.has(mode)) {
      skippedModes.push(mode);
      continue;
    }

    if (existingByMode.has(mode)) {
      skippedModes.push(mode);
      continue;
    }

    const groups = await buildPredictionGroupsByMode(db, mode, latestDrawNo, marketSnapshot);
    const totalCost = BET_GROUP_COUNT * TARGET_PERIODS * COST_PER_GROUP_PER_PERIOD;

    const createResult = await createPredictionRow(db, {
      draw_no: targetDrawNo,
      mode,
      groups,
      group_count: BET_GROUP_COUNT,
      target_periods: TARGET_PERIODS,
      cost_per_group_per_period: COST_PER_GROUP_PER_PERIOD,
      total_cost: totalCost
    });

    if (createResult.row) {
      createdRows.push(createResult.row);
    }
  }

  return {
    ok: true,
    target_draw_no: targetDrawNo,
    created_count: createdRows.length,
    created_modes: createdRows.map((row) => normalizeMode(row?.mode)),
    skipped_modes: skippedModes,
    created_rows: createdRows
  };
}

async function comparePredictionRow(db, predictionRow, drawRows = []) {
  const rowId = predictionRow?.id;
  const mode = normalizeMode(predictionRow?.mode);
  const drawNo = toNum(predictionRow?.draw_no, 0);

  const rawGroups = predictionRow?.groups ?? predictionRow?.prediction_groups ?? predictionRow?.numbers ?? [];
  const groups = normalizePredictionGroups(
    Array.isArray(rawGroups) ? rawGroups : safeArray(rawGroups)
  );

  const safeDrawRows = (Array.isArray(drawRows) ? drawRows : []).filter(
    (row) => toNum(row?.draw_no, 0) === drawNo
  );

  if (!groups.length || !safeDrawRows.length) {
    return {
      ok: false,
      mode,
      prediction_id: rowId || null,
      draw_no: drawNo,
      skipped: true,
      reason: !groups.length ? 'invalid_groups' : 'draw_not_found'
    };
  }

  const comparePayload = buildComparePayload({
    groups,
    drawRows: safeDrawRows,
    costPerGroupPerPeriod: toNum(predictionRow?.cost_per_group_per_period, COST_PER_GROUP_PER_PERIOD)
  });

  const compareResult = comparePayload?.compareResult || {
    detail: [],
    draw_detail: [],
    strategy_detail: [],
    total_hit: 0,
    total_cost: 0,
    total_reward: 0,
    total_profit: 0,
    roi: 0
  };

  await recordStrategyCompareResult(compareResult);

  const nowIso = new Date().toISOString();
  const updatePayload = {
    compare_status: 'done',
    compare_result: compareResult,
    total_hit: toNum(compareResult?.total_hit, 0),
    total_cost: toNum(compareResult?.total_cost, 0),
    total_reward: toNum(compareResult?.total_reward, 0),
    total_profit: toNum(compareResult?.total_profit, 0),
    roi: round4(compareResult?.roi),
    compared_at: nowIso,
    updated_at: nowIso
  };

  const { error: updateError } = await db
    .from(PREDICTIONS_TABLE)
    .update(updatePayload)
    .eq('id', rowId);

  if (updateError) {
    throw new Error(`prediction compare update failed: ${updateError.message || updateError}`);
  }

  return {
    ok: true,
    mode,
    prediction_id: rowId || null,
    draw_no: drawNo,
    skipped: false,
    total_hit: updatePayload.total_hit,
    total_cost: updatePayload.total_cost,
    total_reward: updatePayload.total_reward,
    total_profit: updatePayload.total_profit,
    roi: updatePayload.roi
  };
}

async function runCompareByMode(db, mode, availableDrawRows = []) {
  const latestDrawNo = Math.max(
    0,
    ...(Array.isArray(availableDrawRows) ? availableDrawRows : []).map((row) => toNum(row?.draw_no, 0))
  );

  const { data: predictionRows, error: predictionError } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', normalizeMode(mode))
    .lte('draw_no', latestDrawNo)
    .or('compare_status.is.null,compare_status.eq.pending')
    .order('draw_no', { ascending: true })
    .limit(COMPARE_BATCH_LIMIT);

  if (predictionError) {
    throw new Error(`prediction compare scan failed: ${predictionError.message || predictionError}`);
  }

  if (!Array.isArray(predictionRows) || !predictionRows.length) {
    return {
      ok: true,
      processed: 0,
      waiting: 0,
      mode: normalizeMode(mode),
      results: []
    };
  }

  const results = [];
  let processed = 0;
  let waiting = 0;

  for (const row of predictionRows) {
    const drawNo = toNum(row?.draw_no, 0);
    const matchedDrawRows = availableDrawRows.filter((draw) => toNum(draw?.draw_no, 0) === drawNo);

    if (!matchedDrawRows.length) {
      waiting += 1;
      continue;
    }

    const compareResult = await comparePredictionRow(db, row, matchedDrawRows);
    results.push(compareResult);
    if (!compareResult.skipped) processed += 1;
  }

  return {
    ok: true,
    processed,
    waiting,
    mode: normalizeMode(mode),
    results
  };
}

async function runCompareAllModes(db) {
  const latestDrawRows = await getLatestDrawRows(db, COMPARE_BATCH_LIMIT);

  const summary = {
    ok: true,
    processed: 0,
    waiting: 0,
    processed_by_mode: {},
    waiting_by_mode: {},
    total_candidates: 0,
    compare_modes: [...COMPARE_MODES]
  };

  for (const mode of COMPARE_MODES) {
    const result = await runCompareByMode(db, mode, latestDrawRows);
    summary.processed += toNum(result.processed, 0);
    summary.waiting += toNum(result.waiting, 0);
    summary.processed_by_mode[mode] = toNum(result.processed, 0);
    summary.waiting_by_mode[mode] = toNum(result.waiting, 0);
    summary.total_candidates += (result.results || []).length + toNum(result.waiting, 0);
  }

  return summary;
}

async function runMarketSnapshot(db) {
  try {
    const rows = await getLatestDrawRows(db, MARKET_LOOKBACK_LIMIT);
    const latestDrawNo = toNum(rows?.[0]?.draw_no, 0);

    let marketSnapshot = {};
    try {
      const rawSnapshot = await buildRecentMarketSignalSnapshot(rows);
      marketSnapshot = normalizeMarketSnapshot(rawSnapshot || {});
    } catch {
      marketSnapshot = normalizeMarketSnapshot({});
    }

    return {
      ok: true,
      latest_draw_no: latestDrawNo,
      rows,
      market_snapshot: marketSnapshot
    };
  } catch (error) {
    return {
      ok: false,
      latest_draw_no: 0,
      rows: [],
      market_snapshot: normalizeMarketSnapshot({}),
      error: error?.message || String(error)
    };
  }
}

function toHttpMethod(req) {
  return String(req?.method || 'GET').toUpperCase();
}

function allowWrite(method = 'GET') {
  return method === 'GET' || method === 'POST';
}

export default async function handler(req, res) {
  const method = toHttpMethod(req);

  if (!allowWrite(method)) {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const db = getSupabase();

    const ensureResult = await ensureStrategyPoolStrategies();
    const marketInfo = await runMarketSnapshot(db);

    const compareBeforeCreate = await runCompareAllModes(db);

    const catchup = {
      ok: true
    };

    const sync = {
      ok: true,
      latest_draw_no: marketInfo.latest_draw_no,
      active_count_before: await countActiveStrategies(db)
    };

    const reaper = await runStrategyReaper(
      db,
      marketInfo.market_snapshot || normalizeMarketSnapshot({})
    );

    const postReaperActiveCount = await countActiveStrategies(db);

    const spawner = await runStrategySpawner(
      db,
      marketInfo.latest_draw_no,
      marketInfo.market_snapshot || normalizeMarketSnapshot({})
    );

    const create = await runPredictionCreator(
      db,
      marketInfo.latest_draw_no,
      marketInfo.market_snapshot || normalizeMarketSnapshot({})
    );

    const compareAfterCreate = await runCompareAllModes(db);

    return res.status(200).json({
      ok: true,
      compare_modes: [...COMPARE_MODES],
      ensure: ensureResult,
      pipeline: {
        compare_before_create: compareBeforeCreate,
        catchup,
        sync,
        reaper,
        spawner,
        create,
        compare_after_create: compareAfterCreate
      },
      meta: {
        latest_draw_no: marketInfo.latest_draw_no,
        active_count_after_reaper: postReaperActiveCount,
        target_active_strategy: TARGET_ACTIVE_STRATEGY,
        max_active_strategy: MAX_ACTIVE_STRATEGY,
        min_active_strategy: MIN_ACTIVE_STRATEGY,
        bet_group_count: BET_GROUP_COUNT,
        target_periods: TARGET_PERIODS,
        cost_per_group_per_period: COST_PER_GROUP_PER_PERIOD
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
}
