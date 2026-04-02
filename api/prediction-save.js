import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-save-market-role-v10-roi-hit-gate';

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

const DEFAULT_ANALYSIS_PERIOD = 20;
const ALLOWED_ANALYSIS_PERIODS = new Set([5, 10, 20, 50]);
const ALLOWED_STRATEGY_MODES = new Set(['hot', 'cold', 'mix', 'burst']);
const ALLOWED_RISK_MODES = new Set(['safe', 'balanced', 'aggressive', 'sniper']);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return fallback;
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
  const strategyKey = String(
    sourceMeta.strategy_key || group.key || `group_${idx + 1}`
  ).trim();
  const strategyName = String(
    sourceMeta.strategy_name || group.label || group.key || `策略 ${idx + 1}`
  ).trim();

  return {
    key: strategyKey,
    label: String(group.label || strategyName).trim(),
    nums,
    reason:
      group.reason ||
      `正式下注採用最新 test 模擬前 ${idx + 1} 名策略（單期 / 每組 ${COST_PER_GROUP} 元）`,
    meta: {
      ...sourceMeta,
      strategy_key: strategyKey,
      strategy_name: strategyName,
      selection_rank: toNum(sourceMeta.selection_rank, idx + 1),
      source_draw_no: toNum(sourceDraw?.draw_no, 0),
      source_draw_time: sourceDraw?.draw_time || null,
      bet_amount: COST_PER_GROUP,
      decision: sourceMeta.decision || 'from_latest_test_prediction'
    }
  };
}

