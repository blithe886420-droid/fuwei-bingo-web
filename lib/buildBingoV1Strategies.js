/**
 * buildBingoV1Strategies.js - v32 SQL回測驗證版
 *
 * 根據11,000+期歷史數據回測結論：
 *
 * ✅ 保留：
 * - 出號條件 pool>=5（期命中率10.16%，遠高於隨機）
 * - 強力出號：爆發→爆發（期命中率16.50%）
 * - 普通出號：觀察→爆發（期命中率13.79%）
 *
 * ❌ 移除：
 * - 解鎖條件 pool>=3（命中率1.20%，低於隨機1.39%，出了虧錢）
 * - 連續跳過強制解鎖（數據證明跳過越久命中率反而下滑）
 * - 反轉期出號（命中率0%，已在v31移除）
 *
 * 四週期條件（不變）：
 * - w1（最近5期）出現 >=3次
 * - w2（第6-10期）出現 >=1次
 * - w3（第11-15期）出現 >=1次
 * - w4（第16-20期）出現 >=1次
 */

function parseNums(numbers) {
  if (Array.isArray(numbers)) return numbers.map(Number).filter(n => n >= 1 && n <= 80);
  return String(numbers || '').trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 80);
}

function countIn(draws, num) {
  return draws.filter(d => parseNums(d.numbers).includes(num)).length;
}

function makeCombos(nums) {
  const combos = [];
  for (let i = 0; i < nums.length; i++)
    for (let j = i + 1; j < nums.length; j++)
      for (let k = j + 1; k < nums.length; k++)
        combos.push([nums[i], nums[j], nums[k]]);
  return combos;
}

function getTaichiPosition({ poolSize, prev1Hit, prev3Hit2 }) {
  // 冷卻期：前一期中3星
  if (prev1Hit >= 3) return '冷卻期';
  // 預熱期：最近3期累積中2的組>=3
  if (prev3Hit2 >= 3) return '預熱期';
  // 爆發期：pool>=5
  if (poolSize >= 5) return '爆發期';
  // 其他：觀察期
  return '觀察期';
}

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0, recentPredictions = []) {
  if (recentDraws.length < 20) return [];

  const window1 = recentDraws.slice(0, 5);
  const window2 = recentDraws.slice(5, 10);
  const window3 = recentDraws.slice(10, 15);
  const window4 = recentDraws.slice(15, 20);

  // 篩選四週期熱號
  const hotNums = [];
  for (let n = 1; n <= 80; n++) {
    const w1 = countIn(window1, n);
    const w2 = countIn(window2, n);
    const w3 = countIn(window3, n);
    const w4 = countIn(window4, n);
    if (w1 >= 3 && w2 >= 1 && w3 >= 1 && w4 >= 1) {
      hotNums.push(n);
    }
  }

  const poolSize = hotNums.length;

  // ★ pool<5 直接跳過，SQL回測證明 pool=3命中率1.2%低於隨機，不值得出號
  if (poolSize < 5) {
    console.log(`[buildBingoGroups] pool=${poolSize} < 5，跳過`);
    return [];
  }

  const prev3 = recentPredictions.slice(0, 3);
  const prev1 = prev3[0] || {};
  const prev1Hit = prev1.hit_count || 0;
  const prev1Pool = prev1.pool_size || 0;
  const prev3Hit2 = prev3.reduce((s, p) => s + (p.hit2_groups || 0), 0);

  // 判斷當前太極位置
  const currentPos = getTaichiPosition({ poolSize, prev1Hit, prev3Hit2 });

  // 判斷前一期太極位置
  const prev1Hit2 = prev3[1] ? (prev3[1].hit2_groups || 0) : 0;
  const prev2Hit2 = prev3[2] ? (prev3[2].hit2_groups || 0) : 0;
  const prev1Pos = getTaichiPosition({
    poolSize: prev1Pool,
    prev1Hit: prev3[1]?.hit_count || 0,
    prev3Hit2: prev1Hit2 + prev2Hit2,
  });

  // 判斷策略
  // SQL4回測：爆發→爆發 16.50%，觀察→爆發 13.79%
  // pool>=5 一律出號，前期狀態決定是否為強力出號
  let action = '出號';
  if (prev1Pos === '爆發期' && currentPos === '爆發期') {
    action = '強力出號';  // 16.50% 期命中率
  }

  console.log(`[buildBingoGroups] 位置=${currentPos} 前期=${prev1Pos} 策略=${action} pool=${poolSize}`);

  if (hotNums.length < 3) return [];

  const combos = makeCombos(hotNums);
  return combos.map(combo => {
    const key = `h${combo[0]}_${combo[1]}_${combo[2]}`;
    return {
      key,
      label: key,
      nums: combo,
      meta: {
        strategy_key: key,
        strategy_name: key,
        type: 'hot',
        action,
        position: currentPos,
        prev_position: prev1Pos,
        hot_pool: hotNums.join(','),
        hot_pool_size: poolSize,
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
