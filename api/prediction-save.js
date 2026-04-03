
import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-save-market-role-v11-stable-full-rewrite';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';

const TEST_MODE = 'test';
const FORMAL_MODE = 'formal';
const FORMAL_CANDIDATE_MODE = 'formal_candidate';

const COST_PER_GROUP = 25;
const FORMAL_BATCH_LIMIT = 3;
const GROUP_COUNT = 4;
const MAX_GROUPS_PER_STRATEGY = 2;

const DEFAULT_ANALYSIS_PERIOD = 20;
const ALLOWED_ANALYSIS_PERIODS = new Set([5, 10, 20, 50]);
const ALLOWED_STRATEGY_MODES = new Set(['hot', 'cold', 'mix', 'burst']);
const ALLOWED_RISK_MODES = new Set(['safe', 'balanced', 'aggressive', 'sniper']);

const MIN_TIER_A_ROUNDS = 20;
const MIN_TIER_B_ROUNDS = 10;
const MAX_GROUP_OVERLAP = 2;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function round4(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))]
    .filter((n) => n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function safeJsonParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseNums(value) {
  if (Array.isArray(value)) return uniqueAsc(value);

  if (typeof value === 'string') {
    return uniqueAsc(
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
        value.values ||
        []
    );
  }

  return [];
}

function parseGroupsJson(value) {
  if (Array.isArray(value)) return value;
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeGroup(group, idx = 0, sourceDraw = null) {
  if (!group || typeof group !== 'object') return null;

  const nums = uniqueAsc(
    Array.isArray(group.nums)
      ? group.nums
      : Array.isArray(group.numbers)
        ? group.numbers
        : Array.isArray(group.values)
          ? group.values
          : []
  ).slice(0, 4);

  if (nums.length !== 4) return null;

  const sourceMeta = group.meta && typeof group.meta === 'object' ? group.meta : {};
  const strategyKey = String(sourceMeta.strategy_key || group.key || `group_${idx + 1}`).trim();
  const strategyName = String(
    sourceMeta.strategy_name || group.label || group.key || `策略 ${idx + 1}`
  ).trim();

  return {
    key: strategyKey,
    label: String(group.label || strategyName).trim(),
    nums,
    reason:
      group.reason ||
      `正式下注採用候選池策略（單期 / 每組 ${COST_PER_GROUP} 元）`,
    meta: {
      ...sourceMeta,
      strategy_key: strategyKey,
      strategy_name: strategyName,
      selection_rank: toNum(sourceMeta.selection_rank, idx + 1),
      source_draw_no: toNum(sourceDraw?.draw_no, 0),
      source_draw_time: sourceDraw?.draw_time || null,
      bet_amount: COST_PER_GROUP,
      decision: sourceMeta.decision || 'from_candidate_pool'
    }
  };
}

function normalizeGroups(groups = [], sourceDraw = null) {
  return (Array.isArray(groups) ? groups : [])
    .map((group, idx) => normalizeGroup(group, idx, sourceDraw))
    .filter(Boolean)
    .slice(0, 200);
}

function getBody(req) {
  if (req?.body && typeof req.body === 'object') return req.body;

  if (typeof req?.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return {};
}

function getMode(req) {
  const body = getBody(req);
  return String(body?.mode || req.query?.mode || FORMAL_MODE).toLowerCase() === TEST_MODE
    ? TEST_MODE
    : FORMAL_MODE;
}

function getTriggerSource(req) {
  const body = getBody(req);
  return String(
    body?.trigger_source ||
      req.query?.trigger_source ||
      req.headers?.['x-trigger-source'] ||
      'unknown'
  ).trim();
}

function getSelectionParams(req) {
  const body = getBody(req);

  const analysisPeriodRaw = toNum(
    body?.analysisPeriod ??
      body?.analysis_period ??
      req.query?.analysisPeriod ??
      req.query?.analysis_period,
    DEFAULT_ANALYSIS_PERIOD
  );

  const analysisPeriod = ALLOWED_ANALYSIS_PERIODS.has(analysisPeriodRaw)
    ? analysisPeriodRaw
    : DEFAULT_ANALYSIS_PERIOD;

  const strategyModeRaw = String(
    body?.strategyMode ??
      body?.strategy_mode ??
      req.query?.strategyMode ??
      req.query?.strategy_mode ??
      'mix'
  ).trim().toLowerCase();

  const strategyMode = ALLOWED_STRATEGY_MODES.has(strategyModeRaw)
    ? strategyModeRaw
    : 'mix';

  const riskModeRaw = String(
    body?.riskMode ??
      body?.risk_mode ??
      req.query?.riskMode ??
      req.query?.risk_mode ??
      'balanced'
  ).trim().toLowerCase();

  const riskMode = ALLOWED_RISK_MODES.has(riskModeRaw)
    ? riskModeRaw
    : 'balanced';

  return {
    analysisPeriod,
    strategyMode,
    riskMode
  };
}

function roleLabelOf(type = '') {
  const key = String(type || '').trim().toLowerCase();
  if (key === 'safe') return '保守';
  if (key === 'balanced') return '平衡';
  if (key === 'aggressive') return '進攻';
  if (key === 'sniper') return '衝高';
  return '一般';
}

function strategyModeLabel(mode = '') {
  if (mode === 'hot') return '追熱';
  if (mode === 'cold') return '補冷';
  if (mode === 'mix') return '均衡';
  if (mode === 'burst') return '爆發';
  return '均衡';
}

async function getLatestDraw() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.draw_no) throw new Error('找不到最新期數');
  return data;
}

async function getRecentDraws(limitCount = DEFAULT_ANALYSIS_PERIOD) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getFormalRowsBySourceDrawNo(sourceDrawNo) {
  if (!sourceDrawNo) return [];

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, created_at, source_draw_no, mode, status')
    .eq('mode', FORMAL_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getLatestAnyTestPrediction() {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', TEST_MODE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getLatestTestPredictionUpToSourceDraw(sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', TEST_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getLatestFormalCandidateUpToSourceDraw(sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', FORMAL_CANDIDATE_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getRecentPredictionRowsByMode(mode, limitCount = 12) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', mode)
    .order('created_at', { ascending: false })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}


async function getStrategyStatsRowsByKeys(strategyKeys = []) {
  const keys = [...new Set((Array.isArray(strategyKeys) ? strategyKeys : []).map((v) => String(v || '').trim()).filter(Boolean))];
  if (!keys.length) return [];

  const { data, error } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .in('strategy_key', keys);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}


async function getStrategyPoolRows(limitCount = 120) {
  const { data, error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('strategy_key, strategy_name')
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function pickMetric(preferredValue, fallbackValue) {
  const preferred = Number(preferredValue);
  if (Number.isFinite(preferred)) return preferred;
  const fallback = Number(fallbackValue);
  return Number.isFinite(fallback) ? fallback : 0;
}

function mergeStrategyStatsIntoGroup(group = {}, statsMap = new Map()) {
  const strategyKey = getStrategyKey(group);
  if (!strategyKey || !statsMap.has(strategyKey)) return group;

  const stats = statsMap.get(strategyKey) || {};
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};

  return {
    ...group,
    meta: {
      ...meta,
      strategy_key: strategyKey,
      strategy_name: String(stats.strategy_name || meta.strategy_name || group.label || strategyKey),
      total_rounds: pickMetric(stats.total_rounds, meta.total_rounds),
      total_profit: pickMetric(stats.total_profit, meta.total_profit),
      roi: pickMetric(stats.roi, meta.roi),
      avg_hit: pickMetric(stats.avg_hit, meta.avg_hit),
      hit2: pickMetric(stats.hit2, meta.hit2),
      hit3: pickMetric(stats.hit3, meta.hit3),
      hit4: pickMetric(stats.hit4, meta.hit4),
      hit2_rate: pickMetric(stats.hit2_rate, meta.hit2_rate),
      hit3_rate: pickMetric(stats.hit3_rate, meta.hit3_rate),
      hit4_rate: pickMetric(stats.hit4_rate, meta.hit4_rate),
      recent_50_roi: pickMetric(stats.recent_50_roi, meta.recent_50_roi),
      recent_50_hit_rate: pickMetric(stats.recent_50_hit_rate, meta.recent_50_hit_rate),
      recent_50_hit3_rate: pickMetric(stats.recent_50_hit3_rate, meta.recent_50_hit3_rate),
      recent_50_hit4_rate: pickMetric(stats.recent_50_hit4_rate, meta.recent_50_hit4_rate),
      score: pickMetric(stats.score, meta.score)
    }
  };
}

function mergeStrategyStatsIntoGroups(groups = [], statsRows = []) {
  const statsMap = new Map(
    (Array.isArray(statsRows) ? statsRows : []).map((row) => [String(row?.strategy_key || '').trim(), row])
  );

  return (Array.isArray(groups) ? groups : []).map((group) =>
    mergeStrategyStatsIntoGroup(group, statsMap)
  );
}


function pickZoneAnchors(source = []) {
  const nums = uniqueAsc(source);
  const zones = [[], [], [], []];
  nums.forEach((n) => {
    if (n <= 20) zones[0].push(n);
    else if (n <= 40) zones[1].push(n);
    else if (n <= 60) zones[2].push(n);
    else zones[3].push(n);
  });

  return uniqueAsc([
    zones[0][0],
    zones[1][0],
    zones[2][0],
    zones[3][0]
  ].filter((n) => Number.isFinite(n)));
}

function buildNumsFromStrategyKey(strategyKey = '', pools = {}, selection = {}, phaseContext = null) {
  const key = String(strategyKey || '').trim().toLowerCase();

  const hotCore = [...(pools.hot5 || []), ...(pools.hot10 || []), ...(pools.attack || [])];
  const coldCore = [...(pools.cold || []), ...(pools.gap || []), ...(pools.extend || [])];
  const guardCore = [...(pools.guard || []), ...(pools.hot20 || []), ...(pools.warm || [])];
  const recentCore = [...(pools.recent || []), ...(pools.hot5 || []), ...(pools.attack || [])];
  const mixedCore = [...(pools.qualityAll || []), ...(pools.hot || []), ...(pools.extend || []), ...(pools.guard || [])];

  let base = [];

  if (key.includes('gap') || key.includes('chase') || key.includes('jump')) {
    base = [...coldCore, ...(pools.hot10 || [])];
  } else if (key.includes('cold')) {
    base = [...(pools.cold || []), ...(pools.gap || []), ...(pools.guard || [])];
  } else if (key.includes('hot') || key.includes('repeat')) {
    base = [...hotCore, ...(pools.recent || [])];
  } else if (key.includes('guard') || key.includes('balance') || key.includes('balanced') || key.includes('mix')) {
    base = [...guardCore, ...(pools.extend || [])];
  } else if (key.includes('recent')) {
    base = [...recentCore, ...(pools.extend || [])];
  } else {
    base = mixedCore;
  }

  if (key.includes('zone')) {
    base = uniqueAsc([...pickZoneAnchors(base), ...base, ...(pools.qualityAll || [])]);
  }

  if (key.includes('tail')) {
    const tails = new Map();
    for (const n of base) {
      const t = n % 10;
      if (!tails.has(t)) tails.set(t, n);
      if (tails.size >= 4) break;
    }
    base = uniqueAsc([...tails.values(), ...base, ...(pools.qualityAll || [])]);
  }

  if (key.includes('skip')) {
    base = uniqueAsc(base.filter((_, idx) => idx % 2 === 0).concat(pools.gap || []));
  }

  if (key.includes('cluster') || key.includes('pattern')) {
    base = uniqueAsc([...(pools.hot10 || []), ...(pools.hot20 || []), ...base]);
  }

  if (key.includes('split')) {
    base = uniqueAsc([...(pools.attack || []).slice(0, 2), ...(pools.gap || []).slice(0, 4), ...base]);
  }

  const nums = fillToFour([], [base, pools.qualityAll || [], pools.hot || [], pools.gap || [], pools.all || []], key.length * 37 + (selection.analysisPeriod || 0) * 11);

  return uniqueAsc(nums).slice(0, 4);
}

function buildStrategyPoolGroups(poolRows = [], pools = {}, selection = {}, phaseContext = null, sourceDraw = null) {
  const groups = [];

  for (const row of Array.isArray(poolRows) ? poolRows : []) {
    const strategyKey = String(row?.strategy_key || '').trim();
    if (!strategyKey || isFallbackStrategyKey(strategyKey)) continue;

    const nums = buildNumsFromStrategyKey(strategyKey, pools, selection, phaseContext);
    if (nums.length !== 4) continue;
    if (!isAcceptableGroup(nums, pools, inferRoleFromGroup({ key: strategyKey, meta: { strategy_key: strategyKey } }), selection, phaseContext)) continue;

    groups.push({
      key: strategyKey,
      label: String(row?.strategy_name || strategyKey),
      nums,
      reason: `正式下注採用策略池策略（單期 / 每組 ${COST_PER_GROUP} 元）`,
      meta: {
        strategy_key: strategyKey,
        strategy_name: String(row?.strategy_name || strategyKey),
        source_tag: 'strategy_pool',
        source_draw_no: toNum(sourceDraw?.draw_no, 0),
        source_draw_time: sourceDraw?.draw_time || null,
        bet_amount: COST_PER_GROUP,
        decision: 'from_strategy_pool'
      }
    });
  }

  return normalizeGroups(groups, sourceDraw);
}

async function getLatestComparedPredictionBeforeSource(sourceDrawNo) {
  const safeSourceDrawNo = toNum(sourceDrawNo, 0);
  if (!safeSourceDrawNo) return null;

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .in('mode', [FORMAL_MODE, TEST_MODE, FORMAL_CANDIDATE_MODE])
    .eq('status', 'compared')
    .lt('source_draw_no', safeSourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function inferLastHitLevel(lastComparedPrediction = null) {
  const hitCount =
    toInt(lastComparedPrediction?.hit_count, NaN) ||
    toInt(lastComparedPrediction?.compare_result_json?.hit_count, 0) ||
    toInt(lastComparedPrediction?.compare_result?.hit_count, 0);

  if (hitCount >= 3) return 'good';
  if (hitCount >= 1) return 'neutral';
  return 'bad';
}

function inferMarketPhase(sourcePrediction = null, marketSnapshot = {}) {
  const snapshotPhase = String(
    sourcePrediction?.market_phase ||
      sourcePrediction?.marketPhase ||
      marketSnapshot?.market_phase ||
      marketSnapshot?.phase ||
      ''
  ).trim().toLowerCase();

  if (snapshotPhase === 'continuation') return 'continuation';
  if (snapshotPhase === 'rotation') return 'rotation';

  const streak4 = (marketSnapshot?.streak4 || marketSnapshot?.streaks?.streak4 || []).length;
  const streak3 = (marketSnapshot?.streak3 || marketSnapshot?.streaks?.streak3 || []).length;
  return streak4 > 0 || streak3 >= 2 ? 'continuation' : 'rotation';
}

function buildWeightProfile(marketPhase = 'rotation', lastHitLevel = 'neutral') {
  const profile = { attack: 1, extend: 1, guard: 1, recent: 1 };

  if (marketPhase === 'rotation') {
    profile.attack = 0.9;
    profile.extend = 1.05;
    profile.guard = 1.08;
    profile.recent = 1.02;
  } else {
    profile.attack = 1.12;
    profile.guard = 0.96;
    profile.recent = 0.96;
    profile.extend = 1.02;
  }

  if (lastHitLevel === 'good') {
    profile.attack += 0.05;
    profile.extend += 0.04;
  } else if (lastHitLevel === 'bad') {
    profile.attack -= 0.08;
    profile.guard += 0.08;
    profile.extend += 0.06;
    profile.recent += 0.03;
  }

  return {
    attack: round4(profile.attack),
    extend: round4(profile.extend),
    guard: round4(profile.guard),
    recent: round4(profile.recent)
  };
}

function buildPhaseContext(sourcePrediction = null, lastComparedPrediction = null) {
  const marketSnapshot =
    sourcePrediction?.market_snapshot_json && typeof sourcePrediction.market_snapshot_json === 'object'
      ? sourcePrediction.market_snapshot_json
      : safeJsonParse(sourcePrediction?.market_snapshot_json, {}) || {};

  const marketPhase = inferMarketPhase(sourcePrediction, marketSnapshot);
  const lastHitLevel = inferLastHitLevel(lastComparedPrediction);
  const confidenceScore = clamp(
    toNum(
      sourcePrediction?.confidence_score ||
        sourcePrediction?.meta?.confidence_score ||
        sourcePrediction?.market_signal_json?.confidence_score,
      45
    ),
    0,
    100
  );

  return {
    marketPhase,
    lastHitLevel,
    confidenceScore,
    weightProfile: buildWeightProfile(marketPhase, lastHitLevel)
  };
}

function buildMarketPools(drawRows = [], marketSnapshot = {}) {
  const rows = Array.isArray(drawRows) ? drawRows : [];
  const allNums = Array.from({ length: 80 }, (_, i) => i + 1);

  const freqMap = new Map();
  const lastSeen = new Map();
  allNums.forEach((n) => freqMap.set(n, 0));

  rows.forEach((row, idx) => {
    const nums = parseNums(row?.numbers);
    nums.forEach((n) => {
      freqMap.set(n, toNum(freqMap.get(n), 0) + 1);
      if (!lastSeen.has(n)) lastSeen.set(n, idx);
    });
  });

  const hot = [...freqMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const cold = [...freqMap.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  const gap = allNums
    .slice()
    .sort((a, b) => {
      const gapA = lastSeen.has(a) ? lastSeen.get(a) : 999;
      const gapB = lastSeen.has(b) ? lastSeen.get(b) : 999;
      return gapB - gapA || a - b;
    });

  const warm = hot.slice(10).concat(hot.slice(0, 10));

  const hot5Numbers = uniqueAsc(
    marketSnapshot?.hot_windows?.hot_5?.numbers || marketSnapshot?.hot_5_numbers || []
  );
  const hot10Numbers = uniqueAsc(
    marketSnapshot?.hot_windows?.hot_10?.numbers || marketSnapshot?.hot_10_numbers || []
  );
  const hot20Numbers = uniqueAsc(
    marketSnapshot?.hot_windows?.hot_20?.numbers || marketSnapshot?.hot_20_numbers || []
  );

  const streak2 = uniqueAsc(marketSnapshot?.streak2 || marketSnapshot?.streaks?.streak2 || []);
  const streak3 = uniqueAsc(marketSnapshot?.streak3 || marketSnapshot?.streaks?.streak3 || []);
  const streak4 = uniqueAsc(marketSnapshot?.streak4 || marketSnapshot?.streaks?.streak4 || []);

  const attack = uniqueAsc([
    ...(marketSnapshot?.decision_basis?.attack_core_numbers || []),
    ...streak4,
    ...streak3,
    ...hot5Numbers.slice(0, 12),
    ...hot10Numbers.slice(0, 8)
  ]);

  const extend = uniqueAsc([
    ...(marketSnapshot?.decision_basis?.extend_numbers || []),
    ...streak2,
    ...hot10Numbers.slice(0, 14),
    ...hot20Numbers.slice(0, 10),
    ...gap.slice(0, 8)
  ]);

  const guard = uniqueAsc([
    ...(marketSnapshot?.decision_basis?.guard_numbers || []),
    ...hot20Numbers.slice(0, 20),
    ...warm.slice(0, 16),
    ...cold.slice(0, 8)
  ]);

  const recent = uniqueAsc([
    ...(marketSnapshot?.decision_basis?.recent_focus_numbers || []),
    ...parseNums(rows[0]?.numbers || []),
    ...hot5Numbers.slice(0, 10)
  ]);

  const qualityAll = uniqueAsc([
    ...attack,
    ...extend,
    ...guard,
    ...recent,
    ...hot.slice(0, 28),
    ...warm.slice(0, 24),
    ...gap.slice(0, 18),
    ...allNums
  ]);

  return {
    hot,
    cold,
    warm,
    gap,
    attack,
    extend,
    guard,
    recent,
    hot5: hot5Numbers,
    hot10: hot10Numbers,
    hot20: hot20Numbers,
    streak2,
    streak3,
    streak4,
    all: allNums,
    qualityAll
  };
}

function getZoneBucket(n) {
  const num = toNum(n, 0);
  if (num <= 20) return 1;
  if (num <= 40) return 2;
  if (num <= 60) return 3;
  return 4;
}

function countConsecutivePairs(nums = []) {
  const arr = uniqueAsc(nums);
  let count = 0;
  for (let i = 1; i < arr.length; i += 1) {
    if (arr[i] - arr[i - 1] === 1) count += 1;
  }
  return count;
}

function buildGroupQualityReport(nums = [], pools = {}) {
  const arr = uniqueAsc(nums).slice(0, 4);
  const oddCount = arr.filter((n) => n % 2 === 1).length;
  const sum = arr.reduce((acc, n) => acc + n, 0);
  const span = arr.length ? arr[arr.length - 1] - arr[0] : 0;
  const tailKinds = new Set(arr.map((n) => n % 10)).size;
  const zoneKinds = new Set(arr.map((n) => getZoneBucket(n))).size;
  const consecutivePairs = countConsecutivePairs(arr);
  const hotCount = arr.filter((n) => (pools.hot || []).slice(0, 20).includes(n)).length;
  const attackCount = arr.filter((n) => (pools.attack || []).slice(0, 18).includes(n)).length;
  const extendCount = arr.filter((n) => (pools.extend || []).slice(0, 18).includes(n)).length;
  const guardCount = arr.filter((n) => (pools.guard || []).slice(0, 18).includes(n)).length;
  const gapCount = arr.filter((n) => (pools.gap || []).slice(0, 18).includes(n)).length;

  return {
    nums: arr,
    oddCount,
    sum,
    span,
    tailKinds,
    zoneKinds,
    consecutivePairs,
    hotCount,
    attackCount,
    extendCount,
    guardCount,
    gapCount
  };
}

function scoreQualityReport(report = {}, role = 'mix', selection = {}, phaseContext = null) {
  let score = 0;
  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();

  if (report.oddCount === 2) score += 16;
  else if (report.oddCount === 1 || report.oddCount === 3) score += 8;
  else score -= 12;

  if (report.tailKinds >= 4) score += 12;
  else if (report.tailKinds === 3) score += 8;
  else if (report.tailKinds === 2) score += 2;
  else score -= 12;

  if (report.zoneKinds >= 3) score += 14;
  else if (report.zoneKinds === 2) score += 6;
  else score -= 10;

  if (report.consecutivePairs === 0) score += 10;
  else if (report.consecutivePairs === 1) score += 2;
  else score -= 14;

  if (report.sum >= 70 && report.sum <= 210) score += 10;
  else score -= 8;

  if (report.span >= 18 && report.span <= 62) score += 10;
  else if (report.span >= 10 && report.span <= 70) score += 4;
  else score -= 10;

  if (role === 'attack') score += report.attackCount * 8 + report.hotCount * 4;
  if (role === 'extend') score += report.extendCount * 7 + report.gapCount * 5;
  if (role === 'guard') score += report.guardCount * 7 + report.hotCount * 3;
  if (role === 'recent') score += report.hotCount * 4 + report.extendCount * 4;

  if (selection.strategyMode === 'cold') score += report.gapCount * 4;
  if (selection.strategyMode === 'hot') score += report.hotCount * 4;
  if (selection.strategyMode === 'burst') score += report.attackCount * 5 + report.gapCount * 4;

  if (marketPhase === 'rotation' && role === 'attack') score -= 6;
  if (marketPhase === 'rotation' && (role === 'extend' || role === 'guard')) score += 4;
  if (marketPhase === 'continuation' && role === 'attack') score += 8;

  return score;
}

function isAcceptableGroup(nums = [], pools = {}, role = 'mix', selection = {}, phaseContext = null) {
  const arr = uniqueAsc(nums).slice(0, 4);
  if (arr.length !== 4) return false;
  if (arr.every((n) => n <= 10)) return false;

  const report = buildGroupQualityReport(arr, pools);
  if (report.consecutivePairs >= 2) return false;
  if (report.tailKinds <= 1) return false;

  const qualityScore = scoreQualityReport(report, role, selection, phaseContext);
  return qualityScore >= 12;
}

function pickFromPool(pool = [], selectedSet = new Set(), seed = 0) {
  const candidates = uniqueAsc(pool).filter((n) => !selectedSet.has(n));
  if (!candidates.length) return null;
  const index = Math.abs(toNum(seed, 0) * 7 + candidates.length * 3) % candidates.length;
  return candidates[index];
}

function fillToFour(base = [], fallbackPools = [], seed = 0) {
  const initial = uniqueAsc(base).slice(0, 4);
  const selected = new Set(initial);
  const mergedPools = Array.isArray(fallbackPools) ? fallbackPools : [];
  let cursor = 0;

  while (selected.size < 4 && cursor < 400) {
    let picked = null;

    for (let i = 0; i < mergedPools.length; i += 1) {
      const value = pickFromPool(mergedPools[i], selected, seed + cursor + i * 13);
      cursor += 1;
      if (value == null) continue;
      picked = value;
      break;
    }

    if (picked == null) break;
    selected.add(picked);
  }

  return uniqueAsc([...selected]).slice(0, 4);
}

function countOverlap(a = [], b = []) {
  const setB = new Set(uniqueAsc(b));
  return uniqueAsc(a).filter((n) => setB.has(n)).length;
}

function getRiskOrder(riskMode = 'balanced', phaseContext = null) {
  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();

  if (marketPhase === 'rotation') {
    if (riskMode === 'safe') return ['guard', 'extend', 'recent', 'attack'];
    if (riskMode === 'balanced') return ['extend', 'guard', 'recent', 'attack'];
    if (riskMode === 'aggressive') return ['extend', 'attack', 'guard', 'recent'];
    return ['recent', 'extend', 'guard', 'attack'];
  }

  if (riskMode === 'safe') return ['guard', 'extend', 'attack', 'recent'];
  if (riskMode === 'balanced') return ['attack', 'extend', 'guard', 'recent'];
  if (riskMode === 'aggressive') return ['attack', 'attack', 'extend', 'recent'];
  return ['attack', 'recent', 'extend', 'guard'];
}

function inferRoleFromGroup(group = {}) {
  const key = String(group?.meta?.strategy_key || group?.key || '').toLowerCase();
  const label = String(group?.label || '').toLowerCase();
  const preferredRole = String(group?.meta?.preferred_role || '').toLowerCase();
  const marketReason = String(group?.meta?.market_reason || '').toLowerCase();

  if (preferredRole) return preferredRole;
  if (label.startsWith('attack')) return 'attack';
  if (label.startsWith('extend')) return 'extend';
  if (label.startsWith('guard')) return 'guard';
  if (label.startsWith('recent')) return 'recent';

  if (marketReason.includes('attack')) return 'attack';
  if (marketReason.includes('extend')) return 'extend';
  if (marketReason.includes('guard')) return 'guard';
  if (marketReason.includes('recent')) return 'recent';

  if (key.includes('repeat') || key.includes('hot')) return 'attack';
  if (key.includes('gap') || key.includes('chase') || key.includes('jump')) return 'extend';
  if (key.includes('guard') || key.includes('balance') || key.includes('mix')) return 'guard';
  if (key.includes('tail') || key.includes('rotation') || key.includes('split')) return 'recent';

  return 'mix';
}

function getKeepNeedByRole(role = 'mix', phaseContext = null) {
  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();
  const lastHitLevel = String(phaseContext?.lastHitLevel || '').toLowerCase();

  if (marketPhase === 'continuation') {
    if (role === 'attack') return lastHitLevel === 'good' ? 3 : 2;
    if (role === 'extend') return 2;
    if (role === 'guard') return 2;
    if (role === 'recent') return 1;
    return 2;
  }

  if (marketPhase === 'rotation') {
    if (role === 'attack') return 1;
    if (role === 'extend') return 2;
    if (role === 'guard') return 2;
    if (role === 'recent') return 2;
    return 2;
  }

  return 2;
}

function buildKeepPoolByRole(role = 'mix', pools = {}, phaseContext = null) {
  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();

  if (marketPhase === 'rotation') {
    if (role === 'attack') return uniqueAsc([...(pools.extend || []), ...(pools.attack || []), ...(pools.hot10 || [])]);
    if (role === 'extend') return uniqueAsc([...(pools.extend || []), ...(pools.hot10 || []), ...(pools.guard || [])]);
    if (role === 'guard') return uniqueAsc([...(pools.guard || []), ...(pools.hot20 || []), ...(pools.warm || [])]);
    if (role === 'recent') return uniqueAsc([...(pools.recent || []), ...(pools.extend || []), ...(pools.hot5 || [])]);
    return uniqueAsc([...(pools.extend || []), ...(pools.guard || []), ...(pools.hot || [])]);
  }

  if (role === 'attack') return uniqueAsc([...(pools.attack || []), ...(pools.hot5 || []), ...(pools.hot10 || [])]);
  if (role === 'extend') return uniqueAsc([...(pools.extend || []), ...(pools.hot10 || []), ...(pools.guard || [])]);
  if (role === 'guard') return uniqueAsc([...(pools.guard || []), ...(pools.hot20 || []), ...(pools.warm || [])]);
  if (role === 'recent') return uniqueAsc([...(pools.recent || []), ...(pools.hot5 || []), ...(pools.attack || [])]);
  return uniqueAsc([...(pools.hot || []), ...(pools.extend || []), ...(pools.guard || [])]);
}

function pickKeepNumsByRole(sourceNums = [], role = 'mix', pools = {}, phaseContext = null) {
  const nums = uniqueAsc(sourceNums);
  const keepPool = new Set(buildKeepPoolByRole(role, pools, phaseContext));
  const need = getKeepNeedByRole(role, phaseContext);
  const kept = nums.filter((n) => keepPool.has(n));
  if (kept.length >= need) return kept.slice(0, need);
  return uniqueAsc([...kept, ...nums.slice(0, need)]).slice(0, need);
}

function getBlendedRoi(group = {}) {
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const recent50 = toNum(meta.recent_50_roi, NaN);
  const baseRoi = toNum(meta.roi, 0);
  if (Number.isFinite(recent50)) return round4(recent50 * 0.7 + baseRoi * 0.3);
  return round4(baseRoi);
}

function getBlendedHit3Rate(group = {}) {
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const recent50 = toNum(meta.recent_50_hit3_rate, NaN);
  const base = toNum(meta.hit3_rate, 0);
  if (Number.isFinite(recent50)) return round4(recent50 * 0.7 + base * 0.3);
  return round4(base);
}

function getDecisionScoreFloor(role = 'mix', selection = {}, phaseContext = null) {
  let floor = 90;
  if (role === 'attack') floor = 130;
  if (role === 'extend') floor = 150;
  if (role === 'guard') floor = 85;
  if (role === 'recent') floor = 95;
  if (selection.riskMode === 'safe') floor += 10;
  if (selection.riskMode === 'aggressive' && role === 'attack') floor -= 5;
  if (phaseContext?.marketPhase === 'continuation' && role === 'attack') floor -= 10;
  if (phaseContext?.marketPhase === 'rotation' && role === 'attack') floor += 10;
  return floor;
}

function getRecentRoiFloor(role = 'mix', selection = {}, phaseContext = null) {
  let floor = -0.15;
  if (role === 'attack') floor = -0.12;
  if (role === 'extend') floor = -0.24;
  if (role === 'guard') floor = -0.35;
  if (role === 'recent') floor = -0.28;
  if (selection.riskMode === 'safe') floor += 0.05;
  if (phaseContext?.lastHitLevel === 'bad') floor += 0.04;
  return round4(floor);
}

function getHit3RateFloor(role = 'mix', selection = {}, phaseContext = null) {
  let floor = 0.01;
  if (role === 'attack') floor = 0.012;
  if (role === 'extend') floor = 0.008;
  if (role === 'guard') floor = 0;
  if (role === 'recent') floor = 0.004;
  if (selection.strategyMode === 'hot') floor += 0.002;
  if (phaseContext?.marketPhase === 'continuation' && role === 'attack') floor -= 0.002;
  return round4(Math.max(0, floor));
}

function getStabilityFloor(role = 'mix', selection = {}, phaseContext = null) {
  let floor = 1;
  if (role === 'guard') floor = 0;
  if (role === 'recent') floor = 0;
  if (selection.riskMode === 'safe') floor += 1;
  return floor;
}

function getTierThresholds(role = 'mix', selection = {}, phaseContext = null) {
  const decisionGate = getDecisionScoreFloor(role, selection, phaseContext);
  const roiGate = getRecentRoiFloor(role, selection, phaseContext);
  const hit3Gate = getHit3RateFloor(role, selection, phaseContext);
  const stabilityGate = getStabilityFloor(role, selection, phaseContext);

  return {
    decisionGate,
    roiGate,
    hit3Gate,
    stabilityGate,
    decisionGateB: round4(decisionGate * 0.72),
    roiGateB: round4(roiGate - 0.12),
    hit3GateB: round4(Math.max(0, hit3Gate - 0.008)),
    stabilityGateB: Math.max(0, stabilityGate - 1)
  };
}

function getCandidateTier(sourceGroup, score, role = 'mix', selection = {}, phaseContext = null) {
  const meta = sourceGroup?.meta && typeof sourceGroup.meta === 'object' ? sourceGroup.meta : {};
  const totalRounds = toNum(meta.total_rounds, 0);
  const blendedRoi = getBlendedRoi(sourceGroup);
  const blendedHit3Rate = getBlendedHit3Rate(sourceGroup);
  const avgHit = toNum(meta.avg_hit, 0);
  const thresholds = getTierThresholds(role, selection, phaseContext);

  const isA =
    totalRounds >= MIN_TIER_A_ROUNDS &&
    score >= thresholds.decisionGate &&
    blendedRoi >= thresholds.roiGate &&
    blendedHit3Rate >= thresholds.hit3Gate &&
    avgHit >= thresholds.stabilityGate;

  if (isA) return 'A';

  const isB =
    totalRounds >= MIN_TIER_B_ROUNDS &&
    score >= thresholds.decisionGateB &&
    blendedRoi >= thresholds.roiGateB &&
    blendedHit3Rate >= thresholds.hit3GateB &&
    avgHit >= thresholds.stabilityGateB;

  if (isB) return 'B';
  return 'C';
}

function candidateTierBonus(tier = 'C') {
  if (tier === 'A') return 2200;
  if (tier === 'B') return 900;
  return 0;
}

function tierRank(tier = 'C') {
  if (tier === 'A') return 3;
  if (tier === 'B') return 2;
  return 1;
}

function minTierForSlot(slotNo = 1) {
  if (slotNo === 1) return 'A';
  if (slotNo === 2) return 'B';
  if (slotNo === 3) return 'B';
  return 'C';
}

function meetsMinTier(actualTier = 'C', requiredTier = 'C') {
  return tierRank(actualTier) >= tierRank(requiredTier);
}

function getStrategyKey(group = {}) {
  return String(group?.meta?.strategy_key || group?.key || '').trim();
}

function isFallbackStrategyKey(strategyKey = '') {
  return String(strategyKey || '').trim().toLowerCase().startsWith('fallback_');
}

function isFallbackGroup(group = {}) {
  return isFallbackStrategyKey(getStrategyKey(group));
}

function getSourceTag(group = {}) {
  return String(group?.meta?.source_tag || group?.meta?.decision || 'source').trim();
}

function scoreGroupForMode(group, role = 'mix', strategyMode = 'mix', riskMode = 'balanced', pools = {}, phaseContext = null) {
  const nums = uniqueAsc(group?.nums || []);
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const report = buildGroupQualityReport(nums, pools);
  const blendedRoi = getBlendedRoi(group);
  const blendedHit3Rate = getBlendedHit3Rate(group);
  const recent50Roi = toNum(meta.recent_50_roi, blendedRoi);
  const recent50Hit3Rate = toNum(meta.recent_50_hit3_rate, blendedHit3Rate);
  const avgHit = toNum(meta.avg_hit, 0);
  const totalRounds = toNum(meta.total_rounds, 0);

  const roleWeight =
    role === 'attack'
      ? toNum(phaseContext?.weightProfile?.attack, 1)
      : role === 'extend'
        ? toNum(phaseContext?.weightProfile?.extend, 1)
        : role === 'guard'
          ? toNum(phaseContext?.weightProfile?.guard, 1)
          : role === 'recent'
            ? toNum(phaseContext?.weightProfile?.recent, 1)
            : 1;

  let score = scoreQualityReport(report, role, { strategyMode, riskMode }, phaseContext);
  score += blendedRoi * 260;
  score += recent50Roi * 340;
  score += blendedHit3Rate * 3600;
  score += recent50Hit3Rate * 4200;
  score += avgHit * 65;
  score += totalRounds * 1.6;
  score += toNum(meta.hit4_rate, 0) * 5200;
  score += toNum(meta.recent_50_hit4_rate, 0) * 6000;

  if (blendedRoi < 0) score += blendedRoi * 260;
  if (recent50Roi < 0) score += recent50Roi * 320;
  if (blendedHit3Rate <= 0) score -= 180;
  if (recent50Hit3Rate <= 0) score -= 220;

  score *= roleWeight;

  if (riskMode === 'safe' && role === 'guard') score += 35;
  if (riskMode === 'aggressive' && role === 'attack') score += 35;
  if (strategyMode === 'cold') score += report.gapCount * 8;
  if (strategyMode === 'hot') score += report.hotCount * 8;
  if (strategyMode === 'burst') score += report.attackCount * 12;

  return round4(score);
}

function getRoleSeedPools(role = 'mix', pools = {}, phaseContext = null) {
  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();

  if (marketPhase === 'rotation') {
    if (role === 'attack') return [pools.extend, pools.attack, pools.recent, pools.hot10 || pools.hot, pools.all];
    if (role === 'extend') return [pools.extend, pools.guard, pools.hot10 || pools.hot, pools.recent, pools.all];
    if (role === 'guard') return [pools.guard, pools.extend, pools.hot20 || pools.warm, pools.cold, pools.all];
    if (role === 'recent') return [pools.recent, pools.extend, pools.guard, pools.hot5 || pools.hot, pools.all];
    return [pools.extend, pools.guard, pools.hot, pools.all];
  }

  if (role === 'attack') return [pools.attack, pools.hot5 || pools.hot, pools.hot10 || pools.hot, pools.recent, pools.all];
  if (role === 'extend') return [pools.extend, pools.hot10 || pools.hot, pools.hot20 || pools.hot, pools.guard, pools.all];
  if (role === 'guard') return [pools.guard, pools.hot20 || pools.hot, pools.warm, pools.cold, pools.all];
  if (role === 'recent') return [pools.recent, pools.attack, pools.hot5 || pools.hot, pools.extend, pools.all];
  return [pools.hot, pools.extend, pools.guard, pools.all];
}

function evaluateFormalCandidateScore(sourceGroup, nums, slotRole, selection, pools, phaseContext, existingGroups = []) {
  const report = buildGroupQualityReport(nums, pools);
  let score = scoreGroupForMode(
    { ...sourceGroup, nums },
    slotRole,
    selection.strategyMode,
    selection.riskMode,
    pools,
    phaseContext
  );

  existingGroups.forEach((g) => {
    const overlap = countOverlap(nums, g?.nums || []);
    if (overlap >= 3) score -= 900;
    else if (overlap === 2) score -= 120;
  });

  if (report.zoneKinds >= 3) score += 30;
  if (report.tailKinds >= 3) score += 25;
  if (report.consecutivePairs === 0) score += 24;

  return round4(score);
}

function forceGroupDifference(nums = [], existingGroups = [], pools = {}, seed = 0) {
  let result = uniqueAsc(nums).slice(0, 4);
  const backupPools = [
    pools.attack,
    pools.extend,
    pools.guard,
    pools.recent,
    pools.hot10 || pools.hot,
    pools.gap,
    pools.warm,
    pools.qualityAll,
    pools.all
  ];

  for (let round = 0; round < 10; round += 1) {
    const overlapTooHigh = existingGroups.some((group) => countOverlap(result, group?.nums || []) > MAX_GROUP_OVERLAP);
    if (!overlapTooHigh) break;
    const keep = result.slice(0, 2);
    result = fillToFour(keep, backupPools, seed + round * 17 + 3);
  }

  return uniqueAsc(result).slice(0, 4);
}

function buildVariantFromSourceGroup(sourceGroup, slotRole, slotNo, pools, existingGroups = [], selection = {}, phaseContext = null) {
  const sourceNums = uniqueAsc(sourceGroup?.nums || []);
  const keepNums = pickKeepNumsByRole(sourceNums, slotRole, pools, phaseContext);
  const fallbackPools = getRoleSeedPools(slotRole, pools, phaseContext);
  const seedBase =
    slotNo * 101 +
    toNum(sourceGroup?.meta?.selection_rank, slotNo) * 17 +
    selection.analysisPeriod * 3;

  const candidateMap = new Map();

  const addCandidate = (nums, tag = 'base', extraScore = 0) => {
    const safeNums = uniqueAsc(nums).slice(0, 4);
    if (safeNums.length !== 4) return;
    if (!isAcceptableGroup(safeNums, pools, slotRole, selection, phaseContext)) return;

    const adjustedNums = forceGroupDifference(safeNums, existingGroups, pools, seedBase + extraScore);
    if (adjustedNums.length !== 4) return;

    const score =
      evaluateFormalCandidateScore(
        sourceGroup,
        adjustedNums,
        slotRole,
        selection,
        pools,
        phaseContext,
        existingGroups
      ) + extraScore;

    const tier = getCandidateTier(sourceGroup, score, slotRole, selection, phaseContext);

    const key = adjustedNums.join(',');
    const prev = candidateMap.get(key);
    if (!prev || score > prev.score) {
      candidateMap.set(key, {
        nums: adjustedNums,
        score,
        tag,
        sourceGroup,
        tier
      });
    }
  };

  addCandidate(fillToFour(keepNums, fallbackPools, seedBase), 'keep_base', 0);

  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();
  const lastHitLevel = String(phaseContext?.lastHitLevel || '').toLowerCase();

  if (slotRole === 'attack' && marketPhase === 'continuation') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums,
          ...(pools.attack || []).slice(0, lastHitLevel === 'good' ? 4 : 3)
        ]),
        fallbackPools,
        seedBase + 19
      ),
      'attack_continuation',
      14
    );
  }

  if (slotRole === 'extend') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums,
          ...(pools.extend || []).slice(0, 4),
          ...(pools.gap || []).slice(0, 2)
        ]),
        fallbackPools,
        seedBase + 31
      ),
      'extend_gap',
      11
    );
  }

  if (slotRole === 'guard') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums,
          ...(pools.guard || []).slice(0, 5),
          ...(pools.hot20 || []).slice(0, 2)
        ]),
        fallbackPools,
        seedBase + 47
      ),
      'guard_stable',
      10
    );
  }

  if (slotRole === 'recent') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums,
          ...(pools.recent || []).slice(0, 5),
          ...(pools.hot5 || []).slice(0, 2)
        ]),
        fallbackPools,
        seedBase + 59
      ),
      'recent_focus',
      8
    );
  }

  addCandidate(
    fillToFour(uniqueAsc([...sourceNums.slice(0, 2), ...(pools.qualityAll || []).slice(0, 10)]), fallbackPools, seedBase + 73),
    'quality_mix',
    6
  );

  const candidates = [...candidateMap.values()].sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function buildFormalLabel(slotRole, slotNo, sourceGroup) {
  const roleName =
    slotRole === 'attack'
      ? 'Attack'
      : slotRole === 'extend'
        ? 'Extend'
        : slotRole === 'guard'
          ? 'Guard'
          : slotRole === 'recent'
            ? 'Recent'
            : 'Mix';

  const baseName = String(
    sourceGroup?.meta?.strategy_name || sourceGroup?.label || sourceGroup?.key || 'Strategy'
  ).trim();

  return `${roleName} ${slotNo} / ${baseName}`;
}

