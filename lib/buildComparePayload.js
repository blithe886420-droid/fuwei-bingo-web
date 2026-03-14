export const COST_PER_GROUP_PER_PERIOD = 25;

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
  return [...new Set(nums.map((n) => Number(n)).filter(Number.isFinite))].sort((a, b) => a - b);
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

export function getHitNumbers(predicted, drawNumbers) {
  const drawSet = new Set(drawNumbers.map(Number));
  return predicted.map(Number).filter((n) => drawSet.has(n)).sort((a, b) => a - b);
}

export function calcRewardByHitCount(hitCount) {
  if (hitCount >= 4) return 1000;
  if (hitCount === 3) return 100;
  if (hitCount === 2) return 25;
  return 0;
}

export function parsePredictionGroups(prediction, maxGroupCount = 4) {
  const raw = prediction?.groups_json ?? null;
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((group, idx) => {
        if (Array.isArray(group)) {
          return {
            key: `group_${idx + 1}`,
            label: `第${idx + 1}組`,
            nums: uniqueAsc(group).slice(0, 4),
            reason: '舊版資料',
            meta: { legacy: true }
          };
        }

        if (group && typeof group === 'object') {
          const nums = Array.isArray(group.nums)
            ? group.nums
            : Array.isArray(group.numbers)
              ? group.numbers
              : Array.isArray(group.pick)
                ? group.pick
                : [];

          return {
            key: group.key || group.strategyKey || `group_${idx + 1}`,
            label: group.label || group.name || `第${idx + 1}組`,
            nums: uniqueAsc(nums).slice(0, 4),
            reason: group.reason || '',
            meta: group.meta || {}
          };
        }

        return null;
      })
      .filter((g) => g && g.nums.length === 4)
      .slice(0, maxGroupCount);
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsePredictionGroups({ groups_json: parsed }, maxGroupCount);
    } catch {
      return [];
    }
  }

  return [];
}

