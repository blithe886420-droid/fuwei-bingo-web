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
// ✅ v18 第六階段：時段感知權重調整
// 根據台灣時間識別當前時段，調整 analyzeBoardState 各因子權重
// 數據顯示：早上盤面較規律（連號多），下午散亂，晚上介於中間
// ============================================================
function getTimeSlotWeights() {
  const now = new Date();
  const taipeiHour = (now.getUTCHours() + 8) % 24;

  if (taipeiHour >= 7 && taipeiHour < 12) {
    // 早上 07:00~12:00：小幅加重熱號和連號
    return {
      slot: 'morning',
      freqWeight: 2.0,
      hotWeight: { hot5: 8.0, hot10: 4.0, hot20: 2.0 },
      streakWeight: { streak4: 3.5, streak3: 2.5 },
      overdueWeight: { continuation: 1.0, chaos: 4.0, default: 2.5 },
      coldWeight: { continuation: 0.5, default: 2.0 },
      hotFreqWeight: 0.3
    };
  } else if (taipeiHour >= 12 && taipeiHour < 18) {
    // 下午 12:00~18:00：小幅加重回補
    return {
      slot: 'afternoon',
      freqWeight: 2.0,
      hotWeight: { hot5: 7.0, hot10: 3.5, hot20: 1.8 },
      streakWeight: { streak4: 2.5, streak3: 2.0 },
      overdueWeight: { continuation: 1.0, chaos: 4.5, default: 3.2 },
      coldWeight: { continuation: 0.5, default: 2.2 },
      hotFreqWeight: 0.28
    };
  } else if (taipeiHour >= 18 && taipeiHour < 23) {
    // 晚上 18:00~23:00：平衡權重（接近 v17 基準）
    return {
      slot: 'evening',
      freqWeight: 2.0,
      hotWeight: { hot5: 8.0, hot10: 4.0, hot20: 2.0 },
      streakWeight: { streak4: 3.0, streak3: 2.5 },
      overdueWeight: { continuation: 1.0, chaos: 4.0, default: 3.0 },
      coldWeight: { continuation: 0.5, default: 2.0 },
      hotFreqWeight: 0.3
    };
  } else {
    // 深夜/凌晨
    return {
      slot: 'night',
      freqWeight: 2.0,
      hotWeight: { hot5: 7.0, hot10: 3.5, hot20: 1.8 },
      streakWeight: { streak4: 2.5, streak3: 2.0 },
      overdueWeight: { continuation: 1.0, chaos: 4.0, default: 3.0 },
      coldWeight: { continuation: 0.5, default: 2.0 },
      hotFreqWeight: 0.28
    };
  }
}


// ============================================================
// ✅ v17 第四階段：盤面感知選號（戰術層）
// ✅ v18 第六階段：整合時段感知，早午晚使用不同權重
// ============================================================
function analyzeBoardState(allRows = [], marketSnapshot = {}) {
  const numFreqMap = marketSnapshot?.num_freq_map || {};
  const gapNums = extractGapNumbers(marketSnapshot, 20);
  const hot5 = extractHotNumbers(marketSnapshot, 'hot_5', 5);
  const hot10 = extractHotNumbers(marketSnapshot, 'hot_10', 10);
  const hot20 = extractHotNumbers(marketSnapshot, 'hot_20', 20);
  const streak3 = extractStreakNumbers(marketSnapshot, 'streak3');
  const streak4 = extractStreakNumbers(marketSnapshot, 'streak4');
  const freq20Hot = Array.isArray(marketSnapshot?.freq20_hot_nums) ? marketSnapshot.freq20_hot_nums : [];
  const freq20Cold = Array.isArray(marketSnapshot?.freq20_cold_nums) ? marketSnapshot.freq20_cold_nums : [];
  const marketPhase = String(marketSnapshot?.market_phase || 'rotation').toLowerCase();

  // ✅ v18 第六階段：取得時段感知權重
  const tw = getTimeSlotWeights();
  console.log(`[analyzeBoardState] 時段=${tw.slot} 盤相=${marketPhase}`);

  // 建立 gapAnalysis（回補分數）
  const gapAnalysis = buildGapAnalysis(allRows.length > 0 ? allRows : []);

  // 對每個號碼打分（使用時段感知的動態權重）
  const scores = {};
  const factorScores = { hot: 0, overdue: 0, streak: 0, cold: 0, freq: 0 };

  for (let n = 1; n <= 80; n++) {
    let score = 0;

    // 1. 頻率分（近20期出現頻率）
    const freq = Number(numFreqMap[String(n)] || 0);
    const freqContrib = freq * tw.freqWeight;
    score += freqContrib;
    factorScores.freq += freqContrib;

    // 2. 熱號加分（時段感知）
    let hotContrib = 0;
    if (hot5.includes(n)) hotContrib = tw.hotWeight.hot5;
    else if (hot10.includes(n)) hotContrib = tw.hotWeight.hot10;
    else if (hot20.includes(n)) hotContrib = tw.hotWeight.hot20;
    score += hotContrib;
    factorScores.hot += hotContrib;

    // 3. 連號加分（時段感知）
    let streakContrib = 0;
    if (streak4.includes(n)) {
      streakContrib = marketPhase === 'continuation' ? tw.streakWeight.streak4 : tw.streakWeight.streak4 * 0.4;
    } else if (streak3.includes(n)) {
      streakContrib = marketPhase === 'continuation' ? tw.streakWeight.streak3 : tw.streakWeight.streak3 * 0.4;
    }
    score += streakContrib;
    factorScores.streak += streakContrib;

    // 4. 回補分（時段感知）
    const gap = gapAnalysis[n];
    let overdueContrib = 0;
    if (gap && gap.overdueScore > 0) {
      const overdueWeight = marketPhase === 'continuation' ? tw.overdueWeight.continuation :
                            marketPhase === 'chaos' ? tw.overdueWeight.chaos : tw.overdueWeight.default;
      overdueContrib = gap.overdueScore * overdueWeight;
    }
    score += overdueContrib;
    factorScores.overdue += overdueContrib;

    // 5. 冷號加分（時段感知）
    const coldIdx = freq20Cold.indexOf(n);
    let coldContrib = 0;
    if (coldIdx >= 0) {
      const coldWeight = marketPhase === 'continuation' ? tw.coldWeight.continuation : tw.coldWeight.default;
      coldContrib = (10 - Math.min(coldIdx, 9)) * coldWeight * 0.3;
    }
    score += coldContrib;
    factorScores.cold += coldContrib;

    // 6. 近20期高頻加分（時段感知）
    const hotIdx = freq20Hot.indexOf(n);
    if (hotIdx >= 0) {
      score += (20 - Math.min(hotIdx, 19)) * tw.hotFreqWeight;
    }

    scores[n] = score;
  }

  // 排序取前24顆最高分號碼
  const ranked = Object.entries(scores)
    .map(([n, s]) => ({ n: Number(n), score: s }))
    .sort((a, b) => b.score - a.score);

  // 確保24顆號碼的尾數和區間都有覆蓋（多樣性保護）
  const selected = [];
  const selectedTails = new Map();
  const selectedZones = new Map();

  for (const { n, score } of ranked) {
    if (selected.length >= 24) break;
    const tail = n % 10;
    const zone = n <= 20 ? 1 : n <= 40 ? 2 : n <= 60 ? 3 : 4;
    const tailCount = selectedTails.get(tail) || 0;
    const zoneCount = selectedZones.get(zone) || 0;
    if (tailCount >= 3) continue;
    if (zoneCount >= 8) continue;
    selected.push(n);
    selectedTails.set(tail, tailCount + 1);
    selectedZones.set(zone, zoneCount + 1);
  }

  if (selected.length < 24) {
    for (const { n } of ranked) {
      if (selected.length >= 24) break;
      if (!selected.includes(n)) selected.push(n);
    }
  }

  const groups = distributeToGroups(selected, scores, 8, 3);

  return {
    scoredNums: ranked,
    top24: selected,
    groups,
    marketPhase,
    timeSlot: tw.slot,
    // ✅ v18：回傳各因子分數供記錄
    boardMeta: {
      hot_score: factorScores.hot,
      overdue_score: factorScores.overdue,
      streak_score: factorScores.streak,
      cold_score: factorScores.cold,
      freq_score: factorScores.freq,
      market_phase: marketPhase,
      time_slot: tw.slot
    },
    boardStats: {
      hotCount: hot5.length + hot10.length,
      coldCount: freq20Cold.length,
      streakCount: streak3.length + streak4.length,
      overdueCount: gapNums.length
    }
  };
}

