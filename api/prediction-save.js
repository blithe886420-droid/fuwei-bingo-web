import { createClient } from '@supabase/supabase-js';
import { buildRecentMarketSignalSnapshot } from '../lib/marketSignalEngine.js';

console.log('🔥 NEW VERSION LOADED v3.8 AGGRESSIVE RATE FIX');

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';
const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const FORMAL_MODE = 'formal';
const FORMAL_TARGET_PERIODS = 4;
const GROUP_COUNT = 4;
const RECENT_DRAW_LIMIT = 80;
const RECENT_FORMAL_USAGE_LIMIT = 24;

const PROFIT_MODE_NAME = 'profit_mode_v2_3_aggressive_rotation_ratefix';
const BASE_BET_AMOUNT = 25;

const DEFAULT_STRATEGY_KEYS = [
  'repeat_hot',
  'zone_repeat',
  '2_hot',
  'split_repeat',
  'tail_repeat',
  'repeat_mix',
  'gap_repeat',
  'cluster_spread',
  'hot_chase',
  'zone_balanced',
  'mix_2',
  'balance_mix',
  'pattern_structure',
  'cold_gap',
  'gap_hot',
  'cluster_chase_2',
  'zone_pattern',
  'gap_chase',
  'split_gap',
  'zone_2',
  'balanced_split',
  'structure_hot',
  'tail_repeat'
];

const AGGRESSIVE_CONFIG = {
  minRoundsTrust: 8,
  eliteScore: 2600,
  strongScore: 1400,
  usableScore: 450,
  rejectRoi: -0.75,
  rejectRecentRoi: -0.55,
  rejectAvgHit: 1.05,
  recentUsageHardCap: 0.58,
  recentUsageSoftCap: 0.34,
  staleBonusGap: 7,
  staleBonusScale: 0.18,
  nearTieRatio: 1.08,
  rotationTieRatio: 1.16
};

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeRate(value) {
  const raw = toNum(value, 0);

  if (raw <= 0) return 0;

  // 若資料像 64.47、60，視為百分比；若像 0.6447、0.6，視為比例
  const normalized = raw > 1 ? raw / 100 : raw;
  return clamp(normalized, 0, 1);
}

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))]
    .filter((n) => n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function uniqueKeepOrder(nums = []) {
  const seen = new Set();
  const result = [];

  for (const n of (Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite)) {
    if (seen.has(n)) continue;
    if (n < 1 || n > 80) continue;
    seen.add(n);
    result.push(n);
  }

  return result;
}

function stableHash(text = '') {
  let h = 0;
  const s = String(text || '');

  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }

  return h;
}

function rotateList(source = [], offset = 0) {
  if (!Array.isArray(source) || source.length === 0) return [];
  const len = source.length;
  const safeOffset = ((offset % len) + len) % len;
  return [...source.slice(safeOffset), ...source.slice(0, safeOffset)];
}

