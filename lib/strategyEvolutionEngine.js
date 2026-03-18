function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function uniqueAsc(nums) {
  return [...new Set((Array.isArray(nums) ? nums : []).map((n) => Number(n)).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

export function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function normalizeGroup(group, idx = 0) {
  if (Array.isArray(group)) {
    const nums = uniqueAsc(group).slice(0, 4);
    if (nums.length !== 4) return null;

    return {
      key: `group_${idx + 1}`,
      label: `第${idx + 1}組`,
      nums,
      reason: '',
      meta: {}
    };
  }

  if (!group || typeof group !== 'object') return null;

  const nums = uniqueAsc(Array.isArray(group.nums) ? group.nums : []).slice(0, 4);
  if (nums.length !== 4) return null;

  return {
    key: group.key || group.strategy_key || group.meta?.strategy_key || `group_${idx + 1}`,
    label: group.label || group.name || group.strategy_name || `第${idx + 1}組`,
    nums,
    reason: group.reason || '',
    meta: group.meta || {}
  };
}

export function parsePredictionGroups(prediction, fallbackCount = 4) {
  const raw = prediction?.groups_json || prediction?.groups || prediction?.prediction_groups || [];

  let groups = [];

  if (Array.isArray(raw)) {
    groups = raw;
  } else if (typeof raw === 'string') {
    try {
      groups = JSON.parse(raw);
    } catch {
      groups = [];
    }
  }

  const normalized = groups.map((g, idx) => normalizeGroup(g, idx)).filter(Boolean);

  if (normalized.length) {
    return normalized.slice(0, fallbackCount);
  }

  return [];
}

function getRewardByHit(hitCount) {
  if (hitCount >= 4) return 1000;
  if (hitCount === 3) return 100;
  if (hitCount === 2) return 25;
  return 0;
}

function getVerdict(totalProfit) {
  if (totalProfit > 0) return 'win';
  if (totalProfit < 0) return 'loss';
  return 'draw';
}

export function buildComparePayload({
  prediction,
  groups,
  drawRows,
  drawNoCol = 'draw_no',
  drawTimeCol = 'draw_time',
  drawNumbersCol = 'numbers',
  costPerGroupPerPeriod = 25
}) {
  const normalizedGroups = (Array.isArray(groups) ? groups : [])
    .map((g, idx) => normalizeGroup(g, idx))
    .filter(Boolean);

  const normalizedDrawRows = (Array.isArray(drawRows) ? drawRows : []).map((row) => ({
    draw_no: row?.[drawNoCol],
    draw_time: row?.[drawTimeCol] || null,
    numbers: parseDrawNumbers(row?.[drawNumbersCol])
  }));

  let overallTotalCost = 0;
  let overallTotalReward = 0;
  let overallTotalProfit = 0;
  let overallTotalHitCount = 0;
  let bestSingleHit = 0;

  const comparedDrawCount = normalizedDrawRows.length;
  const compareDrawNo =
    comparedDrawCount > 0
      ? toInt(normalizedDrawRows[normalizedDrawRows.length - 1]?.draw_no, 0)
      : 0;

  const groupsResult = normalizedGroups.map((group) => {
    let totalCost = 0;
    let totalReward = 0;
    let totalProfit = 0;
    let totalHitCount = 0;
    let hit0Count = 0;
    let hit1Count = 0;
    let hit2Count = 0;
    let hit3Count = 0;
    let hit4Count = 0;
    let groupBestHit = 0;

    const rounds = normalizedDrawRows.map((drawRow) => {
      const hitNums = group.nums.filter((n) => drawRow.numbers.includes(n));
      const hitCount = hitNums.length;
      const reward = getRewardByHit(hitCount);
      const cost = costPerGroupPerPeriod;
      const profit = reward - cost;

      totalCost += cost;
      totalReward += reward;
      totalProfit += profit;
      totalHitCount += hitCount;

      if (hitCount === 0) hit0Count += 1;
      else if (hitCount === 1) hit1Count += 1;
      else if (hitCount === 2) hit2Count += 1;
      else if (hitCount === 3) hit3Count += 1;
      else if (hitCount >= 4) hit4Count += 1;

      groupBestHit = Math.max(groupBestHit, hitCount);
      bestSingleHit = Math.max(bestSingleHit, hitCount);

      return {
        draw_no: toInt(drawRow.draw_no, 0),
        draw_time: drawRow.draw_time,
        draw_numbers: drawRow.numbers,
        pick_numbers: group.nums,
        hit_numbers: hitNums,
        hit_count: hitCount,
        reward,
        cost,
        profit
      };
    });

    const roi = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
    const payoutRate = totalCost > 0 ? (totalReward / totalCost) * 100 : 0;
    const profitWinRate = rounds.length > 0 ? ((rounds.filter((r) => r.profit > 0).length / rounds.length) * 100) : 0;

    overallTotalCost += totalCost;
    overallTotalReward += totalReward;
    overallTotalProfit += totalProfit;
    overallTotalHitCount += totalHitCount;

    return {
      key: group.key,
      label: group.label,
      nums: group.nums,
      reason: group.reason || '',
      meta: group.meta || {},
      rounds,
      total_cost: totalCost,
      total_reward: totalReward,
      total_profit: totalProfit,
      total_hit_count: totalHitCount,
      best_single_hit: groupBestHit,
      payout_rate: round2(payoutRate),
      profit_win_rate: round2(profitWinRate),
      roi: round2(roi),
      hit0_count: hit0Count,
      hit1_count: hit1Count,
      hit2_count: hit2Count,
      hit3_count: hit3Count,
      hit4_count: hit4Count
    };
  });

  const compareResult = {
    prediction_id: prediction?.id || null,
    mode: prediction?.mode || '',
    source_draw_no: toInt(prediction?.source_draw_no, 0),
    target_periods: toInt(prediction?.target_periods, comparedDrawCount),
    compared_draw_count: comparedDrawCount,
    compare_draw_no: compareDrawNo,
    groups: groupsResult,
    total_cost: overallTotalCost,
    total_reward: overallTotalReward,
    total_profit: overallTotalProfit,
    profit: overallTotalProfit,
    total_hit_count: overallTotalHitCount,
    hit_count: overallTotalHitCount,
    best_single_hit: bestSingleHit
  };

  const resultForApp = {
    prediction_id: prediction?.id || null,
    compare_draw_no: compareDrawNo,
    compared_draw_count: comparedDrawCount,
    groups: groupsResult.map((g) => ({
      key: g.key,
      label: g.label,
      nums: g.nums,
      total_hit_count: g.total_hit_count,
      hit_count: g.total_hit_count,
      best_single_hit: g.best_single_hit,
      total_reward: g.total_reward,
      total_cost: g.total_cost,
      total_profit: g.total_profit,
      payout_rate: g.payout_rate,
      profit_win_rate: g.profit_win_rate,
      roi: g.roi,
      hit0_count: g.hit0_count,
      hit1_count: g.hit1_count,
      hit2_count: g.hit2_count,
      hit3_count: g.hit3_count,
      hit4_count: g.hit4_count,
      meta: g.meta || {}
    })),
    total_cost: overallTotalCost,
    total_reward: overallTotalReward,
    total_profit: overallTotalProfit,
    profit: overallTotalProfit,
    total_hit_count: overallTotalHitCount,
    hit_count: overallTotalHitCount,
    best_single_hit: bestSingleHit
  };

  return {
    comparedDrawCount,
    compareDrawNo,
    compareResult,
    compareResultJson: compareResult,
    verdict: getVerdict(overallTotalProfit),
    hitCount: overallTotalHitCount,
    bestSingleHit,
    resultForApp
  };
}
