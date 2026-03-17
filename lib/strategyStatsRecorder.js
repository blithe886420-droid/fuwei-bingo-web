import { createClient } from '@supabase/supabase-js';
import { ensureStrategyPoolStrategies } from './ensureStrategyPoolStrategies.js';

const RECENT_WINDOW = 50;
const MARKET_BUCKET_RECENT_WINDOW = 30;
const MAX_MARKET_BUCKETS = 60;

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

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
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

/* =========================
 * market bucket 相關邏輯
 * 先存進 strategy_pool.parameters
 * 不動 strategy_stats schema
 * ========================= */

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeMarketSummary(summary = {}) {
  const s = safeObject(summary);

  return {
    sum: toInt(s.sum, 0),
    span: toInt(s.span, 0),
    sum_tail: toInt(s.sum_tail, 0),
    odd_even_bias: String(s.odd_even_bias || 'balanced'),
    big_small_bias: String(s.big_small_bias || 'balanced'),
    hot_zone: toInt(s.hot_zone, 0),
    compactness: String(s.compactness || 'normal'),
    sum_band: String(s.sum_band || 'mid'),
    zone_counts: Array.isArray(s.zone_counts)
      ? s.zone_counts.map((x) => toInt(x, 0)).slice(0, 4)
      : [0, 0, 0, 0]
  };
}

function pickMarketSummary(input = {}) {
  const root = safeObject(input);

  if (root?.latest?.summary) {
    return normalizeMarketSummary(root.latest.summary);
  }

  if (root?.summary) {
    return normalizeMarketSummary(root.summary);
  }

  if (root?.market_snapshot?.latest?.summary) {
    return normalizeMarketSummary(root.market_snapshot.latest.summary);
  }

  if (root?.market_signal?.summary) {
    return normalizeMarketSummary(root.market_signal.summary);
  }

  if (root?.marketSignal?.summary) {
    return normalizeMarketSummary(root.marketSignal.summary);
  }

  if (root?.meta?.market_summary) {
    return normalizeMarketSummary(root.meta.market_summary);
  }

  return null;
}

function buildMarketBucketKey(summary) {
  if (!summary) return 'unknown';

  return [
    `sumBand:${summary.sum_band || 'mid'}`,
    `compact:${summary.compactness || 'normal'}`,
    `oddEven:${summary.odd_even_bias || 'balanced'}`,
    `bigSmall:${summary.big_small_bias || 'balanced'}`,
    `zone:${toInt(summary.hot_zone, 0)}`
  ].join('|');
}

function trimBucketObjectBuckets(buckets = {}) {
  const entries = Object.entries(safeObject(buckets));

  if (entries.length <= MAX_MARKET_BUCKETS) {
    return safeObject(buckets);
  }

  const sorted = entries.sort((a, b) => {
    const aTime = Date.parse(a?.[1]?.last_updated || 0) || 0;
    const bTime = Date.parse(b?.[1]?.last_updated || 0) || 0;
    return bTime - aTime;
  });

  return Object.fromEntries(sorted.slice(0, MAX_MARKET_BUCKETS));
}

