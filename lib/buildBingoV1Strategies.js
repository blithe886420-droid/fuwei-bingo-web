/**
 * buildBingoV1Strategies.js - v31 四象太極狀態機版（解鎖修正）
 *
 * 策略（根據SQL數據驗證）：
 * - 強力出號：前一期預熱期 + 本期爆發期（pool>=5）→ 回測40%命中率
 * - 出號：爆發期且pool>=5 → 回測14.81%
 * - 解鎖出號：連續跳過>=3期且pool>=3 → 避免系統卡死無限跳過
 * - 跳過：反轉期（數據證明無效）/ pool不足 / 其他
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

function getTaichiPosition({ poolSize, prev1Hit, prev3Skips, prev3Hit2 }) {
  if (prev1Hit >= 3) return '冷卻期';
  if (prev3Hit2 >= 3) return '預熱期';
  if (prev3Skips >= 3) return '反轉期';
  if (poolSize >= 5) return '爆發期';
  return '觀察期';
}

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0, recentPredictions = []) {
  if (recentDraws.length < 20) return [];

  const window1 = recentDraws.slice(0, 5);
  const window2 = recentDraws.slice(5, 10);
  const window3 = recentDraws.slice(10, 15);
  const window4 = recentDraws.slice(15, 20);

  // 篩選熱號
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
  const prev3 = recentPredictions.slice(0, 3);
  const prev1 = prev3[0] || {};
  const prev1Hit = prev1.hit_count || 0;
  const prev1Pool = prev1.pool_size || 0;
  const prev3Skips = prev3.filter(p => p.status === 'skipped' || p.groups_count === 0).length;
  const prev3Hit2 = prev3.reduce((s, p) => s + (p.hit2_groups || 0), 0);

  // 判斷當前太極位置
  const currentPos = getTaichiPosition({ poolSize, prev1Hit, prev3Skips, prev3Hit2 });

  // 判斷前一期太極位置
  const prev1Pos = getTaichiPosition({
    poolSize: prev1Pool,
    prev1Hit: prev3[1]?.hit_count || 0,
    prev3Skips: prev3.slice(1).filter(p => p.status === 'skipped' || p.groups_count === 0).length,
    prev3Hit2: prev3.slice(1).reduce((s, p) => s + (p.hit2_groups || 0), 0),
  });

  // ★ 解鎖條件：連續跳過>=3期，系統卡死時降門檻出號
  const isStuck = prev3Skips >= 3;

  // 判斷策略
  let action = '跳過';

  // 強力出號：預熱期→爆發期 且 pool>=5
  if (prev1Pos === '預熱期' && currentPos === '爆發期' && poolSize >= 5) {
    action = '強力出號';
  }
  // 出號：爆發期 且 pool>=5
  else if (currentPos === '爆發期' && poolSize >= 5) {
    action = '出號';
  }
  // ★ 解鎖出號：連續跳過>=3期 且 pool>=3，打破卡死迴圈
  else if (isStuck && poolSize >= 3) {
    action = '出號';
  }
  // 其他全部跳過（包含反轉期，數據證明無效）

  console.log(`[buildBingoGroups] 位置=${currentPos} 前期=${prev1Pos} 策略=${action} pool=${poolSize} 連續跳過=${prev3Skips}`);

  if (action === '跳過') return [];
  if (hotNums.length < 3) return [];

  const combos = makeCombos(hotNums);
  return combos.map(combo => {
    const key = `h${combo[0]}_${combo[1]}_${combo[2]}`;
    return {
      key, label: key,
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
        is_stuck_unlock: isStuck,  // ★ 標記是否為解鎖出號
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
