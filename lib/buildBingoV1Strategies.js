/**
 * buildBingoV1Strategies.js - v21 純隨機覆蓋版
 *
 * 核心邏輯：把 1~80 分成8個區段，每組從一個區段隨機選3顆
 * 用 draw_no 當 seed 確保每期不同，但可重現
 */

const ZONES = [
  { key: 'zone_1', nums: [1,2,3,4,5,6,7,8,9,10] },
  { key: 'zone_2', nums: [11,12,13,14,15,16,17,18,19,20] },
  { key: 'zone_3', nums: [21,22,23,24,25,26,27,28,29,30] },
  { key: 'zone_4', nums: [31,32,33,34,35,36,37,38,39,40] },
  { key: 'zone_5', nums: [41,42,43,44,45,46,47,48,49,50] },
  { key: 'zone_6', nums: [51,52,53,54,55,56,57,58,59,60] },
  { key: 'zone_7', nums: [61,62,63,64,65,66,67,68,69,70] },
  { key: 'zone_8', nums: [71,72,73,74,75,76,77,78,79,80] },
];

// 簡單的確定性亂數（LCG），用 seed 確保每期結果不同但可重現
function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

// 從區段隨機選3顆（Fisher-Yates shuffle）
function pickRandom(nums, rand) {
  const arr = [...nums];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 3);
}

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0) {
  return ZONES.map((zone, idx) => {
    const seed = (latestDrawNo * 31 + idx * 1000003) >>> 0;
    const rand = seededRandom(seed);
    const nums = pickRandom(zone.nums, rand);
    return {
      key: zone.key,
      label: zone.key,
      nums,
      meta: {
        strategy_key: zone.key,
        strategy_name: zone.key,
        zone_range: `${zone.nums[0]}-${zone.nums[9]}`,
      }
    };
  });
}

export function getZoneStrategyKeys() {
  return ZONES.map(z => z.key);
}
