import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const MODE = 'test';
const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 2;
const COMPARE_BATCH_LIMIT = 50;
const MARKET_LOOKBACK_LIMIT = 120;
const COST_PER_GROUP_PER_PERIOD = 25;

const DEFAULT_STRATEGY_KEYS = [
  'hot_balanced',
  'balanced_zone',
  'mix_zone_3',
  'warm_gap',
  'mix_repeat',
  'zone_gap',
  'tail_repeat',
  'gap_mix',
  'chase_balanced_2',
  'odd_even_gap',
  'gap_cluster',
  'reverse_hot',
  'gap_chase',
  'gap_cluster_2',
  'tail_mix',
  'hot_zone',
  'warm_balanced',
  'repeat_guard',
  'zone_split',
  'pattern_mix'
];

let supabase = null;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE env');
  }

  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });
  }

  return supabase;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueSorted(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))]
    .filter((n) => n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseNums(value) {
  if (Array.isArray(value)) {
    return uniqueSorted(value);
  }

  if (typeof value === 'string') {
    return uniqueSorted(
      value
        .replace(/[{}[\]]/g, ' ')
        .split(/[,\s|/]+/)
        .map(Number)
    );
  }

  if (value && typeof value === 'object') {
    return parseNums(
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

function isDuplicateDrawModeError(error) {
  const msg = String(error?.message || '');
  const details = String(error?.details || '');
  const code = String(error?.code || '');

  return (
    code === '23505' ||
    msg.includes('unique_draw_mode') ||
    details.includes('unique_draw_mode') ||
    msg.includes('duplicate key value violates unique constraint')
  );
}

function tokenizeStrategyKey(strategyKey = '') {
  return String(strategyKey || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token));
}

function strategyLabel(strategyKey = '') {
  return String(strategyKey || '')
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function sum(arr = []) {
  return arr.reduce((acc, v) => acc + toNum(v, 0), 0);
}

function average(arr = []) {
  return arr.length ? sum(arr) / arr.length : 0;
}

function pickFromPool(pool = [], selectedSet = new Set(), seed = 0) {
  const candidates = uniqueSorted(pool).filter((n) => !selectedSet.has(n));
  if (!candidates.length) return null;

  const index = Math.abs(toNum(seed, 0)) % candidates.length;
  return candidates[index];
}

function fillToFour(base = [], fallbackPools = [], seed = 0) {
  const result = uniqueSorted(base).slice(0, 4);
  const selected = new Set(result);
  let cursor = 0;

  for (const pool of fallbackPools) {
    while (result.length < 4 && cursor < 200) {
      const value = pickFromPool(pool, selected, seed + cursor);
      cursor += 1;
      if (value == null) break;
      selected.add(value);
      result.push(value);
    }
    if (result.length >= 4) break;
  }

  if (result.length < 4) {
    const allNums = Array.from({ length: 80 }, (_, i) => i + 1);
    while (result.length < 4 && cursor < 400) {
      const value = pickFromPool(allNums, selected, seed + cursor);
      cursor += 1;
      if (value == null) break;
      selected.add(value);
      result.push(value);
    }
  }

  return uniqueSorted(result).slice(0, 4);
}

function buildMarketState(drawRows = []) {
  const rows = Array.isArray(drawRows) ? drawRows : [];
  const parsedRows = rows.map((row) => ({
    draw_no: toNum(row?.draw_no, 0),
    numbers: parseNums(
      row?.numbers ??
      row?.draw_numbers ??
      row?.result_numbers ??
      row?.open_numbers
    )
  }));

  const latest = parsedRows[0]?.numbers || [];
  const recent20 = parsedRows.slice(0, 20);
  const recent50 = parsedRows.slice(0, 50);

  const freq20 = new Map();
  const freq50 = new Map();
  const lastSeenIndex = new Map();
  const tailFreq20 = new Map();
  const zoneFreq20 = new Map();

  for (let i = 1; i <= 80; i++) {
    freq20.set(i, 0);
    freq50.set(i, 0);
  }

  recent20.forEach((row, idx) => {
    for (const n of row.numbers) {
      freq20.set(n, toNum(freq20.get(n), 0) + 1);
      if (!lastSeenIndex.has(n)) lastSeenIndex.set(n, idx);
      const tail = n % 10;
      tailFreq20.set(tail, toNum(tailFreq20.get(tail), 0) + 1);
      const zone = Math.floor((n - 1) / 20);
      zoneFreq20.set(zone, toNum(zoneFreq20.get(zone), 0) + 1);
    }
  });

  recent50.forEach((row) => {
    for (const n of row.numbers) {
      freq50.set(n, toNum(freq50.get(n), 0) + 1);
    }
  });

  const hot = [...freq20.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const cold = [...freq20.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  const warm = [...freq50.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const gap = Array.from({ length: 80 }, (_, idx) => idx + 1)
    .sort((a, b) => {
      const gapA = lastSeenIndex.has(a) ? lastSeenIndex.get(a) : 999;
      const gapB = lastSeenIndex.has(b) ? lastSeenIndex.get(b) : 999;
      return gapB - gapA || a - b;
    });

  const tailsHot = [...tailFreq20.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([tail]) => tail);

  const zoneOrder = [...zoneFreq20.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([zone]) => zone);

  const odd = Array.from({ length: 80 }, (_, i) => i + 1).filter((n) => n % 2 === 1);
  const even = Array.from({ length: 80 }, (_, i) => i + 1).filter((n) => n % 2 === 0);

  return {
    latest,
    hot,
    cold,
    warm,
    gap,
    odd,
    even,
    tailsHot,
    zoneOrder,
    recent20,
    recent50,
    allNums: Array.from({ length: 80 }, (_, i) => i + 1)
  };
}

function numbersByTail(tail, allNums = []) {
  return allNums.filter((n) => n % 10 === tail);
}

function numbersByZone(zoneIndex, allNums = []) {
  const start = zoneIndex * 20 + 1;
  const end = start + 19;
  return allNums.filter((n) => n >= start && n <= end);
}

function buildStrategyNums(strategyKey, market, seed = 0) {
  const tokens = tokenizeStrategyKey(strategyKey);
  const selected = [];

  const {
    latest,
    hot,
    cold,
    warm,
    gap,
    odd,
    even,
    tailsHot,
    zoneOrder,
    allNums
  } = market;

  const fallbackPools = [hot, warm, gap, cold, allNums];

  const has = (token) => tokens.includes(token);

  if (has('repeat')) {
    selected.push(...latest.slice(0, 2));
  }

  if (has('hot')) {
    selected.push(...hot.slice(0, 3));
  }

  if (has('cold')) {
    selected.push(...cold.slice(0, 3));
  }

  if (has('warm')) {
    selected.push(...warm.slice(2, 6));
  }

  if (has('gap') || has('jump') || has('chase')) {
    selected.push(...gap.slice(0, 4));
  }

  if (has('tail')) {
    const topTail = tailsHot[0] ?? 0;
    selected.push(...numbersByTail(topTail, allNums).slice(0, 2));
    const secondTail = tailsHot[1] ?? ((topTail + 5) % 10);
    selected.push(...numbersByTail(secondTail, allNums).slice(0, 1));
  }

  if (has('zone') || has('split')) {
    const z1 = zoneOrder[0] ?? 0;
    const z2 = zoneOrder[1] ?? 1;
    selected.push(...numbersByZone(z1, allNums).slice(0, 2));
    selected.push(...numbersByZone(z2, allNums).slice(0, 1));
  }

  if (has('balanced') || has('balance')) {
    selected.push(...odd.slice(0, 2));
    selected.push(...even.slice(0, 2));
  }

  if (has('cluster')) {
    const base = hot[0] ?? 10;
    selected.push(base);
    if (base + 1 <= 80) selected.push(base + 1);
    if (base + 2 <= 80) selected.push(base + 2);
  }

  if (has('mix') || has('pattern') || has('structure')) {
    selected.push(hot[0], warm[1], gap[1], cold[0]);
  }

  if (has('guard')) {
    selected.push(cold[0], gap[0]);
  }

  if (has('reverse')) {
    selected.push(...cold.slice(0, 2));
    selected.push(...gap.slice(0, 2));
  }

  let nums = fillToFour(selected, fallbackPools, seed);

  if (has('balanced') || has('balance')) {
    const oddNums = nums.filter((n) => n % 2 === 1);
    const evenNums = nums.filter((n) => n % 2 === 0);

    if (oddNums.length === 0 || evenNums.length === 0) {
      nums = fillToFour(
        [...odd.slice(0, 2), ...even.slice(0, 2), ...nums],
        fallbackPools,
        seed + 11
      );
    }
  }

  if (has('zone') || has('split')) {
    const zones = new Set(nums.map((n) => Math.floor((n - 1) / 20)));
    if (zones.size < 2) {
      const extraZone = zoneOrder[1] ?? 1;
      nums = fillToFour(
        [...nums, ...numbersByZone(extraZone, allNums).slice(0, 2)],
        fallbackPools,
        seed + 17
      );
    }
  }

  return uniqueSorted(nums).slice(0, 4);
}

function computeStrategyWeight(poolRow = {}, statRow = {}) {
  const score = toNum(statRow?.score, 0);
  const avgHit = toNum(statRow?.avg_hit, 0);
  const hitRate = toNum(statRow?.hit_rate, 0);
  const recent50HitRate = toNum(statRow?.recent_50_hit_rate, 0);
  const roi = toNum(statRow?.roi, 0);
  const recent50Roi = toNum(statRow?.recent_50_roi, 0);
  const totalRounds = toNum(statRow?.total_rounds, 0);
  const generation = Math.max(1, toNum(poolRow?.generation, 1));

  let weight = 10;
  weight += Math.max(0, score * 0.02);
  weight += avgHit * 15;
  weight += hitRate * 25;
  weight += recent50HitRate * 30;
  weight += roi * 8;
  weight += recent50Roi * 12;
  weight += Math.min(totalRounds, 200) * 0.05;
  weight += generation * 0.5;

  if (String(poolRow?.protected_rank) === 'true' || poolRow?.protected_rank === true) {
    weight += 10;
  }

  return Math.max(1, Math.round(weight));
}

function weightedPick(rows = [], usedKeys = new Set(), seed = 0) {
  const available = rows.filter((row) => !usedKeys.has(row.strategy_key));
  if (!available.length) return null;

  const totalWeight = available.reduce((acc, row) => acc + toNum(row.weight, 1), 0);
  if (totalWeight <= 0) return available[Math.abs(seed) % available.length];

  let cursor = Math.abs(seed) % totalWeight;

  for (const row of available) {
    cursor -= toNum(row.weight, 1);
    if (cursor < 0) return row;
  }

  return available[available.length - 1];
}

async function runSync() {
  return { ok: true };
}

async function runCatchup() {
  return { ok: true };
}

async function runCompare(db) {
  const { data: predictions, error: predError } = await db
    .from('bingo_predictions')
    .select('*')
    .eq('status', 'created')
    .order('created_at', { ascending: true })
    .limit(COMPARE_BATCH_LIMIT);

  if (predError) throw predError;

  if (!predictions || !predictions.length) {
    return { ok: true, processed: 0, waiting: 0 };
  }

  let processed = 0;
  let waiting = 0;

  for (const prediction of predictions) {
    const sourceDrawNo = toNum(prediction?.source_draw_no, 0);
    const targetPeriods = Math.max(1, toNum(prediction?.target_periods, TARGET_PERIODS));
    const groups = Array.isArray(prediction?.groups_json) ? prediction.groups_json : [];

    if (!sourceDrawNo || groups.length === 0) {
      waiting += 1;
      continue;
    }

    const { data: drawRows, error: drawError } = await db
      .from('bingo_draws')
      .select('*')
      .gt('draw_no', sourceDrawNo)
      .order('draw_no', { ascending: true })
      .limit(targetPeriods);

    if (drawError) throw drawError;

    if (!drawRows || drawRows.length < targetPeriods) {
      waiting += 1;
      continue;
    }

    const payload = buildComparePayload({
      groups,
      drawRows,
      costPerGroupPerPeriod: COST_PER_GROUP_PER_PERIOD
    });

    if (!payload || !payload.compareResult) {
      waiting += 1;
      continue;
    }

    const comparedAt = new Date().toISOString();

    const { error: updateError } = await db
      .from('bingo_predictions')
      .update({
        status: 'compared',
        compare_status: 'done',
        hit_count: toNum(payload.hitCount, 0),
        compared_at: comparedAt
      })
      .eq('id', prediction.id);

    if (updateError) throw updateError;

    await recordStrategyCompareResult(payload.compareResult);
    processed += 1;
  }

  return {
    ok: true,
    processed,
    waiting
  };
}

async function fetchMarketRows(db) {
  const { data, error } = await db
    .from('bingo_draws')
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(MARKET_LOOKBACK_LIMIT);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function fetchStrategyCandidates(db) {
  await ensureStrategyPoolStrategies({
    strategyKeys: DEFAULT_STRATEGY_KEYS,
    sourceType: 'seed',
    status: 'active'
  });

  const { data: poolRows, error: poolError } = await db
    .from('strategy_pool')
    .select('*')
    .in('status', ['active', 'paused'])
    .order('updated_at', { ascending: false });

  if (poolError) throw poolError;

  const strategyKeys = (poolRows || [])
    .map((row) => String(row?.strategy_key || '').trim().toLowerCase())
    .filter(Boolean);

  if (!strategyKeys.length) {
    throw new Error('No active strategy_pool rows');
  }

  const { data: statsRows, error: statsError } = await db
    .from('strategy_stats')
    .select('*')
    .in('strategy_key', strategyKeys);

  if (statsError) throw statsError;

  const statsMap = new Map((statsRows || []).map((row) => [row.strategy_key, row]));

  return (poolRows || []).map((row) => {
    const stat = statsMap.get(row.strategy_key) || {};
    return {
      ...row,
      stats: stat,
      weight: computeStrategyWeight(row, stat)
    };
  });
}

function buildPredictionGroups(candidates = [], market = {}, seed = Date.now()) {
  const used = new Set();
  const groups = [];

  for (let i = 0; i < BET_GROUP_COUNT; i += 1) {
    const picked = weightedPick(candidates, used, seed + i * 37);
    if (!picked) break;

    used.add(picked.strategy_key);

    const nums = buildStrategyNums(picked.strategy_key, market, seed + i * 101);

    groups.push({
      key: picked.strategy_key,
      label: picked.strategy_name || strategyLabel(picked.strategy_key),
      nums,
      meta: {
        strategy_key: picked.strategy_key,
        strategy_name: picked.strategy_name || strategyLabel(picked.strategy_key),
        score: toNum(picked?.stats?.score, 0),
        avg_hit: toNum(picked?.stats?.avg_hit, 0),
        roi: toNum(picked?.stats?.roi, 0),
        weight: toNum(picked?.weight, 1),
        generation: toNum(picked?.generation, 1),
        source_type: String(picked?.source_type || 'seed')
      }
    });
  }

  return groups;
}

export default async function handler(req, res) {
  try {
    const db = getSupabase();

    const compare = await runCompare(db);
    const catchup = await runCatchup(db);
    const sync = await runSync(db);

    const pipeline = {
      compare,
      catchup,
      sync
    };

    const { data: latestDrawRows, error: latestError } = await db
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(1);

    if (latestError) throw latestError;

    if (!latestDrawRows || !latestDrawRows.length) {
      return res.status(200).json({
        ok: true,
        pipeline,
        compared_count: toNum(compare?.processed, 0),
        created_count: 0,
        train: {
          ok: true,
          skipped: true,
          reason: 'No bingo_draws'
        }
      });
    }

    const latestDraw = latestDrawRows[0];
    const sourceDrawNo = String(latestDraw.draw_no);

    const { data: existingPrediction, error: existingError } = await db
      .from('bingo_predictions')
      .select('*')
      .eq('mode', MODE)
      .eq('source_draw_no', sourceDrawNo)
      .limit(1)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existingPrediction) {
      return res.status(200).json({
        ok: true,
        pipeline,
        compared_count: toNum(compare?.processed, 0),
        created_count: 0,
        active_created_prediction: existingPrediction,
        train: {
          ok: true,
          skipped: true,
          reason: 'Prediction already exists',
          existing: existingPrediction
        }
      });
    }

    const marketRows = await fetchMarketRows(db);
    const market = buildMarketState(marketRows);
    const strategyCandidates = await fetchStrategyCandidates(db);
    const groups = buildPredictionGroups(strategyCandidates, market, Date.now());

    if (!groups.length) {
      throw new Error('Failed to build prediction groups from strategy_pool');
    }

    const now = Date.now();
    const payload = {
      id: now,
      mode: MODE,
      status: 'created',
      source_draw_no: sourceDrawNo,
      target_periods: TARGET_PERIODS,
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const { data: inserted, error: insertError } = await db
      .from('bingo_predictions')
      .insert(payload)
      .select('*')
      .single();

    if (insertError) {
      if (isDuplicateDrawModeError(insertError)) {
        const { data: existingAfterDup } = await db
          .from('bingo_predictions')
          .select('*')
          .eq('mode', MODE)
          .eq('source_draw_no', sourceDrawNo)
          .limit(1)
          .maybeSingle();

        return res.status(200).json({
          ok: true,
          pipeline,
          compared_count: toNum(compare?.processed, 0),
          created_count: 0,
          active_created_prediction: existingAfterDup || null,
          train: {
            ok: true,
            skipped: true,
            reason: 'Duplicate prevented',
            existing: existingAfterDup || null
          }
        });
      }

      throw insertError;
    }

    return res.status(200).json({
      ok: true,
      pipeline,
      compared_count: toNum(compare?.processed, 0),
      created_count: 1,
      active_created_prediction: inserted,
      train: {
        ok: true,
        inserted
      }
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || 'auto-train failed'
    });
  }
}
