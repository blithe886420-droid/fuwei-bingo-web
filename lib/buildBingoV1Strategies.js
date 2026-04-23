function parseNumbers(str) {
  return String(str || "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => String(x).padStart(2, "0"));
}

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function countFreq(rows, weight = 1) {
  const map = {};
  rows.forEach((row) => {
    parseNumbers(row.numbers).forEach((n) => {
      map[n] = (map[n] || 0) + weight;
    });
  });
  return map;
}

function mergeScores(...maps) {
  const merged = {};
  maps.forEach((map) => {
    Object.entries(map || {}).forEach(([num, score]) => {
      merged[num] = (merged[num] || 0) + score;
    });
  });
  return merged;
}

function sortByScore(scoreMap) {
  return Object.entries(scoreMap || {})
    .map(([num, score]) => ({ num, score }))
    .sort((a, b) => b.score - a.score || Number(a.num) - Number(b.num));
}

function getTail(num) {
  return Number(num) % 10;
}

function getZone(num) {
  const n = Number(num);
  if (n <= 20) return "01-20";
  if (n <= 40) return "21-40";
  if (n <= 60) return "41-60";
  return "61-80";
}

function uniq(arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean))];
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function takeTopDistinct(sorted, count, exclude = []) {
  const ex = new Set(exclude);
  const result = [];
  for (const item of sorted || []) {
    if (ex.has(item.num)) continue;
    if (!result.includes(item.num)) result.push(item.num);
    if (result.length >= count) break;
  }
  return result;
}

function takeTopByCondition(sorted, count, condition, exclude = []) {
  const ex = new Set(exclude);
  const result = [];
  for (const item of sorted || []) {
    if (ex.has(item.num)) continue;
    if (!condition(item.num, item.score)) continue;
    if (!result.includes(item.num)) result.push(item.num);
    if (result.length >= count) break;
  }
  return result;
}

function buildTodayRows(allRows) {
  if (!Array.isArray(allRows)) return [];
  return allRows.slice(0, 160);
}

function buildRecentRows(allRows, n) {
  if (!Array.isArray(allRows)) return [];
  return allRows.slice(0, n);
}

function buildHistoryRows(allRows, start, end) {
  if (!Array.isArray(allRows)) return [];
  return allRows.slice(start, end);
}

function normalizeWeightMap(weightMap = {}) {
  return {
    hot_chase: clamp(Number(weightMap.hot_chase || 1), 0.55, 1.85),
    rebound: clamp(Number(weightMap.rebound || 1), 0.55, 1.85),
    zone_balanced: clamp(Number(weightMap.zone_balanced || 1), 0.55, 1.85),
    pattern_structure: clamp(Number(weightMap.pattern_structure || 1), 0.55, 1.85)
  };
}

function buildMarketProfile(rows = []) {
  const allNums = [];
  const recentParsed = (Array.isArray(rows) ? rows : []).map((row) => {
    const nums = parseNumbers(row.numbers);
    allNums.push(...nums);
    return nums;
  });

  const zoneCount = {
    "01-20": 0,
    "21-40": 0,
    "41-60": 0,
    "61-80": 0
  };

  const tailCount = {};
  let oddCount = 0;
  let evenCount = 0;
  let totalSum = 0;
  let totalSpan = 0;
  let validRows = 0;

  recentParsed.forEach((nums) => {
    if (!nums.length) return;

    const intNums = nums.map((n) => Number(n)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!intNums.length) return;

    validRows += 1;
    totalSum += intNums.reduce((acc, n) => acc + n, 0);
    totalSpan += intNums[intNums.length - 1] - intNums[0];

    intNums.forEach((n) => {
      if (n % 2 === 0) evenCount += 1;
      else oddCount += 1;

      const zone = getZone(n);
      zoneCount[zone] += 1;

      const tail = n % 10;
      tailCount[tail] = (tailCount[tail] || 0) + 1;
    });
  });

  const zoneRank = Object.entries(zoneCount)
    .sort((a, b) => b[1] - a[1])
    .map(([zone]) => zone);

  const tailRank = Object.entries(tailCount)
    .sort((a, b) => b[1] - a[1])
    .map(([tail]) => Number(tail));

  const avgSum = validRows > 0 ? totalSum / validRows : 820;
  const avgSpan = validRows > 0 ? totalSpan / validRows : 70;
  const oddRatio = oddCount + evenCount > 0 ? oddCount / (oddCount + evenCount) : 0.5;

  return {
    zoneCount,
    zoneRank,
    tailCount,
    tailRank,
    avgSum,
    avgSpan,
    oddRatio
  };
}

