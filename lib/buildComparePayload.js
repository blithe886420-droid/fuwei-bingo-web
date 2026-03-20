export function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map(Number)
      .filter(Number.isFinite);
  }

  return [];
}

function calcReward(hit) {
  if (hit >= 4) return 450;
  if (hit === 3) return 50;
  if (hit === 2) return 10;
  return 0;
}

function safeGroups(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group, idx) => {
      if (!group || typeof group !== 'object') return null;

      const numsSource = Array.isArray(group.nums)
        ? group.nums
        : Array.isArray(group.numbers)
          ? group.numbers
          : [];

      const nums = [...new Set(numsSource.map(Number).filter(Number.isFinite))].slice(0, 4);
      if (nums.length !== 4) return null;

      const meta = group.meta && typeof group.meta === 'object' ? group.meta : {};

      return {
        key: String(group.key || meta.strategy_key || `group_${idx + 1}`),
        label: String(group.label || meta.strategy_name || `第${idx + 1}組`),
        nums,
        meta: {
          ...meta,
          strategy_key: String(meta.strategy_key || group.key || `group_${idx + 1}`),
          strategy_name: String(meta.strategy_name || group.label || `第${idx + 1}組`)
        }
      };
    })
    .filter(Boolean);
}

export function buildComparePayload({
  groups,
  drawRows,
  costPerGroupPerPeriod = 25
}) {
  const safeDrawRows = Array.isArray(drawRows) ? drawRows : [];
  const safeGroupRows = safeGroups(groups);

  let totalHit = 0;
  let totalCost = 0;
  let totalReward = 0;

  const detail = [];
  const draw_detail = [];
  const strategyAggregateMap = new Map();

  for (const draw of safeDrawRows) {
    const drawNo = Number(draw?.draw_no || 0);
    const nums = parseDrawNumbers(draw?.numbers);

    const perDraw = {
      draw_no: drawNo || null,
      hit_total: 0,
      cost_total: 0,
      reward_total: 0,
      groups: []
    };

    for (const group of safeGroupRows) {
      const hit = group.nums.filter((n) => nums.includes(n)).length;
      const reward = calcReward(hit);
      const cost = Number(costPerGroupPerPeriod) || 25;

      totalHit += hit;
      totalCost += cost;
      totalReward += reward;

      perDraw.hit_total += hit;
      perDraw.cost_total += cost;
      perDraw.reward_total += reward;

      const strategyKey = String(group?.meta?.strategy_key || group.key);

      detail.push({
        draw_no: drawNo || null,
        strategy_key: strategyKey,
        strategy_name: String(group?.meta?.strategy_name || group.label || strategyKey),
        hit,
        cost,
        reward,
        nums: group.nums
      });

      perDraw.groups.push({
        strategy_key: strategyKey,
        strategy_name: String(group?.meta?.strategy_name || group.label || strategyKey),
        nums: group.nums,
        hit,
        cost,
        reward
      });

      if (!strategyAggregateMap.has(strategyKey)) {
        strategyAggregateMap.set(strategyKey, {
          strategy_key: strategyKey,
          strategy_name: String(group?.meta?.strategy_name || group.label || strategyKey),
          rounds: 0,
          total_hit: 0,
          total_cost: 0,
          total_reward: 0
        });
      }

      const agg = strategyAggregateMap.get(strategyKey);
      agg.rounds += 1;
      agg.total_hit += hit;
      agg.total_cost += cost;
      agg.total_reward += reward;
    }

    draw_detail.push(perDraw);
  }

  const totalProfit = totalReward - totalCost;
  const roi = totalCost > 0 ? totalProfit / totalCost : 0;

  const strategy_detail = [...strategyAggregateMap.values()].map((row) => {
    const totalProfitPerStrategy = row.total_reward - row.total_cost;
    const strategyRoi = row.total_cost > 0 ? totalProfitPerStrategy / row.total_cost : 0;
    const avgHit = row.rounds > 0 ? row.total_hit / row.rounds : 0;

    return {
      ...row,
      total_profit: totalProfitPerStrategy,
      roi: strategyRoi,
      avg_hit: avgHit
    };
  });

  return {
    hitCount: totalHit,
    verdict: totalProfit > 0 ? 'good' : 'bad',
    compareResult: {
      detail,
      draw_detail,
      strategy_detail,
      total_hit: totalHit,
      total_cost: totalCost,
      total_reward: totalReward,
      total_profit: totalProfit,
      roi
    }
  };
}