function buildFormalMeta(sourceGroup, slotRole, slotNo, sourcePrediction, selection, phaseContext) {
  const meta = sourceGroup?.meta && typeof sourceGroup.meta === 'object' ? sourceGroup.meta : {};
  return {
    ...meta,
    strategy_key: String(meta.strategy_key || sourceGroup?.key || `strategy_${slotNo}`).trim(),
    strategy_name: String(meta.strategy_name || sourceGroup?.label || sourceGroup?.key || `策略 ${slotNo}`).trim(),
    preferred_role: slotRole,
    slot_no: slotNo,
    selection_rank: slotNo,
    source_prediction_id: sourcePrediction?.id || null,
    source_prediction_mode: sourcePrediction?.mode || null,
    source_prediction_draw_no: sourcePrediction?.source_draw_no || null,
    analysis_period: selection.analysisPeriod,
    strategy_mode: selection.strategyMode,
    risk_mode: selection.riskMode,
    market_phase: phaseContext?.marketPhase || null,
    last_hit_level: phaseContext?.lastHitLevel || null,
    confidence_score: phaseContext?.confidenceScore || null,
    weight_profile: phaseContext?.weightProfile || null,
    decision: 'formal_slot_selected',
    bet_amount: COST_PER_GROUP
  };
}

function buildFallbackGroup(slotRole, slotNo, pools, selection, phaseContext, existingGroups = []) {
  const fallbackPools = getRoleSeedPools(slotRole, pools, phaseContext);
  const base = fillToFour([], fallbackPools, slotNo * 97 + selection.analysisPeriod * 5);
  let nums = base;

  if (nums.length !== 4 || !isAcceptableGroup(nums, pools, slotRole, selection, phaseContext)) {
    nums = uniqueAsc([
      ...(pools.qualityAll || []).slice(slotNo * 2, slotNo * 2 + 2),
      ...(pools.hot || []).slice(slotNo, slotNo + 2),
      ...(pools.gap || []).slice(slotNo, slotNo + 2)
    ]).slice(0, 4);
  }

  nums = forceGroupDifference(fillToFour(nums, [pools.qualityAll, pools.hot, pools.gap, pools.all], slotNo * 111), existingGroups, pools, slotNo * 131);

  if (nums.length !== 4) {
    nums = uniqueAsc([
      ...(pools.all || []).slice(slotNo * 4, slotNo * 4 + 4)
    ]).slice(0, 4);
  }

  return {
    key: `fallback_${slotRole}_${slotNo}`,
    label: `Fallback ${slotRole.toUpperCase()} ${slotNo}`,
    nums,
    reason: `正式下注保底分工：${slotRole.toUpperCase()} / ${strategyModeLabel(selection.strategyMode)} / ${roleLabelOf(selection.riskMode)} / ${phaseContext.marketPhase} / ${phaseContext.lastHitLevel}`,
    meta: {
      strategy_key: `fallback_${slotRole}`,
      strategy_name: `Fallback ${slotRole}`,
      preferred_role: slotRole,
      slot_no: slotNo,
      selection_rank: slotNo,
      decision: 'forced_fallback',
      analysis_period: selection.analysisPeriod,
      strategy_mode: selection.strategyMode,
      risk_mode: selection.riskMode,
      market_phase: phaseContext.marketPhase,
      last_hit_level: phaseContext.lastHitLevel,
      confidence_score: phaseContext.confidenceScore,
      weight_profile: phaseContext.weightProfile,
      total_rounds: 0,
      avg_hit: 0,
      roi: 0,
      hit3_rate: 0,
      bet_amount: COST_PER_GROUP,
      tier: 'C'
    }
  };
}