function computeCandidateScores(todayRows, recent20, historyRows) {
  const todayScore = countFreq(todayRows, 4.2);
  const recentScore = countFreq(recent20, 2.3);
  const historyScore = countFreq(historyRows, 0.9);

  const merged = mergeScores(todayScore, recentScore, historyScore);
  const scored = sortByScore(merged);

  return scored.map((item) => {
    const n = Number(item.num);
    const oddBonus = n % 2 === 1 ? 0.18 : 0;
    const midZoneBonus = getZone(n) === "21-40" || getZone(n) === "41-60" ? 0.22 : 0;

    return {
      ...item,
      zone: getZone(item.num),
      tail: getTail(item.num),
      score: item.score + oddBonus + midZoneBonus
    };
  });
}

function sumOf(nums = []) {
  return nums.reduce((acc, n) => acc + Number(n), 0);
}

function spanOf(nums = []) {
  const arr = nums.map((n) => Number(n)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return 0;
  return arr[arr.length - 1] - arr[0];
}

function oddCountOf(nums = []) {
  return nums.map(Number).filter((n) => Number.isFinite(n) && n % 2 === 1).length;
}

function tailDiversity(nums = []) {
  return new Set(nums.map((n) => getTail(n))).size;
}

function scoreGroupShape(nums = [], marketProfile, strategyKey = "") {
  const intNums = nums.map(Number).filter(Number.isFinite);
  if (intNums.length < 3) return -999999;

  const groupSum = sumOf(intNums);
  const groupSpan = spanOf(intNums);
  const oddCount = oddCountOf(intNums);
  const tailKinds = tailDiversity(intNums);
  const zones = intNums.map((n) => getZone(n));
  const zoneKinds = new Set(zones).size;
  const tails = intNums.map((n) => getTail(n));

  let score = 0;

  const targetSum = clamp(marketProfile.avgSum / 5, 120, 220);
  const targetSpan = clamp(marketProfile.avgSpan, 35, 78);

  score -= Math.abs(groupSum - targetSum) * 0.09;
  score -= Math.abs(groupSpan - targetSpan) * 0.12;

  if (oddCount === 2) score += 6;
  else if (oddCount === 1 || oddCount === 3) score += 3;
  else score -= 4;

  if (tailKinds >= 3) score += 3;
  if (zoneKinds >= 3) score += 5;
  else if (zoneKinds === 2) score += 2;

  const hotTailSet = new Set((marketProfile.tailRank || []).slice(0, 3));
  const hotZoneSet = new Set((marketProfile.zoneRank || []).slice(0, 2));

  tails.forEach((t) => {
    if (hotTailSet.has(t)) score += 1.4;
  });

  zones.forEach((z) => {
    if (hotZoneSet.has(z)) score += 1.8;
  });

  const sorted = [...intNums].sort((a, b) => a - b);
  let pairCount = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] === 1) pairCount += 1;
  }

  if (strategyKey === "pattern_structure") {
    score += pairCount * 2.4;
    if (tailKinds <= 2) score += 3.5;
  }

  if (strategyKey === "zone_balanced") {
    score += zoneKinds * 2.2;
  }

  if (strategyKey === "hot_chase") {
    const hotZoneHits = zones.filter((z) => hotZoneSet.has(z)).length;
    score += hotZoneHits * 1.4;
  }

  if (strategyKey === "rebound") {
    if (pairCount === 0) score += 2.5;
    if (zoneKinds >= 3) score += 2.5;
  }

  return score;
}

