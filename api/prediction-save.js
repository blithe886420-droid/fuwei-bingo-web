import { createClient } from '@supabase/supabase-js';
import { buildBingoV1Strategies } from '../lib/buildBingoV1Strategies.js';

const API_VERSION = 'prediction-save-e-phase-final-write-v3-force-insert';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';

const TEST_MODE = 'test';
const FORMAL_MODE = 'formal';
const FORMAL_CANDIDATE_MODE = 'formal_candidate';

const COST_PER_GROUP = 25;
const FORMAL_BATCH_LIMIT = 999;
const GROUP_COUNT = 4;
const MAX_GROUPS_PER_STRATEGY = 1;

const DEFAULT_ANALYSIS_PERIOD = 20;
const ALLOWED_ANALYSIS_PERIODS = new Set([5, 10, 20, 50]);
const ALLOWED_STRATEGY_MODES = new Set(['hot', 'cold', 'mix', 'burst']);
const ALLOWED_RISK_MODES = new Set(['safe', 'balanced', 'aggressive', 'sniper']);

const MIN_TIER_A_ROUNDS = 20;
const MIN_TIER_B_ROUNDS = 10;
const MAX_GROUP_OVERLAP = 2;

const FORMAL_MIN_RECENT_50_HIT_RATE = 0.12;
const FORMAL_MIN_HIT2_RATE = 0.12;
const FORMAL_MIN_RECENT_50_HIT3_RATE = 0.005;
const FORMAL_STRONG_RECENT_50_HIT3_RATE = 0.03;
const FORMAL_MIN_RECENT_50_ROI = -0.85;

let supabase = null;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_KEY');
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

function normalizeAnalysisPeriod(value, fallback = DEFAULT_ANALYSIS_PERIOD) {
  const n = toNum(value, fallback);
  return ALLOWED_ANALYSIS_PERIODS.has(n) ? n : fallback;
}

function getSelectionParams(req) {
  return {
    analysisPeriod: DEFAULT_ANALYSIS_PERIOD,
    strategyMode: 'mix',
    riskMode: 'balanced'
  };
}