function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .replace(/[{}[\]]/g, ' ')
      .split(/[,\s|/]+/)
      .map(Number)
      .filter(Number.isFinite);
  }

  if (value && typeof value === 'object') {
    return parseDrawNumbers(
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

function getZone(n) {
  if (n >= 1 && n <= 20) return 1;
  if (n <= 40) return 2;
  if (n <= 60) return 3;
  return 4;
}

function normalizeStrategyKey(raw = '') {
  return String(raw || '').trim().toLowerCase();
}

function buildStrategyName(strategyKey = '') {
  return String(strategyKey || '')
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function inferGeneA(strategyKey = '') {
  const key = String(strategyKey || '').toLowerCase();
  if (key.includes('hot')) return 'hot';
  if (key.includes('cold')) return 'cold';
  if (key.includes('zone')) return 'zone';
  if (key.includes('guard')) return 'guard';
  if (key.includes('chase')) return 'chase';
  if (key.includes('mix')) return 'mix';
  if (key.includes('tail')) return 'tail';
  if (key.includes('pattern')) return 'pattern';
  if (key.includes('gap')) return 'gap';
  if (key.includes('cluster')) return 'pattern';
  if (key.includes('split')) return 'zone';
  if (key.includes('balance')) return 'balanced';
  if (key.includes('repeat')) return 'repeat';
  if (key.includes('structure')) return 'pattern';
  return 'hot';
}

function inferGeneB(strategyKey = '') {
  const key = String(strategyKey || '').toLowerCase();
  if (key.includes('zone')) return 'zone';
  if (key.includes('guard')) return 'guard';
  if (key.includes('chase')) return 'chase';
  if (key.includes('cold')) return 'cold';
  if (key.includes('mix')) return 'balanced';
  if (key.includes('tail')) return 'balanced';
  if (key.includes('repeat')) return 'repeat';
  if (key.includes('pattern')) return 'mix';
  if (key.includes('gap')) return 'gap';
  if (key.includes('cluster')) return 'repeat';
  if (key.includes('split')) return 'mix';
  if (key.includes('balance')) return 'zone';
  if (key.includes('structure')) return 'hot';
  return 'balanced';
}

function numbersByZone(zone, pool = []) {
  return pool.filter((n) => getZone(n) === zone);
}

function numbersByTail(tail, pool = []) {
  return pool.filter((n) => n % 10 === tail);
}

function buildRecentAnalysis(rows = []) {
  const parsedRows = (Array.isArray(rows) ? rows : []).map((row) => ({
    draw_no: Number(row?.draw_no || 0),
    draw_time: row?.draw_time || null,
    numbers: parseDrawNumbers(
      row?.numbers ??
      row?.draw_numbers ??
      row?.result_numbers ??
      row?.open_numbers
    )
  }));

  const latestDraw = parsedRows[0]?.numbers || [];
  const prevDraw = parsedRows[1]?.numbers || [];

  const freq = new Map();
  const zoneFreq = new Map();
  const tailFreq = new Map();
  const lastSeenIndex = new Map();

  for (let n = 1; n <= 80; n += 1) {
    freq.set(n, 0);
  }

  parsedRows.forEach((row, idx) => {
    for (const n of row.numbers) {
      freq.set(n, (freq.get(n) || 0) + 1);
      zoneFreq.set(getZone(n), (zoneFreq.get(getZone(n)) || 0) + 1);
      tailFreq.set(n % 10, (tailFreq.get(n % 10) || 0) + 1);

      if (!lastSeenIndex.has(n)) {
        lastSeenIndex.set(n, idx);
      }
    }
  });

  const hottest = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const coldest = [...freq.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  const hotZones = [...zoneFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([zone]) => zone);

  const hotTails = [...tailFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([tail]) => tail);

  const gapNums = Array.from({ length: 80 }, (_, i) => i + 1).sort((a, b) => {
    const ga = lastSeenIndex.has(a) ? lastSeenIndex.get(a) : 999;
    const gb = lastSeenIndex.has(b) ? lastSeenIndex.get(b) : 999;
    return gb - ga || a - b;
  });

  return {
    hottest,
    coldest,
    latestDraw,
    prevDraw,
    hotZones,
    hotTails,
    gapNums
  };
}

function geneCandidates(gene, analysis, context = {}) {
  const geneName = String(gene || '').toLowerCase();
  const hash = stableHash(
    `${context.strategyKey || ''}_${context.idx || 0}_${geneName}_${context.sourceDrawNo || 0}`
  );

  const hottest = analysis.hottest || [];
  const coldest = analysis.coldest || [];
  const latestDraw = analysis.latestDraw || [];
  const prevDraw = analysis.prevDraw || [];
  const gapNums = analysis.gapNums || [];
  const hotZones = analysis.hotZones || [];
  const hotTails = analysis.hotTails || [];
  const allNums = Array.from({ length: 80 }, (_, i) => i + 1);

  switch (geneName) {
    case 'hot':
      return rotateList(hottest, hash % 9).slice(0, 20);

    case 'cold':
      return rotateList(coldest, hash % 9).slice(0, 20);

    case 'zone': {
      const zoneA = hotZones[0] || 1;
      const zoneB = hotZones[1] || 2;
      return uniqueKeepOrder([
        ...rotateList(numbersByZone(zoneA, hottest), hash % 5).slice(0, 8),
        ...rotateList(numbersByZone(zoneB, hottest), hash % 7).slice(0, 8),
        ...rotateList(hottest, hash % 5).slice(0, 8)
      ]);
    }

    case 'tail': {
      const tailA = hotTails[0] ?? 0;
      const tailB = hotTails[1] ?? 5;
      return uniqueKeepOrder([
        ...rotateList(numbersByTail(tailA, allNums), hash % 4).slice(0, 8),
        ...rotateList(numbersByTail(tailB, allNums), hash % 5).slice(0, 8),
        ...rotateList(hottest, hash % 5).slice(0, 6)
      ]);
    }

    case 'guard':
      return uniqueKeepOrder([
        ...rotateList(hottest.filter((n) => !latestDraw.includes(n)), hash % 7).slice(0, 12),
        ...rotateList(coldest, hash % 5).slice(0, 8)
      ]);

    case 'chase':
      return uniqueKeepOrder([
        ...rotateList(gapNums, hash % 7).slice(0, 10),
        ...rotateList(hottest, hash % 5).slice(0, 8)
      ]);

    case 'repeat':
      return uniqueKeepOrder([
        ...rotateList(latestDraw, hash % 3).slice(0, 2),
        ...rotateList(prevDraw, hash % 4).slice(0, 2),
        ...rotateList(hottest, hash % 5).slice(0, 8)
      ]);

    case 'pattern':
      return uniqueKeepOrder([
        ...rotateList(hottest, hash % 5).slice(0, 6),
        ...rotateList(gapNums, hash % 7).slice(0, 6),
        ...rotateList(prevDraw, hash % 4).slice(0, 4)
      ]);

    case 'gap':
      return uniqueKeepOrder([
        ...rotateList(gapNums, hash % 7).slice(0, 12),
        ...rotateList(coldest, hash % 5).slice(0, 8)
      ]);

    case 'balanced':
    case 'mix':
    default:
      return uniqueKeepOrder([
        ...rotateList(latestDraw, hash % 3).slice(0, 1),
        ...rotateList(hottest, hash % 5).slice(0, 8),
        ...rotateList(coldest, hash % 7).slice(0, 8),
        ...rotateList(prevDraw, hash % 4).slice(0, 4)
      ]);
  }
}

function finalizeNums(candidates = [], strategyKey = '', analysis = {}, idx = 0, sourceDrawNo = 0) {
  const hash = stableHash(`${strategyKey}_${idx}_${sourceDrawNo}`);
  const rotated = rotateList(
    uniqueKeepOrder(candidates),
    hash % Math.max(candidates.length || 1, 1)
  );

  let nums = uniqueAsc(rotated.slice(0, 4));
  if (nums.length === 4) return nums;

  const fallback = uniqueKeepOrder([
    ...(analysis.hottest || []).slice(0, 16),
    ...(analysis.gapNums || []).slice(0, 16),
    ...(analysis.coldest || []).slice(0, 16),
    ...(analysis.latestDraw || []).slice(0, 8)
  ]);

  nums = uniqueAsc([...nums, ...fallback].slice(0, 12)).slice(0, 4);
  if (nums.length === 4) return nums;

  return uniqueAsc([...nums, 1, 20, 40, 60, 80]).slice(0, 4);
}

function normalizeStrategyRow(row = {}) {
  const rawHitRate = toNum(row?.hit_rate, 0);
  const rawRecent50HitRate = toNum(row?.recent_50_hit_rate, 0);

  return {
    strategy_key: normalizeStrategyKey(row?.strategy_key),
    strategy_name: String(row?.strategy_name || row?.strategy_label || row?.strategy_key || '').trim(),
    score: toNum(row?.score, 0),
    avg_hit: toNum(row?.avg_hit, 0),
    roi: toNum(row?.roi, 0),
    total_rounds: toNum(row?.total_rounds, 0),
    hit_rate: normalizeRate(rawHitRate),
    recent_50_hit_rate: normalizeRate(rawRecent50HitRate),
    recent_50_roi: toNum(row?.recent_50_roi, 0),
    strategy_weight: toNum(row?.weight, 0),
    raw_hit_rate: rawHitRate,
    raw_recent_50_hit_rate: rawRecent50HitRate
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

function detectMarketType(marketSnapshot = {}) {
  const summary = marketSnapshot?.latest?.summary;
  if (!summary) return 'UNKNOWN';

  if (summary.compactness === 'wide') return 'WIDE_SPREAD';
  if (summary.compactness === 'tight') return 'TIGHT_CLUSTER';
  if (summary.sum_band === 'high' && summary.big_small_bias === 'big') return 'HIGH_BIG';
  if (summary.sum_band === 'low' && summary.big_small_bias === 'small') return 'LOW_SMALL';
  if (summary.odd_even_bias === 'odd') return 'ODD_HEAVY';
  if (summary.odd_even_bias === 'even') return 'EVEN_HEAVY';
  return 'NORMAL';
}

function getStrategyMarketBoost(strategyKey = '', marketSnapshot = {}) {
  const key = normalizeStrategyKey(strategyKey);
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
    boost += 0.18;
    reasons.push('odd_bias_match');
  }

  if (latestSummary.odd_even_bias === 'even' && key.includes('even')) {
    boost += 0.18;
    reasons.push('even_bias_match');
  }

  if (latestSummary.big_small_bias === 'big' && (key.includes('hot') || key.includes('chase'))) {
    boost += 0.12;
    reasons.push('big_bias_hot');
  }

  if (latestSummary.big_small_bias === 'small' && (key.includes('cold') || key.includes('guard'))) {
    boost += 0.12;
    reasons.push('small_bias_cold');
  }

  if (latestSummary.compactness === 'tight' && (key.includes('pattern') || key.includes('cluster'))) {
    boost += 0.2;
    reasons.push('tight_pattern');
  }

  if (latestSummary.compactness === 'wide' && (key.includes('gap') || key.includes('chase') || key.includes('split'))) {
    boost += 0.2;
    reasons.push('wide_gap');
  }

  if ((latestSummary.hot_zone === 1 || latestSummary.hot_zone === 4) && key.includes('zone')) {
    boost += 0.1;
    reasons.push('zone_focus');
  }

  if (latestSummary.sum_band === 'high' && (key.includes('hot') || key.includes('mix'))) {
    boost += 0.1;
    reasons.push('high_sum_hot');
  }

  if (latestSummary.sum_band === 'low' && (key.includes('cold') || key.includes('gap'))) {
    boost += 0.1;
    reasons.push('low_sum_cold');
  }

  if (trend.tail_changed && key.includes('tail')) {
    boost += 0.09;
    reasons.push('tail_changed');
  }

  if (toNum(trend.span_delta_1, 0) >= 8 && key.includes('gap')) {
    boost += 0.09;
    reasons.push('span_expanding');
  }

  if (toNum(trend.span_delta_1, 0) <= -8 && (key.includes('pattern') || key.includes('cluster'))) {
    boost += 0.09;
    reasons.push('span_shrinking');
  }

  boost = clamp(boost, 0.72, 1.38);

  return {
    boost,
    reason: reasons.length ? reasons.join('|') : 'market_neutral'
  };
}

function safeSquarePositive(v) {
  const n = Math.max(0, toNum(v, 0));
  return n * n;
}

function buildUsagePenaltyInfo(strategyKey = '', usageInfo = {}) {
  const normalizedKey = normalizeStrategyKey(strategyKey);
  const total = Math.max(1, toNum(usageInfo?.total, 0));
  const recentCount = toNum(usageInfo?.counts?.[normalizedKey], 0);
  const recentRatio = recentCount / total;

  const staleIndex = toNum(usageInfo?.lastSeenIndex?.[normalizedKey], 99);
  const staleBonus =
    staleIndex >= AGGRESSIVE_CONFIG.staleBonusGap
      ? 1 + Math.min(0.75, (staleIndex - AGGRESSIVE_CONFIG.staleBonusGap) * AGGRESSIVE_CONFIG.staleBonusScale * 0.1)
      : 1;

  let penaltyMultiplier = 1;
  let reason = 'usage_neutral';

  if (recentRatio >= AGGRESSIVE_CONFIG.recentUsageHardCap) {
    penaltyMultiplier = 0.18;
    reason = 'usage_hard_cap';
  } else if (recentRatio >= AGGRESSIVE_CONFIG.recentUsageSoftCap) {
    penaltyMultiplier = 0.48;
    reason = 'usage_soft_cap';
  } else if (recentCount >= 3) {
    penaltyMultiplier = 0.72;
    reason = 'usage_repeat_penalty';
  }

  return {
    recentCount,
    recentRatio,
    staleIndex,
    staleBonus,
    penaltyMultiplier,
    reason
  };
}

function computeAggressiveDecision(row = {}) {
  const roi = toNum(row.adjusted_roi, row.roi);
  const recentRoi = toNum(row.recent_50_roi, 0);
  const avgHit = toNum(row.avg_hit, 0);

  // 這裡一定使用標準化後比例值
  const hitRate = normalizeRate(row.hit_rate);
  const recentHitRate = normalizeRate(row.recent_50_hit_rate);

  const totalRounds = toNum(row.total_rounds, 0);
  const score = toNum(row.adjusted_score, row.score);
  const marketBoost = toNum(row.market_boost, 1);
  const usagePenalty = toNum(row.usage_penalty_multiplier, 1);
  const staleBonus = toNum(row.stale_bonus_multiplier, 1);

  const posRoi = Math.max(0, roi);
  const posRecentRoi = Math.max(0, recentRoi);
  const posAvgHit = Math.max(0, avgHit - 1);
  const posHitRate = Math.max(0, hitRate);
  const posRecentHitRate = Math.max(0, recentHitRate);

  let decisionScore = 0;

  decisionScore += safeSquarePositive(posRoi + 0.25) * 1700;
  decisionScore += safeSquarePositive(posRecentRoi + 0.35) * 2400;
  decisionScore += safeSquarePositive(posAvgHit) * 2800;

  // 修正後：hit_rate / recent_50_hit_rate 已落在 0~1，不會再被 64.47 當成 64
  decisionScore += safeSquarePositive(posHitRate) * 1000;
  decisionScore += safeSquarePositive(posRecentHitRate) * 1350;

  if (score >= 0) {
    decisionScore += score * 3.2;
  } else {
    decisionScore += score * 5.8;
  }

  if (totalRounds >= AGGRESSIVE_CONFIG.minRoundsTrust) {
    decisionScore += Math.min(totalRounds, 140) * 8;
  } else {
    decisionScore -= (AGGRESSIVE_CONFIG.minRoundsTrust - totalRounds) * 130;
  }

  decisionScore *= marketBoost;
  decisionScore *= usagePenalty;
  decisionScore *= staleBonus;

  if (roi <= AGGRESSIVE_CONFIG.rejectRoi) {
    decisionScore -= 3200;
  } else if (roi < 0) {
    decisionScore -= Math.abs(roi) * 1900;
  }

  if (recentRoi <= AGGRESSIVE_CONFIG.rejectRecentRoi) {
    decisionScore -= 3000;
  } else if (recentRoi < 0) {
    decisionScore -= Math.abs(recentRoi) * 2300;
  }

  if (avgHit < AGGRESSIVE_CONFIG.rejectAvgHit) {
    decisionScore -= (AGGRESSIVE_CONFIG.rejectAvgHit - avgHit) * 1800;
  }

  if (totalRounds >= AGGRESSIVE_CONFIG.minRoundsTrust && roi < 0 && recentRoi < 0) {
    decisionScore *= 0.28;
  }

  if (totalRounds >= AGGRESSIVE_CONFIG.minRoundsTrust && avgHit < 1.12 && hitRate < 0.16) {
    decisionScore *= 0.38;
  }

  let decision = 'reject';

  if (decisionScore >= AGGRESSIVE_CONFIG.eliteScore) {
    decision = 'elite';
  } else if (decisionScore >= AGGRESSIVE_CONFIG.strongScore) {
    decision = 'strong';
  } else if (decisionScore >= AGGRESSIVE_CONFIG.usableScore) {
    decision = 'usable';
  } else if (totalRounds < AGGRESSIVE_CONFIG.minRoundsTrust && avgHit >= 1.18 && recentRoi >= 0) {
    decision = 'trial';
  }

  return {
    decision,
    decision_score: Math.round(decisionScore * 1000) / 1000
  };
}

function applyMarketDecisionToRows(rows = [], marketSnapshot = {}, recentFormalUsage = {}) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const base = normalizeStrategyRow(row);
    const marketFit = getStrategyMarketBoost(base.strategy_key, marketSnapshot);
    const usageInfo = buildUsagePenaltyInfo(base.strategy_key, recentFormalUsage);

    const adjustedScore = base.score * marketFit.boost;
    const adjustedRoi = base.roi * marketFit.boost;

    const aggressive = computeAggressiveDecision({
      ...base,
      adjusted_score: adjustedScore,
      adjusted_roi: adjustedRoi,
      market_boost: marketFit.boost,
      usage_penalty_multiplier: usageInfo.penaltyMultiplier,
      stale_bonus_multiplier: usageInfo.staleBonus
    });

    return {
      ...base,
      market_boost: marketFit.boost,
      market_reason: marketFit.reason,
      adjusted_score: adjustedScore,
      adjusted_roi: adjustedRoi,
      decision: aggressive.decision,
      decision_score: aggressive.decision_score,
      recent_formal_count: usageInfo.recentCount,
      recent_formal_ratio: usageInfo.recentRatio,
      usage_penalty_multiplier: usageInfo.penaltyMultiplier,
      usage_penalty_reason: usageInfo.reason,
      stale_bonus_multiplier: usageInfo.staleBonus,
      stale_index: usageInfo.staleIndex
    };
  });
}

function byDecisionDesc(a, b) {
  return (
    toNum(b.decision_score, 0) - toNum(a.decision_score, 0) ||
    toNum(b.adjusted_roi, 0) - toNum(a.adjusted_roi, 0) ||
    toNum(b.recent_50_roi, 0) - toNum(a.recent_50_roi, 0) ||
    toNum(b.avg_hit, 0) - toNum(a.avg_hit, 0) ||
    toNum(b.market_boost, 1) - toNum(a.market_boost, 1) ||
    toNum(a.recent_formal_ratio, 0) - toNum(b.recent_formal_ratio, 0) ||
    toNum(b.total_rounds, 0) - toNum(a.total_rounds, 0) ||
    String(a.strategy_key).localeCompare(String(b.strategy_key))
  );
}

function buildFormalCandidates(statsRows = [], marketSnapshot = {}, recentFormalUsage = {}) {
  const ranked = applyMarketDecisionToRows(
    (statsRows || []).map(normalizeStrategyRow).filter((row) => row.strategy_key),
    marketSnapshot,
    recentFormalUsage
  ).sort(byDecisionDesc);

  const elite = ranked.filter((row) => row.decision === 'elite');
  const strong = ranked.filter((row) => row.decision === 'strong');
  const usable = ranked.filter((row) => row.decision === 'usable');
  const trial = ranked.filter((row) => row.decision === 'trial');

  const selected = [];
  const used = new Set();

  function pushRows(rows, tag, limit = Infinity) {
    let pushed = 0;

    for (const row of rows) {
      if (selected.length >= GROUP_COUNT) break;
      if (pushed >= limit) break;
      if (used.has(row.strategy_key)) continue;

      used.add(row.strategy_key);
      selected.push({
        ...row,
        filter_pass: tag
      });
      pushed += 1;
    }
  }

  pushRows(elite, 'elite', 2);
  pushRows(strong, 'strong', 2);
  pushRows(usable, 'usable', 2);
  pushRows(trial, 'trial', 1);

  if (selected.length < GROUP_COUNT) {
    const fallback = ranked.filter((row) => row.decision !== 'reject');
    pushRows(fallback, 'fallback_non_reject', GROUP_COUNT - selected.length);
  }

  if (selected.length < GROUP_COUNT) {
    pushRows(ranked, 'forced_fallback', GROUP_COUNT - selected.length);
  }

  return selected.slice(0, GROUP_COUNT);
}

function calcStrategyStrength(row = {}) {
  const roi = toNum(row.adjusted_roi, row.roi);
  const recentRoi = toNum(row.recent_50_roi, 0);
  const avgHit = toNum(row.avg_hit, 0);
  const hitRate = normalizeRate(row.hit_rate);
  const recentHitRate = normalizeRate(row.recent_50_hit_rate);
  const totalRounds = toNum(row.total_rounds, 0);
  const decisionScore = toNum(row.decision_score, 0);
  const marketBoost = toNum(row.market_boost, 1);
  const usagePenalty = toNum(row.usage_penalty_multiplier, 1);
  const staleBonus = toNum(row.stale_bonus_multiplier, 1);

  let strength = 0;

  strength += Math.max(0, decisionScore);
  strength += safeSquarePositive(Math.max(0, roi) + 0.2) * 2000;
  strength += safeSquarePositive(Math.max(0, recentRoi) + 0.25) * 2600;
  strength += safeSquarePositive(Math.max(0, avgHit - 1)) * 2900;
  strength += safeSquarePositive(Math.max(0, hitRate)) * 1200;
  strength += safeSquarePositive(Math.max(0, recentHitRate)) * 1400;
  strength += Math.min(totalRounds, 100) * 9;
  strength += Math.max(0, marketBoost - 1) * 2800;

  strength *= usagePenalty;
  strength *= staleBonus;

  if (roi < 0) strength -= Math.abs(roi) * 2200;
  if (recentRoi < 0) strength -= Math.abs(recentRoi) * 2600;
  if (avgHit < 1) strength -= (1 - avgHit) * 1800;

  return Math.max(0, strength);
}

function buildBetWeightMeta(rows = []) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (!normalizedRows.length) return [];

  const strengths = normalizedRows.map((row) => calcStrategyStrength(row));
  const totalStrength = strengths.reduce((sum, n) => sum + n, 0);
  const maxStrength = Math.max(...strengths, 0);

  if (totalStrength <= 0) {
    return normalizedRows.map((row) => ({
      ...row,
      bet_weight: 2500,
      weight: 1,
      bet_amount: BASE_BET_AMOUNT,
      strength_score: 0,
      strength_share: 0.25
    }));
  }

  const rawBasisPoints = strengths.map((strength) => (strength / totalStrength) * 10000);
  const floorBasisPoints = rawBasisPoints.map((v) => Math.floor(v));
  let remain = 10000 - floorBasisPoints.reduce((sum, n) => sum + n, 0);

  const fractionalOrder = rawBasisPoints
    .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);

  for (let i = 0; i < fractionalOrder.length && remain > 0; i += 1, remain -= 1) {
    floorBasisPoints[fractionalOrder[i].idx] += 1;
  }

  return normalizedRows.map((row, idx) => {
    const strength = strengths[idx];
    const share = totalStrength > 0 ? strength / totalStrength : 0;
    const decisionScore = toNum(row.decision_score, 0);
    const roi = toNum(row.adjusted_roi, row.roi);
    const recentRoi = toNum(row.recent_50_roi, 0);

    let weight = 1;

    if (
      strength === maxStrength &&
      share >= 0.4 &&
      decisionScore >= AGGRESSIVE_CONFIG.eliteScore
    ) {
      weight = 3;
    } else if (
      share >= 0.2 &&
      decisionScore >= AGGRESSIVE_CONFIG.strongScore
    ) {
      weight = 2;
    }

    if (roi < 0 || recentRoi < 0) {
      weight = Math.min(weight, 1);
    }

    return {
      ...row,
      bet_weight: floorBasisPoints[idx],
      weight,
      bet_amount: BASE_BET_AMOUNT * weight,
      strength_score: Math.round(strength * 1000) / 1000,
      strength_share: Math.round(share * 1000000) / 1000000
    };
  });
}

