import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { maybeRunStrategyEvolution } from '../lib/strategyEvolutionEngine.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CURRENT_MODE = 'test';
const ACCEPT_MODES = ['test'];

const TARGET_PERIODS = 2;
const BET_GROUP_COUNT = 4;
const COST_PER_GROUP_PER_PERIOD = 25;

const MAX_COMPARE_PER_RUN = 1;
const MAX_CREATE_PER_RUN = 1;
const SOFT_TIMEOUT_MS = 8000;

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_POOL_TABLE = 'strategy_pool';
const STRATEGY_STATS_TABLE = 'strategy_stats';

const DRAW_NO_COL = 'draw_no';
const DRAW_TIME_COL = 'draw_time';
const DRAW_NUMBERS_COL = 'numbers';

function nowTs() {
  return Date.now();
}

function toInt(value, fallback = 0) {
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

function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function getHitNumbers(predicted, drawNumbers) {
  const drawSet = new Set(drawNumbers.map(Number));
  return predicted.map(Number).filter((n) => drawSet.has(n)).sort((a, b) => a - b);
}

function calcRewardByHitCount(hitCount) {
  if (hitCount >= 4) return 1000;
  if (hitCount === 3) return 100;
  if (hitCount === 2) return 25;
  return 0;
}

function parsePredictionGroups(prediction) {
  const raw = prediction?.groups_json ?? null;
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((group, idx) => {
        if (Array.isArray(group)) {
          return {
            key: `group_${idx + 1}`,
            label: `第${idx + 1}組`,
            nums: uniqueAsc(group).slice(0, 4),
            reason: '舊版資料',
            meta: { legacy: true }
          };
        }

        if (group && typeof group === 'object') {
          const nums = Array.isArray(group.nums) ? group.nums : [];
          return {
            key: group.key || `group_${idx + 1}`,
            label: group.label || `第${idx + 1}組`,
            nums: uniqueAsc(nums).slice(0, 4),
            reason: group.reason || '',
            meta: group.meta || {}
          };
        }

        return null;
      })
      .filter((g) => g && g.nums.length === 4)
      .slice(0, BET_GROUP_COUNT);
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsePredictionGroups({ groups_json: parsed });
    } catch {
      return [];
    }
  }

  return [];
}

async function getLatestDrawNo() {
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
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select(`${DRAW_NO_COL}, ${DRAW_TIME_COL}, ${DRAW_NUMBERS_COL}`)
    .order(DRAW_NO_COL, { ascending: false })
    .limit(20);

  if (error) throw error;
  return data || [];
}

