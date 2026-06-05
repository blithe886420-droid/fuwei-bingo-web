/**
 * buildBingoV1Strategies.js - v26 四週期全排列版
 *
 * 核心邏輯：
 * 1. 找出5期、10期、15期、20期都出現過的穩定熱號
 * 2. 這些號碼全排列 C(n,3)，有幾組就幾組
 * 3. 不夠3顆熱號就不出（回傳空陣列）
 */

function parseNums(numbers) {
  if (Array.isArray(numbers)) return numbers.map(Number).filter(n => n >= 1 && n <= 80);
  return String(numbers || '').trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 80);
}

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0) {
  if (recentDraws.length < 20) return [];

  const draws5  = recentDraws.slice(0, 5);
  const draws10 = recentDraws.slice(0, 10);
  const draws15 = recentDraws.slice(0, 15);
  const draws20 = recentDraws.slice(0, 20);

  function countFreq(draws, num) {
    return draws.filter(d => parseNums(d.numbers).includes(num)).length;
  }

  // 篩選四週期穩定熱號
  const hotNums = [];
  for (let n = 1; n <= 80; n++) {
    if (
      countFreq(draws5,  n) >= 1 &&
      countFreq(draws10, n) >= 2 &&
      countFreq(draws15, n) >= 3 &&
      countFreq(draws20, n) >= 4
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
            zone_range: `${nums[0]}-${nums[2]}`,
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