export function buildComparePayload({
  prediction,
  groups,
  drawRows,
  drawNoCol = 'draw_no',
  drawTimeCol = 'draw_time',
  drawNumbersCol = 'numbers',
  costPerGroupPerPeriod = COST_PER_GROUP_PER_PERIOD
}) {
  const sourceDrawNo = String(prediction.source_draw_no || '');
  const targetPeriods = toInt(prediction.target_periods || 2);

  const groupResults = [];
  const periodResults = [];

  let totalReward = 0;
  let totalHitCount = 0;
  let bestSingleHit = 0;

  for (const drawRow of drawRows) {
    const drawNo = toInt(drawRow[drawNoCol]);
    const drawTime = drawRow[drawTimeCol] || '';
    const drawNumbers = parseDrawNumbers(drawRow[drawNumbersCol]);

    let periodReward = 0;

    for (const group of groups) {
      const hitNumbers = getHitNumbers(group.nums, drawNumbers);
      const hitCount = hitNumbers.length;
      const reward = calcRewardByHitCount(hitCount);

      let targetGroup = groupResults.find((g) => g.key === group.key);
      if (!targetGroup) {
        targetGroup = {
          key: group.key,
          label: group.label,
          nums: group.nums,
          reason: group.reason || '',
          meta: group.meta || {},
          total_hit_count: 0,
          best_single_hit: 0,
          total_reward: 0,
          hit2_count: 0,
          hit3_count: 0,
          hit4_count: 0,
          payout_rounds: 0,
          profit_rounds: 0,
          total_cost: 0,
          total_profit: 0,
          periods: []
        };
        groupResults.push(targetGroup);
      }

      const cost = costPerGroupPerPeriod;
      const profit = reward - cost;

      targetGroup.total_hit_count += hitCount;
      targetGroup.best_single_hit = Math.max(targetGroup.best_single_hit, hitCount);
      targetGroup.total_reward += reward;
      targetGroup.total_cost += cost;
      targetGroup.total_profit += profit;

      if (hitCount === 2) targetGroup.hit2_count += 1;
      if (hitCount === 3) targetGroup.hit3_count += 1;
      if (hitCount >= 4) targetGroup.hit4_count += 1;
      if (reward > 0) targetGroup.payout_rounds += 1;
      if (profit > 0) targetGroup.profit_rounds += 1;

      targetGroup.periods.push({
        draw_no: drawNo,
        draw_time: drawTime,
        hit_numbers: hitNumbers,
        hit_count: hitCount,
        reward,
        cost,
        profit
      });

      totalHitCount += hitCount;
      bestSingleHit = Math.max(bestSingleHit, hitCount);
      periodReward += reward;
      totalReward += reward;
    }

    periodResults.push({
      draw_no: drawNo,
      draw_time: drawTime,
      reward: periodReward
    });
  }

  for (const group of groupResults) {
    const totalRounds = group.periods.length || targetPeriods;
    group.avg_hit = round2(group.total_hit_count / totalRounds);
    group.avg_reward = round2(group.total_reward / totalRounds);
    group.avg_profit = round2(group.total_profit / totalRounds);
    group.payout_rate = round2((group.payout_rounds / totalRounds) * 100);
    group.profit_win_rate = round2((group.profit_rounds / totalRounds) * 100);
    group.roi = group.total_cost > 0
      ? round2((group.total_profit / group.total_cost) * 100)
      : 0;
  }

  const totalCost = groups.length * targetPeriods * costPerGroupPerPeriod;
  const profit = totalReward - totalCost;
  const compareDrawRange =
    drawRows.length > 0
      ? `${drawRows[0][drawNoCol]} ~ ${drawRows[drawRows.length - 1][drawNoCol]}`
      : '';

  const maxTotalHit = Math.max(0, ...groupResults.map((g) => g.total_hit_count));
  const verdict = `${targetPeriods}期累計最佳 ${maxTotalHit} 碼 / 單期最佳中${bestSingleHit}`;
  const compareDrawNo = drawRows.length
    ? toInt(drawRows[drawRows.length - 1][drawNoCol])
    : null;

  const compareResult = {
    mode: `4star_${groups.length}group_${targetPeriods}period`,
    source_draw_no: sourceDrawNo,
    target_periods: targetPeriods,
    total_cost: totalCost,
    total_reward: totalReward,
    profit,
    total_hit_count: totalHitCount,
    best_single_hit: bestSingleHit,
    compare_draw_range: compareDrawRange,
    groups: groupResults,
    period_results: periodResults,
    summary: {
      total_groups: groups.length,
      total_periods: drawRows.length,
      total_hit_count: totalHitCount,
      best_single_hit: bestSingleHit
    }
  };

  const resultForApp = {
    verdict,
    sourceDrawNo,
    targetDrawNo: toInt(sourceDrawNo) + targetPeriods,
    compareDrawNo,
    compareDrawRange,
    totalCost,
    estimatedReturn: totalReward,
    profit,
    compareRounds: drawRows.map((drawRow) => ({
      drawNo: toInt(drawRow[drawNoCol]),
      drawTime: drawRow[drawTimeCol] || '',
      drawNumbers: parseDrawNumbers(drawRow[drawNumbersCol])
    })),
    results: groupResults.map((g) => ({
      key: g.key,
      strategyKey: g.meta?.strategy_key || g.key,
      strategy: g.meta?.strategy_name || g.key,
      label: g.label,
      nums: g.nums,
      reason: g.reason,
      meta: g.meta || {},
      hitCount: g.total_hit_count,
      bestSingleHit: g.best_single_hit,
      totalReward: g.total_reward,
      totalCost: g.total_cost,
      totalProfit: g.total_profit,
      roi: g.roi,
      avgHit: g.avg_hit,
      avgReward: g.avg_reward,
      avgProfit: g.avg_profit,
      hit2Count: g.hit2_count,
      hit3Count: g.hit3_count,
      hit4Count: g.hit4_count,
      payoutRate: g.payout_rate,
      profitWinRate: g.profit_win_rate,
      periodHits: (g.periods || []).map((p) => ({
        drawNo: p.draw_no,
        drawTime: p.draw_time,
        hitNumbers: p.hit_numbers,
        hitCount: p.hit_count,
        reward: p.reward,
        cost: p.cost,
        profit: p.profit
      }))
    }))
  };

  return {
    compareResult,
    compareResultJson: compareResult,
    resultForApp,
    verdict,
    hitCount: totalHitCount,
    bestSingleHit,
    comparedDrawCount: drawRows.length,
    compareDrawNo
  };
}
