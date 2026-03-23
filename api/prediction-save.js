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

const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';
const STRATEGY_STATS_TABLE = 'strategy_stats';

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

const PROFIT_MODE_NAME = 'profit_mode_v2_1_weighted';
const BASE_BET_AMOUNT = 25;

const HARD_RULES = {
  roiMin: 0,
  avgHitMin: 1.1,
  totalRoundsMin: 10,
  scoreMin: 0
};

const SOFT_RULES = {
  roiMin: -0.2,
  avgHitMin: 1.0,
  totalRoundsMin: 5,
  scoreMin: -150
};

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  return 'balanced';
}

function numbersByZone(zone, pool = []) {
  return pool.filter((n) => getZone(n) === zone);
}

function numbersByTail(tail, pool = []) {
  return pool.filter((n) => n % 10 === tail);
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
  return {
    strategy_key: String(row?.strategy_key || '').trim(),
    strategy_name: String(row?.strategy_name || row?.strategy_key || '').trim(),
    score: toNum(row?.score, 0),
    avg_hit: toNum(row?.avg_hit, 0),
    roi: toNum(row?.roi, 0),
    total_rounds: toNum(row?.total_rounds, 0),
    hit_rate: toNum(row?.hit_rate, 0),
    recent_50_hit_rate: toNum(row?.recent_50_hit_rate, 0),
    recent_50_roi: toNum(row?.recent_50_roi, 0),
    strategy_weight: toNum(row?.weight, 0)
  };
}

function isHardQualified(row) {
  return (
    row.roi > HARD_RULES.roiMin &&
    row.avg_hit >= HARD_RULES.avgHitMin &&
    row.total_rounds >= HARD_RULES.totalRoundsMin &&
    row.score > HARD_RULES.scoreMin
  );
}

function isSoftQualified(row) {
  return (
    row.roi > SOFT_RULES.roiMin &&
    row.avg_hit >= SOFT_RULES.avgHitMin &&
    row.total_rounds >= SOFT_RULES.totalRoundsMin &&
    row.score > SOFT_RULES.scoreMin
  );
}

function rankStrategyRows(rows = []) {
  return [...rows].sort((a, b) => {
    if (b.roi !== a.roi) return b.roi - a.roi;
    if (b.avg_hit !== a.avg_hit) return b.avg_hit - a.avg_hit;
    if (b.score !== a.score) return b.score - a.score;
    if (b.total_rounds !== a.total_rounds) return b.total_rounds - a.total_rounds;
    if (b.recent_50_roi !== a.recent_50_roi) return b.recent_50_roi - a.recent_50_roi;
    if (b.recent_50_hit_rate !== a.recent_50_hit_rate) {
      return b.recent_50_hit_rate - a.recent_50_hit_rate;
    }
    return a.strategy_key.localeCompare(b.strategy_key);
  });
}

function buildFormalCandidates(statsRows = []) {
  const normalized = rankStrategyRows(
    (statsRows || [])
      .map(normalizeStrategyRow)
      .filter((row) => row.strategy_key)
  );

  const hardQualified = normalized.filter(isHardQualified);

  const softQualified = normalized.filter((row) => {
    if (hardQualified.some((x) => x.strategy_key === row.strategy_key)) return false;
    return isSoftQualified(row);
  });

  const strongQualified = normalized.filter((row) => {
    if (hardQualified.some((x) => x.strategy_key === row.strategy_key)) return false;
    if (softQualified.some((x) => x.strategy_key === row.strategy_key)) return false;

    return (
      row.recent_50_roi > 0 &&
      row.avg_hit >= 1.2 &&
      row.total_rounds >= 15 &&
      row.score > 0
    );
  });

  const usableQualified = normalized.filter((row) => {
    if (hardQualified.some((x) => x.strategy_key === row.strategy_key)) return false;
    if (softQualified.some((x) => x.strategy_key === row.strategy_key)) return false;
    if (strongQualified.some((x) => x.strategy_key === row.strategy_key)) return false;

    return (
      row.recent_50_roi >= 0 &&
      row.avg_hit >= 1.1 &&
      row.total_rounds >= 10
    );
  });

  const reserveQualified = normalized.filter((row) => {
    if (hardQualified.some((x) => x.strategy_key === row.strategy_key)) return false;
    if (softQualified.some((x) => x.strategy_key === row.strategy_key)) return false;
    if (strongQualified.some((x) => x.strategy_key === row.strategy_key)) return false;
    if (usableQualified.some((x) => x.strategy_key === row.strategy_key)) return false;

    return (
      row.recent_50_roi > -0.1 &&
      row.roi > -0.1 &&
      row.avg_hit >= 1.0 &&
      row.total_rounds >= 8
    );
  });

  const selected = [];
  const used = new Set();

  function pushRows(rows, filterPass) {
    for (const row of rows) {
      if (selected.length >= GROUP_COUNT) break;
      if (used.has(row.strategy_key)) continue;

      used.add(row.strategy_key);
      selected.push({
        ...row,
        filter_pass: filterPass
      });
    }
  }

  pushRows(hardQualified, 'hard');
  pushRows(softQualified, 'soft');
  pushRows(strongQualified, 'strong');
  pushRows(usableQualified, 'usable');
  pushRows(reserveQualified, 'reserve');

  if (selected.length < GROUP_COUNT) {
    for (const row of normalized) {
      if (selected.length >= GROUP_COUNT) break;
      if (used.has(row.strategy_key)) continue;

      used.add(row.strategy_key);
      selected.push({
        ...row,
        filter_pass: 'fallback'
      });
    }
  }

  return selected.slice(0, GROUP_COUNT);
}