function buildStructuredGroup(sortedCandidates, marketProfile, strategyKey, options = {}) {
  const exclude = new Set(options.exclude || []);
  const preferredZones = options.preferredZones || [];
  const preferredTail = options.preferredTail;
  const limit = clamp(options.limit || 24, 12, 40);

  const pool = (sortedCandidates || [])
    .filter((item) => !exclude.has(item.num))
    .slice(0, limit);

  if (pool.length < 4) {
    return takeTopDistinct(sortedCandidates, 4, [...exclude]);
  }

  let bestNums = [];
  let bestScore = -999999;

  for (let a = 0; a < pool.length; a += 1) {
    for (let b = a + 1; b < pool.length; b += 1) {
      for (let c = b + 1; c < pool.length; c += 1) {
        for (let d = c + 1; d < pool.length; d += 1) {
          const nums = [pool[a].num, pool[b].num, pool[c].num, pool[d].num];
          const intNums = nums.map(Number);
          let score = nums.reduce((acc, n) => {
            const found = pool.find((x) => x.num === n);
            return acc + (found ? found.score : 0);
          }, 0);

          score += scoreGroupShape(intNums, marketProfile, strategyKey);

          if (preferredZones.length) {
            const zones = intNums.map((n) => getZone(n));
            const zoneHits = zones.filter((z) => preferredZones.includes(z)).length;
            score += zoneHits * 1.6;
          }

          if (preferredTail !== undefined && preferredTail !== null) {
            const tailHits = intNums.filter((n) => getTail(n) === Number(preferredTail)).length;
            score += tailHits * 2.1;
          }

          if (score > bestScore) {
            bestScore = score;
            bestNums = nums;
          }
        }
      }
    }
  }

  return uniq(bestNums).slice(0, 4);
}

function buildHotChase(todayRows, recent20, historyRows, optimizerWeight, marketProfile) {
  const todayScore = countFreq(todayRows, 4 + optimizerWeight * 1.8);
  const recentScore = countFreq(recent20, 2 + optimizerWeight * 1.2);
  const historyScore = countFreq(historyRows, 0.8 + optimizerWeight * 0.4);

  const merged = mergeScores(todayScore, recentScore, historyScore);
  const sorted = sortByScore(merged).map((x) => ({
    ...x,
    zone: getZone(x.num),
    tail: getTail(x.num)
  }));

  const nums = buildStructuredGroup(sorted, marketProfile, "hot_chase", {
    preferredZones: (marketProfile.zoneRank || []).slice(0, 2),
    limit: 22
  });

  return {
    key: "hot_chase",
    label: "熱門追擊型",
    nums,
    reason: "今日盤高頻 + 近20期熱號 + 熱區優先",
    meta: {
      model: "v3",
      optimizerWeight,
      focus: "hot+zone"
    }
  };
}

function buildRebound(todayRows, recent20, historyRows, optimizerWeight, marketProfile) {
  const todayPenalty = 0.9 + (2 - optimizerWeight) * 0.35;
  const recentPenalty = 0.6 + (2 - optimizerWeight) * 0.25;
  const historyBase = 3.2 + optimizerWeight * 1.1;

  const todayScore = countFreq(todayRows, 1);
  const recentScore = countFreq(recent20, 1);
  const historyScore = countFreq(historyRows, historyBase);

  const merged = {};
  const historySorted = sortByScore(historyScore);

  historySorted.forEach(({ num, score }) => {
    const today = todayScore[num] || 0;
    const recent = recentScore[num] || 0;
    merged[num] = score - today * todayPenalty - recent * recentPenalty;
  });

  const sorted = sortByScore(merged)
    .filter((x) => (historyScore[x.num] || 0) > 0)
    .map((x) => ({
      ...x,
      zone: getZone(x.num),
      tail: getTail(x.num)
    }));

  const nums = buildStructuredGroup(sorted, marketProfile, "rebound", {
    preferredZones: (marketProfile.zoneRank || []).slice(1, 4),
    limit: 20
  });

  return {
    key: "rebound",
    label: "回補反彈型",
    nums,
    reason: "長期常見但今日相對沉寂，搭配區段分散抓回補",
    meta: {
      model: "v3",
      optimizerWeight,
      focus: "rebound+spread"
    }
  };
}

function buildZoneBalanced(todayRows, recent20, historyRows, optimizerWeight, marketProfile) {
  const merged = mergeScores(
    countFreq(todayRows, 2.2 + optimizerWeight * 1.0),
    countFreq(recent20, 1.6 + optimizerWeight * 0.8),
    countFreq(historyRows, 0.8 + optimizerWeight * 0.3)
  );

  const sorted = sortByScore(merged).map((x) => ({
    ...x,
    zone: getZone(x.num),
    tail: getTail(x.num)
  }));

  const zoneTargets = marketProfile.zoneRank?.length
    ? marketProfile.zoneRank.slice(0, 4)
    : ["01-20", "21-40", "41-60", "61-80"];

  const nums = [];

  zoneTargets.forEach((zone) => {
    const found = takeTopByCondition(
      sorted,
      1,
      (num) => getZone(num) === zone,
      nums
    );
    nums.push(...found);
  });

  if (nums.length < 4) {
    const补 = buildStructuredGroup(sorted, marketProfile, "zone_balanced", {
      preferredZones: zoneTargets.slice(0, 3),
      exclude: nums,
      limit: 24
    });
    nums.push(...补);
  }

  return {
    key: "zone_balanced",
    label: "區段平衡型",
    nums: uniq(nums).slice(0, 4),
    reason: "四大區段分散配置，兼顧熱區與盤面均衡",
    meta: {
      model: "v3",
      optimizerWeight,
      structure: "zone-balanced"
    }
  };
}

