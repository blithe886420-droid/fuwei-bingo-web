function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))]
    .filter((n) => n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseNumbersFromValue(raw) {
  if (Array.isArray(raw)) {
    return uniqueAsc(raw);
  }

  if (typeof raw === 'string') {
    return uniqueAsc(
      raw
        .replace(/[{}[\]]/g, ' ')
        .split(/[,\s|/]+/)
        .map((s) => Number(String(s).trim()))
    );
  }

  if (raw && typeof raw === 'object') {
    return parseNumbersFromValue(
      raw.numbers ||
      raw.draw_numbers ||
      raw.result_numbers ||
      raw.open_numbers ||
      raw.nums ||
      []
    );
  }

  return [];
}

function getZoneIndex(n) {
  if (n >= 1 && n <= 20) return 1;
  if (n <= 40) return 2;
  if (n <= 60) return 3;
  return 4;
}

function getTail(n) {
  return Math.abs(toInt(n, 0)) % 10;
}

function buildEmptySignal() {
  return {
    count: 0,
    min: 0,
    max: 0,
    sum: 0,
    avg: 0,
    median: 0,
    span: 0,
    sum_tail: 0,
    odd_count: 0,
    even_count: 0,
    big_count: 0,
    small_count: 0,
    zone_1_count: 0,
    zone_2_count: 0,
    zone_3_count: 0,
    zone_4_count: 0,
    consecutive_pairs: 0,
    max_consecutive_chain: 0,
    tail_repeat_pairs: 0,
    unique_tail_count: 0,
    tail_0_count: 0,
    tail_1_count: 0,
    tail_2_count: 0,
    tail_3_count: 0,
    tail_4_count: 0,
    tail_5_count: 0,
    tail_6_count: 0,
    tail_7_count: 0,
    tail_8_count: 0,
    tail_9_count: 0
  };
}

function calcMedian(nums = []) {
  if (!nums.length) return 0;
  const sorted = uniqueAsc(nums);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return round2((sorted[mid - 1] + sorted[mid]) / 2);
}

function calcConsecutiveStats(nums = []) {
  if (!nums.length) {
    return {
      consecutive_pairs: 0,
      max_consecutive_chain: 0
    };
  }

  let pairs = 0;
  let currentChain = 1;
  let maxChain = 1;

  for (let i = 1; i < nums.length; i += 1) {
    if (nums[i] === nums[i - 1] + 1) {
      pairs += 1;
      currentChain += 1;
      if (currentChain > maxChain) maxChain = currentChain;
    } else {
      currentChain = 1;
    }
  }

  return {
    consecutive_pairs: pairs,
    max_consecutive_chain: maxChain
  };
}

function buildTailStats(nums = []) {
  const counts = Array.from({ length: 10 }, () => 0);

  for (const n of nums) {
    counts[getTail(n)] += 1;
  }

  let repeatPairs = 0;
  let uniqueTailCount = 0;

  for (const count of counts) {
    if (count > 0) uniqueTailCount += 1;
    if (count >= 2) repeatPairs += count - 1;
  }

  return {
    tail_repeat_pairs: repeatPairs,
    unique_tail_count: uniqueTailCount,
    tail_0_count: counts[0],
    tail_1_count: counts[1],
    tail_2_count: counts[2],
    tail_3_count: counts[3],
    tail_4_count: counts[4],
    tail_5_count: counts[5],
    tail_6_count: counts[6],
    tail_7_count: counts[7],
    tail_8_count: counts[8],
    tail_9_count: counts[9]
  };
}

function buildHotNumberStats(rows = [], take = 5, drawNumbersCol = 'numbers') {
  const safeRows = Array.isArray(rows) ? rows.slice(0, Math.max(0, take)) : [];
  const countMap = new Map();

  for (const row of safeRows) {
    const nums = parseNumbersFromValue(row?.[drawNumbersCol]);
    for (const n of nums) {
      countMap.set(n, (countMap.get(n) || 0) + 1);
    }
  }

  const entries = [...countMap.entries()]
    .map(([num, count]) => ({
      num,
      count
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.num - b.num;
    });

  return {
    window: take,
    items: entries,
    numbers: entries.map((x) => x.num),
    map: Object.fromEntries(entries.map((x) => [String(x.num), x.count]))
  };
}

function buildCurrentStreakStats(rows = [], drawNumbersCol = 'numbers') {
  const safeRows = Array.isArray(rows) ? rows : [];
  const streakMap = new Map();

  if (!safeRows.length) {
    return {
      map: {},
      streak2: [],
      streak3: [],
      streak4: [],
      max_streak: 0
    };
  }

  const latestNums = parseNumbersFromValue(safeRows[0]?.[drawNumbersCol]);
  for (const n of latestNums) {
    streakMap.set(n, 1);
  }

  for (let i = 1; i < safeRows.length; i += 1) {
    const currentSet = new Set(parseNumbersFromValue(safeRows[i]?.[drawNumbersCol]));
    for (const [num, streak] of [...streakMap.entries()]) {
      if (currentSet.has(num)) {
        streakMap.set(num, streak + 1);
      } else {
        streakMap.delete(num);
      }
    }
    if (!streakMap.size) break;
  }

  const entries = [...streakMap.entries()]
    .map(([num, streak]) => ({
      num,
      streak
    }))
    .sort((a, b) => {
      if (b.streak !== a.streak) return b.streak - a.streak;
      return a.num - b.num;
    });

  const streak2 = entries.filter((x) => x.streak >= 2).map((x) => x.num);
  const streak3 = entries.filter((x) => x.streak >= 3).map((x) => x.num);
  const streak4 = entries.filter((x) => x.streak >= 4).map((x) => x.num);
  const maxStreak = entries.length ? entries[0].streak : 0;

  return {
    map: Object.fromEntries(entries.map((x) => [String(x.num), x.streak])),
    items: entries,
    streak2,
    streak3,
    streak4,
    max_streak: maxStreak
  };
}

function buildRecentDrawDigest(rows = [], take = 5, drawNumbersCol = 'numbers') {
  return (Array.isArray(rows) ? rows.slice(0, Math.max(0, take)) : []).map((row, idx) => {
    const nums = parseNumbersFromValue(row?.[drawNumbersCol]);
    return {
      index: idx,
      draw_no:
        row?.draw_no ??
        row?.drawNo ??
        row?.period ??
        row?.issue ??
        null,
      draw_date:
        row?.draw_date ??
        row?.date ??
        row?.drawDay ??
        null,
      draw_time:
        row?.draw_time ??
        row?.time ??
        null,
      numbers: nums
    };
  });
}

function pickTopOverlap(hotStatsA = {}, hotStatsB = {}, limit = 10) {
  const mapA = hotStatsA?.map || {};
  const mapB = hotStatsB?.map || {};
  const overlap = [];

  for (let n = 1; n <= 80; n += 1) {
    const a = toInt(mapA[String(n)], 0);
    const b = toInt(mapB[String(n)], 0);
    if (a > 0 && b > 0) {
      overlap.push({
        num: n,
        score: a + b,
        a,
        b
      });
    }
  }

  return overlap
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      if (y.a !== x.a) return y.a - x.a;
      if (y.b !== x.b) return y.b - x.b;
      return x.num - y.num;
    })
    .slice(0, Math.max(0, limit));
}

