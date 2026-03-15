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
  return [...new Set(nums.map((n) => Number(n)).filter(Number.isFinite))].sort((a, b) => a - b);
}

export function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return uniqueAsc(value);
  }

  if (typeof value === 'string') {
    const raw = value.trim();

    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return uniqueAsc(parsed);
      }
    } catch {
      // ignore JSON parse error and continue with text parsing
    }

    return uniqueAsc(
      raw
        .split(/[^0-9]+/g)
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
    );
  }

  if (value && typeof value === 'object') {
    if (Array.isArray(value.nums)) return uniqueAsc(value.nums);
    if (Array.isArray(value.numbers)) return uniqueAsc(value.numbers);
  }

  return [];
}

export function parsePredictionGroups(prediction, expectedGroupCount = 4) {
  const raw = prediction?.groups_json;
  let groups = [];

  if (Array.isArray(raw)) {
    groups = raw;
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      groups = Array.isArray(parsed) ? parsed : [];
    } catch {
      groups = [];
    }
  }

  const normalized = groups
    .map((group, idx) => {
      const nums = parseDrawNumbers(group?.nums || group?.numbers || group);
      if (!nums.length) return null;

      return {
        key: group?.key || group?.strategy_key || `group_${idx + 1}`,
        label: group?.label || group?.strategy_name || `第${idx + 1}組`,
        nums: uniqueAsc(nums).slice(0, 4),
        reason: group?.reason || '',
        meta: {
          ...(group?.meta || {}),
          strategy_key:
            group?.meta?.strategy_key ||
            group?.strategy_key ||
            group?.key ||
            `group_${idx + 1}`
        }
      };
    })
    .filter(Boolean);

  return normalized.slice(0, expectedGroupCount);
}

function calcRewardByHit(hitCount) {
  // 這裡先採用保守、固定的測試獎金規則
  // 若你之後有正式獎金表，再改這裡即可
  if (hitCount >= 4) return 3000;
  if (hitCount === 3) return 300;
  if (hitCount === 2) return 50;
  return 0;
}

function calcSingleGroupResult({
  group,
  drawRows,
  drawNoCol,
  drawTimeCol,
  drawNumbersCol,
  costPerGroupPerPeriod
}) {
  const nums = uniqueAsc(group?.nums || []).slice(0, 4);
  const perDrawCost = toNum(costPerGroupPerPeriod, 25);

  let totalHitCount = 0;
  let totalReward = 0;
  let totalCost = 0;
  let bestSingleHit = 0;
  let hit2Count = 0;
  let hit3Count = 0;
  let hit4Count = 0;

  const history = [];

  for (const row of drawRows || []) {
    const drawNums = parseDrawNumbers(row?.[drawNumbersCol]);
    const hitNums = nums.filter((n) => drawNums.includes(n));
    const hitCount = hitNums.length;
    const reward = calcRewardByHit(hitCount);

    totalHitCount += hitCount;
    totalReward += reward;
    totalCost += perDrawCost;
    bestSingleHit = Math.max(bestSingleHit, hitCount);

    if (hitCount === 2) hit2Count += 1;
    else if (hitCount === 3) hit3Count += 1;
    else if (hitCount >= 4) hit4Count += 1;

    history.push({
      draw_no: toNum(row?.[drawNoCol], 0),
      draw_time: row?.[drawTimeCol] || null,
      draw_numbers: drawNums,
      nums,
      hit_nums: hitNums,
      hit_count: hitCount,
      reward
    });
  }

  const totalProfit = totalReward - totalCost;
  const roi = totalCost > 0 ? round2((totalProfit / totalCost) * 100) : 0;
  const payoutRate = totalCost > 0 ? round2((totalReward / totalCost) * 100) : 0;
  const profitWinRate =
    history.length > 0
      ? round2((history.filter((x) => toNum(x.reward, 0) > 0).length / history.length) * 100)
      : 0;

  return {
    key: group?.key || '',
    label: group?.label || '',
    nums,
    reason: group?.reason || '',
    meta: group?.meta || {},
    draw_count: history.length,
    total_hit_count: totalHitCount,
    hitCount: totalHitCount,
    total_cost: round2(totalCost),
    totalCost: round2(totalCost),
    total_reward: round2(totalReward),
    totalReward: round2(totalReward),
    total_profit: round2(totalProfit),
    totalProfit: round2(totalProfit),
    payout_rate: payoutRate,
    profit_win_rate: profitWinRate,
    roi,
    best_single_hit: bestSingleHit,
    hit2_count: hit2Count,
    hit3_count: hit3Count,
    hit4_count: hit4Count,
    history,
    strategyKey:
      group?.meta?.strategy_key ||
      group?.key ||
      ''
  };
}

