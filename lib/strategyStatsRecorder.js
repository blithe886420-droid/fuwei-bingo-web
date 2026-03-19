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

function limitRecent(list = [], size = 50) {
  return asArray(list).slice(-size);
}

function safeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

async function getStrategyStatsColumns() {
  const { data, error } = await supabase
    .from('information_schema.columns')
    .select('column_name')
    .eq('table_schema', 'public')
    .eq('table_name', 'strategy_stats');

  if (error) {
    throw error;
  }

  return new Set((data || []).map((row) => row.column_name));
}

function normalizeFlatRows(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((row) => {
      const strategyKey =
        row?.strategy_key ||
        row?.strategyKey ||
        row?.key ||
        row?.meta?.strategy_key ||
        null;

      if (!strategyKey) return null;

      const hitCount = toNum(
        row?.hit_count ??
          row?.hitCount ??
          row?.total_hit_count ??
          row?.totalHits,
        0
      );

      const cost = toNum(row?.cost, 25);
      const reward = toNum(row?.reward, 0);
      const profit = toNum(
        row?.profit ?? row?.total_profit,
        reward - cost
      );

      const drawNo = toNum(row?.draw_no ?? row?.drawNo, 0);
      const strategyLabel =
        row?.strategy_label ||
        row?.strategyLabel ||
        row?.label ||
        row?.name ||
        null;

      return {
        strategy_key: String(strategyKey),
        strategy_label: strategyLabel ? String(strategyLabel) : null,
        draw_no: drawNo,
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

      const rounds = Array.isArray(g?.rounds) ? g.rounds : [];
      const hitCount = toNum(g?.total_hit_count ?? g?.hit_count ?? g?.hitCount, 0);
      const totalProfit = toNum(g?.total_profit ?? g?.profit, 0);
      const totalCost = rounds.length > 0 ? rounds.length * 25 : 25;
      const totalReward = totalProfit + totalCost;

      return {
        strategy_key: String(strategyKey),
        strategy_label: g?.label || null,
        draw_no: 0,
        hit_count: hitCount,
        cost: totalCost,
        reward: totalReward,
        profit: totalProfit
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
        rows: [],
        total_rounds: 0,
        total_hits: 0,
        hit0: 0,
        hit1: 0,
        hit2: 0,
        hit3: 0,
        hit4: 0,
        total_cost: 0,
        total_reward: 0,
        total_profit: 0
      });
    }

    const bucket = map.get(key);
    bucket.rows.push(row);
    bucket.total_rounds += 1;
    bucket.total_hits += toNum(row.hit_count, 0);
    bucket.total_cost += toNum(row.cost, 0);
    bucket.total_reward += toNum(row.reward, 0);
    bucket.total_profit += toNum(row.profit, 0);

    const hit = toNum(row.hit_count, 0);
    if (hit <= 0) bucket.hit0 += 1;
    else if (hit === 1) bucket.hit1 += 1;
    else if (hit === 2) bucket.hit2 += 1;
    else if (hit === 3) bucket.hit3 += 1;
    else bucket.hit4 += 1;
  }

  return [...map.values()];
}

