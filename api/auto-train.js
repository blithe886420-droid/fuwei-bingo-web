import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import {
  buildComparePayload,
  parseDrawNumbers
} from '../lib/buildComparePayload.js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const CURRENT_MODE = 'test';
const PICK_COUNT = 4;
const DRAW_COMPARE_LIMIT = 2;
const RECENT_ANALYSIS_LIMIT = 20;

const STRATEGY_POOL_TABLE = 'strategy_pool';
const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE service role key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueAsc(nums) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function stableHash(text = '') {
  let h = 0;
  const s = String(text || '');
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

function uniqueKeepOrder(nums) {
  const seen = new Set();
  const result = [];

  for (const n of (Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite)) {
    if (seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }

  return result;
}

function inferGenes(strategyKey = '') {
  const tokens = String(strategyKey || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean);

  const geneA = tokens[0] || 'mix';
  const geneB = tokens[1] || 'balanced';

  return {
    gene_a: geneA,
    gene_b: geneB
  };
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
    sum_tail: sum % 10,
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

function buildRecentAnalysis(rows = []) {
  const drawRows = Array.isArray(rows) ? rows : [];
  const parsedRows = drawRows.map((row) => ({
    draw_no: toNum(row?.draw_no, 0),
    draw_time: row?.draw_time || null,
    numbers: parseDrawNumbers(row?.numbers)
  }));

  const latestDraw = parsedRows[0]?.numbers || [];
  const prevDraw = parsedRows[1]?.numbers || [];
  const thirdDraw = parsedRows[2]?.numbers || [];
  const allNums = parsedRows.flatMap((row) => row.numbers);

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
    .map(([tail]) => tail);

  const hotZones = [...zoneFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([zone]) => zone);

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
    rows: parsedRows,
    hottest,
    coldest,
    warm: warm.length ? warm : hottest,
    latestDraw,
    prevDraw,
    thirdDraw,
    topTails,
    hotZones,
    topInRange,
    pickByTail,
    pickByZone,
    numbers1to80: Array.from({ length: 80 }, (_, idx) => idx + 1)
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

  const variant = toNum(context.variantIndex, 0);
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

  for (const n of rotated) {
    if (selected.includes(n)) continue;
    selected.push(n);
    if (selected.length >= count) break;
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

  if (!usedSignatures.has(originalSignature)) return base;

  for (let i = 0; i < rotatedPool.length; i += 1) {
    const candidate = rotatedPool[i];
    if (base.includes(candidate)) continue;

    for (let replaceIdx = 0; replaceIdx < base.length; replaceIdx += 1) {
      const mutated = uniqueAsc([
        ...base.filter((_, idx) => idx !== replaceIdx),
        candidate
      ]).slice(0, 4);

      if (mutated.length !== 4) continue;

      const signature = getGroupSignature(mutated);
      if (!usedSignatures.has(signature)) return mutated;
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
      nums
    };
  });
}

function buildGroupsFromStrategies(strategies = [], recentRows = []) {
  const analysis = buildRecentAnalysis(recentRows);

  const groups = strategies.map((row, idx) => {
    const strategyKey = row.strategy_key || `strategy_${idx + 1}`;
    const genes = inferGenes(strategyKey);

    const context = {
      variantIndex: idx,
      strategyKey
    };

    const candidateLists = [
      geneCandidates(genes.gene_a, analysis, context),
      geneCandidates(genes.gene_b, analysis, context)
    ];

    const mergedCandidates = mergeGeneLists(candidateLists, strategyKey, idx);
    const nums = finalizeGroupNumbers(
      mergedCandidates,
      analysis,
      { strategy_key: strategyKey, variantIndex: idx },
      4
    );

    return {
      key: `group_${idx + 1}`,
      label: row.strategy_name || strategyKey,
      nums,
      reason: `strategy_pool active：${strategyKey}`,
      meta: {
        strategy_key: strategyKey,
        strategy_id: row.strategy_id || null,
        strategy_name: row.strategy_name || strategyKey,
        gene_a: genes.gene_a,
        gene_b: genes.gene_b,
        source_type: row.source_type || 'seed'
      }
    };
  });

  return ensureUniqueGroups(groups, analysis).filter(
    (group) => Array.isArray(group.nums) && group.nums.length === 4
  );
}

async function getRecentDrawRows(limitCount = RECENT_ANALYSIS_LIMIT) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getLatestDrawNo() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return toNum(data?.draw_no, 0);
}

async function getActiveStrategies() {
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

  const { data, error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function pickStrategies(rows, count = 4) {
  const source = Array.isArray(rows) ? [...rows] : [];
  const shuffled = source.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function buildCompareMarketSnapshot(compareRows = []) {
  const normalized = (Array.isArray(compareRows) ? compareRows : []).map((row) => {
    const numbers = parseDrawNumbers(row?.numbers);
    return {
      draw_no: toNum(row?.draw_no, 0),
      draw_time: row?.draw_time || null,
      numbers,
      signal: buildMarketSignalFromNumbers(numbers)
    };
  });

  const latest = normalized[0] || null;
  const prev = normalized[1] || null;

  return {
    latest: latest
      ? {
          draw_no: latest.draw_no,
          draw_time: latest.draw_time,
          numbers: latest.numbers,
          ...latest.signal
        }
      : null,
    prev: prev
      ? {
          draw_no: prev.draw_no,
          draw_time: prev.draw_time,
          numbers: prev.numbers,
          ...prev.signal
        }
      : null
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const activeStrategies = await getActiveStrategies();

    if (!activeStrategies.length) {
      return res.status(200).json({
        ok: true,
        mode: CURRENT_MODE,
        message: 'no active strategies'
      });
    }

    const pickedStrategies = pickStrategies(activeStrategies, PICK_COUNT);
    const recentRows = await getRecentDrawRows(RECENT_ANALYSIS_LIMIT);
    const latestDrawNo = await getLatestDrawNo();

    if (!recentRows.length) {
      return res.status(200).json({
        ok: true,
        mode: CURRENT_MODE,
        message: 'no draw rows'
      });
    }

    const groups = buildGroupsFromStrategies(pickedStrategies, recentRows);

    if (!groups.length) {
      return res.status(200).json({
        ok: true,
        mode: CURRENT_MODE,
        message: 'no valid groups built'
      });
    }

    const latestMarketSignal = buildMarketSignalFromNumbers(
      parseDrawNumbers(recentRows[0]?.numbers)
    );

    const insertPayload = {
      mode: CURRENT_MODE,
      status: 'created',
      source_draw_no: String(latestDrawNo),
      target_periods: DRAW_COMPARE_LIMIT,
      groups_json: groups,
      market_signal: latestMarketSignal,
      market_signal_json: latestMarketSignal,
      created_at: new Date().toISOString()
    };

    const { data: prediction, error: insertError } = await supabase
      .from(PREDICTIONS_TABLE)
      .insert(insertPayload)
      .select('*')
      .single();

    if (insertError) throw insertError;
    if (!prediction?.id) {
      throw new Error('Prediction created but no id returned');
    }

    const compareRows = recentRows.slice(0, DRAW_COMPARE_LIMIT);
    const marketSnapshot = buildCompareMarketSnapshot(compareRows);

    const payload = buildComparePayload({
      prediction,
      groups,
      drawRows: compareRows,
      drawNoCol: 'draw_no',
      drawTimeCol: 'draw_time',
      drawNumbersCol: 'numbers',
      costPerGroupPerPeriod: 25
    });

    const updatePayload = {
      compare_result: payload.compareResult ?? null,
      compare_result_json: payload.compareResultJson ?? payload.compareResult ?? null,
      compare_status: 'done',
      status: 'compared',
      verdict: payload.verdict || null,
      compared_at: new Date().toISOString(),
      compared_draw_count: payload.comparedDrawCount || 0,
      hit_count: payload.hitCount || 0,
      best_single_hit: payload.bestSingleHit || 0,
      market_snapshot_json: marketSnapshot,
      compare_history_json: [
        {
          compared_at: new Date().toISOString(),
          compare_draw_no: payload.compareDrawNo || 0,
          compared_draw_count: payload.comparedDrawCount || 0,
          verdict: payload.verdict || null,
          hit_count: payload.hitCount || 0,
          best_single_hit: payload.bestSingleHit || 0,
          market_snapshot: marketSnapshot
        }
      ]
    };

    const { error: updateError } = await supabase
      .from(PREDICTIONS_TABLE)
      .update(updatePayload)
      .eq('id', prediction.id);

    if (updateError) throw updateError;

    try {
  if (payload?.compareResult?.groups?.length) {
    console.log('🔥 writing strategy stats...', payload.compareResult.groups.length);

    await recordStrategyCompareResult(payload.compareResult);

    console.log('✅ strategy stats written');
  } else {
    console.log('⚠️ no groups to record');
  }
} catch (err) {
  console.error('❌ strategy stats failed:', err);
}

    return res.status(200).json({
      ok: true,
      mode: CURRENT_MODE,
      prediction_id: prediction.id,
      picked_count: groups.length,
      compare_draw_count: payload.comparedDrawCount || 0,
      hit_count: payload.hitCount || 0,
      best_single_hit: payload.bestSingleHit || 0,
      verdict: payload.verdict || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'auto-train failed'
    });
  }
}
