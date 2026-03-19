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

function normalizeFlatRows(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((row) => {
      const strategyKey =
        row?.strategy_key ||
        row?.strategyKey ||
        row?.meta?.strategy_key ||
        row?.key ||
        null;

      if (!strategyKey) return null;

      const hitCount = toNum(
        row?.hit_count ??
          row?.hitCount ??
          row?.total_hit_count ??
          row?.totalHits,
        0
      );

      const cost = toNum(row?.cost, COST_PER_GROUP_PER_PERIOD);
      const reward = toNum(row?.reward, 0);
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
        hit_count: hitCount,
        cost,
        reward,
        profit
      };
    })
    .filter(Boolean);
}

function normalizeLegacyCompareResult(compareResult) {
  if (!compareResult || typeof compareResult !== 'object') return [];

  const groups = Array.isArray(compareResult.groups) ? compareResult.groups : [];
  if (!groups.length) return [];

  return groups
    .map((g) => {
      const strategyKey =
        g?.meta?.strategy_key ||
        g?.strategy_key ||
        g?.strategyKey ||
        g?.key ||
        null;

      if (!strategyKey) return null;

      const hitCount = toNum(
        g?.hit_count ??
          g?.hitCount ??
          g?.total_hit_count ??
          g?.totalHits,
        0
      );

      const rounds = Array.isArray(g?.rounds) ? g.rounds : [];
      const cost = rounds.length > 0 ? rounds.length * COST_PER_GROUP_PER_PERIOD : COST_PER_GROUP_PER_PERIOD;
      const reward = toNum(
        g?.reward ??
          g?.total_reward ??
          g?.totalReward ??
          g?.prize,
        0
      );
      const profit = toNum(
        g?.profit ??
          g?.total_profit,
        reward - cost
      );

      return {
        strategy_key: String(strategyKey),
        strategy_label: g?.label || null,
        hit_count: hitCount,
        cost,
        reward,
        profit
      };
    })
    .filter(Boolean);
}

function normalizeInput(compareResultOrRows) {
  if (Array.isArray(compareResultOrRows)) {
    return normalizeFlatRows(compareResultOrRows);
  }

  return normalizeLegacyCompareResult(compareResultOrRows);
}

function aggregateByStrategy(rows = []) {
  const map = new Map();

  for (const row of rows) {
    const key = String(row.strategy_key || '').trim();
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        strategy_key: key,
        strategy_label: row.strategy_label || null,
        total_rounds: 0,
        total_hits: 0,
        hit0: 0,
        hit1: 0,
        hit2: 0,
        hit3: 0,
        hit4: 0,
        total_cost: 0,
        total_reward: 0,
        total_profit: 0,
        recent_hits_append: [],
        recent_profit_append: []
      });
    }

    const bucket = map.get(key);
    const hit = toNum(row.hit_count, 0);
    const cost = toNum(row.cost, COST_PER_GROUP_PER_PERIOD);
    const reward = toNum(row.reward, 0);
    const profit = toNum(row.profit, reward - cost);

    bucket.total_rounds += 1;
    bucket.total_hits += hit;
    bucket.total_cost += cost;
    bucket.total_reward += reward;
    bucket.total_profit += profit;
    bucket.recent_hits_append.push(hit);
    bucket.recent_profit_append.push(profit);

    if (hit <= 0) bucket.hit0 += 1;
    else if (hit === 1) bucket.hit1 += 1;
    else if (hit === 2) bucket.hit2 += 1;
    else if (hit === 3) bucket.hit3 += 1;
    else bucket.hit4 += 1;
  }

  return [...map.values()];
}

