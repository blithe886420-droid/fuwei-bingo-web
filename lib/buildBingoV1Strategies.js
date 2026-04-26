// ✅ 從 marketSnapshot 正確解析熱號
// hot_windows.hot_5 結構：{items: [{num, count}], numbers: [...], map: {...}}
// items 已按 count 排序，取前 topN 個就是最熱的號碼
function extractHotNumbers(marketSnapshot, windowKey = 'hot_5', topN = 5) {
  const windowData = marketSnapshot?.hot_windows?.[windowKey];
  if (!windowData) return [];

  // 優先用 items（已排序，最準確）
  if (Array.isArray(windowData?.items) && windowData.items.length > 0) {
    return windowData.items
      .sort((a, b) => b.count - a.count)
      .slice(0, topN)
      .map(x => x.num);
  }

  // fallback: 用 map 排序
  const mapData = windowData?.map;
  if (mapData && typeof mapData === 'object' && !Array.isArray(mapData)) {
    return Object.entries(mapData)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, topN)
      .map(([num]) => Number(num));
  }

  return [];
}

// ✅ 從 marketSnapshot 正確解析 streak 號碼
// streak2/3/4 直接在 snapshot 頂層，也在 streaks 裡
function extractStreakNumbers(marketSnapshot, streakKey = 'streak3') {
  // 先讀頂層（buildRecentMarketSignalSnapshot 直接展開了）
  const direct = marketSnapshot?.[streakKey];
  if (Array.isArray(direct)) return direct;
  // fallback: 讀 streaks 巢狀結構
  const nested = marketSnapshot?.streaks?.[streakKey];
  if (Array.isArray(nested)) return nested;
  return [];
}

// ✅ 從 marketSnapshot 解析 gap/cold 號碼（來自 decision_basis）
function extractGapNumbers(marketSnapshot, topN = 15) {
  // gap 號碼在 decision_basis.extend_numbers 裡
  const extend = marketSnapshot?.decision_basis?.extend_numbers;
  if (Array.isArray(extend)) return extend.slice(0, topN);
  return [];
}

function extractColdNumbers(marketSnapshot, topN = 10) {
  // cold 號碼：不在 guard_numbers 裡但在 extend 裡的
  const guard = marketSnapshot?.decision_basis?.guard_numbers;
  if (Array.isArray(guard)) return guard.slice(0, topN);
  return [];
}


// ============================================================
// ✅ 優化一：號碼間距分析
// 80個號碼每期選20個，分析相鄰被選號碼的間距分布
// 間距分布均勻的選號組合，覆蓋面更廣，中3機率更高
// ============================================================
function calcSpacingScore(nums = []) {
  const sorted = nums.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 2) return 0;
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i] - sorted[i - 1]);
  }
  // 標準差越小 → 間距越均勻 → 覆蓋越分散
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - avg) ** 2, 0) / gaps.length;
  const stdDev = Math.sqrt(variance);
  // 間距均勻加分（stdDev 越小越好），間距理想值大約是 80/(numCount+1)
  return Math.max(0, 10 - stdDev * 0.5);
}

// ============================================================
// ✅ 優化一：同尾號碼週期分析
// 個位數相同的號碼（如 1,11,21,31,41,51,61,71）有出現週期性
// 統計近期每個尾數的出現頻率，選尾數分散的組合
// ============================================================
function calcTailDiversityScore(nums = [], recentRows = []) {
  const intNums = nums.map(Number).filter(Number.isFinite);
  // 這組號碼的尾數集合
  const tails = intNums.map(n => n % 10);
  const uniqueTails = new Set(tails);
  // 尾數越分散越好（三星3個號碼，最好3個不同尾數）
  const diversityScore = uniqueTails.size * 3;

  // 近20期每個尾數的出現次數
  const tailFreq = {};
  for (let t = 0; t <= 9; t++) tailFreq[t] = 0;
  recentRows.slice(0, 20).forEach(row => {
    const rowNums = parseNumbers(row.numbers).map(n => Number(n));
    rowNums.forEach(n => { tailFreq[n % 10] = (tailFreq[n % 10] || 0) + 1; });
  });

  // 選到近期熱門尾數加分
  let hotTailScore = 0;
  const sortedTails = Object.entries(tailFreq).sort((a, b) => b[1] - a[1]);
  const hotTails = new Set(sortedTails.slice(0, 4).map(([t]) => Number(t)));
  tails.forEach(t => { if (hotTails.has(t)) hotTailScore += 2; });

  return diversityScore + hotTailScore;
}

