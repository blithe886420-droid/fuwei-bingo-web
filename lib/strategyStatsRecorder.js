import { createClient } from '@supabase/supabase-js';
import { ensureStrategyPoolStrategies } from './ensureStrategyPoolStrategies.js';

const RECENT_WINDOW = 50;

function getSupabase() {
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
    throw new Error('Missing Supabase env for strategyStatsRecorder');
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
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

function normalizeRecentArray(value) {
  if (Array.isArray(value)) {
    return value.map((x) => toNum(x, 0));
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((x) => toNum(x, 0)) : [];
    } catch {
      return [];
    }
  }

  return [];
}

function trimRecent(arr, size = RECENT_WINDOW) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(-size);
}

function getRecencyWeightedSum(values = []) {
  if (!values.length) return { weightedSum: 0, weightTotal: 0 };

  let weightedSum = 0;
  let weightTotal = 0;

  for (let i = 0; i < values.length; i += 1) {
    const weight = i + 1;
    weightedSum += toNum(values[i], 0) * weight;
    weightTotal += weight;
  }

  return { weightedSum, weightTotal };
}

/**
 * 近期命中率改成加權：
 * - 中2：1.0
 * - 中3：1.8
 * - 中4：3.0
 * 越近的局權重越高
 */
function calcRecent50HitRate(recentBestHits = []) {
  if (!recentBestHits.length) return 0;

  const normalized = recentBestHits.map((hit) => {
    const n = toNum(hit, 0);
    if (n >= 4) return 3.0;
    if (n === 3) return 1.8;
    if (n === 2) return 1.0;
    if (n === 1) return 0.25;
    return 0;
  });

  const { weightedSum, weightTotal } = getRecencyWeightedSum(normalized);
  if (weightTotal <= 0) return 0;

  return round2((weightedSum / (weightTotal * 3.0)) * 100);
}

/**
 * 近期 ROI 也改成加權，越近越重要
 */
function calcRecent50Roi(recentProfit = [], recentCost = 25) {
  if (!recentProfit.length) return 0;

  const { weightedSum, weightTotal } = getRecencyWeightedSum(recentProfit);
  const weightedCost = recentCost * weightTotal;

  if (weightedCost <= 0) return 0;
  return round2((weightedSum / weightedCost) * 100);
}

function getStrategyKeyFromResult(result) {
  return (
    result?.meta?.strategy_key ||
    result?.strategyKey ||
    result?.key ||
    result?.strategy ||
    ''
  );
}

function getCurrentHit(result) {
  return toNum(
    result?.hitCount ??
      result?.total_hit_count ??
      0,
    0
  );
}

function getCurrentBestSingleHit(result) {
  return toNum(
    result?.best_single_hit ??
      result?.bestSingleHit ??
      result?.hitCount ??
      result?.total_hit_count ??
      0,
    0
  );
}

function getCurrentCost(result) {
  return toNum(
    result?.totalCost ??
      result?.total_cost ??
      0,
    0
  );
}

function getCurrentReward(result) {
  return toNum(
    result?.totalReward ??
      result?.total_reward ??
      0,
    0
  );
}

function getCurrentProfit(result) {
  const explicit = result?.totalProfit ?? result?.total_profit;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    return toNum(explicit, 0);
  }

  const reward = getCurrentReward(result);
  const cost = getCurrentCost(result);
  return reward - cost;
}

function buildStatPatch({ existingRow, result, drawNo }) {
  const prev = existingRow || {};

  const previousRounds = toNum(prev.total_rounds, 0);
  const previousHits = toNum(prev.total_hits, 0);
  const previousCost = toNum(prev.total_cost, 0);
  const previousReward = toNum(prev.total_reward, 0);
  const previousProfit = toNum(prev.total_profit, 0);

  const currentHit = getCurrentHit(result);
  const currentBestSingleHit = getCurrentBestSingleHit(result);
  const currentCost = getCurrentCost(result);
  const currentReward = getCurrentReward(result);
  const currentProfit = getCurrentProfit(result);

  const nextRounds = previousRounds + 1;
  const nextHits = previousHits + currentHit;
  const nextCost = previousCost + currentCost;
  const nextReward = previousReward + currentReward;
  const nextProfit = previousProfit + currentProfit;

  const prevHit0 = toNum(prev.hit0, 0);
  const prevHit1 = toNum(prev.hit1, 0);
  const prevHit2 = toNum(prev.hit2, 0);
  const prevHit3 = toNum(prev.hit3, 0);
  const prevHit4 = toNum(prev.hit4, 0);

  let hit0 = prevHit0;
  let hit1 = prevHit1;
  let hit2 = prevHit2;
  let hit3 = prevHit3;
  let hit4 = prevHit4;

  if (currentBestSingleHit <= 0) hit0 += 1;
  else if (currentBestSingleHit === 1) hit1 += 1;
  else if (currentBestSingleHit === 2) hit2 += 1;
  else if (currentBestSingleHit === 3) hit3 += 1;
  else hit4 += 1;

  const recentHits = trimRecent([
    ...normalizeRecentArray(prev.recent_hits),
    currentHit
  ]);

  const recentProfit = trimRecent([
    ...normalizeRecentArray(prev.recent_profit),
    currentProfit
  ]);

  const recentBestHits = trimRecent([
    ...normalizeRecentArray(prev.recent_best_hits),
    currentBestSingleHit
  ]);

  const avgHit = nextRounds > 0 ? round2(nextHits / nextRounds) : 0;
  const hitRate = nextRounds > 0 ? round2(((hit2 + hit3 + hit4) / nextRounds) * 100) : 0;
  const roi = nextCost > 0 ? round2((nextProfit / nextCost) * 100) : 0;
  const recent50HitRate = calcRecent50HitRate(recentBestHits);
  const recent50Roi = calcRecent50Roi(recentProfit, currentCost > 0 ? currentCost : 25);

  return {
    strategy_key: getStrategyKeyFromResult(result),
    total_rounds: nextRounds,
    total_hits: nextHits,
    hit0,
    hit1,
    hit2,
    hit3,
    hit4,
    avg_hit: avgHit,
    hit_rate: hitRate,
    total_cost: round2(nextCost),
    total_reward: round2(nextReward),
    total_profit: round2(nextProfit),
    roi,
    recent_hits: recentHits,
    recent_profit: recentProfit,
    recent_best_hits: recentBestHits,
    recent_50_hit_rate: recent50HitRate,
    recent_50_roi: recent50Roi,
    last_result_draw_no: toNum(drawNo, 0),
    last_updated: new Date().toISOString()
  };
}