export function buildMarketSignalFromNumbers(numbers = []) {
  const nums = uniqueAsc(numbers);
  if (!nums.length) {
    return buildEmptySignal();
  }

  const sum = nums.reduce((acc, n) => acc + n, 0);
  const span = nums[nums.length - 1] - nums[0];
  const sumTail = sum % 10;

  let oddCount = 0;
  let evenCount = 0;
  let bigCount = 0;
  let smallCount = 0;
  let zone1 = 0;
  let zone2 = 0;
  let zone3 = 0;
  let zone4 = 0;

  for (const n of nums) {
    if (n % 2 === 0) evenCount += 1;
    else oddCount += 1;

    if (n >= 41) bigCount += 1;
    else smallCount += 1;

    const zoneIndex = getZoneIndex(n);
    if (zoneIndex === 1) zone1 += 1;
    else if (zoneIndex === 2) zone2 += 1;
    else if (zoneIndex === 3) zone3 += 1;
    else zone4 += 1;
  }

  const consecutiveStats = calcConsecutiveStats(nums);
  const tailStats = buildTailStats(nums);

  return {
    count: nums.length,
    min: nums[0],
    max: nums[nums.length - 1],
    sum,
    avg: round2(sum / nums.length),
    median: calcMedian(nums),
    span,
    sum_tail: sumTail,
    odd_count: oddCount,
    even_count: evenCount,
    big_count: bigCount,
    small_count: smallCount,
    zone_1_count: zone1,
    zone_2_count: zone2,
    zone_3_count: zone3,
    zone_4_count: zone4,
    ...consecutiveStats,
    ...tailStats
  };
}

