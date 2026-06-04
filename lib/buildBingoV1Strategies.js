/**
 * buildBingoV1Strategies.js - v23 連號加權版
 *
 * 核心邏輯（版本v3）：
 * 1. 看最近20期，出現4次以上的號碼為熱號
 * 2. 連號分數：開出時旁邊有連號×3 + 出現次數×1
 * 3. 每區段選連號分數最高的前3顆
 * 4. 不夠3顆從其他區段借真熱號補足
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

  // 計算每顆號碼的連號分數和出現次數
  const freqMap = new Map();
  const consecMap = new Map();
  for (let n = 1; n <= 80; n++) {
    freqMap.set(n, 0);
    consecMap.set(n, 0);
  }

  for (const draw of draws) {
    const nums = parseNums(draw.numbers);
    const numSet = new Set(nums);
    for (const n of nums) {
      freqMap.set(n, (freqMap.get(n) || 0) + 1);
      // 連號：旁邊有 n-1 或 n+1
      if (numSet.has(n - 1) || numSet.has(n + 1)) {
        consecMap.set(n, (consecMap.get(n) || 0) + 1);
      }
    }
  }

  // 篩選熱號：20期出現4次以上
  const hotNums = [];
  for (let n = 1; n <= 80; n++) {
    if (freqMap.get(n) >= 4) {
      const score = consecMap.get(n) * 3 + freqMap.get(n) * 1;
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
        if (h.zone === zoneIdx + 1) continue; // 跳過同區段
        // 確認這顆號碼沒有被其他組用過
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

export function getZoneStrategyKeys() {
  return ZONES.map(z => z.key);
}