function calcStrategyStrength(row = {}) {
  const scorePart = Math.max(0, toNum(row.score, 0));
  const roiPart = Math.max(0, toNum(row.roi, 0)) * 200;
  const avgHitPart = Math.max(0, toNum(row.avg_hit, 0) - 1) * 800;
  const recentRoiPart = Math.max(0, toNum(row.recent_50_roi, 0)) * 150;
  const roundsPart = Math.min(40, Math.max(0, toNum(row.total_rounds, 0))) * 5;

  return scorePart + roiPart + avgHitPart + recentRoiPart + roundsPart;
}

function buildBetWeightMeta(rows = []) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const strengths = normalizedRows.map((row) => calcStrategyStrength(row));
  const totalStrength = strengths.reduce((sum, n) => sum + n, 0);

  if (!normalizedRows.length) return [];

  if (totalStrength <= 0) {
    return normalizedRows.map((row, idx) => ({
      ...row,
      bet_weight: idx === 0 ? 2500 : 2500,
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

  const maxStrength = Math.max(...strengths, 0);

  return normalizedRows.map((row, idx) => {
    const strength = strengths[idx];
    const share = totalStrength > 0 ? strength / totalStrength : 0;
    let weight = 1;

    if (strength > 0) {
      if (strength === maxStrength && share >= 0.45) {
        weight = 3;
      } else if (share >= 0.25 && row.roi > 0 && row.avg_hit >= 1.3) {
        weight = 2;
      } else if (share >= 0.18 && row.score > 0 && row.avg_hit >= 1.15) {
        weight = 2;
      }
    }

    return {
      ...row,
      bet_weight: floorBasisPoints[idx],
      weight,
      bet_amount: BASE_BET_AMOUNT * weight,
      strength_score: strength,
      strength_share: share
    };
  });
}

function buildGroupsFromStats(statsRows = [], recentRows = [], sourceDrawNo) {
  const analysis = buildRecentAnalysis(recentRows);
  const selectedStats = buildFormalCandidates(statsRows);
  const selectedWithWeights = buildBetWeightMeta(selectedStats);

  const groups = selectedWithWeights.map((row, idx) => {
    const strategyKey = row.strategy_key;
    const strategyName = row.strategy_name || row.strategy_key;
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
      reason: `正式下注依權重模式建立（倍率 x${row.weight} / 單組 ${row.bet_amount} 元）`,
      meta: {
        strategy_key: strategyKey,
        strategy_name: strategyName,
        roi: row.roi,
        avg_hit: row.avg_hit,
        total_rounds: row.total_rounds,
        score: row.score,
        recent_50_roi: row.recent_50_roi,
        recent_50_hit_rate: row.recent_50_hit_rate,
        profit_mode: PROFIT_MODE_NAME,
        filter_pass: row.filter_pass,
        bet_weight: row.bet_weight,
        bet_amount: row.bet_amount,
        weight_multiplier: row.weight,
        strength_score: row.strength_score,
        strength_share: row.strength_share,
        strategy_weight: row.strategy_weight
      }
    };
  });

  if (
    groups.length === GROUP_COUNT &&
    groups.every((g) => Array.isArray(g.nums) && g.nums.length === 4)
  ) {
    return groups;
  }

  const pool = uniqueKeepOrder([
    ...(analysis.hottest || []).slice(0, 16),
    ...(analysis.gapNums || []).slice(0, 16),
    ...(analysis.coldest || []).slice(0, 16),
    ...(analysis.latestDraw || []).slice(0, 8)
  ]);

  const safePool = pool.length >= 16 ? pool : Array.from({ length: 20 }, (_, i) => i + 1);

  return Array.from({ length: GROUP_COUNT }, (_, idx) => ({
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
      weight_multiplier: 1,
      strength_score: 0,
      strength_share: 0.25
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
    .from('strategy_pool')
    .select('strategy_key')
    .eq('status', 'active');

  if (error) throw error;

  return new Set(
    (Array.isArray(data) ? data : [])
      .map((row) => String(row?.strategy_key || '').trim())
      .filter(Boolean)
  );
}

async function getTopStrategyStats(limit = 50) {
  const { data, error } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const activeKeys = await getActiveStrategyKeys();

  const normalized = (Array.isArray(data) ? data : [])
    .map(normalizeStrategyRow)
    .filter((row) => row.strategy_key)
    .filter((row) => activeKeys.size === 0 || activeKeys.has(row.strategy_key));

  return rankStrategyRows(normalized);
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

    const [latestDraw, recentRows, strategyStats] = await Promise.all([
      getLatestDraw(),
      getRecentDraws(RECENT_DRAW_LIMIT),
      getTopStrategyStats(50)
    ]);

    const sourceDrawNo = Number(latestDraw.draw_no || 0);
    if (!sourceDrawNo) {
      throw new Error('source draw not found');
    }

    const groups = buildGroupsFromStats(strategyStats, recentRows, sourceDrawNo);

    const payload = {
      id: Date.now(),
      mode: FORMAL_MODE,
      status: 'created',
      source_draw_no: sourceDrawNo,
      target_periods: FORMAL_TARGET_PERIODS,
      groups_json: groups,
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
