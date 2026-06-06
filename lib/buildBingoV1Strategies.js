/**
 * buildBingoV1Strategies.js - v30
 *
 * 邏輯：
 * 1. 熱號策略：四區間篩選（w1>=3,w2>=1,w3>=1,w4>=1）
 *    - 自然全排列，最多輸出8組（取分數最高的8組組合）
 * 2. 冷號備用：熱號不足時（<3顆）改用冷號
 *    - 10期沒開但之前30期有開的號碼
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
  const window30 = recentDraws.slice(0, 30);

  // === 熱號策略 ===
  const hotNums = [];
  for (let n = 1; n <= 80; n++) {
    const w1 = countIn(window1, n);
    const w2 = countIn(window2, n);
    const w3 = countIn(window3, n);
    const w4 = countIn(window4, n);
    if (w1 >= 3 && w2 >= 1 && w3 >= 1 && w4 >= 1) {
      const score = w1 * 4 + w2 * 3 + w3 * 2 + w4 * 1;
      hotNums.push({ num: n, score });
    }
  }

  // 熱號夠3顆：全排列最多8組
  if (hotNums.length >= 3) {
    hotNums.sort((a, b) => b.score - a.score || a.num - b.num);
    const selected = hotNums.map(h => h.num);
    const allCombos = makeCombos(selected);

    // 按組合分數排序取前8組
    const scoredCombos = allCombos.map(combo => ({
      combo,
      score: combo.reduce((s, n) => {
        const h = hotNums.find(h => h.num === n);
        return s + (h ? h.score : 0);
      }, 0)
    }));
    scoredCombos.sort((a, b) => b.score - a.score);
    const top8 = scoredCombos.slice(0, 8);

    return top8.map(({ combo }) => {
      const key = `h${combo[0]}_${combo[1]}_${combo[2]}`;
      return {
        key, label: key,
        nums: combo,
        meta: {
          strategy_key: key,
          strategy_name: key,
          type: 'hot',
          hot_pool: selected.join(','),
          hot_pool_size: selected.length,
        }
      };
    });
  }

  // === 冷號備用策略 ===
  const coldNums = [];
  for (let n = 1; n <= 80; n++) {
    const inRecent10 = countIn(window10, n);
    const inOlder = recentDraws.length >= 30 ? countIn(window30.slice(10), n) : 0;
    if (inRecent10 === 0 && inOlder >= 3) {
      coldNums.push({ num: n, score: inOlder });
    }
  }

  if (coldNums.length < 3) return [];

  // 冷號取分數最高4顆，C(4,3)=4組
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