// 把 N 顆號碼最優化分配成 groupCount 組，每組 numPerGroup 顆
// 確保每組號碼來自不同區間，最大化覆蓋效果
function distributeToGroups(nums = [], scores = {}, groupCount = 8, numPerGroup = 3) {
  const sorted = [...nums].sort((a, b) => (scores[b] || 0) - (scores[a] || 0));
  const groups = Array.from({ length: groupCount }, () => []);
  const usedNums = new Set();

  // 策略：每輪從最高分號碼開始，分配到號碼數量最少且區間最不集中的組
  for (const n of sorted) {
    if (usedNums.has(n)) continue;

    // 找最需要補充的組（號碼數量最少的組，優先選區間多樣性最高的）
    let bestGroupIdx = -1;
    let bestDiversity = -1;

    for (let i = 0; i < groupCount; i++) {
      const group = groups[i];
      if (group.length >= numPerGroup) continue;

      // 計算這組加入 n 之後的區間多樣性
      const zones = new Set([...group, n].map(x => x <= 20 ? 1 : x <= 40 ? 2 : x <= 60 ? 3 : 4));
      const diversity = zones.size * 10 + (numPerGroup - group.length); // 優先補充少的組

      if (diversity > bestDiversity) {
        bestDiversity = diversity;
        bestGroupIdx = i;
      }
    }

    if (bestGroupIdx >= 0) {
      groups[bestGroupIdx].push(n);
      usedNums.add(n);
    }
  }

  // 確保每組都有 numPerGroup 顆（補足）
  const remaining = sorted.filter(n => !usedNums.has(n));
  for (const group of groups) {
    for (const n of remaining) {
      if (group.length >= numPerGroup) break;
      if (!usedNums.has(n)) {
        group.push(n);
        usedNums.add(n);
      }
    }
  }

  return groups.filter(g => g.length === numPerGroup);
}


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

  // ✅ v16：根據實測數據調整權重
  // gap_zone_rotation 系列命中率最高（1.66~1.85%），代表回補冷號是關鍵訊號
  // streak4 權重過高導致號碼集中在連號區，降低以避免過度集中
  score += hot5Hits * 4.0;    // 近5期熱號（維持）
  score += streak4Hits * 3.0; // 連4號（從5.0降到3.0，避免過度集中連號區）
  score += streak3Hits * 2.5; // 連3號（從3.5降到2.5）
  score += hot10Hits * 2.5;   // 近10期熱號（從2.0升到2.5，擴大熱號參考窗口）
  score += attackHits * 2.5;  // 攻擊核心號（維持）

  // ✅ 修正2：移除 hot5Hits >= 2 加8分獎勵
  // 鼓勵號碼集中在熱號區跟「分散覆蓋」目標衝突，會讓8組號碼都擠在熱號區
  // if (hot5Hits >= 2) score += 8.0;  // 移除，避免號碼過度集中
  if (streak3Hits + streak4Hits >= 2) score += 4.0; // 連號獎勵（從6.0降到4.0）

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

  // ✅ v16：overdueScore 從 0.8 提升到 2.0
  // gap_zone_rotation 命中率最高印證回補訊號最準，大幅加重此項
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

