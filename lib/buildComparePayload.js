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
  throw new Error('Missing SUPABASE env for strategyStatsRecorder');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const COST_PER_GROUP_PER_PERIOD = 25;

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round6(value) {
  const n = toNum(value, 0);
  return Math.round(n * 1000000) / 1000000;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function keepLast(list = [], size = 50) {
  return asArray(list).slice(-size);
}

function rewardByHitCount(hitCount) {
  const hit = toNum(hitCount, 0);
  if (hit >= 4) return 1000;
  if (hit === 3) return 100;
  if (hit === 2) return 25;
  return 0;
}

function normalizeFromFlatRows(rows) {
  return asArray(rows)
    .map((row) => {
      const strategyKey =
        row?.strategy_key ||
        row?.strategyKey ||
        row?.meta?.strategy_key ||
        row?.meta?.strategyKey ||
        row?.key ||
        null;

      if (!strategyKey) return null;

      const hitCount = toNum(
        row?.hit_count ??
          row?.hitCount ??
          row?.total_hit_count ??
          row?.totalHits ??
          row?.hits,
        0
      );

      const cost = toNum(row?.cost, COST_PER_GROUP_PER_PERIOD);
      const reward = toNum(row?.reward, rewardByHitCount(hitCount));
      const profit = toNum(row?.profit, reward - cost);

      const strategyLabel =
        row?.strategy_label ||
        row?.strategyLabel ||
        row?.label ||
        row?.name ||
        null;

      return {
        strategy_key: String(strategyKey),
        strategy_label: strategyLabel ? String(strategyLabel) : null,
        rounds: 1,
        total_hits: hitCount,
        hit0: hitCount === 0 ? 1 : 0,
        hit1: hitCount === 1 ? 1 : 0,
        hit2: hitCount === 2 ? 1 : 0,
        hit3: hitCount === 3 ? 1 : 0,
        hit4: hitCount >= 4 ? 1 : 0,
        total_cost: cost,
        total_reward: reward,
        total_profit: profit,
        recent_hits: [hitCount],
        recent_profit: [profit],
        best_single_hit: hitCount
      };
    })
    .filter(Boolean);
}

function normalizeFromCompareResult(compareResult) {
  if (!compareResult || typeof compareResult !== 'object') return [];

  const groups = asArray(compareResult.groups);

  return groups
    .map((group) => {
      const strategyKey =
        group?.meta?.strategy_key ||
        group?.meta?.strategyKey ||
        group?.strategy_key ||
        group?.strategyKey ||
        group?.key ||
        null;

      if (!strategyKey) return null;

      const strategyLabel =
        group?.strategy_label ||
        group?.strategyLabel ||
        group?.label ||
        group?.name ||
        null;

      const rounds = asArray(group?.rounds);
      const roundHits = rounds.map((r) => toNum(r?.hit_count, 0));
      const roundProfits = rounds.map((r) => toNum(r?.profit, 0));

      const totalRounds = Math.max(1, rounds.length || 0);
      const totalHits = toNum(
        group?.total_hit_count ?? group?.hit_count,
        roundHits.reduce((sum, n) => sum + n, 0)
      );

      const totalCost = toNum(
        group?.total_cost,
        rounds.length > 0
          ? rounds.reduce((sum, r) => sum + toNum(r?.cost, COST_PER_GROUP_PER_PERIOD), 0)
          : COST_PER_GROUP_PER_PERIOD
      );

      const totalReward = toNum(
        group?.total_reward,
        rounds.length > 0
          ? rounds.reduce((sum, r) => sum + toNum(r?.reward, rewardByHitCount(r?.hit_count)), 0)
          : rewardByHitCount(totalHits)
      );

      const totalProfit = toNum(
        group?.total_profit,
        totalReward - totalCost
      );

      const hit0 = toNum(
        group?.hit0_count,
        roundHits.filter((n) => n === 0).length
      );
      const hit1 = toNum(
        group?.hit1_count,
        roundHits.filter((n) => n === 1).length
      );
      const hit2 = toNum(
        group?.hit2_count,
        roundHits.filter((n) => n === 2).length
      );
      const hit3 = toNum(
        group?.hit3_count,
        roundHits.filter((n) => n === 3).length
      );
      const hit4 = toNum(
        group?.hit4_count,
        roundHits.filter((n) => n >= 4).length
      );

      const bestSingleHit = toNum(
        group?.best_single_hit,
        roundHits.length ? Math.max(...roundHits) : 0
      );

      return {
        strategy_key: String(strategyKey),
        strategy_label: strategyLabel ? String(strategyLabel) : null,
        rounds: totalRounds,
        total_hits: totalHits,
        hit0,
        hit1,
        hit2,
        hit3,
        hit4,
        total_cost: totalCost,
        total_reward: totalReward,
        total_profit: totalProfit,
        recent_hits: roundHits,
        recent_profit: roundProfits,
        best_single_hit: bestSingleHit
      };
    })
    .filter(Boolean);
}

function normalizeInput(input) {
  if (Array.isArray(input)) {
    return normalizeFromFlatRows(input);
  }

  if (input && typeof input === 'object') {
    return normalizeFromCompareResult(input);
  }

  return [];
}

function mergeByStrategy(items = []) {
  const map = new Map();

  for (const item of items) {
    const key = String(item.strategy_key || '').trim();
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        strategy_key: key,
        strategy_label: item.strategy_label || null,
        rounds: 0,
        total_hits: 0,
        hit0: 0,
        hit1: 0,
        hit2: 0,
        hit3: 0,
        hit4: 0,
        total_cost: 0,
        total_reward: 0,
        total_profit: 0,
        recent_hits: [],
        recent_profit: [],
        best_single_hit: 0
      });
    }

    const bucket = map.get(key);
    bucket.rounds += toNum(item.rounds, 0);
    bucket.total_hits += toNum(item.total_hits, 0);
    bucket.hit0 += toNum(item.hit0, 0);
    bucket.hit1 += toNum(item.hit1, 0);
    bucket.hit2 += toNum(item.hit2, 0);
    bucket.hit3 += toNum(item.hit3, 0);
    bucket.hit4 += toNum(item.hit4, 0);
    bucket.total_cost += toNum(item.total_cost, 0);
    bucket.total_reward += toNum(item.total_reward, 0);
    bucket.total_profit += toNum(item.total_profit, 0);
    bucket.recent_hits.push(...asArray(item.recent_hits));
    bucket.recent_profit.push(...asArray(item.recent_profit));
    bucket.best_single_hit = Math.max(
      bucket.best_single_hit,
      toNum(item.best_single_hit, 0)
    );

    if (!bucket.strategy_label && item.strategy_label) {
      bucket.strategy_label = item.strategy_label;
    }
  }

  return [...map.values()].map((item) => ({
    ...item,
    recent_hits: keepLast(item.recent_hits, 50),
    recent_profit: keepLast(item.recent_profit, 50)
  }));
}