function deriveBackendAnalysisPeriod(sourcePrediction = null, marketSnapshot = {}, fallback = DEFAULT_ANALYSIS_PERIOD) {
  return normalizeAnalysisPeriod(
    sourcePrediction?.analysis_period ||
      sourcePrediction?.analysisPeriod ||
      marketSnapshot?.analysis_period_hint ||
      marketSnapshot?.analysisPeriodHint ||
      fallback,
    fallback
  );
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

function getPhaseBucketStats(group = {}, phaseContext = null) {
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const marketPhase = String(phaseContext?.marketPhase || '').trim().toLowerCase();
  const phaseStatsJson = safeJsonParse(meta.phase_stats_json, meta.phase_stats_json) || {};
  const bucket =
    marketPhase && phaseStatsJson && typeof phaseStatsJson === 'object'
      ? phaseStatsJson[marketPhase] || {}
      : {};

  return {
    rounds: toNum(bucket?.rounds, 0),
    avgHit: toNum(bucket?.avg_hit, 0),
    roi: toNum(bucket?.roi, 0),
    hit2Rate: toNum(bucket?.hit2_rate, 0),
    hit3Rate: toNum(bucket?.hit3_rate, 0),
    hit4Rate: toNum(bucket?.hit4_rate, 0),
    recent20HitRate: toNum(bucket?.recent_20_hit_rate, 0),
    recent20Hit3Rate: toNum(bucket?.recent_20_hit3_rate, 0),
    recent20Hit4Rate: toNum(bucket?.recent_20_hit4_rate, 0),
    recent20Roi: toNum(bucket?.recent_20_roi, 0)
  };
}

function getPhaseBestSnapshot(group = {}, phaseContext = null) {
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const bestJson = safeJsonParse(meta.phase_best_json, meta.phase_best_json) || {};
  const marketPhase = String(phaseContext?.marketPhase || '').trim().toLowerCase();
  const bestPhase = String(bestJson?.best_phase || '').trim().toLowerCase();
  const phaseScores = bestJson?.phase_scores && typeof bestJson.phase_scores === 'object' ? bestJson.phase_scores : {};

  return {
    bestPhase,
    bestScore: toNum(bestJson?.best_score, 0),
    currentPhaseScore: toNum(phaseScores?.[marketPhase], 0),
    bestPhaseMatched: !!marketPhase && bestPhase === marketPhase
  };
}

function getFormalStabilitySnapshot(group = {}, phaseContext = null) {
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const phaseBucket = getPhaseBucketStats(group, phaseContext);
  const phaseBest = getPhaseBestSnapshot(group, phaseContext);

  const totalRounds = toNum(meta.total_rounds, 0);
  const phaseRounds = phaseBucket.rounds;
  const phaseWeight = phaseRounds >= 8 ? 0.65 : phaseRounds >= 4 ? 0.45 : phaseRounds >= 2 ? 0.25 : 0;
  const globalWeight = 1 - phaseWeight;

  const mix = (globalValue, phaseValue) => round4(toNum(globalValue, 0) * globalWeight + toNum(phaseValue, 0) * phaseWeight);

  return {
    totalRounds,
    phaseRounds,
    recent50HitRate: mix(meta.recent_50_hit_rate, phaseBucket.recent20HitRate),
    hit2Rate: mix(meta.hit2_rate, phaseBucket.hit2Rate),
    recent50Hit3Rate: mix(meta.recent_50_hit3_rate, phaseBucket.recent20Hit3Rate),
    hit3Rate: mix(meta.hit3_rate, phaseBucket.hit3Rate),
    recent50Hit4Rate: mix(meta.recent_50_hit4_rate, phaseBucket.recent20Hit4Rate),
    hit4Rate: mix(meta.hit4_rate, phaseBucket.hit4Rate),
    recent50Roi: mix(meta.recent_50_roi, phaseBucket.recent20Roi),
    roi: mix(meta.roi, phaseBucket.roi),
    avgHit: mix(meta.avg_hit, phaseBucket.avgHit),
    phaseBestMatched: phaseBest.bestPhaseMatched,
    phaseBestScore: phaseBest.bestScore,
    currentPhaseScore: phaseBest.currentPhaseScore
  };
}

function isStableFormalCandidate(group = {}, slotNo = 1, phaseContext = null) {
  const stats = getFormalStabilitySnapshot(group, phaseContext);
  const totalRounds = stats.totalRounds;

  if (totalRounds <= 0) return false;

  if (totalRounds >= 8) {
    if (stats.recent50HitRate < FORMAL_MIN_RECENT_50_HIT_RATE) return false;
    if (stats.hit2Rate < FORMAL_MIN_HIT2_RATE) return false;
    if (stats.recent50Roi < FORMAL_MIN_RECENT_50_ROI) return false;
  }

  if (slotNo <= 2 && totalRounds >= 12) {
    if (stats.recent50Hit3Rate < FORMAL_MIN_RECENT_50_HIT3_RATE && stats.hit3Rate < FORMAL_MIN_RECENT_50_HIT3_RATE) {
      return false;
    }
  }

  return true;
}

function isFormalHardRejectCandidate(group = {}, slotNo = 1, phaseContext = null) {
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const stats = getFormalStabilitySnapshot(group, phaseContext);
  const totalRounds = stats.totalRounds;
  const decision = String(meta.decision || '').trim().toLowerCase();
  const blendedHit3Rate = Math.max(stats.recent50Hit3Rate, stats.hit3Rate);
  const blendedRoi = Math.max(stats.recent50Roi, stats.roi);

  if (decision === 'reject') return true;
  if (totalRounds <= 0) return true;

  if (totalRounds >= 8) {
    if (stats.recent50HitRate < FORMAL_MIN_RECENT_50_HIT_RATE) return true;
    if (stats.hit2Rate < FORMAL_MIN_HIT2_RATE) return true;
    if (stats.recent50Roi < FORMAL_MIN_RECENT_50_ROI) return true;
  }

  if (slotNo <= 2 && totalRounds >= 12 && blendedHit3Rate < FORMAL_MIN_RECENT_50_HIT3_RATE) {
    return true;
  }

  if (slotNo <= 2 && totalRounds >= 20 && blendedHit3Rate <= 0) {
    return true;
  }

  if (slotNo === 1 && totalRounds >= 20) {
    if (stats.recent50HitRate < 0.15) return true;
    if (stats.hit2Rate < 0.15) return true;
  }

  if (slotNo === 1 && totalRounds >= 30 && blendedRoi < -0.75) {
    return true;
  }

  // 第1、2槽：輪數不足 50 輪且 hit3 = 0，直接拒絕
  // 避免小樣本假高分策略佔據重要槽位
  if (slotNo <= 2 && totalRounds < 50 && blendedHit3Rate <= 0) {
    return true;
  }

  // 第1槽：輪數不足 30 輪直接拒絕，讓有歷史資料的策略優先
  if (slotNo === 1 && totalRounds < 30) {
    return true;
  }

  return false;
}

function getFormalStabilityBonus(group = {}, slotNo = 1, phaseContext = null) {
  const stats = getFormalStabilitySnapshot(group, phaseContext);
  let bonus = 0;

  bonus += stats.recent50HitRate * 4200;
  bonus += stats.hit2Rate * 3600;
  bonus += Math.max(stats.recent50Hit3Rate, stats.hit3Rate) * 2600;
  bonus += Math.max(stats.recent50Roi, stats.roi) * 140;

  if (stats.recent50HitRate >= 0.35) bonus += 360;
  if (stats.hit2Rate >= 0.3) bonus += 280;
  if (stats.recent50Hit3Rate >= FORMAL_STRONG_RECENT_50_HIT3_RATE) bonus += 180;
  if (slotNo <= 2 && stats.recent50Hit3Rate >= FORMAL_STRONG_RECENT_50_HIT3_RATE) bonus += 120;
  if (stats.recent50Roi >= 0) bonus += 100;
  if (stats.phaseBestMatched) bonus += 220;
  bonus += stats.currentPhaseScore * 0.45;
  if (stats.phaseRounds >= 4) bonus += Math.min(stats.phaseRounds, 20) * 12;
  if (stats.phaseRounds >= 8 && stats.recent50HitRate >= 0.28) bonus += 90;

  return round4(bonus);
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
      phase_stats_json: stats.phase_stats_json || meta.phase_stats_json || {},
      phase_best_json: stats.phase_best_json || meta.phase_best_json || {},
      phase_best_phase: String((stats.phase_best_json && stats.phase_best_json.best_phase) || meta.phase_best_phase || '').trim().toLowerCase() || null,
      phase_best_score: pickMetric(stats.phase_best_json && stats.phase_best_json.best_score, meta.phase_best_score),
      phase_current_phase: meta.phase_current_phase || null,
      phase_current_score: pickMetric(meta.phase_current_score, 0),
      phase_best_matched: Boolean(meta.phase_best_matched),
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

function buildStrategyPoolGroups(poolRows = [], statsRows = [], pools = {}, selection = {}, phaseContext = null, sourceDraw = null) {
  const groups = [];
  const statsMap = new Map(
    (Array.isArray(statsRows) ? statsRows : []).map((row) => [String(row?.strategy_key || '').trim(), row])
  );

  for (const row of Array.isArray(poolRows) ? poolRows : []) {
    const strategyKey = String(row?.strategy_key || '').trim();
    if (!strategyKey || isFallbackStrategyKey(strategyKey)) continue;

    const stats = statsMap.get(strategyKey);
    if (!stats) continue;

    const totalRounds = toNum(stats.total_rounds, 0);
    if (totalRounds < 3) continue;

    const recent50HitRate = toNum(stats.recent_50_hit_rate, 0);
    const hit2Rate = toNum(stats.hit2_rate, 0);
    const recent50Hit3Rate = toNum(stats.recent_50_hit3_rate, 0);
    const hit3Rate = toNum(stats.hit3_rate, 0);
    const recent50Roi = toNum(stats.recent_50_roi, 0);

    if (totalRounds >= 8 && recent50HitRate < FORMAL_MIN_RECENT_50_HIT_RATE) continue;
    if (totalRounds >= 8 && hit2Rate < FORMAL_MIN_HIT2_RATE) continue;
    if (totalRounds >= 8 && recent50Roi < FORMAL_MIN_RECENT_50_ROI) continue;
    if (totalRounds >= 12 && recent50Hit3Rate < FORMAL_MIN_RECENT_50_HIT3_RATE && hit3Rate < FORMAL_MIN_RECENT_50_HIT3_RATE) continue;

    const role = inferRoleFromGroup({
      key: strategyKey,
      meta: {
        strategy_key: strategyKey,
        preferred_role: stats?.preferred_role || ''
      }
    });

    let nums = buildNumsFromStrategyKey(strategyKey, pools, selection, phaseContext);
    if (nums.length !== 4) continue;

    if (!isAcceptableGroup(nums, pools, role, selection, phaseContext)) {
      nums = fillToFour(
        nums,
        [pools.qualityAll || [], pools.hot || [], pools.gap || [], pools.all || []],
        strategyKey.length * 53
      );
    }

    if (nums.length !== 4) continue;

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
        decision: 'from_strategy_pool',
        total_rounds: toNum(stats.total_rounds, 0),
        total_profit: toNum(stats.total_profit, 0),
        roi: toNum(stats.roi, 0),
        avg_hit: toNum(stats.avg_hit, 0),
        hit2: toNum(stats.hit2, 0),
        hit3: toNum(stats.hit3, 0),
        hit4: toNum(stats.hit4, 0),
        hit2_rate: toNum(stats.hit2_rate, 0),
        hit3_rate: toNum(stats.hit3_rate, 0),
        hit4_rate: toNum(stats.hit4_rate, 0),
        recent_50_roi: toNum(stats.recent_50_roi, 0),
        recent_50_hit_rate: toNum(stats.recent_50_hit_rate, 0),
        recent_50_hit3_rate: toNum(stats.recent_50_hit3_rate, 0),
        recent_50_hit4_rate: toNum(stats.recent_50_hit4_rate, 0),
        score: toNum(stats.score, 0)
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

function buildWeightProfile(marketPhase = 'rotation', lastHitLevel = 'neutral', marketType = 'random', riskModeHint = 'balanced') {
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

  if (marketType === 'strong_trend') {
    profile.attack += 0.14;
    profile.extend += 0.08;
    profile.guard -= 0.06;
  } else if (marketType === 'weak_trend') {
    profile.attack += 0.05;
    profile.extend += 0.06;
  } else {
    profile.guard += 0.10;
    profile.extend += 0.04;
    profile.attack -= 0.06;
  }

  if (riskModeHint === 'aggressive') {
    profile.attack += 0.08;
    profile.extend += 0.03;
  } else if (riskModeHint === 'safe') {
    profile.guard += 0.08;
    profile.attack -= 0.05;
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
  const marketType = String(
    sourcePrediction?.market_type ||
      sourcePrediction?.marketType ||
      marketSnapshot?.market_type ||
      'random'
  ).trim().toLowerCase();
  const strategyModeHint = String(
    sourcePrediction?.strategy_mode ||
      sourcePrediction?.strategyMode ||
      marketSnapshot?.strategy_mode_hint ||
      'mix'
  ).trim().toLowerCase();
  const riskModeHint = String(
    sourcePrediction?.risk_mode ||
      sourcePrediction?.riskMode ||
      marketSnapshot?.risk_mode_hint ||
      'balanced'
  ).trim().toLowerCase();
  const lastHitLevel = inferLastHitLevel(lastComparedPrediction);
  const confidenceScore = clamp(
    toNum(
      sourcePrediction?.confidence_score ||
        sourcePrediction?.meta?.confidence_score ||
        sourcePrediction?.market_signal_json?.confidence_score ||
        marketSnapshot?.confidence_score,
      45
    ),
    0,
    100
  );

  return {
    marketPhase,
    marketType,
    strategyModeHint,
    riskModeHint,
    lastHitLevel,
    confidenceScore,
    weightProfile: buildWeightProfile(marketPhase, lastHitLevel, marketType, riskModeHint)
  };
}


function applyMarketControl(selection = {}, phaseContext = null) {
  const safeSelection =
    selection && typeof selection === 'object'
      ? { ...selection }
      : {
          analysisPeriod: DEFAULT_ANALYSIS_PERIOD,
          strategyMode: 'mix',
          riskMode: 'balanced'
        };

  const marketPhase = String(phaseContext?.marketPhase || '').trim().toLowerCase();

  if (marketPhase === 'continuation') {
    return {
      ...safeSelection,
      strategyMode: 'hot',
      riskMode: 'aggressive'
    };
  }

  if (marketPhase === 'rotation') {
    return {
      ...safeSelection,
      strategyMode: 'mix',
      riskMode: 'balanced'
    };
  }

  return {
    ...safeSelection,
    strategyMode: 'cold',
    riskMode: 'safe'
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

  const recent3Rows = rows.slice(0, 3);
  const recent3CountMap = new Map();
  recent3Rows.forEach((row) => {
    parseNums(row?.numbers).forEach((n) => {
      recent3CountMap.set(n, toNum(recent3CountMap.get(n), 0) + 1);
    });
  });

  const latestNumsSet = new Set(parseNums(rows[0]?.numbers || []));
  const prevNumsSet = new Set(parseNums(rows[1]?.numbers || []));
  const streakSet = new Set([...streak2, ...streak3, ...streak4]);

  const preStreak = uniqueAsc(
    [...recent3CountMap.entries()]
      .filter(([n, count]) => {
        if (count < 2) return false;
        if (streakSet.has(n)) return false;
        return latestNumsSet.has(n) || prevNumsSet.has(n);
      })
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([n]) => n)
  );

  const attack = uniqueAsc([
    ...(marketSnapshot?.decision_basis?.attack_core_numbers || []),
    ...streak4,
    ...streak3,
    ...streak2.slice(0, 6),
    ...preStreak.slice(0, 1),
    ...hot5Numbers.slice(0, 12),
    ...hot10Numbers.slice(0, 8)
  ]);

  const extend = uniqueAsc([
    ...(marketSnapshot?.decision_basis?.extend_numbers || []),
    ...streak2,
    ...preStreak.slice(0, 1),
    ...hot10Numbers.slice(0, 14),
    ...hot20Numbers.slice(0, 10),
    ...gap.slice(0, 8)
  ]);

  const guard = uniqueAsc([
    ...(marketSnapshot?.decision_basis?.guard_numbers || []),
    ...hot20Numbers.slice(0, 20),
    ...warm.slice(0, 16),
    ...preStreak.slice(0, 1),
    ...cold.slice(0, 8)
  ]);

  const recent = uniqueAsc([
    ...(marketSnapshot?.decision_basis?.recent_focus_numbers || []),
    ...parseNums(rows[0]?.numbers || []),
    ...preStreak.slice(0, 1),
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
    preStreak,
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
  const streakCount = arr.filter((n) => (pools.streak2 || []).includes(n) || (pools.streak3 || []).includes(n) || (pools.streak4 || []).includes(n)).length;
  const preStreakCount = arr.filter((n) => (pools.preStreak || []).includes(n)).length;

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
    gapCount,
    streakCount,
    preStreakCount
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

  if (role === 'attack') score += report.attackCount * 8 + report.hotCount * 4 + report.streakCount * 22 + report.preStreakCount * 4;
  if (role === 'extend') score += report.extendCount * 7 + report.gapCount * 5 + report.preStreakCount * 4 + report.streakCount * 8;
  if (role === 'guard') score += report.guardCount * 7 + report.hotCount * 3 + report.preStreakCount * 2;
  if (role === 'recent') score += report.hotCount * 4 + report.extendCount * 4 + report.preStreakCount * 4 + report.streakCount * 10;

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

  if (riskMode === 'safe') return ['guard', 'extend', 'recent', 'attack'];
  if (riskMode === 'balanced') return ['extend', 'guard', 'recent', 'attack'];
  if (riskMode === 'aggressive') return ['attack', 'extend', 'guard', 'recent'];
  return ['recent', 'extend', 'guard', 'attack'];
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
  if (role === 'attack') floor = 135;
  if (role === 'extend') floor = 145;
  if (role === 'guard') floor = 95;
  if (role === 'recent') floor = 100;
  if (selection.riskMode === 'safe') floor += 10;
  if (selection.riskMode === 'balanced' && (role === 'extend' || role === 'guard')) floor += 10;
  if (selection.riskMode === 'balanced' && role === 'attack') floor += 8;
  if (selection.riskMode === 'aggressive' && role === 'attack') floor -= 5;
  if (phaseContext?.marketPhase === 'continuation' && role === 'attack') floor -= 10;
  if (phaseContext?.marketPhase === 'rotation' && role === 'attack') floor += 10;
  return floor;
}

function getRecentRoiFloor(role = 'mix', selection = {}, phaseContext = null) {
  let floor = -0.15;
  if (role === 'attack') floor = -0.08;
  if (role === 'extend') floor = -0.20;
  if (role === 'guard') floor = -0.26;
  if (role === 'recent') floor = -0.24;
  if (selection.riskMode === 'safe') floor += 0.05;
  if (selection.riskMode === 'balanced' && (role === 'extend' || role === 'guard')) floor += 0.03;
  if (selection.riskMode === 'balanced' && role === 'attack') floor += 0.02;
  if (phaseContext?.lastHitLevel === 'bad') floor += 0.04;
  return round4(floor);
}

function getHit3RateFloor(role = 'mix', selection = {}, phaseContext = null) {
  let floor = 0.01;
  if (role === 'attack') floor = 0.02;
  if (role === 'extend') floor = 0.01;
  if (role === 'guard') floor = 0.004;
  if (role === 'recent') floor = 0.008;
  if (selection.strategyMode === 'hot') floor += 0.002;
  if (selection.riskMode === 'balanced' && role === 'attack') floor += 0.004;
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

function isStrategyPoolGroup(group = {}) {
  return String(group?.meta?.source_tag || '').trim().toLowerCase() === 'strategy_pool';
}

function getSourceTag(group = {}) {
  return String(group?.meta?.source_tag || group?.meta?.decision || 'source').trim();
}

function getStrategySelectionPower(group = {}) {
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const hit2Rate = toNum(meta.hit2_rate, 0);
  const recent50HitRate = toNum(meta.recent_50_hit_rate, 0);
  const hit3Rate = Math.max(toNum(meta.hit3_rate, 0), toNum(meta.recent_50_hit3_rate, 0));
  const roi = Math.max(toNum(meta.roi, 0), toNum(meta.recent_50_roi, 0));
  const avgHit = toNum(meta.avg_hit, 0);
  const totalRounds = toNum(meta.total_rounds, 0);
  return round4(
    hit2Rate * 3200 +
    recent50HitRate * 2600 +
    hit3Rate * 4200 +
    roi * 320 +
    avgHit * 90 +
    Math.min(totalRounds, 200) * 2.5
  );
}

function scoreGroupForMode(group, role = 'mix', strategyMode = 'mix', riskMode = 'balanced', pools = {}, phaseContext = null) {
  const nums = uniqueAsc(group?.nums || []);
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};
  const report = buildGroupQualityReport(nums, pools);
  const blendedRoi = getBlendedRoi(group);
  const blendedHit3Rate = getBlendedHit3Rate(group);
  const recent50Roi = toNum(meta.recent_50_roi, blendedRoi);
  const recent50Hit3Rate = toNum(meta.recent_50_hit3_rate, blendedHit3Rate);
  const recent50HitRate = toNum(meta.recent_50_hit_rate, 0);
  const hit2Rate = toNum(meta.hit2_rate, 0);
  const avgHit = toNum(meta.avg_hit, 0);
  const totalRounds = toNum(meta.total_rounds, 0);
  const phaseBucket = getPhaseBucketStats(group, phaseContext);
  const phaseBest = getPhaseBestSnapshot(group, phaseContext);

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

  const marketType = String(phaseContext?.marketType || '').trim().toLowerCase();
  const strategyModeHint = String(phaseContext?.strategyModeHint || '').trim().toLowerCase();
  const riskModeHint = String(phaseContext?.riskModeHint || '').trim().toLowerCase();

  let score = scoreQualityReport(report, role, { strategyMode, riskMode }, phaseContext);
  score += blendedRoi * 260;
  score += recent50Roi * 340;
  score += hit2Rate * 3200;
  score += recent50HitRate * 2600;
  score += blendedHit3Rate * 3600;
  score += recent50Hit3Rate * 4200;
  score += avgHit * 65;
  score += totalRounds * 1.6;
  score += toNum(meta.hit4_rate, 0) * 5200;
  score += toNum(meta.recent_50_hit4_rate, 0) * 6000;
  score += phaseBucket.hit2Rate * 2400;
  score += phaseBucket.recent20HitRate * 3000;
  score += phaseBucket.hit3Rate * 4200;
  score += phaseBucket.recent20Hit3Rate * 5200;
  score += phaseBucket.recent20Hit4Rate * 7600;
  score += phaseBucket.recent20Roi * 420;
  score += phaseBest.currentPhaseScore * 0.8;
  if (phaseBest.bestPhaseMatched) score += 380;
  if (phaseBucket.rounds >= 4) score += Math.min(phaseBucket.rounds, 20) * 18;

  if (blendedRoi < 0) score += blendedRoi * 260;
  if (recent50Roi < 0) score += recent50Roi * 320;
  if (hit2Rate <= 0) score -= 520;
  if (recent50HitRate <= 0) score -= 420;
  if (blendedHit3Rate <= 0) score -= 180;
  if (recent50Hit3Rate <= 0) score -= 220;

  score *= roleWeight;

  if (riskMode === 'safe' && role === 'guard') score += 35;
  if (riskMode === 'aggressive' && role === 'attack') score += 35;
  if (strategyMode === 'cold') score += report.gapCount * 8;
  if (strategyMode === 'hot') score += report.hotCount * 8;
  if (strategyMode === 'burst') score += report.attackCount * 12;

  if (marketType === 'strong_trend') {
    if (role === 'attack') score += 48;
    if (role === 'extend') score += 24;
    score += report.hotCount * 12;
    score += report.attackCount * 15;
  } else if (marketType === 'weak_trend') {
    if (role === 'extend') score += 24;
    if (role === 'attack') score += 12;
    score += report.hotCount * 6;
    score += report.gapCount * 4;
  } else {
    if (role === 'guard') score += 30;
    score += report.gapCount * 9;
  }

  if (strategyModeHint === 'hot') score += report.hotCount * 4;
  if (strategyModeHint === 'cold') score += report.gapCount * 4;
  if (riskModeHint === 'aggressive' && role === 'attack') score += 18;
  if (riskModeHint === 'safe' && role === 'guard') score += 18;

  score += report.streakCount * 34;
  score += report.preStreakCount * 4;
  if (role === 'attack' && report.streakCount === 0 && report.preStreakCount === 0) score -= 110;
  if (role === 'extend' && report.preStreakCount === 0 && report.streakCount === 0) score -= 18;
  if (role === 'recent' && report.preStreakCount === 0 && report.streakCount === 0) score -= 24;

  if (riskMode === 'balanced') {
    if (role === 'extend') {
      score += hit2Rate * 900;
      score += recent50HitRate * 700;
      if (blendedHit3Rate <= 0) score -= 80;
    }

    if (role === 'guard') {
      score += hit2Rate * 820;
      score += recent50HitRate * 760;
      if (recent50Roi < -0.45) score -= 120;
    }

    if (role === 'recent') {
      score += recent50HitRate * 420;
      score += blendedHit3Rate * 600;
    }

    if (role === 'attack') {
      score += blendedHit3Rate * 1350;
      score += recent50Hit3Rate * 1650;
      if (hit2Rate < 0.2) score -= 260;
      if (recent50HitRate < 0.2) score -= 220;
    }
  }

  return round4(score);
}

function getRoleSeedPools(role = 'mix', pools = {}, phaseContext = null) {
  const marketPhase = String(phaseContext?.marketPhase || '').toLowerCase();

  if (marketPhase === 'rotation') {
    if (role === 'attack') return [pools.streak4, pools.streak3, pools.streak2, pools.attack, pools.recent, pools.hot10 || pools.hot, pools.preStreak, pools.all];
    if (role === 'extend') return [pools.streak2, pools.extend, pools.guard, pools.hot10 || pools.hot, pools.preStreak, pools.recent, pools.all];
    if (role === 'guard') return [pools.guard, pools.streak2, pools.extend, pools.hot20 || pools.warm, pools.preStreak, pools.cold, pools.all];
    if (role === 'recent') return [pools.streak2, pools.recent, pools.extend, pools.hot5 || pools.hot, pools.preStreak, pools.guard, pools.all];
    return [pools.streak2, pools.extend, pools.guard, pools.hot, pools.preStreak, pools.all];
  }

  if (role === 'attack') return [pools.streak4, pools.streak3, pools.streak2, pools.attack, pools.hot5 || pools.hot, pools.hot10 || pools.hot, pools.preStreak, pools.recent, pools.all];
  if (role === 'extend') return [pools.streak2, pools.extend, pools.hot10 || pools.hot, pools.hot20 || pools.hot, pools.preStreak, pools.guard, pools.all];
  if (role === 'guard') return [pools.guard, pools.streak2, pools.hot20 || pools.hot, pools.warm, pools.preStreak, pools.cold, pools.all];
  if (role === 'recent') return [pools.streak2, pools.recent, pools.attack, pools.hot5 || pools.hot, pools.preStreak, pools.extend, pools.all];
  return [pools.streak2, pools.hot, pools.extend, pools.guard, pools.preStreak, pools.all];
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
    pools.streak2,
    pools.preStreak,
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

  if (slotRole === 'attack') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums,
          ...(pools.streak4 || []).slice(0, 1),
          ...(pools.streak3 || []).slice(0, 1),
          ...(pools.streak2 || []).slice(0, 2),
          ...(pools.preStreak || []).slice(0, 1),
          ...(pools.attack || []).slice(0, 2)
        ]),
        fallbackPools,
        seedBase + 23
      ),
      'attack_streak_pre',
      22
    );
  }

  if (slotRole === 'extend') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums,
          ...(pools.preStreak || []).slice(0, 1),
          ...(pools.extend || []).slice(0, 3),
          ...(pools.gap || []).slice(0, 1)
        ]),
        fallbackPools,
        seedBase + 29
      ),
      'extend_pre_streak',
      13
    );
  }

  if (slotRole === 'recent') {
    addCandidate(
      fillToFour(
        uniqueAsc([
          ...keepNums,
          ...(pools.preStreak || []).slice(0, 1),
          ...(pools.recent || []).slice(0, 3),
          ...(pools.hot5 || []).slice(0, 2)
        ]),
        fallbackPools,
        seedBase + 37
      ),
      'recent_pre_streak',
      11
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
  const phaseBest = getPhaseBestSnapshot(sourceGroup, phaseContext);
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
    phase_stats_json: meta.phase_stats_json || {},
    phase_best_json: meta.phase_best_json || {},
    phase_best_phase: phaseBest.bestPhase || String(meta.phase_best_phase || '').trim().toLowerCase() || phaseContext?.marketPhase || null,
    phase_best_score: pickMetric(phaseBest.bestScore, meta.phase_best_score),
    phase_current_phase: phaseContext?.marketPhase || null,
    phase_current_score: pickMetric(phaseBest.currentPhaseScore, meta.phase_current_score),
    phase_best_matched: Boolean(phaseBest.bestPhaseMatched),
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
      phase_stats_json: {},
      phase_best_json: {},
      phase_best_phase: phaseContext.marketPhase,
      phase_best_score: 0,
      phase_current_phase: phaseContext.marketPhase,
      phase_current_score: 0,
      phase_best_matched: true,
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
    const strategyKey = getStrategyKey(group) || `unknown|${numsKey}`;
    const safeKey = strategyKey;
    const prev = bucket.get(safeKey);

    const score =
      getStrategySelectionPower(group) +
      toNum(group?.meta?.score, 0) * 0.15 +
      getBlendedRoi(group) * 100 +
      getBlendedHit3Rate(group) * 1200;

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

function dedupeSourceGroupsByStrategy(sourceGroups = [], selection = {}, pools = {}, phaseContext = null) {
  const bestByStrategy = new Map();
  const fallbackGroups = [];

  for (const group of Array.isArray(sourceGroups) ? sourceGroups : []) {
    if (!group || typeof group !== 'object') continue;

    const strategyKey = getStrategyKey(group);
    const inferredRole = inferRoleFromGroup(group);
    const baseScore = scoreGroupForMode(
      group,
      inferredRole,
      selection.strategyMode,
      selection.riskMode,
      pools,
      phaseContext
    ) + getFormalStabilityBonus(group, 1) + getStrategySelectionPower(group);

    if (!strategyKey) {
      fallbackGroups.push({ group, inferredRole, baseScore });
      continue;
    }

    const previous = bestByStrategy.get(strategyKey);
    if (!previous || baseScore > previous.baseScore) {
      bestByStrategy.set(strategyKey, { group, inferredRole, baseScore });
    }
  }

  return [
    ...[...bestByStrategy.values()].map((row) => row.group),
    ...fallbackGroups.map((row) => row.group)
  ];
}

function buildRankedSourceGroups(sourceGroups = [], selection = {}, pools = {}, phaseContext = null) {
  return dedupeSourceGroupsByStrategy(sourceGroups, selection, pools, phaseContext)
    .filter((group) => !isFormalHardRejectCandidate(group, 1, phaseContext))
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

      const isPool = isStrategyPoolGroup(group);

      const stabilityBonus = getFormalStabilityBonus(group, 1, phaseContext);

      const totalRoundsForPenalty = toNum(group?.meta?.total_rounds, 0);
      // 輪數太少（< 20輪）的策略給予分數懲罰，避免新策略因小樣本假高分擠掉老策略
      const lowRoundsPenalty = totalRoundsForPenalty < 5 ? -8000
        : totalRoundsForPenalty < 10 ? -6000
        : totalRoundsForPenalty < 20 ? -4000
        : totalRoundsForPenalty < 30 ? -2000
        : 0;
      // 輪數夠多（>= 50輪）給予經驗加成
      const experienceBonus = totalRoundsForPenalty >= 300 ? 1200
        : totalRoundsForPenalty >= 200 ? 900
        : totalRoundsForPenalty >= 100 ? 600
        : totalRoundsForPenalty >= 50 ? 300
        : 0;

      return {
        group,
        role,
        score: isPool
          ? round4(score + 120 + stabilityBonus + lowRoundsPenalty + experienceBonus)
          : round4(score + stabilityBonus + lowRoundsPenalty + experienceBonus),
        tier,
        strategyKey: getStrategyKey(group),
        totalRounds: totalRoundsForPenalty,
        sourceTag: getSourceTag(group),
        selectionPower: getStrategySelectionPower(group),
        phaseBestMatched: getPhaseBestSnapshot(group, phaseContext).bestPhaseMatched,
        phaseCurrentScore: getPhaseBestSnapshot(group, phaseContext).currentPhaseScore,
        isPool
      };
    })
    .sort((a, b) => {
      const slotPriorityA =
        candidateTierBonus(a.tier) +
        a.score +
        a.selectionPower +
        a.totalRounds +
        (a.phaseBestMatched ? 1800 : 0) +
        a.phaseCurrentScore * 1.5;
      const slotPriorityB =
        candidateTierBonus(b.tier) +
        b.score +
        b.selectionPower +
        b.totalRounds +
        (b.phaseBestMatched ? 1800 : 0) +
        b.phaseCurrentScore * 1.5;
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
      const isPool = isStrategyPoolGroup(rankedRow.group);

      if (slotNo <= 3 && isFallbackStrategyKey(strategyKey)) continue;
      if (strategyKey && usedCount >= MAX_GROUPS_PER_STRATEGY) continue;
      if (isFormalHardRejectCandidate(rankedRow.group, slotNo)) continue;

      const score = scoreGroupForMode(
        rankedRow.group,
        role,
        selection.strategyMode,
        selection.riskMode,
        pools,
        phaseContext
      );

      const tier = getCandidateTier(rankedRow.group, score, role, selection, phaseContext);
      if (!isPool && !meetsMinTier(tier, requiredTier)) continue;

      const bonus = candidateTierBonus(tier) - usedCount * 1500 + getStrategySelectionPower(rankedRow.group) + (getPhaseBestSnapshot(rankedRow.group, phaseContext).bestPhaseMatched ? 2200 : 0);
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
      if (isFormalHardRejectCandidate(rankedRow.group, slotNo)) continue;
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

function getBalancedSlotRole(nextSlotNo = 1, sourceGroup = null, fallbackRole = 'mix') {
  const inferredRole = inferRoleFromGroup(sourceGroup);

  if (nextSlotNo === 1) {
    if (inferredRole === 'extend' || inferredRole === 'guard') return inferredRole;
    return 'extend';
  }

  if (nextSlotNo === 2) {
    if (inferredRole === 'guard' || inferredRole === 'extend') return inferredRole;
    return 'guard';
  }

  if (nextSlotNo === 3) {
    if (inferredRole === 'guard' || inferredRole === 'recent' || inferredRole === 'extend') return inferredRole;
    return 'recent';
  }

  if (inferredRole === 'attack') return 'attack';
  return 'attack';
}

function buildFormalGroups(sourceGroups = [], sourcePrediction = null, sourceDraw = null, selection = {}, pools = {}, phaseContext = null) {
  const uniqueSourceGroups = dedupeSourceGroupsByStrategy(sourceGroups, selection, pools, phaseContext);
  const ranked = buildRankedSourceGroups(uniqueSourceGroups, selection, pools, phaseContext);
  const groups = [];
  const usedStrategyKeys = new Set();

  const getBalancedSlotRoleBySource = (slotNo = 1, sourceGroup = null) => {
    const inferredRole = inferRoleFromGroup(sourceGroup);

    if (slotNo === 1) {
      if (inferredRole === 'extend' || inferredRole === 'guard') return inferredRole;
      return 'extend';
    }

    if (slotNo === 2) {
      if (inferredRole === 'guard' || inferredRole === 'extend') return inferredRole;
      return 'guard';
    }

    if (slotNo === 3) {
      if (inferredRole === 'guard' || inferredRole === 'recent' || inferredRole === 'extend') return inferredRole;
      return 'recent';
    }

    return 'attack';
  };

  const canUseBalancedSlot = (sourceGroup, slotNo, slotRole) => {
    if (!sourceGroup) return false;
    if (isFormalHardRejectCandidate(sourceGroup, slotNo, phaseContext)) return false;

    const strategyKey = getStrategyKey(sourceGroup);
    if (strategyKey && usedStrategyKeys.has(strategyKey)) return false;

    const totalRounds = toNum(sourceGroup?.meta?.total_rounds, 0);
    const roi = getBlendedRoi(sourceGroup);
    const hit3 = getBlendedHit3Rate(sourceGroup);
    const recent50HitRate = toNum(sourceGroup?.meta?.recent_50_hit_rate, 0);
    const hit2Rate = toNum(sourceGroup?.meta?.hit2_rate, 0);
    const recent50Hit3Rate = toNum(sourceGroup?.meta?.recent_50_hit3_rate, 0);
    const recent50Roi = toNum(sourceGroup?.meta?.recent_50_roi, 0);

    if (!isStableFormalCandidate(sourceGroup, slotNo, phaseContext)) return false;
    const phaseBest = getPhaseBestSnapshot(sourceGroup, phaseContext);
    const hasPhaseMemory = Boolean(phaseBest.bestPhase);
    if (slotNo <= 2 && hasPhaseMemory && !phaseBest.bestPhaseMatched) return false;


    if (slotNo === 1) {
      if (!(slotRole === 'extend' || slotRole === 'guard')) return false;
      if (totalRounds >= 20 && hit2Rate < 0.15) return false;
      if (totalRounds >= 20 && recent50HitRate < 0.15) return false;
      if (Math.max(recent50Roi, roi) < -0.80) return false;
    } else if (slotNo === 2) {
      if (!(slotRole === 'guard' || slotRole === 'extend')) return false;
      if (totalRounds >= 20 && hit2Rate < 0.13) return false;
      if (totalRounds >= 20 && recent50HitRate < 0.13) return false;
    } else if (slotNo === 3) {
      if (slotRole === 'attack') return false;
      if (totalRounds >= 20 && hit2Rate < 0.10) return false;
    } else if (slotNo === 4) {
      if (slotRole !== 'attack') return false;
      if (totalRounds >= 20) {
        if (Math.max(hit3, recent50Hit3Rate) < 0.005) return false;
        if (Math.max(recent50Roi, roi) < -0.80) return false;
      }
    }

    if ((slotRole === 'extend' || slotRole === 'guard') && totalRounds >= 20) {
      if (hit2Rate < 0.13) return false;
      if (recent50HitRate < 0.12) return false;
    }

    if (slotRole === 'attack' && totalRounds >= 20) {
      if (Math.max(hit3, recent50Hit3Rate) < 0.005) return false;
      if (Math.max(recent50Roi, roi) < -0.80) return false;
    }

    return true;
  };

  const pushVariantForSlot = (sourceGroup, slotNo, slotRole) => {
    if (!sourceGroup) return false;

    const strategyKey = getStrategyKey(sourceGroup);
    if (strategyKey && usedStrategyKeys.has(strategyKey)) return false;

    const variant = buildVariantFromSourceGroup(
      sourceGroup,
      slotRole,
      slotNo,
      pools,
      groups,
      selection,
      phaseContext
    );

    if (!variant || !variant.nums || variant.nums.length !== 4) return false;

    const nums = variant.nums;
    const overlapTooHigh = groups.some((g) => countOverlap(nums, g?.nums || []) > MAX_GROUP_OVERLAP);
    if (overlapTooHigh) return false;

    const candidateScore = variant.score;
    const tier = getCandidateTier(
      sourceGroup,
      candidateScore + getFormalStabilityBonus(sourceGroup, slotNo, phaseContext),
      slotRole,
      selection,
      phaseContext
    );

    groups.push({
      key: `${sourceGroup.key}_${slotRole}_${slotNo}`,
      label: buildFormalLabel(slotRole, slotNo, sourceGroup),
      nums,
      reason: `正式下注分工：${slotRole.toUpperCase()} / ${strategyModeLabel(selection.strategyMode)} / ${roleLabelOf(selection.riskMode)} / ${phaseContext.marketPhase} / ${phaseContext.lastHitLevel}`,
      meta: {
        ...buildFormalMeta(sourceGroup, slotRole, slotNo, sourcePrediction, selection, phaseContext),
        decision_score: round4(candidateScore + getFormalStabilityBonus(sourceGroup, slotNo, phaseContext)),
        decision_gate: getDecisionScoreFloor(slotRole, selection, phaseContext),
        roi_gate: getRecentRoiFloor(slotRole, selection, phaseContext),
        hit3_gate: getHit3RateFloor(slotRole, selection, phaseContext),
        blended_roi: getBlendedRoi(sourceGroup),
        blended_hit3_rate: getBlendedHit3Rate(sourceGroup),
        tier
      }
    });

    if (strategyKey) usedStrategyKeys.add(strategyKey);
    return true;
  };

  if (selection.riskMode === 'balanced') {
    for (let slotNo = 1; slotNo <= GROUP_COUNT; slotNo += 1) {
      let best = null;

      for (const rankedRow of ranked) {
        const sourceGroup = rankedRow.group;
        if (!sourceGroup) continue;

        const slotRole = getBalancedSlotRoleBySource(slotNo, sourceGroup);
        if (!canUseBalancedSlot(sourceGroup, slotNo, slotRole)) continue;

        const totalRounds = toNum(sourceGroup?.meta?.total_rounds, 0);
        const hit2Rate = toNum(sourceGroup?.meta?.hit2_rate, 0);
        const recent50HitRate = toNum(sourceGroup?.meta?.recent_50_hit_rate, 0);
        const hit3Rate = Math.max(
          toNum(sourceGroup?.meta?.hit3_rate, 0),
          toNum(sourceGroup?.meta?.recent_50_hit3_rate, 0)
        );
        const roi = Math.max(
          toNum(sourceGroup?.meta?.roi, 0),
          toNum(sourceGroup?.meta?.recent_50_roi, 0)
        );

        let slotScore = rankedRow.score + getFormalStabilityBonus(sourceGroup, slotNo, phaseContext) + totalRounds + (getPhaseBestSnapshot(sourceGroup, phaseContext).bestPhaseMatched ? 2400 : 0);
        if (slotNo === 1) {
          slotScore += hit2Rate * 5000 + recent50HitRate * 5000 + Math.max(roi, -1) * 120;
        } else if (slotNo === 2) {
          slotScore += hit2Rate * 4200 + recent50HitRate * 3600 + Math.max(roi, -1) * 80;
        } else if (slotNo === 3) {
          slotScore += hit2Rate * 2400 + recent50HitRate * 2200 + hit3Rate * 900;
        } else {
          slotScore += hit3Rate * 5200 + Math.max(roi, -1) * 140 + hit2Rate * 600;
        }

        if (!best || slotScore > best.slotScore) {
          best = {
            sourceGroup,
            slotRole,
            slotScore
          };
        }
      }

      if (best) {
        pushVariantForSlot(best.sourceGroup, slotNo, best.slotRole);
      }
    }
  } else {
    const roleOrdered = pickRoleOrderedGroups(ranked, selection, pools, phaseContext);

    const tryAddSlot = (sourceGroup, slotRole = 'mix') => {
      if (!sourceGroup) return false;
      if (isFormalHardRejectCandidate(sourceGroup, groups.length + 1)) return false;

      const strategyKey = getStrategyKey(sourceGroup);
      if (strategyKey && usedStrategyKeys.has(strategyKey)) return false;

      const nextSlotNo = groups.length + 1;
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
      if (groups.some((g) => countOverlap(variant.nums, g?.nums || []) > MAX_GROUP_OVERLAP)) return false;

      groups.push({
        key: `${sourceGroup.key}_${slotRole}_${nextSlotNo}`,
        label: buildFormalLabel(slotRole, nextSlotNo, sourceGroup),
        nums: variant.nums,
        reason: `正式下注分工：${slotRole.toUpperCase()} / ${strategyModeLabel(selection.strategyMode)} / ${roleLabelOf(selection.riskMode)} / ${phaseContext.marketPhase} / ${phaseContext.lastHitLevel}`,
        meta: {
          ...buildFormalMeta(sourceGroup, slotRole, nextSlotNo, sourcePrediction, selection, phaseContext),
          decision_score: round4(variant.score + getFormalStabilityBonus(sourceGroup, nextSlotNo)),
          decision_gate: getDecisionScoreFloor(slotRole, selection, phaseContext),
          roi_gate: getRecentRoiFloor(slotRole, selection, phaseContext),
          hit3_gate: getHit3RateFloor(slotRole, selection, phaseContext),
          blended_roi: getBlendedRoi(sourceGroup),
          blended_hit3_rate: getBlendedHit3Rate(sourceGroup),
          tier: getCandidateTier(sourceGroup, variant.score, slotRole, selection, phaseContext)
        }
      });

      if (strategyKey) usedStrategyKeys.add(strategyKey);
      return true;
    };

    for (let i = 0; i < roleOrdered.length && groups.length < GROUP_COUNT; i += 1) {
      const slot = roleOrdered[i];
      if (!slot?.group) continue;
      tryAddSlot(slot.group, slot.role || 'mix');
    }
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

  const controlledSelection = applyMarketControl(
    {
      ...selection,
      analysisPeriod: deriveBackendAnalysisPeriod(sourcePrediction, marketSnapshot, selection.analysisPeriod)
    },
    phaseContext
  );

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

  const predictionKeys = predictionSourceGroups.map((group) => getStrategyKey(group));
  const strategyPoolKeys = strategyPoolRows
    .map((row) => String(row?.strategy_key || '').trim())
    .filter(Boolean);

  const strategyStatsRows = await getStrategyStatsRowsByKeys([
    ...predictionKeys,
    ...strategyPoolKeys
  ]);

  const strategyPoolGroups = buildStrategyPoolGroups(
    strategyPoolRows,
    strategyStatsRows,
    pools,
    controlledSelection,
    phaseContext,
    latestDraw
  );

  const rawSourceGroups = [
    ...predictionSourceGroups,
    ...strategyPoolGroups
  ];

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
    controlledSelection,
    pools,
    phaseContext
  );

  if (!groups.length) {
    throw new Error('formal groups 建立失敗');
  }

  const finalGroups = forceInjectPhaseIntoGroups(
    __forceInjectPhaseMeta(buildFinalGroupsV8(groups), phaseContext),
    phaseContext
  );

  const persistedGroups = (Array.isArray(finalGroups) ? finalGroups : []).map((g) => ({
    ...g,
    meta: {
      ...(g?.meta || {}),
      phase_best_phase: String(g?.meta?.phase_best_phase || phaseContext?.marketPhase || 'rotation').toLowerCase(),
      phase_current_phase: String(g?.meta?.phase_current_phase || phaseContext?.marketPhase || 'rotation').toLowerCase(),
      phase_best_matched: typeof g?.meta?.phase_best_matched === 'boolean'
        ? g.meta.phase_best_matched
        : String(g?.meta?.phase_best_phase || phaseContext?.marketPhase || 'rotation').toLowerCase() === String(phaseContext?.marketPhase || 'rotation').toLowerCase(),
      phase_best_score: pickMetric(g?.meta?.phase_best_score, 0),
      phase_current_score: pickMetric(g?.meta?.phase_current_score, 0),
      market_phase: String(g?.meta?.market_phase || phaseContext?.marketPhase || 'rotation').toLowerCase(),
      phase_marker: 'FORCED_PHASE_V3'
    }
  }));

  const insertPayload = {
    groups_json: persistedGroups,
    market_phase: String(phaseContext?.marketPhase || 'rotation').toLowerCase(),
    market_signal: phaseContext?.marketPhase || null,
    confidence_score: phaseContext?.confidenceScore != null ? toNum(phaseContext.confidenceScore, null) : null,
    weight_profile: phaseContext?.weightProfile ? JSON.stringify(phaseContext.weightProfile) : null,
    mode: FORMAL_MODE,
    status: 'created',
    source_draw_no: String(sourceDrawNo),
    target_periods: 1,
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

  // ===== 衍生3星預測（不影響主流程，失敗不拋錯）=====
  await insertThreeStarDerivative(supabase, persistedGroups, sourceDrawNo, latestDraw, phaseContext);

  return {
    ok: true,
    api_version: API_VERSION,
    mode: FORMAL_MODE,
    trigger_source: triggerSource,
    cost_per_group: COST_PER_GROUP,
    group_count: groups.length,
    formal_batch_limit: FORMAL_BATCH_LIMIT,
    requested_selection: controlledSelection,
    selection_control_mode: 'backend_only',
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
      groups: persistedGroups
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
    getSupabase();

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
    return res.status(200).json({
      ...result,
      selection_control_mode: 'backend_only'
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      api_version: API_VERSION,
      error: error instanceof Error ? error.message : String(error || 'unknown error')
    });
  }
}
// ===== V8 HARD FINAL CONTROL =====
function buildFinalGroupsV8(rawGroups = []) {
  const used = new Set();
  const result = [];

  // 第一輪：正常去重，跳過 decision=reject 的 group
  for (const g of rawGroups) {
    if (!g || !g.key) continue;
    if (String(g?.meta?.decision || '').trim().toLowerCase() === 'reject') continue;
    if (!used.has(g.key)) {
      used.add(g.key);
      result.push(g);
    }
  }

  // 第二輪：補足4組，仍然跳過 decision=reject 的 group
  for (const g of rawGroups) {
    if (result.length >= 4) break;
    if (!g || !g.key) continue;
    if (String(g?.meta?.decision || '').trim().toLowerCase() === 'reject') continue;
    if (!used.has(g.key)) {
      used.add(g.key);
      result.push(g);
    }
  }

  if (result.length < 4) {
    throw new Error('V8: not enough valid (non-reject) strategies');
  }

  return result.slice(0, 4).map((g, idx) => ({
    ...g,
    meta: {
      ...(g.meta || {}),
      slot_no: idx + 1,
      preferred_role: ['attack','attack','extend','guard'][idx],
      selection_rank: idx + 1
    }
  }));
}

// ===== E版 phase 強制寫入（正式接入決策與寫入）=====
function __forceInjectPhaseMeta(groups = [], phaseContext = {}) {
  const marketPhase = String(phaseContext?.marketPhase || 'rotation').toLowerCase();
  return (Array.isArray(groups) ? groups : []).map((g) => {
    const meta = g?.meta && typeof g.meta === 'object' ? g.meta : {};
    const bestJson = safeJsonParse(meta.phase_best_json, meta.phase_best_json) || {};
    const bestPhase = String(
      meta.phase_best_phase ||
      bestJson?.best_phase ||
      meta.market_phase ||
      marketPhase ||
      'rotation'
    ).toLowerCase();
    const phaseScores = bestJson?.phase_scores && typeof bestJson.phase_scores === 'object' ? bestJson.phase_scores : {};
    const currentPhaseScore = pickMetric(meta.phase_current_score, phaseScores?.[marketPhase]);
    const bestPhaseScore = pickMetric(meta.phase_best_score, bestJson?.best_score);

    return {
      ...g,
      meta: {
        ...meta,
        phase_best_json: bestJson,
        phase_best_phase: bestPhase || null,
        phase_best_score: bestPhaseScore,
        phase_current_phase: marketPhase || null,
        phase_current_score: currentPhaseScore,
        phase_best_matched: !!bestPhase && !!marketPhase ? bestPhase === marketPhase : false,
        market_phase: marketPhase || null,
        phase_marker: 'FORCED_PHASE_V3'
      }
    };
  });
}

// ⚠️ 如有 groups 寫入 DB 前的區塊，請確保有這行（已補安全版）
// groups = __forceInjectPhaseMeta(groups, phaseContext);




// ====== 🔥 FORCE PHASE INJECTION (E版最終修正) ======
function forceInjectPhaseIntoGroups(groups = [], phaseContext = null) {
  const currentPhase = String(phaseContext?.marketPhase || 'rotation').toLowerCase() || 'rotation';

  return (Array.isArray(groups) ? groups : []).map((g) => {
    const meta = g?.meta && typeof g.meta === 'object' ? g.meta : {};
    const bestJson = safeJsonParse(meta.phase_best_json, meta.phase_best_json) || {};
    const bestPhase = String(
      meta.phase_best_phase ||
      bestJson?.best_phase ||
      meta.market_phase ||
      currentPhase ||
      'rotation'
    ).toLowerCase() || 'rotation';
    const phaseScores = bestJson?.phase_scores && typeof bestJson.phase_scores === 'object' ? bestJson.phase_scores : {};

    return {
      ...g,
      meta: {
        ...meta,
        phase_best_json: bestJson,
        phase_best_phase: bestPhase || null,
        phase_current_phase: currentPhase || null,
        phase_best_matched: !!currentPhase && !!bestPhase ? currentPhase === bestPhase : false,
        phase_current_score: pickMetric(meta.phase_current_score, phaseScores?.[currentPhase]),
        phase_best_score: pickMetric(meta.phase_best_score, bestJson?.best_score),
        market_phase: currentPhase || null,
        phase_marker: 'FORCED_PHASE_V3'
      }
    };
  });
}

// ⚠️ 在正式寫入前，務必呼叫：
// finalGroups = forceInjectPhaseIntoGroups(finalGroups, phaseContext);


// ===== 3星衍生預測（Parallel 3-Star）=====
async function insertThreeStarDerivative(db, formalGroups, sourceDrawNo, latestDraw, phaseContext) {
  try {
    // ✅ 修正 Bug3：先檢查同一期是否已有三星，避免和 auto-train 雙重寫入
    const { data: existing3star } = await db
      .from(PREDICTIONS_TABLE)
      .select('id')
      .eq('mode', 'formal_3star')
      .eq('source_draw_no', sourceDrawNo)
      .limit(1)
      .maybeSingle();

    if (existing3star?.id) {
      console.log('[3star] 同期已有三星預測，跳過衍生（避免雙重寫入）, draw:', sourceDrawNo);
      return null;
    }

    // ✅ 真三星：直接用 buildBingoV1Strategies starCount=3 獨立產生，不從四星截頭
    const marketRows = await db
      .from(DRAWS_TABLE)
      .select('draw_no, numbers, draw_time')
      .order('draw_no', { ascending: false })
      .limit(160);

    // ✅ 從 strategy_pool 取 active 策略，按 hit3_rate 排序取前8名
    const poolRows3s = await db.from(STRATEGY_POOL_TABLE).select('strategy_key').eq('status', 'active');
    const activeKeys3s = (poolRows3s?.data || []).map(r => r.strategy_key).filter(Boolean);
    const statsRows3s = await db.from(STRATEGY_STATS_TABLE)
      .select('strategy_key, recent_hits, hit3, hit2, total_rounds')
      .in('strategy_key', activeKeys3s.length > 0 ? activeKeys3s : ['hot_chase']);
    const statsMap3s = new Map();
    (statsRows3s?.data || []).forEach(row => {
      const rounds = Number(row.total_rounds || 0);
      const hit3Rate = rounds > 0 ? Number(row.hit3 || 0) / rounds : 0;
      const hit2Rate = rounds > 0 ? Number(row.hit2 || 0) / rounds : 0;
      statsMap3s.set(row.strategy_key, { score: hit3Rate * 60 + hit2Rate * 25, totalRounds: rounds });
    });
    const sorted3sKeys = activeKeys3s
      .map(key => ({ key, score: statsMap3s.get(key)?.score ?? -10, rounds: statsMap3s.get(key)?.totalRounds ?? 0 }))
      .sort((a, b) => { if (a.rounds === 0 && b.rounds > 0) return 1; if (b.rounds === 0 && a.rounds > 0) return -1; return b.score - a.score; })
      .slice(0, 8).map(x => x.key);
    const recent10Stats3s = {};
    sorted3sKeys.forEach(key => { const d = statsMap3s.get(key); recent10Stats3s[key] = d ? { score: d.score, hit3Rate: 0, avgCoverageHit: 3, totalRounds: d.totalRounds } : { score: -10, hit3Rate: 0, avgCoverageHit: 3, totalRounds: 0 }; });
    const result3star = buildBingoV1Strategies(marketRows.data || [], {}, 3, {}, recent10Stats3s, sorted3sKeys);

    const threeStarGroups = (result3star.strategies || []).map((s, idx) => ({
      key: s.key,
      label: s.label,
      nums: (Array.isArray(s.nums) ? s.nums : []).slice(0, 3),
      reason: '真三星直接選號',
      meta: {
        ...(s.meta || {}),
        star_mode: 3,
        derived_from: 'buildBingoV1Strategies_3star',
        slot_no: idx + 1
      }
    })).filter(g => g.nums.length === 3);

    if (!threeStarGroups.length) {
      console.warn('[3star] 無有效3星組，跳過');
      return null;
    }

    const payload = {
      groups_json: threeStarGroups,
      market_phase: String(phaseContext?.marketPhase || 'rotation').toLowerCase(),
      market_signal: phaseContext?.marketPhase || null,
      confidence_score: phaseContext?.confidenceScore != null
        ? toNum(phaseContext.confidenceScore, null) : null,
      weight_profile: phaseContext?.weightProfile
        ? JSON.stringify(phaseContext.weightProfile) : null,
      mode: 'formal_3star',
      status: 'created',
      source_draw_no: String(sourceDrawNo),
      target_periods: 1,
      latest_draw_numbers: JSON.stringify(parseNums(latestDraw?.numbers || [])),
      compare_result_json: null,
      compare_result: null,
      compare_status: 'pending',  // ✅ 修正：讓 comparePendingPredictions 能找到這筆
      hit_count: 0,
      compared_history_json: [],
      compared_draw_count: 0,
      verdict: null,
      compared_at: null
    };

    const { data, error } = await db
      .from(PREDICTIONS_TABLE)
      .insert(payload)
      .select('id')
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('[3star] 衍生寫入失敗:', error.message);
      return null;
    }
    console.log('[3star] 衍生成功, id:', data?.id);
    return data?.id || null;
  } catch (err) {
    console.warn('[3star] 衍生例外:', err.message);
    return null;
  }
}