async function getMaturedPredictions(limitCount) {
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
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id')
    .eq('mode', CURRENT_MODE)
    .eq('status', 'created')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getDrawRowsForPrediction(prediction) {
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

function buildComparePayload({ prediction, groups, drawRows }) {
  const sourceDrawNo = String(prediction.source_draw_no || '');
  const targetPeriods = toInt(prediction.target_periods || TARGET_PERIODS);

  const groupResults = [];
  const periodResults = [];

  let totalReward = 0;
  let totalHitCount = 0;
  let bestSingleHit = 0;

  for (const drawRow of drawRows) {
    const drawNo = toInt(drawRow[DRAW_NO_COL]);
    const drawTime = drawRow[DRAW_TIME_COL] || '';
    const drawNumbers = parseDrawNumbers(drawRow[DRAW_NUMBERS_COL]);

    let periodReward = 0;

    for (const group of groups) {
      const hitNumbers = getHitNumbers(group.nums, drawNumbers);
      const hitCount = hitNumbers.length;
      const reward = calcRewardByHitCount(hitCount);

      let targetGroup = groupResults.find((g) => g.key === group.key);
      if (!targetGroup) {
        targetGroup = {
          key: group.key,
          label: group.label,
          nums: group.nums,
          reason: group.reason || '',
          meta: group.meta || {},
          total_hit_count: 0,
          best_single_hit: 0,
          total_reward: 0,
          hit2_count: 0,
          hit3_count: 0,
          hit4_count: 0,
          payout_rounds: 0,
          profit_rounds: 0,
          total_cost: 0,
          total_profit: 0,
          periods: []
        };
        groupResults.push(targetGroup);
      }

      const cost = COST_PER_GROUP_PER_PERIOD;
      const profit = reward - cost;

      targetGroup.total_hit_count += hitCount;
      targetGroup.best_single_hit = Math.max(targetGroup.best_single_hit, hitCount);
      targetGroup.total_reward += reward;
      targetGroup.total_cost += cost;
      targetGroup.total_profit += profit;

      if (hitCount === 2) targetGroup.hit2_count += 1;
      if (hitCount === 3) targetGroup.hit3_count += 1;
      if (hitCount >= 4) targetGroup.hit4_count += 1;
      if (reward > 0) targetGroup.payout_rounds += 1;
      if (profit > 0) targetGroup.profit_rounds += 1;

      targetGroup.periods.push({
        draw_no: drawNo,
        draw_time: drawTime,
        hit_numbers: hitNumbers,
        hit_count: hitCount,
        reward,
        cost,
        profit
      });

      totalHitCount += hitCount;
      bestSingleHit = Math.max(bestSingleHit, hitCount);
      periodReward += reward;
      totalReward += reward;
    }

    periodResults.push({
      draw_no: drawNo,
      draw_time: drawTime,
      reward: periodReward
    });
  }

  for (const group of groupResults) {
    const totalRounds = group.periods.length || targetPeriods;
    group.avg_hit = round2(group.total_hit_count / totalRounds);
    group.avg_reward = round2(group.total_reward / totalRounds);
    group.avg_profit = round2(group.total_profit / totalRounds);
    group.payout_rate = round2((group.payout_rounds / totalRounds) * 100);
    group.profit_win_rate = round2((group.profit_rounds / totalRounds) * 100);
    group.roi = group.total_cost > 0
      ? round2((group.total_profit / group.total_cost) * 100)
      : 0;
  }

  const totalCost = groups.length * targetPeriods * COST_PER_GROUP_PER_PERIOD;
  const profit = totalReward - totalCost;
  const compareDrawRange =
    drawRows.length > 0
      ? `${drawRows[0][DRAW_NO_COL]} ~ ${drawRows[drawRows.length - 1][DRAW_NO_COL]}`
      : '';

  const maxTotalHit = Math.max(0, ...groupResults.map((g) => g.total_hit_count));
  const verdict = `${targetPeriods}期累計最佳 ${maxTotalHit} 碼 / 單期最佳中${bestSingleHit}`;
  const compareDrawNo = drawRows.length
    ? toInt(drawRows[drawRows.length - 1][DRAW_NO_COL])
    : null;

  const compareResult = {
    mode: '4star_4group_2period',
    source_draw_no: sourceDrawNo,
    total_cost: totalCost,
    total_reward: totalReward,
    profit,
    total_hit_count: totalHitCount,
    best_single_hit: bestSingleHit,
    compare_draw_range: compareDrawRange,
    groups: groupResults,
    period_results: periodResults,
    summary: {
      total_groups: groups.length,
      total_periods: drawRows.length,
      total_hit_count: totalHitCount,
      best_single_hit: bestSingleHit
    }
  };

  const resultForApp = {
    verdict,
    sourceDrawNo,
    targetDrawNo: toInt(sourceDrawNo) + targetPeriods,
    compareDrawNo,
    compareDrawRange,
    totalCost,
    estimatedReturn: totalReward,
    profit,
    compareRounds: drawRows.map((drawRow) => ({
      drawNo: toInt(drawRow[DRAW_NO_COL]),
      drawTime: drawRow[DRAW_TIME_COL] || '',
      drawNumbers: parseDrawNumbers(drawRow[DRAW_NUMBERS_COL])
    })),
    results: groupResults.map((g) => ({
      key: g.key,
      strategyKey: g.key,
      strategy: g.key,
      label: g.label,
      nums: g.nums,
      hitCount: g.total_hit_count,
      bestSingleHit: g.best_single_hit,
      totalReward: g.total_reward,
      totalCost: g.total_cost,
      totalProfit: g.total_profit,
      roi: g.roi,
      hit2Count: g.hit2_count,
      hit3Count: g.hit3_count,
      hit4Count: g.hit4_count,
      payoutRate: g.payout_rate,
      profitWinRate: g.profit_win_rate,
      periodHits: (g.periods || []).map((p) => ({
        drawNo: p.draw_no,
        drawTime: p.draw_time,
        hitNumbers: p.hit_numbers,
        hitCount: p.hit_count,
        reward: p.reward,
        cost: p.cost,
        profit: p.profit
      }))
    }))
  };

  return {
    compareResult,
    compareResultJson: compareResult,
    resultForApp,
    verdict,
    hitCount: totalHitCount,
    bestSingleHit,
    comparedDrawCount: drawRows.length,
    compareDrawNo
  };
}

async function comparePrediction(prediction) {
  const groups = parsePredictionGroups(prediction);

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

  const built = buildComparePayload({ prediction, groups, drawRows });

  const { error } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'compared',
      compare_status: 'done',
      compared_at: new Date().toISOString(),
      compared_draw_count: built.comparedDrawCount,
      compare_result: built.compareResult,
      compare_result_json: built.compareResultJson,
      compare_history_json: [],
      verdict: built.verdict,
      hit_count: built.hitCount,
      best_single_hit: built.bestSingleHit
    })
    .eq('id', prediction.id);

  if (error) throw error;

  let strategyStatsResult = null;

  try {
    strategyStatsResult = await recordStrategyCompareResult({
      drawNo: built.compareDrawNo,
      compareResult: built.resultForApp
    });
  } catch (err) {
    console.error('recordStrategyCompareResult error:', err.message);
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
    compareDrawNo: built.compareDrawNo
  };
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

function getGroupSignature(nums) {
  return uniqueAsc(nums).join('-');
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

  for (let a = 0; a < rotatedPool.length; a += 1) {
    for (let b = a + 1; b < rotatedPool.length; b += 1) {
      const nums = uniqueAsc([base[0], base[1], rotatedPool[a], rotatedPool[b]]).slice(0, 4);
      if (nums.length !== 4) continue;
      const signature = getGroupSignature(nums);
      if (!usedSignatures.has(signature)) {
        return nums;
      }
    }
    if (a > 12) break;
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

function buildGroupFromStrategy(strategy, recent20, variantIndex = 0) {
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
    reason: buildGroupReason(strategy, genes),
    meta: {
      model: 'v4.1',
      source: 'strategy_pool',
      strategy_key: strategy.strategy_key || `group_${variantIndex + 1}`,
      strategy_name: strategy.strategy_name || strategy.strategy_key || `第${variantIndex + 1}組`,
      gene_a: strategy.gene_a || '',
      gene_b: strategy.gene_b || '',
      protected_rank: Boolean(strategy.protected_rank),
      total_rounds: toInt(strategy.total_rounds, 0),
      avg_hit: Number(strategy.avg_hit || 0),
      roi: Number(strategy.roi || 0),
      recent_50_roi: Number(strategy.recent_50_roi || 0)
    }
  };
}

function scoreActiveStrategy(row) {
  const protectedBonus = row.protected_rank ? 9999 : 0;
  const avgHit = Number(row.avg_hit || 0);
  const roi = Number(row.roi || 0);
  const recent50Roi = Number(row.recent_50_roi || 0);
  const hit2 = Number(row.hit2 || 0);
  const hit3 = Number(row.hit3 || 0);
  const hit4 = Number(row.hit4 || 0);
  const totalRounds = Number(row.total_rounds || 0);

  const explosionScore = hit2 * 3 + hit3 * 8 + hit4 * 20;
  const stabilityScore = avgHit * 50 + recent50Roi * 35 + roi * 10;
  const matureBonus = totalRounds >= 30 ? 25 : totalRounds >= 15 ? 10 : 0;

  return protectedBonus + explosionScore + stabilityScore + matureBonus;
}

async function getActiveStrategiesFromPool(limitCount = BET_GROUP_COUNT) {
  const { data: activeRows, error: activeError } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active');

  if (activeError) throw activeError;

  const activeStrategies = (activeRows || []).filter(
    (row) => String(row.strategy_key || '').trim() && row.gene_a && row.gene_b
  );

  if (!activeStrategies.length) return [];

  const strategyKeys = activeStrategies.map((row) => row.strategy_key);

  const { data: statsRows, error: statsError } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .in('strategy_key', strategyKeys);

  if (statsError) throw statsError;

  const statsMap = new Map((statsRows || []).map((row) => [row.strategy_key, row]));

  return activeStrategies
    .map((row) => ({
      ...row,
      ...(statsMap.get(row.strategy_key) || {}),
      strategy_score: scoreActiveStrategy({
        ...row,
        ...(statsMap.get(row.strategy_key) || {})
      })
    }))
    .sort((a, b) => {
      if (Boolean(a.protected_rank) !== Boolean(b.protected_rank)) {
        return Boolean(b.protected_rank) - Boolean(a.protected_rank);
      }
      return Number(b.strategy_score || 0) - Number(a.strategy_score || 0);
    })
    .slice(0, limitCount);
}

function buildFallbackSeedGroupsFromRecent20(recent20) {
  const fallbackStrategies = [
    {
      strategy_key: 'hot_balanced',
      strategy_name: 'Hot Balanced',
      gene_a: 'hot',
      gene_b: 'balanced',
      protected_rank: false
    },
    {
      strategy_key: 'balanced_zone',
      strategy_name: 'Balanced Zone',
      gene_a: 'balanced',
      gene_b: 'zone',
      protected_rank: false
    },
    {
      strategy_key: 'hot_chase',
      strategy_name: '熱門追擊型',
      gene_a: 'hot',
      gene_b: 'chase',
      protected_rank: false
    },
    {
      strategy_key: 'repeat_guard',
      strategy_name: '重號防守型',
      gene_a: 'repeat',
      gene_b: 'guard',
      protected_rank: false
    }
  ];

  const rawGroups = fallbackStrategies.map((strategy, idx) => buildGroupFromStrategy(strategy, recent20, idx));
  const analysis = buildRecent20Analysis(recent20);
  return ensureUniqueGroups(rawGroups, analysis);
}

async function buildStrategyGroupsFromPool(recent20) {
  const activeStrategies = await getActiveStrategiesFromPool(BET_GROUP_COUNT);
  const analysis = buildRecent20Analysis(recent20);

  if (!activeStrategies.length) {
    return buildFallbackSeedGroupsFromRecent20(recent20);
  }

  let groups = activeStrategies
    .map((strategy, idx) => buildGroupFromStrategy(strategy, recent20, idx))
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
  const id = Date.now();

  const payload = {
    id,
    mode: CURRENT_MODE,
    status: 'created',
    source_draw_no: String(latestDrawNo),
    target_periods: TARGET_PERIODS,
    groups_json: groups,
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
    message: `已建立新 AI 自動訓練局，來源第 ${latestDrawNo} 期`
  };
}

async function buildLeaderboard(limitRows = 160) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, mode, compare_result, compared_at')
    .eq('status', 'compared')
    .not('compare_result', 'is', null)
    .order('compared_at', { ascending: false })
    .limit(limitRows);

  if (error) throw error;

  const map = new Map();

  for (const row of data || []) {
    const groups = Array.isArray(row?.compare_result?.groups) ? row.compare_result.groups : [];
    for (const group of groups) {
      const key = group?.key || 'unknown';
      const label = group?.label || key;

      if (!map.has(key)) {
        map.set(key, {
          key,
          label,
          rounds: 0,
          totalHit: 0,
          totalReward: 0,
          totalCost: 0,
          totalProfit: 0,
          payoutRounds: 0,
          profitRounds: 0,
          bestHit: 0,
          hit1: 0,
          hit2: 0,
          hit3: 0,
          hit4: 0
        });
      }

      const entry = map.get(key);
      const totalRounds = Array.isArray(group?.periods)
        ? group.periods.length
        : toInt(row?.compare_result?.summary?.total_periods, TARGET_PERIODS);
      const totalHit = toInt(group?.total_hit_count, 0);
      const totalReward = toInt(group?.total_reward, 0);
      const payoutRounds = toInt(group?.payout_rounds, 0);
      const profitRounds = toInt(group?.profit_rounds, 0);
      const totalCost = toInt(group?.total_cost, totalRounds * COST_PER_GROUP_PER_PERIOD);
      const totalProfit = toInt(group?.total_profit, totalReward - totalCost);

      entry.rounds += totalRounds;
      entry.totalHit += totalHit;
      entry.totalReward += totalReward;
      entry.totalCost += totalCost;
      entry.totalProfit += totalProfit;
      entry.payoutRounds += payoutRounds;
      entry.profitRounds += profitRounds;
      entry.bestHit = Math.max(entry.bestHit, toInt(group?.best_single_hit, 0));
      entry.hit2 += toInt(group?.hit2_count, 0);
      entry.hit3 += toInt(group?.hit3_count, 0);
      entry.hit4 += toInt(group?.hit4_count, 0);
      entry.hit1 += Math.max(
        0,
        totalRounds -
          toInt(group?.hit2_count, 0) -
          toInt(group?.hit3_count, 0) -
          toInt(group?.hit4_count, 0)
      );
    }
  }

  const leaderboard = [...map.values()]
    .map((item) => {
      const avgHit = item.rounds ? item.totalHit / item.rounds : 0;
      const avgReward = item.rounds ? item.totalReward / item.rounds : 0;
      const avgProfit = item.rounds ? item.totalProfit / item.rounds : 0;
      const payoutRate = item.rounds ? (item.payoutRounds / item.rounds) * 100 : 0;
      const profitWinRate = item.rounds ? (item.profitRounds / item.rounds) * 100 : 0;
      const roi = item.totalCost > 0 ? (item.totalProfit / item.totalCost) * 100 : 0;

      const explosionScore = item.hit2 * 3 + item.hit3 * 8 + item.hit4 * 20;
      const stabilityScore = avgHit * 50 + avgReward * 5;
      const score = round2(explosionScore + stabilityScore);

      return {
        key: item.key,
        label: item.label,
        total_rounds: item.rounds,
        avg_hit: round2(avgHit),
        avg_reward: round2(avgReward),
        avg_profit: round2(avgProfit),
        payout_rate: round2(payoutRate),
        profit_win_rate: round2(profitWinRate),
        roi: round2(roi),
        hit1: item.hit1,
        hit2: item.hit2,
        hit3: item.hit3,
        hit4: item.hit4,
        best_hit: item.bestHit,
        score
      };
    })
    .filter((item) => item.key !== 'unknown')
    .sort((a, b) => b.score - a.score);

  return leaderboard;
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
          strategy_stats_result: result.strategyStatsResult,
          strategies: Array.isArray(result.compareResult?.groups)
            ? result.compareResult.groups.map((g) => ({
                key: g.key,
                label: g.label,
                nums: g.nums,
                total_hit_count: g.total_hit_count,
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

    const leaderboard = await buildLeaderboard(160);

    let evolutionResult = null;

    try {
      evolutionResult = await maybeRunStrategyEvolution();
      console.log('strategy evolution result:', evolutionResult);
    } catch (err) {
      console.error('maybeRunStrategyEvolution error:', err.message);
    }

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
      leaderboard,
      evolution_result: evolutionResult,
      message: `auto-train 完成：到期比對 ${comparedCount} 筆，新建訓練 ${createdCount} 筆`
    });
  } catch (error) {
    console.error('auto-train error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Unknown auto-train error'
    });
  }
}
