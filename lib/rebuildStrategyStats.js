import { createClient } from '@supabase/supabase-js';

const RECENT_WINDOW = 50;
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_STATS_TABLE = 'strategy_stats';

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
    throw new Error('Missing Supabase env for rebuildStrategyStats');
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

function trimRecent(arr, size = RECENT_WINDOW) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(-size);
}

function calcRecent50HitRate(recentHits = []) {
  if (!recentHits.length) return 0;
  const positiveRounds = recentHits.filter((x) => toNum(x, 0) >= 2).length;
  return round2((positiveRounds / recentHits.length) * 100);
}

function calcRecent50Roi(recentProfit = [], recentCost = 25) {
  if (!recentProfit.length) return 0;
  const totalProfit = recentProfit.reduce((sum, x) => sum + toNum(x, 0), 0);
  const totalCost = recentProfit.length * recentCost;
  if (totalCost <= 0) return 0;
  return round2((totalProfit / totalCost) * 100);
}

function normalizeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function getGroupDrawCount(group, compareResult) {
  if (Array.isArray(group?.periods) && group.periods.length > 0) {
    return group.periods.length;
  }

  const summaryPeriods = toNum(compareResult?.summary?.total_periods, 0);
  if (summaryPeriods > 0) return summaryPeriods;

  const targetPeriods = toNum(compareResult?.target_periods, 0);
  if (targetPeriods > 0) return targetPeriods;

  return 0;
}

function getGroupCost(group, compareResult) {
  const explicit = Number(group?.total_cost);
  if (Number.isFinite(explicit)) return explicit;

  const rounds = getGroupDrawCount(group, compareResult);
  if (rounds <= 0) return 0;

  const totalGroups = Math.max(
    1,
    Array.isArray(compareResult?.groups) ? compareResult.groups.length : 1
  );

  const totalCost = Number(compareResult?.total_cost);
  if (Number.isFinite(totalCost) && totalGroups > 0) {
    return totalCost / totalGroups;
  }

  return rounds * 25;
}

function getGroupReward(group) {
  const explicit = Number(group?.total_reward);
  if (Number.isFinite(explicit)) return explicit;

  if (Array.isArray(group?.periods)) {
    return group.periods.reduce((sum, p) => sum + toNum(p?.reward, 0), 0);
  }

  return 0;
}

function getGroupHitCount(group) {
  const explicit = Number(group?.total_hit_count);
  if (Number.isFinite(explicit)) return explicit;

  if (Array.isArray(group?.periods)) {
    return group.periods.reduce((sum, p) => sum + toNum(p?.hit_count, 0), 0);
  }

  return 0;
}

function getHitBuckets(group, rounds, totalHitCount) {
  let hit0 = toNum(group?.hit0, NaN);
  let hit1 = toNum(group?.hit1, NaN);
  let hit2 = toNum(group?.hit2_count, NaN);
  let hit3 = toNum(group?.hit3_count, NaN);
  let hit4 = toNum(group?.hit4_count, NaN);

  const hasExplicit =
    Number.isFinite(hit0) ||
    Number.isFinite(hit1) ||
    Number.isFinite(hit2) ||
    Number.isFinite(hit3) ||
    Number.isFinite(hit4);

  if (hasExplicit) {
    return {
      hit0: Number.isFinite(hit0) ? hit0 : Math.max(0, rounds - (toNum(hit1, 0) + toNum(hit2, 0) + toNum(hit3, 0) + toNum(hit4, 0))),
      hit1: Number.isFinite(hit1) ? hit1 : 0,
      hit2: Number.isFinite(hit2) ? hit2 : 0,
      hit3: Number.isFinite(hit3) ? hit3 : 0,
      hit4: Number.isFinite(hit4) ? hit4 : 0
    };
  }

  if (Array.isArray(group?.periods) && group.periods.length > 0) {
    let c0 = 0;
    let c1 = 0;
    let c2 = 0;
    let c3 = 0;
    let c4 = 0;

    for (const p of group.periods) {
      const hc = toNum(p?.hit_count, 0);
      if (hc <= 0) c0 += 1;
      else if (hc === 1) c1 += 1;
      else if (hc === 2) c2 += 1;
      else if (hc === 3) c3 += 1;
      else c4 += 1;
    }

    return { hit0: c0, hit1: c1, hit2: c2, hit3: c3, hit4: c4 };
  }

  const inferredHit2 = toNum(group?.hit2_count, 0);
  const inferredHit3 = toNum(group?.hit3_count, 0);
  const inferredHit4 = toNum(group?.hit4_count, 0);
  const inferredHit1 = Math.max(0, rounds - inferredHit2 - inferredHit3 - inferredHit4);
  const inferredHit0 = 0;

  if (rounds > 0) {
    return {
      hit0: inferredHit0,
      hit1: inferredHit1,
      hit2: inferredHit2,
      hit3: inferredHit3,
      hit4: inferredHit4
    };
  }

  const avgHit = rounds > 0 ? totalHitCount / rounds : 0;
  return {
    hit0: 0,
    hit1: avgHit > 0 ? rounds : 0,
    hit2: 0,
    hit3: 0,
    hit4: 0
  };
}

