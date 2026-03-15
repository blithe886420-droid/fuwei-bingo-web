import { createClient } from '@supabase/supabase-js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 4;
const COST_PER_GROUP_PER_PERIOD = 25;
const DEFAULT_MODE = 'v4_manual_4group_4period';

const DRAWS_TABLE = 'bingo_draws';
const STRATEGY_POOL_TABLE = 'strategy_pool';
const STRATEGY_STATS_TABLE = 'strategy_stats';
const PREDICTIONS_TABLE = 'bingo_predictions';
const PREDICTION_STRATEGY_MAP_TABLE = 'prediction_strategy_map';

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function normalizeIncomingGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return [];

  return rawGroups
    .map((group, idx) => {
      if (Array.isArray(group)) {
        const nums = uniqueAsc(group).slice(0, 4);
        if (nums.length !== 4) return null;

        return {
          key: `group_${idx + 1}`,
          label: `第${idx + 1}組`,
          nums,
          reason: '前端傳入',
          meta: { source: 'frontend_array' }
        };
      }

      if (!group || typeof group !== 'object') return null;

      const numsSource = Array.isArray(group.nums)
        ? group.nums
        : Array.isArray(group.numbers)
          ? group.numbers
          : Array.isArray(group.pick)
            ? group.pick
            : [];

      const nums = uniqueAsc(numsSource).slice(0, 4);
      if (nums.length !== 4) return null;

      return {
        key: group.key || group.strategyKey || `group_${idx + 1}`,
        label: group.label || group.name || `第${idx + 1}組`,
        nums,
        reason: group.reason || '前端傳入',
        meta: group.meta || {
          source: 'frontend_object'
        }
      };
    })
    .filter(Boolean)
    .slice(0, BET_GROUP_COUNT);
}

function buildRecent20Analysis(recent20) {
  const rows = Array.isArray(recent20) ? recent20 : [];
  const allNums = rows.flatMap((row) => parseDrawNumbers(row.numbers));
  const latestRow = rows[0] || null;
  const prevRow = rows[1] || null;
  const thirdRow = rows[2] || null;

  const latestDraw = latestRow ? parseDrawNumbers(latestRow.numbers) : [];
  const prevDraw = prevRow ? parseDrawNumbers(prevRow.numbers) : [];
  const thirdDraw = thirdRow ? parseDrawNumbers(thirdRow.numbers) : [];

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
  const seed = String(context.generationSeed || '');
  const hash = stableHash(`${key}_${variant}_${gene}_${seed}`);
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

    default:
      return rotateList(hottest, hash % 10).slice(0, 20);
  }
}