function normalizeGroups(groups = [], sourceDraw = null) {
  return (Array.isArray(groups) ? groups : [])
    .map((group, idx) => normalizeGroup(group, idx, sourceDraw))
    .filter(Boolean)
    .slice(0, 12);
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

function isManualFormalRequest(req) {
  const body = getBody(req);
  const bodyManual = toBool(body?.manual, false);
  const queryManual = toBool(req.query?.manual, false);
  const headerManual = toBool(req.headers['x-manual-formal-save'], false);

  return bodyManual || queryManual || headerManual;
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

async function getLatestFormalRow() {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, created_at, source_draw_no, mode, status')
    .eq('mode', FORMAL_MODE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function resolveFormalSourceDraw(latestDraw) {
  const latestSourceDrawNo = toNum(latestDraw?.draw_no, 0);

  return {
    sourceDrawNo: latestSourceDrawNo,
    batchCount: 0,
    nextBatchNo: 1,
    usingExistingBatch: false
  };
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


function buildMarketPools(drawRows = [], marketSnapshot = {}) {
  const rows = Array.isArray(drawRows) ? drawRows : [];
  const allNums = Array.from({ length: 80 }, (_, i) => i + 1);

  const freqMap = new Map();
  const lastSeen = new Map();
  const recentBoost = new Map();

  allNums.forEach((n) => {
    freqMap.set(n, 0);
    recentBoost.set(n, 0);
  });

  rows.forEach((row, idx) => {
    const nums = parseNums(row?.numbers);
    nums.forEach((n) => {
      freqMap.set(n, toNum(freqMap.get(n), 0) + 1);
      recentBoost.set(n, toNum(recentBoost.get(n), 0) + Math.max(0, 12 - idx));
      if (!lastSeen.has(n)) {
        lastSeen.set(n, idx);
      }
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
  const odd = allNums.filter((n) => n % 2 === 1);
  const even = allNums.filter((n) => n % 2 === 0);
  const low = allNums.filter((n) => n <= 20);
  const mid = allNums.filter((n) => n >= 21 && n <= 60);
  const high = allNums.filter((n) => n >= 61);

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
    odd,
    even,
    low,
    mid,
    high,
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
    qualityAll,
    freqMap,
    recentBoost
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
  const evenCount = arr.length - oddCount;
  const sum = arr.reduce((acc, n) => acc + n, 0);
  const span = arr.length ? arr[arr.length - 1] - arr[0] : 0;
  const tailKinds = new Set(arr.map((n) => n % 10)).size;
  const zoneKinds = new Set(arr.map((n) => getZoneBucket(n))).size;
  const consecutivePairs = countConsecutivePairs(arr);
  const lowCount = arr.filter((n) => n <= 20).length;
  const highCount = arr.filter((n) => n >= 61).length;
  const hotCount = arr.filter((n) => (pools.hot || []).slice(0, 20).includes(n)).length;
  const attackCount = arr.filter((n) => (pools.attack || []).slice(0, 18).includes(n)).length;
  const extendCount = arr.filter((n) => (pools.extend || []).slice(0, 18).includes(n)).length;
  const guardCount = arr.filter((n) => (pools.guard || []).slice(0, 18).includes(n)).length;
  const gapCount = arr.filter((n) => (pools.gap || []).slice(0, 18).includes(n)).length;

  return {
    nums: arr,
    oddCount,
    evenCount,
    sum,
    span,
    tailKinds,
    zoneKinds,
    consecutivePairs,
    lowCount,
    highCount,
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

  if (report.lowCount <= 2) score += 3;
  if (report.highCount <= 2) score += 3;
  if (report.lowCount >= 3 && report.nums[0] <= 12) score -= 15;
  if (report.highCount >= 3 && report.nums[0] >= 58) score -= 12;

  if (role === 'attack') {
    score += report.attackCount * 8 + report.hotCount * 4;
  } else if (role === 'extend') {
    score += report.extendCount * 7 + report.gapCount * 5;
  } else if (role === 'guard') {
    score += report.guardCount * 7 + report.hotCount * 3;
  } else if (role === 'recent') {
    score += report.hotCount * 4 + report.extendCount * 4;
  } else {
    score += report.hotCount * 3 + report.extendCount * 3 + report.guardCount * 3;
  }

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
  if (report.zoneKinds <= 1 && role !== 'guard') return false;
  if (report.lowCount >= 3 && arr[0] <= 12) return false;

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

  const chooseCandidate = () => {
    for (let i = 0; i < mergedPools.length; i += 1) {
      const value = pickFromPool(mergedPools[i], selected, seed + cursor + i * 13);
      cursor += 1;
      if (value == null) continue;

      const next = uniqueAsc([...selected, value]).slice(0, 4);
      if (next.length < 4) {
        const partial = buildGroupQualityReport(next, pools);
        if (partial.consecutivePairs <= 1) return value;
        continue;
      }

      if (isAcceptableGroup(next, pools, role, selection, phaseContext)) {
        return value;
      }
    }
    return null;
  };

  while (selected.size < 4 && cursor < 320) {
    const value = chooseCandidate();
    if (value == null) break;
    selected.add(value);
  }

  if (selected.size < 4) {
    const backupOrder = uniqueAsc([
      ...(pools.qualityAll || []),
      ...(pools.hot || []).slice(0, 24),
      ...(pools.extend || []).slice(0, 20),
      ...(pools.guard || []).slice(0, 20),
      ...(pools.gap || []).slice(0, 16),
      ...(pools.all || [])
    ]);

    while (selected.size < 4 && cursor < 520) {
      const value = pickFromPool(backupOrder, selected, seed + cursor + 97);
      cursor += 1;
      if (value == null) break;

      const next = uniqueAsc([...selected, value]).slice(0, 4);
      if (next.length < 4 || isAcceptableGroup(next, pools, role, selection, phaseContext)) {
        selected.add(value);
      }
    }
  }

  const finalNums = uniqueAsc([...selected]).slice(0, 4);
  if (finalNums.length === 4) return finalNums;
  return uniqueAsc(base).slice(0, 4);
}

function countOverlap(a = [], b = []) {
  const setB = new Set(uniqueAsc(b));
  return uniqueAsc(a).filter((n) => setB.has(n)).length;
}

function mutateOne(nums = [], pools = [], seed = 0, role = 'mix', allPools = {}, selection = {}, phaseContext = null) {
  const current = uniqueAsc(nums).slice(0, 4);
  if (current.length !== 4) return current;

  let best = current;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let removeIndex = 0; removeIndex < current.length; removeIndex += 1) {
    const base = current.filter((_, idx) => idx !== removeIndex);
    const selected = new Set(base);

    for (let i = 0; i < pools.length; i += 1) {
      const value = pickFromPool(pools[i], selected, seed + removeIndex * 31 + i * 17 + 3);
      if (value == null) continue;

      const candidate = uniqueAsc([...base, value]).slice(0, 4);
      if (!isAcceptableGroup(candidate, allPools, role, selection, phaseContext)) continue;

      const report = buildGroupQualityReport(candidate, allPools);
      const score = scoreQualityReport(report, role, selection, phaseContext);

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

  return uniqueAsc(best).slice(0, 4);
}

function forceGroupDifference(nums = [], existingGroups = [], pools = {}, seed = 0, role = 'mix', selection = {}, phaseContext = null) {
  let result = uniqueAsc(nums).slice(0, 4);
  const poolOrder = [
    pools.attack,
    pools.extend,
    pools.guard,
    pools.recent,
    pools.hot,
    pools.gap,
    pools.warm,
    pools.qualityAll,
    pools.all
  ];

  for (let round = 0; round < 12; round += 1) {
    let changed = false;

    for (const group of existingGroups) {
      const overlap = countOverlap(result, group?.nums || []);
      if (overlap >= 3) {
        result = mutateOne(result, poolOrder, seed + round * 23 + overlap, role, pools, selection, phaseContext);
        changed = true;
        break;
      }
    }

    if (!changed) break;
  }

  if (!isAcceptableGroup(result, pools, role, selection, phaseContext)) {
    result = fillToFour([], poolOrder, seed + 211, pools, role, selection, phaseContext);
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

  if (riskMode === 'safe') {
    return ['guard', 'extend', 'attack', 'recent'];
  }
  if (riskMode === 'balanced') {
    return ['attack', 'extend', 'guard', 'recent'];
  }
  if (riskMode === 'aggressive') {
    return ['attack', 'attack', 'extend', 'recent'];
  }
  return ['attack', 'recent', 'extend', 'guard'];
}

function inferRoleFromGroup(group = {}) {
  const key = String(group?.meta?.strategy_key || group?.key || '').toLowerCase();
  const label = String(group?.label || '').toLowerCase();
  const preferredRole = String(group?.meta?.preferred_role || '').toLowerCase();
  const focusBucket = String(group?.meta?.focus_bucket || '').toLowerCase();
  const marketReason = String(group?.meta?.market_reason || '').toLowerCase();

  if (preferredRole) return preferredRole;
  if (label.startsWith('attack｜') || label.startsWith('attack-')) return 'attack';
  if (label.startsWith('extend｜') || label.startsWith('extend-')) return 'extend';
  if (label.startsWith('guard｜') || label.startsWith('guard-')) return 'guard';
  if (label.startsWith('recent｜') || label.startsWith('recent-')) return 'recent';

  if (focusBucket === 'top1') return 'attack';
  if (focusBucket === 'top2') return 'extend';
  if (focusBucket === 'top3') return 'guard';

  if (marketReason.includes('streak3') || marketReason.includes('attack_core')) return 'attack';
  if (marketReason.includes('extend')) return 'extend';
  if (marketReason.includes('guard')) return 'guard';
  if (marketReason.includes('recent')) return 'recent';

  if (key.includes('repeat') || key.includes('hot')) return 'attack';
  if (key.includes('gap') || key.includes('chase') || key.includes('jump')) return 'extend';
  if (key.includes('guard') || key.includes('balance') || key.includes('mix')) return 'guard';
  if (key.includes('tail') || key.includes('rotation') || key.includes('split')) return 'recent';

  return 'mix';
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

  if (role === 'attack') {
    return [pools.attack, pools.hot5 || pools.hot, pools.hot10 || pools.hot, pools.recent, pools.all];
  }
  if (role === 'extend') {
    return [pools.extend, pools.hot10 || pools.hot, pools.hot20 || pools.hot, pools.guard, pools.all];
  }
  if (role === 'guard') {
    return [pools.guard, pools.hot20 || pools.hot, pools.warm, pools.cold, pools.all];
  }
  if (role === 'recent') {
    return [pools.recent, pools.attack, pools.hot5 || pools.hot, pools.extend, pools.all];
  }
  return [pools.hot, pools.extend, pools.guard, pools.all];
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

function pickKeepNumsByRole(sourceNums = [], role = 'mix', pools = {}, phaseContext = null) {
  const nums = uniqueAsc(sourceNums);
  const keepPool = new Set(buildKeepPoolByRole(role, pools, phaseContext));
  const need = getKeepNeedByRole(role, phaseContext);

  const kept = nums.filter((n) => keepPool.has(n));
  if (kept.length >= need) {
    return kept.slice(0, need);
  }

  return nums.slice(0, Math.min(need, nums.length));
}

function buildWeightProfile(marketPhase = 'rotation', lastHitLevel = 'neutral') {
  const phase = String(marketPhase || 'rotation').toLowerCase();
  const hit = String(lastHitLevel || 'neutral').toLowerCase();

  if (phase === 'continuation' && hit === 'bad') {
    return { attack: 0.95, extend: 1.10, guard: 1.05, recent: 0.90 };
  }

  if (phase === 'continuation' && hit === 'neutral') {
    return { attack: 1.10, extend: 1.00, guard: 0.95, recent: 0.95 };
  }

  if (phase === 'continuation' && hit === 'good') {
    return { attack: 1.25, extend: 1.05, guard: 0.85, recent: 0.85 };
  }

  if (phase === 'rotation' && hit === 'bad') {
    return { attack: 0.65, extend: 1.20, guard: 1.20, recent: 1.10 };
  }

  if (phase === 'rotation' && hit === 'neutral') {
    return { attack: 0.75, extend: 1.15, guard: 1.10, recent: 1.00 };
  }

  if (phase === 'rotation' && hit === 'good') {
    return { attack: 0.90, extend: 1.05, guard: 1.05, recent: 1.00 };
  }

  return { attack: 1.00, extend: 1.00, guard: 1.00, recent: 1.00 };
}

function roleWeightOf(role = 'mix', weightProfile = {}) {
  const key = String(role || 'mix').toLowerCase();
  if (key === 'attack') return toNum(weightProfile.attack, 1);
  if (key === 'extend') return toNum(weightProfile.extend, 1);
  if (key === 'guard') return toNum(weightProfile.guard, 1);
  if (key === 'recent') return toNum(weightProfile.recent, 1);
  return 1;
}

function buildLastHitLevel(lastPrediction = null) {
  const hitCount = toNum(lastPrediction?.hit_count, 0);
  if (hitCount >= 2) return 'good';
  if (hitCount === 1) return 'neutral';
  return 'bad';
}

function buildConfidenceScore(marketPhase = 'rotation', lastHitLevel = 'neutral', marketSnapshot = {}) {
  const phase = String(marketPhase || 'rotation').toLowerCase();
  const hit = String(lastHitLevel || 'neutral').toLowerCase();

  let score = phase === 'continuation' ? 60 : 45;
  if (hit === 'bad') score -= 10;
  if (hit === 'good') score += 12;

  const streak3Count = Array.isArray(marketSnapshot?.streak3) ? marketSnapshot.streak3.length : 0;
  const streak2Count = Array.isArray(marketSnapshot?.streak2) ? marketSnapshot.streak2.length : 0;
  const streak4Count = Array.isArray(marketSnapshot?.streak4) ? marketSnapshot.streak4.length : 0;

  if (streak3Count > 0) score += 8;
  if (streak2Count === 0 && streak3Count === 0 && streak4Count === 0) score -= 6;

  return clamp(Math.round(score), 0, 100);
}

function buildPhaseContext(sourcePrediction = null, lastComparedPrediction = null) {
  const marketSnapshot =
    sourcePrediction?.market_snapshot_json && typeof sourcePrediction.market_snapshot_json === 'object'
      ? sourcePrediction.market_snapshot_json
      : {};

  const marketPhase = String(marketSnapshot?.market_phase || 'rotation').toLowerCase();
  const lastHitLevel = buildLastHitLevel(lastComparedPrediction);
  const weightProfile = buildWeightProfile(marketPhase, lastHitLevel);
  const confidenceScore = buildConfidenceScore(marketPhase, lastHitLevel, marketSnapshot);

  return {
    marketPhase,
    lastHitLevel,
    weightProfile,
    confidenceScore,
    lastPredictionId: lastComparedPrediction?.id || null,
    lastPredictionMode: lastComparedPrediction?.mode || null,
    lastPredictionHitCount: toNum(lastComparedPrediction?.hit_count, 0)
  };
}


function scoreGroupForMode(group, role, strategyMode, riskMode, pools, phaseContext = null) {
  const nums = uniqueAsc(group?.nums || []);
  const key = String(group?.meta?.strategy_key || group?.key || '').toLowerCase();
  const groupRole = inferRoleFromGroup(group);
  const weightProfile = phaseContext?.weightProfile || {};
  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();

  const attackSet = new Set((pools.attack || []).slice(0, 18));
  const extendSet = new Set((pools.extend || []).slice(0, 18));
  const guardSet = new Set((pools.guard || []).slice(0, 18));
  const recentSet = new Set((pools.recent || []).slice(0, 18));
  const hotSet = new Set((pools.hot || []).slice(0, 20));
  const coldSet = new Set((pools.cold || []).slice(0, 20));
  const gapSet = new Set((pools.gap || []).slice(0, 20));

  const attackCount = nums.filter((n) => attackSet.has(n)).length;
  const extendCount = nums.filter((n) => extendSet.has(n)).length;
  const guardCount = nums.filter((n) => guardSet.has(n)).length;
  const recentCount = nums.filter((n) => recentSet.has(n)).length;
  const hotCount = nums.filter((n) => hotSet.has(n)).length;
  const coldCount = nums.filter((n) => coldSet.has(n)).length;
  const gapCount = nums.filter((n) => gapSet.has(n)).length;

  let score = 0;

  score += toNum(group?.meta?.decision_score, 0);
  score += toNum(group?.meta?.recent_50_hit3_rate, 0) * 300;
  score += toNum(group?.meta?.hit3_rate, 0) * 220;
  score += toNum(group?.meta?.market_boost, 1) * 30;

  if (groupRole === role) score += 90;
  if (role === 'attack') score += attackCount * 20 + hotCount * 5;
  if (role === 'extend') score += extendCount * 18 + hotCount * 4 + gapCount * 3;
  if (role === 'guard') score += guardCount * 18 + coldCount * 2;
  if (role === 'recent') score += recentCount * 18 + hotCount * 4;

  if (strategyMode === 'hot') {
    score += hotCount * 12;
    if (key.includes('hot') || key.includes('repeat')) score += 20;
  } else if (strategyMode === 'cold') {
    score += coldCount * 12 + gapCount * 6;
    if (key.includes('cold') || key.includes('gap') || key.includes('guard')) score += 20;
  } else if (strategyMode === 'burst') {
    score += attackCount * 8 + gapCount * 10 + recentCount * 6;
    if (key.includes('gap') || key.includes('tail') || key.includes('zone')) score += 18;
  } else {
    score += attackCount * 6 + extendCount * 6 + guardCount * 6;
  }

  const qualityReport = buildGroupQualityReport(nums, pools);
  score += scoreQualityReport(qualityReport, role, { strategyMode, riskMode }, phaseContext) * 1.8;

  if (riskMode === 'safe' && (role === 'guard' || role === 'extend')) score += 10;
  if (riskMode === 'aggressive' && role === 'attack') score += 10;
  if (riskMode === 'sniper' && (role === 'attack' || role === 'recent')) score += 10;

  const roleWeight = roleWeightOf(role, weightProfile);
  score *= roleWeight;

  if (marketPhase === 'rotation') {
    if (role === 'attack') score -= 20;
    if (role === 'extend') score += 12;
    if (role === 'guard') score += 12;
    if (role === 'recent') score += 8;
  }

  if (marketPhase === 'continuation') {
    if (role === 'attack') score += 18;
    if (role === 'recent') score -= 6;
  }

  return score;
}



function getDecisionScoreFloor(role = 'mix', selection = {}, phaseContext = null) {
  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();
  const riskMode = String(selection?.riskMode || 'balanced').toLowerCase();

  let base = 120;
  if (role === 'extend') base = 150;
  else if (role === 'attack') base = 130;
  else if (role === 'guard') base = 90;
  else if (role === 'recent') base = 95;

  if (marketPhase === 'rotation') {
    if (role === 'attack') base += 10;
    if (role === 'extend') base += 10;
    if (role === 'guard') base -= 5;
  }

  if (marketPhase === 'continuation') {
    if (role === 'attack') base -= 10;
    if (role === 'recent') base += 5;
  }

  if (riskMode === 'safe' && role === 'guard') base -= 10;
  if (riskMode === 'aggressive' && role === 'attack') base -= 5;
  if (riskMode === 'sniper' && role === 'recent') base -= 5;

  return base;
}

function getRecentRoiFloor(role = 'mix', selection = {}, phaseContext = null) {
  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();
  const riskMode = String(selection?.riskMode || 'balanced').toLowerCase();

  let floor = -0.28;
  if (role === 'attack') floor = -0.18;
  else if (role === 'extend') floor = -0.25;
  else if (role === 'guard') floor = -0.20;
  else if (role === 'recent') floor = -0.16;

  if (marketPhase === 'rotation' && (role === 'guard' || role === 'extend')) floor -= 0.03;
  if (marketPhase === 'continuation' && role === 'attack') floor -= 0.03;

  if (riskMode === 'safe' && role === 'guard') floor -= 0.05;
  if (riskMode === 'aggressive' && (role === 'attack' || role === 'recent')) floor += 0.03;
  if (riskMode === 'sniper' && role === 'recent') floor += 0.02;

  return round4(floor);
}

function getHit3RateFloor(role = 'mix', selection = {}, phaseContext = null) {
  const riskMode = String(selection?.riskMode || 'balanced').toLowerCase();

  let floor = 0.008;
  if (role === 'attack') floor = 0.015;
  else if (role === 'extend') floor = 0.010;
  else if (role === 'guard') floor = 0.004;
  else if (role === 'recent') floor = 0.012;

  if (riskMode === 'aggressive' && role === 'attack') floor += 0.002;
  if (riskMode === 'safe' && role === 'guard') floor -= 0.002;

  return round4(Math.max(0, floor));
}

function getMinRoundsForStrictFilter(role = 'mix') {
  if (role === 'attack') return 8;
  if (role === 'recent') return 8;
  if (role === 'extend') return 10;
  if (role === 'guard') return 6;
  return 8;
}

function getMetaMetric(group = {}, key = '', fallback = 0) {
  return toNum(group?.meta?.[key], fallback);
}

function getBlendedRoi(group = {}) {
  const lifetimeRoi = getMetaMetric(group, 'roi', 0);
  const recent50Roi = getMetaMetric(group, 'recent_50_roi', lifetimeRoi);
  return round4(recent50Roi * 0.7 + lifetimeRoi * 0.3);
}

function getBlendedHit3Rate(group = {}) {
  const recent = getMetaMetric(group, 'recent_50_hit3_rate', 0);
  const lifetime = getMetaMetric(group, 'hit3_rate', 0);
  return round4(recent * 0.7 + lifetime * 0.3);
}

function passesRoiGate(group = {}, role = 'mix', selection = {}, phaseContext = null) {
  const totalRounds = getMetaMetric(group, 'total_rounds', 0);
  const floor = getRecentRoiFloor(role, selection, phaseContext);

  if (totalRounds < getMinRoundsForStrictFilter(role)) return true;

  const blendedRoi = getBlendedRoi(group);
  return blendedRoi >= floor;
}

function passesHit3Gate(group = {}, role = 'mix', selection = {}, phaseContext = null) {
  const totalRounds = getMetaMetric(group, 'total_rounds', 0);
  const floor = getHit3RateFloor(role, selection, phaseContext);

  if (totalRounds < getMinRoundsForStrictFilter(role)) return true;

  const blendedHit3Rate = getBlendedHit3Rate(group);
  return blendedHit3Rate >= floor;
}

function passesStabilityGate(group = {}, role = 'mix') {
  const totalRounds = getMetaMetric(group, 'total_rounds', 0);
  const recent50HitRate = getMetaMetric(group, 'recent_50_hit_rate', getMetaMetric(group, 'hit2_rate', 0));
  const roi = getMetaMetric(group, 'roi', 0);
  const recent50Roi = getMetaMetric(group, 'recent_50_roi', roi);

  if (totalRounds < 12) return true;
  if (recent50HitRate >= 0.22) return true;

  return !(roi < -0.25 && recent50Roi < -0.25 && (role === 'attack' || role === 'recent'));
}

function evaluateFormalCandidateScore(group = {}, nums = [], role = 'mix', selection = {}, pools = {}, phaseContext = null, existingGroups = []) {
  const safeNums = uniqueAsc(nums).slice(0, 4);
  if (safeNums.length !== 4) return Number.NEGATIVE_INFINITY;
  if (!isAcceptableGroup(safeNums, pools, role, selection, phaseContext)) return Number.NEGATIVE_INFINITY;

  const report = buildGroupQualityReport(safeNums, pools);
  const overlapPenalty = (existingGroups || []).reduce(
    (acc, g) => acc + Math.max(0, countOverlap(safeNums, g?.nums || []) - 1) * 18,
    0
  );

  return (
    scoreGroupForMode(
      {
        ...group,
        nums: safeNums
      },
      role,
      selection.strategyMode,
      selection.riskMode,
      pools,
      phaseContext
    ) +
    scoreQualityReport(report, role, selection, phaseContext) * 2.2 -
    overlapPenalty
  );
}

function passesDecisionGate(group = {}, score = Number.NEGATIVE_INFINITY, role = 'mix', selection = {}, phaseContext = null) {
  if (score < getDecisionScoreFloor(role, selection, phaseContext)) return false;
  if (!passesRoiGate(group, role, selection, phaseContext)) return false;
  if (!passesHit3Gate(group, role, selection, phaseContext)) return false;
  if (!passesStabilityGate(group, role)) return false;
  return true;
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

  for (let i = 0; i < roles.length; i += 1) {
    const role = roles[i];
    let bestIdx = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let j = 0; j < ranked.length; j += 1) {
      if (usedIndexes.has(j)) continue;
      const row = ranked[j];
      const score = scoreGroupForMode(row.group, role, selection.strategyMode, selection.riskMode, pools, phaseContext);

      if (!passesDecisionGate(row.group, score, role, selection, phaseContext)) continue;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0) {
      usedIndexes.add(bestIdx);
      picked.push({
        role,
        group: ranked[bestIdx].group,
        role_decision_score: bestScore
      });
    }
  }

  if (picked.length < GROUP_COUNT) {
    for (let j = 0; j < ranked.length && picked.length < GROUP_COUNT; j += 1) {
      if (usedIndexes.has(j)) continue;

      const role = roles[picked.length] || 'mix';
      const score = scoreGroupForMode(ranked[j].group, role, selection.strategyMode, selection.riskMode, pools, phaseContext);

      if (!passesDecisionGate(row.group, score, role, selection, phaseContext)) continue;

      usedIndexes.add(j);
      picked.push({
        role,
        group: ranked[j].group,
        role_decision_score: score
      });
    }
  }

  return picked.slice(0, GROUP_COUNT);
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

    if (!passesDecisionGate(sourceGroup, score, slotRole, selection, phaseContext)) return;

    const key = safeNums.join(',');
    const prev = candidateMap.get(key);
    if (!prev || score > prev.score) {
      candidateMap.set(key, {
        nums: safeNums,
        score,
        tag
      });
    }
  };

  addCandidate(
    fillToFour(keepNums, fallbackPools, seedBase, pools, slotRole, selection, phaseContext),
    'keep_base',
    0
  );

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
        uniqueAsc([
          ...keepNums.slice(0, 1),
          ...(pools.extend || []).slice(0, 2),
          ...(pools.guard || []).slice(0, 2)
        ]),
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

  if (slotRole === 'guard' && marketPhase === 'rotation') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums,
          ...(pools.guard || []).slice(0, 4)
        ]),
        [pools.guard, pools.extend, pools.recent, pools.qualityAll, pools.all],
        seedBase + 23,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      'guard_rotation',
      10
    );
  }

  if (slotRole === 'recent' && marketPhase === 'rotation') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums,
          ...(pools.recent || []).slice(0, 4)
        ]),
        [pools.recent, pools.extend, pools.guard, pools.qualityAll, pools.all],
        seedBase + 27,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      'recent_rotation',
      8
    );
  }

  if (selection.strategyMode === 'cold') {
    addCandidate(
      fillToFour(
        uniqueAsc([...keepNums.slice(0, 2), ...(pools.cold || []).slice(0, 4), ...(pools.gap || []).slice(0, 3)]),
        [pools.guard, pools.cold, pools.gap, pools.qualityAll, pools.all],
        seedBase + 29,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      'cold_mode',
      9
    );
  }

  if (selection.strategyMode === 'burst') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums.slice(0, 2),
          ...(marketPhase === 'continuation' ? (pools.attack || []).slice(0, 3) : (pools.extend || []).slice(0, 2)),
          ...(pools.recent || []).slice(0, 2)
        ]),
        [pools.attack, pools.extend, pools.recent, pools.hot, pools.qualityAll, pools.all],
        seedBase + 31,
        pools,
        slotRole,
        selection,
        phaseContext
      ),
      'burst_mode',
      11
    );
  }

  for (let i = 0; i < 12; i += 1) {
    const dynamicBase = uniqueAsc([
      ...keepNums.slice(0, Math.max(1, keepNums.length - (i % 2))),
      ...((slotRole === 'attack' ? pools.attack : slotRole === 'guard' ? pools.guard : slotRole === 'recent' ? pools.recent : pools.extend) || []).slice(0, 2 + (i % 3)),
      ...((i % 2 === 0 ? pools.recent : pools.gap) || []).slice(0, 2)
    ]);

    addCandidate(
      fillToFour(
        dynamicBase,
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

  let ranked = [...candidateMap.values()]
    .map((row) => {
      const adjustedNums = forceGroupDifference(
        row.nums,
        existingGroups,
        pools,
        seedBase + row.score,
        slotRole,
        selection,
        phaseContext
      );

      const score = evaluateFormalCandidateScore(
        row.sourceGroup,
        adjustedNums,
        slotRole,
        selection,
        pools,
        phaseContext,
        existingGroups
      );

      return {
        ...row,
        nums: adjustedNums,
        score
      };
    })
    .filter((row) =>
      passesDecisionGate(row.sourceGroup, row.score, slotRole, selection, phaseContext)
    )
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return [];
  }

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
    decision: 'market_role_formal_v9_quality_gate',
    market_phase: phaseContext?.marketPhase || 'rotation',
    last_hit_level: phaseContext?.lastHitLevel || 'neutral',
    confidence_score: toNum(phaseContext?.confidenceScore, 0),
    weight_profile: weightProfile,
    role_weight: roleWeightOf(slotRole, weightProfile),
    quality_engine: 'v2'
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

  const sourcePrediction =
    latestSameSourceTest ||
    fallbackTest ||
    latestSameSourceCandidate ||
    null;

  if (!sourcePrediction?.id) {
    throw new Error('找不到可用的 test prediction，請先讓 auto-train 建立最新 test prediction');
  }

  const sourceGroups = normalizeGroups(
    parseGroupsJson(sourcePrediction.groups_json),
    sourceDraw
  );

  if (!sourceGroups.length) {
    throw new Error('最新 test prediction 沒有可用四碼群組');
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

  const tryAddSlot = (sourceGroup, slotRole) => {
    if (!sourceGroup) return false;

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

    if (!passesDecisionGate(sourceGroup, candidateScore, slotRole, selection, phaseContext)) return false;

    const safeKey = `${sourceGroup.key}_${slotRole}`;
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
        blended_hit3_rate: getBlendedHit3Rate(sourceGroup)
      }
    });

    usedKeys.add(safeKey);
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
      for (const role of fallbackRoles) {
        const baseScore = scoreGroupForMode(
          sourceGroup,
          role,
          selection.strategyMode,
          selection.riskMode,
          pools,
          phaseContext
        );

        if (!passesDecisionGate(sourceGroup, baseScore, role, selection, phaseContext)) continue;

        fallbackMatrix.push({
          sourceGroup,
          role,
          baseScore
        });
      }
    }

    fallbackMatrix
      .sort((a, b) => b.baseScore - a.baseScore)
      .forEach((row) => {
        if (groups.length >= GROUP_COUNT) return;
        tryAddSlot(row.sourceGroup, row.role);
      });
  }

  const finalGroups = normalizeGroups(groups, sourceDraw)
    .filter((group) => {
      const role = inferRoleFromGroup(group);
      const score = evaluateFormalCandidateScore(group, group?.nums || [], role, selection, pools, phaseContext, []);
      return passesDecisionGate(group, score, role, selection, phaseContext);
    })
    .slice(0, GROUP_COUNT);

  if (finalGroups.length !== GROUP_COUNT) {
    throw new Error('正式下注分工四組建立失敗：通過品質門檻的組數不足，已停止補入弱組');
  }

  return {
    groups: finalGroups,
    recentDrawCount: recentDraws.length,
    sourcePredictionId: sourcePrediction.id,
    sourcePredictionMode: sourcePrediction.mode || TEST_MODE,
    sourcePredictionDrawNo: toNum(sourcePrediction.source_draw_no, 0),
    marketSnapshot,
    phaseContext
  };
}


