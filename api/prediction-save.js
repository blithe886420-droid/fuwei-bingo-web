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
  const mode = String(rawMode || '').trim().toLowerCase();
  if (mode === 'formal_synced_from_server_prediction') return 'formal';
  if (mode === 'test') return 'test';
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

  const freq = new Map();
  const zoneFreq = new Map();

  for (let n = 1; n <= 80; n += 1) {
    freq.set(n, 0);
  }

  for (const n of allNums) {
    freq.set(n, (freq.get(n) || 0) + 1);
    zoneFreq.set(getZone(n), (zoneFreq.get(getZone(n)) || 0) + 1);
  }

  const hottest = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const coldest = [...freq.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  const hotZones = [...zoneFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([zone]) => zone);

  return {
    hottest,
    coldest,
    latestDraw,
    prevDraw,
    hotZones
  };
}

function geneCandidates(gene, analysis, context = {}) {
  const geneName = String(gene || '').toLowerCase();
  const hash = stableHash(`${context.strategyKey || ''}_${context.idx || 0}_${geneName}`);

  switch (geneName) {
    case 'hot':
      return rotateList(analysis.hottest || [], hash % 9).slice(0, 24);
    case 'cold':
      return rotateList(analysis.coldest || [], hash % 9).slice(0, 20);
    case 'zone': {
      const hotZone = analysis.hotZones?.[0] || 1;
      return uniqueKeepOrder([
        ...rotateList((analysis.hottest || []).filter((n) => getZone(n) === hotZone), hash % 7).slice(0, 12),
        ...rotateList(analysis.hottest || [], hash % 5).slice(0, 10)
      ]);
    }
    case 'guard':
      return uniqueKeepOrder([
        ...rotateList((analysis.hottest || []).filter((n) => !(analysis.latestDraw || []).includes(n)), hash % 7).slice(0, 16),
        ...rotateList(analysis.coldest || [], hash % 5).slice(0, 8)
      ]);
    case 'balanced':
    case 'balance':
      return uniqueKeepOrder([
        ...rotateList(analysis.latestDraw || [], hash % 3).slice(0, 1),
        ...rotateList(analysis.hottest || [], hash % 5).slice(0, 8),
        ...rotateList(analysis.coldest || [], hash % 7).slice(0, 8)
      ]);
    case 'chase':
      return uniqueKeepOrder([
        ...(analysis.latestDraw || []),
        ...(analysis.prevDraw || []),
        ...rotateList(analysis.hottest || [], hash % 11).slice(0, 10)
      ]);
    default:
      return rotateList(analysis.hottest || [], hash % 10).slice(0, 20);
  }
}

function buildGroupsFromStrategies(strategies = [], recentRows = []) {
  const analysis = buildRecentAnalysis(recentRows);

  const groups = strategies.map((strategy, idx) => {
    const geneA = String(strategy.gene_a || 'hot');
    const geneB = String(strategy.gene_b || 'balanced');
    const key = String(strategy.strategy_key || `group_${idx + 1}`);
    const label = String(strategy.strategy_name || key);

    const candidates = uniqueKeepOrder([
      ...geneCandidates(geneA, analysis, { strategyKey: key, idx }),
      ...geneCandidates(geneB, analysis, { strategyKey: key, idx }),
      ...(analysis.hottest || []),
      ...(analysis.coldest || [])
    ]);

    const nums = uniqueAsc(candidates).slice(0, 4);

    return {
      key,
      label,
      nums,
      reason: '正式下注 = AI選策略',
      meta: {
        strategy_key: key,
        strategy_name: label,
        gene_a: geneA,
        gene_b: geneB,
        strategy_score: toNum(strategy.strategy_score, 0)
      }
    };
  });

  return groups.filter((group) => group.nums.length === 4).slice(0, BET_GROUP_COUNT);
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

  return (
    protectedBonus +
    avgHit * 60 +
    recent50Roi * 45 +
    roi * 10 +
    hit2 * 3 +
    hit3 * 8 +
    hit4 * 20 +
    (totalRounds >= 30 ? 25 : totalRounds >= 15 ? 10 : 0)
  );
}

async function getLatestDraw(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

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

async function getExistingPredictionByDrawAndMode(supabase, sourceDrawNo, mode) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('source_draw_no', String(sourceDrawNo))
    .eq('mode', mode)
    .order('created_at', { ascending: false })
    .limit(1)
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
    .update({ status: 'replaced' })
    .in('id', ids);

  if (updateError) throw updateError;
}

async function getRankedActiveStrategies(supabase, limitCount = BET_GROUP_COUNT) {
  const { data: poolRows, error: poolError } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active');

  if (poolError) throw poolError;

  const pool = (poolRows || []).filter((row) => String(row.strategy_key || '').trim());
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
        strategy_score: scoreStrategy({ ...row, ...stats })
      };
    })
    .sort((a, b) => toNum(b.strategy_score, 0) - toNum(a.strategy_score, 0))
    .slice(0, limitCount);
}

function buildFallbackStrategies() {
  return [
    {
      strategy_key: 'hot_balanced',
      strategy_name: 'Hot Balanced',
      gene_a: 'hot',
      gene_b: 'balanced',
      strategy_score: 0
    },
    {
      strategy_key: 'balanced_zone',
      strategy_name: 'Balanced Zone',
      gene_a: 'balanced',
      gene_b: 'zone',
      strategy_score: 0
    },
    {
      strategy_key: 'cluster_chase',
      strategy_name: 'Cluster Chase',
      gene_a: 'chase',
      gene_b: 'hot',
      strategy_score: 0
    },
    {
      strategy_key: 'guard_zone',
      strategy_name: 'Guard Zone',
      gene_a: 'guard',
      gene_b: 'zone',
      strategy_score: 0
    }
  ];
}

async function buildAIGroups(supabase) {
  const recentRows = await getRecentDraws(supabase, 80);
  const ranked = await getRankedActiveStrategies(supabase, BET_GROUP_COUNT);

  if (ranked.length >= BET_GROUP_COUNT) {
    return buildGroupsFromStrategies(ranked, recentRows);
  }

  return buildGroupsFromStrategies(buildFallbackStrategies(), recentRows);
}

function generatePredictionId() {
  return Date.now() + Math.floor(Math.random() * 1000);
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
    const targetPeriods = mode === 'formal' ? TARGET_PERIODS : 2;

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
      groups = await buildAIGroups(supabase);
    }

    if (groups.length !== BET_GROUP_COUNT) {
      return res.status(400).json({
        ok: false,
        error: 'groups 不足'
      });
    }

    const nowIso = new Date().toISOString();
    const existing = await getExistingPredictionByDrawAndMode(supabase, latestDrawNo, mode);

    let savedRow = null;

    if (existing?.id) {
      const { data, error } = await supabase
        .from(PREDICTIONS_TABLE)
        .update({
          mode,
          status: 'created',
          source_draw_no: latestDrawNo,
          target_periods: targetPeriods,
          groups_json: groups,
          compare_result: null,
          compare_status: null,
          verdict: null,
          hit_count: null,
          compared_at: null,
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
          id: generatePredictionId(),
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

    if (!savedRow?.id) {
      return res.status(500).json({
        ok: false,
        error: 'prediction save returned null'
      });
    }

    if (mode === 'formal') {
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
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'prediction save failed'
    });
  }
}