function arrangeSelectedOrder(rows = [], sourceDrawNo = 0, marketSnapshot = {}) {
  const list = [...rows];
  if (list.length <= 1) return list;

  const marketType = detectMarketType(marketSnapshot);
  const summary = marketSnapshot?.latest?.summary || {};
  const hash = stableHash(
    `${sourceDrawNo}_${marketType}_${summary.odd_even_bias || ''}_${summary.compactness || ''}_${summary.hot_zone || ''}`
  );

  const first = toNum(list[0]?.decision_score, 0);
  const second = toNum(list[1]?.decision_score, 0);
  const third = toNum(list[2]?.decision_score, 0);

  if (second > 0 && first / second <= AGGRESSIVE_CONFIG.nearTieRatio) {
    if (hash % 2 === 1) {
      [list[0], list[1]] = [list[1], list[0]];
    }
  }

  if (third > 0 && first / third <= AGGRESSIVE_CONFIG.rotationTieRatio && list.length >= 3) {
    const offset = hash % 3;
    return rotateList(list.slice(0, 3), offset).concat(list.slice(3));
  }

  return list;
}

async function ensureDefaultStrategyPoolActive(strategyKeys = []) {
  const finalKeys = [...new Set((Array.isArray(strategyKeys) ? strategyKeys : [])
    .map(normalizeStrategyKey)
    .filter(Boolean))];

  if (!finalKeys.length) {
    return {
      ok: true,
      checked_count: 0,
      inserted_count: 0,
      updated_count: 0
    };
  }

  const { data: existingRows, error: existingError } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .in('strategy_key', finalKeys);

  if (existingError) throw existingError;

  const existingMap = new Map((existingRows || []).map((row) => [normalizeStrategyKey(row?.strategy_key), row]));
  const nowIso = new Date().toISOString();

  const rowsToInsert = [];
  const keysToForceActive = [];

  for (const strategyKey of finalKeys) {
    const existing = existingMap.get(strategyKey);

    if (!existing) {
      rowsToInsert.push({
        strategy_key: strategyKey,
        strategy_name: buildStrategyName(strategyKey),
        gene_a: inferGeneA(strategyKey),
        gene_b: inferGeneB(strategyKey),
        parameters: {},
        generation: 1,
        source_type: 'seed',
        parent_keys: [],
        status: 'active',
        protected_rank: false,
        incubation_until_draw: 0,
        created_draw_no: 0,
        created_at: nowIso,
        updated_at: nowIso
      });
      continue;
    }

    if (String(existing.status || '').toLowerCase() !== 'active') {
      keysToForceActive.push(strategyKey);
    }
  }

  if (rowsToInsert.length) {
    const { error: insertError } = await supabase
      .from(STRATEGY_POOL_TABLE)
      .insert(rowsToInsert);

    if (insertError) throw insertError;
  }

  for (const strategyKey of keysToForceActive) {
    const { error: updateError } = await supabase
      .from(STRATEGY_POOL_TABLE)
      .update({
        status: 'active',
        updated_at: nowIso
      })
      .eq('strategy_key', strategyKey);

    if (updateError) throw updateError;
  }

  return {
    ok: true,
    checked_count: finalKeys.length,
    inserted_count: rowsToInsert.length,
    updated_count: keysToForceActive.length
  };
}

