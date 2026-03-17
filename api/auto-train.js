import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';
import {
  parsePredictionGroups,
  buildComparePayload,
  parseDrawNumbers
} from '../lib/buildComparePayload.js';

const CURRENT_MODE = 'test';
const ACCEPT_MODES = ['test'];

/**
 * 即時學習 Lite：
 * 原本 = 2（等兩期）
 * 現在 = 1（每一期就學）
 */
const TARGET_PERIODS = 1;

const BET_GROUP_COUNT = 4;
const COST_PER_GROUP_PER_PERIOD = 25;

const MAX_COMPARE_PER_RUN = 3;
const MAX_CREATE_PER_RUN = 2;
const SOFT_TIMEOUT_MS = 8000;

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_POOL_TABLE = 'strategy_pool';
const STRATEGY_STATS_TABLE = 'strategy_stats';

const DRAW_NO_COL = 'draw_no';
const DRAW_TIME_COL = 'draw_time';
const DRAW_NUMBERS_COL = 'numbers';

const ACTIVE_TARGET_MIN = 24;
const ACTIVE_TARGET_MAX = 36;

/**
 * 微調 1：加速淘汰
 */
const RETIRE_MIN_ROUNDS = 24;
const RETIRE_ROI_THRESHOLD = -28;
const RETIRE_RECENT50_ROI_THRESHOLD = -18;
const RETIRE_AVG_HIT_THRESHOLD = 1.45;
const RETIRE_HIT34_RATE_THRESHOLD = 6;

const PROTECTED_TOP_N = 10;

/**
 * 微調 2：主力 / 探索比例
 */
const TRAINING_CORE_GROUP_COUNT = 3;
const TRAINING_EXPLORATION_GROUP_COUNT = 1;
const EXPLORATION_MIN_RECENT50_ROI = -5;
const EXPLORATION_MIN_SCORE = 140;

const GENE_POOL = [
  'hot',
  'chase',
  'balanced',
  'zone',
  'tail',
  'mix',
  'rebound',
  'warm',
  'repeat',
  'guard',
  'cold',
  'jump',
  'follow',
  'pattern',
  'structure',
  'split'
];

let cachedSupabase = null;

function getSupabase() {
  if (cachedSupabase) return cachedSupabase;

  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE key');
  }

  cachedSupabase = createClient(url, key, {
    auth: { persistSession: false }
  });

  return cachedSupabase;
}

