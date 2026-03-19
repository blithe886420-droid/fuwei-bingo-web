export function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => Number(String(s).trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function unique(arr = []) {
  return [...new Set(arr)];
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function getHitNumbers(predNums, drawNums) {
  const set = new Set(drawNums);
  return predNums.filter((n) => set.has(n));
}

function buildGroupResult(group, drawNums, costPerGroup) {
  const nums = safeArray(group?.nums);
  const hitNumbers = getHitNumbers(nums, drawNums);
  const hitCount = hitNumbers.length;

  let reward = 0;
  if (hitCount >= 4) reward = 1000;
  else if (hitCount === 3) reward = 75;

  const cost = costPerGroup;
  const profit = reward - cost;

  return {
    ...group,
    hit_numbers: hitNumbers,
    hit_count: hitCount,
    reward,
    cost,
    profit
  };
}

function buildPeriodResult({
  drawRow,
  groups,
  drawNoCol,
  drawTimeCol,
  drawNumbersCol,
  costPerGroupPerPeriod
}) {
  const drawNums = parseDrawNumbers(drawRow?.[drawNumbersCol]);

  const groupResults = groups.map((g) =>
    buildGroupResult(g, drawNums, costPerGroupPerPeriod)
  );

  return {
    draw_no: drawRow?.[drawNoCol],
    draw_time: drawRow?.[drawTimeCol],
    numbers: drawNums,
    groups: groupResults
  };
}

function summarize(compareResult) {
  let totalHit = 0;
  let best = 0;

  for (const period of compareResult) {
    for (const g of period.groups || []) {
      totalHit += g.hit_count || 0;
      best = Math.max(best, g.hit_count || 0);
    }
  }

  return {
    hitCount: totalHit,
    verdict: best >= 3 ? 'good' : 'normal'
  };
}

export function parsePredictionGroups(prediction, expectedCount = 4) {
  const raw = prediction?.groups_json;

  if (Array.isArray(raw)) return raw;

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }

  return [];
}

export function buildComparePayload({
  prediction,
  groups,
  drawRows,
  drawNoCol = 'draw_no',
  drawTimeCol = 'draw_time',
  drawNumbersCol = 'numbers',
  costPerGroupPerPeriod = 25
}) {
  const safeGroups = safeArray(groups);

  const compareResult = safeArray(drawRows).map((row) =>
    buildPeriodResult({
      drawRow: row,
      groups: safeGroups,
      drawNoCol,
      drawTimeCol,
      drawNumbersCol,
      costPerGroupPerPeriod
    })
  );

  const summary = summarize(compareResult);

  return {
    compareResult,
    hitCount: summary.hitCount,
    verdict: summary.verdict,
    resultForApp: {
      totalHit: summary.hitCount,
      verdict: summary.verdict
    }
  };
}