function buildInsertPayload(columns, agg) {
  const payload = {};
  const nowIso = new Date().toISOString();

  if (columns.has('strategy_key')) payload.strategy_key = agg.strategy_key;
  if (columns.has('strategy_label')) payload.strategy_label = agg.strategy_label;
  if (columns.has('total_rounds')) payload.total_rounds = agg.total_rounds;
  if (columns.has('total_runs')) payload.total_runs = agg.total_rounds;
  if (columns.has('draw_count')) payload.draw_count = agg.total_rounds;

  if (columns.has('total_hits')) payload.total_hits = agg.total_hits;
  if (columns.has('total_hit_count')) payload.total_hit_count = agg.total_hits;
  if (columns.has('total_hit_col')) payload.total_hit_col = agg.total_hits;

  if (columns.has('hit0')) payload.hit0 = agg.hit0;
  if (columns.has('hit1')) payload.hit1 = agg.hit1;
  if (columns.has('hit2')) payload.hit2 = agg.hit2;
  if (columns.has('hit3')) payload.hit3 = agg.hit3;
  if (columns.has('hit4')) payload.hit4 = agg.hit4;

  if (columns.has('win_count')) payload.win_count = agg.hit1 + agg.hit2 + agg.hit3 + agg.hit4;
  if (columns.has('loss_count')) payload.loss_count = agg.hit0;

  if (columns.has('avg_hit')) {
    payload.avg_hit = agg.total_rounds > 0 ? round6(agg.total_hits / agg.total_rounds) : 0;
  }

  if (columns.has('hit_rate')) {
    payload.hit_rate =
      agg.total_rounds > 0 ? round6(agg.total_hits / (agg.total_rounds * 4)) : 0;
  }

  if (columns.has('total_cost')) payload.total_cost = agg.total_cost;
  if (columns.has('total_reward')) payload.total_reward = agg.total_reward;
  if (columns.has('total_profit')) payload.total_profit = agg.total_profit;

  if (columns.has('roi')) {
    payload.roi = agg.total_cost > 0 ? round6(agg.total_profit / agg.total_cost) : 0;
  }

  const recentHits = agg.rows.map((r) => toNum(r.hit_count, 0));
  const recentProfit = agg.rows.map((r) => toNum(r.profit, 0));
  const recentCost = agg.rows.map((r) => toNum(r.cost, 0));

  if (columns.has('recent_hits')) payload.recent_hits = limitRecent(recentHits, 50);
  if (columns.has('recent_profit')) payload.recent_profit = limitRecent(recentProfit, 50);
  if (columns.has('recent_cost')) payload.recent_cost = limitRecent(recentCost, 50);

  if (columns.has('recent_50_hit')) {
    const hits = limitRecent(recentHits, 50);
    payload.recent_50_hit =
      hits.length > 0 ? round6(hits.reduce((a, b) => a + b, 0) / hits.length) : 0;
  }

  if (columns.has('recent_50_roi')) {
    const profits = limitRecent(recentProfit, 50);
    const costs = limitRecent(recentCost, 50);
    const p = profits.reduce((a, b) => a + b, 0);
    const c = costs.reduce((a, b) => a + b, 0);
    payload.recent_50_roi = c > 0 ? round6(p / c) : 0;
  }

  if (columns.has('best_single_hit')) {
    payload.best_single_hit = Math.max(...recentHits, 0);
  }

  if (columns.has('last_result')) {
    payload.last_result = recentHits.length ? recentHits[recentHits.length - 1] : 0;
  }

  if (columns.has('last_result_count')) {
    payload.last_result_count = recentHits.length ? recentHits[recentHits.length - 1] : 0;
  }

  if (columns.has('last_updated')) payload.last_updated = nowIso;
  if (columns.has('updated_at')) payload.updated_at = nowIso;
  if (columns.has('created_at')) payload.created_at = nowIso;

  return payload;
}

