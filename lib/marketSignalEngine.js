function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function uniqueAsc(nums) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

export function buildMarketSignalFromNumbers(numbers = []) {
  const nums = uniqueAsc(numbers);
  if (!nums.length) {
    return {
      sum: 0,
      span: 0,
      sum_tail: 0,
      odd_count: 0,
      even_count: 0,
      big_count: 0,
      small_count: 0,
      zone_1_count: 0,
      zone_2_count: 0,
      zone_3_count: 0,
      zone_4_count: 0
    };
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

    if (n >= 1 && n <= 20) zone1 += 1;
    else if (n <= 40) zone2 += 1;
    else if (n <= 60) zone3 += 1;
    else zone4 += 1;
  }

  return {
    sum,
    span,
    sum_tail: sumTail,
    odd_count: oddCount,
    even_count: evenCount,
    big_count: bigCount,
    small_count: smallCount,
    zone_1_count: zone1,
    zone_2_count: zone2,
    zone_3_count: zone3,
    zone_4_count: zone4
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
      sum <= 700 ? 'low' : sum >= 860 ? 'high' : 'mid'
  };
}

export function buildMarketSignalFromDrawRow(drawRow = {}, drawNumbersCol = 'numbers') {
  const raw = drawRow?.[drawNumbersCol];

  let numbers = [];
  if (Array.isArray(raw)) {
    numbers = raw.map(Number).filter(Number.isFinite);
  } else if (typeof raw === 'string') {
    numbers = raw
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite);
  }

  const signal = buildMarketSignalFromNumbers(numbers);
  const summary = buildMarketSignalSummary(signal);

  return {
    ...signal,
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

  return {
    latest: latestSignal,
    prev: prevSignal,
    third: thirdSignal,
    trend: {
      sum_delta_1: latestSignal && prevSignal ? latestSignal.sum - prevSignal.sum : 0,
      span_delta_1: latestSignal && prevSignal ? latestSignal.span - prevSignal.span : 0,
      tail_changed:
        latestSignal && prevSignal ? latestSignal.sum_tail !== prevSignal.sum_tail : false
    }
  };
}