// ============================================================
// ✅ 優化一：跨期間隔分析（回補傾向）
// 計算每個號碼距上次出現的期數
// 超過平均間隔的號碼有統計上的回補傾向
// ============================================================
function buildGapAnalysis(allRows = []) {
  const lastSeen = {}; // 每個號碼最後出現在第幾期（0=最新）
  const appearCount = {};

  allRows.slice(0, 80).forEach((row, periodIdx) => {
    const nums = parseNumbers(row.numbers).map(n => Number(n));
    nums.forEach(n => {
      if (lastSeen[n] === undefined) lastSeen[n] = periodIdx;
      appearCount[n] = (appearCount[n] || 0) + 1;
    });
  });

  // 平均每個號碼出現間隔 = 80期 / (總出現次數/80個號碼)
  // 賓果每期開20個，理論間隔 = 80/20 = 4 期
  const result = {};
  for (let n = 1; n <= 80; n++) {
    const gap = lastSeen[n] !== undefined ? lastSeen[n] : 80;
    const freq = appearCount[n] || 0;
    const avgInterval = 4; // 理論平均間隔
    // gap 超過平均間隔越多，回補分越高（但不是無限加，用 log 壓縮）
    const overdue = Math.max(0, gap - avgInterval);
    result[n] = { gap, freq, overdueScore: Math.log(1 + overdue) * 2 };
  }
  return result;
}

// ============================================================
// ✅ 優化三：策略基因真正影響選號
// 根據策略 key 的 token 決定具體的選號偏向參數
// 讓不同名字的策略真的選出不同特性的號碼
// ============================================================
function buildStrategyProfile(strategyKey = '') {
  const tokens = strategyKey.toLowerCase().split('_');
  return {
    // 熱號權重（越高越偏向熱門號）
    hotWeight: tokens.includes('hot') || tokens.includes('repeat') ? 1.8 :
               tokens.includes('cold') || tokens.includes('reverse') ? 0.3 : 1.0,
    // 冷號權重（越高越偏向冷門回補）
    coldWeight: tokens.includes('cold') || tokens.includes('gap') || tokens.includes('rebound') ? 1.8 :
                tokens.includes('hot') ? 0.3 : 1.0,
    // 間距均勻化程度（越高越分散選號）
    spacingWeight: tokens.includes('zone') || tokens.includes('balanced') || tokens.includes('spread') ? 2.0 :
                   tokens.includes('cluster') ? 0.5 : 1.0,
    // 連號偏好（越高越追連號）
    streakWeight: tokens.includes('streak') || tokens.includes('chase') || tokens.includes('pattern') ? 2.0 :
                  tokens.includes('rotation') || tokens.includes('skip') ? 0.3 : 1.0,
    // 回補偏好（越高越追久未出現的號碼）
    overdueWeight: tokens.includes('gap') || tokens.includes('rebound') || tokens.includes('jump') ? 2.0 :
                   tokens.includes('hot') ? 0.3 : 1.0,
    // 尾數分散程度（越高越要求不同尾數）
    tailDiversityWeight: tokens.includes('tail') || tokens.includes('split') || tokens.includes('balanced') ? 2.0 : 1.0,
  };
}

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

function scoreGroupShape(nums = [], marketProfile, strategyKey = "", marketSnapshot = {}) {
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

  score -= Math.abs(groupSum - targetSum) * 0.06;
  score -= Math.abs(groupSpan - targetSpan) * 0.08;

  if (oddCount === 2) score += 4;
  else if (oddCount === 1 || oddCount === 3) score += 2;
  else score -= 3;

  const hotTailSet = new Set((marketProfile.tailRank || []).slice(0, 3));
  const hotZoneSet = new Set((marketProfile.zoneRank || []).slice(0, 2));

  tails.forEach((t) => { if (hotTailSet.has(t)) score += 1.8; });
  zones.forEach((z) => { if (hotZoneSet.has(z)) score += 2.2; });

  // ✅ 中3導向：從 marketSnapshot 正確取熱號
  const hot5 = extractHotNumbers(marketSnapshot, 'hot_5', 5).map(String);
  const hot10 = extractHotNumbers(marketSnapshot, 'hot_10', 10).map(String);
  const streak3 = extractStreakNumbers(marketSnapshot, 'streak3').map(String);
  const streak4 = extractStreakNumbers(marketSnapshot, 'streak4').map(String);
  const attackCore = Array.isArray(marketSnapshot?.decision_basis?.attack_core_numbers)
    ? marketSnapshot.decision_basis.attack_core_numbers.map(String) : [];

  const numStrs = intNums.map(n => String(n).padStart(2, "0"));

  // 熱號命中加分（中3關鍵：號碼要在高頻區）
  const hot5Hits = numStrs.filter(n => hot5.includes(n) || hot5.includes(String(Number(n)))).length;
  const hot10Hits = numStrs.filter(n => hot10.includes(n) || hot10.includes(String(Number(n)))).length;
  const streak3Hits = numStrs.filter(n => streak3.includes(n) || streak3.includes(String(Number(n)))).length;
  const streak4Hits = numStrs.filter(n => streak4.includes(n) || streak4.includes(String(Number(n)))).length;
  const attackHits = numStrs.filter(n => attackCore.includes(n) || attackCore.includes(String(Number(n)))).length;

  score += hot5Hits * 4.0;    // 近5期熱號最重要
  score += streak4Hits * 5.0; // 連4號最容易再出現
  score += streak3Hits * 3.5; // 連3號次之
  score += hot10Hits * 2.0;   // 近10期熱號
  score += attackHits * 2.5;  // 攻擊核心號

  // 中3加權：3個號碼都在熱區時額外獎勵
  if (hot5Hits >= 2) score += 8.0;  // 2個以上在近5期熱號，中3機率大幅提升
  if (streak3Hits + streak4Hits >= 2) score += 6.0; // 2個以上連號

  const sorted = [...intNums].sort((a, b) => a - b);
  let pairCount = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] === 1) pairCount += 1;
  }

  if (strategyKey === "pattern_structure") {
    score += pairCount * 3.0;
    if (tailKinds <= 2) score += 3.0;
  }

  if (strategyKey === "zone_balanced") {
    score += zoneKinds * 1.8;
  }

  if (strategyKey === "hot_chase") {
    score += hot5Hits * 2.0; // hot_chase 額外加重熱號
  }

  if (strategyKey === "rebound") {
    if (pairCount === 0) score += 2.0;
  }

  if (strategyKey === "streak_chase") {
    score += streak4Hits * 3.0;
    score += streak3Hits * 2.0;
  }

  // ✅ 優化一：加入間距分析分數（間距均勻的組合覆蓋面更廣）
  const spacingScore = calcSpacingScore(intNums);
  score += spacingScore * 0.8;

  // ✅ 優化一：尾數多樣性加分（三星3個號碼最好3個不同尾數）
  const uniqueTails = new Set(intNums.map(n => n % 10)).size;
  score += uniqueTails * 1.5;

  return score;
}

