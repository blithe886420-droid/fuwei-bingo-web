import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

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

const MODE = 'test';
const GROUP_COUNT = 4;
const TARGET_PERIODS = 2;
const COST_PER_GROUP_PER_PERIOD = 25;
const RECENT_DRAW_LIMIT = 60;
const MAX_COMPARE_PER_RUN = 5;

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

function getZone(n) {
  if (n >= 1 && n <= 20) return 1;
  if (n <= 40) return 2;
  if (n <= 60) return 3;
  return 4;
}

function parseDrawNumbers(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value === 'string') {
    return value.split(/[,\s]+/).map(Number).filter(Number.isFinite);
  }
  return [];
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

function buildFallbackStrategies() {
  return [
    {
      strategy_key: 'hot_balanced',
      strategy_name: 'Hot Balanced',
      gene_a: 'hot',
      gene_b: 'balanced',
      score: 0
    },
    {
      strategy_key: 'balanced_zone',
      strategy_name: 'Balanced Zone',
      gene_a: 'balanced',
      gene_b: 'zone',
      score: 0
    },
    {
      strategy_key: 'cluster_chase',
      strategy_name: 'Cluster Chase',
      gene_a: 'chase',
      gene_b: 'hot',
      score: 0
    },
    {
      strategy_key: 'guard_zone',
      strategy_name: 'Guard Zone',
      gene_a: 'guard',
      gene_b: 'zone',
      score: 0
    }
  ];
}

function buildGroupsFromStrategies(strategies = [], recentRows = [], sourceDrawNo) {
  const analysis = buildRecentAnalysis(recentRows);

  const rawGroups = (Array.isArray(strategies) ? strategies : [])
    .slice(0, GROUP_COUNT)
    .map((strategy, idx) => {
      const geneA = String(strategy.gene_a || 'hot');
      const geneB = String(strategy.gene_b || 'balanced');
      const key = String(strategy.strategy_key || `group_${idx + 1}`);
      const label = String(strategy.strategy_name || key);

      const candidates = uniqueKeepOrder([
        ...geneCandidates(geneA, analysis, { strategyKey: key, idx, sourceDrawNo }),
        ...geneCandidates(geneB, analysis, { strategyKey: key, idx, sourceDrawNo }),
        ...(analysis.hottest || []),
        ...(analysis.coldest || [])
      ]);

      const rotateSeed = stableHash(`${key}_${sourceDrawNo}_${idx}`);
      const nums = uniqueAsc(rotateList(candidates, rotateSeed % Math.max(candidates.length || 1, 1)).slice(0, 4));

      return {
        key,
        label,
        nums,
        reason: 'auto-train strategy',
        meta: {
          strategy_key: key,
          strategy_name: label,
          gene_a: geneA,
          gene_b: geneB,
          score: toNum(strategy.score, toNum(strategy.strategy_score, 0))
        }
      };
    });

  const validGroups = rawGroups.filter((group) => Array.isArray(group.nums) && group.nums.length === 4);

  if (validGroups.length === GROUP_COUNT) {
    return validGroups;
  }

  const latestNumbers = analysis.latestDraw || [];
  const fallbackPool = uniqueKeepOrder([
    ...latestNumbers,
    ...(analysis.hottest || []).slice(0, 20),
    ...(analysis.coldest || []).slice(0, 20)
  ]);

  const safePool = fallbackPool.length >= 16
    ? fallbackPool
    : Array.from({ length: 20 }, (_, i) => i + 1);

  return Array.from({ length: GROUP_COUNT }, (_, idx) => ({
    key: `fallback_${idx + 1}`,
    label: `Fallback ${idx + 1}`,
    nums: uniqueAsc(rotateList(safePool, idx * 4).slice(0, 4)),
    reason: 'auto-train fallback',
    meta: {
      strategy_key: `fallback_${idx + 1}`,
      strategy_name: `Fallback ${idx + 1}`
    }
  }));
}

function computeScore(row) {
  const roi = toNum(row?.roi, 0);
  const avgHit = toNum(row?.avg_hit, 0);
  const totalRounds = toNum(row?.total_rounds, 0);
  return roi * 100 + avgHit * 20 + Math.min(totalRounds, 200) * 0.1;
}

async function getLatestDraw() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
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

async function getTopTrainingStrategies(limitCount = GROUP_COUNT) {
  const { data, error } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .select('strategy_key, roi, avg_hit, total_rounds')
    .order('roi', { ascending: false })
    .order('avg_hit', { ascending: false })
    .order('total_rounds', { ascending: false })
    .limit(limitCount * 3);

  if (error) throw error;

  const rows = (Array.isArray(data) ? data : [])
    .filter((row) => String(row?.strategy_key || '').trim() !== '')
    .map((row) => ({
      strategy_key: String(row.strategy_key),
      strategy_name: String(row.strategy_key),
      gene_a: inferGeneA(row.strategy_key),
      gene_b: inferGeneB(row.strategy_key),
      score: computeScore(row)
    }))
    .slice(0, limitCount);

  if (rows.length >= GROUP_COUNT) return rows;
  return buildFallbackStrategies();
}

function inferGeneA(strategyKey = '') {
  const key = String(strategyKey || '').toLowerCase();
  if (key.includes('hot')) return 'hot';
  if (key.includes('cold')) return 'cold';
  if (key.includes('zone')) return 'zone';
  if (key.includes('guard')) return 'guard';
  if (key.includes('chase')) return 'chase';
  if (key.includes('balance')) return 'balanced';
  return 'hot';
}