export function buildMarketSignalSummary(signal = {}) {
  const sum = toInt(signal.sum, 0);
  const span = toInt(signal.span, 0);
  const sumTail = toInt(signal.sum_tail, 0);

  const oddCount = toInt(signal.odd_count, 0);
  const evenCount = toInt(signal.even_count, 0);
  const bigCount = toInt(signal.big_count, 0);
  const smallCount = toInt(signal.small_count, 0);

  const zoneCounts = [
    toInt(signal.zone_1_count, 0),
    toInt(signal.zone_2_count, 0),
    toInt(signal.zone_3_count, 0),
    toInt(signal.zone_4_count, 0)
  ];

  const hotZoneIndex = zoneCounts.indexOf(Math.max(...zoneCounts)) + 1;
  const consecutivePairs = toInt(signal.consecutive_pairs, 0);
  const maxConsecutiveChain = toInt(signal.max_consecutive_chain, 0);
  const tailRepeatPairs = toInt(signal.tail_repeat_pairs, 0);
  const uniqueTailCount = toInt(signal.unique_tail_count, 0);

  return {
    sum,
    span,
    sum_tail: sumTail,
    odd_even_bias:
      oddCount > evenCount ? 'odd' : oddCount < evenCount ? 'even' : 'balanced',
    big_small_bias:
      bigCount > smallCount ? 'big' : bigCount < smallCount ? 'small' : 'balanced',
    hot_zone: hotZoneIndex,
    zone_counts: zoneCounts,
    compactness:
      span <= 55 ? 'tight' : span >= 72 ? 'wide' : 'normal',
    sum_band:
      sum <= 700 ? 'low' : sum >= 860 ? 'high' : 'mid',
    consecutive_pressure:
      maxConsecutiveChain >= 3 ? 'high' : consecutivePairs >= 1 ? 'mid' : 'low',
    tail_pressure:
      tailRepeatPairs >= 3 ? 'high' : tailRepeatPairs >= 1 ? 'mid' : 'low',
    tail_spread:
      uniqueTailCount >= 8 ? 'wide' : uniqueTailCount <= 5 ? 'tight' : 'normal'
  };
}

export function buildMarketSignalFromDrawRow(drawRow = {}, drawNumbersCol = 'numbers') {
  const numbers = parseNumbersFromValue(drawRow?.[drawNumbersCol]);
  const signal = buildMarketSignalFromNumbers(numbers);
  const summary = buildMarketSignalSummary(signal);

  return {
    ...signal,
    numbers,
    summary
  };
}