function collectSourceGroups(candidateRows = [], sourceDraw = null) {
  const allGroups = [];

  for (const row of candidateRows) {
    const groups = normalizeGroups(parseGroupsJson(row?.groups_json), sourceDraw);
    const sourceTag = row?.mode === TEST_MODE ? 'test' : row?.mode === FORMAL_CANDIDATE_MODE ? 'formal_candidate' : 'recent';
    groups.forEach((group, idx) => {
      allGroups.push({
        ...group,
        meta: {
          ...(group.meta || {}),
          source_tag: `${sourceTag}_${idx + 1}`,
          source_prediction_id: row?.id || null,
          source_prediction_mode: row?.mode || null,
          source_prediction_draw_no: row?.source_draw_no || null
        }
      });
    });
  }

  return allGroups;
}

function dedupeSourceGroups(groups = []) {
  const bucket = new Map();

  for (const group of groups) {
    const numsKey = uniqueAsc(group?.nums || []).join(',');
    const strategyKey = getStrategyKey(group) || 'unknown';
    const safeKey = `${strategyKey}|${numsKey}`;
    const prev = bucket.get(safeKey);

    const score = toNum(group?.meta?.score, 0) + getBlendedRoi(group) * 100 + getBlendedHit3Rate(group) * 1200;
    if (!prev || score > prev._score) {
      bucket.set(safeKey, {
        ...group,
        _score: score
      });
    }
  }

  return [...bucket.values()]
    .sort((a, b) => b._score - a._score)
    .map((item) => {
      const copy = { ...item };
      delete copy._score;
      return copy;
    });
}

