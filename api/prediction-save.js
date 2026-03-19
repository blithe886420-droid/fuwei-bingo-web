import { createClient } from '@supabase/supabase-js';

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 4;

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_POOL_TABLE = 'strategy_pool';
const STRATEGY_STATS_TABLE = 'strategy_stats';

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function uniqueKeepOrder(nums = []) {
  const seen = new Set();
  const result = [];

  for (const n of (Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite)) {
    if (seen.has(n)) continue;
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
      .split(/[,\s]+/)
      .map((s) => Number(String(s).trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function normalizeMode(rawMode = '') {
  const mode = String(rawMode || '').trim();
  if (mode === 'formal_synced_from_server_prediction') return 'formal';
  if (mode) return mode;
  return 'formal';
}

function normalizeGroup(group, idx = 0) {
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
    key: String(group.key || group.strategyKey || `group_${idx + 1}`),
    label: String(group.label || group.name || `第${idx + 1}組`),
    nums,
    reason: String(group.reason || ''),
    meta: group.meta && typeof group.meta === 'object' ? group.meta : {}
  };
}

function normalizeGroups(rawGroups = []) {
  if (!Array.isArray(rawGroups)) return [];

  return rawGroups
    .map((group, idx) => normalizeGroup(group, idx))
    .filter(Boolean)
    .slice(0, BET_GROUP_COUNT);
}

function getZone(n) {
  if (n >= 1 && n <= 20) return 1;
  if (n <= 40) return 2;
  if (n <= 60) return 3;
  return 4;
}

function buildRecentAnalysis(rows = []) {
  const parsedRows = (Array.isArray(rows) ? rows : []).map((row) => ({
    draw_no: toInt(row?.draw_no, 0),
    draw_time: row?.draw_time || null,
    numbers: parseDrawNumbers(row?.numbers)
  }));

  const allNums = parsedRows.flatMap((row) => row.numbers);
  const latestDraw = parsedRows[0]?.numbers || [];
  const prevDraw = parsedRows[1]?.numbers || [];
  const thirdDraw = parsedRows[2]?.numbers || [];

  const freq = new Map();
  const tailFreq = new Map();
  const zoneFreq = new Map();

  for (let n = 1; n <= 80; n += 1) {
    freq.set(n, 0);
  }

  for (const n of allNums) {
    freq.set(n, (freq.get(n) || 0) + 1);
    tailFreq.set(n % 10, (tailFreq.get(n % 10) || 0) + 1);
    zoneFreq.set(getZone(n), (zoneFreq.get(getZone(n)) || 0) + 1);
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

  return {
    hottest,
    coldest,
    warm: warm.length ? warm : hottest,
    latestDraw,
    prevDraw,
    thirdDraw,
    topTails,
    hotZones,
    numbers1to80: Array.from({ length: 80 }, (_, idx) => idx + 1)
  };
}

function geneCandidates(gene, analysis, context = {}) {
  const geneName = String(gene || '').toLowerCase();
  const variantIndex = toInt(context.variantIndex, 0);
  const strategyKey = String(context.strategyKey || '');
  const seedText = String(context.seed || '');
  const hash = stableHash(`${strategyKey}_${variantIndex}_${geneName}_${seedText}`);

  const hottest = analysis.hottest || [];
  const coldest = analysis.coldest || [];
  const warm = analysis.warm || [];
  const latestDraw = analysis.latestDraw || [];
  const prevDraw = analysis.prevDraw || [];
  const thirdDraw = analysis.thirdDraw || [];
  const topTails = analysis.topTails || [];
  const hotZones = analysis.hotZones || [];

  const latestSet = new Set(latestDraw);
  const prevSet = new Set(prevDraw);

  const pickByTail = (tail, source, count) =>
    source.filter((n) => n % 10 === tail).slice(0, count);

  const pickByZone = (zone, source, count) =>
    source.filter((n) => getZone(n) === zone).slice(0, count);

  switch (geneName) {
    case 'hot':
      return rotateList(hottest, hash % 13).slice(0, 24);

    case 'chase':
      return uniqueKeepOrder([
        ...latestDraw,
        ...rotateList(hottest, hash % 11).slice(0, 16)
      ]);

    case 'balanced':
    case 'balance':
      return uniqueKeepOrder([
        ...pickByZone(1, rotateList(hottest, hash % 3), 4),
        ...pickByZone(2, rotateList(hottest, hash % 5), 4),
        ...pickByZone(3, rotateList(warm, hash % 7), 4),
        ...pickByZone(4, rotateList(warm, hash % 9), 4),
        ...rotateList(hottest, hash % 10).slice(0, 8)
      ]);

    case 'zone': {
      const zoneA = hotZones[hash % Math.max(1, hotZones.length)] || 1;
      const zoneB = hotZones[(hash + 1) % Math.max(1, hotZones.length)] || 2;
      return uniqueKeepOrder([
        ...pickByZone(zoneA, rotateList(hottest, hash % 7), 8),
        ...pickByZone(zoneB, rotateList(warm, hash % 5), 8),
        ...rotateList(coldest, hash % 9).slice(0, 6)
      ]);
    }

    case 'tail': {
      const tailA = topTails[hash % Math.max(1, topTails.length)] ?? 0;
      const tailB = topTails[(hash + 2) % Math.max(1, topTails.length)] ?? 1;
      return uniqueKeepOrder([
        ...pickByTail(tailA, rotateList(hottest, hash % 7), 8),
        ...pickByTail(tailB, rotateList(warm, hash % 5), 8),
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

    case 'jump':
      return uniqueKeepOrder([
        ...rotateList(hottest.filter((n) => !latestSet.has(n) && !prevSet.has(n)), hash % 9).slice(0, 16),
        ...rotateList(coldest, hash % 5).slice(0, 6)
      ]);

    case 'structure':
    case 'pattern':
      return uniqueKeepOrder([
        ...rotateList(hottest, hash % 8).slice(0, 8),
        ...rotateList(warm, hash % 6).slice(0, 8),
        ...latestDraw
      ]);

    default:
      return rotateList(hottest, hash % 10).slice(0, 20);
  }
}

function mergeGeneLists(geneLists = [], strategyKey = '', variantIndex = 0, seed = '') {
  const lists = geneLists.filter((list) => Array.isArray(list) && list.length > 0);
  if (!lists.length) return [];

  const hash = stableHash(`${strategyKey}_${variantIndex}_${seed}`);
  const result = [];

  for (let i = 0; i < lists.length; i += 1) {
    const list = lists[(i + hash) % lists.length];
    const offset = (hash + i * 3) % Math.max(1, list.length);
    result.push(...rotateList(list, offset));
  }

  return uniqueKeepOrder(result);
}

function finalizeGroupNumbers(candidates = [], analysis, strategyKey = '', variantIndex = 0, seed = '') {
  const merged = uniqueKeepOrder([
    ...candidates,
    ...(analysis.hottest || []),
    ...(analysis.warm || []),
    ...(analysis.coldest || []),
    ...(analysis.numbers1to80 || [])
  ]);

  const hash = stableHash(`${strategyKey}_${variantIndex}_${seed}`);
  const rotated = rotateList(merged, hash % Math.max(1, merged.length));

  const selected = [];
  for (const n of rotated) {
    if (selected.includes(n)) continue;
    selected.push(n);
    if (selected.length >= 4) break;
  }

  return uniqueAsc(selected.slice(0, 4));
}

function getGroupSignature(nums = []) {
  return uniqueAsc(nums).join('-');
}

function mutateGroupToUnique(baseNums = [], analysis, strategyKey = '', variantIndex = 0, seed = '', used = new Set()) {
  const base = uniqueAsc(baseNums).slice(0, 4);
  const originalSignature = getGroupSignature(base);

  if (!used.has(originalSignature)) {
    return base;
  }

  const pool = uniqueKeepOrder([
    ...(analysis.hottest || []),
    ...(analysis.warm || []),
    ...(analysis.coldest || []),
    ...(analysis.numbers1to80 || [])
  ]);

  const hash = stableHash(`${strategyKey}_${variantIndex}_mutate_${seed}`);
  const rotatedPool = rotateList(pool, hash % Math.max(1, pool.length));

  for (const candidate of rotatedPool) {
    if (base.includes(candidate)) continue;

    for (let i = 0; i < base.length; i += 1) {
      const mutated = uniqueAsc([
        ...base.filter((_, idx) => idx !== i),
        candidate
      ]).slice(0, 4);

      if (mutated.length !== 4) continue;

      const signature = getGroupSignature(mutated);
      if (!used.has(signature)) {
        return mutated;
      }
    }
  }

  return base;
}

function ensureUniqueGroups(groups = [], analysis, seed = '') {
  const used = new Set();

  return groups.map((group, idx) => {
    const strategyKey = String(group.key || `group_${idx + 1}`);
    const original = uniqueAsc(group.nums).slice(0, 4);
    const originalSignature = getGroupSignature(original);

    let nums = original;
    if (used.has(originalSignature)) {
      nums = mutateGroupToUnique(original, analysis, strategyKey, idx, seed, used);
    }

    used.add(getGroupSignature(nums));

    return {
      ...group,
      nums,
      reason:
        getGroupSignature(nums) !== originalSignature
          ? `${group.reason || ''}（已自動避開重複組合）`
          : group.reason || ''
    };
  });
}

function scoreStrategy(row = {}) {
  const protectedBonus = row.protected_rank ? 9999 : 0;
  const avgHit = toNum(row.avg_hit, 0);
  const roi = toNum(row.roi, 0);
  const recent50Roi = toNum(row.recent_50_roi, 0);
  const hit2 = toInt(row.hit2, 0);
  const hit3 = toInt(row.hit3, 0);
  const hit4 = toInt(row.hit4, 0);
  const totalRounds = toInt(row.total_rounds, 0);

  const explosionScore = hit2 * 3 + hit3 * 8 + hit4 * 20;
  const stabilityScore = avgHit * 60 + recent50Roi * 45 + roi * 10;
  const matureBonus = totalRounds >= 30 ? 25 : totalRounds >= 15 ? 10 : 0;

  return protectedBonus + explosionScore + stabilityScore + matureBonus;
}

async function getLatestDraw(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .single();

  if (error) throw error;
  if (!data) throw new Error('latest draw not found');

  return data;
}

async function getRecentDraws(supabase, limitCount = 80) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getExistingPredictionBySourceDrawNo(supabase, sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('source_draw_no', String(sourceDrawNo))
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function markOlderFormalRowsReplaced(supabase, keepId) {
  const { data: rows, error: readError } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id')
    .eq('mode', 'formal')
    .neq('id', keepId);

  if (readError) throw readError;

  const ids = (rows || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) return;

  const { error: updateError } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'replaced'
    })
    .in('id', ids);

  if (updateError) throw updateError;
}

async function getRankedActiveStrategies(supabase, limitCount = BET_GROUP_COUNT) {
  const { data: poolRows, error: poolError } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active');

  if (poolError) throw poolError;

  const pool = (poolRows || []).filter(
    (row) => String(row.strategy_key || '').trim()
  );

  if (!pool.length) return [];

  const keys = pool.map((row) => row.strategy_key);

  const { data: statsRows, error: statsError } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .in('strategy_key', keys);

  if (statsError) throw statsError;

  const statsMap = new Map((statsRows || []).map((row) => [row.strategy_key, row]));

  return pool
    .map((row) => {
      const stats = statsMap.get(row.strategy_key) || {};
      return {
        ...row,
        ...stats,
        strategy_score: scoreStrategy({
          ...row,
          ...stats
        })
      };
    })
    .sort((a, b) => {
      if (Boolean(a.protected_rank) !== Boolean(b.protected_rank)) {
        return Number(Boolean(b.protected_rank)) - Number(Boolean(a.protected_rank));
      }
      return toNum(b.strategy_score, 0) - toNum(a.strategy_score, 0);
    })
    .slice(0, limitCount);
}

function buildFallbackStrategies() {
  return [
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
      strategy_key: 'cluster_chase',
      strategy_name: 'Cluster Chase',
      gene_a: 'chase',
      gene_b: 'tail',
      protected_rank: false
    },
    {
      strategy_key: 'guard_zone_rotation',
      strategy_name: 'Guard Zone Rotation',
      gene_a: 'guard',
      gene_b: 'zone',
      protected_rank: false
    }
  ];
}

function buildGroupsFromStrategies(strategies = [], recentRows = [], seed = '') {
  const analysis = buildRecentAnalysis(recentRows);

  const rawGroups = strategies.map((strategy, idx) => {
    const geneA = String(strategy.gene_a || '').trim() || 'mix';
    const geneB = String(strategy.gene_b || '').trim() || 'balanced';

    const listA = geneCandidates(geneA, analysis, {
      variantIndex: idx,
      strategyKey: strategy.strategy_key,
      seed
    });

    const listB = geneCandidates(geneB, analysis, {
      variantIndex: idx,
      strategyKey: strategy.strategy_key,
      seed
    });

    const candidates = mergeGeneLists(
      [listA, listB],
      strategy.strategy_key,
      idx,
      seed
    );

    const nums = finalizeGroupNumbers(
      candidates,
      analysis,
      strategy.strategy_key,
      idx,
      seed
    );

    return {
      key: String(strategy.strategy_key || `group_${idx + 1}`),
      label: String(strategy.strategy_name || strategy.strategy_key || `第${idx + 1}組`),
      nums,
      reason: `正式下注 = AI選策略`,
      meta: {
        strategy_key: String(strategy.strategy_key || `group_${idx + 1}`),
        strategy_name: String(strategy.strategy_name || strategy.strategy_key || `group_${idx + 1}`),
        gene_a: geneA,
        gene_b: geneB,
        source: 'strategy_pool_active_ai_select',
        strategy_score: toNum(strategy.strategy_score, 0),
        total_rounds: toInt(strategy.total_rounds, 0),
        avg_hit: toNum(strategy.avg_hit, 0),
        roi: toNum(strategy.roi, 0),
        recent_50_roi: toNum(strategy.recent_50_roi, 0),
        protected_rank: Boolean(strategy.protected_rank)
      }
    };
  });

  return ensureUniqueGroups(rawGroups, analysis, seed).slice(0, BET_GROUP_COUNT);
}

async function buildAIGroups(supabase, seed = '') {
  const recentRows = await getRecentDraws(supabase, 80);
  const ranked = await getRankedActiveStrategies(supabase, BET_GROUP_COUNT);

  if (ranked.length >= BET_GROUP_COUNT) {
    return buildGroupsFromStrategies(ranked, recentRows, seed);
  }

  return buildGroupsFromStrategies(buildFallbackStrategies(), recentRows, seed);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'Method not allowed'
      });
    }

    const SUPABASE_URL =
      process.env.SUPABASE_URL ||
      process.env.VITE_SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const SUPABASE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_KEY ||
      process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Missing SUPABASE env'
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });

    const body = req.body || {};
    const mode = normalizeMode(body.mode);
    const targetPeriods = toInt(body.targetPeriods, TARGET_PERIODS);
    const seed = `${Date.now()}_${Math.random()}`;

    const latestDraw = await getLatestDraw(supabase);
    const latestDrawNo = String(latestDraw.draw_no || '');

    if (!latestDrawNo) {
      return res.status(500).json({
        ok: false,
        error: 'latest draw not found'
      });
    }

    let groups = normalizeGroups(
      body.groups ||
      body.generatedGroups ||
      body.predictionGroups ||
      []
    );

    if (groups.length !== BET_GROUP_COUNT) {
      groups = await buildAIGroups(supabase, seed);
    }

    if (groups.length !== BET_GROUP_COUNT) {
      return res.status(400).json({
        ok: false,
        error: 'groups 不足'
      });
    }

    const nowIso = new Date().toISOString();

    const existing = await getExistingPredictionBySourceDrawNo(supabase, latestDrawNo);

    let savedRow = null;

    if (existing) {
      const { data, error } = await supabase
        .from(PREDICTIONS_TABLE)
        .update({
          mode,
          status: 'created',
          source_draw_no: latestDrawNo,
          target_periods: targetPeriods,
          groups_json: groups,
          created_at: nowIso
        })
        .eq('id', existing.id)
        .select('*')
        .single();

      if (error) {
        return res.status(500).json({
          ok: false,
          error: error.message
        });
      }

      savedRow = data;
    } else {
      const { data, error } = await supabase
        .from(PREDICTIONS_TABLE)
        .insert({
          id: Date.now(),
          mode,
          status: 'created',
          source_draw_no: latestDrawNo,
          target_periods: targetPeriods,
          groups_json: groups,
          created_at: nowIso
        })
        .select('*')
        .single();

      if (error) {
        return res.status(500).json({
          ok: false,
          error: error.message
        });
      }

      savedRow = data;
    }

    if (mode === 'formal' && savedRow?.id) {
      await markOlderFormalRowsReplaced(supabase, savedRow.id);
    }

    return res.status(200).json({
      ok: true,
      id: savedRow.id,
      row: savedRow,
      source_draw_no: savedRow.source_draw_no,
      target_periods: savedRow.target_periods,
      groups: savedRow.groups_json
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'prediction save failed'
    });
  }
}
