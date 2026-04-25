export function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .replace(/[{}[\]]/g, ' ')
      .split(/[,\s|/]+/)
      .map(Number)
      .filter(Number.isFinite);
  }

  if (value && typeof value === 'object') {
    const candidates = [
      value.numbers,
      value.draw_numbers,
      value.nums,
      value.result
    ];

    for (const item of candidates) {
      const parsed = parseDrawNumbers(item);
      if (parsed.length > 0) return parsed;
    }
  }

  return [];
}

/**
 * ✅ 支援多星等獎金結構
 * starMode: 3 = 三星, 4 = 四星（預設）
 */
function calcReward(hit, starMode = 4) {
  if (starMode === 3) {
    if (hit >= 3) return 500;
    if (hit === 2) return 50;
    return 0;
  }
  // 四星（原本邏輯）
  if (hit >= 4) return 1000;
  if (hit === 3) return 100;
  if (hit === 2) return 25;
  return 0;
}

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function normalizeGroups(groups = [], starMode = 4) {
  const numsLength = starMode === 3 ? 3 : 4;

  return (Array.isArray(groups) ? groups : [])
    .map((group, idx) => {
      if (!group || typeof group !== 'object') return null;

      const numsSource = Array.isArray(group.nums)
        ? group.nums
        : Array.isArray(group.numbers)
          ? group.numbers
          : Array.isArray(group.values)
            ? group.values
            : [];

      const nums = [...new Set(numsSource.map(Number).filter(Number.isFinite))].slice(0, numsLength);
      if (nums.length !== numsLength) return null;

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

function buildStrategyAggBase(strategyKey = '', strategyName = '') {
  return {
    strategy_key: strategyKey,
    strategy_name: strategyName,
    total_rounds: 0,
    total_hits: 0,
    total_cost: 0,
    total_reward: 0,
    hit1: 0,
    hit2: 0,
    hit3: 0,
    hit4: 0,
    hit0: 0
  };
}

export function buildComparePayload({
  groups = [],
  drawRows = [],
  costPerGroupPerPeriod = 25,
  starMode = 4  // ✅ 新增：支援 3 或 4，預設 4
}) {
  const safeGroups = normalizeGroups(groups, starMode);
  const safeDrawRows = Array.isArray(drawRows) ? drawRows : [];

  if (!safeGroups.length || !safeDrawRows.length) {
    return {
      hitCount: 0,
      verdict: 'bad',
      compareResult: {
        detail: [],
        draw_detail: [],
        strategy_detail: [],
        best_hit: 0,
        best_reward: 0,
        best_group: null,
        total_hit: 0,
        total_cost: 0,
        total_reward: 0,
        total_profit: 0,
        roi: 0
      }
    };
  }

  let bestHit = 0;
  let bestReward = 0;
  let bestGroup = null;

  let totalHit = 0;
  let totalCost = 0;
  let totalReward = 0;

  const detail = [];
  const draw_detail = [];
  const strategyMap = new Map();

  for (const draw of safeDrawRows) {
    const drawNo = Number(draw?.draw_no || 0) || null;

    const nums = parseDrawNumbers(
      draw?.numbers ??
      draw?.draw_numbers ??
      draw?.result_numbers ??
      draw?.open_numbers
    );

    const drawBucket = {
      draw_no: drawNo,
      groups: [],
      best_hit: 0,
      best_reward: 0,
      best_group: null,
      total_hit: 0,
      total_cost: 0,
      total_reward: 0,
      hit0: 0,
      hit1: 0,
      hit2: 0,
      hit3: 0,
      hit4: 0
    };

    for (const group of safeGroups) {
      const hit = group.nums.filter((n) => nums.includes(n)).length;
      const reward = calcReward(hit, starMode);  // ✅ 傳入 starMode
      const cost = Number(costPerGroupPerPeriod) || 25;

      const strategyKey = String(group.meta?.strategy_key || group.key);
      const strategyName = String(group.meta?.strategy_name || group.label || strategyKey);

      totalHit += hit;
      totalCost += cost;
      totalReward += reward;

      drawBucket.total_hit += hit;
      drawBucket.total_cost += cost;
      drawBucket.total_reward += reward;

      if (hit > bestHit || (hit === bestHit && reward > bestReward)) {
        bestHit = hit;
        bestReward = reward;
        bestGroup = {
          draw_no: drawNo,
          strategy_key: strategyKey,
          strategy_name: strategyName,
          hit,
          cost,
          reward,
          nums: group.nums
        };
      }

      if (hit > drawBucket.best_hit || (hit === drawBucket.best_hit && reward > drawBucket.best_reward)) {
        drawBucket.best_hit = hit;
        drawBucket.best_reward = reward;
        drawBucket.best_group = {
          draw_no: drawNo,
          strategy_key: strategyKey,
          strategy_name: strategyName,
          hit,
          cost,
          reward,
          nums: group.nums
        };
      }

      if (hit <= 0) drawBucket.hit0 += 1;
      if (hit === 1) drawBucket.hit1 += 1;
      if (hit === 2) drawBucket.hit2 += 1;
      if (hit === 3) drawBucket.hit3 += 1;
      if (hit >= 4) drawBucket.hit4 += 1;

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
        strategyMap.set(
          strategyKey,
          buildStrategyAggBase(strategyKey, strategyName)
        );
      }

      const agg = strategyMap.get(strategyKey);
      agg.total_rounds += 1;
      agg.total_hits += hit;
      agg.total_cost += cost;
      agg.total_reward += reward;

      if (hit <= 0) agg.hit0 += 1;
      if (hit === 1) agg.hit1 += 1;
      if (hit === 2) agg.hit2 += 1;
      if (hit === 3) agg.hit3 += 1;
      if (hit >= 4) agg.hit4 += 1;
    }

    draw_detail.push(drawBucket);
  }

  const strategy_detail = [...strategyMap.values()].map((row) => {
    const totalProfit = row.total_reward - row.total_cost;
    const roi = row.total_cost > 0 ? totalProfit / row.total_cost : 0;
    const avgHit = row.total_rounds > 0 ? row.total_hits / row.total_rounds : 0;

    const hit0Rate = row.total_rounds > 0 ? row.hit0 / row.total_rounds : 0;
    const hit1Rate = row.total_rounds > 0 ? row.hit1 / row.total_rounds : 0;
    const hit2Rate = row.total_rounds > 0 ? row.hit2 / row.total_rounds : 0;
    const hit3Rate = row.total_rounds > 0 ? row.hit3 / row.total_rounds : 0;
    const hit4Rate = row.total_rounds > 0 ? row.hit4 / row.total_rounds : 0;

    return {
      ...row,
      total_profit: totalProfit,
      roi: round4(roi),
      avg_hit: round4(avgHit),

      hit0_count: row.hit0,
      hit1_count: row.hit1,
      hit2_count: row.hit2,
      hit3_count: row.hit3,
      hit4_count: row.hit4,

      hit0: row.hit0,
      hit1: row.hit1,
      hit2: row.hit2,
      hit3: row.hit3,
      hit4: row.hit4,

      hit0_rate: round4(hit0Rate),
      hit1_rate: round4(hit1Rate),
      hit2_rate: round4(hit2Rate),
      hit3_rate: round4(hit3Rate),
      hit4_rate: round4(hit4Rate)
    };
  });

  const totalProfit = totalReward - totalCost;
  const roi = totalCost > 0 ? totalProfit / totalCost : 0;

  // ✅ 覆蓋率計算：統計所有組的號碼覆蓋了哪些號碼
  const allCoveredNums = [...new Set(safeGroups.flatMap(g => g.nums))];
  const coverageCount = allCoveredNums.length; // 覆蓋了幾個不同號碼

  // ✅ 每期開獎號碼有幾個落在覆蓋範圍內
  const coverageHitPerDraw = draw_detail.map(d => {
    const drawNums = parseDrawNumbers(
      safeDrawRows.find(r => Number(r?.draw_no) === d.draw_no)?.numbers || []
    );
    const coverageHit = drawNums.filter(n => allCoveredNums.includes(n)).length;
    return {
      draw_no: d.draw_no,
      coverage_hit: coverageHit,        // 開獎20個號碼裡有幾個在覆蓋範圍內
      coverage_hit_rate: round4(coverageHit / Math.max(drawNums.length, 1))
    };
  });

  const avgCoverageHit = coverageHitPerDraw.length > 0
    ? round4(coverageHitPerDraw.reduce((a, b) => a + b.coverage_hit, 0) / coverageHitPerDraw.length)
    : 0;

  return {
    hitCount: bestHit,
    verdict: bestReward > 0 ? 'good' : 'bad',
    compareResult: {
      detail,
      draw_detail,
      strategy_detail,
      best_hit: bestHit,
      best_reward: bestReward,
      best_group: bestGroup,
      total_hit: totalHit,
      total_cost: totalCost,
      total_reward: totalReward,
      total_profit: totalProfit,
      roi: round4(roi),
      // ✅ 新增覆蓋率數據
      coverage_nums: allCoveredNums,          // 這期覆蓋的所有號碼
      coverage_count: coverageCount,           // 覆蓋幾個不同號碼
      coverage_hit_per_draw: coverageHitPerDraw, // 每期開獎號碼落在覆蓋範圍內幾個
      avg_coverage_hit: avgCoverageHit          // 平均覆蓋命中數
    }
  };
}
