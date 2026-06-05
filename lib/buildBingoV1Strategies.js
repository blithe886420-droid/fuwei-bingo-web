/**
 * buildBingoV1Strategies.js - v26 四週期全排列版（修正）
 *
 * 核心邏輯：
 * 1. 四個獨立區間都出現過的號碼才是穩定熱號
 *    - 第1~5期 出現過
 *    - 第6~10期 出現過
 *    - 第11~15期 出現過
 *    - 第16~20期 出現過
 * 2. 這些號碼全排列 C(n,3)，有幾組就幾組
 * 3. 不夠3顆就不出
 */

function parseNums(numbers) {
  if (Array.isArray(numbers)) return numbers.map(Number).filter(n => n >= 1 && n <= 80);
  return String(numbers || '').trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 80);
}

function appearsIn(draws, num) {
  return draws.some(d => parseNums(d.numbers).includes(num));
}

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0) {
  if (recentDraws.length < 20) return [];

  // 四個獨立區間
  const window1 = recentDraws.slice(0, 5);   // 最近1~5期
  const window2 = recentDraws.slice(5, 10);  // 最近6~10期
  const window3 = recentDraws.slice(10, 15); // 最近11~15期
  const window4 = recentDraws.slice(15, 20); // 最近16~20期

  // 四個區間都出現過才是穩定熱號
  const hotNums = [];
  for (let n = 1; n <= 80; n++) {
    if (
      appearsIn(window1, n) &&
      appearsIn(window2, n) &&
      appearsIn(window3, n) &&
      appearsIn(window4, n)
    ) {
      hotNums.push(n);
    }
  }

  // 不夠3顆就不出
  if (hotNums.length < 3) return [];

  // 全排列 C(n,3)
  const groups = [];
  for (let i = 0; i < hotNums.length; i++) {
    for (let j = i + 1; j < hotNums.length; j++) {
      for (let k = j + 1; k < hotNums.length; k++) {
        const nums = [hotNums[i], hotNums[j], hotNums[k]];
        const key = `h${hotNums[i]}_${hotNums[j]}_${hotNums[k]}`;
        groups.push({
          key,
          label: key,
          nums,
          meta: {
            strategy_key: key,
            strategy_name: key,
            hot_pool: hotNums.join(','),
            hot_pool_size: hotNums.length,
          }
        });
      }
    }
  }

  return groups;
}

export function getZoneStrategyKeys() {
  return [];
}
