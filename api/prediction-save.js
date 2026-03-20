import { createClient } from '@supabase/supabase-js';

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
  throw new Error('Missing SUPABASE env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_STATS_TABLE = 'strategy_stats';

const FORMAL_MODE = 'formal';
const FORMAL_TARGET_PERIODS = 4;
const GROUP_COUNT = 4;
const RECENT_DRAW_LIMIT = 60;

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
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value === 'string') {
    return value.split(/[,\s]+/).map(Number).filter(Number.isFinite);
  }
  return [];
}

function getZone(n) {
  if (n >= 1 && n <= 20) return 1;
  if (n <= 40) return 2;
  if (n <= 60) return 3;
  return 4;
}

function normalizeGroup(group, idx = 0) {
  if (!group || typeof group !== 'object') return null;

  const numsSource = Array.isArray(group.nums)
    ? group.nums
    : Array.isArray(group.numbers)
      ? group.numbers
      : [];

  const nums = uniqueAsc(numsSource).slice(0, 4);
  if (nums.length !== 4) return null;

  const meta = group.meta && typeof group.meta === 'object' ? group.meta : {};

  return {
    key: String(group.key || meta.strategy_key || `group_${idx + 1}`),
    label: String(group.label || meta.strategy_name || `第${idx + 1}組`),
    nums,
    reason: String(group.reason || meta.strategy_name || '正式下注策略'),
    meta: {
      ...meta,
      strategy_key: String(meta.strategy_key || group.key || `group_${idx + 1}`),
      strategy_name: String(meta.strategy_name || group.label || `第${idx + 1}組`)
    }
  };
}

function normalizeGroups(rawGroups = []) {
  return (Array.isArray(rawGroups) ? rawGroups : [])
    .map((group, idx) => normalizeGroup(group, idx))
    .filter(Boolean)
    .slice(0, GROUP_COUNT);
}

