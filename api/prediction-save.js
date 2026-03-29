import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-save-batch-v5-weighted-focus-b';

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
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === '1') return true;
    if (v === '0') return false;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return fallback;
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
      selection_rank: idx + 1,
      source_draw_no: toNum(sourceDraw?.draw_no, 0),
      source_draw_time: sourceDraw?.draw_time || null,
      bet_amount: COST_PER_GROUP,
      decision: 'from_latest_test_prediction'
    }
  };
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

function buildMarketPools(drawRows = []) {
  const rows = Array.isArray(drawRows) ? drawRows : [];
  const freqMap = new Map();
  const lastSeen = new Map();
  const allNums = Array.from({ length: 80 }, (_, i) => i + 1);

  allNums.forEach((n) => {
    freqMap.set(n, 0);
  });

  rows.forEach((row, idx) => {
    const nums = parseNums(row?.numbers);
    nums.forEach((n) => {
      freqMap.set(n, toNum(freqMap.get(n), 0) + 1);
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

  return {
    hot,
    cold,
    warm,
    gap,
    odd,
    even,
    all: allNums
  };
}

function pickFromPool(pool = [], selectedSet = new Set(), seed = 0) {
  const candidates = uniqueAsc(pool).filter((n) => !selectedSet.has(n));
  if (!candidates.length) return null;
  return candidates[Math.abs(toNum(seed, 0)) % candidates.length];
}

function fillToFour(base = [], fallbackPools = [], seed = 0) {
  const result = uniqueAsc(base).slice(0, 4);
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

  return uniqueAsc(result).slice(0, 4);
}

function countOverlap(a = [], b = []) {
  const setB = new Set(uniqueAsc(b));
  return uniqueAsc(a).filter((n) => setB.has(n)).length;
}

function mutateOne(nums = [], pools = [], seed = 0) {
  const current = uniqueAsc(nums).slice(0, 4);
  if (current.length !== 4) return current;

  const selected = new Set(current);
  const removeIndex = Math.abs(seed) % current.length;
  selected.delete(current[removeIndex]);

  for (let i = 0; i < pools.length; i += 1) {
    const value = pickFromPool(pools[i], selected, seed + i * 17 + 3);
    if (value != null) {
      selected.add(value);
      return uniqueAsc([...selected]).slice(0, 4);
    }
  }

  return uniqueAsc([...selected]).slice(0, 4);
}

function forceGroupDifference(nums = [], existingGroups = [], pools = {}, seed = 0) {
  let result = uniqueAsc(nums).slice(0, 4);
  const poolOrder = [pools.hot, pools.cold, pools.gap, pools.warm, pools.all];

  for (let round = 0; round < 10; round += 1) {
    let changed = false;

    for (const group of existingGroups) {
      const overlap = countOverlap(result, group?.nums || []);
      if (overlap >= 3) {
        result = mutateOne(result, poolOrder, seed + round * 23 + overlap);
        changed = true;
        break;
      }
    }

    if (!changed) break;
  }

  return uniqueAsc(result).slice(0, 4);
}

function getRiskOrder(riskMode = 'balanced') {
  if (riskMode === 'safe') {
    return ['safe', 'balanced', 'aggressive', 'sniper'];
  }
  if (riskMode === 'balanced') {
    return ['balanced', 'safe', 'aggressive', 'sniper'];
  }
  if (riskMode === 'aggressive') {
    return ['aggressive', 'balanced', 'sniper', 'safe'];
  }
  return ['sniper', 'aggressive', 'balanced', 'safe'];
}

function buildModePools(strategyMode, pools) {
  if (strategyMode === 'hot') {
    return [pools.hot, pools.warm, pools.gap, pools.all];
  }
  if (strategyMode === 'cold') {
    return [pools.cold, pools.gap, pools.warm, pools.all];
  }
  if (strategyMode === 'burst') {
    return [pools.gap, pools.cold, pools.hot, pools.all];
  }
  return [pools.hot, pools.cold, pools.warm, pools.all];
}

function scoreGroupForMode(group, strategyMode, pools) {
  const nums = uniqueAsc(group?.nums || []);
  const key = String(group?.meta?.strategy_key || group?.key || '').toLowerCase();
  const type = String(group?.meta?.type || '').toLowerCase();

  const hotSet = new Set(pools.hot.slice(0, 20));
  const coldSet = new Set(pools.cold.slice(0, 20));
  const gapSet = new Set(pools.gap.slice(0, 20));

  const hotCount = nums.filter((n) => hotSet.has(n)).length;
  const coldCount = nums.filter((n) => coldSet.has(n)).length;
  const gapCount = nums.filter((n) => gapSet.has(n)).length;

  let score = 0;

  if (strategyMode === 'hot') {
    score += hotCount * 10;
    if (key.includes('hot') || key.includes('repeat')) score += 6;
  } else if (strategyMode === 'cold') {
    score += coldCount * 10;
    if (key.includes('cold') || key.includes('gap') || key.includes('guard')) score += 6;
  } else if (strategyMode === 'burst') {
    score += gapCount * 7 + coldCount * 4 + hotCount * 2;
    if (key.includes('tail') || key.includes('zone') || key.includes('cluster')) score += 6;
    if (type === 'sniper' || type === 'aggressive') score += 4;
  } else {
    score += Math.min(hotCount, 2) * 5 + Math.min(coldCount, 2) * 5;
    if (key.includes('mix') || key.includes('balanced')) score += 6;
    if (type === 'balanced') score += 4;
  }

  score += toNum(group?.meta?.selection_rank, 0) * -0.5;
  return score;
}

function scoreGroupForWeightedFocus(group, strategyMode, pools) {
  const modeScore = scoreGroupForMode(group, strategyMode, pools);
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};

  const baseScore = toNum(meta.score, 0);
  const strengthScore = toNum(meta.strength_score, 0);
  const roi = toNum(meta.roi, 0);
  const recent50Roi = toNum(meta.recent_50_roi, 0);
  const avgHit = toNum(meta.avg_hit, 0);
  const hit3Rate = toNum(meta.hit3_rate, 0);
  const recent50Hit3Rate = toNum(meta.recent_50_hit3_rate, 0);
  const hit4Count = toNum(meta.hit4, toNum(meta.hit4_count, 0));
  const hit3Count = toNum(meta.hit3, toNum(meta.hit3_count, 0));
  const totalRounds = toNum(meta.total_rounds, 0);
  const selectionRank = toNum(meta.selection_rank, 0);

  let score = 0;

  score += modeScore;
  score += baseScore * 0.01;
  score += strengthScore * 0.001;
  score += roi * 20;
  score += recent50Roi * 18;
  score += avgHit * 10;
  score += hit3Rate * 100;
  score += recent50Hit3Rate * 130;
  score += hit3Count * 3;
  score += hit4Count * 8;
  score += Math.min(totalRounds, 30) * 0.15;
  score -= selectionRank * 0.5;

  return score;
}

function adaptNumsBySelection(baseNums, roleType, strategyMode, pools, seed = 0) {
  const nums = uniqueAsc(baseNums).slice(0, 4);
  const modePools = buildModePools(strategyMode, pools);

  if (roleType === 'safe') {
    return fillToFour(
      [...nums.slice(0, 3), ...modePools[0].slice(0, 2)],
      [modePools[0], modePools[1], pools.warm, pools.all],
      seed + 11
    );
  }

  if (roleType === 'balanced') {
    return fillToFour(
      [...nums.slice(0, 2), modePools[0][0], modePools[1][0]],
      [modePools[0], modePools[1], pools.warm, pools.all],
      seed + 23
    );
  }

  if (roleType === 'aggressive') {
    return fillToFour(
      [modePools[0][0], modePools[0][1], ...nums.slice(0, 1), modePools[1][0]],
      [modePools[0], modePools[1], pools.gap, pools.all],
      seed + 37
    );
  }

  return fillToFour(
    [modePools[0][0], modePools[0][1], modePools[1][0], modePools[2][0]],
    [modePools[0], modePools[1], modePools[2], pools.all],
    seed + 49
  );
}

function buildWeightedFocusPlan(top1, top2) {
  const top1Type = String(top1?.meta?.type || '').toLowerCase();
  const top2Type = String(top2?.meta?.type || '').toLowerCase();

  return [
    {
      sourceGroup: top1,
      sourceRank: 1,
      focusBucket: 'top1',
      focusWeight: 3,
      slotNo: 1,
      roleType: top1Type === 'sniper' ? 'sniper' : 'aggressive',
      tag: 'TOP1-1'
    },
    {
      sourceGroup: top1,
      sourceRank: 1,
      focusBucket: 'top1',
      focusWeight: 3,
      slotNo: 2,
      roleType: 'sniper',
      tag: 'TOP1-2'
    },
    {
      sourceGroup: top1,
      sourceRank: 1,
      focusBucket: 'top1',
      focusWeight: 3,
      slotNo: 3,
      roleType: 'aggressive',
      tag: 'TOP1-3'
    },
    {
      sourceGroup: top2,
      sourceRank: 2,
      focusBucket: 'top2',
      focusWeight: 1,
      slotNo: 4,
      roleType:
        top2Type === 'safe' || top2Type === 'balanced' || top2Type === 'aggressive' || top2Type === 'sniper'
          ? top2Type
          : 'aggressive',
      tag: 'TOP2-1'
    }
  ];
}

function reorderAndTransformGroups(rawGroups, selection, recentDraws, sourceDraw) {
  const pools = buildMarketPools(recentDraws);
  const normalized = rawGroups
    .map((group, idx) => normalizeGroup(group, idx, sourceDraw))
    .filter(Boolean)
    .slice(0, 12);

  if (!normalized.length) {
    throw new Error('最新 test prediction 沒有可用 groups_json');
  }

  if (normalized.length < 2) {
    throw new Error(`最新 test prediction 可用組數不足，目前僅有 ${normalized.length} 組`);
  }

  const weightedSorted = normalized
    .map((group, idx) => ({
      ...group,
      _originIdx: idx,
      _focusScore: scoreGroupForWeightedFocus(group, selection.strategyMode, pools)
    }))
    .sort((a, b) => {
      if (b._focusScore !== a._focusScore) return b._focusScore - a._focusScore;
      return a._originIdx - b._originIdx;
    });

  const top1 = weightedSorted[0];
  const top2 = weightedSorted[1];

  if (!top1 || !top2) {
    throw new Error('集中火力模式至少需要 2 組可用策略');
  }

  const plan = buildWeightedFocusPlan(top1, top2);
  const result = [];

  plan.forEach((item, idx) => {
    const sourceGroup = item.sourceGroup;
    const roleType = item.roleType;

    let nums = adaptNumsBySelection(
      sourceGroup.nums,
      roleType,
      selection.strategyMode,
      pools,
      selection.analysisPeriod + (idx + 1) * 41 + item.sourceRank * 101
    );

    nums = forceGroupDifference(
      nums,
      result,
      pools,
      selection.analysisPeriod + (idx + 1) * 131 + item.sourceRank * 211
    );

    result.push({
      ...sourceGroup,
      nums,
      label: `${item.tag}｜${roleLabelOf(roleType)}｜${sourceGroup.meta?.strategy_name || sourceGroup.label}`,
      reason: `集中火力B / ${item.tag} / ${strategyModeLabel(selection.strategyMode)} / ${roleLabelOf(roleType)} / 分析 ${selection.analysisPeriod} 期`,
      meta: {
        ...sourceGroup.meta,
        selection_rank: item.sourceRank,
        source_selection_rank: item.sourceRank,
        requested_analysis_period: selection.analysisPeriod,
        requested_strategy_mode: selection.strategyMode,
        requested_risk_mode: selection.riskMode,
        formal_role_label: roleLabelOf(roleType),
        formal_selection_applied: true,
        focus_mode: 'weighted_focus_b',
        focus_bucket: item.focusBucket,
        focus_weight: item.focusWeight,
        focus_slot_no: item.slotNo,
        focus_tag: item.tag,
        decision: 'weighted_focus_top1x3_top2x1'
      }
    });
  });

  if (result.length !== GROUP_COUNT) {
    throw new Error(`集中火力模式建立失敗，目前僅產生 ${result.length} 組`);
  }

  return result;
}

async function buildFormalGroups(sourceDraw, selection) {
  const sourceDrawNo = toNum(sourceDraw?.draw_no, 0);

  let testPrediction = await getLatestTestPredictionUpToSourceDraw(sourceDrawNo);
  if (!testPrediction) {
    testPrediction = await getLatestAnyTestPrediction();
  }

  if (!testPrediction) {
    throw new Error('找不到可用的 test prediction，請先建立 test prediction');
  }

  const rawGroups = parseGroupsJson(testPrediction.groups_json);
  if (!rawGroups.length) {
    throw new Error('最新 test prediction 沒有可用 groups_json');
  }

  const recentDraws = await getRecentDraws(selection.analysisPeriod);
  const groups = reorderAndTransformGroups(rawGroups, selection, recentDraws, sourceDraw);

  return {
    groups,
    recentDrawCount: recentDraws.length,
    sourceTestPredictionId: testPrediction.id || null,
    sourceTestDrawNo: toNum(testPrediction.source_draw_no, 0)
  };
}

async function createFormalPrediction(selection) {
  const latestDraw = await getLatestDraw();

  const batchInfo = await resolveFormalSourceDraw(latestDraw);
  const sourceDrawNo = batchInfo.sourceDrawNo;

  if (!sourceDrawNo) {
    throw new Error('無法判斷正式下注來源期數');
  }

  const sourceDraw = {
    draw_no: sourceDrawNo,
    draw_time:
      sourceDrawNo === toNum(latestDraw?.draw_no, 0)
        ? latestDraw?.draw_time || null
        : null
  };

  const existingRows = await getFormalRowsBySourceDrawNo(sourceDrawNo);
  if (existingRows.length >= FORMAL_BATCH_LIMIT) {
    return {
      ok: true,
      skipped: true,
      reason: `本期正式下注已達上限 ${FORMAL_BATCH_LIMIT} 次`,
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
    sourceTestPredictionId,
    sourceTestDrawNo
  } = await buildFormalGroups(sourceDraw, selection);

  const payload = {
    mode: FORMAL_MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: 1,
    groups_json: groups,
    compare_status: 'pending',
    compare_result: null,
    hit_count: 0,
    verdict: null,
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
    source_test_prediction_id: sourceTestPredictionId,
    source_test_draw_no: sourceTestDrawNo,
    requested_selection: selection,
    recent_draw_count: recentDrawCount,
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
    .select('id, created_at, groups_json, source_draw_no, target_periods, status')
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
        groups: parseGroupsJson(existing.groups_json)
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
      manual_locked: true,
      target_periods: 1,
      bet_type: 'single_period_weighted_focus_top1x3_top2x1_manual_only',
      cost_per_group: COST_PER_GROUP,
      group_count: GROUP_COUNT,
      formal_batch_limit: FORMAL_BATCH_LIMIT,
      ...result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      api_version: API_VERSION,
      error: error?.message || 'prediction-save failed'
    });
  }
}