function buildVerdict({ totalProfit, bestSingleHit, totalHitCount }) {
  if (bestSingleHit >= 4) return 'excellent';
  if (totalProfit > 0) return 'profit';
  if (bestSingleHit >= 3) return 'good';
  if (totalHitCount > 0) return 'partial';
  return 'miss';
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
  const safeGroups = Array.isArray(groups) ? groups : [];
  const safeRows = Array.isArray(drawRows) ? drawRows : [];

  const groupResults = safeGroups.map((group) =>
    calcSingleGroupResult({
      group,
      drawRows: safeRows,
      drawNoCol,
      drawTimeCol,
      drawNumbersCol,
      costPerGroupPerPeriod
    })
  );

  const comparedDrawCount = safeRows.length;
  const compareDrawNo =
    safeRows.length > 0 ? toNum(safeRows[safeRows.length - 1]?.[drawNoCol], 0) : 0;

  const totalCost = round2(groupResults.reduce((sum, g) => sum + toNum(g.total_cost, 0), 0));
  const totalReward = round2(groupResults.reduce((sum, g) => sum + toNum(g.total_reward, 0), 0));
  const totalProfit = round2(totalReward - totalCost);
  const totalHitCount = groupResults.reduce((sum, g) => sum + toNum(g.total_hit_count, 0), 0);
  const bestSingleHit = groupResults.reduce(
    (max, g) => Math.max(max, toNum(g.best_single_hit, 0)),
    0
  );

  const resultGroups = groupResults.map((g) => ({
    key: g.key,
    label: g.label,
    nums: g.nums,
    reason: g.reason,
    meta: g.meta,
    total_hit_count: g.total_hit_count,
    total_reward: g.total_reward,
    total_cost: g.total_cost,
    total_profit: g.total_profit,
    payout_rate: g.payout_rate,
    profit_win_rate: g.profit_win_rate,
    roi: g.roi,
    hit2_count: g.hit2_count,
    hit3_count: g.hit3_count,
    hit4_count: g.hit4_count,
    best_single_hit: g.best_single_hit,
    history: g.history
  }));

  const resultForApp = {
    predictionId: prediction?.id || null,
    sourceDrawNo: toNum(prediction?.source_draw_no, 0),
    compareDrawNo,
    comparedDrawCount,
    totalCost,
    totalReward,
    totalProfit,
    totalHitCount,
    bestSingleHit,
    results: groupResults.map((g) => ({
      key: g.key,
      label: g.label,
      nums: g.nums,
      reason: g.reason,
      meta: g.meta,
      strategyKey: g.strategyKey,
      hitCount: g.total_hit_count,
      totalCost: g.total_cost,
      totalReward: g.total_reward,
      totalProfit: g.total_profit,
      roi: g.roi,
      hit2Count: g.hit2_count,
      hit3Count: g.hit3_count,
      hit4Count: g.hit4_count,
      bestSingleHit: g.best_single_hit
    }))
  };

  const compareResult = {
    prediction_id: prediction?.id || null,
    source_draw_no: toNum(prediction?.source_draw_no, 0),
    compare_draw_no: compareDrawNo,
    compared_draw_count: comparedDrawCount,
    total_cost: totalCost,
    total_reward: totalReward,
    profit: totalProfit,
    total_hit_count: totalHitCount,
    best_single_hit: bestSingleHit,
    verdict: buildVerdict({
      totalProfit,
      bestSingleHit,
      totalHitCount
    }),
    groups: resultGroups,
    results: resultForApp.results
  };

  return {
    comparedDrawCount,
    compareDrawNo,
    compareResult,
    compareResultJson: JSON.stringify(compareResult),
    verdict: compareResult.verdict,
    hitCount: totalHitCount,
    bestSingleHit,
    resultForApp
  };
}