function buildStructuredGroup(sortedCandidates, marketProfile, strategyKey, options = {}, marketSnapshot = {}) {
  const exclude = new Set(options.exclude || []);
  const preferredZones = options.preferredZones || [];
  const preferredTail = options.preferredTail;
  const numCount = options.numCount || 4; // ✅ 支援三星(3)或四星(4)
  const limit = clamp(options.limit || 24, numCount + 9, 40);

  const pool = (sortedCandidates || [])
    .filter((item) => !exclude.has(item.num))
    .slice(0, limit);

  if (pool.length < numCount) {
    return takeTopDistinct(sortedCandidates, numCount, [...exclude]);
  }

  let bestNums = [];
  let bestScore = -999999;

  // 三星用3層迴圈，四星用4層迴圈
  if (numCount === 3) {
    for (let a = 0; a < pool.length; a += 1) {
      for (let b = a + 1; b < pool.length; b += 1) {
        for (let c = b + 1; c < pool.length; c += 1) {
          const nums = [pool[a].num, pool[b].num, pool[c].num];
          const intNums = nums.map(Number);
          let score = nums.reduce((acc, n) => {
            const found = pool.find((x) => x.num === n);
            return acc + (found ? found.score : 0);
          }, 0);

          score += scoreGroupShape(intNums, marketProfile, strategyKey, marketSnapshot);

          if (preferredZones.length) {
            const zones = intNums.map((n) => getZone(n));
            const zoneHits = zones.filter((z) => preferredZones.includes(z)).length;
            score += zoneHits * 2.0;
          }

          if (preferredTail !== undefined && preferredTail !== null) {
            const tailHits = intNums.filter((n) => getTail(n) === Number(preferredTail)).length;
            score += tailHits * 2.5;
          }

          if (score > bestScore) {
            bestScore = score;
            bestNums = nums;
          }
        }
      }
    }
  } else {
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

            score += scoreGroupShape(intNums, marketProfile, strategyKey, marketSnapshot);

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
  }

  return uniq(bestNums).slice(0, numCount);
}

function buildHotChase(todayRows, recent20, historyRows, optimizerWeight, marketProfile, marketSnapshot = {}) {
  const hot5 = extractHotNumbers(marketSnapshot, 'hot_5', 5);
  const hot10 = extractHotNumbers(marketSnapshot, 'hot_10', 10);
  const marketPhase = String(marketSnapshot?.market_phase || 'rotation').toLowerCase();

  // ✅ 根據盤相動態調整權重
  const todayWeight = marketPhase === 'continuation' ? 5.5 : marketPhase === 'chaos' ? 2.5 : 4.0;
  const recentWeight = marketPhase === 'continuation' ? 2.5 : 2.0;

  const todayScore = countFreq(todayRows, todayWeight + optimizerWeight * 1.8);
  const recentScore = countFreq(recent20, recentWeight + optimizerWeight * 1.2);
  const historyScore = countFreq(historyRows, 0.8 + optimizerWeight * 0.4);

  const merged = mergeScores(todayScore, recentScore, historyScore);

  // ✅ marketSnapshot 熱號加分
  hot5.forEach(n => {
    const key = String(n).padStart(2, "0");
    merged[key] = (merged[key] || 0) + 8;
  });
  hot10.forEach(n => {
    const key = String(n).padStart(2, "0");
    merged[key] = (merged[key] || 0) + 4;
  });

  const sorted = sortByScore(merged).map((x) => ({
    ...x,
    zone: getZone(x.num),
    tail: getTail(x.num)
  }));

  const nums = buildStructuredGroup(sorted, marketProfile, "hot_chase", {
    preferredZones: (marketProfile.zoneRank || []).slice(0, 2),
    limit: 20
  }, marketSnapshot);

  return {
    key: "hot_chase",
    label: "熱門追擊型",
    nums,
    reason: `盤相:${marketPhase} 熱號集中攻擊`,
    meta: {
      model: "v3",
      optimizerWeight,
      focus: "hot+zone",
      marketPhase
    }
  };
}