function buildMarketBucketPatch({
  existingParameters,
  marketSummary,
  result,
  drawNo
}) {
  const parameters = safeObject(existingParameters);
  const existingMarketStats = safeObject(parameters.market_stats);
  const existingBuckets = safeObject(existingMarketStats.buckets);

  const bucketKey = buildMarketBucketKey(marketSummary);
  const existingBucket = safeObject(existingBuckets[bucketKey]);

  const currentHit = getCurrentHit(result);
  const currentBestSingleHit = getCurrentBestSingleHit(result);
  const currentCost = getCurrentCost(result);
  const currentReward = getCurrentReward(result);
  const currentProfit = getCurrentProfit(result);

  const previousRounds = toNum(existingBucket.total_rounds, 0);
  const previousHits = toNum(existingBucket.total_hits, 0);
  const previousCost = toNum(existingBucket.total_cost, 0);
  const previousReward = toNum(existingBucket.total_reward, 0);
  const previousProfit = toNum(existingBucket.total_profit, 0);

  const nextRounds = previousRounds + 1;
  const nextHits = previousHits + currentHit;
  const nextCost = previousCost + currentCost;
  const nextReward = previousReward + currentReward;
  const nextProfit = previousProfit + currentProfit;

  let hit0 = toNum(existingBucket.hit0, 0);
  let hit1 = toNum(existingBucket.hit1, 0);
  let hit2 = toNum(existingBucket.hit2, 0);
  let hit3 = toNum(existingBucket.hit3, 0);
  let hit4 = toNum(existingBucket.hit4, 0);

  if (currentBestSingleHit <= 0) hit0 += 1;
  else if (currentBestSingleHit === 1) hit1 += 1;
  else if (currentBestSingleHit === 2) hit2 += 1;
  else if (currentBestSingleHit === 3) hit3 += 1;
  else hit4 += 1;

  const recentProfit = trimRecent(
    [...normalizeRecentArray(existingBucket.recent_profit), currentProfit],
    MARKET_BUCKET_RECENT_WINDOW
  );

  const recentBestHits = trimRecent(
    [...normalizeRecentArray(existingBucket.recent_best_hits), currentBestSingleHit],
    MARKET_BUCKET_RECENT_WINDOW
  );

  const avgHit = nextRounds > 0 ? round2(nextHits / nextRounds) : 0;
  const roi = nextCost > 0 ? round2((nextProfit / nextCost) * 100) : 0;
  const recentRoi = calcRecent50Roi(recentProfit, currentCost > 0 ? currentCost : 25);
  const recentHitRate = calcRecent50HitRate(recentBestHits);

  const nextBucket = {
    market_key: bucketKey,
    total_rounds: nextRounds,
    total_hits: nextHits,
    total_cost: round2(nextCost),
    total_reward: round2(nextReward),
    total_profit: round2(nextProfit),
    avg_hit: avgHit,
    roi,
    hit0,
    hit1,
    hit2,
    hit3,
    hit4,
    recent_profit: recentProfit,
    recent_best_hits: recentBestHits,
    recent_50_hit_rate: recentHitRate,
    recent_50_roi: recentRoi,
    last_result_draw_no: toNum(drawNo, 0),
    last_updated: new Date().toISOString(),
    sample_market: marketSummary
  };

  const nextBuckets = trimBucketObjectBuckets({
    ...existingBuckets,
    [bucketKey]: nextBucket
  });

  return {
    ...parameters,
    market_stats: {
      profile_version: 1,
      last_market_key: bucketKey,
      last_market_summary: marketSummary,
      updated_at: new Date().toISOString(),
      buckets: nextBuckets
    }
  };
}

async function getStrategyPoolRow(supabase, strategyKey) {
  const { data, error } = await supabase
    .from('strategy_pool')
    .select('*')
    .eq('strategy_key', strategyKey)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function updateStrategyPoolMarketParameters({
  supabase,
  strategyKey,
  marketSummary,
  result,
  drawNo
}) {
  if (!strategyKey || !marketSummary) {
    return {
      ok: true,
      skipped: true,
      strategy_key: strategyKey || '',
      reason: 'missing_strategy_key_or_market_summary'
    };
  }

  const poolRow = await getStrategyPoolRow(supabase, strategyKey);
  if (!poolRow) {
    return {
      ok: true,
      skipped: true,
      strategy_key: strategyKey,
      reason: 'strategy_pool_row_not_found'
    };
  }

  const nextParameters = buildMarketBucketPatch({
    existingParameters: poolRow.parameters,
    marketSummary,
    result,
    drawNo
  });

  const { error } = await supabase
    .from('strategy_pool')
    .update({
      parameters: nextParameters,
      updated_at: new Date().toISOString()
    })
    .eq('strategy_key', strategyKey);

  if (error) throw error;

  return {
    ok: true,
    skipped: false,
    strategy_key: strategyKey,
    market_key: buildMarketBucketKey(marketSummary)
  };
}

export async function recordStrategyCompareResult({
  drawNo,
  compareResult,
  marketSnapshot = null,
  marketSignal = null
}) {
  const supabase = getSupabase();

  const results = extractCompareResults(compareResult);
  if (!results.length) {
    return {
      ok: true,
      updated_count: 0,
      updated: [],
      market_summary_used: null
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

  const marketSummary =
    pickMarketSummary(marketSnapshot) ||
    pickMarketSummary(compareResult) ||
    pickMarketSummary(marketSignal);

  const updated = [];
  const marketBucketUpdates = [];

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

    let marketBucketResult = {
      ok: true,
      skipped: true,
      strategy_key: strategyKey,
      reason: 'market_summary_unavailable'
    };

    if (marketSummary) {
      marketBucketResult = await updateStrategyPoolMarketParameters({
        supabase,
        strategyKey,
        marketSummary,
        result,
        drawNo
      });
    }

    marketBucketUpdates.push(marketBucketResult);

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
      last_result_draw_no: patch.last_result_draw_no,
      market_key: marketBucketResult?.market_key || null
    });
  }

  return {
    ok: true,
    strategy_pool_ensure_result: strategyPoolEnsureResult,
    updated_count: updated.length,
    updated,
    market_summary_used: marketSummary || null,
    market_bucket_updates: marketBucketUpdates
  };
}
