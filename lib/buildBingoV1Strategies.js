function parseNumbers(str) {
  return String(str || "")
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => String(x).padStart(2, "0"));
}

function countFreq(rows, weight = 1) {
  const map = {};
  rows.forEach(row => {
    parseNumbers(row.numbers).forEach(n => {
      map[n] = (map[n] || 0) + weight;
    });
  });
  return map;
}

function mergeScores(...maps) {
  const merged = {};
  maps.forEach(map => {
    Object.entries(map).forEach(([num, score]) => {
      merged[num] = (merged[num] || 0) + score;
    });
  });
  return merged;
}

function sortByScore(scoreMap) {
  return Object.entries(scoreMap)
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
  return [...new Set(arr)];
}

function takeTopDistinct(sorted, count, exclude = []) {
  const ex = new Set(exclude);
  const result = [];
  for (const item of sorted) {
    if (ex.has(item.num)) continue;
    if (!result.includes(item.num)) result.push(item.num);
    if (result.length >= count) break;
  }
  return result;
}

function takeTopByCondition(sorted, count, condition, exclude = []) {
  const ex = new Set(exclude);
  const result = [];
  for (const item of sorted) {
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

function buildHotChase(todayRows, recent20, historyRows) {
  const todayScore = countFreq(todayRows, 5);
  const recentScore = countFreq(recent20, 3);
  const historyScore = countFreq(historyRows, 1);

  const merged = mergeScores(todayScore, recentScore, historyScore);
  const sorted = sortByScore(merged);

  const nums = takeTopDistinct(sorted, 4);

  return {
    key: "hot_chase",
    label: "熱門追擊型",
    nums,
    reason: "今日盤高頻 + 近20期熱號 + 長期底盤",
    meta: {
      model: "v1",
      weights: {
        today: 5,
        recent20: 3,
        history: 1
      }
    }
  };
}

function buildRebound(todayRows, recent20, historyRows) {
  const todayScore = countFreq(todayRows, 1);
  const recentScore = countFreq(recent20, 1);
  const historyScore = countFreq(historyRows, 4);

  const merged = {};
  const historySorted = sortByScore(historyScore);

  historySorted.forEach(({ num, score }) => {
    const today = todayScore[num] || 0;
    const recent = recentScore[num] || 0;
    merged[num] = score - today * 1.2 - recent * 0.8;
  });

  const sorted = sortByScore(merged)
    .filter(x => (historyScore[x.num] || 0) > 0);

  const nums = takeTopDistinct(sorted, 4);

  return {
    key: "rebound",
    label: "回補反彈型",
    nums,
    reason: "長期常見但今日相對沉寂，嘗試抓回補",
    meta: {
      model: "v1",
      weights: {
        historyBase: 4,
        todayPenalty: 1.2,
        recentPenalty: 0.8
      }
    }
  };
}

function buildZoneBalanced(todayRows, recent20, historyRows) {
  const merged = mergeScores(
    countFreq(todayRows, 3),
    countFreq(recent20, 2),
    countFreq(historyRows, 1)
  );

  const sorted = sortByScore(merged);

  const zoneTargets = ["01-20", "21-40", "41-60", "61-80"];
  const nums = [];

  zoneTargets.forEach(zone => {
    const found = takeTopByCondition(
      sorted,
      1,
      num => getZone(num) === zone,
      nums
    );
    nums.push(...found);
  });

  if (nums.length < 4) {
    nums.push(...takeTopDistinct(sorted, 4 - nums.length, nums));
  }

  return {
    key: "zone_balanced",
    label: "區段平衡型",
    nums: nums.slice(0, 4),
    reason: "四大區段分散配置，降低單區過熱風險",
    meta: {
      model: "v1",
      structure: "1 zone x 4"
    }
  };
}

function buildPatternStructure(todayRows, recent20, historyRows) {
  const merged = mergeScores(
    countFreq(todayRows, 4),
    countFreq(recent20, 2),
    countFreq(historyRows, 1)
  );

  const sorted = sortByScore(merged).slice(0, 20);

  const tailMap = {};
  sorted.forEach(({ num, score }) => {
    const t = getTail(num);
    tailMap[t] = (tailMap[t] || 0) + score;
  });

  const bestTail = Object.entries(tailMap)
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  let nums = takeTopByCondition(
    sorted,
    4,
    num => String(getTail(num)) === String(bestTail)
  );

  if (nums.length < 4) {
    const topNums = sorted.map(x => Number(x.num)).sort((a, b) => a - b);
    for (let i = 0; i < topNums.length; i++) {
      const n = topNums[i];
      if (topNums.includes(n + 1)) {
        nums = uniq([
          ...nums,
          String(n).padStart(2, "0"),
          String(n + 1).padStart(2, "0")
        ]);
      }
      if (nums.length >= 4) break;
    }
  }

  if (nums.length < 4) {
    nums.push(...takeTopDistinct(sorted, 4 - nums.length, nums));
  }

  return {
    key: "pattern_structure",
    label: "盤型結構型",
    nums: nums.slice(0, 4),
    reason: "同尾優先，輔以鄰號與盤型結構",
    meta: {
      model: "v1",
      bestTail: bestTail ?? null
    }
  };
}

export function buildBingoV1Strategies(allRows = []) {
  const todayRows = buildTodayRows(allRows);
  const recent20 = buildRecentRows(allRows, 20);
  const historyRows = buildHistoryRows(allRows, 20, 500);

  const s1 = buildHotChase(todayRows, recent20, historyRows);
  const s2 = buildRebound(todayRows, recent20, historyRows);
  const s3 = buildZoneBalanced(todayRows, recent20, historyRows);
  const s4 = buildPatternStructure(todayRows, recent20, historyRows);

  const strategies = [s1, s2, s3, s4].map((s, idx) => ({
    ...s,
    groupNo: idx + 1,
    nums: uniq(s.nums).slice(0, 4)
  }));

  return {
    mode: "bingo_v1_4star_4group_4period",
    target: {
      stars: 4,
      groups: 4,
      periods: 4
    },
    generatedAt: new Date().toISOString(),
    totalRowsUsed: allRows.length,
    strategies
  };
}