function buildInsertPayload(item) {
  const nowIso = new Date().toISOString();
  const recent50HitRate =
    item.recent_hits.length > 0
      ? round6(item.recent_hits.reduce((sum, n) => sum + toNum(n, 0), 0) / (item.recent_hits.length * 4))
      : 0;

  const recent50Cost = item.recent_hits.length * COST_PER_GROUP_PER_PERIOD;
  const recent50Profit = item.recent_profit.reduce((sum, n) => sum + toNum(n, 0), 0);
  const recent50Roi = recent50Cost > 0 ? round6((recent50Profit / recent50Cost) * 100) : 0;

  const roi = item.total_cost > 0 ? round6((item.total_profit / item.total_cost) * 100) : 0;

  return {
    strategy_key: item.strategy_key,
    total_rounds: item.rounds,
    total_hits: item.total_hits,
    hit0: item.hit0,
    hit1: item.hit1,
    hit2: item.hit2,
    hit3: item.hit3,
    hit4: item.hit4,
    avg_hit: item.rounds > 0 ? round6(item.total_hits / item.rounds) : 0,
    hit_rate: item.rounds > 0 ? round6(item.total_hits / (item.rounds * 4)) : 0,
    total_profit: item.total_profit,
    roi,
    recent_hits: item.recent_hits,
    recent_profit: item.recent_profit,
    recent_50_hit_rate: recent50HitRate,
    recent_50_roi: recent50Roi,
    strategy_label: item.strategy_label,
    total_runs: item.rounds,
    total_hit_col: item.total_hits,
    win_count: item.hit1 + item.hit2 + item.hit3 + item.hit4,
    loss_count: item.hit0,
    draw_count: item.rounds,
    best_single_hit: item.best_single_hit,
    last_result_count: item.recent_hits.length ? item.recent_hits[item.recent_hits.length - 1] : 0,
    last_updated: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
    total_cost: item.total_cost,
    total_reward: item.total_reward
  };
}

