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

function normalizeGroups(groups = []) {
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
  groups = [],
  drawRows = [],
  costPerGroupPerPeriod = 25
}) {
  const safeGroups = normalizeGroups(groups);
  const safeDrawRows = Array.isArray(drawRows) ? drawRows : [];

  let totalHit = 0;
  let totalCost = 0;
  let totalReward = 0;

  const detail = [];
  const draw_detail = [];
  const strategyMap = new Map();

  for (const draw of safeDrawRows) {
    const drawNo = Number(draw?.draw_no || 0) || null;
    const nums = parseDrawNumbers(draw?.numbers);

    const drawBucket = {
      draw_no: drawNo,
      groups: [],
      total_hit: 0,
      total_cost: 0,
      total_reward: 0
    };

    for (const group of safeGroups) {
      const hit = group.nums.filter((n) => nums.includes(n)).length;
      const reward = calcReward(hit);
      const cost = Number(costPerGroupPerPeriod) || 25;
      const strategyKey = String(group.meta?.strategy_key || group.key);
      const strategyName = String(group.meta?.strategy_name || group.label || strategyKey);

      totalHit += hit;
      totalCost += cost;
      totalReward += reward;

      drawBucket.total_hit += hit;
      drawBucket.total_cost += cost;
      drawBucket.total_reward += reward;

      const row = {
        draw_no: drawNo,
        strategy_key: strategyKey,
        strategy_name: strategyName,
        hit,
        cost,
        reward,
        nums: group.nums
      };

      detail.push(row);
      drawBucket.groups.push(row);

      if (!strategyMap.has(strategyKey)) {
        strategyMap.set(strategyKey, {
          strategy_key: strategyKey,
          strategy_name: strategyName,
          total_rounds: 0,
          total_hits: 0,
          total_cost: 0,
          total_reward: 0
        });
      }

      const agg = strategyMap.get(strategyKey);
      agg.total_rounds += 1;
      agg.total_hits += hit;
      agg.total_cost += cost;
      agg.total_reward += reward;
    }

    draw_detail.push(drawBucket);
  }

  const strategy_detail = [...strategyMap.values()].map((row) => {
    const totalProfit = row.total_reward - row.total_cost;
    const roi = row.total_cost > 0 ? totalProfit / row.total_cost : 0;
    const avgHit = row.total_rounds > 0 ? row.total_hits / row.total_rounds : 0;

    return {
      ...row,
      total_profit: totalProfit,
      roi,
      avg_hit: avgHit
    };
  });

  const totalProfit = totalReward - totalCost;
  const roi = totalCost > 0 ? totalProfit / totalCost : 0;

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
