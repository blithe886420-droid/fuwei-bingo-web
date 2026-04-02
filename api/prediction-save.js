import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-save-market-role-v10.3-candidate-expansion';

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
        []
    );
  }

  return [];
}

function parseGroupsJson(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  if (value && typeof value === 'object') {
    return Array.isArray(value) ? value : [];
  }

  return [];
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
    .slice(0, 40);
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
      req.headers['x-trigger-source'] ||
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

async function getRecentPredictionRowsByMode(mode, limitCount = 6) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', mode)
    .order('created_at', { ascending: false })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getLatestComparedPredictionBeforeSource(sourceDrawNo) {
  const safeSourceDrawNo = toNum(sourceDrawNo, 0);
  if (!safeSourceDrawNo) return null;

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .in('mode', [FORMAL_MODE, TEST_MODE])
    .eq('status', 'compared')
    .lt('source_draw_no', safeSourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function roleWeightOf(role = 'mix', weightProfile = {}) {
  if (role === 'attack') return toNum(weightProfile.attack, 1);
  if (role === 'extend') return toNum(weightProfile.extend, 1);
  if (role === 'guard') return toNum(weightProfile.guard, 1);
  if (role === 'recent') return toNum(weightProfile.recent, 1);
  return 1;
}

function inferLastHitLevel(lastComparedPrediction = null) {
  const hitCount = toInt(lastComparedPrediction?.hit_count, 0);
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
    profile.guard = 1.05;
  } else {
    profile.attack = 1.1;
    profile.guard = 0.95;
    profile.recent = 0.95;
  }

  if (lastHitLevel === 'good') {
    profile.attack += 0.05;
    profile.extend += 0.05;
  } else if (lastHitLevel === 'bad') {
    profile.attack -= 0.1;
    profile.guard += 0.1;
    profile.extend += 0.05;
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
      : {};

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
  return qualityScore >= 18;
}

function pickFromPool(pool = [], selectedSet = new Set(), seed = 0) {
  const candidates = uniqueAsc(pool).filter((n) => !selectedSet.has(n));
  if (!candidates.length) return null;
  const index = Math.abs(toNum(seed, 0) * 7 + candidates.length * 3) % candidates.length;
  return candidates[index];
}

function fillToFour(base = [], fallbackPools = [], seed = 0, pools = {}, role = 'mix', selection = {}, phaseContext = null) {
  const initial = uniqueAsc(base).slice(0, 4);
  const selected = new Set(initial);
  const mergedPools = Array.isArray(fallbackPools) ? fallbackPools : [];
  let cursor = 0;

  while (selected.size < 4 && cursor < 320) {
    let picked = null;

    for (let i = 0; i < mergedPools.length; i += 1) {
      const value = pickFromPool(mergedPools[i], selected, seed + cursor + i * 13);
      cursor += 1;
      if (value == null) continue;

      const next = uniqueAsc([...selected, value]).slice(0, 4);
      if (next.length < 4 || isAcceptableGroup(next, pools, role, selection, phaseContext)) {
        picked = value;
        break;
      }
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

function forceGroupDifference(nums = [], existingGroups = [], pools = {}, seed = 0, role = 'mix', selection = {}, phaseContext = null) {
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

  for (let round = 0; round < 8; round += 1) {
    const overlapTooHigh = existingGroups.some((group) => countOverlap(result, group?.nums || []) >= 3);
    if (!overlapTooHigh) break;
    const keep = result.slice(0, 2);
    result = fillToFour(keep, backupPools, seed + round * 17 + 3, pools, role, selection, phaseContext);
  }

  return uniqueAsc(result).slice(0, 4);
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
  if (role === 'attack') floor = 1;
  if (role === 'extend') floor = 1;
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

function getCandidateTier(sourceGroup, score, role, selection, phaseContext) {
  const meta = sourceGroup?.meta && typeof sourceGroup.meta === 'object' ? sourceGroup.meta : {};
  const blendedRoi = getBlendedRoi(sourceGroup);
  const blendedHit3Rate = getBlendedHit3Rate(sourceGroup);
  const totalRounds = toNum(meta.total_rounds, 0);
  const t = getTierThresholds(role, selection, phaseContext);

  const passA =
    Number.isFinite(score) &&
    score >= t.decisionGate &&
    blendedRoi >= t.roiGate &&
    blendedHit3Rate >= t.hit3Gate &&
    (role === 'attack' || totalRounds >= t.stabilityGate);

  if (passA) return 'A';

  const passB =
    Number.isFinite(score) &&
    score >= t.decisionGateB &&
    blendedRoi >= t.roiGateB &&
    blendedHit3Rate >= t.hit3GateB &&
    (role === 'attack' || totalRounds >= t.stabilityGateB);

  if (passB) return 'B';
  return 'C';
}

function candidateTierBonus(tier = 'C') {
  if (tier === 'A') return 100000;
  if (tier === 'B') return 1000;
  return 0;
}

function getStrategyKey(group = {}) {
  return String(group?.meta?.strategy_key || group?.key || '').trim();
}

function evaluateFormalCandidateScore(sourceGroup, nums, role, selection, pools, phaseContext, existingGroups = []) {
  const meta = sourceGroup?.meta && typeof sourceGroup.meta === 'object' ? sourceGroup.meta : {};
  const report = buildGroupQualityReport(nums, pools);
  let score = scoreQualityReport(report, role, selection, phaseContext);

  score += toNum(meta.score, 0) * 0.35;
  score += Math.max(-120, getBlendedRoi(sourceGroup) * 240);
  score += getBlendedHit3Rate(sourceGroup) * 1000;
  score += toNum(meta.hit2_rate, 0) * 90;
  score += Math.min(50, toNum(meta.total_rounds, 0));
  score *= roleWeightOf(role, phaseContext?.weightProfile || {});

  for (const group of existingGroups) {
    const overlap = countOverlap(nums, group?.nums || []);
    if (overlap >= 3) score -= 180;
    else if (overlap === 2) score -= 40;
  }

  return round4(score);
}

function scoreGroupForMode(group, role, strategyMode, riskMode, pools, phaseContext) {
  const nums = uniqueAsc(group?.nums || []);
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const key = String(meta.strategy_key || group?.key || '').toLowerCase();
  const report = buildGroupQualityReport(nums, pools);
  let score = scoreQualityReport(report, role, { strategyMode, riskMode }, phaseContext);

  const hotCount = report.hotCount;
  const extendCount = report.extendCount;
  const guardCount = report.guardCount;
  const gapCount = report.gapCount;
  const recentCount = nums.filter((n) => (pools.recent || []).slice(0, 18).includes(n)).length;
  const coldCount = nums.filter((n) => (pools.cold || []).slice(0, 18).includes(n)).length;

  if (role === 'attack') score += report.attackCount * 18 + hotCount * 6;
  if (role === 'extend') score += extendCount * 18 + gapCount * 5;
  if (role === 'guard') score += guardCount * 18 + coldCount * 2;
  if (role === 'recent') score += recentCount * 18 + hotCount * 4;

  if (strategyMode === 'hot') {
    score += hotCount * 12;
    if (key.includes('hot') || key.includes('repeat')) score += 20;
  } else if (strategyMode === 'cold') {
    score += coldCount * 12 + gapCount * 6;
    if (key.includes('cold') || key.includes('gap') || key.includes('guard')) score += 20;
  } else if (strategyMode === 'burst') {
    score += report.attackCount * 8 + gapCount * 10 + recentCount * 6;
    if (key.includes('gap') || key.includes('tail') || key.includes('zone')) score += 18;
  } else {
    score += report.attackCount * 6 + extendCount * 6 + guardCount * 6;
  }

  if (riskMode === 'safe' && (role === 'guard' || role === 'extend')) score += 10;
  if (riskMode === 'aggressive' && role === 'attack') score += 10;
  if (riskMode === 'sniper' && (role === 'attack' || role === 'recent')) score += 10;

  score *= roleWeightOf(role, phaseContext?.weightProfile || {});

  if (phaseContext?.marketPhase === 'rotation') {
    if (role === 'attack') score -= 20;
    if (role === 'extend') score += 12;
    if (role === 'guard') score += 12;
    if (role === 'recent') score += 8;
  }

  if (phaseContext?.marketPhase === 'continuation') {
    if (role === 'attack') score += 18;
    if (role === 'recent') score -= 6;
  }

  return round4(score);
}

function mergeCandidateSources(sourceDraw, sourcePrediction, fallbackTest, formalCandidateRows = [], recentTestRows = [], recentCandidateRows = []) {
  const seen = new Set();
  const merged = [];

  function pushGroupsFromRow(row, sourceTag) {
    if (!row) return;
    const groups = normalizeGroups(parseGroupsJson(row.groups_json), sourceDraw);
    for (const group of groups) {
      const strategyKey = getStrategyKey(group);
      const numsKey = uniqueAsc(group.nums || []).join(',');
      const mergeKey = `${strategyKey}__${numsKey}`;
      if (seen.has(mergeKey)) continue;
      seen.add(mergeKey);

      merged.push({
        ...group,
        meta: {
          ...(group.meta || {}),
          source_tag: sourceTag,
          source_prediction_id: row.id || null,
          source_prediction_mode: row.mode || null
        }
      });
    }
  }

  pushGroupsFromRow(sourcePrediction, 'primary_test');
  pushGroupsFromRow(fallbackTest, 'fallback_test');

  for (const row of formalCandidateRows) pushGroupsFromRow(row, 'formal_candidate');
  for (const row of recentTestRows) pushGroupsFromRow(row, 'recent_test');
  for (const row of recentCandidateRows) pushGroupsFromRow(row, 'recent_formal_candidate');

  return merged;
}

function chooseRoleOrderedGroups(sourceGroups = [], selection = {}, pools = {}, phaseContext = null) {
  const roles = getRiskOrder(selection.riskMode, phaseContext);
  const ranked = sourceGroups
    .map((group) => ({
      group,
      inferredRole: inferRoleFromGroup(group)
    }))
    .sort((a, b) => {
      const scoreA = scoreGroupForMode(a.group, roles[0], selection.strategyMode, selection.riskMode, pools, phaseContext);
      const scoreB = scoreGroupForMode(b.group, roles[0], selection.strategyMode, selection.riskMode, pools, phaseContext);
      return scoreB - scoreA;
    });

  const usedIndexes = new Set();
  const picked = [];
  const strategyUseCount = new Map();

  for (let i = 0; i < roles.length; i += 1) {
    const role = roles[i];
    let bestIdx = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestTier = 'C';

    for (let j = 0; j < ranked.length; j += 1) {
      if (usedIndexes.has(j)) continue;

      const rankedRow = ranked[j];
      const strategyKey = getStrategyKey(rankedRow.group);
      const usedCount = toInt(strategyUseCount.get(strategyKey), 0);
      if (strategyKey && usedCount >= MAX_GROUPS_PER_STRATEGY) continue;

      const score = scoreGroupForMode(
        rankedRow.group,
        role,
        selection.strategyMode,
        selection.riskMode,
        pools,
        phaseContext
      );
      const tier = getCandidateTier(rankedRow.group, score, role, selection, phaseContext);
      if (tier === 'C') continue;

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

      const role = roles[picked.length] || 'mix';
      const rankedRow = ranked[j];
      const strategyKey = getStrategyKey(rankedRow.group);
      const usedCount = toInt(strategyUseCount.get(strategyKey), 0);
      if (strategyKey && usedCount >= MAX_GROUPS_PER_STRATEGY) continue;

      const score = scoreGroupForMode(
        rankedRow.group,
        role,
        selection.strategyMode,
        selection.riskMode,
        pools,
        phaseContext
      );
      const tier = getCandidateTier(rankedRow.group, score, role, selection, phaseContext);
      if (tier === 'C') continue;

      usedIndexes.add(j);
      if (strategyKey) {
        strategyUseCount.set(strategyKey, usedCount + 1);
      }

      picked.push({
        role,
        group: rankedRow.group,
        role_decision_score: score,
        tier
      });
    }
  }

  return picked.slice(0, GROUP_COUNT);
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

    const score =
      evaluateFormalCandidateScore(
        sourceGroup,
        safeNums,
        slotRole,
        selection,
        pools,
        phaseContext,
        existingGroups
      ) + extraScore;

    const tier = getCandidateTier(sourceGroup, score, slotRole, selection, phaseContext);
    if (tier === 'C') return;

    const key = safeNums.join(',');
    const prev = candidateMap.get(key);
    if (!prev || score > prev.score) {
      candidateMap.set(key, {
        nums: safeNums,
        score,
        tag,
        sourceGroup,
        tier
      });
    }
  };

  addCandidate(fillToFour(keepNums, fallbackPools, seedBase, pools, slotRole, selection, phaseContext), 'keep_base', 0);

  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();
  const lastHitLevel = String(phaseContext?.lastHitLevel || '').toLowerCase();

  if (slotRole === 'attack' && marketPhase === 'continuation') {
    addCandidate(
      fillToFour(
        uniqueAsc([...keepNums, ...(pools.attack || []).slice(0, lastHitLevel === 'good' ? 4 : 3)]),
        fallbackPools,
        seedBase + 19,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      'attack_continuation',
      14
    );
  }

  if (slotRole === 'attack' && marketPhase === 'rotation') {
    addCandidate(
      fillToFour(
        uniqueAsc([...keepNums.slice(0, 1), ...(pools.extend || []).slice(0, 2), ...(pools.guard || []).slice(0, 2)]),
        [pools.extend, pools.guard, pools.recent, pools.qualityAll, pools.all],
        seedBase + 21,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      'attack_rotation',
      12
    );
  }

  if (slotRole === 'extend') {
    addCandidate(
      fillToFour(
        uniqueAsc([...keepNums, ...(pools.extend || []).slice(0, 4), ...(pools.gap || []).slice(0, 3)]),
        [pools.extend, pools.guard, pools.hot10, pools.qualityAll, pools.all],
        seedBase + 29,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      'extend_focus',
      10
    );
  }

  if (slotRole === 'guard') {
    addCandidate(
      fillToFour(
        uniqueAsc([...keepNums, ...(pools.guard || []).slice(0, 4), ...(pools.hot20 || []).slice(0, 3)]),
        [pools.guard, pools.hot20, pools.warm, pools.qualityAll, pools.all],
        seedBase + 37,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      'guard_focus',
      9
    );
  }

  if (slotRole === 'recent') {
    addCandidate(
      fillToFour(
        uniqueAsc([...keepNums, ...(pools.recent || []).slice(0, 4), ...(pools.hot5 || []).slice(0, 3)]),
        [pools.recent, pools.extend, pools.hot5, pools.qualityAll, pools.all],
        seedBase + 43,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      'recent_focus',
      8
    );
  }

  for (let i = 0; i < 8; i += 1) {
    addCandidate(
      fillToFour(
        keepNums,
        [...fallbackPools, pools.qualityAll, pools.all],
        seedBase + 101 + i * 37,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      `dynamic_${i + 1}`,
      0
    );
  }

  const ranked = [...candidateMap.values()]
    .map((candidateRow) => {
      const adjustedNums = forceGroupDifference(
        candidateRow.nums,
        existingGroups,
        pools,
        seedBase + candidateRow.score,
        slotRole,
        selection,
        phaseContext
      );

      const nextScore = evaluateFormalCandidateScore(
        candidateRow.sourceGroup,
        adjustedNums,
        slotRole,
        selection,
        pools,
        phaseContext,
        existingGroups
      );

      return {
        ...candidateRow,
        nums: adjustedNums,
        score: nextScore,
        tier: getCandidateTier(candidateRow.sourceGroup, nextScore, slotRole, selection, phaseContext)
      };
    })
    .filter((candidateRow) => candidateRow.tier !== 'C')
    .sort((a, b) => {
      const bonusA = candidateTierBonus(a.tier);
      const bonusB = candidateTierBonus(b.tier);
      return b.score + bonusB - (a.score + bonusA);
    });

  if (!ranked.length) return [];

  const bestA = ranked.find((row) => row.tier === 'A');
  if (bestA) return uniqueAsc(bestA.nums).slice(0, 4);

  return uniqueAsc(ranked[0].nums).slice(0, 4);
}

function buildFormalLabel(slotRole, slotNo, sourceGroup) {
  const roleText =
    slotRole === 'attack'
      ? 'ATTACK'
      : slotRole === 'extend'
        ? 'EXTEND'
        : slotRole === 'guard'
          ? 'GUARD'
          : slotRole === 'recent'
            ? 'RECENT'
            : 'MIX';

  const name =
    sourceGroup?.meta?.strategy_name ||
    sourceGroup?.label ||
    sourceGroup?.key ||
    `Group ${slotNo}`;

  return `${roleText}-${slotNo}｜${name}`;
}

function buildFormalMeta(sourceGroup, slotRole, slotNo, sourceRow, selection, phaseContext = null) {
  const sourceMeta = sourceGroup?.meta && typeof sourceGroup.meta === 'object' ? sourceGroup.meta : {};
  const weightProfile = phaseContext?.weightProfile || {};

  return {
    ...sourceMeta,
    strategy_key: String(sourceMeta.strategy_key || sourceGroup?.key || `group_${slotNo}`),
    strategy_name: String(
      sourceMeta.strategy_name || sourceGroup?.label || sourceGroup?.key || `第${slotNo}組`
    ),
    preferred_role: slotRole,
    role_slot_no: slotNo,
    requested_strategy_mode: selection.strategyMode,
    requested_risk_mode: selection.riskMode,
    requested_analysis_period: selection.analysisPeriod,
    source_prediction_id: sourceRow?.id || null,
    source_prediction_mode: sourceRow?.mode || TEST_MODE,
    source_selection_rank: toNum(sourceMeta.selection_rank, slotNo),
    bet_amount: COST_PER_GROUP,
    decision: 'market_role_formal_v10_3_candidate_expansion',
    market_phase: phaseContext?.marketPhase || 'rotation',
    last_hit_level: phaseContext?.lastHitLevel || 'neutral',
    confidence_score: toNum(phaseContext?.confidenceScore, 0),
    weight_profile: weightProfile,
    role_weight: roleWeightOf(slotRole, weightProfile),
    quality_engine: 'v10.3-expansion',
    strategy_spread_limit: MAX_GROUPS_PER_STRATEGY
  };
}

async function buildFormalGroups(sourceDraw, selection) {
  const sourceDrawNo = toNum(sourceDraw?.draw_no, 0);
  const recentDraws = await getRecentDraws(selection.analysisPeriod);

  const latestSameSourceTest = sourceDrawNo
    ? await getLatestTestPredictionUpToSourceDraw(sourceDrawNo)
    : null;

  const latestSameSourceCandidate = sourceDrawNo
    ? await getLatestFormalCandidateUpToSourceDraw(sourceDrawNo)
    : null;

  const fallbackTest = latestSameSourceTest ? null : await getLatestAnyTestPrediction();
  const recentTestRows = await getRecentPredictionRowsByMode(TEST_MODE, 6);
  const recentCandidateRows = await getRecentPredictionRowsByMode(FORMAL_CANDIDATE_MODE, 6);

  const sourcePrediction = latestSameSourceTest || fallbackTest || latestSameSourceCandidate || null;

  if (!sourcePrediction?.id) {
    throw new Error('找不到可用的 test prediction，請先讓 auto-train 建立最新 test prediction');
  }

  const sourceGroups = mergeCandidateSources(
    sourceDraw,
    sourcePrediction,
    fallbackTest,
    latestSameSourceCandidate ? [latestSameSourceCandidate] : [],
    recentTestRows,
    recentCandidateRows
  );

  if (!sourceGroups.length) {
    throw new Error('候選池建立失敗：找不到可用四碼群組');
  }

  const marketSnapshot =
    sourcePrediction?.market_snapshot_json && typeof sourcePrediction.market_snapshot_json === 'object'
      ? sourcePrediction.market_snapshot_json
      : {};

  const lastComparedPrediction = await getLatestComparedPredictionBeforeSource(sourceDrawNo);
  const phaseContext = buildPhaseContext(sourcePrediction, lastComparedPrediction);
  const pools = buildMarketPools(recentDraws, marketSnapshot);
  const roleOrdered = chooseRoleOrderedGroups(sourceGroups, selection, pools, phaseContext);

  const groups = [];
  const usedKeys = new Set();
  const strategyUseCount = new Map();

  const tryAddSlot = (sourceGroup, slotRole) => {
    const strategyKey = getStrategyKey(sourceGroup);
    const currentStrategyCount = toInt(strategyUseCount.get(strategyKey), 0);

    if (strategyKey && currentStrategyCount >= MAX_GROUPS_PER_STRATEGY) return false;

    const nums = buildVariantFromSourceGroup(
      sourceGroup,
      slotRole,
      groups.length + 1,
      pools,
      groups,
      selection,
      phaseContext
    );

    if (!Array.isArray(nums) || nums.length !== 4) return false;

    const candidateScore = evaluateFormalCandidateScore(
      sourceGroup,
      nums,
      slotRole,
      selection,
      pools,
      phaseContext,
      groups
    );

    const tier = getCandidateTier(sourceGroup, candidateScore, slotRole, selection, phaseContext);
    if (tier === 'C') return false;

    const safeKey = `${sourceGroup.key}_${slotRole}_${nums.join('_')}`;
    const overlapTooHigh = groups.some((g) => countOverlap(nums, g?.nums || []) >= 3);
    if (usedKeys.has(safeKey) || overlapTooHigh) return false;

    groups.push({
      key: `${sourceGroup.key}_${slotRole}_${groups.length + 1}`,
      label: buildFormalLabel(slotRole, groups.length + 1, sourceGroup),
      nums,
      reason: `正式下注分工：${slotRole.toUpperCase()} / ${strategyModeLabel(selection.strategyMode)} / ${roleLabelOf(selection.riskMode)} / ${phaseContext.marketPhase} / ${phaseContext.lastHitLevel}`,
      meta: {
        ...buildFormalMeta(sourceGroup, slotRole, groups.length + 1, sourcePrediction, selection, phaseContext),
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
      if (strategyKey && currentStrategyCount >= MAX_GROUPS_PER_STRATEGY) continue;

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
        if (tier === 'C') continue;

        fallbackMatrix.push({
          sourceGroup,
          role,
          baseScore,
          tier,
          strategyKey,
          currentStrategyCount
        });
      }
    }

    fallbackMatrix
      .sort((a, b) => {
        const spreadPenaltyA = a.currentStrategyCount * 1500;
        const spreadPenaltyB = b.currentStrategyCount * 1500;
        const bonusA = candidateTierBonus(a.tier) - spreadPenaltyA;
        const bonusB = candidateTierBonus(b.tier) - spreadPenaltyB;
        return b.baseScore + bonusB - (a.baseScore + bonusA);
      })
      .forEach((matrixRow) => {
        if (groups.length >= GROUP_COUNT) return;
        tryAddSlot(matrixRow.sourceGroup, matrixRow.role);
      });
  }

  const finalGroups = normalizeGroups(groups, sourceDraw)
    .map((group) => {
      const role = inferRoleFromGroup(group);
      const score = evaluateFormalCandidateScore(
        group,
        group?.nums || [],
        role,
        selection,
        pools,
        phaseContext,
        []
      );
      const tier = getCandidateTier(group, score, role, selection, phaseContext);
      return {
        ...group,
        meta: {
          ...(group.meta || {}),
          decision_score: round4(score),
          blended_roi: getBlendedRoi(group),
          blended_hit3_rate: getBlendedHit3Rate(group),
          tier
        }
      };
    })
    .filter((group) => String(group?.meta?.tier || 'C') !== 'C')
    .slice(0, GROUP_COUNT);

  const finalTierACount = finalGroups.filter((g) => String(g?.meta?.tier || '') === 'A').length;
  const finalStrategyCounts = new Map();

  for (const group of finalGroups) {
    const strategyKey = getStrategyKey(group);
    if (!strategyKey) continue;
    finalStrategyCounts.set(strategyKey, toInt(finalStrategyCounts.get(strategyKey), 0) + 1);
  }

  const overLimitStrategy = [...finalStrategyCounts.entries()].find(
    ([, count]) => count > MAX_GROUPS_PER_STRATEGY
  );

  if (finalGroups.length !== GROUP_COUNT) {
    throw new Error('正式下注分工四組建立失敗：候選池擴容後 A/B 級可用組數仍不足 4 組');
  }

  if (finalTierACount < 2) {
    throw new Error('正式下注分工四組建立失敗：A 級策略不足 2 組，已停止出單');
  }

  if (overLimitStrategy) {
    throw new Error(`正式下注分工四組建立失敗：策略分散限制未通過（${overLimitStrategy[0]} 超過 ${MAX_GROUPS_PER_STRATEGY} 組）`);
  }

  return {
    groups: finalGroups,
    recentDrawCount: recentDraws.length,
    sourcePredictionId: sourcePrediction.id,
    sourcePredictionMode: sourcePrediction.mode || TEST_MODE,
    sourcePredictionDrawNo: toNum(sourcePrediction.source_draw_no, 0),
    marketSnapshot,
    phaseContext,
    candidatePoolSize: sourceGroups.length
  };
}

async function createFormalPrediction(selection, triggerSource = 'unknown') {
  const latestDraw = await getLatestDraw();
  const sourceDrawNo = toNum(latestDraw?.draw_no, 0);

  if (!sourceDrawNo) {
    throw new Error('找不到可用 source_draw_no');
  }

  const existingRows = await getFormalRowsBySourceDrawNo(sourceDrawNo);

  if (existingRows.length >= FORMAL_BATCH_LIMIT) {
    return {
      ok: true,
      api_version: API_VERSION,
      mode: FORMAL_MODE,
      trigger_source: triggerSource,
      cost_per_group: COST_PER_GROUP,
      group_count: GROUP_COUNT,
      formal_batch_limit: FORMAL_BATCH_LIMIT,
      requested_selection: selection,
      skipped: true,
      reason: '本期 formal 批次已達上限',
      latest_draw_no: sourceDrawNo,
      latest_draw_time: latestDraw?.draw_time || null,
      source_draw_no: sourceDrawNo,
      formal_batch_no: existingRows.length,
      existing_count: existingRows.length,
      prediction: null
    };
  }

  const built = await buildFormalGroups(latestDraw, selection);

  const insertPayload = {
    mode: FORMAL_MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: 1,
    groups_json: built.groups,
    market_snapshot_json: built.marketSnapshot,
    market_phase: built.phaseContext.marketPhase,
    last_hit_level: built.phaseContext.lastHitLevel,
    confidence_score: built.phaseContext.confidenceScore,
    weight_profile: built.phaseContext.weightProfile,
    created_at: new Date().toISOString()
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
    source_prediction_id: built.sourcePredictionId,
    source_prediction_mode: built.sourcePredictionMode,
    source_prediction_draw_no: built.sourcePredictionDrawNo,
    recent_draw_count: built.recentDrawCount,
    candidate_pool_size: built.candidatePoolSize,
    market_phase: built.phaseContext.marketPhase,
    last_hit_level: built.phaseContext.lastHitLevel,
    confidence_score: built.phaseContext.confidenceScore,
    weight_profile: built.phaseContext.weightProfile,
    prediction: {
      id: inserted?.id || null,
      mode: FORMAL_MODE,
      status: inserted?.status || 'created',
      source_draw_no: sourceDrawNo,
      target_periods: 1,
      group_count: built.groups.length,
      groups: built.groups
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

    const result = await createFormalPrediction(selection, triggerSource);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(200).json({
      ok: false,
      api_version: API_VERSION,
      error: error instanceof Error ? error.message : String(error || 'unknown error')
    });
  }
}