function buildRebound(todayRows, recent20, historyRows, optimizerWeight, marketProfile, marketSnapshot = {}) {
  const marketPhase = String(marketSnapshot?.market_phase || 'rotation').toLowerCase();
  const gapNumbers = extractGapNumbers(marketSnapshot, 15);
  const coldNumbers = extractColdNumbers(marketSnapshot, 10);

  // ✅ chaos/rotation 盤回補效果最好，continuation 盤回補效果差
  const todayPenalty = marketPhase === 'continuation' ? 1.4 : 0.9 + (2 - optimizerWeight) * 0.35;
  const recentPenalty = marketPhase === 'continuation' ? 1.0 : 0.6 + (2 - optimizerWeight) * 0.25;
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

  // ✅ gap/cold 號碼加分（真正的回補候選）
  gapNumbers.slice(0, 10).forEach(n => {
    const key = String(n).padStart(2, "0");
    merged[key] = (merged[key] || 0) + 6;
  });
  coldNumbers.slice(0, 8).forEach(n => {
    const key = String(n).padStart(2, "0");
    merged[key] = (merged[key] || 0) + 4;
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
  }, marketSnapshot);

  return {
    key: "rebound",
    label: "回補反彈型",
    nums,
    reason: `盤相:${marketPhase} gap=${gapNumbers.length} cold=${coldNumbers.length}`,
    meta: {
      model: "v3",
      optimizerWeight,
      focus: "rebound+gap",
      marketPhase
    }
  };
}

function buildZoneBalanced(todayRows, recent20, historyRows, optimizerWeight, marketProfile, marketSnapshot = {}) {
  const marketPhase = String(marketSnapshot?.market_phase || 'rotation').toLowerCase();
  const hot5 = extractHotNumbers(marketSnapshot, 'hot_5', 5);
  const hot20 = extractHotNumbers(marketSnapshot, 'hot_20', 20);

  const merged = mergeScores(
    countFreq(todayRows, 2.2 + optimizerWeight * 1.0),
    countFreq(recent20, 1.6 + optimizerWeight * 0.8),
    countFreq(historyRows, 0.8 + optimizerWeight * 0.3)
  );

  // ✅ 根據盤相決定熱區加分方式
  // bias/continuation 盤：集中在最熱區
  // rotation/chaos 盤：各區平均分布
  if (marketPhase === 'continuation' || marketPhase === 'bias') {
    hot5.forEach(n => {
      const key = String(n).padStart(2, "0");
      merged[key] = (merged[key] || 0) + 6;
    });
  } else {
    hot20.forEach(n => {
      const key = String(n).padStart(2, "0");
      merged[key] = (merged[key] || 0) + 3;
    });
  }

  const sorted = sortByScore(merged).map((x) => ({
    ...x,
    zone: getZone(x.num),
    tail: getTail(x.num)
  }));

  // ✅ rotation盤從各區選，continuation盤集中熱區
  const zoneTargets = marketPhase === 'continuation' || marketPhase === 'bias'
    ? (marketProfile.zoneRank || []).slice(0, 2)  // 集中前2熱區
    : (marketProfile.zoneRank || []).slice(0, 4); // 四區各選一個

  const nums = [];
  zoneTargets.forEach((zone) => {
    const found = takeTopByCondition(sorted, 1, (num) => getZone(num) === zone, nums);
    nums.push(...found);
  });

  if (nums.length < 3) {
    const extra = buildStructuredGroup(sorted, marketProfile, "zone_balanced", {
      preferredZones: zoneTargets,
      exclude: nums,
      limit: 24
    }, marketSnapshot);
    nums.push(...extra);
  }

  return {
    key: "zone_balanced",
    label: "區段平衡型",
    nums: uniq(nums).slice(0, 4),
    reason: `盤相:${marketPhase} 區段動態配置`,
    meta: {
      model: "v3",
      optimizerWeight,
      structure: "zone-balanced",
      marketPhase
    }
  };
}