function getStrategyKeyFromGroup(group) {
  return (
    group?.meta?.strategy_key ||
    group?.strategyKey ||
    group?.key ||
    ''
  );
}

function emptyStat(strategyKey = '') {
  return {
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
    recent_50_hit_rate: 0,
    recent_50_roi: 0,
    last_result_draw_no: 0,
    last_updated: new Date().toISOString()
  };
}

function finalizeStat(stat) {
  stat.avg_hit =
    stat.total_rounds > 0 ? round2(stat.total_hits / stat.total_rounds) : 0;

  stat.hit_rate =
    stat.total_rounds > 0
      ? round2(((stat.hit2 + stat.hit3 + stat.hit4) / stat.total_rounds) * 100)
      : 0;

  stat.total_cost = round2(stat.total_cost);
  stat.total_reward = round2(stat.total_reward);
  stat.total_profit = round2(stat.total_profit);
  stat.roi =
    stat.total_cost > 0
      ? round2((stat.total_profit / stat.total_cost) * 100)
      : 0;

  stat.recent_hits = trimRecent(stat.recent_hits);
  stat.recent_profit = trimRecent(stat.recent_profit);
  stat.recent_50_hit_rate = calcRecent50HitRate(stat.recent_hits);
  stat.recent_50_roi = calcRecent50Roi(stat.recent_profit, 25);
  stat.last_updated = new Date().toISOString();

  return stat;
}