function buildZoneBalanced(todayRows, recent20, historyRows, optimizerWeight, marketProfile, marketSnapshot = {}, numCount = 4) {
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
    nums: uniq(nums).slice(0, numCount || 4),  // ✅ 修正3：三星用numCount=3，不固定切4個
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

  // ✅ v16：overdueScore 加重（gap_zone_rotation 命中率最高印證回補訊號最準）
  Object.entries(gapAnalysis).forEach(([n, data]) => {
    if (data.overdueScore > 0) {
      const k = String(n).padStart(2,"0");
      merged[k] = (merged[k] || 0) + data.overdueScore * profile.overdueWeight * 2.5;
    }
  });

  const sorted = sortByScore(merged).map(x => ({ ...x, zone: getZone(x.num), tail: getTail(x.num) }));

  // ✅ 修正第3點：改用8個小區段（每段10個號碼）取代4個大區段
  // 三星3個號碼，從8個小區段裡選最高分的3個不同區段各選1個
  // 覆蓋更均勻，避免號碼集中在某個20號的大區段裡
  let nums;
  if (profile.spacingWeight >= 1.5) {
    // 8個小區段：1-10, 11-20, 21-30, 31-40, 41-50, 51-60, 61-70, 71-80
    const smallZones = [
      [1,10], [11,20], [21,30], [31,40],
      [41,50], [51,60], [61,70], [71,80]
    ];

    // 每個小區段找最高分號碼
    const zoneTopNums = smallZones.map(([lo, hi]) => {
      const found = sorted.find(x => {
        const n = Number(x.num);
        return n >= lo && n <= hi;
      });
      return found ? { num: Number(found.num), score: found.score, zone: `${lo}-${hi}` } : null;
    }).filter(Boolean);

    // 按分數排序，取前3個（三星只需要3個號碼）
    zoneTopNums.sort((a, b) => b.score - a.score);
    const picked = zoneTopNums.slice(0, 3).map(x => x.num);

    // 不足補
    if (picked.length < 3) {
      const extra = buildStructuredGroup(sorted, marketProfile, strategyKey, {
        exclude: picked.map(String),
        limit: 30
      }, marketSnapshot);
      nums = uniq([...picked, ...extra.map(Number)]).slice(0, 3);
    } else {
      nums = picked;
    }
  } else {
    nums = buildStructuredGroup(sorted, marketProfile, strategyKey, { limit: 40 }, marketSnapshot);
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

  const strategies = strategyKeys.map(key => {
    const baseScore = getScore(key);
    const hit3Rate = getHit3Rate(key);
    const totalRounds = getTotalRounds(key);

    // ✅ v16 方向三：加入近10期滑動命中率，讓排名即時反應當下盤面
    // recent10Stats 裡的 recent_hits 近10期數據如果有，額外加分
    const val = recent10Stats[key];
    let recentBonus = 0;
    if (typeof val === 'object' && Array.isArray(val?.recentHits)) {
      const last10 = val.recentHits.slice(-10);
      const last10Hit3 = last10.filter(h => h >= 3).length;
      const last10Hit3Rate = last10.length > 0 ? last10Hit3 / last10.length : 0;
      // 近10期命中率高於全期命中率，給額外加分（最多+3）
      const bonus = Math.min(3, last10Hit3Rate * 20);
      recentBonus = bonus;
    }

    return {
      key,
      score: baseScore + recentBonus
    };
  }).sort((a, b) => b.score - a.score);

  const BASE_STRATEGY_COUNT = strategies.length;

  // ✅ 若外部傳入 forcedGroupCount（加碼/減碼邏輯），直接使用；否則預設 8
  // 注意：forcedGroupCount 是總出組數上限，不能被 BASE_STRATEGY_COUNT 反向撐高
  // 縮組時（例如5組）strategies 本身也只剩5個 key（auto-train 已 slice 好），所以直接用
  let totalGroups = (forcedGroupCount != null && Number.isFinite(Number(forcedGroupCount)))
    ? Math.max(1, Number(forcedGroupCount))
    : 8;

  // ✅ 修正第1點：每個策略只出1組，讓8組邏輯盡量多元
  // 原本表現好的策略可以出2~3組，但同一邏輯重複選號效益低
  // 改為：每個策略固定1組，剩餘組數給其他不同策略
  // 如果策略數量不夠8個，才讓表現最好的策略補出額外組數
  const allocation = {};
  strategies.forEach(s => { allocation[s.key] = 1; });

  let extra = totalGroups - BASE_STRATEGY_COUNT;
  if (extra > 0) {
    // 策略數量不夠時，才讓表現最好的策略補出額外組數（但最多+1）
    for (const s of strategies) {
      if (extra <= 0) break;
      const rounds = getTotalRounds(s.key);
      const hit3Rate = getHit3Rate(s.key);
      // 只有真的有數據且表現優異的策略才補一組
      if (rounds >= 20 && hit3Rate > 0.03) {
        allocation[s.key] += 1;
        extra -= 1;
      }
    }
    // 還有剩，給第一個策略補（確保組數達標）
    if (extra > 0) {
      const firstKey = strategies[0]?.key;
      if (firstKey) allocation[firstKey] = (allocation[firstKey] || 1) + extra;
    }
  }

  return { allocation, totalGroups };
}

// ============================================================
// ✅ 盤面感知機制：分析當期市場狀況，動態決定8組的選號策略組合
// 不再用固定邏輯，而是根據盤面靈活應對
// ============================================================
function detectMarketCondition(marketSnapshot = {}, allRows = []) {
  const streak2 = extractStreakNumbers(marketSnapshot, 'streak2');
  const streak3 = extractStreakNumbers(marketSnapshot, 'streak3');
  const streak4 = extractStreakNumbers(marketSnapshot, 'streak4');
  const hot5 = (marketSnapshot?.hot_windows?.hot_5?.numbers || []);
  const hot10 = (marketSnapshot?.hot_windows?.hot_10?.numbers || []);
  const hot20 = (marketSnapshot?.hot_windows?.hot_20?.numbers || []);
  const gapNums = extractGapNumbers(marketSnapshot, 20);
  const latest = allRows[0] ? parseNumbers(allRows[0].numbers) : [];
  const marketPhase = marketSnapshot?.market_phase || 'rotation';

  // 連號強度
  const streakStrength = streak4.length * 3 + streak3.length * 2 + streak2.length * 1;

  // 熱區集中度：hot5和hot10重疊越多代表熱區越集中
  const hot5Set = new Set(hot5);
  const hotConcentration = hot10.filter(n => hot5Set.has(n)).length;

  // 冷號壓力：久未出現的號碼數量
  const coldPressure = gapNums.length;

  // 最新一期號碼跟熱區的重疊
  const latestHotOverlap = latest.filter(n => hot10.includes(n)).length;

  // 區段分布：分析最近3期開獎號碼在4個區段的分布
  const recentZoneDist = [0, 0, 0, 0]; // 1-20, 21-40, 41-60, 61-80
  allRows.slice(0, 3).forEach(row => {
    parseNumbers(row.numbers).forEach(n => {
      if (n <= 20) recentZoneDist[0]++;
      else if (n <= 40) recentZoneDist[1]++;
      else if (n <= 60) recentZoneDist[2]++;
      else recentZoneDist[3]++;
    });
  });
  const maxZone = Math.max(...recentZoneDist);
  const minZone = Math.min(...recentZoneDist);
  const zoneBias = maxZone - minZone; // 越大代表越集中在某個區段

  return {
    streakStrength,
    hotConcentration,
    coldPressure,
    latestHotOverlap,
    zoneBias,
    recentZoneDist,
    streak2, streak3, streak4,
    hot5, hot10, hot20, gapNums, latest,
    marketPhase
  };
}

// 根據盤面狀況動態決定8組的策略角色分配
// ✅ 修復：加入 market_phase 影響角色分配，讓四種盤相真正起作用
function decideDynamicRoleAllocation(condition = {}, totalGroups = 8, roleWeights = {}) {
  const {
    streakStrength, hotConcentration, coldPressure,
    latestHotOverlap, zoneBias, marketPhase,
    recentZoneDist
  } = condition;

  let roles = [];

  // ═══════════════════════════════════════════════════════
  // 教練戰術室：根據場上狀況決定今局派哪些球員上場
  //
  // 20位球員名冊：
  //   hot       = 強打者（近20期高頻）
  //   cold      = 回補手（近20期低頻/久未出現）
  //   streak    = 連號追擊手（連續出現的號碼）
  //   recent    = 近況觀察手（最近5期動態）
  //   zone_fill = 區段填補手（填補冷門大區段）
  //   scatter   = 分散游擊手（8小區段廣覆蓋）
  //   tail_hot  = 熱尾數專家（近期最熱的尾數）
  //   tail_cold = 冷尾數專家（近期最冷的尾數）
  //   repeat    = 重複追擊手（追上一期號碼）
  //   anti_hot  = 逆勢手（追完全沒出現的號碼）
  //   gap_zone  = 區段回補手（冷門區段冷號）
  //   chain     = 連鎖追擊手（鄰近上期號碼±1~3）
  //   dominant  = 主宰手（近10期出現5次以上）
  //   sleeper   = 蟄伏反撲手（超過15期未出現）
  //   mid_zone  = 中段集中手（21-60中段號碼）
  //   edge_zone = 邊緣突擊手（1-20、61-80邊緣）
  //   odd_bias  = 奇偶平衡手（平衡近期奇偶比例）
  //   sum_low   = 低總和手（偏小號碼，≤35）
  //   sum_high  = 高總和手（偏大號碼，≥46）
  //   balance   = 均衡配置手（四區各代表一個）
  //
  // 場地狀況（market_phase）：
  //   continuation = 延續盤（熱號持續，連號多）
  //   bias         = 偏移盤（某區段特別集中）
  //   chaos        = 混亂盤（最新一期熱號少，無連號）
  //   rotation     = 輪動盤（正常輪換，無明顯趨勢）
  // ═══════════════════════════════════════════════════════

  const coldPressureHigh = coldPressure >= 12;
  const hasStreak = streakStrength >= 5;
  const zoneBiasStrong = zoneBias >= 20;
  const hotOverlapLow = latestHotOverlap <= 5;
  const hotOverlapHigh = latestHotOverlap >= 12;

  if (marketPhase === 'continuation') {
    // 延續盤：熱號持續，連號多
    if (hasStreak) {
      // 有明顯連號：streak+dominant主攻，chain追鄰近，cold保底
      roles = ['streak', 'dominant', 'chain', 'recent', 'hot', 'cold', 'tail_hot', 'scatter'];
    } else if (hotOverlapHigh) {
      // 熱號高度重疊但無連號：repeat+recent為主，sleeper等爆發
      roles = ['repeat', 'recent', 'dominant', 'cold', 'hot', 'tail_hot', 'sleeper', 'scatter'];
    } else {
      // 一般延續：recent+chain追動態，cold+sleeper等回補
      roles = ['recent', 'chain', 'cold', 'hot', 'repeat', 'sleeper', 'zone_fill', 'balance'];
    }

  } else if (marketPhase === 'bias') {
    // 偏移盤：某區段特別集中，填補冷門區段
    if (zoneBiasStrong) {
      // 強烈偏移：gap_zone+edge_zone+zone_fill全力填補
      roles = ['gap_zone', 'zone_fill', 'edge_zone', 'cold', 'tail_cold', 'anti_hot', 'sleeper', 'balance'];
    } else {
      // 輕微偏移：zone_fill為主，hot守住熱區
      roles = ['zone_fill', 'gap_zone', 'cold', 'hot', 'tail_cold', 'recent', 'edge_zone', 'scatter'];
    }

  } else if (marketPhase === 'chaos') {
    // 混亂盤：無規律，熱號少，冷號多
    if (coldPressureHigh) {
      // 冷號壓力高：sleeper+anti_hot+balance廣撒網
      roles = ['sleeper', 'anti_hot', 'balance', 'scatter', 'cold', 'gap_zone', 'odd_bias', 'zone_fill'];
    } else {
      // 一般混亂：scatter+balance廣覆蓋，sum_low/sum_high試運氣
      roles = ['scatter', 'balance', 'anti_hot', 'cold', 'sum_low', 'sum_high', 'odd_bias', 'zone_fill'];
    }

  } else {
    // rotation（輪動盤）：正常輪換，根據細部指標靈活調度
    if (coldPressureHigh && !hasStreak) {
      // 冷號壓力大：sleeper+cold+gap_zone主攻回補
      roles = ['sleeper', 'cold', 'gap_zone', 'tail_cold', 'hot', 'recent', 'zone_fill', 'balance'];
    } else if (hasStreak) {
      // 有連號趨勢：streak+chain+dominant主攻
      roles = ['streak', 'chain', 'dominant', 'hot', 'cold', 'recent', 'tail_hot', 'scatter'];
    } else if (hotOverlapLow) {
      // 熱號命中率低：逆勢+廣覆蓋
      roles = ['anti_hot', 'scatter', 'cold', 'balance', 'zone_fill', 'odd_bias', 'sleeper', 'recent'];
    } else if (hotOverlapHigh) {
      // 熱號高度重疊：repeat+dominant鎖定強勢號
      roles = ['repeat', 'dominant', 'hot', 'cold', 'chain', 'tail_hot', 'recent', 'zone_fill'];
    } else {
      // 標準輪動：20位球員輪番出場，均衡覆蓋
      roles = ['hot', 'cold', 'recent', 'streak', 'zone_fill', 'scatter', 'tail_hot', 'balance'];
    }
  }

  // ✅ 步驟七：根據 roleWeights 動態調整角色出場順序
  if (Object.keys(roleWeights).length > 0) {
    const getRoleWeight = (role) => {
      let maxW = 1.0;
      for (const [key, w] of Object.entries(roleWeights)) {
        const k = key.toLowerCase();
        if (role === 'hot' && (k.includes('hot') || k.includes('mix_zone'))) maxW = Math.max(maxW, w);
        if (role === 'cold' && (k.includes('cold') || k.includes('rebound'))) maxW = Math.max(maxW, w);
        if (role === 'recent' && k.includes('recent')) maxW = Math.max(maxW, w);
        if (role === 'streak' && (k.includes('streak') || k.includes('gap'))) maxW = Math.max(maxW, w);
        if (role === 'zone_fill' && k.includes('zone')) maxW = Math.max(maxW, w);
        if (role === 'scatter' && k.includes('scatter')) maxW = Math.max(maxW, w);
      }
      return maxW;
    };
    const weightedRoles = roles.slice(0, totalGroups).map(role => ({ role, weight: getRoleWeight(role) }));
    weightedRoles.sort((a, b) => b.weight - a.weight);
    const sortedRoles = weightedRoles.map(x => x.role);
    console.log(`[step7] phase=${marketPhase} roleWeights applied → ${sortedRoles.join(',')}`);
    return sortedRoles;
  }

  console.log(`[role_alloc] phase=${marketPhase} streak=${streakStrength} hotConc=${hotConcentration} coldHigh=${coldPressureHigh} → ${roles.slice(0, totalGroups).join(',')}`);

  return roles.slice(0, totalGroups);
}

// 根據角色選號
// ✅ 修復：整合 freq20_hot_nums（近20期高頻號碼），所有角色都優先參考頻率數據
// ✅ 修復：scatter 和 zone_fill 不再完全隨機，改為從高頻號碼分散選
function buildNumsByRole(role = 'scatter', condition = {}, usedNums = new Set(), numCount = 3, seed = 0, marketSnapshot = {}) {
  const { streak2, streak3, streak4, hot5, hot10, hot20, gapNums, latest, recentZoneDist } = condition;

  // ✅ 整合近20期頻率數據（從 auto-train 注入的 freq20_hot_nums）
  const freq20Hot = Array.isArray(marketSnapshot?.freq20_hot_nums) ? marketSnapshot.freq20_hot_nums : [];
  const freq20Cold = Array.isArray(marketSnapshot?.freq20_cold_nums) ? marketSnapshot.freq20_cold_nums : [];
  const numFreqMap = marketSnapshot?.num_freq_map || {};

  // 把頻率數據轉成排序好的號碼陣列（高頻→低頻）
  const freqSortedAll = Object.entries(numFreqMap)
    .map(([n, f]) => ({ n: Number(n), f: Number(f) }))
    .filter(x => x.n >= 1 && x.n <= 80)
    .sort((a, b) => b.f - a.f)
    .map(x => x.n);

  const picked = [];
  const usedSet = new Set(usedNums);

  const tryAdd = (candidates) => {
    for (const n of candidates) {
      if (picked.length >= numCount) break;
      const num = Number(n);
      if (!usedSet.has(num) && num >= 1 && num <= 80 && !picked.includes(num)) {
        picked.push(num);
        usedSet.add(num);
      }
    }
  };

  if (role === 'streak') {
    // ── 連號追擊手 ──
    // 專長：追連續出現2期以上的號碼，這些號碼有短期慣性
    // 選號邏輯：streak4最強（連4期）> streak3 > streak2
    // 沒有連號時：改追最近3期都出現的號碼（短期repeat）
    const recent3Set = new Map();
    (latest || []).forEach(n => recent3Set.set(n, (recent3Set.get(n) || 0) + 3));
    tryAdd([...streak4, ...streak3, ...streak2]);
    if (picked.length < numCount) {
      // 連號不夠：從最近3期高頻補
      const repeat3 = [...recent3Set.entries()].sort((a,b) => b[1]-a[1]).map(([n]) => n);
      tryAdd(repeat3);
    }
    if (picked.length < numCount) tryAdd([...freq20Hot]);

  } else if (role === 'hot') {
    // ── 強打者 ──
    // 專長：追近20期出現頻率最高的號碼
    // 選號邏輯：頻率越高越優先，確保覆蓋最活躍的號碼
    // 跟 recent 的差別：hot 看長窗口（20期），recent 看短窗口（5期）
    tryAdd([...freq20Hot, ...hot5, ...hot10]);

  } else if (role === 'cold') {
    // ── 回補手 ──
    // 專長：追久未出現的號碼，賭回補效應
    // 選號邏輯：近20期低頻 > gap（超過平均間隔）
    // 跟 hot 完全相反，專打被忽略的號碼
    tryAdd([...freq20Cold, ...gapNums]);
    const freqSortedCold = [...freqSortedAll].reverse().filter(n => !usedSet.has(n));
    tryAdd(freqSortedCold);

  } else if (role === 'zone_fill') {
    // ── 區段填補手 ──
    // 專長：填補最近3期開獎最少的區段
    // 選號邏輯：找冷門區段（1-20, 21-40, 41-60, 61-80中最少的），從該區段選頻率最高的號碼
    // 跟 scatter 的差別：zone_fill 集中填補一個冷門區段；scatter 是各區段分散
    const safeRecentZoneDist = Array.isArray(recentZoneDist) && recentZoneDist.length === 4
      ? recentZoneDist : [0, 0, 0, 0];
    const minZoneIdx = safeRecentZoneDist.indexOf(Math.min(...safeRecentZoneDist));
    const zoneRanges = [[1,20],[21,40],[41,60],[61,80]];
    const [lo, hi] = zoneRanges[minZoneIdx];
    const zoneFreqPool = freqSortedAll.filter(n => n >= lo && n <= hi && !usedSet.has(n));
    tryAdd(zoneFreqPool);
    tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));

  } else if (role === 'recent') {
    // ── 近況觀察手 ──
    // 專長：追最近5期內出現的號碼，抓短期動態
    // 選號邏輯：最近5期開獎號碼中，重複出現次數越多越優先
    // 跟 hot 的差別：recent 只看最近5期；hot 看20期長趨勢
    const recent5Freq = new Map();
    (latest || []).forEach(n => recent5Freq.set(n, (recent5Freq.get(n) || 0) + 2));
    // freq20Hot 前5個通常跟最近5期有重疊，給額外加分
    freq20Hot.slice(0, 8).forEach(n => recent5Freq.set(n, (recent5Freq.get(n) || 0) + 1));
    const recent5Sorted = [...recent5Freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([n]) => Number(n))
      .filter(n => !usedSet.has(n));
    tryAdd(recent5Sorted);
    if (picked.length < numCount) tryAdd([...freq20Hot.slice(0, 12)]);

  } else if (role === 'tail_hot') {
    // ── 熱尾數專家 ──
    // 近20期出現最多的尾數（個位數），選同尾數的號碼
    const tailFreq = {};
    freqSortedAll.forEach(n => {
      const t = n % 10;
      tailFreq[t] = (tailFreq[t] || 0) + (numFreqMap[String(n)] || 0);
    });
    const hotTails = Object.entries(tailFreq).sort((a,b) => b[1]-a[1]).slice(0,3).map(([t]) => Number(t));
    const tailPool = freqSortedAll.filter(n => hotTails.includes(n % 10) && !usedSet.has(n));
    tryAdd(tailPool);
    if (picked.length < numCount) tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));

  } else if (role === 'tail_cold') {
    // ── 冷尾數專家 ──
    // 近20期出現最少的尾數，選同尾數的號碼等待回補
    const tailFreq2 = {};
    for (let t = 0; t <= 9; t++) tailFreq2[t] = 0;
    freqSortedAll.forEach(n => {
      tailFreq2[n % 10] = (tailFreq2[n % 10] || 0) + (numFreqMap[String(n)] || 0);
    });
    const coldTails = Object.entries(tailFreq2).sort((a,b) => a[1]-b[1]).slice(0,3).map(([t]) => Number(t));
    const coldTailPool = freqSortedAll.filter(n => coldTails.includes(n % 10) && !usedSet.has(n));
    tryAdd(coldTailPool);
    if (picked.length < numCount) tryAdd([...freqSortedAll].reverse().filter(n => !usedSet.has(n)));

  } else if (role === 'repeat') {
    // ── 重複追擊手 ──
    // 追上一期開出的號碼，有些號碼會連兩期出現
    const lastDrawNums = Array.isArray(latest) ? latest.map(Number) : [];
    tryAdd(lastDrawNums.sort((a,b) => (numFreqMap[String(b)]||0) - (numFreqMap[String(a)]||0)));
    if (picked.length < numCount) tryAdd([...freq20Hot]);

  } else if (role === 'anti_hot') {
    // ── 逆勢手 ──
    // 反向操作，追近5期完全沒出現的號碼
    const latestSet = new Set(Array.isArray(latest) ? latest.map(Number) : []);
    const freq20HotSet = new Set(freq20Hot.slice(0, 15));
    const antiPool = freqSortedAll.filter(n => !latestSet.has(n) && !freq20HotSet.has(n) && !usedSet.has(n));
    tryAdd(antiPool);
    if (picked.length < numCount) tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));

  } else if (role === 'gap_zone') {
    // ── 區段回補手 ──
    // 比 cold 更精準：找最久未出現且集中在某區段的號碼
    const safeZoneDist = Array.isArray(recentZoneDist) && recentZoneDist.length === 4 ? recentZoneDist : [0,0,0,0];
    const coldZoneIdx = safeZoneDist.indexOf(Math.min(...safeZoneDist));
    const zoneRanges = [[1,20],[21,40],[41,60],[61,80]];
    const [zlo, zhi] = zoneRanges[coldZoneIdx];
    const gapZonePool = [...freqSortedAll].reverse().filter(n => n >= zlo && n <= zhi && !usedSet.has(n));
    tryAdd(gapZonePool);
    if (picked.length < numCount) tryAdd([...freqSortedAll].reverse().filter(n => !usedSet.has(n)));

  } else if (role === 'chain') {
    // ── 連鎖追擊手 ──
    // 追跟上一期號碼相差1-3的號碼（鄰近號碼有時會連帶出現）
    const latestNums = Array.isArray(latest) ? latest.map(Number) : [];
    const chainPool = [];
    for (const n of latestNums) {
      for (let d = 1; d <= 3; d++) {
        if (n + d <= 80) chainPool.push(n + d);
        if (n - d >= 1) chainPool.push(n - d);
      }
    }
    const chainSorted = [...new Set(chainPool)]
      .filter(n => !usedSet.has(n))
      .sort((a,b) => (numFreqMap[String(b)]||0) - (numFreqMap[String(a)]||0));
    tryAdd(chainSorted);
    if (picked.length < numCount) tryAdd([...freq20Hot]);

  } else if (role === 'dominant') {
    // ── 主宰手 ──
    // 追近10期出現超過5次的超熱號，鎖定最強勢的號碼
    const dominantPool = freqSortedAll.filter(n => {
      const freq = numFreqMap[String(n)] || 0;
      return freq >= 5 && !usedSet.has(n);
    });
    tryAdd(dominantPool);
    if (picked.length < numCount) tryAdd([...freq20Hot]);

  } else if (role === 'sleeper') {
    // ── 蟄伏反撲手 ──
    // 追超過15期未出現的號碼，等待爆發回補
    const sleeperPool = gapNums.filter(n => !usedSet.has(n));
    tryAdd(sleeperPool);
    if (picked.length < numCount) tryAdd([...freq20Cold]);
    if (picked.length < numCount) tryAdd([...freqSortedAll].reverse().filter(n => !usedSet.has(n)));

  } else if (role === 'mid_zone') {
    // ── 中段集中手 ──
    // 專攻21-60的中段號碼（統計上中段號碼開出比例略高）
    const midPool = freqSortedAll.filter(n => n >= 21 && n <= 60 && !usedSet.has(n));
    tryAdd(midPool);
    if (picked.length < numCount) tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));

  } else if (role === 'edge_zone') {
    // ── 邊緣突擊手 ──
    // 專攻1-20和61-80的邊緣號碼，當中段過熱時邊緣有回補機會
    const edgePool = freqSortedAll.filter(n => (n <= 20 || n >= 61) && !usedSet.has(n));
    tryAdd(edgePool);
    if (picked.length < numCount) tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));

  } else if (role === 'odd_bias') {
    // ── 奇偶平衡手 ──
    // 近期奇數多就追偶數，近期偶數多就追奇數（平衡反向）
    const recentOdds = (latest || []).filter(n => Number(n) % 2 === 1).length;
    const recentEvens = (latest || []).filter(n => Number(n) % 2 === 0).length;
    const targetParity = recentOdds > recentEvens ? 0 : 1; // 少的那邊
    const parityPool = freqSortedAll.filter(n => n % 2 === targetParity && !usedSet.has(n));
    tryAdd(parityPool);
    if (picked.length < numCount) tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));

  } else if (role === 'sum_low') {
    // ── 低總和手 ──
    // 選號碼總和偏低的組合（偏小號碼），當近期總和偏高時使用
    const lowPool = freqSortedAll.filter(n => n <= 35 && !usedSet.has(n));
    tryAdd(lowPool);
    if (picked.length < numCount) tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));

  } else if (role === 'sum_high') {
    // ── 高總和手 ──
    // 選號碼總和偏高的組合（偏大號碼），當近期總和偏低時使用
    const highPool = freqSortedAll.filter(n => n >= 46 && !usedSet.has(n));
    tryAdd(highPool);
    if (picked.length < numCount) tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));

  } else if (role === 'balance') {
    // ── 均衡配置手 ──
    // 確保奇偶、大小、四區各有代表，最均衡的選號
    const zones4 = [[1,20],[21,40],[41,60],[61,80]];
    for (const [lo, hi] of zones4) {
      if (picked.length >= numCount) break;
      const zPool = freqSortedAll.filter(n => n >= lo && n <= hi && !usedSet.has(n));
      if (zPool[0]) { picked.push(zPool[0]); usedSet.add(zPool[0]); }
    }
    if (picked.length < numCount) tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));

  } else {
    // ✅ 修復：scatter 不再完全隨機，改為從高頻號碼各區段各選一個
    // 8個小區段各選一個高頻號碼，確保分散又命中熱區
    const smallZones = [[1,10],[11,20],[21,30],[31,40],[41,50],[51,60],[61,70],[71,80]];
    // 先從有頻率數據的號碼按區段選
    for (const [lo, hi] of smallZones) {
      if (picked.length >= numCount) break;
      const zonePool = freqSortedAll.filter(n => n >= lo && n <= hi && !usedSet.has(n));
      if (zonePool[0]) {
        picked.push(zonePool[0]);
        usedSet.add(zonePool[0]);
      }
    }
    // 不夠再補高頻號碼
    tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));
  }

  // 不足補：從高頻號碼順序補（不再隨機）
  if (picked.length < numCount) {
    tryAdd(freqSortedAll.filter(n => !usedSet.has(n)));
    // 最後才從全域補
    if (picked.length < numCount) {
      const allPool = Array.from({length: 80}, (_, i) => i + 1).filter(n => !usedSet.has(n));
      tryAdd(allPool);
    }
  }

  return picked.slice(0, numCount);
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
  const s5 = buildZoneBalanced(todayRows, recent20, historyRows, weights.zone_balanced, marketProfile, marketSnapshot, numCount);

  // ✅ 建立策略 map（固定5個 + 動態策略用通用選號）
  const baseStrategyMap = new Map([
    [s1.key, s1], [s2.key, s2], [s3.key, s3], [s4.key, s4], [s5.key, s5]
  ]);

  // 動態策略清單：如果有傳入，用動態清單；否則用固定5個
  const useKeys = dynamicStrategyKeys.length > 0 ? dynamicStrategyKeys : [s1.key, s2.key, s3.key, s4.key, s5.key];

  // ✅ 動態決定每個策略出幾組（根據近10期表現 + 盤面強度 + 加碼/減碼）
  const { allocation, totalGroups } = decideGroupCountByPerformance(recent10Stats, marketSnapshot, useKeys, forcedGroupCount);

  // ✅ 三星模式：啟用盤面感知機制，動態分配8組的選號角色
  // ✅ v17 第四階段：先用 analyzeBoardState 產出最優24顆號碼
  // 再由策略邏輯微調，讓「號碼決定策略」而不是「策略決定號碼」
  let marketCondition = null;
  let dynamicRoles = null;
  let boardState = null;
  if (starCount === 3) {
    marketCondition = detectMarketCondition(marketSnapshot, allRows);
    // ✅ 步驟七：從 marketSnapshot 取得 auto-train 計算的 roleWeights
    const roleWeights = marketSnapshot?.role_weights || {};
    dynamicRoles = decideDynamicRoleAllocation(marketCondition, totalGroups, roleWeights);
    // ✅ v17：先分析盤面，產出今期最值得覆蓋的24顆號碼和預分配的8組
    boardState = analyzeBoardState(allRows, marketSnapshot);
    console.log(`[3star] 盤面感知: 連號強度=${marketCondition.streakStrength} 熱區集中=${marketCondition.hotConcentration} 冷號壓力=${marketCondition.coldPressure} 區段偏移=${marketCondition.zoneBias}`);
    console.log(`[3star] 動態角色: ${dynamicRoles.join(', ')}`);
    console.log(`[3star v17] 盤面最優24顆: ${boardState.top24.slice(0, 12).join(',')}...`);
    console.log(`[3star v17] 盤面預分配8組: ${boardState.groups.map(g => g.join('-')).join(' | ')}`);
  }

  // ✅ 重新設計三星選號流程：先選號、再去重、最後補熱區覆蓋組

  // 建立近期開獎熱號頻率表（供熱區覆蓋組使用）
  function buildRecentHotFreq(recentRows) {
    const freq = {};
    recentRows.slice(0, 5).forEach(row => {
      parseNumbers(row.numbers).forEach(n => {
        freq[n] = (freq[n] || 0) + 3;
      });
    });
    recentRows.slice(5, 10).forEach(row => {
      parseNumbers(row.numbers).forEach(n => {
        freq[n] = (freq[n] || 0) + 2;
      });
    });
    recentRows.slice(10, 20).forEach(row => {
      parseNumbers(row.numbers).forEach(n => {
        freq[n] = (freq[n] || 0) + 1;
      });
    });
    return freq;
  }

  // 從熱號頻率表選出3個未用過的號碼（尾數盡量分散）
  // ✅ 修復：整合 freq20_hot_nums（auto-train 注入的近20期頻率數據）
  function pickHotCoverNums(hotFreq, globalUsedNums, numCount = 3) {
    // 合併兩個頻率來源：自己算的 hotFreq + auto-train 注入的 freq20_hot_nums
    const freq20Hot = Array.isArray(marketSnapshot?.freq20_hot_nums) ? marketSnapshot.freq20_hot_nums : [];
    const numFreqMap = marketSnapshot?.num_freq_map || {};

    // 合併分數：自己算的頻率 + 外部注入的頻率加倍
    const mergedFreq = { ...hotFreq };
    Object.entries(numFreqMap).forEach(([n, f]) => {
      const num = String(n).padStart ? n : n;
      mergedFreq[num] = (mergedFreq[num] || 0) + Number(f) * 2;
    });
    // freq20_hot_nums 裡的號碼額外加分（排名越前加分越多）
    freq20Hot.forEach((n, idx) => {
      const key = String(n).padStart(2, '0');
      mergedFreq[key] = (mergedFreq[key] || 0) + Math.max(1, 10 - idx);
    });

    const sorted = Object.entries(mergedFreq)
      .sort((a, b) => b[1] - a[1])
      .map(([n]) => Number(n))
      .filter(n => !globalUsedNums.has(n) && n >= 1 && n <= 80);

    const picked = [];
    const pickedTails = new Set();

    // 第一輪：優先選尾數不重複的
    for (const n of sorted) {
      if (picked.length >= numCount) break;
      const tail = n % 10;
      if (!pickedTails.has(tail)) {
        picked.push(n);
        pickedTails.add(tail);
      }
    }

    // 第二輪：尾數不夠分散時直接補足
    for (const n of sorted) {
      if (picked.length >= numCount) break;
      if (!picked.includes(n)) picked.push(n);
    }

    // 還不夠：從全域1-80補
    if (picked.length < numCount) {
      for (let n = 1; n <= 80; n++) {
        if (picked.length >= numCount) break;
        if (!globalUsedNums.has(n) && !picked.includes(n)) picked.push(n);
      }
    }

    return picked.slice(0, numCount);
  }

  // Step 1：依照 allocation 展開所有策略組
  // ✅ 三星模式：用盤面感知動態角色選號
  // ✅ 四星模式：維持原本固定策略邏輯
  const rawStrategies = [];

  if (starCount === 3 && marketCondition && dynamicRoles) {
    // ✅ v17 第四階段：以 boardState 預分配的8組為基礎
    // 策略只負責從盤面最優號碼裡微調，不再主導選號
    const globalUsedForRoles = new Set();

    // ✅ v19 修復：直接用 buildNumsByRole 按角色選號
    // 原本的 boardState.groups 路徑讓每期號碼都是相同的熱號（33,63,37...），
    // 因為 top24 幾乎永遠是同樣的頻率熱號，跟 market_phase 無關
    // 現在改為：角色真正決定選號邏輯，continuation/bias/chaos/rotation 產生真正不同的號碼
    dynamicRoles.forEach((role, idx) => {
      const nums = buildNumsByRole(role, marketCondition, globalUsedForRoles, numCount, idx * 17, marketSnapshot);
      nums.forEach(n => globalUsedForRoles.add(n));
      const strategyKey = useKeys[idx] || `dynamic_${role}_${idx + 1}`;
      rawStrategies.push({
        key: strategyKey,
        label: `${role.toUpperCase()}｜${strategyKey}`,
        nums,
        reason: `盤面感知v19[${role}] 盤相:${marketCondition.marketPhase} 連號:${marketCondition.streakStrength} 熱區:${marketCondition.hotConcentration} 冷號:${marketCondition.coldPressure}`,
        meta: {
          model: 'v19_role_driven',
          role,
          market_condition: {
            streakStrength: marketCondition.streakStrength,
            hotConcentration: marketCondition.hotConcentration,
            coldPressure: marketCondition.coldPressure,
            zoneBias: marketCondition.zoneBias,
            marketPhase: marketCondition.marketPhase
          },
          star_mode: 3
        },
        groupSlot: idx + 1
      });
    });
  } else {
    // 四星：維持原本固定策略邏輯
    useKeys.forEach(key => {
      const s = baseStrategyMap.get(key) || buildHotChaseForKey(key, todayRows, recent20, historyRows, weights.hot_chase, marketProfile, marketSnapshot, allRows);
      const slots = allocation[key] || 1;
      for (let i = 0; i < slots; i++) {
        rawStrategies.push({ ...s, key, groupSlot: i + 1 });
      }
    });
  }

  // ✅ v19 移除 dedupeStrategies：各角色邏輯天生選不同號碼，去重反而破壞選號品質
  // hot選熱號、cold選冷號、streak選連號，本來就不重複，不需要強制去重
  const deduped = rawStrategies.map((s, idx) => ({ ...s, groupNo: idx + 1 }));

  // Step 3：三星模式 - 替換最後2組為純熱區覆蓋組
  if (starCount === 3 && deduped.length >= 3) {
    const hotFreq = buildRecentHotFreq(allRows);

    // ✅ 不限制已用號碼，讓熱區和冷區覆蓋自由選最強號碼
    const hotNums1 = pickHotCoverNums(hotFreq, new Set(), numCount);
    const hotNums2 = pickHotCoverNums(hotFreq, new Set([...hotNums1]), numCount);

    // 替換最後2組：第1組熱區覆蓋，第2組改為冷號覆蓋
    // ✅ v16：熱冷各一，平衡覆蓋（數據顯示 gap_zone_rotation 冷號命中率最高）
    deduped[deduped.length - 2] = {
      key: 'hot_zone_cover_1',
      label: '熱區覆蓋1',
      groupNo: deduped.length - 1,
      nums: hotNums1,
      reason: '強制熱區覆蓋：近期開獎高頻號碼',
      meta: { model: 'hot_zone_cover', focus: 'coverage_boost', star_mode: 3 }
    };

    // ✅ v16：第2組改為冷號覆蓋（久未出現的回補號碼）
    const freq20Cold = Array.isArray(marketSnapshot?.freq20_cold_nums) ? marketSnapshot.freq20_cold_nums : [];
    const gapNums = extractGapNumbers(marketSnapshot, 15);
    const coldCandidates = [...new Set([...freq20Cold, ...gapNums])];
    let coldNums = coldCandidates.slice(0, 3).map(Number).filter(n => n >= 1 && n <= 80);

    // 不夠3顆從低頻補
    if (coldNums.length < 3) {
      const numFreqMap = marketSnapshot?.num_freq_map || {};
      const freqSortedCold = Object.entries(numFreqMap)
        .map(([n, f]) => ({ n: Number(n), f: Number(f) }))
        .filter(x => x.n >= 1 && x.n <= 80 && !coldNums.includes(x.n))
        .sort((a, b) => a.f - b.f)
        .map(x => x.n);
      coldNums = [...coldNums, ...freqSortedCold].slice(0, 3);
    }

    // 還不夠就退回熱區覆蓋
    if (coldNums.length < 3) coldNums = hotNums2;

    deduped[deduped.length - 1] = {
      key: 'cold_zone_cover',
      label: '冷區覆蓋',
      groupNo: deduped.length,
      nums: coldNums,
      reason: '強制冷號覆蓋：久未出現的回補號碼',
      meta: { model: 'cold_zone_cover', focus: 'rebound_coverage', star_mode: 3 }
    };
  }

  const strategies = deduped;

  // ✅ 每組只取前 numCount 個號碼
  const finalStrategies = strategies.map((s) => ({
    ...s,
    nums: uniq(s.nums).slice(0, numCount)
  }));

  return {
    mode: starCount === 3
      ? `bingo_v4_3star_${totalGroups}group_board_driven_v17`
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