function nowTs() {
  return Date.now();
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function uniqueAsc(nums) {
  return [...new Set(nums.map((n) => Number(n)).filter(Number.isFinite))].sort((a, b) => a - b);
}

function uniqueKeepOrder(nums) {
  const seen = new Set();
  const result = [];

  for (const n of nums.map((x) => Number(x)).filter(Number.isFinite)) {
    if (seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }

  return result;
}

function stableHash(text = '') {
  let h = 0;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function rotateList(source, offset = 0) {
  if (!Array.isArray(source) || source.length === 0) return [];
  const len = source.length;
  const safeOffset = ((offset % len) + len) % len;
  return [...source.slice(safeOffset), ...source.slice(0, safeOffset)];
}

function rowOrEmpty(row) {
  return row || {};
}

function calcHit34Rate(row) {
  const totalRounds = toNum(row.total_rounds, 0);
  if (totalRounds <= 0) return 0;

  const hit3 = toNum(row.hit3, 0);
  const hit4 = toNum(row.hit4, 0);
  return round2(((hit3 + hit4) / totalRounds) * 100);
}

function buildMarketSignalFromNumbers(numbers = []) {
  const nums = uniqueAsc(numbers);
  if (!nums.length) {
    return {
      sum: 0,
      span: 0,
      sum_tail: 0,
      odd_count: 0,
      even_count: 0,
      big_count: 0,
      small_count: 0,
      zone_1_count: 0,
      zone_2_count: 0,
      zone_3_count: 0,
      zone_4_count: 0
    };
  }

  const sum = nums.reduce((acc, n) => acc + n, 0);
  const span = nums[nums.length - 1] - nums[0];
  const sumTail = sum % 10;

  let oddCount = 0;
  let evenCount = 0;
  let bigCount = 0;
  let smallCount = 0;
  let zone1 = 0;
  let zone2 = 0;
  let zone3 = 0;
  let zone4 = 0;

  for (const n of nums) {
    if (n % 2 === 0) evenCount += 1;
    else oddCount += 1;

    if (n >= 41) bigCount += 1;
    else smallCount += 1;

    if (n >= 1 && n <= 20) zone1 += 1;
    else if (n <= 40) zone2 += 1;
    else if (n <= 60) zone3 += 1;
    else zone4 += 1;
  }

  return {
    sum,
    span,
    sum_tail: sumTail,
    odd_count: oddCount,
    even_count: evenCount,
    big_count: bigCount,
    small_count: smallCount,
    zone_1_count: zone1,
    zone_2_count: zone2,
    zone_3_count: zone3,
    zone_4_count: zone4
  };
}

function buildMarketSignalSummary(signal = {}) {
  const sum = toInt(signal.sum, 0);
  const span = toInt(signal.span, 0);
  const sumTail = toInt(signal.sum_tail, 0);

  const oddCount = toInt(signal.odd_count, 0);
  const evenCount = toInt(signal.even_count, 0);
  const bigCount = toInt(signal.big_count, 0);
  const smallCount = toInt(signal.small_count, 0);

  const zoneCounts = [
    toInt(signal.zone_1_count, 0),
    toInt(signal.zone_2_count, 0),
    toInt(signal.zone_3_count, 0),
    toInt(signal.zone_4_count, 0)
  ];

  const hotZoneIndex = zoneCounts.indexOf(Math.max(...zoneCounts)) + 1;

  return {
    sum,
    span,
    sum_tail: sumTail,
    odd_even_bias:
      oddCount > evenCount ? 'odd' : oddCount < evenCount ? 'even' : 'balanced',
    big_small_bias:
      bigCount > smallCount ? 'big' : bigCount < smallCount ? 'small' : 'balanced',
    hot_zone: hotZoneIndex,
    zone_counts: zoneCounts,
    compactness:
      span <= 55 ? 'tight' : span >= 72 ? 'wide' : 'normal',
    sum_band:
      sum <= 700 ? 'low' : sum >= 860 ? 'high' : 'mid'
  };
}

function buildMarketSignalFromDrawRow(drawRow = {}, drawNumbersCol = 'numbers') {
  const raw = drawRow?.[drawNumbersCol];
  const numbers = parseDrawNumbers(raw);
  const signal = buildMarketSignalFromNumbers(numbers);
  const summary = buildMarketSignalSummary(signal);

  return {
    ...signal,
    summary
  };
}

function buildRecentMarketSignalSnapshot(rows = [], drawNumbersCol = 'numbers') {
  const safeRows = Array.isArray(rows) ? rows : [];
  const latest = safeRows[0] || null;
  const prev = safeRows[1] || null;
  const third = safeRows[2] || null;

  const latestSignal = latest ? buildMarketSignalFromDrawRow(latest, drawNumbersCol) : null;
  const prevSignal = prev ? buildMarketSignalFromDrawRow(prev, drawNumbersCol) : null;
  const thirdSignal = third ? buildMarketSignalFromDrawRow(third, drawNumbersCol) : null;

  return {
    latest: latestSignal,
    prev: prevSignal,
    third: thirdSignal,
    trend: {
      sum_delta_1: latestSignal && prevSignal ? latestSignal.sum - prevSignal.sum : 0,
      span_delta_1: latestSignal && prevSignal ? latestSignal.span - prevSignal.span : 0,
      tail_changed:
        latestSignal && prevSignal ? latestSignal.sum_tail !== prevSignal.sum_tail : false
    }
  };
}

async function getLatestDrawNo() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select(DRAW_NO_COL)
    .order(DRAW_NO_COL, { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? toInt(data[DRAW_NO_COL]) : 0;
}

async function getRecent20() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select(`${DRAW_NO_COL}, ${DRAW_TIME_COL}, ${DRAW_NUMBERS_COL}`)
    .order(DRAW_NO_COL, { ascending: false })
    .limit(20);

  if (error) throw error;
  return data || [];
}

async function getMaturedPredictions(limitCount) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('status', 'created')
    .in('mode', ACCEPT_MODES)
    .order('created_at', { ascending: true })
    .limit(limitCount);

  if (error) throw error;
  return data || [];
}

async function getActiveCreatedTestPrediction() {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', CURRENT_MODE)
    .eq('status', 'created')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getDrawRowsForPrediction(prediction) {
  const supabase = getSupabase();

  const sourceDrawNo = toInt(prediction.source_draw_no);
  const targetPeriods = toInt(prediction.target_periods || TARGET_PERIODS);

  const start = sourceDrawNo + 1;
  const end = sourceDrawNo + targetPeriods;

  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select(`${DRAW_NO_COL}, ${DRAW_TIME_COL}, ${DRAW_NUMBERS_COL}`)
    .gte(DRAW_NO_COL, start)
    .lte(DRAW_NO_COL, end)
    .order(DRAW_NO_COL, { ascending: true });

  if (error) throw error;

  return (data || []).filter((row) => parseDrawNumbers(row[DRAW_NUMBERS_COL]).length > 0);
}

async function comparePrediction(prediction) {
  const supabase = getSupabase();
  const groups = parsePredictionGroups(prediction, BET_GROUP_COUNT);

  if (!groups.length) {
    return {
      ok: false,
      pending: false,
      predictionId: prediction.id,
      message: 'groups_json 解析失敗'
    };
  }

  const targetPeriods = toInt(prediction.target_periods || TARGET_PERIODS);
  const drawRows = await getDrawRowsForPrediction(prediction);

  if (drawRows.length < targetPeriods) {
    const startNo = toInt(prediction.source_draw_no) + 1;
    const endNo = toInt(prediction.source_draw_no) + targetPeriods;

    return {
      ok: false,
      pending: true,
      predictionId: prediction.id,
      message: `尚未收齊第 ${startNo} 期到第 ${endNo} 期開獎資料`
    };
  }

  const built = buildComparePayload({
    prediction,
    groups,
    drawRows,
    drawNoCol: DRAW_NO_COL,
    drawTimeCol: DRAW_TIME_COL,
    drawNumbersCol: DRAW_NUMBERS_COL,
    costPerGroupPerPeriod: COST_PER_GROUP_PER_PERIOD
  });

  const compareMarketSignals = drawRows.map((row) => ({
    draw_no: toInt(row?.[DRAW_NO_COL], 0),
    draw_time: row?.[DRAW_TIME_COL] || null,
    ...buildMarketSignalFromDrawRow(row, DRAW_NUMBERS_COL)
  }));

  const compareMarketSnapshot = buildRecentMarketSignalSnapshot(drawRows, DRAW_NUMBERS_COL);

  const existingHistory = Array.isArray(prediction.compare_history_json)
    ? prediction.compare_history_json
    : [];

  const nextHistory = [
    ...existingHistory,
    {
      compared_at: new Date().toISOString(),
      compare_draw_no: built.compareDrawNo,
      best_single_hit: built.bestSingleHit,
      total_hit_count: built.hitCount,
      market_signals: compareMarketSignals,
      market_snapshot: compareMarketSnapshot
    }
  ];

  const { error } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'compared',
      compare_status: 'done',
      compared_at: new Date().toISOString(),
      compared_draw_count: built.comparedDrawCount,
      compare_result: built.compareResult,
      compare_result_json: {
        ...built.compareResultJson,
        market_snapshot: compareMarketSnapshot,
        market_signals: compareMarketSignals
      },
      compare_history_json: nextHistory,
      verdict: built.verdict,
      hit_count: built.hitCount,
      best_single_hit: built.bestSingleHit,
      market_snapshot_json: compareMarketSnapshot
    })
    .eq('id', prediction.id);

  if (error) throw error;

  let strategyStatsResult = null;

  try {
    strategyStatsResult = await recordStrategyCompareResult({
      drawNo: built.compareDrawNo,
      compareResult: built.resultForApp,
      marketSnapshot: compareMarketSnapshot,
      marketSignal: prediction?.market_signal || prediction?.market_signal_json || null
    });
  } catch (err) {
    console.error('recordStrategyCompareResult error:', err?.message || err);
  }

  return {
    ok: true,
    predictionId: prediction.id,
    sourceDrawNo: prediction.source_draw_no,
    compareResult: built.compareResult,
    resultForApp: built.resultForApp,
    strategyStatsResult,
    hitCount: built.hitCount,
    bestSingleHit: built.bestSingleHit,
    compareDrawNo: built.compareDrawNo,
    marketSnapshot: compareMarketSnapshot
  };
}

function buildRecent20Analysis(recent20) {
  const rows = Array.isArray(recent20) ? recent20 : [];
  const allNums = rows.flatMap((row) => parseDrawNumbers(row[DRAW_NUMBERS_COL]));
  const latestRow = rows[0] || null;
  const prevRow = rows[1] || null;
  const thirdRow = rows[2] || null;

  const latestDraw = latestRow ? parseDrawNumbers(rowOrEmpty(latestRow)[DRAW_NUMBERS_COL]) : [];
  const prevDraw = prevRow ? parseDrawNumbers(rowOrEmpty(prevRow)[DRAW_NUMBERS_COL]) : [];
  const thirdDraw = thirdRow ? parseDrawNumbers(rowOrEmpty(thirdRow)[DRAW_NUMBERS_COL]) : [];

  const freq = new Map();
  const tailFreq = new Map();
  const zoneFreq = new Map();

  for (let n = 1; n <= 80; n += 1) {
    freq.set(n, 0);
  }

  for (const n of allNums) {
    freq.set(n, (freq.get(n) || 0) + 1);
    tailFreq.set(n % 10, (tailFreq.get(n % 10) || 0) + 1);

    const zone = n <= 20 ? 1 : n <= 40 ? 2 : n <= 60 ? 3 : 4;
    zoneFreq.set(zone, (zoneFreq.get(zone) || 0) + 1);
  }

  const hottest = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const coldest = [...freq.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  const warm = [...freq.entries()]
    .filter(([, count]) => count >= 1 && count <= 3)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const topTails = [...tailFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([t]) => t);

  const hotZones = [...zoneFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([zone]) => zone);

  const numbers1to80 = Array.from({ length: 80 }, (_, idx) => idx + 1);

  function topInRange(min, max, count, source = hottest) {
    return source.filter((n) => n >= min && n <= max).slice(0, count);
  }

  function pickByTail(tailNum, count, source = hottest) {
    return source.filter((n) => n % 10 === tailNum).slice(0, count);
  }

  function pickByZone(zone, count, source = hottest) {
    if (zone === 1) return source.filter((n) => n >= 1 && n <= 20).slice(0, count);
    if (zone === 2) return source.filter((n) => n >= 21 && n <= 40).slice(0, count);
    if (zone === 3) return source.filter((n) => n >= 41 && n <= 60).slice(0, count);
    return source.filter((n) => n >= 61 && n <= 80).slice(0, count);
  }

  return {
    rows,
    hottest,
    coldest,
    warm: warm.length ? warm : hottest,
    latestDraw,
    prevDraw,
    thirdDraw,
    topTails,
    hotZones,
    numbers1to80,
    topInRange,
    pickByTail,
    pickByZone
  };
}

function geneCandidates(gene, analysis, context = {}) {
  const {
    hottest,
    coldest,
    warm,
    latestDraw,
    prevDraw,
    thirdDraw,
    topTails,
    hotZones,
    topInRange,
    pickByTail,
    pickByZone
  } = analysis;

  const variant = toInt(context.variantIndex, 0);
  const key = String(context.strategyKey || '');
  const hash = stableHash(`${key}_${variant}_${gene}`);
  const latestSet = new Set(latestDraw);
  const prevSet = new Set(prevDraw);
  const thirdSet = new Set(thirdDraw);

  switch (String(gene || '').toLowerCase()) {
    case 'hot':
      return rotateList(hottest, hash % 17).slice(0, 24);

    case 'chase':
      return uniqueKeepOrder([
        ...latestDraw.filter((n) => hottest.includes(n)),
        ...rotateList(hottest, hash % 11).slice(0, 20)
      ]);

    case 'balanced':
    case 'balance':
      return uniqueKeepOrder([
        ...topInRange(1, 20, 3, rotateList(hottest, hash % 3)),
        ...topInRange(21, 40, 3, rotateList(hottest, hash % 5)),
        ...topInRange(41, 60, 3, rotateList(warm, hash % 7)),
        ...topInRange(61, 80, 3, rotateList(warm, hash % 9)),
        ...rotateList(warm, hash % 13).slice(0, 8)
      ]);

    case 'zone': {
      const zoneA = hotZones[hash % Math.max(1, hotZones.length)] || 1;
      const zoneB = hotZones[(hash + 1) % Math.max(1, hotZones.length)] || 2;
      return uniqueKeepOrder([
        ...pickByZone(zoneA, 8, rotateList(hottest, hash % 7)),
        ...pickByZone(zoneB, 8, rotateList(warm, hash % 5)),
        ...rotateList(coldest, hash % 9).slice(0, 6)
      ]);
    }

    case 'tail': {
      const tailA = topTails[hash % Math.max(1, topTails.length)] ?? 0;
      const tailB = topTails[(hash + 2) % Math.max(1, topTails.length)] ?? 1;
      return uniqueKeepOrder([
        ...pickByTail(tailA, 8, rotateList(hottest, hash % 7)),
        ...pickByTail(tailB, 8, rotateList(warm, hash % 5)),
        ...rotateList(coldest, hash % 11).slice(0, 6)
      ]);
    }

    case 'mix':
      return uniqueKeepOrder([
        ...rotateList(hottest, hash % 13).slice(0, 8),
        ...rotateList(warm, hash % 9).slice(0, 8),
        ...rotateList(coldest, hash % 7).slice(0, 8)
      ]);

    case 'rebound':
    case 'bounce':
      return uniqueKeepOrder([
        ...rotateList(coldest.filter((n) => !latestSet.has(n)), hash % 11).slice(0, 12),
        ...rotateList(warm.filter((n) => prevSet.has(n) || thirdSet.has(n)), hash % 7).slice(0, 12),
        ...rotateList(hottest, hash % 5).slice(0, 8)
      ]);

    case 'warm':
      return uniqueKeepOrder([
        ...rotateList(warm, hash % 13).slice(0, 18),
        ...rotateList(hottest, hash % 7).slice(0, 10)
      ]);

    case 'repeat':
      return uniqueKeepOrder([
        ...latestDraw,
        ...prevDraw.filter((n) => latestSet.has(n)),
        ...thirdDraw.filter((n) => latestSet.has(n) || prevSet.has(n)),
        ...rotateList(hottest, hash % 7).slice(0, 8)
      ]);

    case 'guard':
      return uniqueKeepOrder([
        ...rotateList(hottest.filter((n) => !latestSet.has(n)), hash % 9).slice(0, 14),
        ...rotateList(warm.filter((n) => !latestSet.has(n)), hash % 5).slice(0, 10),
        ...rotateList(coldest, hash % 7).slice(0, 6)
      ]);

    case 'cold':
      return uniqueKeepOrder([
        ...rotateList(coldest, hash % 13).slice(0, 18),
        ...rotateList(warm, hash % 5).slice(0, 8)
      ]);

    case 'jump': {
      const jumped = latestDraw.map((n) => {
        const next = n + 10;
        return next > 80 ? next - 80 : next;
      });
      return uniqueKeepOrder([
        ...rotateList(jumped, hash % 5),
        ...rotateList(hottest.filter((n) => !latestSet.has(n)), hash % 11).slice(0, 10),
        ...rotateList(warm, hash % 7).slice(0, 8)
      ]);
    }

    case 'follow': {
      const around = [];
      for (const n of latestDraw) {
        if (n - 1 >= 1) around.push(n - 1);
        if (n + 1 <= 80) around.push(n + 1);
        if (n - 2 >= 1) around.push(n - 2);
        if (n + 2 <= 80) around.push(n + 2);
      }
      return uniqueKeepOrder([
        ...rotateList(around, hash % 7),
        ...rotateList(prevDraw, hash % 5),
        ...rotateList(hottest, hash % 9).slice(0, 8)
      ]);
    }

    case 'pattern':
      return uniqueKeepOrder([
        ...rotateList(hottest.filter((n) => n % 2 === hash % 2), hash % 7).slice(0, 14),
        ...rotateList(hottest.filter((n) => n % 2 !== hash % 2), hash % 5).slice(0, 10),
        ...rotateList(warm, hash % 3).slice(0, 8)
      ]);

    case 'structure':
      return uniqueKeepOrder([
        ...rotateList(hottest, hash % 9).filter((_, i) => i % 2 === 0).slice(0, 10),
        ...rotateList(warm, hash % 7).filter((_, i) => i % 3 === 0).slice(0, 10),
        ...latestDraw,
        ...prevDraw
      ]);

    case 'split':
      return uniqueKeepOrder([
        ...topInRange(1, 20, 2, rotateList(hottest, hash % 3)),
        ...topInRange(21, 40, 2, rotateList(hottest, hash % 5)),
        ...topInRange(41, 60, 2, rotateList(hottest, hash % 7)),
        ...topInRange(61, 80, 2, rotateList(hottest, hash % 9)),
        ...rotateList(warm, hash % 11).slice(0, 8)
      ]);

    default:
      return rotateList(hottest, hash % 10).slice(0, 20);
  }
}

function mergeGeneLists(geneLists, strategyKey = '', variantIndex = 0) {
  const normalized = geneLists.filter((list) => Array.isArray(list) && list.length > 0);
  if (!normalized.length) return [];

  const seed = stableHash(`${strategyKey}_${variantIndex}`);
  const result = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const list = normalized[(i + seed) % normalized.length];
    const offset = (seed + i * 3) % Math.max(1, list.length);
    result.push(...rotateList(list, offset));
  }

  return uniqueKeepOrder(result);
}

function finalizeGroupNumbers(candidates, analysis, strategy, count = 4) {
  const merged = uniqueKeepOrder([
    ...candidates,
    ...analysis.hottest,
    ...analysis.warm,
    ...analysis.coldest,
    ...analysis.numbers1to80
  ]);

  const seed = stableHash(`${strategy.strategy_key}_${strategy.variantIndex || 0}`);
  const rotated = rotateList(merged, seed % Math.max(1, merged.length));

  const selected = [];
  const g1 = String(strategy.gene_a || '').toLowerCase();
  const g2 = String(strategy.gene_b || '').toLowerCase();

  const wantSpread = [g1, g2].some((g) => ['zone', 'balanced', 'balance', 'split'].includes(g));
  const wantTail = [g1, g2].includes('tail');
  const wantFollow = [g1, g2].some((g) => ['follow', 'repeat', 'chase'].includes(g));
  const wantCold = [g1, g2].some((g) => ['cold', 'bounce', 'rebound'].includes(g));

  for (const n of rotated) {
    if (selected.includes(n)) continue;

    if (wantSpread) {
      const zone = n <= 20 ? 1 : n <= 40 ? 2 : n <= 60 ? 3 : 4;
      const zoneCount = selected.filter((x) => {
        const z = x <= 20 ? 1 : x <= 40 ? 2 : x <= 60 ? 3 : 4;
        return z === zone;
      }).length;
      if (zoneCount >= 1 && selected.length < 3) continue;
    }

    if (wantTail) {
      const tail = n % 10;
      const sameTailCount = selected.filter((x) => x % 10 === tail).length;
      if (sameTailCount >= 2) continue;
    }

    if (wantFollow && selected.length < 2) {
      const tooFar = selected.length > 0 && selected.every((x) => Math.abs(x - n) > 18);
      if (tooFar) continue;
    }

    if (wantCold && selected.length < 2) {
      const tooHot = analysis.hottest.slice(0, 8).includes(n);
      if (tooHot) continue;
    }

    selected.push(n);
    if (selected.length >= count) break;
  }

  if (selected.length < count) {
    for (const n of rotated) {
      if (!selected.includes(n)) selected.push(n);
      if (selected.length >= count) break;
    }
  }

  return uniqueAsc(selected.slice(0, count));
}

function getGroupSignature(nums) {
  return uniqueAsc(nums).join('-');
}

function mutateGroupToUnique(baseNums, analysis, strategy, usedSignatures = new Set()) {
  const base = uniqueAsc(baseNums).slice(0, 4);
  const fallbackPool = uniqueKeepOrder([
    ...analysis.hottest,
    ...analysis.warm,
    ...analysis.coldest,
    ...analysis.numbers1to80
  ]);

  const seed = stableHash(`${strategy.strategy_key}_${strategy.variantIndex || 0}_mutate`);
  const rotatedPool = rotateList(fallbackPool, seed % Math.max(1, fallbackPool.length));

  const originalSignature = getGroupSignature(base);
  if (!usedSignatures.has(originalSignature)) {
    return base;
  }

  const variants = [];

  for (let i = 0; i < rotatedPool.length; i += 1) {
    const candidate = rotatedPool[i];
    if (base.includes(candidate)) continue;

    for (let replaceIdx = 0; replaceIdx < base.length; replaceIdx += 1) {
      const mutated = uniqueAsc([
        ...base.filter((_, idx) => idx !== replaceIdx),
        candidate
      ]).slice(0, 4);

      if (mutated.length === 4) {
        variants.push(mutated);
      }
    }

    if (variants.length >= 24) break;
  }

  for (const variant of variants) {
    const signature = getGroupSignature(variant);
    if (!usedSignatures.has(signature)) {
      return variant;
    }
  }

  return base;
}

function ensureUniqueGroups(groups, analysis) {
  const used = new Set();

  return groups.map((group, idx) => {
    const strategy = {
      strategy_key: group.key || `group_${idx + 1}`,
      variantIndex: idx
    };

    const originalNums = uniqueAsc(group.nums).slice(0, 4);
    const originalSignature = getGroupSignature(originalNums);

    let nums = originalNums;
    if (used.has(originalSignature)) {
      nums = mutateGroupToUnique(originalNums, analysis, strategy, used);
    }

    const finalSignature = getGroupSignature(nums);
    used.add(finalSignature);

    return {
      ...group,
      nums,
      reason:
        finalSignature !== originalSignature
          ? `${group.reason}（已自動避開重複組合）`
          : group.reason
    };
  });
}

function buildGroupReason(strategy, genes) {
  const strategyName = strategy.strategy_name || strategy.strategy_key;
  return `來自 strategy_pool active 策略 ${strategyName}，基因 ${genes.join(' + ')}`;
}

function buildGroupFromStrategy(strategy, recent20, variantIndex = 0, reasonPrefix = '') {
  const analysis = buildRecent20Analysis(recent20);
  const genes = uniqueKeepOrder([strategy.gene_a, strategy.gene_b].filter(Boolean));

  const context = {
    variantIndex,
    strategyKey: strategy.strategy_key
  };

  const candidateLists = genes.map((gene) => geneCandidates(gene, analysis, context));
  const mergedCandidates = mergeGeneLists(candidateLists, strategy.strategy_key, variantIndex);
  const nums = finalizeGroupNumbers(
    mergedCandidates,
    analysis,
    { ...strategy, variantIndex },
    4
  );

  return {
    key: strategy.strategy_key || `group_${variantIndex + 1}`,
    label: strategy.strategy_name || strategy.strategy_key || `第${variantIndex + 1}組`,
    nums,
    reason: reasonPrefix
      ? `${reasonPrefix}｜${buildGroupReason(strategy, genes)}`
      : buildGroupReason(strategy, genes),
    meta: {
      model: 'v5.4',
      source: strategy.source_type || 'strategy_pool',
      strategy_key: strategy.strategy_key || `group_${variantIndex + 1}`,
      strategy_name: strategy.strategy_name || strategy.strategy_key || `第${variantIndex + 1}組`,
      gene_a: strategy.gene_a || '',
      gene_b: strategy.gene_b || '',
      protected_rank: Boolean(strategy.protected_rank),
      total_rounds: toInt(strategy.total_rounds, 0),
      avg_hit: Number(strategy.avg_hit || 0),
      roi: Number(strategy.roi || 0),
      recent_50_roi: Number(strategy.recent_50_roi || 0),
      recent_50_hit_rate: Number(strategy.recent_50_hit_rate || 0),
      hit3: toInt(strategy.hit3, 0),
      hit4: toInt(strategy.hit4, 0),
      strategy_score: round2(strategy.strategy_score || scoreActiveStrategy(strategy))
    }
  };
}

function makeStrategyKey(geneA, geneB, suffix = '') {
  const base = `${geneA}_${geneB}`;
  return suffix ? `${base}_${suffix}` : base;
}

function scoreActiveStrategy(row) {
  const protectedBonus = row.protected_rank ? 12000 : 0;

  const avgHit = Number(row.avg_hit || 0);
  const roi = Number(row.roi || 0);
  const recent50Roi = Number(row.recent_50_roi || 0);
  const recent50HitRate = Number(row.recent_50_hit_rate || 0);

  const hit0 = Number(row.hit0 || 0);
  const hit1 = Number(row.hit1 || 0);
  const hit2 = Number(row.hit2 || 0);
  const hit3 = Number(row.hit3 || 0);
  const hit4 = Number(row.hit4 || 0);
  const totalRounds = Number(row.total_rounds || 0);

  const hit34Rate = calcHit34Rate(row);

  const explosionScore =
    hit2 * 2 +
    hit3 * 14 +
    hit4 * 42 +
    hit34Rate * 8;

  const recentScore =
    recent50Roi * 70 +
    recent50HitRate * 1.6 +
    avgHit * 95;

  const baseScore =
    roi * 6 +
    Math.min(totalRounds, 120) * 0.8;

  const matureBonus =
    totalRounds >= 60 ? 45 : totalRounds >= 30 ? 20 : totalRounds >= 15 ? 8 : 0;

  const penalty =
    hit0 * 1.2 +
    hit1 * 0.6;

  return protectedBonus + explosionScore + recentScore + baseScore + matureBonus - penalty;
}

async function getPoolWithStats() {
  const supabase = getSupabase();

  const { data: poolRows, error: poolError } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*');

  if (poolError) throw poolError;

  const strategyKeys = (poolRows || []).map((row) => row.strategy_key).filter(Boolean);
  const statsMap = new Map();

  if (strategyKeys.length) {
    const { data: statsRows, error: statsError } = await supabase
      .from(STRATEGY_STATS_TABLE)
      .select('*')
      .in('strategy_key', strategyKeys);

    if (statsError) throw statsError;

    for (const row of statsRows || []) {
      statsMap.set(row.strategy_key, row);
    }
  }

  return (poolRows || []).map((row) => ({
    ...row,
    ...(statsMap.get(row.strategy_key) || {})
  }));
}

function sortStrategiesByStrength(rows = []) {
  return [...rows]
    .map((row) => ({
      ...row,
      strategy_score: scoreActiveStrategy(row)
    }))
    .sort((a, b) => {
      if (Boolean(a.protected_rank) !== Boolean(b.protected_rank)) {
        return Boolean(b.protected_rank) - Boolean(a.protected_rank);
      }
      return Number(b.strategy_score || 0) - Number(a.strategy_score || 0);
    });
}

async function getActiveStrategiesFromPool(limitCount = BET_GROUP_COUNT) {
  const rows = await getPoolWithStats();

  const activeStrategies = rows.filter(
    (row) =>
      row.status === 'active' &&
      String(row.strategy_key || '').trim() &&
      row.gene_a &&
      row.gene_b
  );

  if (!activeStrategies.length) return [];

  return sortStrategiesByStrength(activeStrategies).slice(0, limitCount);
}

function buildFallbackSeedGroupsFromRecent20(recent20) {
  const fallbackStrategies = [
    {
      strategy_key: 'hot_balanced',
      strategy_name: 'Hot Balanced',
      gene_a: 'hot',
      gene_b: 'balanced',
      protected_rank: false,
      source_type: 'seed'
    },
    {
      strategy_key: 'balanced_zone',
      strategy_name: 'Balanced Zone',
      gene_a: 'balanced',
      gene_b: 'zone',
      protected_rank: false,
      source_type: 'seed'
    },
    {
      strategy_key: 'hot_chase',
      strategy_name: '熱門追擊型',
      gene_a: 'hot',
      gene_b: 'chase',
      protected_rank: false,
      source_type: 'seed'
    },
    {
      strategy_key: 'repeat_guard',
      strategy_name: '重號防守型',
      gene_a: 'repeat',
      gene_b: 'guard',
      protected_rank: false,
      source_type: 'seed'
    }
  ];

  const rawGroups = fallbackStrategies.map((strategy, idx) =>
    buildGroupFromStrategy(strategy, recent20, idx, 'fallback')
  );
  const analysis = buildRecent20Analysis(recent20);
  return ensureUniqueGroups(rawGroups, analysis);
}

async function buildStrategyGroupsFromPool(recent20) {
  const analysis = buildRecent20Analysis(recent20);
  const activeStrategies = await getActiveStrategiesFromPool(ACTIVE_TARGET_MAX);

  if (!activeStrategies.length) {
    return buildFallbackSeedGroupsFromRecent20(recent20);
  }

  const protectedStrategies = activeStrategies.filter((row) => Boolean(row.protected_rank));
  const nonProtectedStrategies = activeStrategies.filter((row) => !row.protected_rank);

  const selected = [];
  const usedKeys = new Set();

  for (const row of protectedStrategies.slice(0, TRAINING_CORE_GROUP_COUNT)) {
    if (usedKeys.has(row.strategy_key)) continue;
    usedKeys.add(row.strategy_key);
    selected.push({ ...row, _bucket: 'core' });
    if (selected.length >= TRAINING_CORE_GROUP_COUNT) break;
  }

  if (selected.length < TRAINING_CORE_GROUP_COUNT) {
    for (const row of nonProtectedStrategies) {
      if (usedKeys.has(row.strategy_key)) continue;
      usedKeys.add(row.strategy_key);
      selected.push({ ...row, _bucket: 'core' });
      if (selected.length >= TRAINING_CORE_GROUP_COUNT) break;
    }
  }

  const explorationCandidates = nonProtectedStrategies
    .filter(
      (row) =>
        !usedKeys.has(row.strategy_key) &&
        String(row.source_type || '') === 'exploration' &&
        toNum(row.recent_50_roi, -999) >= EXPLORATION_MIN_RECENT50_ROI &&
        toNum(row.strategy_score, scoreActiveStrategy(row)) >= EXPLORATION_MIN_SCORE
    )
    .sort((a, b) => Number(b.strategy_score || 0) - Number(a.strategy_score || 0));

  for (const row of explorationCandidates.slice(0, TRAINING_EXPLORATION_GROUP_COUNT)) {
    if (usedKeys.has(row.strategy_key)) continue;
    usedKeys.add(row.strategy_key);
    selected.push({ ...row, _bucket: 'exploration' });
    if (selected.length >= BET_GROUP_COUNT) break;
  }

  if (selected.length < BET_GROUP_COUNT) {
    for (const row of nonProtectedStrategies) {
      if (usedKeys.has(row.strategy_key)) continue;
      usedKeys.add(row.strategy_key);
      selected.push({ ...row, _bucket: 'support' });
      if (selected.length >= BET_GROUP_COUNT) break;
    }
  }

  if (selected.length < BET_GROUP_COUNT) {
    for (const row of protectedStrategies) {
      if (usedKeys.has(row.strategy_key)) continue;
      usedKeys.add(row.strategy_key);
      selected.push({ ...row, _bucket: 'support' });
      if (selected.length >= BET_GROUP_COUNT) break;
    }
  }

  let groups = selected
    .map((strategy, idx) => {
      const reasonPrefix =
        strategy._bucket === 'core'
          ? '主力策略'
          : strategy._bucket === 'exploration'
            ? '探索策略'
            : '補位策略';

      return buildGroupFromStrategy(strategy, recent20, idx, reasonPrefix);
    })
    .filter((group) => Array.isArray(group.nums) && group.nums.length === 4);

  groups = ensureUniqueGroups(groups, analysis);

  if (groups.length >= BET_GROUP_COUNT) {
    return groups.slice(0, BET_GROUP_COUNT);
  }

  const fallbackGroups = buildFallbackSeedGroupsFromRecent20(recent20);
  const map = new Map(groups.map((g) => [g.key, g]));

  for (const fallback of fallbackGroups) {
    if (!map.has(fallback.key) && map.size < BET_GROUP_COUNT) {
      map.set(fallback.key, fallback);
    }
  }

  groups = ensureUniqueGroups([...map.values()].slice(0, BET_GROUP_COUNT), analysis);
  return groups;
}

async function createNextTestPrediction() {
  const supabase = getSupabase();
  const latestDrawNo = await getLatestDrawNo();

  if (!latestDrawNo) {
    return { ok: false, skipped: false, message: 'bingo_draws 尚無資料' };
  }

  const existing = await getActiveCreatedTestPrediction();
  if (existing) {
    return {
      ok: false,
      skipped: true,
      message: '已有 AI 自動訓練局進行中'
    };
  }

  const recent20 = await getRecent20();
  if (!recent20.length) {
    return { ok: false, skipped: false, message: '無 recent20 可建立測試 prediction' };
  }

  const groups = await buildStrategyGroupsFromPool(recent20);

  const latestMarketSignal = recent20[0]
    ? buildMarketSignalFromDrawRow(recent20[0], DRAW_NUMBERS_COL)
    : null;

  const recentMarketSnapshot = buildRecentMarketSignalSnapshot(recent20, DRAW_NUMBERS_COL);

  const id = Date.now();

  const payload = {
    id,
    mode: CURRENT_MODE,
    status: 'created',
    source_draw_no: String(latestDrawNo),
    target_periods: TARGET_PERIODS,
    groups_json: groups,
    market_signal: latestMarketSignal,
    market_signal_json: latestMarketSignal,
    market_snapshot_json: recentMarketSnapshot,
    created_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert(payload)
    .select('*')
    .single();

  if (error) throw error;

  return {
    ok: true,
    created: data,
    groups,
    market_signal: latestMarketSignal,
    market_snapshot: recentMarketSnapshot,
    message: `已建立新 AI 即時訓練局，來源第 ${latestDrawNo} 期`
  };
}

async function buildLeaderboard(limitRows = 50) {
  const rows = await getPoolWithStats();

  const activeRows = rows.filter((row) => row.status === 'active');
  if (!activeRows.length) return [];

  return sortStrategiesByStrength(activeRows)
    .map((row) => {
      const totalRounds = toInt(row.total_rounds, 0);
      const totalHits = toInt(row.total_hits, 0);
      const avgHit = Number(row.avg_hit || 0);
      const totalCost = Number(row.total_cost || 0);
      const totalReward = Number(row.total_reward || 0);
      const totalProfit = Number(row.total_profit || 0);
      const roi = Number(row.roi || 0);
      const recent50Roi = Number(row.recent_50_roi || 0);
      const recent50HitRate = Number(row.recent_50_hit_rate || 0);
      const hit2 = toInt(row.hit2, 0);
      const hit3 = toInt(row.hit3, 0);
      const hit4 = toInt(row.hit4, 0);
      const hit1 = toInt(row.hit1, 0);
      const hit0 = toInt(row.hit0, 0);

      const score = round2(scoreActiveStrategy(row));

      return {
        key: row.strategy_key,
        label: row.strategy_name || row.strategy_key,
        status: row.status,
        source_type: row.source_type || 'seed',
        generation: toInt(row.generation, 1),
        protected_rank: Boolean(row.protected_rank),
        gene_a: row.gene_a || '',
        gene_b: row.gene_b || '',
        total_rounds: totalRounds,
        total_hits: totalHits,
        avg_hit: round2(avgHit),
        total_cost: round2(totalCost),
        total_reward: round2(totalReward),
        total_profit: round2(totalProfit),
        roi: round2(roi),
        recent_50_roi: round2(recent50Roi),
        recent_50_hit_rate: round2(recent50HitRate),
        hit0,
        hit1,
        hit2,
        hit3,
        hit4,
        hit34_rate: calcHit34Rate(row),
        score
      };
    })
    .slice(0, limitRows);
}

function shouldRetireStrategy(row) {
  if (row.protected_rank) return false;

  const totalRounds = toNum(row.total_rounds, 0);
  const roi = toNum(row.roi, 0);
  const recent50Roi = toNum(row.recent_50_roi, 0);
  const avgHit = toNum(row.avg_hit, 0);
  const hit34Rate = calcHit34Rate(row);

  return (
    totalRounds >= RETIRE_MIN_ROUNDS &&
    recent50Roi <= RETIRE_RECENT50_ROI_THRESHOLD &&
    roi <= RETIRE_ROI_THRESHOLD &&
    avgHit < RETIRE_AVG_HIT_THRESHOLD &&
    hit34Rate < RETIRE_HIT34_RATE_THRESHOLD
  );
}

function shouldKeepStrong(row) {
  if (row.protected_rank) return true;

  const totalRounds = toNum(row.total_rounds, 0);
  const roi = toNum(row.roi, 0);
  const recent50Roi = toNum(row.recent_50_roi, 0);
  const avgHit = toNum(row.avg_hit, 0);
  const hit34Rate = calcHit34Rate(row);

  return (
    (totalRounds >= 80 && roi >= 0) ||
    recent50Roi >= 8 ||
    avgHit >= 1.8 ||
    hit34Rate >= 12
  );
}

function buildCandidateStrategyRows(existingRows, desiredCount = 8) {
  const existingKeys = new Set(existingRows.map((row) => row.strategy_key).filter(Boolean));
  const inserted = [];

  for (let i = 0; i < GENE_POOL.length; i += 1) {
    for (let j = 0; j < GENE_POOL.length; j += 1) {
      if (i === j) continue;

      const geneA = GENE_POOL[i];
      const geneB = GENE_POOL[j];
      const key = makeStrategyKey(geneA, geneB);

      if (existingKeys.has(key)) continue;

      inserted.push({
        strategy_key: key,
        strategy_name: `${geneA}_${geneB}`,
        gene_a: geneA,
        gene_b: geneB,
        status: 'active',
        protected_rank: false,
        generation: 1,
        source_type: 'exploration',
        parameters: {},
        parent_keys: [],
        incubation_until_draw: 0,
        created_draw_no: 0
      });

      existingKeys.add(key);

      if (inserted.length >= desiredCount) {
        return inserted;
      }
    }
  }

  const strongRows = existingRows
    .filter((row) => row.status === 'active' && shouldKeepStrong(row))
    .sort((a, b) => scoreActiveStrategy(b) - scoreActiveStrategy(a));

  for (let i = 0; i < strongRows.length; i += 1) {
    for (let j = i + 1; j < strongRows.length; j += 1) {
      const a = strongRows[i];
      const b = strongRows[j];
      const geneA = a.gene_a || 'mix';
      const geneB = b.gene_b || 'balanced';
      const key = makeStrategyKey(geneA, geneB, `g${Date.now()}_${i}_${j}`);

      if (existingKeys.has(key)) continue;

      inserted.push({
        strategy_key: key,
        strategy_name: `${geneA}_${geneB}`,
        gene_a: geneA,
        gene_b: geneB,
        status: 'active',
        protected_rank: false,
        generation: Math.max(toInt(a.generation, 1), toInt(b.generation, 1)) + 1,
        source_type: 'crossover',
        parameters: {},
        parent_keys: [a.strategy_key, b.strategy_key],
        incubation_until_draw: 0,
        created_draw_no: 0
      });

      existingKeys.add(key);

      if (inserted.length >= desiredCount) {
        return inserted;
      }
    }
  }

  return inserted;
}

async function updateProtectedTopStrategies(rows) {
  const supabase = getSupabase();
  const activeRows = rows.filter((row) => row.status === 'active');
  const ranked = sortStrategiesByStrength(activeRows);

  const protectKeys = ranked.slice(0, PROTECTED_TOP_N).map((row) => row.strategy_key);
  const protectSet = new Set(protectKeys);

  const toProtect = activeRows
    .filter((row) => protectSet.has(row.strategy_key) && !row.protected_rank)
    .map((row) => row.strategy_key);

  const toUnprotect = activeRows
    .filter((row) => !protectSet.has(row.strategy_key) && row.protected_rank)
    .map((row) => row.strategy_key);

  if (toProtect.length) {
    const { error } = await supabase
      .from(STRATEGY_POOL_TABLE)
      .update({
        protected_rank: true,
        updated_at: new Date().toISOString()
      })
      .in('strategy_key', toProtect);

    if (error) throw error;
  }

  if (toUnprotect.length) {
    const { error } = await supabase
      .from(STRATEGY_POOL_TABLE)
      .update({
        protected_rank: false,
        updated_at: new Date().toISOString()
      })
      .in('strategy_key', toUnprotect);

    if (error) throw error;
  }

  return {
    protected_top_keys: protectKeys,
    protected_changed_count: toProtect.length + toUnprotect.length
  };
}

async function maybeRunStrategyEvolution() {
  const supabase = getSupabase();

  const poolWithStats = await getPoolWithStats();
  if (!poolWithStats.length) {
    return {
      ok: true,
      retired_count: 0,
      activated_count: 0,
      inserted_count: 0,
      protected_changed_count: 0,
      protected_top_keys: [],
      message: 'strategy_pool 尚無資料'
    };
  }

  const protectedUpdateBefore = await updateProtectedTopStrategies(poolWithStats);

  const rowsAfterProtect = await getPoolWithStats();
  const activeRows = rowsAfterProtect.filter((row) => row.status === 'active');
  const retireRows = activeRows.filter((row) => shouldRetireStrategy(row));

  let retiredCount = 0;
  if (retireRows.length) {
    const retireKeys = retireRows.map((row) => row.strategy_key);

    const { error: retireError } = await supabase
      .from(STRATEGY_POOL_TABLE)
      .update({
        status: 'retired',
        updated_at: new Date().toISOString()
      })
      .in('strategy_key', retireKeys);

    if (retireError) throw retireError;
    retiredCount = retireKeys.length;
  }

  const refreshedRows = await getPoolWithStats();
  let refreshedActive = refreshedRows.filter((row) => row.status === 'active');
  let activeCount = refreshedActive.length;

  const disabledCandidates = sortStrategiesByStrength(
    refreshedRows.filter((row) => row.status === 'disabled' && !shouldRetireStrategy(row))
  );

  let activatedCount = 0;

  if (activeCount < ACTIVE_TARGET_MIN && disabledCandidates.length) {
    const needCount = Math.min(ACTIVE_TARGET_MIN - activeCount, disabledCandidates.length);
    const activateKeys = disabledCandidates.slice(0, needCount).map((row) => row.strategy_key);

    const { error: activateError } = await supabase
      .from(STRATEGY_POOL_TABLE)
      .update({
        status: 'active',
        updated_at: new Date().toISOString()
      })
      .in('strategy_key', activateKeys);

    if (activateError) throw activateError;
    activatedCount = activateKeys.length;
  }

  const secondRefreshRows = await getPoolWithStats();
  refreshedActive = secondRefreshRows.filter((row) => row.status === 'active');
  activeCount = refreshedActive.length;

  let insertedCount = 0;

  if (activeCount < ACTIVE_TARGET_MIN) {
    const needInsert = ACTIVE_TARGET_MIN - activeCount;
    const candidateRows = buildCandidateStrategyRows(secondRefreshRows, needInsert);

    if (candidateRows.length) {
      await ensureStrategyPoolStrategies({
        strategyKeys: candidateRows.map((row) => row.strategy_key),
        sourceType: 'exploration',
        status: 'active'
      });

      insertedCount = candidateRows.length;
    }
  }

  const finalRowsBeforeTrim = await getPoolWithStats();
  const finalActiveBeforeTrim = finalRowsBeforeTrim.filter((row) => row.status === 'active');

  let disabled_overflow_count = 0;
  if (finalActiveBeforeTrim.length > ACTIVE_TARGET_MAX) {
    const rankedActive = sortStrategiesByStrength(finalActiveBeforeTrim);
    const keepKeys = new Set(rankedActive.slice(0, ACTIVE_TARGET_MAX).map((row) => row.strategy_key));
    const disableKeys = rankedActive
      .filter((row) => !keepKeys.has(row.strategy_key) && !row.protected_rank)
      .map((row) => row.strategy_key);

    if (disableKeys.length) {
      const { error: pauseError } = await supabase
        .from(STRATEGY_POOL_TABLE)
        .update({
          status: 'disabled',
          updated_at: new Date().toISOString()
        })
        .in('strategy_key', disableKeys);

      if (pauseError) throw pauseError;
      disabled_overflow_count = disableKeys.length;
    }
  }

  const finalRows = await getPoolWithStats();
  const protectedUpdateAfter = await updateProtectedTopStrategies(finalRows);
  const afterRows = await getPoolWithStats();

  return {
    ok: true,
    retired_count: retiredCount,
    activated_count: activatedCount,
    inserted_count: insertedCount,
    disabled_overflow_count,
    active_count: afterRows.filter((row) => row.status === 'active').length,
    retired_keys: retireRows.map((row) => row.strategy_key),
    protected_changed_count:
      protectedUpdateBefore.protected_changed_count +
      protectedUpdateAfter.protected_changed_count,
    protected_top_keys: protectedUpdateAfter.protected_top_keys,
    message: 'strategy convergence instant-lite done'
  };
}

export default async function handler(req, res) {
  const startedAt = nowTs();

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    await ensureStrategyPoolStrategies({
      strategyKeys: [
        'hot_balanced',
        'balanced_zone',
        'hot_chase',
        'repeat_guard',
        'mix_zone',
        'zone_mix',
        'tail_structure',
        'structure_balanced'
      ],
      sourceType: 'seed',
      status: 'active'
    });

    const latestDrawNo = await getLatestDrawNo();
    const maturedCandidates = await getMaturedPredictions(MAX_COMPARE_PER_RUN);

    let comparedCount = 0;
    let createdCount = 0;
    let comparedBestHit = 0;

    const comparedDetails = [];
    const pendingDetails = [];
    const createdDetails = [];

    for (const prediction of maturedCandidates) {
      if (nowTs() - startedAt > SOFT_TIMEOUT_MS) break;

      const result = await comparePrediction(prediction);

      if (result.ok) {
        comparedCount += 1;
        comparedBestHit = Math.max(comparedBestHit, result.bestSingleHit);

        comparedDetails.push({
          prediction_id: result.predictionId,
          source_draw_no: result.sourceDrawNo,
          total_cost: result.compareResult?.total_cost || 0,
          total_reward: result.compareResult?.total_reward || 0,
          profit: result.compareResult?.profit || 0,
          total_hit_count: result.compareResult?.total_hit_count || 0,
          best_single_hit: result.bestSingleHit,
          market_snapshot: result.marketSnapshot || null,
          strategy_stats_result: result.strategyStatsResult,
          strategies: Array.isArray(result.compareResult?.groups)
            ? result.compareResult.groups.map((g) => ({
                key: g.key,
                label: g.label,
                nums: g.nums,
                total_hit_count: g.total_hit_count,
                best_single_hit: g.best_single_hit,
                total_reward: g.total_reward,
                total_cost: g.total_cost,
                total_profit: g.total_profit,
                payout_rate: g.payout_rate,
                profit_win_rate: g.profit_win_rate,
                roi: g.roi,
                hit2_count: g.hit2_count,
                hit3_count: g.hit3_count,
                hit4_count: g.hit4_count
              }))
            : []
        });
      } else if (result.pending) {
        pendingDetails.push({
          prediction_id: result.predictionId,
          source_draw_no: prediction.source_draw_no,
          message: result.message
        });
      }
    }

    for (let i = 0; i < MAX_CREATE_PER_RUN; i += 1) {
      if (nowTs() - startedAt > SOFT_TIMEOUT_MS) break;

      const created = await createNextTestPrediction();

      if (created.ok) {
        createdCount += 1;
        createdDetails.push({
          prediction_id: created.created.id,
          source_draw_no: created.created.source_draw_no,
          target_periods: created.created.target_periods,
          total_cost: BET_GROUP_COUNT * TARGET_PERIODS * COST_PER_GROUP_PER_PERIOD,
          market_signal: created.market_signal || null,
          market_snapshot: created.market_snapshot || null,
          strategies: created.groups.map((g) => ({
            key: g.key,
            label: g.label,
            nums: g.nums,
            reason: g.reason,
            meta: g.meta
          }))
        });
      } else {
        if (!created.skipped) {
          createdDetails.push({
            skipped: true,
            message: created.message
          });
        }
        break;
      }
    }

    const evolutionResult = await maybeRunStrategyEvolution();
    const activeCreatedPrediction = await getActiveCreatedTestPrediction();
    const leaderboard = await buildLeaderboard(50);

    return res.status(200).json({
      ok: true,
      mode: CURRENT_MODE,
      latest_draw_no: latestDrawNo,
      target_periods: TARGET_PERIODS,
      bet_group_count: BET_GROUP_COUNT,
      cost_per_group_per_period: COST_PER_GROUP_PER_PERIOD,
      estimated_total_cost: BET_GROUP_COUNT * TARGET_PERIODS * COST_PER_GROUP_PER_PERIOD,
      compare_limit: MAX_COMPARE_PER_RUN,
      create_limit: MAX_CREATE_PER_RUN,
      compared_count: comparedCount,
      created_count: createdCount,
      best_single_hit: comparedBestHit,
      compared_details: comparedDetails,
      pending_details: pendingDetails,
      created_details: createdDetails,
      active_created_prediction: activeCreatedPrediction
        ? {
            prediction_id: activeCreatedPrediction.id,
            source_draw_no: activeCreatedPrediction.source_draw_no,
            target_periods: activeCreatedPrediction.target_periods,
            created_at: activeCreatedPrediction.created_at,
            mode: activeCreatedPrediction.mode,
            status: activeCreatedPrediction.status,
            market_signal: activeCreatedPrediction.market_signal || activeCreatedPrediction.market_signal_json || null,
            market_snapshot: activeCreatedPrediction.market_snapshot_json || null
          }
        : null,
      leaderboard,
      evolution_result: evolutionResult,
      message: `auto-train 即時學習完成：到期比對 ${comparedCount} 筆，新建訓練 ${createdCount} 筆`
    });
  } catch (error) {
    console.error('auto-train error:', error);

    return res.status(500).json({
      ok: false,
      error: error?.message || 'Unknown auto-train error'
    });
  }
}