function buildUpdatePayload(existing, item) {
  const nowIso = new Date().toISOString();

  const totalRounds = toNum(existing.total_rounds, 0) + item.rounds;
  const totalHits = toNum(existing.total_hits, 0) + item.total_hits;

  const hit0 = toNum(existing.hit0, 0) + item.hit0;
  const hit1 = toNum(existing.hit1, 0) + item.hit1;
  const hit2 = toNum(existing.hit2, 0) + item.hit2;
  const hit3 = toNum(existing.hit3, 0) + item.hit3;
  const hit4 = toNum(existing.hit4, 0) + item.hit4;

  const totalCost = toNum(existing.total_cost, 0) + item.total_cost;
  const totalReward = toNum(existing.total_reward, 0) + item.total_reward;
  const totalProfit = toNum(existing.total_profit, 0) + item.total_profit;
  const roi = totalCost > 0 ? round6((totalProfit / totalCost) * 100) : 0;

  const recentHits = keepLast(
    [...asArray(existing.recent_hits), ...item.recent_hits],
    50
  );
  const recentProfit = keepLast(
    [...asArray(existing.recent_profit), ...item.recent_profit],
    50
  );

  const recent50HitRate =
    recentHits.length > 0
      ? round6(recentHits.reduce((sum, n) => sum + toNum(n, 0), 0) / (recentHits.length * 4))
      : 0;

  const recent50Cost = recentHits.length * COST_PER_GROUP_PER_PERIOD;
  const recent50Profit = recentProfit.reduce((sum, n) => sum + toNum(n, 0), 0);
  const recent50Roi = recent50Cost > 0 ? round6((recent50Profit / recent50Cost) * 100) : 0;

  return {
    total_rounds: totalRounds,
    total_hits: totalHits,
    hit0,
    hit1,
    hit2,
    hit3,
    hit4,
    avg_hit: totalRounds > 0 ? round6(totalHits / totalRounds) : 0,
    hit_rate: totalRounds > 0 ? round6(totalHits / (totalRounds * 4)) : 0,
    total_profit: totalProfit,
    roi,
    recent_hits: recentHits,
    recent_profit: recentProfit,
    recent_50_hit_rate: recent50HitRate,
    recent_50_roi: recent50Roi,
    strategy_label: existing.strategy_label || item.strategy_label || null,
    total_runs: totalRounds,
    total_hit_col: totalHits,
    win_count: hit1 + hit2 + hit3 + hit4,
    loss_count: hit0,
    draw_count: totalRounds,
    best_single_hit: Math.max(toNum(existing.best_single_hit, 0), item.best_single_hit),
    last_result_count: recentHits.length ? recentHits[recentHits.length - 1] : 0,
    last_updated: nowIso,
    updated_at: nowIso,
    total_cost: totalCost,
    total_reward: totalReward
  };
}

export async function recordStrategyCompareResult(compareResultOrRows) {
  const normalizedItems = normalizeInput(compareResultOrRows);

  if (!normalizedItems.length) {
    return {
      ok: false,
      results: []
    };
  }

  const groupedItems = mergeByStrategy(normalizedItems);
  const results = [];

  for (const item of groupedItems) {
    const { data: existing, error: fetchError } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', item.strategy_key)
      .maybeSingle();

    if (fetchError) {
      results.push({
        strategy_key: item.strategy_key,
        action: 'fetch_error',
        error: fetchError.message
      });
      continue;
    }

    if (!existing) {
      const insertPayload = buildInsertPayload(item);

      const { error: insertError } = await supabase
        .from('strategy_stats')
        .insert(insertPayload);

      results.push({
        strategy_key: item.strategy_key,
        action: 'insert',
        error: insertError ? insertError.message : null
      });
      continue;
    }

    const updatePayload = buildUpdatePayload(existing, item);

    const { error: updateError } = await supabase
      .from('strategy_stats')
      .update(updatePayload)
      .eq('strategy_key', item.strategy_key);

    results.push({
      strategy_key: item.strategy_key,
      action: 'update',
      error: updateError ? updateError.message : null
    });
  }

  return {
    ok: true,
    results
  };
}