function buildPatternStructure(todayRows, recent20, historyRows, optimizerWeight, marketProfile, marketSnapshot = {}) {
  const marketPhase = String(marketSnapshot?.market_phase || 'rotation').toLowerCase();
  const hot5 = extractHotNumbers(marketSnapshot, 'hot_5', 5);
  const streak2 = extractStreakNumbers(marketSnapshot, 'streak2');

  const merged = mergeScores(
    countFreq(todayRows, 3 + optimizerWeight * 1.4),
    countFreq(recent20, 1.6 + optimizerWeight * 0.8),
    countFreq(historyRows, 0.8 + optimizerWeight * 0.3)
  );

  // ✅ 連2號碼加分（同尾/連號結構）
  streak2.slice(0, 8).forEach(n => {
    const key = String(n).padStart(2, "0");
    merged[key] = (merged[key] || 0) + 5;
  });
  hot5.forEach(n => {
    const key = String(n).padStart(2, "0");
    merged[key] = (merged[key] || 0) + 3;
  });

  const sorted = sortByScore(merged)
    .slice(0, 28)
    .map((x) => ({
      ...x,
      zone: getZone(x.num),
      tail: getTail(x.num)
    }));

  // ✅ 根據盤相決定尾數策略
  const bestTail = marketPhase === 'chaos'
    ? (marketProfile.tailRank || [])[1]  // chaos盤用第二熱尾數
    : (marketProfile.tailRank || [])[0];

  const nums = buildStructuredGroup(sorted, marketProfile, "pattern_structure", {
    preferredTail: bestTail,
    preferredZones: (marketProfile.zoneRank || []).slice(0, 2),
    limit: 24
  }, marketSnapshot);

  return {
    key: "pattern_structure",
    label: "盤型結構型",
    nums,
    reason: `盤相:${marketPhase} 同尾連號結構`,
    meta: {
      model: "v3",
      optimizerWeight,
      bestTail: bestTail ?? null,
      marketPhase
    }
  };
}

function dedupeStrategies(strategies = [], sortedCandidates = [], marketProfile, numCount = 4) {
  // ✅ 優化二：真正零重疊版本
  // 統一用數字比較（不再有 padStart 格式問題），確保每組號碼完全不重疊
  // 這樣 8 組三星最多覆蓋 24 個不同號碼，最大化中3機率
  const usedNums = new Set(); // 儲存已使用號碼（純數字格式）
  const usedCombos = new Set(); // 儲存已使用的號碼組合（防止完全重複）

  return strategies.map((s, idx) => {
    let nums = uniq(s.nums).map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 80).slice(0, numCount);

    // 計算與已用號碼的重疊數（用純數字比較，無格式問題）
    const overlapCount = nums.filter(n => usedNums.has(n)).length;
    const comboKey = [...nums].sort((a, b) => a - b).join('-');
    const isDuplicate = usedCombos.has(comboKey);

    // 重疊超過1個 或 組合完全重複 → 重新選號排除已用號碼
    if (nums.length < numCount || isDuplicate || overlapCount > 1) {
      // 排除已用號碼，從候選池選未用過的號碼
      const excludeNums = [...usedNums].map(String);
      const fullNums = buildStructuredGroup(sortedCandidates, marketProfile, s.key, {
        exclude: excludeNums,
        limit: 50,
        numCount
      });
      nums = uniq(fullNums).map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 80).slice(0, numCount);
    }

    // 如果還是有重疊，強制替換重疊的號碼
    // ✅ 修正：不從 1 開始順序補，改從 sortedCandidates 裡按分數取未用號碼
    // 原本從 n=1 順序補會導致每組都帶 1,2,3,4... 這種無意義的小數字
    if (nums.some(n => usedNums.has(n))) {
      const nonOverlap = nums.filter(n => !usedNums.has(n));
      const nonOverlapSet = new Set(nonOverlap);

      // 優先從 sortedCandidates（按頻率分數排序的候選池）補未用號碼
      const allUnused = [];
      for (const candidate of sortedCandidates) {
        if (nonOverlap.length + allUnused.length >= numCount) break;
        const n = Number(candidate.num);
        if (!Number.isFinite(n) || n < 1 || n > 80) continue;
        if (usedNums.has(n) || nonOverlapSet.has(n)) continue;
        allUnused.push(n);
      }

      // sortedCandidates 不夠時才從全域補，但用隨機順序避免永遠補小數字
      if (nonOverlap.length + allUnused.length < numCount) {
        // 打亂 1-80 的順序，避免固定從 1 開始
        const shuffled = Array.from({length: 80}, (_, i) => i + 1)
          .sort(() => Math.random() - 0.5);
        for (const n of shuffled) {
          if (nonOverlap.length + allUnused.length >= numCount) break;
          if (usedNums.has(n) || nonOverlapSet.has(n) || allUnused.includes(n)) continue;
          allUnused.push(n);
        }
      }

      nums = uniq([...nonOverlap, ...allUnused]).slice(0, numCount);
    }

    // 記錄這組用過的號碼
    nums.forEach(n => usedNums.add(n));
    const finalCombo = [...nums].sort((a, b) => a - b).join('-');
    usedCombos.add(finalCombo);

    return {
      ...s,
      groupNo: idx + 1,
      nums: nums.slice(0, numCount)
    };
  });
}