function buildPatternStructure(todayRows, recent20, historyRows, optimizerWeight, marketProfile) {
  const merged = mergeScores(
    countFreq(todayRows, 3 + optimizerWeight * 1.4),
    countFreq(recent20, 1.6 + optimizerWeight * 0.8),
    countFreq(historyRows, 0.8 + optimizerWeight * 0.3)
  );

  const sorted = sortByScore(merged)
    .slice(0, 28)
    .map((x) => ({
      ...x,
      zone: getZone(x.num),
      tail: getTail(x.num)
    }));

  const bestTail = (marketProfile.tailRank || [])[0];
  const nums = buildStructuredGroup(sorted, marketProfile, "pattern_structure", {
    preferredTail: bestTail,
    preferredZones: (marketProfile.zoneRank || []).slice(0, 2),
    limit: 24
  });

  return {
    key: "pattern_structure",
    label: "盤型結構型",
    nums,
    reason: "同尾優先，輔以鄰號、跨度與盤型結構",
    meta: {
      model: "v3",
      optimizerWeight,
      bestTail: bestTail ?? null
    }
  };
}

function dedupeStrategies(strategies = [], sortedCandidates = [], marketProfile) {
  const used = new Set();

  return strategies.map((s, idx) => {
    let nums = uniq(s.nums).slice(0, 4);
    let key = nums.join("-");

    if (nums.length < 4 || used.has(key)) {
      nums = buildStructuredGroup(sortedCandidates, marketProfile, s.key, {
        exclude: [...used].flatMap((k) => k.split("-").map((n) => String(n).padStart(2, "0"))),
        limit: 30
      });
      key = uniq(nums).slice(0, 4).join("-");
    }

    used.add(key);

    return {
      ...s,
      groupNo: idx + 1,
      nums: uniq(nums).slice(0, 4)
    };
  });
}

export function buildBingoV1Strategies(allRows = [], strategyWeightMap = {}, starCount = 4) {
  // ✅ 支援 starCount=3（三星）或 starCount=4（四星，預設）
  const numCount = starCount === 3 ? 3 : 4;

  const weights = normalizeWeightMap(strategyWeightMap);

  const todayRows = buildTodayRows(allRows);
  const recent20 = buildRecentRows(allRows, 20);
  const historyRows = buildHistoryRows(allRows, 20, 500);

  const marketProfile = buildMarketProfile(buildRecentRows(allRows, 50));
  const sortedCandidates = computeCandidateScores(todayRows, recent20, historyRows);

  const s1 = buildHotChase(todayRows, recent20, historyRows, weights.hot_chase, marketProfile);
  const s2 = buildRebound(todayRows, recent20, historyRows, weights.rebound, marketProfile);
  const s3 = buildZoneBalanced(todayRows, recent20, historyRows, weights.zone_balanced, marketProfile);
  const s4 = buildPatternStructure(todayRows, recent20, historyRows, weights.pattern_structure, marketProfile);

  const strategies = dedupeStrategies(
    [s1, s2, s3, s4],
    sortedCandidates,
    marketProfile
  );

  // ✅ 三星模式：每組只取前 numCount 個號碼
  const finalStrategies = strategies.map((s) => ({
    ...s,
    nums: uniq(s.nums).slice(0, numCount)
  }));

  return {
    mode: starCount === 3 ? "bingo_v3_3star_4group_market_profiled" : "bingo_v3_4star_4group_4period_market_profiled",
    target: {
      stars: numCount,
      groups: 4,
      periods: 4
    },
    generatedAt: new Date().toISOString(),
    totalRowsUsed: allRows.length,
    strategyWeights: weights,
    marketProfile,
    strategies: finalStrategies
  };
}
