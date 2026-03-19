function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
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
      .map((s) => Number(String(s).trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function normalizeGroup(group, idx = 0) {
  if (!group || typeof group !== 'object') return null;

  const numsSource = Array.isArray(group.nums)
    ? group.nums
    : Array.isArray(group.numbers)
      ? group.numbers
      : Array.isArray(group.pick)
        ? group.pick
        : [];

  const nums = uniqueAsc(numsSource).slice(0, 4);
  if (nums.length !== 4) return null;

  const meta = group.meta && typeof group.meta === 'object' ? group.meta : {};

  return {
    key: String(group.key || group.strategyKey || group.strategy_key || `group_${idx + 1}`),
    label: String(group.label || group.name || group.strategy_name || `第${idx + 1}組`),
    nums,
    reason: String(group.reason || ''),
    meta
  };
}

export function parsePredictionGroups(prediction, expectedCount = 4) {
  const raw =
    prediction?.groups_json ??
    prediction?.groups ??
    prediction?.prediction_groups ??
    [];

  let parsed = [];

  if (Array.isArray(raw)) {
    parsed = raw;
  } else if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
  }

  return parsed
    .map((group, idx) => normalizeGroup(group, idx))
    .filter(Boolean)
    .slice(0, expectedCount);
}

function getRewardByHit(hitCount) {
  const hit = toInt(hitCount, 0);
  if (hit >= 4) return 1000;
  if (hit === 3) return 75;
  return 0;
}

function getVerdict(totalProfit) {
  if (totalProfit > 0) return 'good';
  if (totalProfit < 0) return 'normal';
  return 'draw';
}

function buildRoundResult(group, drawRow, costPerGroupPerPeriod) {
  const drawNumbers = parseDrawNumbers(drawRow?.numbers);
  const hitNumbers = group.nums.filter((n) => drawNumbers.includes(n));
  const hitCount = hitNumbers.length;
  const reward = getRewardByHit(hitCount);
  const cost = costPerGroupPerPeriod;
  const profit = reward - cost;

  return {
    draw_no: toInt(drawRow?.draw_no, 0),
    draw_time: drawRow?.draw_time || null,
    draw_numbers: drawNumbers,
    pick_numbers: group.nums,
    hit_numbers: hitNumbers,
    hit_count: hitCount,
    reward,
    cost,
    profit
  };
}

function buildGroupSummary(group, normalizedDrawRows, costPerGroupPerPeriod) {
  const rounds = normalizedDrawRows.map((drawRow) =>
    buildRoundResult(group, drawRow, costPerGroupPerPeriod)
  );

  const totalCost = rounds.reduce((sum, row) => sum + toNum(row.cost, 0), 0);
  const totalReward = rounds.reduce((sum, row) => sum + toNum(row.reward, 0), 0);
  const totalProfit = rounds.reduce((sum, row) => sum + toNum(row.profit, 0), 0);
  const totalHitCount = rounds.reduce((sum, row) => sum + toInt(row.hit_count, 0), 0);
  const bestSingleHit = rounds.reduce((max, row) => Math.max(max, toInt(row.hit_count, 0)), 0);

  const hit0Count = rounds.filter((row) => toInt(row.hit_count, 0) === 0).length;
  const hit1Count = rounds.filter((row) => toInt(row.hit_count, 0) === 1).length;
  const hit2Count = rounds.filter((row) => toInt(row.hit_count, 0) === 2).length;
  const hit3Count = rounds.filter((row) => toInt(row.hit_count, 0) === 3).length;
  const hit4Count = rounds.filter((row) => toInt(row.hit_count, 0) >= 4).length;

  const roi = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
  const payoutRate = totalCost > 0 ? (totalReward / totalCost) * 100 : 0;
  const profitWinRate =
    rounds.length > 0
      ? (rounds.filter((row) => toNum(row.profit, 0) > 0).length / rounds.length) * 100
      : 0;

  return {
    key: group.key,
    label: group.label,
    nums: group.nums,
    reason: group.reason || '',
    meta: group.meta || {},
    rounds,
    hit_count: totalHitCount,
    total_hit_count: totalHitCount,
    total_cost: totalCost,
    total_reward: totalReward,
    total_profit: totalProfit,
    best_single_hit: bestSingleHit,
    payout_rate: round2(payoutRate),
    profit_win_rate: round2(profitWinRate),
    roi: round2(roi),
    hit0_count: hit0Count,
    hit1_count: hit1Count,
    hit2_count: hit2Count,
    hit3_count: hit3Count,
    hit4_count: hit4Count
  };
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
    .map((group, idx) => normalizeGroup(group, idx))
    .filter(Boolean);

  const normalizedDrawRows = (Array.isArray(drawRows) ? drawRows : []).map((row) => ({
    draw_no: toInt(row?.[drawNoCol], 0),
    draw_time: row?.[drawTimeCol] || null,
    numbers: parseDrawNumbers(row?.[drawNumbersCol])
  }));

  const comparedDrawCount = normalizedDrawRows.length;
  const compareDrawNo =
    comparedDrawCount > 0
      ? toInt(normalizedDrawRows[comparedDrawCount - 1]?.draw_no, 0)
      : 0;

  const groupsResult = normalizedGroups.map((group) =>
    buildGroupSummary(group, normalizedDrawRows, costPerGroupPerPeriod)
  );

  const overallTotalCost = groupsResult.reduce((sum, group) => sum + toNum(group.total_cost, 0), 0);
  const overallTotalReward = groupsResult.reduce((sum, group) => sum + toNum(group.total_reward, 0), 0);
  const overallTotalProfit = groupsResult.reduce((sum, group) => sum + toNum(group.total_profit, 0), 0);
  const overallTotalHitCount = groupsResult.reduce((sum, group) => sum + toInt(group.total_hit_count, 0), 0);
  const bestSingleHit = groupsResult.reduce((max, group) => Math.max(max, toInt(group.best_single_hit, 0)), 0);

  const compareResult = {
    prediction_id: prediction?.id || null,
    mode: prediction?.mode || '',
    source_draw_no: toInt(prediction?.source_draw_no, 0),
    target_periods: toInt(prediction?.target_periods, comparedDrawCount),
    compared_draw_count: comparedDrawCount,
    compare_draw_no: compareDrawNo,
    periods: normalizedDrawRows,
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
    groups: groupsResult.map((group) => ({
      key: group.key,
      label: group.label,
      nums: group.nums,
      reason: group.reason,
      hit_count: group.total_hit_count,
      total_hit_count: group.total_hit_count,
      best_single_hit: group.best_single_hit,
      total_reward: group.total_reward,
      total_cost: group.total_cost,
      total_profit: group.total_profit,
      payout_rate: group.payout_rate,
      profit_win_rate: group.profit_win_rate,
      roi: group.roi,
      hit0_count: group.hit0_count,
      hit1_count: group.hit1_count,
      hit2_count: group.hit2_count,
      hit3_count: group.hit3_count,
      hit4_count: group.hit4_count,
      meta: group.meta || {}
    })),
    total_cost: overallTotalCost,
    total_reward: overallTotalReward,
    total_profit: overallTotalProfit,
    total_hit_count: overallTotalHitCount,
    hit_count: overallTotalHitCount,
    best_single_hit: bestSingleHit,
    verdict: getVerdict(overallTotalProfit)
  };

  return {
    compareResult,
    compareResultJson: compareResult,
    verdict: getVerdict(overallTotalProfit),
    hitCount: overallTotalHitCount,
    bestSingleHit,
    comparedDrawCount,
    compareDrawNo,
    resultForApp
  };
}