// ✅ 連熱追擊型（靈活版：有連號用連號，沒連號改集中熱號）
function buildStreakChase(todayRows, recent20, historyRows, optimizerWeight, marketProfile, marketSnapshot = {}) {
  const streak3 = extractStreakNumbers(marketSnapshot, 'streak3');
  const streak4 = extractStreakNumbers(marketSnapshot, 'streak4');
  const streak2 = extractStreakNumbers(marketSnapshot, 'streak2');
  const attackCore = Array.isArray(marketSnapshot?.decision_basis?.attack_core_numbers)
    ? marketSnapshot.decision_basis.attack_core_numbers : [];
  const hot5 = extractHotNumbers(marketSnapshot, 'hot_5', 5);
  const hot10 = extractHotNumbers(marketSnapshot, 'hot_10', 10);
  const marketPhase = String(marketSnapshot?.market_phase || 'rotation').toLowerCase();

  // 有連號：用連號集中攻擊
  // 無連號：改用近期最熱的號碼集中鎖定
  const hasStreak = streak3.length > 0 || streak4.length > 0;

  let priorityPool;
  let focusMode;

  if (hasStreak) {
    // 連號盤：streak4 > streak3 > attackCore > hot5
    priorityPool = uniq([
      ...streak4,
      ...streak3,
      ...attackCore.slice(0, 6),
      ...hot5,
      ...streak2.slice(0, 4)
    ]).map(n => String(n).padStart(2, "0"));
    focusMode = 'streak_attack';
  } else {
    // 輪動盤：集中最近5期出現頻率最高的號碼
    const recent5Freq = countFreq(todayRows.slice(0, 5), 1);
    const top5Recent = sortByScore(recent5Freq).slice(0, 10).map(x => x.num);
    priorityPool = uniq([
      ...hot5,
      ...top5Recent,
      ...hot10.slice(0, 8),
      ...attackCore.slice(0, 6)
    ]).map(n => String(n).padStart(2, "0"));
    focusMode = 'hot_concentrate';
  }

  const merged = mergeScores(
    countFreq(todayRows, 3.5 + optimizerWeight * 1.5),
    countFreq(recent20, 2.0 + optimizerWeight * 1.0),
    countFreq(historyRows, 0.6 + optimizerWeight * 0.3)
  );

  // 優先池加重分數（連號模式加分更高）
  const bonusScore = hasStreak ? 20 : 12;
  priorityPool.forEach((num) => {
    merged[num] = (merged[num] || 0) + bonusScore;
  });

  // 盤相調整：continuation盤加重連號，chaos盤加重分散
  if (marketPhase === 'continuation') {
    streak3.concat(streak4).forEach(n => {
      const key = String(n).padStart(2, "0");
      merged[key] = (merged[key] || 0) + 10;
    });
  }

  const sorted = sortByScore(merged).map((x) => ({
    ...x,
    zone: getZone(x.num),
    tail: getTail(x.num)
  }));

  const nums = buildStructuredGroup(sorted, marketProfile, "streak_chase", {
    preferredZones: (marketProfile.zoneRank || []).slice(0, 2),
    limit: hasStreak ? 15 : 20  // 有連號時縮小候選池，更集中
  });

  return {
    key: "streak_chase",
    label: "連熱追擊型",
    nums,
    reason: hasStreak
      ? `連號攻擊：streak3=${streak3.length} streak4=${streak4.length}`
      : `熱號集中：輪動盤熱區鎖定`,
    meta: {
      model: "v3",
      optimizerWeight,
      focus: focusMode,
      streak3Count: streak3.length,
      streak4Count: streak4.length,
      marketPhase
    }
  };
}

