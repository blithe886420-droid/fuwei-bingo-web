/**
 * buildBingoV1Strategies.js - v27 四週期全排列（確認版）
 *
 * 條件：
 * - 第1~5期出現 >= 3次
 * - 第6~10期出現 >= 1次
 * - 第11~15期出現 >= 1次
 * - 第16~20期出現 >= 1次
 * 平均約3~9顆熱號，平均8.6組
 */

function parseNums(numbers) {
  if (Array.isArray(numbers)) return numbers.map(Number).filter(n => n >= 1 && n <= 80);
  return String(numbers || '').trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 80);
}

function countIn(draws, num) {
  return draws.filter(d => parseNums(d.numbers).includes(num)).length;
}

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0) {
  if (recentDraws.length < 20) return [];

  const window1 = recentDraws.slice(0, 5);
  const window2 = recentDraws.slice(5, 10);
  const window3 = recentDraws.slice(10, 15);
  const window4 = recentDraws.slice(15, 20);

  const hotNums = [];
  for (let n = 1; n <= 80; n++) {
    if (
      countIn(window1, n) >= 3 &&
      countIn(window2, n) >= 1 &&
      countIn(window3, n) >= 1 &&
      countIn(window4, n) >= 1
    ) {
      hotNums.push(n);
    }
  }

  if (hotNums.length < 3) return [];

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