async function ensureStrategyStatsRow(supabase, strategyKey) {
  const { data, error } = await supabase
    .from('strategy_stats')
    .select('*')
    .eq('strategy_key', strategyKey)
    .maybeSingle();

  if (error) throw error;

  if (data) return data;

  const payload = {
    strategy_key: strategyKey,
    total_rounds: 0,
    total_hits: 0,
    hit0: 0,
    hit1: 0,
    hit2: 0,
    hit3: 0,
    hit4: 0,
    avg_hit: 0,
    hit_rate: 0,
    total_cost: 0,
    total_reward: 0,
    total_profit: 0,
    roi: 0,
    recent_hits: [],
    recent_profit: [],
    recent_best_hits: [],
    recent_50_hit_rate: 0,
    recent_50_roi: 0,
    last_result_draw_no: 0,
    last_updated: new Date().toISOString()
  };

  const { data: inserted, error: insertError } = await supabase
    .from('strategy_stats')
    .insert(payload)
    .select('*')
    .single();

  if (insertError) throw insertError;
  return inserted;
}

function extractCompareResults(compareResult) {
  if (Array.isArray(compareResult?.results)) return compareResult.results;
  if (Array.isArray(compareResult?.groups)) return compareResult.groups;
  return [];
}

export async function recordStrategyCompareResult({ drawNo, compareResult }) {
  const supabase = getSupabase();

  const results = extractCompareResults(compareResult);
  if (!results.length) {
    return {
      ok: true,
      updated_count: 0,
      updated: []
    };
  }

  let strategyPoolEnsureResult = null;

  try {
    strategyPoolEnsureResult = await ensureStrategyPoolStrategies({
      groups: results.map((result) => ({
        key: result.key,
        strategyKey: result.strategyKey,
        label: result.label,
        meta: {
          strategy_key:
            result?.meta?.strategy_key ||
            result?.strategyKey ||
            result?.key,
          strategy_name:
            result?.meta?.strategy_name ||
            result?.label ||
            result?.key,
          gene_a: result?.meta?.gene_a || '',
          gene_b: result?.meta?.gene_b || '',
          source_type: result?.meta?.source || result?.meta?.source_type || 'seed'
        }
      })),
      sourceType: 'seed',
      status: 'disabled'
    });
  } catch (poolErr) {
    throw new Error(`ensureStrategyPoolStrategies failed: ${poolErr.message}`);
  }

  const updated = [];

  for (const result of results) {
    const strategyKey = getStrategyKeyFromResult(result);
    if (!strategyKey) continue;

    const existingRow = await ensureStrategyStatsRow(supabase, strategyKey);
    const patch = buildStatPatch({
      existingRow,
      result,
      drawNo
    });

    const { error: updateError } = await supabase
      .from('strategy_stats')
      .update(patch)
      .eq('strategy_key', strategyKey);

    if (updateError) throw updateError;

    updated.push({
      strategy_key: strategyKey,
      total_rounds: patch.total_rounds,
      total_hits: patch.total_hits,
      avg_hit: patch.avg_hit,
      total_cost: patch.total_cost,
      total_reward: patch.total_reward,
      total_profit: patch.total_profit,
      roi: patch.roi,
      recent_50_hit_rate: patch.recent_50_hit_rate,
      recent_50_roi: patch.recent_50_roi,
      hit0: patch.hit0,
      hit1: patch.hit1,
      hit2: patch.hit2,
      hit3: patch.hit3,
      hit4: patch.hit4,
      last_result_draw_no: patch.last_result_draw_no
    });
  }

  return {
    ok: true,
    strategy_pool_ensure_result: strategyPoolEnsureResult,
    updated_count: updated.length,
    updated
  };
}