function inferGeneB(strategyKey = '') {
  const key = String(strategyKey || '').toLowerCase();
  if (key.includes('zone')) return 'zone';
  if (key.includes('guard')) return 'guard';
  if (key.includes('chase')) return 'chase';
  if (key.includes('cold')) return 'cold';
  if (key.includes('balance')) return 'balanced';
  return 'balanced';
}

async function getPendingPredictions(limitCount = MAX_COMPARE_PER_RUN) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', MODE)
    .eq('status', 'created')
    .order('created_at', { ascending: true })
    .limit(limitCount);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getFutureDraws(sourceDrawNo, targetPeriods) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .gt('draw_no', Number(sourceDrawNo))
    .order('draw_no', { ascending: true })
    .limit(targetPeriods);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getLatestCreatedPredictionBySource(sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', MODE)
    .eq('source_draw_no', String(sourceDrawNo))
    .in('status', ['created', 'compared'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function generatePredictionId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

async function insertPrediction(sourceDrawNo, groups) {
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert({
      id: generatePredictionId(),
      mode: MODE,
      status: 'created',
      source_draw_no: String(sourceDrawNo),
      target_periods: TARGET_PERIODS,
      groups_json: groups,
      compare_result: null,
      compare_status: null,
      verdict: null,
      hit_count: null,
      compared_at: null,
      created_at: nowIso
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function updateComparedPrediction(predictionId, payload) {
  const { error } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'compared',
      compare_status: 'done',
      hit_count: Number(payload?.hitCount || 0),
      compare_result: payload?.compareResult || null,
      verdict: payload?.verdict || null,
      compared_at: new Date().toISOString()
    })
    .eq('id', predictionId);

  if (error) throw error;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const comparedRows = [];
    const pendingDetails = [];

    const pendingPredictions = await getPendingPredictions(MAX_COMPARE_PER_RUN);

    for (const prediction of pendingPredictions) {
      const targetPeriods = toNum(prediction?.target_periods, TARGET_PERIODS);
      const futureDraws = await getFutureDraws(prediction?.source_draw_no, targetPeriods);

      if (futureDraws.length < targetPeriods) {
        pendingDetails.push({
          prediction_id: prediction?.id || null,
          source_draw_no: prediction?.source_draw_no || null,
          target_periods: targetPeriods,
          ready_draw_count: futureDraws.length,
          message: `尚未收齊第 ${toNum(prediction?.source_draw_no, 0) + 1} 到第 toNum(prediction?.source_draw_no, 0) + targetPeriods} 期開獎資料`
        });
        continue;
      }

      const payload = buildComparePayload({
        groups: Array.isArray(prediction?.groups_json) ? prediction.groups_json : [],
        drawRows: futureDraws,
        costPerGroupPerPeriod: COST_PER_GROUP_PER_PERIOD
      });

      await updateComparedPrediction(prediction.id, payload);
      await recordStrategyCompareResult(payload.compareResult);

      comparedRows.push({
        id: prediction.id,
        source_draw_no: prediction.source_draw_no,
        target_periods: targetPeriods,
        hit_count: payload.hitCount
      });
    }

    const latestDraw = await getLatestDraw();

    if (!latestDraw?.draw_no) {
      return res.status(200).json({
        ok: true,
        compared_count: comparedRows.length,
        created_count: 0,
        compared_rows: comparedRows,
        pending_details: pendingDetails,
        active_created_prediction: null,
        leaderboard: []
      });
    }

    let activeCreatedPrediction = await getLatestCreatedPredictionBySource(latestDraw.draw_no);
    let createdPrediction = null;

    if (!activeCreatedPrediction) {
      const recentDraws = await getRecentDraws(RECENT_DRAW_LIMIT);
      const strategies = await getTopTrainingStrategies(GROUP_COUNT);
      const groups = buildGroupsFromStrategies(strategies, recentDraws, latestDraw.draw_no);

      createdPrediction = await insertPrediction(latestDraw.draw_no, groups);
      activeCreatedPrediction = createdPrediction;
    }

    const { data: leaderboardRows, error: leaderboardError } = await supabase
      .from(STRATEGY_STATS_TABLE)
      .select('strategy_key, total_rounds, total_hits, total_cost, total_reward, total_profit, roi, avg_hit, hit_rate, updated_at')
      .order('roi', { ascending: false })
      .order('avg_hit', { ascending: false })
      .order('total_rounds', { ascending: false })
      .limit(10);

    if (leaderboardError) throw leaderboardError;

    const leaderboard = (Array.isArray(leaderboardRows) ? leaderboardRows : []).map((row) => ({
      key: String(row.strategy_key),
      label: String(row.strategy_key),
      strategy_key: String(row.strategy_key),
      total_rounds: toNum(row.total_rounds, 0),
      total_hits: toNum(row.total_hits, 0),
      total_cost: toNum(row.total_cost, 0),
      total_reward: toNum(row.total_reward, 0),
      total_profit: toNum(row.total_profit, 0),
      roi: toNum(row.roi, 0),
      avg_hit: toNum(row.avg_hit, 0),
      hit_rate: toNum(row.hit_rate, 0),
      score: computeScore(row),
      updated_at: row.updated_at || null
    }));

    return res.status(200).json({
      ok: true,
      compared_count: comparedRows.length,
      created_count: createdPrediction ? 1 : 0,
      compared_rows: comparedRows,
      pending_details: pendingDetails,
      active_created_prediction: activeCreatedPrediction
        ? {
            id: activeCreatedPrediction.id,
            source_draw_no: activeCreatedPrediction.source_draw_no,
            target_periods: activeCreatedPrediction.target_periods,
            created_at: activeCreatedPrediction.created_at,
            mode: activeCreatedPrediction.mode,
            status: activeCreatedPrediction.status
          }
        : null,
      leaderboard
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'auto-train failed'
    });
  }
}