function mergeGeneLists(geneLists, strategyKey = '', variantIndex = 0, generationSeed = '') {
  const normalized = geneLists.filter((list) => Array.isArray(list) && list.length > 0);
  if (!normalized.length) return [];

  const seed = stableHash(`${strategyKey}_${variantIndex}_${generationSeed}`);
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

  const seed = stableHash(
    `${strategy.strategy_key}_${strategy.variantIndex || 0}_${strategy.generationSeed || ''}`
  );
  const rotated = rotateList(merged, seed % Math.max(1, merged.length));

  const selected = [];
  for (const n of rotated) {
    if (selected.includes(n)) continue;
    selected.push(n);
    if (selected.length >= count) break;
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

  const seed = stableHash(
    `${strategy.strategy_key}_${strategy.variantIndex || 0}_mutate_${strategy.generationSeed || ''}`
  );
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

function ensureUniqueGroups(groups, analysis, generationSeed = '') {
  const used = new Set();

  return groups.map((group, idx) => {
    const strategy = {
      strategy_key: group.key || `group_${idx + 1}`,
      variantIndex: idx,
      generationSeed
    };

    let nums = uniqueAsc(group.nums).slice(0, 4);
    const originalSignature = getGroupSignature(nums);

    if (used.has(originalSignature)) {
      nums = mutateGroupToUnique(nums, analysis, strategy, used);
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

async function getRecent20(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(20);

  if (error) throw error;
  return data || [];
}

async function getLatestDrawNo(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? Number(data.draw_no) : 0;
}

async function getActiveStrategiesFromPool(supabase, limitCount = BET_GROUP_COUNT) {
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

function buildFallbackSeedGroupsFromRecent20(recent20, generationSeed) {
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

  const analysis = buildRecent20Analysis(recent20);

  const rawGroups = fallbackStrategies.map((strategy, idx) => {
    const genes = uniqueKeepOrder([strategy.gene_a, strategy.gene_b].filter(Boolean));
    const candidateLists = genes.map((gene) =>
      geneCandidates(gene, analysis, {
        variantIndex: idx,
        strategyKey: strategy.strategy_key,
        generationSeed
      })
    );
    const mergedCandidates = mergeGeneLists(
      candidateLists,
      strategy.strategy_key,
      idx,
      generationSeed
    );
    const nums = finalizeGroupNumbers(
      mergedCandidates,
      analysis,
      { ...strategy, variantIndex: idx, generationSeed },
      4
    );

    return {
      key: strategy.strategy_key,
      label: strategy.strategy_name,
      nums,
      reason: `fallback 生成 ${strategy.strategy_name}`,
      meta: {
        model: 'v4.4',
        source: 'fallback',
        strategy_key: strategy.strategy_key,
        strategy_name: strategy.strategy_name,
        gene_a: strategy.gene_a,
        gene_b: strategy.gene_b,
        generation_seed: generationSeed
      }
    };
  });

  return ensureUniqueGroups(rawGroups, analysis, generationSeed);
}

async function buildStrategyGroupsFromPool(supabase, recent20, generationSeed) {
  const analysis = buildRecent20Analysis(recent20);
  const activeStrategies = await getActiveStrategiesFromPool(supabase, BET_GROUP_COUNT);

  if (!activeStrategies.length) {
    return buildFallbackSeedGroupsFromRecent20(recent20, generationSeed);
  }

  const rawGroups = activeStrategies
    .map((strategy, idx) => {
      const genes = uniqueKeepOrder([strategy.gene_a, strategy.gene_b].filter(Boolean));
      const candidateLists = genes.map((gene) =>
        geneCandidates(gene, analysis, {
          variantIndex: idx,
          strategyKey: strategy.strategy_key,
          generationSeed
        })
      );
      const mergedCandidates = mergeGeneLists(
        candidateLists,
        strategy.strategy_key,
        idx,
        generationSeed
      );
      const nums = finalizeGroupNumbers(
        mergedCandidates,
        analysis,
        { ...strategy, variantIndex: idx, generationSeed },
        4
      );

      return {
        key: strategy.strategy_key,
        label: strategy.strategy_name || strategy.strategy_key,
        nums,
        reason: `來自 strategy_pool active 策略 ${strategy.strategy_name || strategy.strategy_key}`,
        meta: {
          model: 'v4.4',
          source: 'strategy_pool',
          strategy_key: strategy.strategy_key,
          strategy_name: strategy.strategy_name || strategy.strategy_key,
          gene_a: strategy.gene_a || '',
          gene_b: strategy.gene_b || '',
          protected_rank: Boolean(strategy.protected_rank),
          total_rounds: toInt(strategy.total_rounds, 0),
          avg_hit: Number(strategy.avg_hit || 0),
          roi: Number(strategy.roi || 0),
          recent_50_roi: Number(strategy.recent_50_roi || 0),
          generation_seed: generationSeed
        }
      };
    })
    .filter((group) => Array.isArray(group.nums) && group.nums.length === 4);

  let groups = ensureUniqueGroups(rawGroups, analysis, generationSeed);

  if (groups.length >= BET_GROUP_COUNT) {
    return groups.slice(0, BET_GROUP_COUNT);
  }

  const fallbackGroups = buildFallbackSeedGroupsFromRecent20(recent20, generationSeed);
  const map = new Map(groups.map((g) => [g.key, g]));

  for (const fallback of fallbackGroups) {
    if (!map.has(fallback.key) && map.size < BET_GROUP_COUNT) {
      map.set(fallback.key, fallback);
    }
  }

  groups = ensureUniqueGroups([...map.values()].slice(0, BET_GROUP_COUNT), analysis, generationSeed);
  return groups;
}

async function archivePreviousFormalPredictions(supabase, mode) {
  if (!String(mode || '').includes('formal')) {
    return { ok: true, archived_count: 0 };
  }

  const { data: existingRows, error: selectError } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id')
    .like('mode', '%formal%')
    .eq('status', 'created');

  if (selectError) throw selectError;

  const ids = (existingRows || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) {
    return { ok: true, archived_count: 0 };
  }

  const { error: updateError } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'replaced',
      compare_status: 'replaced'
    })
    .in('id', ids);

  if (updateError) throw updateError;

  return {
    ok: true,
    archived_count: ids.length,
    archived_ids: ids
  };
}

async function insertPredictionStrategyMap(supabase, predictionId, payload) {
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  if (!groups.length) return { ok: true, inserted_count: 0 };

  const rows = groups.map((group, idx) => ({
    prediction_id: predictionId,
    strategy_key:
      group?.meta?.strategy_key ||
      group?.key ||
      `group_${idx + 1}`,
    group_index: idx + 1,
    group_key: group?.key || `group_${idx + 1}`,
    group_label: group?.label || `第${idx + 1}組`,
    nums: Array.isArray(group?.nums) ? group.nums : [],
    mode: payload.mode || DEFAULT_MODE,
    source_draw_no: toInt(payload.source_draw_no, 0),
    created_at: new Date().toISOString()
  }));

  const { error } = await supabase
    .from(PREDICTION_STRATEGY_MAP_TABLE)
    .insert(rows);

  if (error) throw error;

  return {
    ok: true,
    inserted_count: rows.length
  };
}

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Missing SUPABASE_URL or SUPABASE_SECRET_KEY'
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'Method not allowed'
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
    const body = req.body || {};

    const mode = body.mode || DEFAULT_MODE;
    const targetPeriods = Number(body.targetPeriods || TARGET_PERIODS);
    const generationSeed =
      String(body.generationSeed || body.forceSeed || `${Date.now()}_${Math.random()}`);

    const inputGroups = normalizeIncomingGroups(
      Array.isArray(body.groups)
        ? body.groups
        : Array.isArray(body.generatedGroups)
          ? body.generatedGroups
          : Array.isArray(body.strategies)
            ? body.strategies
            : []
    );

    let groups = inputGroups;
    let groupSource = 'frontend';

    const recent20 = await getRecent20(supabase);
    if (!recent20.length) {
      return res.status(500).json({
        ok: false,
        error: 'recent20 not found'
      });
    }

    const analysis = buildRecent20Analysis(recent20);

    if (groups.length >= 1) {
      groups = ensureUniqueGroups(groups, analysis, generationSeed);
    }

    if (groups.length < BET_GROUP_COUNT) {
      groups = await buildStrategyGroupsFromPool(supabase, recent20, generationSeed);
      groupSource = 'server_auto_generate';
    }

    if (!Array.isArray(groups) || groups.length !== BET_GROUP_COUNT) {
      return res.status(400).json({
        ok: false,
        error: `need exactly ${BET_GROUP_COUNT} groups`,
        groups_count: Array.isArray(groups) ? groups.length : 0
      });
    }

    groups = ensureUniqueGroups(groups, analysis, generationSeed);

    try {
      await ensureStrategyPoolStrategies({
        groups: groups.map((group) => ({
          key: group.key,
          label: group.label,
          meta: group.meta || {}
        })),
        sourceType: 'manual_save',
        status: 'disabled'
      });
    } catch (poolErr) {
      console.error('ensureStrategyPoolStrategies error:', poolErr.message);
    }

    const latestDrawNo = await getLatestDrawNo(supabase);
    if (!latestDrawNo) {
      return res.status(500).json({
        ok: false,
        error: 'latest draw not found'
      });
    }

    let archiveResult = null;
    try {
      archiveResult = await archivePreviousFormalPredictions(supabase, mode);
    } catch (archiveErr) {
      return res.status(500).json({
        ok: false,
        error: 'archive previous formal predictions failed',
        detail: archiveErr.message
      });
    }

    const id = Date.now();

    const payload = {
      id,
      mode,
      status: 'created',
      source_draw_no: String(body.sourceDrawNo || latestDrawNo),
      target_periods: targetPeriods,
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from(PREDICTIONS_TABLE)
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'Prediction save failed',
        detail: error.message
      });
    }

    let predictionStrategyMapResult = null;

    try {
      predictionStrategyMapResult = await insertPredictionStrategyMap(supabase, id, payload);
    } catch (mapErr) {
      console.error('insertPredictionStrategyMap error:', mapErr.message);
    }

    return res.status(200).json({
      ok: true,
      id,
      row: data,
      source_draw_no: payload.source_draw_no,
      target_periods: targetPeriods,
      group_source: groupSource,
      generation_seed: generationSeed,
      archive_result: archiveResult,
      groups,
      prediction_strategy_map_result: predictionStrategyMapResult,
      bet_group_count: BET_GROUP_COUNT,
      cost_per_group_per_period: COST_PER_GROUP_PER_PERIOD,
      estimated_total_cost: BET_GROUP_COUNT * targetPeriods * COST_PER_GROUP_PER_PERIOD
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || 'prediction save failed'
    });
  }
}