function chooseSourcePrediction(latestTest, exactTest, exactFormalCandidate) {
  return exactFormalCandidate || exactTest || latestTest || null;
}

function buildRankedSourceGroups(sourceGroups = [], selection = {}, pools = {}, phaseContext = null) {
  return sourceGroups
    .map((group) => {
      const role = inferRoleFromGroup(group);
      const score = scoreGroupForMode(
        group,
        role,
        selection.strategyMode,
        selection.riskMode,
        pools,
        phaseContext
      );
      const tier = getCandidateTier(group, score, role, selection, phaseContext);

      return {
        group,
        role,
        score,
        tier,
        strategyKey: getStrategyKey(group),
        totalRounds: toNum(group?.meta?.total_rounds, 0),
        sourceTag: getSourceTag(group)
      };
    })
    .sort((a, b) => {
      const slotPriorityA = candidateTierBonus(a.tier) + a.score + a.totalRounds;
      const slotPriorityB = candidateTierBonus(b.tier) + b.score + b.totalRounds;
      return slotPriorityB - slotPriorityA;
    });
}

function pickRoleOrderedGroups(ranked = [], selection = {}, pools = {}, phaseContext = null) {
  const roles = getRiskOrder(selection.riskMode, phaseContext);
  const picked = [];
  const usedIndexes = new Set();
  const strategyUseCount = new Map();

  for (let i = 0; i < roles.length && picked.length < GROUP_COUNT; i += 1) {
    const role = roles[i];
    const slotNo = picked.length + 1;
    const requiredTier = minTierForSlot(slotNo);
    let bestIdx = -1;
    let bestScore = -Infinity;
    let bestTier = 'C';

    for (let j = 0; j < ranked.length; j += 1) {
      if (usedIndexes.has(j)) continue;

      const rankedRow = ranked[j];
      const strategyKey = getStrategyKey(rankedRow.group);
      const usedCount = toInt(strategyUseCount.get(strategyKey), 0);

      if (slotNo <= 3 && isFallbackStrategyKey(strategyKey)) continue;
      if (strategyKey && usedCount >= MAX_GROUPS_PER_STRATEGY) continue;
      if (slotNo <= 2 && strategyKey && usedCount >= 1) continue;

      const score = scoreGroupForMode(
        rankedRow.group,
        role,
        selection.strategyMode,
        selection.riskMode,
        pools,
        phaseContext
      );

      const tier = getCandidateTier(rankedRow.group, score, role, selection, phaseContext);
      if (!meetsMinTier(tier, requiredTier)) continue;

      const bonus = candidateTierBonus(tier) - usedCount * 1500;
      if (score + bonus > bestScore) {
        bestScore = score + bonus;
        bestIdx = j;
        bestTier = tier;
      }
    }

    if (bestIdx >= 0) {
      usedIndexes.add(bestIdx);

      const chosenGroup = ranked[bestIdx].group;
      const strategyKey = getStrategyKey(chosenGroup);
      if (strategyKey) {
        strategyUseCount.set(strategyKey, toInt(strategyUseCount.get(strategyKey), 0) + 1);
      }

      picked.push({
        role,
        group: chosenGroup,
        role_decision_score: bestScore,
        tier: bestTier
      });
    }
  }

  if (picked.length < GROUP_COUNT) {
    for (let j = 0; j < ranked.length && picked.length < GROUP_COUNT; j += 1) {
      if (usedIndexes.has(j)) continue;

      const slotNo = picked.length + 1;
      const requiredTier = minTierForSlot(slotNo);
      const role = roles[picked.length] || 'mix';
      const rankedRow = ranked[j];
      const strategyKey = getStrategyKey(rankedRow.group);
      const usedCount = toInt(strategyUseCount.get(strategyKey), 0);
      if (strategyKey && usedCount >= MAX_GROUPS_PER_STRATEGY) continue;
      if (slotNo <= 2 && strategyKey && usedCount >= 1) continue;
      if (!meetsMinTier(rankedRow.tier, requiredTier)) continue;

      usedIndexes.add(j);
      if (strategyKey) {
        strategyUseCount.set(strategyKey, usedCount + 1);
      }

      picked.push({
        role,
        group: rankedRow.group,
        role_decision_score: rankedRow.score,
        tier: rankedRow.tier
      });
    }
  }

  return picked.slice(0, GROUP_COUNT);
}