// ✅ 優化三：通用選號函式 - 策略基因真正影響選號行為
// 每個不同的 strategyKey 會產生真正不同特性的號碼組合
function buildHotChaseForKey(strategyKey = '', todayRows, recent20, historyRows, optimizerWeight, marketProfile, marketSnapshot = {}, allRows = []) {
  const hot5 = extractHotNumbers(marketSnapshot, 'hot_5', 5);
  const hot10 = extractHotNumbers(marketSnapshot, 'hot_10', 10);
  const hot20 = extractHotNumbers(marketSnapshot, 'hot_20', 20);
  const streak3 = extractStreakNumbers(marketSnapshot, 'streak3');
  const streak2 = extractStreakNumbers(marketSnapshot, 'streak2');
  const gapNums = extractGapNumbers(marketSnapshot, 15);

  // ✅ 用策略基因決定選號參數
  const profile = buildStrategyProfile(strategyKey);

  // ✅ 跨期間隔分析：找出久未出現的號碼
  const gapAnalysis = buildGapAnalysis(allRows.length > 0 ? allRows : todayRows);

  const merged = mergeScores(
    countFreq(todayRows, (3.0 + optimizerWeight * 1.5) * profile.hotWeight),
    countFreq(recent20, (2.0 + optimizerWeight * 1.0) * profile.hotWeight),
    countFreq(historyRows, 0.6 + optimizerWeight * 0.3)
  );

  // 熱號加分（根據 hotWeight）
  hot5.forEach(n => {
    const k = String(n).padStart(2,"0");
    merged[k] = (merged[k] || 0) + 12 * profile.hotWeight;
  });
  hot10.forEach(n => {
    const k = String(n).padStart(2,"0");
    merged[k] = (merged[k] || 0) + 6 * profile.hotWeight;
  });

  // 冷號/回補加分（根據 coldWeight）
  gapNums.forEach(n => {
    const k = String(n).padStart(2,"0");
    merged[k] = (merged[k] || 0) + 10 * profile.coldWeight;
  });

  // 連號加分（根據 streakWeight）
  streak3.concat(streak2).forEach(n => {
    const k = String(n).padStart(2,"0");
    merged[k] = (merged[k] || 0) + 10 * profile.streakWeight;
  });

  // ✅ 優化一：跨期回補加分（根據 overdueWeight）
  // 超過平均間隔的號碼有回補傾向
  Object.entries(gapAnalysis).forEach(([n, data]) => {
    if (data.overdueScore > 0) {
      const k = String(n).padStart(2,"0");
      merged[k] = (merged[k] || 0) + data.overdueScore * profile.overdueWeight;
    }
  });

  const sorted = sortByScore(merged).map(x => ({ ...x, zone: getZone(x.num), tail: getTail(x.num) }));

  // ✅ 間距均勻化：spacingWeight 高的策略，從不同區段各選號碼
  let nums;
  if (profile.spacingWeight >= 1.5) {
    // 四個區段各取最高分號碼，確保間距分散
    const zones = ["01-20", "21-40", "41-60", "61-80"];
    const zoneNums = [];
    zones.forEach(zone => {
      const found = sorted.find(x => getZone(x.num) === zone && !zoneNums.includes(Number(x.num)));
      if (found) zoneNums.push(Number(found.num));
    });
    // 不足的從整體補
    const extra = buildStructuredGroup(sorted, marketProfile, strategyKey, {
      exclude: zoneNums.map(String),
      limit: 30
    }, marketSnapshot);
    nums = uniq([...zoneNums, ...extra.map(Number)]).slice(0, 4);
  } else {
    nums = buildStructuredGroup(sorted, marketProfile, strategyKey, { limit: 25 }, marketSnapshot);
  }

  return {
    key: strategyKey,
    label: strategyKey.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' '),
    nums,
    reason: `動態策略[${strategyKey}] hot:${profile.hotWeight.toFixed(1)} cold:${profile.coldWeight.toFixed(1)} streak:${profile.streakWeight.toFixed(1)} overdue:${profile.overdueWeight.toFixed(1)}`,
    meta: {
      model: 'v4_gene_driven',
      optimizerWeight,
      profile,
      focus: 'gene_profile',
      marketPhase: marketSnapshot?.market_phase || 'rotation'
    }
  };
}

// ✅ 根據 hit3_rate + 覆蓋率回饋動態決定每個策略出幾組
// forcedGroupCount：由 auto-train 的加碼/減碼邏輯傳入，覆蓋動態計算的組數
function decideGroupCountByPerformance(recent10Stats = {}, marketSnapshot = {}, useKeys = [], forcedGroupCount = null) {
  const marketPhase = marketSnapshot?.market_phase || 'rotation';
  const streak3 = extractStreakNumbers(marketSnapshot, 'streak3');
  const streak4 = extractStreakNumbers(marketSnapshot, 'streak4');
  const streak3Count = streak3.length;
  const streak4Count = streak4.length;

  // ✅ 支援新舊兩種 recent10Stats 格式
  // 新格式：{ score, hit3Rate, coverageHitRate, avgCoverageHit, totalRounds }
  // 舊格式：直接是數字
  const getScore = (key) => {
    const val = recent10Stats[key];
    if (val === null || val === undefined) return -0.5;
    if (typeof val === 'object') return val.score ?? -0.5;
    return val;
  };

  const getHit3Rate = (key) => {
    const val = recent10Stats[key];
    if (typeof val === 'object') return val.hit3Rate ?? 0;
    return 0;
  };

  const getCoverageHitRate = (key) => {
    const val = recent10Stats[key];
    if (typeof val === 'object') return val.avgCoverageHit ?? 3;
    return 3; // 預設值
  };

  const getTotalRounds = (key) => {
    const val = recent10Stats[key];
    if (typeof val === 'object') return val.totalRounds ?? 0;
    return 0;
  };

  // ✅ 動態策略清單：用傳入的 useKeys，沒有就用固定5個
  const defaultKeys = ['streak_chase', 'hot_chase', 'pattern_structure', 'rebound', 'zone_balanced'];
  const strategyKeys = useKeys.length > 0 ? useKeys : defaultKeys;

  const strategies = strategyKeys.map(key => ({
    key,
    score: getScore(key)
  })).sort((a, b) => b.score - a.score);

  const BASE_STRATEGY_COUNT = strategies.length;

  // ✅ 若外部傳入 forcedGroupCount（加碼/減碼邏輯），直接使用；否則預設 8
  // 注意：forcedGroupCount 是總出組數上限，不能被 BASE_STRATEGY_COUNT 反向撐高
  // 縮組時（例如5組）strategies 本身也只剩5個 key（auto-train 已 slice 好），所以直接用
  let totalGroups = (forcedGroupCount != null && Number.isFinite(Number(forcedGroupCount)))
    ? Math.max(1, Number(forcedGroupCount))
    : 8;

  // 先每個策略分配1組
  const allocation = {};
  strategies.forEach(s => { allocation[s.key] = 1; });

  // ✅ 回饋迴圈：根據 hit3_rate 和覆蓋率分配額外組數
  // 有真實數據（rounds >= 20）的策略才能拿到額外組數
  let extra = totalGroups - BASE_STRATEGY_COUNT;
  for (const s of strategies) {
    if (extra <= 0) break;
    const rounds = getTotalRounds(s.key);
    const hit3Rate = getHit3Rate(s.key);
    const avgCoverage = getCoverageHitRate(s.key);

    let maxAdd;
    if (rounds < 20) {
      // 數據不足，只給1組，讓每個策略都有機會累積數據
      maxAdd = 1;
    } else if (hit3Rate > 0.05 || avgCoverage > 5) {
      // 中3率 > 5% 或覆蓋命中 > 5個：表現優異，最多加3組
      maxAdd = 3;
    } else if (hit3Rate > 0.02 || avgCoverage > 4) {
      // 中3率 > 2% 或覆蓋命中 > 4個：表現一般，最多加2組
      maxAdd = 2;
    } else {
      // 表現差，只維持1組
      maxAdd = 1;
    }

    const add = Math.min(maxAdd, extra);
    allocation[s.key] += add;
    extra -= add;
  }

  return { allocation, totalGroups };
}