async function createFormalPrediction(selection) {
  const latestDraw = await getLatestDraw();
  const sourceResolved = await resolveFormalSourceDraw(latestDraw);
  const sourceDrawNo = toNum(sourceResolved?.sourceDrawNo, 0);

  if (!sourceDrawNo) {
    throw new Error('找不到可用 source_draw_no');
  }

  const existingRows = await getFormalRowsBySourceDrawNo(sourceDrawNo);

  if (existingRows.length >= FORMAL_BATCH_LIMIT) {
    return {
      ok: true,
      skipped: true,
      reason: '本期 formal 批次已達上限',
      latest_draw_no: toNum(latestDraw?.draw_no, 0),
      latest_draw_time: latestDraw?.draw_time || null,
      source_draw_no: sourceDrawNo,
      formal_batch_no: existingRows.length,
      formal_batch_limit: FORMAL_BATCH_LIMIT,
      existing_count: existingRows.length,
      requested_selection: selection,
      prediction: null
    };
  }

  const nextBatchNo = existingRows.length + 1;

  const {
    groups,
    recentDrawCount,
    sourcePredictionId,
    sourcePredictionMode,
    sourcePredictionDrawNo,
    marketSnapshot,
    phaseContext
  } = await buildFormalGroups(latestDraw, selection);

  const payload = {
    mode: FORMAL_MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: 1,
    groups_json: groups,
    compare_status: 'pending',
    compare_result: null,
    compare_result_json: null,
    hit_count: 0,
    verdict: null,
    latest_draw_numbers: parseNums(latestDraw?.numbers).join(','),
    market_snapshot_json: {
      ...(marketSnapshot || {}),
      market_phase: phaseContext?.marketPhase || marketSnapshot?.market_phase || 'rotation',
      last_hit_level: phaseContext?.lastHitLevel || 'neutral',
      confidence_score: toNum(phaseContext?.confidenceScore, 0),
      weight_profile: phaseContext?.weightProfile || {}
    },
    created_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert(payload)
    .select('*')
    .maybeSingle();

  if (error) throw error;

  return {
    ok: true,
    skipped: false,
    reason: '',
    latest_draw_no: toNum(latestDraw?.draw_no, 0),
    latest_draw_time: latestDraw?.draw_time || null,
    source_draw_no: sourceDrawNo,
    formal_batch_no: nextBatchNo,
    formal_batch_limit: FORMAL_BATCH_LIMIT,
    existing_count: existingRows.length,
    source_prediction_id: sourcePredictionId,
    source_prediction_mode: sourcePredictionMode,
    source_prediction_draw_no: sourcePredictionDrawNo,
    requested_selection: selection,
    recent_draw_count: recentDrawCount,
    market_phase: phaseContext?.marketPhase || 'rotation',
    last_hit_level: phaseContext?.lastHitLevel || 'neutral',
    confidence_score: toNum(phaseContext?.confidenceScore, 0),
    weight_profile: phaseContext?.weightProfile || {},
    prediction: {
      id: data?.id || null,
      mode: FORMAL_MODE,
      status: data?.status || 'created',
      source_draw_no: sourceDrawNo,
      target_periods: 1,
      group_count: groups.length,
      groups
    }
  };
}

async function getExistingTestResponse(latestDraw) {
  const sourceDrawNo = toNum(latestDraw?.draw_no, 0);

  const { data: existing, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, created_at, groups_json, source_draw_no, target_periods, status, market_snapshot_json')
    .eq('mode', TEST_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  if (existing?.id) {
    return {
      ok: true,
      skipped: true,
      reason: '本期 test prediction 已存在',
      source_draw_no: sourceDrawNo,
      prediction: {
        id: existing.id,
        mode: TEST_MODE,
        status: existing.status || 'created',
        source_draw_no: sourceDrawNo,
        target_periods: toNum(existing.target_periods, 1),
        group_count: parseGroupsJson(existing.groups_json).length,
        groups: parseGroupsJson(existing.groups_json),
        market_snapshot_json: existing.market_snapshot_json || null
      }
    };
  }

  throw new Error('目前這一版不負責自動建立 test prediction，請先由 auto-train 或既有流程建立 test prediction');
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      api_version: API_VERSION,
      error: 'Method not allowed'
    });
  }

  try {
    const mode = getMode(req);
    const triggerSource = getTriggerSource(req);
    const selection = getSelectionParams(req);

    if (mode === TEST_MODE) {
      const latestDraw = await getLatestDraw();
      const result = await getExistingTestResponse(latestDraw);

      return res.status(200).json({
        ok: true,
        api_version: API_VERSION,
        mode,
        trigger_source: triggerSource,
        latest_draw_no: toNum(latestDraw?.draw_no, 0),
        latest_draw_time: latestDraw?.draw_time || null,
        target_periods: 1,
        bet_type: 'test_existing_only',
        cost_per_group: COST_PER_GROUP,
        group_count: GROUP_COUNT,
        formal_batch_limit: FORMAL_BATCH_LIMIT,
        requested_selection: selection,
        ...result
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        api_version: API_VERSION,
        mode: FORMAL_MODE,
        trigger_source: triggerSource,
        requested_selection: selection,
        error: '正式下注只允許 POST'
      });
    }

    if (!isManualFormalRequest(req)) {
      return res.status(403).json({
        ok: false,
        api_version: API_VERSION,
        mode: FORMAL_MODE,
        trigger_source: triggerSource,
        requested_selection: selection,
        error: '正式下注已鎖定為手動觸發，請由前端按鈕使用 manual=true 呼叫'
      });
    }

    const result = await createFormalPrediction(selection);

    return res.status(200).json({
      ok: true,
      api_version: API_VERSION,
      mode: FORMAL_MODE,
      trigger_source: triggerSource,
      cost_per_group: COST_PER_GROUP,
      group_count: GROUP_COUNT,
      formal_batch_limit: FORMAL_BATCH_LIMIT,
      requested_selection: selection,
      ...result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      api_version: API_VERSION,
      error: error?.message || 'Unknown error'
    });
  }
}