async function fetchComparedPredictions(supabase) {
  const pageSize = 1000;
  let from = 0;
  let allRows = [];

  while (true) {
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from(PREDICTIONS_TABLE)
      .select('id, compared_at, compare_result, compare_result_json')
      .eq('status', 'compared')
      .order('compared_at', { ascending: true, nullsFirst: false })
      .range(from, to);

    if (error) throw error;

    const rows = data || [];
    allRows = allRows.concat(rows);

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

async function replaceStrategyStats(supabase, statsRows) {
  const { error: deleteError } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .delete()
    .neq('strategy_key', '');

  if (deleteError) throw deleteError;

  if (!statsRows.length) {
    return { inserted: 0 };
  }

  const chunkSize = 500;
  let inserted = 0;

  for (let i = 0; i < statsRows.length; i += chunkSize) {
    const chunk = statsRows.slice(i, i + chunkSize);

    const { error } = await supabase
      .from(STRATEGY_STATS_TABLE)
      .insert(chunk);

    if (error) throw error;
    inserted += chunk.length;
  }

  return { inserted };
}

export async function rebuildStrategyStats() {
  const supabase = getSupabase();

  const predictions = await fetchComparedPredictions(supabase);
  const statMap = new Map();

  for (const row of predictions) {
    const compareResult =
      normalizeJson(row.compare_result_json, null) ||
      normalizeJson(row.compare_result, null);

    if (!compareResult) {
      continue;
    }

    const compareDrawNo =
      toNum(compareResult?.compare_draw_no, 0) ||
      toNum(compareResult?.target_draw_no, 0) ||
      0;

    // ✅ 優先讀 strategy_detail（三星新格式），fallback 到 groups（舊格式）
    const useStrategyDetail = Array.isArray(compareResult.strategy_detail) && compareResult.strategy_detail.length > 0;
    const useGroups = !useStrategyDetail && Array.isArray(compareResult.groups) && compareResult.groups.length > 0;

    if (!useStrategyDetail && !useGroups) {
      continue;
    }

    if (useStrategyDetail) {
      // 新格式：strategy_detail 已有完整統計，直接讀取
      for (const sd of compareResult.strategy_detail) {
        const strategyKey = String(sd?.strategy_key || '');
        if (!strategyKey) continue;

        if (!statMap.has(strategyKey)) {
          statMap.set(strategyKey, emptyStat(strategyKey));
        }

        const stat = statMap.get(strategyKey);
        const rounds = toNum(sd?.total_rounds, 1);
        const totalHitCount = toNum(sd?.total_hits, 0);
        const totalCost = toNum(sd?.total_cost, 0);
        const totalReward = toNum(sd?.total_reward, 0);
        const totalProfit = toNum(sd?.total_profit, totalReward - totalCost);

        stat.total_rounds += rounds;
        stat.total_hits += totalHitCount;
        stat.total_cost += totalCost;
        stat.total_reward += totalReward;
        stat.total_profit += totalProfit;

        stat.hit0 += toNum(sd?.hit0, 0);
        stat.hit1 += toNum(sd?.hit1, 0);
        stat.hit2 += toNum(sd?.hit2, 0);
        stat.hit3 += toNum(sd?.hit3, 0);
        stat.hit4 += toNum(sd?.hit4, 0);

        stat.recent_hits.push(totalHitCount);
        stat.recent_profit.push(round2(totalProfit));

        stat.last_result_draw_no = Math.max(
          toNum(stat.last_result_draw_no, 0),
          compareDrawNo
        );
      }
    } else {
      // 舊格式：從 groups 讀取
      for (const group of compareResult.groups) {
        const strategyKey = getStrategyKeyFromGroup(group);
        if (!strategyKey) continue;

        if (!statMap.has(strategyKey)) {
          statMap.set(strategyKey, emptyStat(strategyKey));
        }

        const stat = statMap.get(strategyKey);

        const rounds = getGroupDrawCount(group, compareResult);
        const totalHitCount = getGroupHitCount(group);
        const totalCost = getGroupCost(group, compareResult);
        const totalReward = getGroupReward(group);
        const totalProfit = totalReward - totalCost;

        const buckets = getHitBuckets(group, rounds, totalHitCount);

        stat.total_rounds += rounds;
        stat.total_hits += totalHitCount;
        stat.total_cost += totalCost;
        stat.total_reward += totalReward;
        stat.total_profit += totalProfit;

        stat.hit0 += buckets.hit0;
        stat.hit1 += buckets.hit1;
        stat.hit2 += buckets.hit2;
        stat.hit3 += buckets.hit3;
        stat.hit4 += buckets.hit4;

        stat.recent_hits.push(totalHitCount);
        stat.recent_profit.push(round2(totalProfit));

        stat.last_result_draw_no = Math.max(
          toNum(stat.last_result_draw_no, 0),
          compareDrawNo
        );
      }
    }
  }

  const finalRows = [...statMap.values()].map((stat) => finalizeStat(stat));
  finalRows.sort((a, b) => a.strategy_key.localeCompare(b.strategy_key));

  const replaceResult = await replaceStrategyStats(supabase, finalRows);

  return {
    ok: true,
    compared_prediction_count: predictions.length,
    strategy_count: finalRows.length,
    inserted_count: replaceResult.inserted,
    sample: finalRows.slice(0, 10).map((row) => ({
      strategy_key: row.strategy_key,
      total_rounds: row.total_rounds,
      total_hits: row.total_hits,
      avg_hit: row.avg_hit,
      total_cost: row.total_cost,
      total_reward: row.total_reward,
      total_profit: row.total_profit,
      roi: row.roi,
      recent_50_hit_rate: row.recent_50_hit_rate,
      recent_50_roi: row.recent_50_roi
    }))
  };
}