function buildRecentAnalysis(rows = []) {
  const parsedRows = (Array.isArray(rows) ? rows : []).map((row) => ({
    draw_no: Number(row?.draw_no || 0),
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

function inferGeneA(strategyKey = '') {
  const key = String(strategyKey || '').toLowerCase();
  if (key.includes('hot')) return 'hot';
  if (key.includes('cold')) return 'cold';
  if (key.includes('zone')) return 'zone';
  if (key.includes('guard')) return 'guard';
  if (key.includes('chase')) return 'chase';
  if (key.includes('mix')) return 'hot';
  if (key.includes('tail')) return 'cold';
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
  return 'balanced';
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
        ...rotateList(
          (analysis.hottest || []).filter((n) => !(analysis.latestDraw || []).includes(n)),
          hash % 7
        ).slice(0, 16),
        ...rotateList(analysis.coldest || [], hash % 5).slice(0, 8)
      ]);

    case 'balanced':
    default:
      return uniqueKeepOrder([
        ...rotateList(analysis.latestDraw || [], hash % 3).slice(0, 1),
        ...rotateList(analysis.hottest || [], hash % 5).slice(0, 8),
        ...rotateList(analysis.coldest || [], hash % 7).slice(0, 8),
        ...rotateList(analysis.prevDraw || [], hash % 4).slice(0, 4)
      ]);
  }
}

function buildGroupsFromStats(statsRows = [], recentRows = [], sourceDrawNo) {
  const analysis = buildRecentAnalysis(recentRows);

  const rawGroups = (Array.isArray(statsRows) ? statsRows : [])
    .slice(0, GROUP_COUNT)
    .map((row, idx) => {
      const strategyKey = String(row?.strategy_key || `formal_${idx + 1}`);
      const strategyName = String(row?.strategy_key || `Formal ${idx + 1}`);
      const geneA = inferGeneA(strategyKey);
      const geneB = inferGeneB(strategyKey);

      const candidates = uniqueKeepOrder([
        ...geneCandidates(geneA, analysis, { strategyKey, idx, sourceDrawNo }),
        ...geneCandidates(geneB, analysis, { strategyKey, idx, sourceDrawNo }),
        ...(analysis.hottest || []),
        ...(analysis.coldest || [])
      ]);

      const rotateSeed = stableHash(`${strategyKey}_${sourceDrawNo}_${idx}`);
      const nums = uniqueAsc(
        rotateList(candidates, rotateSeed % Math.max(candidates.length || 1, 1)).slice(0, 4)
      );

      return {
        key: strategyKey,
        label: strategyName,
        nums,
        reason: '正式下注依 strategy_stats 排名建立',
        meta: {
          strategy_key: strategyKey,
          strategy_name: strategyName,
          roi: toNum(row?.roi, 0),
          avg_hit: toNum(row?.avg_hit, 0),
          total_rounds: toNum(row?.total_rounds, 0)
        }
      };
    });

  const validGroups = rawGroups.filter((group) => Array.isArray(group.nums) && group.nums.length === 4);

  if (validGroups.length === GROUP_COUNT) {
    return validGroups;
  }

  const pool = uniqueKeepOrder([
    ...(analysis.hottest || []).slice(0, 16),
    ...(analysis.coldest || []).slice(0, 16),
    ...(analysis.latestDraw || []).slice(0, 8)
  ]);

  const safePool = pool.length >= 16 ? pool : Array.from({ length: 20 }, (_, i) => i + 1);

  return Array.from({ length: GROUP_COUNT }, (_, idx) => ({
    key: `formal_fallback_${idx + 1}`,
    label: `Formal Fallback ${idx + 1}`,
    nums: uniqueAsc(rotateList(safePool, idx * 4).slice(0, 4)),
    reason: '正式下注 fallback',
    meta: {
      strategy_key: `formal_fallback_${idx + 1}`,
      strategy_name: `Formal Fallback ${idx + 1}`
    }
  }));
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

async function getRecentDraws(limitCount = RECENT_DRAW_LIMIT) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getTopStrategies(limit = GROUP_COUNT) {
  const { data, error } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .select('strategy_key, total_rounds, roi, avg_hit, score, updated_at')
    .order('score', { ascending: false })
    .order('roi', { ascending: false })
    .order('avg_hit', { ascending: false })
    .order('total_rounds', { ascending: false })
    .limit(limit * 3);

  if (error) throw error;

  return (Array.isArray(data) ? data : [])
    .filter((row) => String(row?.strategy_key || '').trim() !== '')
    .slice(0, limit);
}

async function getExistingFormalPrediction(drawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', FORMAL_MODE)
    .eq('source_draw_no', String(drawNo))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function markOlderFormalRowsReplaced(keepId) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id')
    .eq('mode', FORMAL_MODE)
    .neq('id', keepId);

  if (error) throw error;

  const ids = (data || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) return;

  const { error: updateError } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({ status: 'replaced' })
    .in('id', ids);

  if (updateError) throw updateError;
}

function generatePredictionId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

async function saveFormalPrediction(drawNo, groups) {
  const nowIso = new Date().toISOString();
  const existing = await getExistingFormalPrediction(drawNo);

  if (existing?.id) {
    const { data, error } = await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        mode: FORMAL_MODE,
        status: 'created',
        source_draw_no: String(drawNo),
        target_periods: FORMAL_TARGET_PERIODS,
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

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert({
      id: generatePredictionId(),
      mode: FORMAL_MODE,
      status: 'created',
      source_draw_no: String(drawNo),
      target_periods: FORMAL_TARGET_PERIODS,
      groups_json: groups,
      created_at: nowIso
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const latestDraw = await getLatestDraw();
    const recentDraws = await getRecentDraws(RECENT_DRAW_LIMIT);
    const topStrategies = await getTopStrategies(GROUP_COUNT);
    const groups = normalizeGroups(buildGroupsFromStats(topStrategies, recentDraws, latestDraw.draw_no));

    if (groups.length !== GROUP_COUNT) {
      return res.status(500).json({
        ok: false,
        error: 'failed to build formal groups'
      });
    }

    const saved = await saveFormalPrediction(latestDraw.draw_no, groups);
    await markOlderFormalRowsReplaced(saved.id);

    return res.status(200).json({
      ok: true,
      row: saved,
      groups
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'prediction save failed'
    });
  }
}
