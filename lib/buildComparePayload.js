export function parseDrawNumbers(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value === 'string') {
    return value.split(/[,\s]+/).map(Number).filter(Number.isFinite);
  }
  return [];
}

function calcReward(hit) {
  if (hit >= 4) return 450;
  if (hit === 3) return 50;
  if (hit === 2) return 10;
  return 0;
}

export function buildComparePayload({
  groups = [],
  drawRows = [],
  costPerGroupPerPeriod = 25
}) {
  let totalHit = 0;
  let totalCost = 0;
  let totalReward = 0;

  const detail = [];

  for (const draw of drawRows) {
    const nums = parseDrawNumbers(draw?.numbers);

    for (const g of groups) {
      if (!g?.nums) continue;

      const hit = g.nums.filter((n) => nums.includes(n)).length;
      const reward = calcReward(hit);
      const cost = costPerGroupPerPeriod;

      totalHit += hit;
      totalCost += cost;
      totalReward += reward;

      detail.push({
        strategy_key: g?.meta?.strategy_key || g.key,
        hit,
        cost,
        reward
      });
    }
  }

  const totalProfit = totalReward - totalCost;
  const roi = totalCost > 0 ? totalProfit / totalCost : 0;

  return {
    hitCount: totalHit,
    verdict: totalProfit > 0 ? 'good' : 'bad',
    compareResult: {
      detail,
      total_hit: totalHit,
      total_cost: totalCost,
      total_reward: totalReward,
      total_profit: totalProfit,
      roi
    }
  };
}