function buildFormalGroups(sourceGroups = [], sourcePrediction = null, sourceDraw = null, selection = {}, pools = {}, phaseContext = null) {
  const groups = [];
  const usedKeys = new Set();
  const strategyUseCount = new Map();

  const ranked = buildRankedSourceGroups(sourceGroups, selection, pools, phaseContext);
  const roleOrdered = pickRoleOrderedGroups(ranked, selection, pools, phaseContext);

  const tryAddSlot = (sourceGroup, slotRole = 'mix') => {
    if (!sourceGroup) return false;

    const strategyKey = getStrategyKey(sourceGroup);
    const currentStrategyCount = toInt(strategyUseCount.get(strategyKey), 0);
    const nextSlotNo = groups.length + 1;
    const requiredTier = minTierForSlot(nextSlotNo);

    if (nextSlotNo <= 3 && isFallbackStrategyKey(strategyKey)) {
      return false;
    }

    const variant = buildVariantFromSourceGroup(
      sourceGroup,
      slotRole,
      nextSlotNo,
      pools,
      groups,
      selection,
      phaseContext
    );

    if (!variant || !variant.nums || variant.nums.length !== 4) return false;

    const nums = variant.nums;
    const candidateScore = variant.score;

    const roi = getBlendedRoi(sourceGroup);
    const hit3 = getBlendedHit3Rate(sourceGroup);

    // ROI / hit3 硬門檻（ stats 已接入後的穩定版 ）
    const totalRounds = toNum(sourceGroup?.meta?.total_rounds, 0);

    if (totalRounds >= 20) {
      if (nextSlotNo === 1 && roi < -0.3) return false;
      if (nextSlotNo === 2 && roi < -0.4) return false;
      if (nextSlotNo === 3 && roi < -0.5) return false;
    }

    // 只對成熟策略做 hit3 限制，避免新策略全部被判死
    if (nextSlotNo <= 3 && totalRounds >= 10 && hit3 <= 0) {
      return false;
    }

    const tier = getCandidateTier(sourceGroup, candidateScore, slotRole, selection, phaseContext);
    const overlapTooHigh = groups.some((g) => countOverlap(nums, g?.nums || []) > MAX_GROUP_OVERLAP);

    const canUseStrategy = !strategyKey || currentStrategyCount < MAX_GROUPS_PER_STRATEGY;
    const canUseByTier = meetsMinTier(tier, requiredTier);
    const mustSpreadTopSlots = nextSlotNo <= 2;
    const violatesTopSpread = mustSpreadTopSlots && strategyKey && currentStrategyCount >= 1;

    const safeKey = `${sourceGroup.key}_${slotRole}_${nums.join('_')}`;
    if (usedKeys.has(safeKey)) return false;
    if (overlapTooHigh) return false;
    if (!canUseStrategy) return false;
    if (!canUseByTier) return false;
    if (violatesTopSpread) return false;

    groups.push({
      key: `${sourceGroup.key}_${slotRole}_${nextSlotNo}`,
      label: buildFormalLabel(slotRole, nextSlotNo, sourceGroup),
      nums,
      reason: `正式下注分工：${slotRole.toUpperCase()} / ${strategyModeLabel(selection.strategyMode)} / ${roleLabelOf(selection.riskMode)} / ${phaseContext.marketPhase} / ${phaseContext.lastHitLevel}`,
      meta: {
        ...buildFormalMeta(sourceGroup, slotRole, nextSlotNo, sourcePrediction, selection, phaseContext),
        decision_score: round4(candidateScore),
        decision_gate: getDecisionScoreFloor(slotRole, selection, phaseContext),
        roi_gate: getRecentRoiFloor(slotRole, selection, phaseContext),
        hit3_gate: getHit3RateFloor(slotRole, selection, phaseContext),
        blended_roi: getBlendedRoi(sourceGroup),
        blended_hit3_rate: getBlendedHit3Rate(sourceGroup),
        tier
      }
    });

    usedKeys.add(safeKey);
    if (strategyKey) {
      strategyUseCount.set(strategyKey, currentStrategyCount + 1);
    }

    return true;
  };

  for (let i = 0; i < roleOrdered.length && groups.length < GROUP_COUNT; i += 1) {
    const slot = roleOrdered[i];
    if (!slot?.group) continue;
    tryAddSlot(slot.group, slot.role || 'mix');
  }

  if (groups.length < GROUP_COUNT) {
    const fallbackRoles = getRiskOrder(selection.riskMode, phaseContext);
    const fallbackMatrix = [];

    for (const sourceGroup of sourceGroups) {
      const strategyKey = getStrategyKey(sourceGroup);
      const currentStrategyCount = toInt(strategyUseCount.get(strategyKey), 0);

      for (const role of fallbackRoles) {
        const baseScore = scoreGroupForMode(
          sourceGroup,
          role,
          selection.strategyMode,
          selection.riskMode,
          pools,
          phaseContext
        );
        const tier = getCandidateTier(sourceGroup, baseScore, role, selection, phaseContext);

        fallbackMatrix.push({
          sourceGroup,
          role,
          baseScore,
          tier,
          strategyKey,
          currentStrategyCount,
          totalRounds: toNum(sourceGroup?.meta?.total_rounds, 0),
          sourceTag: getSourceTag(sourceGroup)
        });
      }
    }

    fallbackMatrix
      .sort((a, b) => {
        const spreadPenaltyA = a.currentStrategyCount * 1500;
        const spreadPenaltyB = b.currentStrategyCount * 1500;
        const bonusA = candidateTierBonus(a.tier) - spreadPenaltyA + a.totalRounds;
        const bonusB = candidateTierBonus(b.tier) - spreadPenaltyB + b.totalRounds;
        return b.baseScore + bonusB - (a.baseScore + bonusA);
      })
      .forEach((matrixRow) => {
        if (groups.length >= GROUP_COUNT) return;
        tryAddSlot(matrixRow.sourceGroup, matrixRow.role);
      });
  }

  while (groups.length < GROUP_COUNT) {
    const fallbackRole = getRiskOrder(selection.riskMode, phaseContext)[groups.length] || 'mix';
    groups.push(
      buildFallbackGroup(
        fallbackRole,
        groups.length + 1,
        pools,
        selection,
        phaseContext,
        groups
      )
    );
  }

  return normalizeGroups(groups, sourceDraw).slice(0, GROUP_COUNT);
}

