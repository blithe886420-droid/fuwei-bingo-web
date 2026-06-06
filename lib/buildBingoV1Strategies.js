/**
 * buildBingoV1Strategies.js - v30 熱號+冷號備用版
 *
 * 邏輯：
 * 1. 熱號策略：四區間篩選（w1>=3,w2>=1,w3>=1,w4>=1）
 *    - 自然全排列，不限制組數
 * 2. 冷號備用：熱號不足時（<3顆）改用冷號
 *    - 10期沒開但之前20期有開的號碼
 *    - 取分數最高4顆做全排列C(4,3)=4組
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

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0) {
  if (recentDraws.length < 20) return [];

  const window1 = recentDraws.slice(0, 5);
  const window2 = recentDraws.slice(5, 10);
  const window3 = recentDraws.slice(10, 15);
  const window4 = recentDraws.slice(15, 20);
  const window10 = recentDraws.slice(0, 10);
  const window11to30 = recentDraws.slice(10, 30);

  // === 熱號策略 ===
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

  // 熱號夠3顆：自然全排列，不限制組數
  if (hotNums.length >= 3) {
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
          hot_pool: hotNums.join(','),
          hot_pool_size: hotNums.length,
        }
      };
    });
  }

  // === 冷號備用策略 ===
  const coldNums = [];
  for (let n = 1; n <= 80; n++) {
    const inRecent10 = countIn(window10, n);
    const inOlder = countIn(window11to30, n);
    if (inRecent10 === 0 && inOlder >= 3) {
      coldNums.push({ num: n, score: inOlder });
    }
  }

  if (coldNums.length < 3) return [];

  coldNums.sort((a, b) => b.score - a.score || a.num - b.num);
  const coldSelected = coldNums.slice(0, 4).map(h => h.num);
  const coldCombos = makeCombos(coldSelected);

  return coldCombos.map(combo => {
    const key = `c${combo[0]}_${combo[1]}_${combo[2]}`;
    return {
      key, label: key,
      nums: combo,
      meta: {
        strategy_key: key,
        strategy_name: key,
        type: 'cold',
        cold_pool: coldSelected.join(','),
        cold_pool_size: coldSelected.length,
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
