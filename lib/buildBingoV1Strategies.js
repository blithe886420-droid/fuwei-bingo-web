/**
 * buildBingoV1Strategies.js - v24 超級9版
 *
 * 核心邏輯：
 * 1. 20期出現3次以上的號碼為熱號池
 * 2. 排除最近2期開過的號碼
 * 3. 評分：20期頻率×2 + 最近1期出現×10 + 連號×5 + 2~5期出現×1
 * 4. 每區段選分數最高的前3顆
 * 5. 不夠從其他區段借真熱號補足
 */

const ZONES = [
  { key: 'zone_1', min: 1,  max: 10  },
  { key: 'zone_2', min: 11, max: 20  },
  { key: 'zone_3', min: 21, max: 30  },
  { key: 'zone_4', min: 31, max: 40  },
  { key: 'zone_5', min: 41, max: 50  },
  { key: 'zone_6', min: 51, max: 60  },
  { key: 'zone_7', min: 61, max: 70  },
  { key: 'zone_8', min: 71, max: 80  },
];

function getZone(num) {
  return Math.ceil(num / 10);
}

function parseNums(numbers) {
  if (Array.isArray(numbers)) return numbers.map(Number).filter(n => n >= 1 && n <= 80);
  return String(numbers || '').trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 80);
}

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0) {
  const draws = recentDraws.slice(0, 20);
  if (draws.length < 3) return buildFallback();

  const last1 = new Set(parseNums(draws[0]?.numbers || ''));
  const last2 = new Set(parseNums(draws[1]?.numbers || ''));

  // 計算每顆號碼的20期頻率
  const freq20 = new Map();
  for (let n = 1; n <= 80; n++) freq20.set(n, 0);
  for (const draw of draws) {
    for (const n of parseNums(draw.numbers)) {
      freq20.set(n, (freq20.get(n) || 0) + 1);
    }
  }

  // 計算連號分數（最近5期）
  const consecScore = new Map();
  for (let n = 1; n <= 80; n++) consecScore.set(n, 0);
  for (const draw of draws.slice(0, 5)) {
    const nums = parseNums(draw.numbers);
    const numSet = new Set(nums);
    for (const n of nums) {
      if (numSet.has(n - 1) || numSet.has(n + 1)) {
        consecScore.set(n, (consecScore.get(n) || 0) + 1);
      }
    }
  }

  // 計算2~5期出現次數
  const freq5 = new Map();
  for (let n = 1; n <= 80; n++) freq5.set(n, 0);
  for (const draw of draws.slice(1, 5)) {
    for (const n of parseNums(draw.numbers)) {
      freq5.set(n, (freq5.get(n) || 0) + 1);
    }
  }

  // 篩選熱號：20期出現3次以上，排除最近2期
  const hotNums = [];
  for (let n = 1; n <= 80; n++) {
    if (freq20.get(n) >= 3 && !last1.has(n) && !last2.has(n)) {
      const score =
        freq20.get(n) * 2 +
        (last1.has(n) ? 10 : 0) +  // 最近1期（已排除，所以這裡不會觸發，保留結構）
        consecScore.get(n) * 5 +
        freq5.get(n) * 1;
      hotNums.push({ num: n, zone: getZone(n), score });
    }
  }

  // 依分數排序
  hotNums.sort((a, b) => b.score - a.score || a.num - b.num);

  // 每個區段取前3顆
  const zoneMap = new Map();
  for (const z of ZONES) zoneMap.set(z.key, []);

  for (const h of hotNums) {
    const key = `zone_${h.zone}`;
    const arr = zoneMap.get(key) || [];
    if (arr.length < 3) {
      arr.push(h.num);
      zoneMap.set(key, arr);
    }
  }

  // 不夠3顆從其他區段借真熱號補足
  const result = ZONES.map((zone, zoneIdx) => {
    const picked = [...(zoneMap.get(zone.key) || [])];

    if (picked.length < 3) {
      for (const h of hotNums) {
        if (picked.length >= 3) break;
        if (h.zone === zoneIdx + 1) continue;
        const usedElsewhere = ZONES.some((z, i) => {
          if (i === zoneIdx) return false;
          return (zoneMap.get(z.key) || []).includes(h.num);
        });
        if (!usedElsewhere && !picked.includes(h.num)) {
          picked.push(h.num);
        }
      }
    }

    // 最後防線：區段內補足
    if (picked.length < 3) {
      for (let n = zone.min; n <= zone.max && picked.length < 3; n++) {
        if (!picked.includes(n)) picked.push(n);
      }
    }

    return {
      key: zone.key,
      label: zone.key,
      nums: picked.slice(0, 3),
      meta: {
        strategy_key: zone.key,
        strategy_name: zone.key,
        zone_range: `${zone.min}-${zone.max}`,
      }
    };
  });

  return result;
}

function buildFallback() {
  return ZONES.map(zone => ({
    key: zone.key,
    label: zone.key,
    nums: [zone.min, zone.min + 1, zone.min + 2],
    meta: { strategy_key: zone.key, strategy_name: zone.key, zone_range: `${zone.min}-${zone.max}` }
  }));
}

export function getZoneStrategyKeys() {
  return ZONES.map(z => z.key);
}