async function getRecentFormalUsage(limit = RECENT_FORMAL_USAGE_LIMIT) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('groups_json, created_at')
    .eq('mode', FORMAL_MODE)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const counts = {};
  const lastSeenIndex = {};

  (Array.isArray(data) ? data : []).forEach((row, idx) => {
    const strategyKey = normalizeStrategyKey(
      row?.groups_json?.[0]?.key || row?.groups_json?.[0]?.meta?.strategy_key || ''
    );
    if (!strategyKey) return;

    counts[strategyKey] = toNum(counts[strategyKey], 0) + 1;

    if (lastSeenIndex[strategyKey] == null) {
      lastSeenIndex[strategyKey] = idx;
    }
  });

  return {
    total: Array.isArray(data) ? data.length : 0,
    counts,
    lastSeenIndex
  };
}

async function getLatestDraw() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.draw_no) throw new Error('latest draw not found');
  return data;
}

async function getRecentDraws(limit = RECENT_DRAW_LIMIT) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getActiveStrategyKeys() {
  const { data, error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('strategy_key')
    .eq('status', 'active');

  if (error) throw error;

  return new Set(
    (Array.isArray(data) ? data : [])
      .map((row) => normalizeStrategyKey(row?.strategy_key))
      .filter(Boolean)
  );
}

async function getTopStrategyStats(limit = 300) {
  await ensureDefaultStrategyPoolActive(DEFAULT_STRATEGY_KEYS);

  const activeKeys = await getActiveStrategyKeys();

  const { data, error } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const normalized = (Array.isArray(data) ? data : [])
    .map(normalizeStrategyRow)
    .filter((row) => row.strategy_key)
    .filter((row) => activeKeys.size === 0 || activeKeys.has(row.strategy_key));

  return normalized;
}

function buildGroupsFromStats(statsRows = [], recentRows = [], sourceDrawNo = 0, recentFormalUsage = {}) {
  const analysis = buildRecentAnalysis(recentRows);
  const marketSnapshot = normalizeMarketSnapshot(buildRecentMarketSignalSnapshot(recentRows, 'numbers'));

  const selectedStats = buildFormalCandidates(statsRows, marketSnapshot, recentFormalUsage);
  const orderedSelectedStats = arrangeSelectedOrder(selectedStats, sourceDrawNo, marketSnapshot);
  const selectedWithWeights = buildBetWeightMeta(orderedSelectedStats);

  const groups = selectedWithWeights.map((row, idx) => {
    const strategyKey = row.strategy_key;
    const strategyName = row.strategy_name || buildStrategyName(strategyKey);
    const geneA = inferGeneA(strategyKey);
    const geneB = inferGeneB(strategyKey);

    const candidates = uniqueKeepOrder([
      ...geneCandidates(geneA, analysis, { strategyKey, idx, sourceDrawNo }),
      ...geneCandidates(geneB, analysis, { strategyKey, idx, sourceDrawNo }),
      ...(analysis.hottest || []),
      ...(analysis.gapNums || []),
      ...(analysis.coldest || [])
    ]);

    const nums = finalizeNums(candidates, strategyKey, analysis, idx, sourceDrawNo);

    return {
      key: strategyKey,
      label: strategyName,
      nums,
      weight: row.weight,
      bet_amount: row.bet_amount,
      bet_weight: row.bet_weight,
      reason: `正式下注依激進輪動決策模式建立（倍率 x${row.weight} / 單組 ${row.bet_amount} 元 / 市場 ${row.market_reason || 'neutral'} / 使用率 ${toNum(row.recent_formal_ratio, 0).toFixed(3)}）`,
      meta: {
        strategy_key: strategyKey,
        strategy_name: strategyName,
        roi: row.roi,
        adjusted_roi: row.adjusted_roi,
        avg_hit: row.avg_hit,
        hit_rate: row.hit_rate,
        raw_hit_rate: row.raw_hit_rate,
        total_rounds: row.total_rounds,
        score: row.score,
        adjusted_score: row.adjusted_score,
        decision: row.decision,
        decision_score: row.decision_score,
        recent_50_roi: row.recent_50_roi,
        recent_50_hit_rate: row.recent_50_hit_rate,
        raw_recent_50_hit_rate: row.raw_recent_50_hit_rate,
        profit_mode: PROFIT_MODE_NAME,
        filter_pass: row.filter_pass,
        bet_weight: row.bet_weight,
        bet_amount: row.bet_amount,
        weight: row.bet_weight,
        weight_multiplier: row.weight,
        strength_score: row.strength_score,
        strength_share: row.strength_share,
        strategy_weight: row.strategy_weight,
        market_boost: row.market_boost,
        market_reason: row.market_reason,
        market_type: detectMarketType(marketSnapshot),
        market_summary: marketSnapshot?.latest?.summary || null,
        recent_formal_count: row.recent_formal_count,
        recent_formal_ratio: row.recent_formal_ratio,
        usage_penalty_multiplier: row.usage_penalty_multiplier,
        usage_penalty_reason: row.usage_penalty_reason,
        stale_bonus_multiplier: row.stale_bonus_multiplier,
        stale_index: row.stale_index,
        selection_rank: idx + 1
      }
    };
  });

  if (
    groups.length === GROUP_COUNT &&
    groups.every((g) => Array.isArray(g.nums) && g.nums.length === 4)
  ) {
    return {
      groups,
      marketSnapshot
    };
  }

  const pool = uniqueKeepOrder([
    ...(analysis.hottest || []).slice(0, 16),
    ...(analysis.gapNums || []).slice(0, 16),
    ...(analysis.coldest || []).slice(0, 16),
    ...(analysis.latestDraw || []).slice(0, 8)
  ]);

  const safePool = pool.length >= 16 ? pool : Array.from({ length: 20 }, (_, i) => i + 1);

  return {
    groups: Array.from({ length: GROUP_COUNT }, (_, idx) => ({
      key: `formal_fallback_${idx + 1}`,
      label: `Formal Fallback ${idx + 1}`,
      nums: uniqueAsc(rotateList(safePool, idx * 4).slice(0, 4)),
      weight: 1,
      bet_amount: BASE_BET_AMOUNT,
      bet_weight: 2500,
      reason: `正式下注 fallback（倍率 x1 / 單組 ${BASE_BET_AMOUNT} 元）`,
      meta: {
        strategy_key: `formal_fallback_${idx + 1}`,
        strategy_name: `Formal Fallback ${idx + 1}`,
        profit_mode: PROFIT_MODE_NAME,
        filter_pass: 'fallback',
        bet_weight: 2500,
        bet_amount: BASE_BET_AMOUNT,
        weight: 2500,
        weight_multiplier: 1,
        strength_score: 0,
        strength_share: 0.25,
        market_boost: 1,
        market_reason: 'fallback',
        market_type: detectMarketType(marketSnapshot),
        selection_rank: idx + 1
      }
    })),
    marketSnapshot
  };
}

async function saveFormalPrediction(payload) {
  const sourceDrawNo = Number(payload.source_draw_no);

  if (!Number.isFinite(sourceDrawNo) || sourceDrawNo <= 0) {
    throw new Error('Invalid source_draw_no');
  }

  const { data: existing, error: existingError } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', FORMAL_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;

  if (existing?.id) {
    const { data: updated, error: updateError } = await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        groups_json: payload.groups_json,
        market_snapshot_json: payload.market_snapshot_json,
        target_periods: Number(payload.target_periods),
        status: 'created',
        compare_status: null,
        hit_count: null,
        compared_at: null,
        created_at: payload.created_at
      })
      .eq('id', existing.id)
      .select('*')
      .maybeSingle();

    if (updateError) throw updateError;

    return {
      action: 'updated',
      row: updated || existing
    };
  }

  const insertPayload = {
    id: payload.id,
    mode: FORMAL_MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: Number(payload.target_periods),
    groups_json: payload.groups_json,
    market_snapshot_json: payload.market_snapshot_json,
    created_at: payload.created_at
  };

  const { data: inserted, error: insertError } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert(insertPayload)
    .select('*')
    .maybeSingle();

  if (insertError) throw insertError;

  return {
    action: 'inserted',
    row: inserted || null
  };
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const body = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {};
    const mode = String(body?.mode || FORMAL_MODE).toLowerCase();

    if (mode !== FORMAL_MODE) {
      return res.status(400).json({
        ok: false,
        error: 'Only formal mode is supported in prediction-save'
      });
    }

    const [latestDraw, recentRows, strategyStats, recentFormalUsage] = await Promise.all([
      getLatestDraw(),
      getRecentDraws(RECENT_DRAW_LIMIT),
      getTopStrategyStats(300),
      getRecentFormalUsage(RECENT_FORMAL_USAGE_LIMIT)
    ]);

    const sourceDrawNo = Number(latestDraw.draw_no || 0);
    if (!sourceDrawNo) {
      throw new Error('source draw not found');
    }

    const built = buildGroupsFromStats(strategyStats, recentRows, sourceDrawNo, recentFormalUsage);
    const groups = built.groups;
    const marketSnapshot =
      built.marketSnapshot ||
      normalizeMarketSnapshot(buildRecentMarketSignalSnapshot(recentRows, 'numbers'));

    const payload = {
      id: Date.now(),
      mode: FORMAL_MODE,
      status: 'created',
      source_draw_no: sourceDrawNo,
      target_periods: FORMAL_TARGET_PERIODS,
      groups_json: groups,
      market_snapshot_json: marketSnapshot,
      created_at: new Date().toISOString()
    };

    const saved = await saveFormalPrediction(payload);

    return res.status(200).json({
      ok: true,
      mode: FORMAL_MODE,
      profit_mode: PROFIT_MODE_NAME,
      source_draw_no: sourceDrawNo,
      target_periods: FORMAL_TARGET_PERIODS,
      latest_draw: latestDraw,
      market_snapshot: marketSnapshot,
      market_type: detectMarketType(marketSnapshot),
      recent_formal_usage: recentFormalUsage,
      base_bet_amount: BASE_BET_AMOUNT,
      total_bet_amount_per_period: groups.reduce((sum, group) => sum + toNum(group.bet_amount, 0), 0),
      total_bet_amount_all_periods:
        groups.reduce((sum, group) => sum + toNum(group.bet_amount, 0), 0) * FORMAL_TARGET_PERIODS,
      selected_strategy_keys: groups.map((g) => g.meta?.strategy_key || g.key),
      groups,
      saved
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'prediction-save failed'
    });
  }
}