export function buildRecentMarketSignalSnapshot(rows = [], drawNumbersCol = 'numbers') {
  const safeRows = Array.isArray(rows) ? rows : [];
  const latest = safeRows[0] || null;
  const prev = safeRows[1] || null;
  const third = safeRows[2] || null;

  const latestSignal = latest ? buildMarketSignalFromDrawRow(latest, drawNumbersCol) : null;
  const prevSignal = prev ? buildMarketSignalFromDrawRow(prev, drawNumbersCol) : null;
  const thirdSignal = third ? buildMarketSignalFromDrawRow(third, drawNumbersCol) : null;

  const hot5 = buildHotNumberStats(safeRows, 5, drawNumbersCol);
  const hot10 = buildHotNumberStats(safeRows, 10, drawNumbersCol);
  const hot20 = buildHotNumberStats(safeRows, 20, drawNumbersCol);
  const streaks = buildCurrentStreakStats(safeRows, drawNumbersCol);
  const recent5 = buildRecentDrawDigest(safeRows, 5, drawNumbersCol);
  const hot5And10 = pickTopOverlap(hot5, hot10, 12);
  const hot10And20 = pickTopOverlap(hot10, hot20, 12);

  // ===== 市場盤型判斷（短版 v1）=====
  const streak2Count = Array.isArray(streaks?.streak2) ? streaks.streak2.length : 0;
  const streak3Count = Array.isArray(streaks?.streak3) ? streaks.streak3.length : 0;

  const recentSet = new Set();
  recent5.forEach((draw) => {
    (draw?.numbers || []).forEach((n) => recentSet.add(n));
  });

  const recentUniqueCount = recentSet.size;

  const hot10Set = new Set(Array.isArray(hot10?.numbers) ? hot10.numbers : []);
  let hot10Overlap = 0;

  recentSet.forEach((n) => {
    if (hot10Set.has(n)) hot10Overlap += 1;
  });

  const continuationScore =
    streak2Count * 1 +
    streak3Count * 3;

  const rotationScore =
    recentUniqueCount * 1 +
    (80 - hot10Overlap) * 0.5;

  const market_phase =
    continuationScore > rotationScore
      ? 'continuation'
      : 'rotation';

  const hotRepeatCount = hot10And20.length + hot5And10.length;
  const maxStreak = toInt(streaks?.max_streak, 0);
  const trend_strength =
    continuationScore >= rotationScore + 8
      ? 'strong'
      : continuationScore >= rotationScore + 3
        ? 'mid'
        : rotationScore >= continuationScore + 6
          ? 'rotation_strong'
          : 'normal';

  const market_type =
    maxStreak >= 4 || hotRepeatCount >= 18
      ? 'strong_trend'
      : maxStreak >= 3 || hotRepeatCount >= 10
        ? 'weak_trend'
        : 'random';

  const strategy_mode_hint =
    market_type === 'strong_trend'
      ? 'hot'
      : market_type === 'weak_trend'
        ? 'mix'
        : 'cold';

  const risk_mode_hint =
    market_type === 'strong_trend'
      ? 'aggressive'
      : market_type === 'weak_trend'
        ? 'balanced'
        : 'safe';

  const confidence_score =
    market_type === 'strong_trend'
      ? 74 + Math.min(18, hotRepeatCount)
      : market_type === 'weak_trend'
        ? 56 + Math.min(12, hotRepeatCount)
        : 42 + Math.min(8, maxStreak);

  return {
    latest: latestSignal,
    prev: prevSignal,
    third: thirdSignal,

    market_phase,
    market_type,
    trend_strength,
    strategy_mode_hint,
    risk_mode_hint,
    confidence_score,

    trend: {
      sum_delta_1: latestSignal && prevSignal ? latestSignal.sum - prevSignal.sum : 0,
      span_delta_1: latestSignal && prevSignal ? latestSignal.span - prevSignal.span : 0,
      tail_changed:
        latestSignal && prevSignal ? latestSignal.sum_tail !== prevSignal.sum_tail : false,
      odd_shift:
        latestSignal && prevSignal
          ? latestSignal.odd_count - prevSignal.odd_count
          : 0,
      big_shift:
        latestSignal && prevSignal
          ? latestSignal.big_count - prevSignal.big_count
          : 0
    },

    recent_5: recent5,

    hot_windows: {
      hot_5: hot5,
      hot_10: hot10,
      hot_20: hot20
    },

    streaks: {
      ...streaks
    },

    streak2: streaks.streak2,
    streak3: streaks.streak3,
    streak4: streaks.streak4,

    hot_5_numbers: hot5.numbers,
    hot_10_numbers: hot10.numbers,
    hot_20_numbers: hot20.numbers,

    hot_overlap: {
      hot5_hot10: hot5And10,
      hot10_hot20: hot10And20
    },

    decision_basis: {
      attack_core_numbers: uniqueAsc([
        ...streaks.streak3,
        ...hot5And10.slice(0, 8).map((x) => x.num)
      ]).slice(0, 12),

      extend_numbers: uniqueAsc([
        ...streaks.streak2,
        ...hot10.numbers.slice(0, 12)
      ]).slice(0, 16),

      guard_numbers: uniqueAsc([
        ...hot20.numbers.slice(0, 16)
      ]).slice(0, 16),

      recent_focus_numbers: uniqueAsc(
        recent5.flatMap((row) => row.numbers || [])
      ).slice(0, 20)
    },

    version: 'market-signal-v3-trend-pack'
  };
}

export function buildStrategyDecisionFromSnapshot(snapshot = {}) {
  const marketType = String(snapshot?.market_type || '').trim().toLowerCase();
  const marketPhase = String(snapshot?.market_phase || '').trim().toLowerCase();
  const confidenceScore = toInt(snapshot?.confidence_score, 50);

  if (marketType === 'strong_trend') {
    return {
      market_type: 'strong_trend',
      market_phase: marketPhase || 'continuation',
      strategy_mode: 'hot',
      risk_mode: 'aggressive',
      preferred_roles: ['attack', 'extend', 'recent', 'guard'],
      confidence_score: confidenceScore
    };
  }

  if (marketType === 'weak_trend') {
    return {
      market_type: 'weak_trend',
      market_phase: marketPhase || 'continuation',
      strategy_mode: 'mix',
      risk_mode: 'balanced',
      preferred_roles: ['extend', 'attack', 'guard', 'recent'],
      confidence_score: confidenceScore
    };
  }

  return {
    market_type: 'random',
    market_phase: marketPhase || 'rotation',
    strategy_mode: 'cold',
    risk_mode: 'safe',
    preferred_roles: ['guard', 'extend', 'recent', 'attack'],
    confidence_score: confidenceScore
  };
}