function buildInsertPayload(agg) {
  const nowIso = new Date().toISOString();
  const recentHits = keepLast(agg.recent_hits_append, 50);
  const recentProfit = keepLast(agg.recent_profit_append, 50);

  const recent50Hit =
    recentHits.length > 0
      ? round6(recentHits.reduce((sum, n) => sum + toNum(n, 0), 0) / recentHits.length)
      : 0;

  const totalCost = agg.total_cost;
  const totalReward = agg.total_reward;
  const totalProfit = agg.total_profit;
  const roi = totalCost > 0 ? round6((totalProfit / totalCost) * 100) : 0;

  const recentCost = recentHits.length * COST_PER_GROUP_PER_PERIOD;
  const recentProfitSum = recentProfit.reduce((sum, n) => sum + toNum(n, 0), 0);
  const recent50Roi = recentCost > 0 ? round6((recentProfitSum / recentCost) * 100) : 0;

  return {
    strategy_key: agg.strategy_key,
    total_rounds: agg.total_rounds,
    total_hits: agg.total_hits,
    hit0: agg.hit0,
    hit1: agg.hit1,
    hit2: agg.hit2,
    hit3: agg.hit3,
    hit4: agg.hit4,
    avg_hit: agg.total_rounds > 0 ? round6(agg.total_hits / agg.total_rounds) : 0,
    hit_rate: agg.total_rounds > 0 ? round6(agg.total_hits / (agg.total_rounds * 4)) : 0,
    total_cost: totalCost,
    total_reward: totalReward,
    total_profit: totalProfit,
    roi,
    recent_hits: recentHits,
    recent_profit: recentProfit,
    recent_50_roi: recent50Roi,
    strategy_label: agg.strategy_label,
    total_runs: agg.total_rounds,
    total_hit_col: agg.total_hits,
    win_count: agg.hit1 + agg.hit2 + agg.hit3 + agg.hit4,
    loss_count: agg.hit0,
    draw_count: agg.total_rounds,
    best_single_hit: Math.max(...recentHits, 0),
    last_result_count: recentHits.length ? recentHits[recentHits.length - 1] : 0,
    last_updated: nowIso,
    created_at: nowIso,
    updated_at: nowIso
  };
}

function buildUpdatePayload(existing, agg) {
  const nowIso = new Date().toISOString();

  const totalRounds = toNum(existing.total_rounds, 0) + agg.total_rounds;
  const totalHits = toNum(existing.total_hits, 0) + agg.total_hits;

  const hit0 = toNum(existing.hit0, 0) + agg.hit0;
  const hit1 = toNum(existing.hit1, 0) + agg.hit1;
  const hit2 = toNum(existing.hit2, 0) + agg.hit2;
  const hit3 = toNum(existing.hit3, 0) + agg.hit3;
  const hit4 = toNum(existing.hit4, 0) + agg.hit4;

  const totalCost = toNum(existing.total_cost, 0) + agg.total_cost;
  const totalReward = toNum(existing.total_reward, 0) + agg.total_reward;
  const totalProfit = toNum(existing.total_profit, 0) + agg.total_profit;
  const roi = totalCost > 0 ? round6((totalProfit / totalCost) * 100) : 0;

  const recentHits = keepLast(
    [...asArray(existing.recent_hits), ...agg.recent_hits_append],
    50
  );
  const recentProfit = keepLast(
    [...asArray(existing.recent_profit), ...agg.recent_profit_append],
    50
  );

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
    total_cost: totalCost,
    total_reward: totalReward,
    total_profit: totalProfit,
    roi,
    recent_hits: recentHits,
    recent_profit: recentProfit,
    recent_50_roi: recent50Roi,
    strategy_label: existing.strategy_label || agg.strategy_label || null,
    total_runs: totalRounds,
    total_hit_col: totalHits,
    win_count: hit1 + hit2 + hit3 + hit4,
    loss_count: hit0,
    draw_count: totalRounds,
    best_single_hit: Math.max(toNum(existing.best_single_hit, 0), ...recentHits, 0),
    last_result_count: recentHits.length ? recentHits[recentHits.length - 1] : 0,
    last_updated: nowIso,
    updated_at: nowIso
  };
}

export async function recordStrategyCompareResult(compareResultOrRows) {
  const normalizedRows = normalizeInput(compareResultOrRows);

  if (!normalizedRows.length) {
    return {
      ok: false,
      results: []
    };
  }

  const grouped = aggregateByStrategy(normalizedRows);
  const results = [];

  for (const agg of grouped) {
    const { data: existing, error: fetchError } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', agg.strategy_key)
      .maybeSingle();

    if (fetchError) {
      results.push({
        strategy_key: agg.strategy_key,
        action: 'fetch_error',
        error: fetchError.message
      });
      continue;
    }

    if (!existing) {
      const insertPayload = buildInsertPayload(agg);

      const { error: insertError } = await supabase
        .from('strategy_stats')
        .insert(insertPayload);

      results.push({
        strategy_key: agg.strategy_key,
        action: 'insert',
        error: insertError ? insertError.message : null
      });

      continue;
    }

    const updatePayload = buildUpdatePayload(existing, agg);

    const { error: updateError } = await supabase
      .from('strategy_stats')
      .update(updatePayload)
      .eq('strategy_key', agg.strategy_key);

    results.push({
      strategy_key: agg.strategy_key,
      action: 'update',
      error: updateError ? updateError.message : null
    });
  }

  return {
    ok: true,
    results
  };
}