function buildUpdatePayload(columns, existing, agg) {
  const payload = {};
  const nowIso = new Date().toISOString();

  const totalRounds = toNum(existing.total_rounds ?? existing.total_runs ?? existing.draw_count, 0) + agg.total_rounds;
  const totalHits =
    toNum(existing.total_hits ?? existing.total_hit_count ?? existing.total_hit_col, 0) +
    agg.total_hits;

  const hit0 = toNum(existing.hit0, 0) + agg.hit0;
  const hit1 = toNum(existing.hit1, 0) + agg.hit1;
  const hit2 = toNum(existing.hit2, 0) + agg.hit2;
  const hit3 = toNum(existing.hit3, 0) + agg.hit3;
  const hit4 = toNum(existing.hit4, 0) + agg.hit4;

  const totalCost = toNum(existing.total_cost, 0) + agg.total_cost;
  const totalReward = toNum(existing.total_reward, 0) + agg.total_reward;
  const totalProfit = toNum(existing.total_profit, 0) + agg.total_profit;

  if (columns.has('strategy_label') && !existing.strategy_label && agg.strategy_label) {
    payload.strategy_label = agg.strategy_label;
  }

  if (columns.has('total_rounds')) payload.total_rounds = totalRounds;
  if (columns.has('total_runs')) payload.total_runs = totalRounds;
  if (columns.has('draw_count')) payload.draw_count = totalRounds;

  if (columns.has('total_hits')) payload.total_hits = totalHits;
  if (columns.has('total_hit_count')) payload.total_hit_count = totalHits;
  if (columns.has('total_hit_col')) payload.total_hit_col = totalHits;

  if (columns.has('hit0')) payload.hit0 = hit0;
  if (columns.has('hit1')) payload.hit1 = hit1;
  if (columns.has('hit2')) payload.hit2 = hit2;
  if (columns.has('hit3')) payload.hit3 = hit3;
  if (columns.has('hit4')) payload.hit4 = hit4;

  if (columns.has('win_count')) payload.win_count = hit1 + hit2 + hit3 + hit4;
  if (columns.has('loss_count')) payload.loss_count = hit0;

  if (columns.has('avg_hit')) {
    payload.avg_hit = totalRounds > 0 ? round6(totalHits / totalRounds) : 0;
  }

  if (columns.has('hit_rate')) {
    payload.hit_rate = totalRounds > 0 ? round6(totalHits / (totalRounds * 4)) : 0;
  }

  if (columns.has('total_cost')) payload.total_cost = totalCost;
  if (columns.has('total_reward')) payload.total_reward = totalReward;
  if (columns.has('total_profit')) payload.total_profit = totalProfit;

  if (columns.has('roi')) {
    payload.roi = totalCost > 0 ? round6(totalProfit / totalCost) : 0;
  }

  const existingRecentHits = safeJsonArray(existing.recent_hits);
  const existingRecentProfit = safeJsonArray(existing.recent_profit);
  const existingRecentCost = safeJsonArray(existing.recent_cost);

  const appendedHits = agg.rows.map((r) => toNum(r.hit_count, 0));
  const appendedProfit = agg.rows.map((r) => toNum(r.profit, 0));
  const appendedCost = agg.rows.map((r) => toNum(r.cost, 0));

  const recentHits = limitRecent([...existingRecentHits, ...appendedHits], 50);
  const recentProfit = limitRecent([...existingRecentProfit, ...appendedProfit], 50);
  const recentCost = limitRecent([...existingRecentCost, ...appendedCost], 50);

  if (columns.has('recent_hits')) payload.recent_hits = recentHits;
  if (columns.has('recent_profit')) payload.recent_profit = recentProfit;
  if (columns.has('recent_cost')) payload.recent_cost = recentCost;

  if (columns.has('recent_50_hit')) {
    payload.recent_50_hit =
      recentHits.length > 0
        ? round6(recentHits.reduce((a, b) => a + b, 0) / recentHits.length)
        : 0;
  }

  if (columns.has('recent_50_roi')) {
    const p = recentProfit.reduce((a, b) => a + b, 0);
    const c = recentCost.reduce((a, b) => a + b, 0);
    payload.recent_50_roi = c > 0 ? round6(p / c) : 0;
  }

  if (columns.has('best_single_hit')) {
    const currentBest = toNum(existing.best_single_hit, 0);
    const newBest = Math.max(...appendedHits, 0);
    payload.best_single_hit = Math.max(currentBest, newBest);
  }

  if (columns.has('last_result')) {
    payload.last_result = appendedHits.length ? appendedHits[appendedHits.length - 1] : 0;
  }

  if (columns.has('last_result_count')) {
    payload.last_result_count = appendedHits.length ? appendedHits[appendedHits.length - 1] : 0;
  }

  if (columns.has('last_updated')) payload.last_updated = nowIso;
  if (columns.has('updated_at')) payload.updated_at = nowIso;

  return payload;
}

export async function recordStrategyCompareResult(compareResultOrRows) {
  const normalizedRows = normalizeInput(compareResultOrRows);
  if (!normalizedRows.length) {
    return {
      ok: false,
      results: []
    };
  }

  const columns = await getStrategyStatsColumns();
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
      const insertPayload = buildInsertPayload(columns, agg);

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

    const updatePayload = buildUpdatePayload(columns, existing, agg);

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
