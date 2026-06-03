/**
 * buildBingoV1Strategies.js - v20 純覆蓋效率版
 *
 * 核心邏輯：把 1~80 分成8個區段，每組從一個區段選3顆號碼
 * 8組對應8個區段，24個號碼零重疊、最大空間分散
 * 不做熱冷號預測，只做覆蓋效率最大化
 */

// 8個固定區段
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

/**
 * 計算最近20期各號碼出現頻率
 */
function calcFrequency(recentDraws = []) {
  const freqMap = new Map();
  for (let n = 1; n <= 80; n++) freqMap.set(n, 0);
  for (const draw of recentDraws) {
    const nums = String(draw?.numbers || '')
      .split(/\s+/)
      .map(Number)
      .filter(n => n >= 1 && n <= 80);
    for (const n of nums) {
      freqMap.set(n, (freqMap.get(n) || 0) + 1);
    }
  }
  return freqMap;
}

/**
 * 從一個區段選出3顆號碼
 * 選頻率中等的號碼，用 seed 輪替策略確保每期選號有變化
 */
function pickFromZone(zoneNums, freqMap, seed = 0) {
  const sorted = [...zoneNums].sort((a, b) => freqMap.get(a) - freqMap.get(b));
  const low  = sorted.slice(0, 3);
  const mid  = sorted.slice(3, 7);
  const high = sorted.slice(7, 10);

  const picks = [];
  const strategy = seed % 3;

  if (strategy === 0) {
    picks.push(mid[seed % mid.length]);
    picks.push(low[seed % low.length]);
    picks.push(high[seed % high.length]);
  } else if (strategy === 1) {
    picks.push(mid[seed % mid.length]);
    picks.push(mid[(seed + 1) % mid.length]);
    picks.push(low[seed % low.length]);
  } else {
    picks.push(mid[seed % mid.length]);
    picks.push(mid[(seed + 2) % mid.length]);
    picks.push(high[seed % high.length]);
  }

  const unique = [...new Set(picks)];
  if (unique.length < 3) {
    for (const n of sorted) {
      if (!unique.includes(n)) unique.push(n);
      if (unique.length >= 3) break;
    }
  }

  return unique.slice(0, 3);
}

/**
 * 建立8組預測號碼
 */
export function buildBingoGroups(recentDraws = [], latestDrawNo = 0) {
  const freqMap = calcFrequency(recentDraws);

  return ZONES.map((zone, idx) => {
    const seed = (latestDrawNo + idx * 7) % 4;
    const nums = pickFromZone(zone.nums, freqMap, seed);
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
