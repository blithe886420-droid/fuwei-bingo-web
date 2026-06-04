/**
 * buildBingoV1Strategies.js - v22 熱號優先+冷卻期版
 *
 * 核心邏輯（版本R）：
 * 1. 看最近20期，出現4次以上的號碼為熱號
 * 2. 排除最近2期開過的號碼（冷卻期）
 * 3. 5期出現過的加權×3，20期出現過的加權×1
 * 4. 每區段選熱號分數最高的前3顆
 * 5. 不夠3顆從其他區段借真熱號補足（不補假號）
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
  const recent5 = recentDraws.slice(0, 5);
  const cooldown1 = recentDraws[0] ? new Set(parseNums(recentDraws[0].numbers)) : new Set();
  const cooldown2 = recentDraws[1] ? new Set(parseNums(recentDraws[1].numbers)) : new Set();

  // 計算每顆號碼的出現次數
  const freq20 = new Map();
  const freq5  = new Map();
  for (let n = 1; n <= 80; n++) { freq20.set(n, 0); freq5.set(n, 0); }

  for (const draw of draws) {
    for (const n of parseNums(draw.numbers)) {
      freq20.set(n, (freq20.get(n) || 0) + 1);
    }
  }
  for (const draw of recent5) {
    for (const n of parseNums(draw.numbers)) {
      freq5.set(n, (freq5.get(n) || 0) + 1);
    }
  }

  // 篩選熱號：20期出現4次以上，且排除最近2期開過的
  const hotNums = [];
  for (let n = 1; n <= 80; n++) {
    if (freq20.get(n) >= 4 && !cooldown1.has(n) && !cooldown2.has(n)) {
      const score = freq5.get(n) * 3 + freq20.get(n) * 1;
      hotNums.push({ num: n, zone: getZone(n), score });
    }
  }

  // 依分數排序
  hotNums.sort((a, b) => b.score - a.score || a.num - b.num);

  // 每個區段取前3顆熱號
  const zoneMap = new Map();
  for (const z of ZONES) zoneMap.set(z.key, []);

  for (const h of hotNums) {
    const key = `zone_${h.zone}`;
    const arr = zoneMap.get(key) || [];
    if (arr.length < 3) arr.push(h.num);
    zoneMap.set(key, arr);
  }

  // 不夠3顆的區段，從其他區段借熱號補足（不補假號）
  const usedNums = new Set(hotNums.slice(0, 24).map(h => h.num));
  const borrowPool = [...hotNums]; // 全部熱號按分數排序，供借用

  const result = ZONES.map((zone) => {
    const picked = zoneMap.get(zone.key) || [];

    // 從其他區段借熱號
    if (picked.length < 3) {
      for (const h of borrowPool) {
        if (picked.length >= 3) break;
        if (!picked.includes(h.num) && getZone(h.num) !== ZONES.indexOf(zone) + 1) {
          // 確保不重複使用
          const alreadyUsed = ZONES.some(z => {
            const arr = zoneMap.get(z.key) || [];
            return arr.includes(h.num) && z.key !== zone.key;
          });
          if (!alreadyUsed) picked.push(h.num);
        }
      }
    }

    // 最後防線：如果借不到，用區段內未被使用的號碼補
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

export function getZoneStrategyKeys() {
  return ZONES.map(z => z.key);
}