async function buildFormalPrediction(selection = {}, triggerSource = 'unknown') {
  const latestDraw = await getLatestDraw();
  const sourceDrawNo = String(latestDraw?.draw_no || '').trim();
  if (!sourceDrawNo) {
    throw new Error('最新期數不存在');
  }

  const existingRows = await getFormalRowsBySourceDrawNo(sourceDrawNo);
  if (existingRows.length >= FORMAL_BATCH_LIMIT) {
    return {
      ok: true,
      api_version: API_VERSION,
      mode: FORMAL_MODE,
      trigger_source: triggerSource,
      skipped: true,
      reason: `formal batch limit reached (${FORMAL_BATCH_LIMIT})`,
      latest_draw_no: sourceDrawNo,
      latest_draw_time: latestDraw?.draw_time || null,
      existing_count: existingRows.length,
      formal_batch_limit: FORMAL_BATCH_LIMIT
    };
  }

  const recentDraws = await getRecentDraws(selection.analysisPeriod || DEFAULT_ANALYSIS_PERIOD);
  const latestAnyTestPrediction = await getLatestAnyTestPrediction();
  const exactTestPrediction = await getLatestTestPredictionUpToSourceDraw(sourceDrawNo);
  const exactFormalCandidatePrediction = await getLatestFormalCandidateUpToSourceDraw(sourceDrawNo);
  const lastComparedPrediction = await getLatestComparedPredictionBeforeSource(sourceDrawNo);

  const sourcePrediction = chooseSourcePrediction(
    latestAnyTestPrediction,
    exactTestPrediction,
    exactFormalCandidatePrediction
  );

  if (!sourcePrediction) {
    throw new Error('找不到可用的來源預測（test / formal_candidate）');
  }

  const phaseContext = buildPhaseContext(sourcePrediction, lastComparedPrediction);

  const marketSnapshot =
    sourcePrediction?.market_snapshot_json && typeof sourcePrediction.market_snapshot_json === 'object'
      ? sourcePrediction.market_snapshot_json
      : safeJsonParse(sourcePrediction?.market_snapshot_json, {}) || {};

  const pools = buildMarketPools(recentDraws, marketSnapshot);

  const recentTestRows = await getRecentPredictionRowsByMode(TEST_MODE, 10);
  const recentFormalCandidateRows = await getRecentPredictionRowsByMode(FORMAL_CANDIDATE_MODE, 10);

  const predictionSourceGroups = collectSourceGroups(
    [
      sourcePrediction,
      ...recentFormalCandidateRows,
      ...recentTestRows
    ].filter(Boolean),
    latestDraw
  );

  const strategyPoolRows = await getStrategyPoolRows(120);
  const strategyPoolGroups = buildStrategyPoolGroups(
    strategyPoolRows,
    pools,
    selection,
    phaseContext,
    latestDraw
  );

  const rawSourceGroups = [
    ...predictionSourceGroups,
    ...strategyPoolGroups
  ];

  const strategyStatsRows = await getStrategyStatsRowsByKeys(
    rawSourceGroups.map((group) => getStrategyKey(group))
  );

  const sourceGroups = dedupeSourceGroups(
    mergeStrategyStatsIntoGroups(rawSourceGroups, strategyStatsRows)
  );

  if (!sourceGroups.length) {
    throw new Error('來源候選池為空，無法建立 formal');
  }

  const groups = buildFormalGroups(
    sourceGroups,
    sourcePrediction,
    latestDraw,
    selection,
    pools,
    phaseContext
  );

  if (!groups.length) {
    throw new Error('formal groups 建立失敗');
  }

  const insertPayload = {
    mode: FORMAL_MODE,
    status: 'created',
    source_draw_no: String(sourceDrawNo),
    target_periods: 1,
    groups_json: groups,
    latest_draw_numbers: JSON.stringify(parseNums(latestDraw?.numbers || [])),
    compare_result_json: null,
    compare_result: null,
    compared_history_json: [],
    compared_draw_count: 0,
    verdict: null,
    compared_at: null
  };

  const { data: inserted, error: insertError } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert(insertPayload)
    .select('*')
    .limit(1)
    .maybeSingle();

  if (insertError) throw insertError;

  return {
    ok: true,
    api_version: API_VERSION,
    mode: FORMAL_MODE,
    trigger_source: triggerSource,
    cost_per_group: COST_PER_GROUP,
    group_count: GROUP_COUNT,
    formal_batch_limit: FORMAL_BATCH_LIMIT,
    requested_selection: selection,
    skipped: false,
    reason: '',
    latest_draw_no: sourceDrawNo,
    latest_draw_time: latestDraw?.draw_time || null,
    source_draw_no: sourceDrawNo,
    formal_batch_no: existingRows.length + 1,
    existing_count: existingRows.length,
    source_prediction_id: sourcePrediction?.id || null,
    source_prediction_mode: sourcePrediction?.mode || null,
    source_prediction_draw_no: sourcePrediction?.source_draw_no || null,
    recent_draw_count: recentDraws.length,
    candidate_pool_size: sourceGroups.length,
    market_phase: phaseContext.marketPhase,
    last_hit_level: phaseContext.lastHitLevel,
    confidence_score: phaseContext.confidenceScore,
    weight_profile: phaseContext.weightProfile,
    prediction: {
      id: inserted?.id || null,
      mode: FORMAL_MODE,
      status: inserted?.status || 'created',
      source_draw_no: sourceDrawNo,
      target_periods: 1,
      group_count: groups.length,
      groups
    }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      api_version: API_VERSION,
      error: 'Method not allowed'
    });
  }

  try {
    const mode = getMode(req);
    const selection = getSelectionParams(req);
    const triggerSource = getTriggerSource(req);

    if (mode !== FORMAL_MODE) {
      return res.status(400).json({
        ok: false,
        api_version: API_VERSION,
        error: 'prediction-save 目前僅提供 formal 儲存'
      });
    }

    const result = await buildFormalPrediction(selection, triggerSource);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(200).json({
      ok: false,
      api_version: API_VERSION,
      error: error instanceof Error ? error.message : String(error || 'unknown error')
    });
  }
}
