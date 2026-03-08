const STRATEGY_KEYS = [
  "hot_chase",
  "rebound",
  "zone_balanced",
  "pattern_structure"
];

const DEFAULT_STATS = {
  hot_chase: {
    key: "hot_chase",
    label: "熱門追擊型",
    rounds: 0,
    totalHits: 0,
    hit0: 0,
    hit1: 0,
    hit2: 0,
    hit3: 0,
    hit4: 0,
    recentHits: [],
    weight: 1
  },
  rebound: {
    key: "rebound",
    label: "回補反彈型",
    rounds: 0,
    totalHits: 0,
    hit0: 0,
    hit1: 0,
    hit2: 0,
    hit3: 0,
    hit4: 0,
    recentHits: [],
    weight: 1
  },
  zone_balanced: {
    key: "zone_balanced",
    label: "區段平衡型",
    rounds: 0,
    totalHits: 0,
    hit0: 0,
    hit1: 0,
    hit2: 0,
    hit3: 0,
    hit4: 0,
    recentHits: [],
    weight: 1
  },
  pattern_structure: {
    key: "pattern_structure",
    label: "盤型結構型",
    rounds: 0,
    totalHits: 0,
    hit0: 0,
    hit1: 0,
    hit2: 0,
    hit3: 0,
    hit4: 0,
    recentHits: [],
    weight: 1
  }
};

function cloneDefaultStats() {
  return JSON.parse(JSON.stringify(DEFAULT_STATS));
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function safeJsonParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getStorage() {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function createLearningStorageKeys(prefix = "fuwei_bingo_strategy_learning_v2") {
  return {
    stats: `${prefix}_stats`,
    seen: `${prefix}_seen`
  };
}

export function readStrategyStats(storageKey) {
  const storage = getStorage();
  if (!storage) return cloneDefaultStats();

  const parsed = safeJsonParse(storage.getItem(storageKey), cloneDefaultStats());
  const base = cloneDefaultStats();

  STRATEGY_KEYS.forEach(key => {
    base[key] = {
      ...base[key],
      ...(parsed[key] || {})
    };
  });

  return recalculateAllWeights(base);
}

export function saveStrategyStats(storageKey, stats) {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(storageKey, JSON.stringify(stats));
}

export function readSeenLearningMap(storageKey) {
  const storage = getStorage();
  if (!storage) return {};
  return safeJsonParse(storage.getItem(storageKey), {});
}

export function saveSeenLearningMap(storageKey, seenMap) {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(storageKey, JSON.stringify(seenMap));
}

export function deriveStrategyKeyFromLabel(label = "") {
  const text = String(label);

  if (text.includes("熱門追擊")) return "hot_chase";
  if (text.includes("回補反彈")) return "rebound";
  if (text.includes("區段平衡")) return "zone_balanced";
  if (text.includes("盤型結構")) return "pattern_structure";

  return null;
}

export function recalculateWeight(stat) {
  const rounds = Number(stat.rounds || 0);
  const totalHits = Number(stat.totalHits || 0);

  if (rounds <= 0) {
    return {
      ...stat,
      weight: 1
    };
  }

  const avgHit = totalHits / rounds;
  const zeroRate = Number(stat.hit0 || 0) / rounds;
  const recentAvg = avg(stat.recentHits || []);
  const highHitRate = (Number(stat.hit3 || 0) + Number(stat.hit4 || 0)) / rounds;

  const weight =
    0.75 +
    avgHit * 0.22 +
    recentAvg * 0.28 +
    highHitRate * 0.35 -
    zeroRate * 0.30;

  return {
    ...stat,
    weight: Number(clamp(weight, 0.55, 1.85).toFixed(3))
  };
}

export function recalculateAllWeights(stats) {
  const next = cloneDefaultStats();

  STRATEGY_KEYS.forEach(key => {
    next[key] = recalculateWeight({
      ...next[key],
      ...(stats[key] || {})
    });
  });

  return next;
}

export function applyLearningFromCompareResult(stats, compareResult) {
  const next = cloneDefaultStats();

  STRATEGY_KEYS.forEach(key => {
    next[key] = {
      ...next[key],
      ...(stats[key] || {})
    };
  });

  const rows = Array.isArray(compareResult?.results) ? compareResult.results : [];

  rows.forEach(row => {
    const key = deriveStrategyKeyFromLabel(row?.label || "");
    if (!key) return;

    const hitCount = Number(row?.hitCount || 0);
    const stat = next[key];

    stat.rounds += 1;
    stat.totalHits += hitCount;

    if (hitCount <= 0) stat.hit0 += 1;
    if (hitCount === 1) stat.hit1 += 1;
    if (hitCount === 2) stat.hit2 += 1;
    if (hitCount === 3) stat.hit3 += 1;
    if (hitCount >= 4) stat.hit4 += 1;

    stat.recentHits = [...(stat.recentHits || []), hitCount].slice(-12);
  });

  return recalculateAllWeights(next);
}

export function buildLearningFingerprint(mode, predictionId, drawNo) {
  return `${mode || "unknown"}:${predictionId || "no_id"}:${drawNo || "no_draw"}`;
}

export function applyCompareLearningOnce({
  statsKey,
  seenKey,
  mode,
  predictionId,
  drawNo,
  compareResult
}) {
  const seenMap = readSeenLearningMap(seenKey);
  const fingerprint = buildLearningFingerprint(mode, predictionId, drawNo);

  if (seenMap[fingerprint]) {
    return {
      applied: false,
      reason: "already_learned",
      stats: readStrategyStats(statsKey)
    };
  }

  const current = readStrategyStats(statsKey);
  const next = applyLearningFromCompareResult(current, compareResult);

  seenMap[fingerprint] = {
    at: new Date().toISOString(),
    mode,
    predictionId,
    drawNo
  };

  saveStrategyStats(statsKey, next);
  saveSeenLearningMap(seenKey, seenMap);

  return {
    applied: true,
    reason: "learned",
    stats: next
  };
}

export function getStrategyWeightMap(stats) {
  const normalized = recalculateAllWeights(stats || {});
  return {
    hot_chase: normalized.hot_chase.weight,
    rebound: normalized.rebound.weight,
    zone_balanced: normalized.zone_balanced.weight,
    pattern_structure: normalized.pattern_structure.weight
  };
}

export function summarizeStrategyStats(stats) {
  const normalized = recalculateAllWeights(stats || {});
  return STRATEGY_KEYS.map(key => {
    const s = normalized[key];
    const rounds = Number(s.rounds || 0);
    const avgHit = rounds ? Number((s.totalHits / rounds).toFixed(3)) : 0;

    return {
      key,
      label: s.label,
      rounds,
      avgHit,
      weight: s.weight,
      hit0: s.hit0 || 0,
      hit1: s.hit1 || 0,
      hit2: s.hit2 || 0,
      hit3: s.hit3 || 0,
      hit4: s.hit4 || 0,
      recentHits: s.recentHits || []
    };
  });
}