export function buildBingoV1Strategies(allRows = [], strategyWeightMap = {}, starCount = 4, marketSnapshot = {}, recent10Stats = {}, dynamicStrategyKeys = [], forcedGroupCount = null) {
  // ✅ 支援 starCount=3（三星）或 starCount=4（四星，預設）
  const numCount = starCount === 3 ? 3 : 4;

  const weights = normalizeWeightMap(strategyWeightMap);

  const todayRows = buildTodayRows(allRows);
  const recent20 = buildRecentRows(allRows, 20);
  const historyRows = buildHistoryRows(allRows, 20, 500);

  const marketProfile = buildMarketProfile(buildRecentRows(allRows, 50));
  const sortedCandidates = computeCandidateScores(todayRows, recent20, historyRows);

  // ✅ 固定5個基礎策略
  const s1 = buildStreakChase(todayRows, recent20, historyRows, weights.hot_chase, marketProfile, marketSnapshot);
  const s2 = buildHotChase(todayRows, recent20, historyRows, weights.hot_chase, marketProfile, marketSnapshot);
  const s3 = buildPatternStructure(todayRows, recent20, historyRows, weights.pattern_structure, marketProfile, marketSnapshot);
  const s4 = buildRebound(todayRows, recent20, historyRows, weights.rebound, marketProfile, marketSnapshot);
  const s5 = buildZoneBalanced(todayRows, recent20, historyRows, weights.zone_balanced, marketProfile, marketSnapshot);

  // ✅ 建立策略 map（固定5個 + 動態策略用通用選號）
  const baseStrategyMap = new Map([
    [s1.key, s1], [s2.key, s2], [s3.key, s3], [s4.key, s4], [s5.key, s5]
  ]);

  // 動態策略清單：如果有傳入，用動態清單；否則用固定5個
  const useKeys = dynamicStrategyKeys.length > 0 ? dynamicStrategyKeys : [s1.key, s2.key, s3.key, s4.key, s5.key];

  // ✅ 動態決定每個策略出幾組（根據近10期表現 + 盤面強度 + 加碼/減碼）
  const { allocation, totalGroups } = decideGroupCountByPerformance(recent10Stats, marketSnapshot, useKeys, forcedGroupCount);

  // 依照 allocation 展開策略組合
  const rawStrategies = [];
  useKeys.forEach(key => {
    // 有固定策略直接用，沒有的用通用熱號選號
    // ✅ 優化三：傳入 allRows 讓通用選號函式可以做跨期間隔分析
    const s = baseStrategyMap.get(key) || buildHotChaseForKey(key, todayRows, recent20, historyRows, weights.hot_chase, marketProfile, marketSnapshot, allRows);
    const slots = allocation[key] || 1;
    for (let i = 0; i < slots; i++) {
      rawStrategies.push({ ...s, key, groupSlot: i + 1 });
    }
  });

  const strategies = dedupeStrategies(
    rawStrategies,
    sortedCandidates,
    marketProfile,
    numCount  // ✅ 傳入 numCount，三星不補回4個
  );

  // ✅ 每組只取前 numCount 個號碼
  const finalStrategies = strategies.map((s) => ({
    ...s,
    nums: uniq(s.nums).slice(0, numCount)
  }));

  return {
    mode: starCount === 3
      ? `bingo_v4_3star_${totalGroups}group_market_driven`
      : `bingo_v4_4star_${totalGroups}group_market_driven`,
    target: {
      stars: numCount,
      groups: totalGroups,
      periods: 1
    },
    generatedAt: new Date().toISOString(),
    totalRowsUsed: allRows.length,
    strategyWeights: weights,
    marketProfile,
    marketPhase: marketSnapshot?.market_phase || 'rotation',
    groupAllocation: allocation,
    strategies: finalStrategies
  };
}
