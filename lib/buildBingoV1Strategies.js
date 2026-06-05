/**
 * buildBingoV1Strategies.js - v25 簡單版C
 *
 * 核心邏輯：最簡單最動態
 * 1. 只看最近3期，出現1次以上的號碼為熱號
 * 2. 每區段選出現頻率最高的前3顆
 * 3. 不夠3顆從本區段內補足
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
  const draws = recentDraws.slice(0, 3);

  // 計算最近3期每顆號碼出現次數
  const freqMap = new Map();
  for (let n = 1; n <= 80; n++) freqMap.set(n, 0);

  for (const draw of draws) {
    for (const n of parseNums(draw.numbers)) {
      freqMap.set(n, (freqMap.get(n) || 0) + 1);
    }
  }

  // 篩選熱號：3期內出現1次以上
  const hotNums = [];
  for (let n = 1; n <= 80; n++) {
    if (freqMap.get(n) >= 1) {
      hotNums.push({ num: n, zone: getZone(n), freq: freqMap.get(n) });
    }
  }

  // 依頻率排序
  hotNums.sort((a, b) => b.freq - a.freq || a.num - b.num);

  // 每個區段取前3顆熱號
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

  // 不夠3顆從本區段補足
  const result = ZONES.map((zone) => {
    const picked = [...(zoneMap.get(zone.key) || [])];

    for (let n = zone.min; n <= zone.max && picked.length < 3; n++) {
      if (!picked.includes(n)) picked.push(n);
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

export function getZoneStrategyKeys() {
  return ZONES.map(z => z.key);
}
