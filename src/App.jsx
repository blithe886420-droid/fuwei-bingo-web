import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TABS = {
  DASHBOARD: 'dashboard',
  PREDICT: 'predict',
  MARKET: 'market'
};

const TAB_ITEMS = [
  { key: TABS.DASHBOARD, label: 'AI狀態', icon: '🏠' },
  { key: TABS.PREDICT, label: '預測下注', icon: '🎯' },
  { key: TABS.MARKET, label: '市場資料', icon: '📊' }
];

const LOOP_INTERVAL_MS = 180000;
const NIGHT_STOP_START_MINUTES = 0;
const NIGHT_STOP_END_MINUTES = 7 * 60;

const FORMAL_BATCH_LIMIT = 3;
const FORMAL_GROUP_COUNT = 4;
const COST_PER_GROUP = 25;

const ANALYSIS_PERIOD_OPTIONS = [5, 10, 20, 50];

const STRATEGY_MODE_OPTIONS = [
  { key: 'hot', label: '追熱策略', desc: '偏向近期熱門號與連續熱勢' },
  { key: 'cold', label: '補冷策略', desc: '偏向補位冷號與久未出現號' },
  { key: 'mix', label: '均衡策略', desc: '熱冷混合，分散風險與提高覆蓋' },
  { key: 'burst', label: '爆發策略', desc: '接受波動，追求較高命中上限' }
];

const RISK_MODE_OPTIONS = [
  { key: 'safe', label: '保守', desc: '以穩定中 2 為主' },
  { key: 'balanced', label: '平衡', desc: '兼顧中 2 與中 3' },
  { key: 'aggressive', label: '進攻', desc: '偏向中 3 的主力組' },
  { key: 'sniper', label: '衝高', desc: '接受波動，拚中 4 爆發' }
];

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmtText(v, fallback = '--') {
  if (v === null || v === undefined || v === '') return fallback;
  return String(v);
}

function fmtDateTime(v) {
  if (!v) return '--';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('zh-TW', { hour12: false });
}

function fmtPercent(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${n.toFixed(digits)}%`;
}

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${n} 元`;
}

function formatBallNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '--';
  return String(num).padStart(2, '0');
}

function parseNums(input) {
  if (Array.isArray(input)) {
    return input.map(Number).filter(Number.isFinite);
  }

  if (typeof input === 'string') {
    return input
      .replace(/[{}[\]]/g, ' ')
      .split(/[,\s|/]+/)
      .map((x) => Number(x.trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function safeJsonParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizePredictionRow(row) {
  if (!row || typeof row !== 'object') return null;

  const compareResult =
    safeJsonParse(row?.compare_result_json, null) ||
    safeJsonParse(row?.compare_result, null) ||
    null;

  const compareHistoryRaw = safeJsonParse(row?.compare_history_json, []);
  const compareHistory = Array.isArray(compareHistoryRaw) ? compareHistoryRaw : [];

  return {
    ...row,
    source_draw_no: toNum(row?.source_draw_no, 0),
    target_periods: toNum(row?.target_periods, 1),
    hit_count: toNum(
      row?.hit_count,
      toNum(compareResult?.hit_count, 0)
    ),
    compare_result_json: compareResult,
    compare_history_json: compareHistory,
    groups_json: normalizeGroups(
      row?.groups_json ||
      row?.groups ||
      row?.prediction_groups ||
      row?.strategies ||
      []
    )
  };
}
function normalizeGroups(rawGroups) {
  const groups = Array.isArray(rawGroups) ? rawGroups : [];

  return groups
    .map((group, idx) => {
      if (!group || typeof group !== 'object') return null;

      const nums = parseNums(group?.nums || group?.numbers || []);
      if (nums.length < 3) return null;  // ✅ 支援三星(3個)和四星(4個)

      const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};

      return {
        key: String(group?.key || meta?.strategy_key || `group_${idx + 1}`),
        label: String(group?.label || meta?.strategy_name || `第${idx + 1}組`),
        nums,
        reason: String(group?.reason || meta?.strategy_name || '--'),
        meta
      };
    })
    .filter(Boolean);
}

function getPredictionGroups(row) {
  return normalizeGroups(
    row?.groups_json ||
      row?.groups ||
      row?.prediction_groups ||
      row?.strategies ||
      []
  );
}

function getRecentRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.recent20)) return data.recent20;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function safeFetchJson(url, options = {}) {
  return fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options?.headers || {})
    }
  }).then(async (res) => {
    const text = await res.text();

    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      throw new Error(json?.error || json?.message || `${url} ${res.status}`);
    }

    return json;
  });
}

async function safeFetchJsonAllowHttpError(url, options = {}) {
  const res = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options?.headers || {})
    }
  });
  const text = await res.text();

  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  return {
    httpOk: res.ok,
    status: res.status,
    json
  };
}

function isDuplicateOrAlreadyExistsMessage(msg) {
  const text = String(msg || '').toLowerCase();

  return (
    text.includes('duplicate key') ||
    text.includes('already exists') ||
    text.includes('prediction already exists')
  );
}

function getNowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function isNightStopWindow() {
  const minutes = getNowMinutes();
  return minutes >= NIGHT_STOP_START_MINUTES && minutes < NIGHT_STOP_END_MINUTES;
}

function msUntilNightWindowEnd() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(7, 30, 0, 0);

  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return Math.max(1000, target.getTime() - now.getTime());
}

function getPredictionLatestRow(data, preferMode) {
  const rows = [
    data?.row,
    ...(Array.isArray(data?.rows) ? data.rows : []),
    ...(Array.isArray(data?.predictions) ? data.predictions : []),
    ...(Array.isArray(data?.data) ? data.data : [])
  ].filter(Boolean);

  if (!rows.length) return null;

  if (preferMode) {
    const found = rows.find((r) => String(r?.mode || '').includes(preferMode));
    if (found) return found;
  }

  return rows[0];
}

function calcHotNumbers(recentRows, lookback = 10) {
  const rows = toArray(recentRows).slice(0, lookback);
  const countMap = new Map();

  rows.forEach((row) => {
    const nums = parseNums(row?.numbers || row?.nums);
    nums.forEach((n) => {
      countMap.set(n, toNum(countMap.get(n), 0) + 1);
    });
  });

  return [...countMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 10)
    .map(([num, count]) => ({ num, count }));
}

function calcCurrentStreakNumbers(recentRows, maxLookback = 5) {
  const rows = toArray(recentRows).slice(0, maxLookback);
  if (!rows.length) return [];

  const latestNums = parseNums(rows[0]?.numbers || rows[0]?.nums);
  const result = [];

  latestNums.forEach((num) => {
    let streak = 1;

    for (let i = 1; i < rows.length; i += 1) {
      const nums = parseNums(rows[i]?.numbers || rows[i]?.nums);
      if (nums.includes(num)) streak += 1;
      else break;
    }

    if (streak >= 2) {
      result.push({ num, streak });
    }
  });

  return result.sort((a, b) => b.streak - a.streak || a.num - b.num);
}

function calcZoneCounts(nums = []) {
  const source = parseNums(nums);
  const zones = [
    { label: '1-20', count: 0 },
    { label: '21-40', count: 0 },
    { label: '41-60', count: 0 },
    { label: '61-80', count: 0 }
  ];

  source.forEach((n) => {
    if (n >= 1 && n <= 20) zones[0].count += 1;
    else if (n >= 21 && n <= 40) zones[1].count += 1;
    else if (n >= 41 && n <= 60) zones[2].count += 1;
    else if (n >= 61 && n <= 80) zones[3].count += 1;
  });

  return zones;
}

function normalizeAiPlayer(data) {
  return {
    assistantMode: data?.assistantMode || 'decision_support',
    readyForFormal: Boolean(data?.readyForFormal),
    adviceLevel: data?.adviceLevel || 'watch',
    decisionPhase: data?.decisionPhase || 'neutral',
    statusArrow: data?.statusArrow || '→',
    statusLabel: data?.statusLabel || '觀察中',
    statusText: data?.statusText || '目前資料可參考，但尚未達到較佳進場條件。',
    statusColor: data?.statusColor || '#2563eb',
    trainingStrength: Math.max(0, Math.min(100, toNum(data?.trainingStrength, 0))),
    comparedLastHour: toNum(data?.comparedLastHour, 0),
    createdLastHour: toNum(data?.createdLastHour, 0),
    disabledLastHour: toNum(data?.disabledLastHour ?? data?.retiredLastHour, 0),
    activeCount: toNum(data?.activeCount, 0),
    totalPoolCount: toNum(data?.totalPoolCount, 0),
    topStrategyKey: data?.topStrategyKey || '--',
    topStrategyAvgHit: toNum(data?.topStrategyAvgHit, 0),
    topStrategyRecent50Roi: toNum(data?.topStrategyRecent50Roi, 0),
    latestDrawNo: data?.latestDrawNo || '--',
    latestDrawTime: data?.latestDrawTime || '--',
    currentTopStrategies: toArray(data?.currentTopStrategies)
  };
}


function normalizeRecentDrawSummary(rows) {
  return toArray(rows)
    .map((row) => ({
      draw_no: toNum(row?.draw_no, 0),
      hit0_count: toNum(row?.hit0_count, 0),
      hit1_count: toNum(row?.hit1_count, 0),
      hit2_count: toNum(row?.hit2_count, 0),
      hit3_count: toNum(row?.hit3_count, 0),
      hit4_count: toNum(row?.hit4_count, 0),
      row_count: toNum(row?.row_count, 0),
      latest_created_at: row?.latest_created_at || null
    }))
    .filter((row) => row.draw_no > 0)
    .sort((a, b) => b.draw_no - a.draw_no);
}

function getCompareDrawNoFromRow(row) {
  const compareResult =
    safeJsonParse(row?.compare_result_json, null) ||
    safeJsonParse(row?.compare_result, null) ||
    null;

  const detail = Array.isArray(compareResult?.detail) ? compareResult.detail : [];
  const firstDetail = detail.length && detail[0] && typeof detail[0] === 'object' ? detail[0] : null;

  return toNum(
    row?.draw_no ||
      row?.target_draw_no ||
      compareResult?.draw_no ||
      compareResult?.target_draw_no ||
      firstDetail?.draw_no ||
      firstDetail?.target_draw_no,
    0
  );
}

function buildRecentDrawSummaryFromComparedRows(rows, limit = 10) {
  const summaryMap = new Map();

  toArray(rows).forEach((rawRow) => {
    const row = normalizePredictionRow(rawRow);
    if (!row) return;

    const drawNo = getCompareDrawNoFromRow(row);
    if (!drawNo) return;

    const current = summaryMap.get(drawNo) || {
      draw_no: drawNo,
      hit0_count: 0,
      hit1_count: 0,
      hit2_count: 0,
      hit3_count: 0,
      hit4_count: 0,
      row_count: 0,
      latest_created_at: row?.created_at || null
    };

    const hit = toNum(row?.hit_count, 0);
    current.row_count += 1;

    if (!current.latest_created_at || new Date(row?.created_at || 0).getTime() > new Date(current.latest_created_at || 0).getTime()) {
      current.latest_created_at = row?.created_at || current.latest_created_at;
    }

    if (hit <= 0) current.hit0_count += 1;
    else if (hit === 1) current.hit1_count += 1;
    else if (hit === 2) current.hit2_count += 1;
    else if (hit === 3) current.hit3_count += 1;
    else current.hit4_count += 1;

    summaryMap.set(drawNo, current);
  });

  return [...summaryMap.values()]
    .sort((a, b) => b.draw_no - a.draw_no)
    .slice(0, Math.max(1, toNum(limit, 10)));
}


function intersectNums(a = [], b = []) {
  const setB = new Set(parseNums(b));
  return parseNums(a).filter((n) => setB.has(n));
}

function getCompareDrawNumbersFromRow(row) {
  const compareResult =
    safeJsonParse(row?.compare_result_json, null) ||
    safeJsonParse(row?.compare_result, null) ||
    null;

  return parseNums(
    compareResult?.draw_numbers ||
      compareResult?.numbers ||
      compareResult?.open_numbers ||
      compareResult?.target_numbers ||
      compareResult?.result_numbers ||
      []
  );
}

function normalizeComparedGroupItem(detail = {}, fallbackGroup = null, idx = 0, compareDrawNumbers = []) {
  const baseGroup = fallbackGroup && typeof fallbackGroup === 'object' ? fallbackGroup : {};
  const nums = parseNums(
    detail?.nums ||
      detail?.numbers ||
      detail?.group_numbers ||
      detail?.groupNums ||
      detail?.picked_numbers ||
      detail?.pickedNumbers ||
      baseGroup?.nums ||
      []
  );

  const matchedNumbers = parseNums(
    detail?.matched_numbers ||
      detail?.matchedNumbers ||
      detail?.hit_numbers ||
      detail?.hitNumbers ||
      detail?.matched ||
      []
  );

  const finalMatched = matchedNumbers.length
    ? matchedNumbers
    : (nums.length && compareDrawNumbers.length ? intersectNums(nums, compareDrawNumbers) : []);

  const hitCountRaw =
    detail?.hit_count ??
    detail?.hitCount ??
    detail?.match_count ??
    detail?.matchCount ??
    detail?.matched_count ??
    detail?.matchedCount ??
    detail?.hit ??
    detail?.matched ??
    null;

  const hitCount = Number.isFinite(Number(hitCountRaw))
    ? toNum(hitCountRaw, 0)
    : finalMatched.length;

  return {
    group_index: toNum(
      detail?.group_index ??
        detail?.groupIndex ??
        detail?.slot_no ??
        detail?.slotNo ??
        detail?.group_no ??
        detail?.groupNo,
      idx + 1
    ),
    key: String(detail?.key || baseGroup?.key || `group_${idx + 1}`),
    label: String(detail?.label || baseGroup?.label || `第${idx + 1}組`),
    nums,
    matched_numbers: finalMatched,
    hit_count: hitCount,
    meta: baseGroup?.meta && typeof baseGroup.meta === 'object' ? baseGroup.meta : {}
  };
}

function extractComparedGroupsFromRow(row) {
  const groups = getPredictionGroups(row);
  const compareResult =
    safeJsonParse(row?.compare_result_json, null) ||
    safeJsonParse(row?.compare_result, null) ||
    null;

  const compareHistory = Array.isArray(row?.compare_history_json)
    ? row.compare_history_json
    : [];

  const detailCandidates = [];
  if (Array.isArray(compareResult?.detail)) {
    detailCandidates.push(...compareResult.detail);
  }
  compareHistory.forEach((historyItem) => {
    if (Array.isArray(historyItem?.detail)) {
      detailCandidates.push(...historyItem.detail);
    }
  });

  const compareDrawNumbers = getCompareDrawNumbersFromRow(row);

  if (detailCandidates.length) {
    return detailCandidates
      .map((detail, idx) => normalizeComparedGroupItem(detail, groups[idx] || null, idx, compareDrawNumbers))
      .filter((item) => item.nums.length >= 3 || item.hit_count > 0)  // ✅ 支援三星
      .sort((a, b) => a.group_index - b.group_index);
  }

  return groups.map((group, idx) => normalizeComparedGroupItem({}, group, idx, compareDrawNumbers));
}

function normalizeRecentFormalComparePeriods(rows) {
  return toArray(rows)
    .map((period) => ({
      compare_draw_no: toNum(period?.compare_draw_no, 0),
      compare_draw_time: period?.compare_draw_time || null,
      compare_draw_numbers: parseNums(period?.compare_draw_numbers || []),
      source_draw_no: toNum(period?.source_draw_no, 0),
      batch_count: toNum(period?.batch_count, 0),
      group_count: toNum(period?.group_count, 0),
      hit0_count: toNum(period?.hit0_count, 0),
      hit1_count: toNum(period?.hit1_count, 0),
      hit2_count: toNum(period?.hit2_count, 0),
      hit3_count: toNum(period?.hit3_count, 0),
      hit4_count: toNum(period?.hit4_count, 0),
      batches: toArray(period?.batches).map((batch, batchIdx) => ({
        ...batch,
        formal_batch_no: toNum(batch?.formal_batch_no, batchIdx + 1),
        compare_draw_numbers: parseNums(batch?.compare_draw_numbers || period?.compare_draw_numbers || []),
        groups: toArray(batch?.groups).map((group, groupIdx) => ({
          ...group,
          group_index: toNum(group?.group_index, groupIdx + 1),
          nums: parseNums(group?.nums || []),
          matched_numbers: parseNums(group?.matched_numbers || [])
        }))
      }))
    }))
    .filter((period) => period.compare_draw_no > 0)
    .sort((a, b) => b.compare_draw_no - a.compare_draw_no);
}

function buildRecentFormalComparePeriodsFromRows(rows, limit = 5) {
  const periodMap = new Map();

  toArray(rows)
    .map(normalizePredictionRow)
    .filter(Boolean)
    .filter((row) => String(row?.mode || '').trim().toLowerCase() === 'formal')
    .forEach((row) => {
      const compareDrawNo = getCompareDrawNoFromRow(row);
      if (!compareDrawNo) return;

      const compareDrawNumbers = getCompareDrawNumbersFromRow(row);
      const period = periodMap.get(compareDrawNo) || {
        compare_draw_no: compareDrawNo,
        compare_draw_time: null,
        compare_draw_numbers: compareDrawNumbers,
        source_draw_no: toNum(row?.source_draw_no, 0),
        batch_count: 0,
        group_count: 0,
        hit0_count: 0,
        hit1_count: 0,
        hit2_count: 0,
        hit3_count: 0,
        hit4_count: 0,
        batches: []
      };

      const batchNo = period.batches.length + 1;
      const comparedGroups = extractComparedGroupsFromRow(row);
      comparedGroups.forEach((group) => {
        const hit = toNum(group?.hit_count, 0);
        period.group_count += 1;
        if (hit <= 0) period.hit0_count += 1;
        else if (hit === 1) period.hit1_count += 1;
        else if (hit === 2) period.hit2_count += 1;
        else if (hit === 3) period.hit3_count += 1;
        else period.hit4_count += 1;
      });

      period.batch_count += 1;
      period.batches.push({
        id: row?.id || `${compareDrawNo}_${batchNo}`,
        formal_batch_no: batchNo,
        source_draw_no: toNum(row?.source_draw_no, 0),
        compare_draw_no: compareDrawNo,
        compare_draw_numbers: compareDrawNumbers,
        created_at: row?.created_at || null,
        status: row?.status || null,
        groups: comparedGroups
      });

      periodMap.set(compareDrawNo, period);
    });

  return [...periodMap.values()]
    .sort((a, b) => b.compare_draw_no - a.compare_draw_no)
    .slice(0, Math.max(1, toNum(limit, 5)));
}

function normalizePredictionLatest(data) {
  const latest = data && typeof data === 'object' ? data : {};

  const trainingRow = normalizePredictionRow(
    latest?.training?.row ||
    latest?.trainingRow ||
    latest?.latestTraining ||
    null
  );

  const formalRow = normalizePredictionRow(
    latest?.display_formal_row ||
    latest?.formal?.row ||
    latest?.formalRow ||
    latest?.latestFormal ||
    null
  );

  const formalBatches = Array.isArray(latest?.formal_batches)
    ? latest.formal_batches.map(normalizePredictionRow).filter(Boolean)
    : Array.isArray(latest?.formalBatches)
      ? latest.formalBatches.map(normalizePredictionRow).filter(Boolean)
      : formalRow
        ? [formalRow]
        : [];

  const leaderboard = Array.isArray(latest?.leaderboard) ? latest.leaderboard : [];
  const currentTopStrategies = Array.isArray(latest?.current_top_strategies)
    ? latest.current_top_strategies
    : Array.isArray(latest?.currentTopStrategies)
      ? latest.currentTopStrategies
      : [];

  const marketStreakBuckets =
    latest?.market_streak_buckets && typeof latest.market_streak_buckets === 'object'
      ? latest.market_streak_buckets
      : latest?.marketStreakBuckets && typeof latest.marketStreakBuckets === 'object'
        ? latest.marketStreakBuckets
        : {
            streak2: [],
            streak3: [],
            streak4: []
          };

  const formalBatchLimit = toNum(
    latest?.formal_batch_limit ?? latest?.formalBatchLimit,
    3
  );

  const formalBatchCount = toNum(
    latest?.formal_batch_count ?? latest?.formalBatchCount ?? formalBatches.length,
    formalBatches.length
  );

  const formalRemainingBatchCount = toNum(
    latest?.formal_remaining_batch_count ?? latest?.formalRemainingBatchCount,
    Math.max(0, formalBatchLimit - formalBatchCount)
  );

  const formalSourceDrawNo = toNum(
    latest?.formal_source_draw_no ?? latest?.formalSourceDrawNo ?? formalRow?.source_draw_no,
    formalRow?.source_draw_no || 0
  );

  const summaryLabel =
    latest?.summary_label ??
    latest?.summaryLabel ??
    '暫無資料';

  const summaryText =
    latest?.summary_text ??
    latest?.summaryText ??
    '';

  const readyForFormal = Boolean(
    latest?.ready_for_formal ??
    latest?.readyForFormal ??
    false
  );

  const adviceLevel =
    latest?.advice_level ??
    latest?.adviceLevel ??
    'watch';

  const assistantMode =
    latest?.assistant_mode ??
    latest?.assistantMode ??
    'decision_support';

  const recentComparedRows = [
    ...(Array.isArray(latest?.recent_compared_rows) ? latest.recent_compared_rows : []),
    ...(Array.isArray(latest?.recent_prediction_rows) ? latest.recent_prediction_rows : []),
    ...(Array.isArray(latest?.compare_history_rows) ? latest.compare_history_rows : []),
    ...(Array.isArray(latest?.predictions) ? latest.predictions : [])
  ]
    .map(normalizePredictionRow)
    .filter(Boolean);

  const recentDrawSummary = normalizeRecentDrawSummary(
    latest?.recent_draw_summary || latest?.recentDrawSummary || []
  );

  const recentFormalComparePeriods = normalizeRecentFormalComparePeriods(
    latest?.recent_formal_compare_periods || latest?.recentFormalComparePeriods || []
  );

  return {
    raw: latest,
    apiVersion: latest?.api_version || latest?.apiVersion || '--',

    trainingRow,
    formalRow,
    formalBatches,

    leaderboard,
    currentTopStrategies,
    marketStreakBuckets,
    recentComparedRows,
    recentDrawSummary,
    recentFormalComparePeriods,

    summaryLabel,
    summaryText,
    readyForFormal,
    adviceLevel,
    assistantMode,

    formalBatchLimit,
    formalBatchCount,
    formalRemainingBatchCount,
    formalSourceDrawNo,

    latest3StarRow: latest?.latest_3star_row || null,
    recent3StarComparedRows: toArray(latest?.recent_3star_compared_rows).map(normalizePredictionRow).filter(Boolean),
    threeStarLeaderboard: toArray(latest?.three_star_leaderboard)
  };
}

function getPipelineItem(result, key) {
  if (!result || typeof result !== 'object') return null;
  const item = result?.pipeline?.[key] || result?.[key] || null;
  return item && typeof item === 'object' ? item : null;
}

function pipelineStatusText(result, key) {
  const item = getPipelineItem(result, key);
  if (!item) return '未執行';
  if (item.ok === true) return '成功';
  if (item.ok === false) return '失敗';
  return '未執行';
}

function normalizeAutoTrainResult(payload, status) {
  const result = payload && typeof payload === 'object' ? payload : {};
  const topError = result?.error || result?.message || '';

  if (result?.skipped) {
    return {
      ok: true,
      skipped: true,
      reason: result?.reason || 'already_exists',
      raw: result
    };
  }

  if (isDuplicateOrAlreadyExistsMessage(topError)) {
    return {
      ok: true,
      skipped: true,
      reason: 'Prediction already exists for current draw and mode',
      raw: result
    };
  }

  if (result?.ok === false && !isDuplicateOrAlreadyExistsMessage(topError)) {
    return {
      ok: false,
      error: topError || `auto-train ${status}`
    };
  }

  return {
    ...result,
    ok: result?.ok !== false
  };
}

function buildLoopStatusText(result) {
  if (!result) {
    if (isNightStopWindow()) return '夜間停訓中（00:00～07:30 不訓練）';
    return '待命中';
  }

  if (result?.skipped) {
    return '本期已存在（正常略過）';
  }

  const compared = toNum(
    result?.compared_count ??
      result?.compare?.data?.processed ??
      result?.compare?.processed,
    0
  );

  const created = toNum(
    result?.created_count ??
      (result?.train?.inserted ? 1 : 0),
    0
  );

  if (compared > 0 || created > 0) {
    return `本輪完成：比對 ${compared} 筆 / 新建 ${created} 筆`;
  }

  return '本輪無異動';
}

function getStrategyModeLabel(mode) {
  const found = STRATEGY_MODE_OPTIONS.find((item) => item.key === mode);
  return found ? found.label : mode;
}

function getRiskModeLabel(mode) {
  const found = RISK_MODE_OPTIONS.find((item) => item.key === mode);
  return found ? found.label : mode;
}

function extractRowDecisionSettings(row) {
  const groups = getPredictionGroups(row);
  const firstMeta = groups[0]?.meta && typeof groups[0].meta === 'object' ? groups[0].meta : {};

  return {
    analysisPeriod:
      toNum(
        firstMeta.analysis_period ??
          row?.analysis_period ??
          row?.analysisPeriod,
        0
      ) || null,
    strategyMode:
      firstMeta.strategy_mode ||
      row?.strategy_mode ||
      row?.strategyMode ||
      null,
    riskMode:
      firstMeta.risk_mode ||
      row?.risk_mode ||
      row?.riskMode ||
      null,
    marketPhase:
      firstMeta.market_phase ||
      row?.market_phase ||
      row?.marketPhase ||
      null,
    confidenceScore:
      toNum(
        firstMeta.confidence_score ??
          row?.confidence_score ??
          row?.confidenceScore,
        0
      )
  };
}

function resolveDisplayedSelection(predictionSummary, trainingLatest, formalLatest, fallbackAnalysisPeriod, fallbackStrategyMode, fallbackRiskMode) {
  const formalDecision = extractRowDecisionSettings(formalLatest);
  const trainingDecision = extractRowDecisionSettings(trainingLatest);

  const analysisPeriod =
    formalDecision.analysisPeriod ||
    trainingDecision.analysisPeriod ||
    fallbackAnalysisPeriod;

  const strategyMode =
    formalDecision.strategyMode ||
    trainingDecision.strategyMode ||
    fallbackStrategyMode;

  const riskMode =
    formalDecision.riskMode ||
    trainingDecision.riskMode ||
    fallbackRiskMode;

  const marketPhase =
    formalDecision.marketPhase ||
    trainingDecision.marketPhase ||
    null;

  const confidenceScore = Math.max(
    formalDecision.confidenceScore,
    trainingDecision.confidenceScore,
    0
  );

  return {
    analysisPeriod,
    strategyMode,
    riskMode,
    marketPhase,
    confidenceScore,
    summaryLabel: predictionSummary?.summaryLabel || '--',
    summaryText: predictionSummary?.summaryText || ''
  };
}

function Card({ title, subtitle, right, children }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div>
          <div style={styles.cardTitle}>{title}</div>
          {subtitle ? <div style={styles.cardSubtitle}>{subtitle}</div> : null}
        </div>
        {right ? <div>{right}</div> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function StatBox({ label, value, hint, valueStyle }) {
  return (
    <div style={styles.statBox}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, ...valueStyle, fontSize: 26, lineHeight: 1.1 }}>{value}</div>
      {hint ? <div style={{ ...styles.statHint, fontSize: 12, marginTop: 6 }}>{hint}</div> : null}
    </div>
  );
}

function MetaChip({ label, value }) {
  return (
    <span style={styles.metaChip}>
      <span style={styles.metaChipLabel}>{label}</span>
      <span>{value}</span>
    </span>
  );
}

function MarketBall({ n, highlight = false }) {
  return (
    <div
      style={{
        ...styles.marketBall,
        ...(highlight ? styles.marketBallHighlight : {})
      }}
    >
      {formatBallNumber(n)}
    </div>
  );
}

function StreakBall({ n, streak }) {
  return (
    <div style={styles.streakBallWrap}>
      <div style={styles.streakBall}>{formatBallNumber(n)}</div>
      <div style={styles.streakBadge}>{streak}</div>
    </div>
  );
}

function GroupCard({ group, idx, showRank = false }) {
  const meta = group?.meta || {};
  const label = fmtText(group?.label || group?.key, `第${idx + 1}組`);
  const shortLabel = label.split('/')[0].trim();
  const roi = Number(meta?.recent_50_roi ?? meta?.roi);
  const roiColor = Number.isFinite(roi) ? (roi >= 0 ? '#0f766e' : '#dc2626') : '#7b6e5c';
  return (
    <div style={{ ...styles.groupCard, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 900, color: '#0f766e' }}>
          第 {idx + 1} 組
        </div>
        <div style={{ fontSize: 13, color: '#7b6e5c', fontWeight: 700 }}>{shortLabel}</div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        {toArray(group?.nums).map((n) => (
          <div key={`${group?.key}_${n}`} style={{ ...styles.pickBall, width: 52, height: 52, fontSize: 18 }}>
            {formatBallNumber(n)}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ ...styles.metaChip, color: roiColor }}>
          <span style={styles.metaChipLabel}>ROI </span>
          {Number.isFinite(roi) ? fmtPercent(roi) : '--'}
        </span>
        <span style={styles.metaChip}>
          <span style={styles.metaChipLabel}>均中 </span>
          {Number.isFinite(Number(meta?.avg_hit)) ? Number(meta.avg_hit).toFixed(2) : '--'}
        </span>
        {meta?.hit3_rate > 0 && (
          <span style={{ ...styles.metaChip, background: '#e0f0ea', borderColor: '#0f766e', color: '#0f766e' }}>
            <span style={{ color: '#0f766e' }}>中3率 </span>
            {fmtPercent(meta.hit3_rate)}
          </span>
        )}
      </div>
    </div>
  );
}

function CompactBetCard({ group, idx }) {
  if (!group) return null;
  return (
    <div style={styles.compactBetCard}>
      <div style={styles.compactBetHead}>
        <div style={styles.compactBetTitle}>第 {idx + 1} 組</div>
        <div style={styles.compactBetSub}>正式下注</div>
      </div>

      <div style={styles.groupBalls}>
        {toArray(group?.nums).map((n) => (
          <div key={`${group?.key || idx}_${n}`} style={styles.pickBall}>
            {formatBallNumber(n)}
          </div>
        ))}
      </div>

      <div style={styles.metaChipRow}>
        <MetaChip label="每組" value={fmtMoney(COST_PER_GROUP)} />
        <MetaChip label="來源期數" value={fmtText(group?.meta?.source_draw_no || '--')} />
      </div>
    </div>
  );
}

function FormalBatchCard({ batch, idx }) {
  const groups = getPredictionGroups(batch);
  const statusColor = batch?.status === 'compared' ? '#0f766e' : '#b45309';

  return (
    <div style={{ ...styles.batchCard, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 900, color: '#0f766e' }}>
            第 {fmtText(batch?.formal_batch_no, idx + 1)} 批
          </div>
          <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 3 }}>
            {fmtDateTime(batch?.created_at)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{ ...styles.metaChip, color: statusColor }}>
            {batch?.status === 'compared' ? '已對獎' : batch?.status === 'created' ? '待對獎' : fmtText(batch?.status)}
          </span>
          <span style={styles.metaChip}>期號 {fmtText(batch?.source_draw_no)}</span>
          <span style={styles.metaChip}>{groups.length} 組</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {groups.length ? (
          groups.map((group, groupIdx) => (
            <GroupCard key={`${batch?.id || idx}_${group?.key || groupIdx}`} group={group} idx={groupIdx} />
          ))
        ) : (
          <div style={styles.emptyBox}>這一批目前沒有可顯示的組合。</div>
        )}
      </div>
    </div>
  );
}

function SelectorButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.selectorButton,
        ...(active ? styles.selectorButtonActive : {})
      }}
    >
      {children}
    </button>
  );
}

function SelectorCard({ active, onClick, title, desc }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.modeCard,
        ...(active ? styles.modeCardActive : {})
      }}
    >
      <div style={styles.modeCardTitle}>{title}</div>
      <div style={styles.modeCardDesc}>{desc}</div>
    </button>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState(TABS.DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [loopStatusText, setLoopStatusText] = useState('待命中');

  const [analysisPeriod] = useState(20);
  const [strategyMode] = useState('mix');
  const [riskMode] = useState('balanced');

  const [recent20, setRecent20] = useState([]);
  const [trainingLatest, setTrainingLatest] = useState(null);
  const [formalLatest, setFormalLatest] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [predictionSummary, setPredictionSummary] = useState({
    apiVersion: '--',
    summaryLabel: '--',
    summaryText: '--',
    currentTopStrategies: [],
    readyForFormal: false,
    formalBatchLimit: FORMAL_BATCH_LIMIT,
    formalBatchCount: 0,
    formalRemainingBatchCount: FORMAL_BATCH_LIMIT,
    formalSourceDrawNo: null,
    formalBatches: [],
    marketStreakBuckets: {
      streak2: [],
      streak3: [],
      streak4: [],
      lookback: 0,
      latestDrawNo: null
    },
    recentComparedRows: [],
    recentFormalComparePeriods: [],
    latest3StarRow: null,
    recent3StarComparedRows: [],
    threeStarLeaderboard: []
  });
  const [aiPlayer, setAiPlayer] = useState(normalizeAiPlayer({}));
  const [lastAutoTrainResult, setLastAutoTrainResult] = useState(null);
  const [autoTrainEnabled, setAutoTrainEnabled] = useState(false);
  const [marketNowText, setMarketNowText] = useState(fmtDateTime(new Date()));

  const mountedRef = useRef(false);
  const schedulerRef = useRef(null);
  const cycleRunningRef = useRef(false);
  const sessionStartedRef = useRef(false);
  const nightPauseTimerRef = useRef(null);

  const clearAllTimers = useCallback(() => {
    if (schedulerRef.current) {
      clearTimeout(schedulerRef.current);
      schedulerRef.current = null;
    }
    if (nightPauseTimerRef.current) {
      clearTimeout(nightPauseTimerRef.current);
      nightPauseTimerRef.current = null;
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [recentRes, predictionRes, aiPlayerRes] = await Promise.all([
        safeFetchJson('/api/recent20').catch(() => ({})),
        safeFetchJson('/api/prediction-latest').catch(() => ({})),
        safeFetchJson('/api/ai-player').catch(() => ({}))
      ]);

      const recentRows = getRecentRows(recentRes);
      setRecent20(recentRows);

     const normalizedPrediction = normalizePredictionLatest(predictionRes);
      setTrainingLatest(normalizedPrediction.trainingRow || null);
      setFormalLatest(normalizedPrediction.formalRow || null);
      setLeaderboard(normalizedPrediction.leaderboard || []);
      setPredictionSummary({
        apiVersion: normalizedPrediction.apiVersion,
        summaryLabel: normalizedPrediction.summaryLabel,
        summaryText: normalizedPrediction.summaryText,
        currentTopStrategies: normalizedPrediction.currentTopStrategies,
        readyForFormal: normalizedPrediction.readyForFormal,
        formalBatchLimit: normalizedPrediction.formalBatchLimit,
        formalBatchCount: normalizedPrediction.formalBatchCount,
        formalRemainingBatchCount: normalizedPrediction.formalRemainingBatchCount,
        formalSourceDrawNo: normalizedPrediction.formalSourceDrawNo,
        formalBatches: normalizedPrediction.formalBatches,
        marketStreakBuckets: normalizedPrediction.marketStreakBuckets,
        recentComparedRows: normalizedPrediction.recentComparedRows,
        recentFormalComparePeriods: normalizedPrediction.recentFormalComparePeriods,
        latest3StarRow: normalizedPrediction.latest3StarRow || null,
        recent3StarComparedRows: normalizedPrediction.recent3StarComparedRows || [],
        threeStarLeaderboard: normalizedPrediction.threeStarLeaderboard || []
      });

      setAiPlayer(normalizeAiPlayer(aiPlayerRes));
      setLastAutoTrainResult(predictionRes?.auto_train_result || null);
    } catch (err) {
      setError(err.message || '讀取資料失敗');
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const runAction = useCallback(
    async (key, fn) => {
      setBusyKey(key);
      setError('');
      try {
        await fn();
        await loadAll();
      } catch (err) {
        setError(err.message || '執行失敗');
      } finally {
        if (mountedRef.current) {
          setBusyKey('');
        }
      }
    },
    [loadAll]
  );

  const handleSync = useCallback(async () => {
    await runAction('sync', async () => {
      await safeFetchJson('/api/sync', { method: 'POST' }).catch(async () => {
        await safeFetchJson('/api/sync');
      });
    });
  }, [runAction]);

  const handleCatchup = useCallback(async () => {
    await runAction('catchup', async () => {
      await safeFetchJson('/api/catchup', { method: 'POST' }).catch(async () => {
        await safeFetchJson('/api/catchup');
      });
    });
  }, [runAction]);

  const handleRefresh = useCallback(async () => {
    await runAction('refresh', async () => {
      await safeFetchJson('/api/sync', { method: 'POST' }).catch(async () => {
        await safeFetchJson('/api/sync');
      });

      await safeFetchJson('/api/recent20').catch(() => ({}));
      await safeFetchJson('/api/prediction-latest').catch(() => ({}));
      await safeFetchJson('/api/ai-player').catch(() => ({}));
    });
  }, [runAction]);

  const handleFormalBet = useCallback(async () => {
    await runAction('formalBet', async () => {
      await safeFetchJson('/api/prediction-save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-manual-formal-save': 'true',
          'x-trigger-source': 'app_button'
        },
        body: JSON.stringify({
          mode: 'formal',
          manual: true,
          trigger_source: 'app_button'
        })
      });
    });
  }, [runAction]);

  const runAiCycle = useCallback(async () => {
    if (cycleRunningRef.current) return;
    cycleRunningRef.current = true;

    try {
      if (isNightStopWindow()) {
        setLoopStatusText('夜間停訓中（00:00～07:30 不訓練）');
        return;
      }

      setLoopStatusText('同步期數中...');
      await safeFetchJson('/api/sync', { method: 'POST' }).catch(async () => {
        await safeFetchJson('/api/sync');
      });

      setLoopStatusText('更新 recent20 中...');
      await safeFetchJson('/api/recent20').catch(() => ({}));

      setLoopStatusText('補抓遺漏期數中...');
      await safeFetchJson('/api/catchup', { method: 'POST' }).catch(async () => {
        await safeFetchJson('/api/catchup');
      });

      setLoopStatusText('自動模擬中...');

      const autoTrainHttp = await safeFetchJsonAllowHttpError('/api/auto-train', { method: 'POST' }).catch(async () => {
        return await safeFetchJsonAllowHttpError('/api/auto-train', { method: 'GET' });
      });

      const autoTrainResult = normalizeAutoTrainResult(autoTrainHttp?.json, autoTrainHttp?.status);

      if (!autoTrainResult?.ok) {
        throw new Error(autoTrainResult?.error || 'AI 循環失敗');
      }

      setLastAutoTrainResult(autoTrainResult);
      setLoopStatusText(buildLoopStatusText(autoTrainResult));
      setError('');
      await loadAll();
    } catch (err) {
      if (isDuplicateOrAlreadyExistsMessage(err?.message)) {
        const normalized = {
          ok: true,
          skipped: true,
          reason: 'Prediction already exists for current draw and mode'
        };
        setLastAutoTrainResult(normalized);
        setLoopStatusText('本期已存在（AI 正常運作中）');
        setError('');
        await loadAll();
      } else {
        setLoopStatusText(`循環失敗：${err.message || '未知錯誤'}`);
        setError(err.message || 'AI 循環失敗');
      }
    } finally {
      cycleRunningRef.current = false;
    }
  }, [loadAll]);

  const scheduleNightResume = useCallback(() => {
    if (nightPauseTimerRef.current) {
      clearTimeout(nightPauseTimerRef.current);
    }

    nightPauseTimerRef.current = setTimeout(() => {
      if (!sessionStartedRef.current) return;
      setLoopStatusText('夜間停訓結束，準備恢復訓練...');
      runAiCycle().finally(() => {
        if (!sessionStartedRef.current) return;
        schedulerRef.current = setTimeout(async function loopRunner() {
          if (!sessionStartedRef.current) return;

          if (isNightStopWindow()) {
            setLoopStatusText('夜間停訓中（00:00～07:30 不訓練）');
            scheduleNightResume();
            return;
          }

          await runAiCycle();
          if (!sessionStartedRef.current) return;
          schedulerRef.current = setTimeout(loopRunner, LOOP_INTERVAL_MS);
        }, LOOP_INTERVAL_MS);
      });
    }, msUntilNightWindowEnd());
  }, [runAiCycle]);

  const startLoopScheduler = useCallback(
    (delay = 0) => {
      clearAllTimers();

      if (!sessionStartedRef.current) return;

      if (isNightStopWindow()) {
        setLoopStatusText('夜間停訓中（00:00～07:30 不訓練）');
        scheduleNightResume();
        return;
      }

      schedulerRef.current = setTimeout(async function loopRunner() {
        if (!sessionStartedRef.current) return;

        if (isNightStopWindow()) {
          setLoopStatusText('夜間停訓中（00:00～07:30 不訓練）');
          scheduleNightResume();
          return;
        }

        await runAiCycle();

        if (!sessionStartedRef.current) return;
        schedulerRef.current = setTimeout(loopRunner, LOOP_INTERVAL_MS);
      }, delay);
    },
    [clearAllTimers, runAiCycle, scheduleNightResume]
  );

  useEffect(() => {
    mountedRef.current = true;
    sessionStartedRef.current = false;
    setAutoTrainEnabled(false);
    setLoopStatusText(isNightStopWindow() ? '夜間停訓中（00:00～07:30 不訓練）' : '待命中');
    loadAll();

    return () => {
      mountedRef.current = false;
      sessionStartedRef.current = false;
      clearAllTimers();
    };
  }, [loadAll, clearAllTimers]);

  useEffect(() => {
    const timer = setInterval(() => {
      setMarketNowText(fmtDateTime(new Date()));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const handleToggleAutoTrain = useCallback(async () => {
    await runAction('toggleAutoTrain', async () => {
      const nextEnabled = !autoTrainEnabled;

      if (nextEnabled) {
        setAutoTrainEnabled(true);
        sessionStartedRef.current = true;

        if (isNightStopWindow()) {
          setLoopStatusText('夜間停訓中（00:00～07:30 不訓練）');
          scheduleNightResume();
        } else {
          setLoopStatusText('策略模擬啟動');
          startLoopScheduler(0);
        }
      } else {
        setAutoTrainEnabled(false);
        sessionStartedRef.current = false;
        clearAllTimers();
        setLoopStatusText('已停止');
      }
    });
  }, [autoTrainEnabled, runAction, scheduleNightResume, startLoopScheduler, clearAllTimers]);

  const latestDraw = recent20[0] || null;
  const latestDrawNo = latestDraw?.draw_no || latestDraw?.drawNo || aiPlayer?.latestDrawNo || '--';
  const latestDrawTime = latestDraw?.draw_time || latestDraw?.drawTime || aiPlayer?.latestDrawTime || '--';
  const latestNumbers = parseNums(latestDraw?.numbers || latestDraw?.nums);
  const backendAnalysisPeriod =
    extractRowDecisionSettings(formalLatest).analysisPeriod ||
    extractRowDecisionSettings(trainingLatest).analysisPeriod ||
    analysisPeriod;

  const recentRowsByPeriod = useMemo(() => {
    return toArray(recent20).slice(0, backendAnalysisPeriod);
  }, [recent20, backendAnalysisPeriod]);

  const trainingGroups = useMemo(() => getPredictionGroups(trainingLatest), [trainingLatest]);
  const formalGroups = useMemo(() => getPredictionGroups(formalLatest), [formalLatest]);

  const hotNumbers = useMemo(() => calcHotNumbers(recentRowsByPeriod, Math.min(backendAnalysisPeriod, 10)), [recentRowsByPeriod, backendAnalysisPeriod]);
  const streakNumbers = useMemo(() => calcCurrentStreakNumbers(recentRowsByPeriod, Math.min(backendAnalysisPeriod, 5)), [recentRowsByPeriod, backendAnalysisPeriod]);
  const zoneCounts = useMemo(() => calcZoneCounts(latestNumbers), [latestNumbers]);
  const streak2Buckets = useMemo(
    () => toArray(predictionSummary?.marketStreakBuckets?.streak2),
    [predictionSummary]
  );
  const streak3Buckets = useMemo(
    () => toArray(predictionSummary?.marketStreakBuckets?.streak3),
    [predictionSummary]
  );
  const streak4Buckets = useMemo(
    () => toArray(predictionSummary?.marketStreakBuckets?.streak4),
    [predictionSummary]
  );

  const lastCycleSummary = useMemo(() => buildLoopStatusText(lastAutoTrainResult), [lastAutoTrainResult]);

  const currentTopStrategies = predictionSummary.currentTopStrategies.length
    ? predictionSummary.currentTopStrategies
    : aiPlayer.currentTopStrategies;

  const comparedRows = useMemo(() => {
    const rows = toArray(predictionSummary?.recentComparedRows)
      .map(normalizePredictionRow)
      .filter(Boolean);

    const seen = new Set();
    return rows.filter((row) => {
      const key = `${row?.id || ''}_${row?.created_at || ''}_${row?.source_draw_no || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);
  }, [predictionSummary]);

  const recentFormalComparePeriods = useMemo(() => {
    const fromApi = normalizeRecentFormalComparePeriods(predictionSummary?.recentFormalComparePeriods || []);
    if (fromApi.length) return fromApi.slice(0, 5);
    return buildRecentFormalComparePeriodsFromRows(comparedRows, 5);
  }, [predictionSummary?.recentFormalComparePeriods, comparedRows]);

  // 3星比對歷史數據
  const recent3StarRows = toArray(predictionSummary?.recent3StarComparedRows);
  const recent3StarSummary = useMemo(() => {
    const rows = recent3StarRows.filter(r => r?.compare_result?.detail);
    let hit0 = 0, hit1 = 0, hit2 = 0, hit3 = 0, groupCount = 0;
    rows.forEach(row => {
      toArray(row?.compare_result?.detail).forEach(d => {
        const h = toNum(d?.hit, 0);
        groupCount++;
        if (h === 0) hit0++;
        else if (h === 1) hit1++;
        else if (h === 2) hit2++;
        else if (h >= 3) hit3++;
      });
    });
    return { periodCount: rows.length, groupCount, hit0, hit1, hit2, hit3 };
  }, [recent3StarRows]);

  const recentFormalCompareSummary = useMemo(() => {
    const summary = {
      periodCount: recentFormalComparePeriods.length,
      batchCount: 0,
      groupCount: 0,
      hit0: 0,
      hit1: 0,
      hit2: 0,
      hit3: 0,
      hit4: 0
    };

    recentFormalComparePeriods.forEach((period) => {
      summary.batchCount += toNum(period?.batch_count, 0);
      summary.groupCount += toNum(period?.group_count, 0);
      summary.hit0 += toNum(period?.hit0_count, 0);
      summary.hit1 += toNum(period?.hit1_count, 0);
      summary.hit2 += toNum(period?.hit2_count, 0);
      summary.hit3 += toNum(period?.hit3_count, 0);
      summary.hit4 += toNum(period?.hit4_count, 0);
    });

    return summary;
  }, [recentFormalComparePeriods]);

  const hitFeedback = useMemo(() => {
    const summary = {
      sampleCount: 0,
      hit0: 0,
      hit1: 0,
      hit2: 0,
      hit3: 0,
      hit4Plus: 0,
      latestSourceDrawNo: '--',
      addBetAdvice: '先觀察',
      note: '最近樣本不足，先觀察。'
    };

    const drawSummaryRows = (
      toArray(predictionSummary?.recentDrawSummary).length
        ? normalizeRecentDrawSummary(predictionSummary?.recentDrawSummary)
        : buildRecentDrawSummaryFromComparedRows(comparedRows, 10)
    ).slice(0, 10);

    if (drawSummaryRows.length) {
      drawSummaryRows.forEach((row) => {
        summary.sampleCount += 1;
        if ((row.hit1_count + row.hit2_count + row.hit3_count + row.hit4_count) <= 0) summary.hit0 += 1;
        if (row.hit1_count > 0) summary.hit1 += 1;
        if (row.hit2_count > 0) summary.hit2 += 1;
        if (row.hit3_count > 0) summary.hit3 += 1;
        if (row.hit4_count > 0) summary.hit4Plus += 1;
      });

      summary.latestSourceDrawNo = fmtText(drawSummaryRows[0]?.draw_no || '--');
    } else {
      const rows = comparedRows;
      if (!rows.length) return summary;

      rows.forEach((row) => {
        const compareResult = row?.compare_result_json && typeof row.compare_result_json === 'object'
          ? row.compare_result_json
          : null;

        const compareHistory = Array.isArray(row?.compare_history_json)
          ? row.compare_history_json
          : [];

        let hit = toNum(row?.hit_count, NaN);
        if (!Number.isFinite(hit) && Number.isFinite(Number(compareResult?.hit_count))) {
          hit = Number(compareResult.hit_count);
        }
        if (!Number.isFinite(hit) && compareHistory.length) {
          const maxHit = Math.max(
            ...compareHistory.map((item) => toNum(item?.hit_count ?? item?.hit ?? item?.matched, 0))
          );
          hit = maxHit;
        }
        if (!Number.isFinite(hit)) hit = 0;

        summary.sampleCount += 1;
        if (hit <= 0) summary.hit0 += 1;
        else if (hit === 1) summary.hit1 += 1;
        else if (hit === 2) summary.hit2 += 1;
        else if (hit === 3) summary.hit3 += 1;
        else summary.hit4Plus += 1;
      });

      summary.latestSourceDrawNo = fmtText(rows[0]?.source_draw_no || '--');
    }

    const hit2PlusRate = summary.sampleCount ? ((summary.hit2 + summary.hit3 + summary.hit4Plus) / summary.sampleCount) * 100 : 0;
    const hit3PlusRate = summary.sampleCount ? ((summary.hit3 + summary.hit4Plus) / summary.sampleCount) * 100 : 0;

    if (hit3PlusRate >= 20 || (summary.hit3 >= 2 && summary.sampleCount >= 5)) {
      summary.addBetAdvice = '可加碼';
      summary.note = '近期中3以上有感，可考慮放大攻擊組。';
    } else if (hit2PlusRate >= 40) {
      summary.addBetAdvice = '小試';
      summary.note = '近期中2以上有延續，可維持平衡下注。';
    } else {
      summary.addBetAdvice = '先保守';
      summary.note = '最近中1偏多，先保守觀察。';
    }

    return summary;
  }, [comparedRows, predictionSummary?.recentDrawSummary]);

  const canFormalBet = predictionSummary.readyForFormal || aiPlayer.readyForFormal;
  const formalBatchCount = predictionSummary.formalBatchCount;
  const formalRemainingBatchCount = predictionSummary.formalRemainingBatchCount;
  const formalBatchLimit = predictionSummary.formalBatchLimit || FORMAL_BATCH_LIMIT;
  const formalBatches = predictionSummary.formalBatches || [];
  const formalBatchProgressText = `${formalBatchCount} / ${formalBatchLimit}`;

  const latestFormalBatch = formalBatches.length ? formalBatches[formalBatches.length - 1] : null;
  const formalDisplayGroups = formalGroups.length
    ? formalGroups
    : getPredictionGroups(latestFormalBatch);

  const formalButtonDisabled =
    busyKey !== '' ||
    !canFormalBet ||
    formalRemainingBatchCount <= 0;

  const formalButtonLabel = !canFormalBet
    ? '暫不建議正式下注'
    : formalRemainingBatchCount <= 0
      ? '本期已達 3 批上限'
      : '手動產生一批正式下注';

  const actualFormalGroupCount = formalDisplayGroups.length;
  const formalGroupCoverageRatio = FORMAL_GROUP_COUNT > 0
    ? actualFormalGroupCount / FORMAL_GROUP_COUNT
    : 0;
  const formalGroupCoverageText = `${actualFormalGroupCount} / ${FORMAL_GROUP_COUNT}`;
  const formalGroupRealityText = actualFormalGroupCount >= FORMAL_GROUP_COUNT
    ? '本批已達完整四組'
    : actualFormalGroupCount > 0
      ? `本批僅保留 ${actualFormalGroupCount} 組有效正式下注，採寧缺勿濫。`
      : '本批目前沒有通過條件的正式下注組合。';

  const formalDecisionSettings = extractRowDecisionSettings(formalLatest);
  const trainingDecisionSettings = extractRowDecisionSettings(trainingLatest);

  const scoreCandidates = [
    ...trainingGroups,
    ...formalGroups,
    ...formalDisplayGroups,
    ...toArray(currentTopStrategies)
  ]
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const meta = item?.meta && typeof item.meta === 'object' ? item.meta : {};
      const score = toNum(meta?.score ?? item?.score, NaN);
      return Number.isFinite(score) ? score : null;
    })
    .filter((v) => Number.isFinite(v));

  const sortedScores = scoreCandidates.slice().sort((a, b) => b - a);
  const topThreeScores = sortedScores.slice(0, 3);
  const avgTopScore = topThreeScores.length
    ? topThreeScores.reduce((sum, v) => sum + v, 0) / topThreeScores.length
    : 0;
  const negativeScoreCount = sortedScores.filter((v) => v < 0).length;

  const scoreBandBase =
    avgTopScore >= 1800 ? 94 :
    avgTopScore >= 1400 ? 88 :
    avgTopScore >= 1000 ? 80 :
    avgTopScore >= 700 ? 72 :
    avgTopScore >= 450 ? 64 :
    avgTopScore >= 250 ? 56 :
    avgTopScore >= 80 ? 48 : 40;

  const strategyStabilityScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        scoreBandBase +
          Math.min(6, formalBatchCount * 2) +
          (lastAutoTrainResult?.ok ? 4 : 0) -
          Math.min(10, negativeScoreCount * 2) -
          Math.max(0, Math.round((1 - formalGroupCoverageRatio) * 18))
      )
    )
  );

  const derivedMarketPhase = String(
    formalDecisionSettings.marketPhase ||
      trainingDecisionSettings.marketPhase ||
      aiPlayer.decisionPhase ||
      'neutral'
  ).toLowerCase();

  const derivedConfidenceScore = Math.max(
    toNum(formalDecisionSettings.confidenceScore, 0),
    toNum(trainingDecisionSettings.confidenceScore, 0),
    0
  );

  const marketPhaseBase =
    derivedMarketPhase === 'rotation' ? 66 :
    derivedMarketPhase === 'continuation' ? 74 :
    derivedMarketPhase === 'strong_trend' ? 78 :
    derivedMarketPhase === 'weak_trend' ? 68 :
    derivedMarketPhase === 'random' ? 56 : 52;

  const marketFitScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        marketPhaseBase +
          Math.min(18, derivedConfidenceScore * 0.18) +
          (predictionSummary.readyForFormal ? 6 : 0) +
          (lastAutoTrainResult?.ok ? 4 : 0) -
          Math.max(0, Math.round((1 - formalGroupCoverageRatio) * 16))
      )
    )
  );

  const displayedSelection = useMemo(
    () =>
      resolveDisplayedSelection(
        predictionSummary,
        trainingLatest,
        formalLatest,
        analysisPeriod,
        strategyMode,
        riskMode
      ),
    [predictionSummary, trainingLatest, formalLatest, analysisPeriod, strategyMode, riskMode]
  );

  const displayedAnalysisPeriod = toNum(displayedSelection.analysisPeriod, analysisPeriod) || analysisPeriod;
  const displayedStrategyMode = displayedSelection.strategyMode || strategyMode;
  const displayedRiskMode = displayedSelection.riskMode || riskMode;

  const decisionTitle = canFormalBet ? '可小試' : '暫不建議正式下注';
  const decisionColor = canFormalBet ? '#0f766e' : '#b45309';
  const decisionSubtitle = displayedSelection.summaryText || predictionSummary.summaryText || aiPlayer.statusText || '先觀察再行動。';

  return (
    <div style={{ ...styles.page, WebkitTextSizeAdjust: '100%' }}>
      <div style={styles.app}>
        <header style={styles.header}>
          <div>
            <div style={styles.brand}>FUWEI BINGO AI</div>
            <div style={styles.headerSub}>策略輪動、單期決策、分批下注。</div>
          </div>

          <div style={styles.headerActions}>
            <button
              style={styles.secondaryButton}
              onClick={handleRefresh}
              disabled={busyKey !== '' && busyKey !== 'refresh'}
            >
              {busyKey === 'refresh' ? '更新中...' : '重新整理'}
            </button>
            <button
              style={{
                ...styles.primaryButton,
                marginTop: 0,
                ...(autoTrainEnabled ? styles.stopButton : {})
              }}
              onClick={handleToggleAutoTrain}
              disabled={busyKey !== '' && busyKey !== 'toggleAutoTrain'}
            >
              {autoTrainEnabled ? '停止訓練' : '啟動訓練'}
            </button>
          </div>
        </header>

        <nav style={styles.tabBar}>
          {TAB_ITEMS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  ...styles.tabButton,
                  ...(active ? styles.tabButtonActive : {})
                }}
              >
                <span style={styles.tabIcon}>{tab.icon}</span>
                {tab.label}
              </button>
            );
          })}
        </nav>

        {error ? <div style={styles.errorBanner}>{error}</div> : null}
        {loading ? <div style={styles.loading}>讀取中...</div> : null}

        {!loading && activeTab === TABS.DASHBOARD && (
          <div style={styles.sectionStack}>
            <Card
              title="首頁決策"
              subtitle="先看雙分數，再決定要不要直接產生正式下注。"
            >
              <div style={{ display: 'flex', gap: 10, marginBottom: 4 }}>
                <div style={{ flex: 1, background: '#f8f1e6', border: '2px solid #d9c7a8', borderRadius: 14, padding: 14 }}>
                  <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 6 }}>策略穩定度</div>
                  <div style={{ fontSize: 32, fontWeight: 900, color: '#0f766e', lineHeight: 1 }}>{strategyStabilityScore}<span style={{ fontSize: 16, color: '#7b6e5c' }}> / 100</span></div>
                  <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 6 }}>活躍策略 {aiPlayer.activeCount} / 策略池 {aiPlayer.totalPoolCount}</div>
                </div>
                <div style={{ flex: 1, background: '#f8f1e6', border: '2px solid #d9c7a8', borderRadius: 14, padding: 14 }}>
                  <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 6 }}>市場適應度</div>
                  <div style={{ fontSize: 32, fontWeight: 900, color: decisionColor, lineHeight: 1 }}>{marketFitScore}<span style={{ fontSize: 16, color: '#7b6e5c' }}> / 100</span></div>
                  <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 6 }}>期數 {fmtText(latestDrawNo)}</div>
                </div>
              </div>

              <div style={styles.resultPanel}>
                <div style={styles.resultTitle}>綜合建議</div>
                <div style={styles.decisionHeadline}>
                  <span style={{ ...styles.decisionBadge, color: decisionColor }}>
                    {decisionTitle}
                  </span>
                </div>
                <div style={styles.resultText}>{decisionSubtitle}</div>
                <div style={{ ...styles.metaChipRow, marginTop: 12 }}>
                  <MetaChip label="本輪摘要" value={lastCycleSummary} />
                  <MetaChip label="formal 批次" value={formalBatchProgressText} />
                  <MetaChip label="有效組數" value={formalGroupCoverageText} />
                  <MetaChip label="自動訓練" value={autoTrainEnabled ? '運行中' : '停止'} />
                </div>
              </div>

              <div style={styles.resultPanel}>
                <div style={styles.resultTitle}>最近 10 期即時命中回饋</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                  <div style={{ background: '#f8f1e6', border: '2px solid #d9c7a8', borderRadius: 14, padding: 14 }}>
                    <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 4 }}>中2</div>
                    <div style={{ fontSize: 28, fontWeight: 900, color: '#0f766e', lineHeight: 1.1 }}>{hitFeedback.hit2} <span style={{ fontSize: 14 }}>期</span></div>
                    <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 4 }}>中2+ {hitFeedback.sampleCount ? Math.round(((hitFeedback.hit2 + hitFeedback.hit3) / hitFeedback.sampleCount) * 100) : 0}%</div>
                  </div>
                  <div style={{ background: '#f8f1e6', border: '2px solid #fecaca', borderRadius: 14, padding: 14 }}>
                    <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 4 }}>中3</div>
                    <div style={{ fontSize: 28, fontWeight: 900, color: '#dc2626', lineHeight: 1.1 }}>{hitFeedback.hit3} <span style={{ fontSize: 14 }}>期</span></div>
                    <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 4 }}>中3率 {hitFeedback.sampleCount ? Math.round((hitFeedback.hit3 / hitFeedback.sampleCount) * 100) : 0}%</div>
                  </div>
                  <div style={{ background: '#f8f1e6', border: '2px solid #d9c7a8', borderRadius: 14, padding: 14 }}>
                    <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 4 }}>中1</div>
                    <div style={{ fontSize: 28, fontWeight: 900, color: '#b45309', lineHeight: 1.1 }}>{hitFeedback.hit1} <span style={{ fontSize: 14 }}>期</span></div>
                    <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 4 }}>單組命中1</div>
                  </div>
                  <div style={{ background: '#f8f1e6', border: '2px solid #d9c7a8', borderRadius: 14, padding: 14 }}>
                    <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 4 }}>樣本</div>
                    <div style={{ fontSize: 28, fontWeight: 900, color: '#23413a', lineHeight: 1.1 }}>{hitFeedback.sampleCount} <span style={{ fontSize: 14 }}>期</span></div>
                    <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 4 }}>中0 {hitFeedback.hit0}</div>
                  </div>
                </div>
                <div style={{ ...styles.metaChipRow, marginTop: 12 }}>
                  <MetaChip label="最近樣本" value={`${hitFeedback.sampleCount} 期`} />
                  <MetaChip label="最新來源期數" value={hitFeedback.latestSourceDrawNo} />
                  <MetaChip label="加碼建議" value={hitFeedback.addBetAdvice} />
                </div>
                <div style={{ ...styles.resultText, marginTop: 10 }}>{hitFeedback.note}</div>
              </div>

              <div style={{ background: '#f8f1e6', border: '2px solid #d9c7a8', borderRadius: 14, padding: 14, marginTop: 4 }}>
                <div style={{ fontSize: 16, fontWeight: 900, color: '#0f766e', marginBottom: 12 }}>AI 目前決策</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  <div style={{ background: '#efe8db', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: '#7b6e5c', marginBottom: 3 }}>分析期數</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#23413a' }}>{displayedAnalysisPeriod} 期</div>
                  </div>
                  <div style={{ background: '#efe8db', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: '#7b6e5c', marginBottom: 3 }}>策略模式</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#23413a' }}>{getStrategyModeLabel(displayedStrategyMode)}</div>
                  </div>
                  <div style={{ background: '#efe8db', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: '#7b6e5c', marginBottom: 3 }}>下注風格</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#23413a' }}>{getRiskModeLabel(displayedRiskMode)}</div>
                  </div>
                  <div style={{ background: '#efe8db', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: '#7b6e5c', marginBottom: 3 }}>盤相</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#23413a' }}>{fmtText(displayedSelection.marketPhase, '--')}</div>
                  </div>
                </div>
              </div>
            </Card>

            <Card
              title="近期連續號碼（連2／連3／連4）"
              subtitle="連續出現的號碼，可作為三星選號參考。"
            >
              <div style={styles.marketGrid3}>
                <div style={styles.zoneBox}>
                  <div style={styles.zoneLabel}>連4+</div>
                  <div style={styles.marketBallsWrap}>
                    {streak4Buckets.length ? (
                      streak4Buckets.map((item) => (
                        <StreakBall key={`streak4_${item.num}`} n={item.num} streak={item.streak} />
                      ))
                    ) : (
                      <div style={styles.emptyBox}>目前沒有連4以上號碼。</div>
                    )}
                  </div>
                </div>

                <div style={styles.zoneBox}>
                  <div style={styles.zoneLabel}>連3</div>
                  <div style={styles.marketBallsWrap}>
                    {streak3Buckets.length ? (
                      streak3Buckets.map((item) => (
                        <StreakBall key={`streak3_${item.num}`} n={item.num} streak={item.streak} />
                      ))
                    ) : (
                      <div style={styles.emptyBox}>目前沒有連3號碼。</div>
                    )}
                  </div>
                </div>

                <div style={styles.zoneBox}>
                  <div style={styles.zoneLabel}>連2</div>
                  <div style={styles.marketBallsWrap}>
                    {streak2Buckets.length ? (
                      streak2Buckets.map((item) => (
                        <StreakBall key={`streak2_${item.num}`} n={item.num} streak={item.streak} />
                      ))
                    ) : (
                      <div style={styles.emptyBox}>目前沒有連2號碼。</div>
                    )}
                  </div>
                </div>
              </div>
            </Card>

            <Card
              title="⭐ 3星下注號碼"
              subtitle="本期3星預測號碼，每期自動產生，每組3個號碼。"
              right={
                <div style={styles.metaChipRow}>
                  <MetaChip label="每組" value="25元" />
                  <MetaChip label="期號" value={fmtText(predictionSummary.latest3StarRow?.source_draw_no, '--')} />
                  <MetaChip label="組數" value={`${toArray(predictionSummary.latest3StarRow?.groups_json).length || '--'}組`} />
                  <MetaChip label="盤相" value={fmtText(predictionSummary.latest3StarRow?.groups_json?.[0]?.meta?.market_phase, '--')} />
                  <MetaChip label="狀態" value={predictionSummary.latest3StarRow?.compare_status === 'done' ? '已比對' : '待開獎'} />
                </div>
              }
            >
              {/* 保留原本的手動產生按鈕（仍可使用） */}
              <div style={styles.formalActionBar}>
                <button
                  style={{
                    ...styles.primaryButton,
                    marginTop: 0,
                    opacity: formalButtonDisabled ? 0.6 : 1
                  }}
                  onClick={handleFormalBet}
                  disabled={formalButtonDisabled}
                >
                  {formalButtonLabel}
                </button>
                <div style={styles.formalActionHint}>
                  手動產生正式下注（同時衍生3星）
                </div>
              </div>

              {/* 3星號碼顯示 */}
              {(() => {
                const row3 = predictionSummary.latest3StarRow;
                const groups3 = toArray(row3?.groups_json);
                const compareResult = row3?.compare_result;
                const detail = toArray(compareResult?.detail);
                const bestHit = toNum(row3?.hit_count, 0);
                const isDone = row3?.compare_status === 'done';
                const hitColor = bestHit >= 3 ? '#dc2626' : bestHit >= 2 ? '#0f766e' : '#7b6e5c';

                if (!row3) return (
                  <div style={{ ...styles.emptyBox, marginTop: 16 }}>尚無3星資料，等待自動產生中...</div>
                );

                return (
                  <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {groups3.map((g, idx) => {
                      const nums = toArray(g?.nums);
                      const matchDetail = detail.find(d => String(d?.strategy_key) === String(g?.key || g?.meta?.strategy_key));
                      const hit = matchDetail ? toNum(matchDetail.hit, -1) : -1;
                      const hitBg = hit >= 3 ? '#fef2f2' : hit >= 2 ? '#f0fdf4' : '#f8f1e6';
                      const hitBorder = hit >= 3 ? '#fecaca' : hit >= 2 ? '#86efac' : '#d9c7a8';
                      return (
                        <div key={g?.key || idx} style={{ background: hitBg, border: `2px solid ${hitBorder}`, borderRadius: 14, padding: '12px 14px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f766e' }}>
                              第 {idx + 1} 組｜{fmtText(g?.label || g?.key)}
                            </div>
                            {isDone && hit >= 0 && (
                              <div style={{ fontSize: 13, fontWeight: 900, color: hit >= 3 ? '#dc2626' : hit >= 2 ? '#0f766e' : '#7b6e5c' }}>
                                中{hit}
                              </div>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            {nums.map((n) => (
                              <div key={n} style={{ ...styles.pickBall, width: 48, height: 48, fontSize: 17 }}>
                                {formatBallNumber(n)}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    {/* 損益摘要 */}
                    <div style={{ background: isDone && bestHit >= 2 ? '#f0fdf4' : '#f8f1e6', border: `2px solid ${isDone && bestHit >= 2 ? '#86efac' : '#d9c7a8'}`, borderRadius: 14, padding: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ fontSize: 13, color: '#7b6e5c' }}>{isDone ? '本期最佳命中' : '等待開獎比對'}</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: isDone ? hitColor : '#7b6e5c' }}>
                          {isDone ? `中${bestHit}` : '--'}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 6 }}>
                        {isDone
                          ? `3星獎金：${bestHit >= 3 ? '500元' : bestHit >= 2 ? '50元' : '0元'}｜成本：25元｜損益：${bestHit >= 3 ? '+475元' : bestHit >= 2 ? '+25元' : '-25元'}`
                          : '開獎後自動比對'}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </Card>



          </div>
        )}

        {!loading && activeTab === TABS.PREDICT && (

          <div style={styles.sectionStack}>
            <Card
              title="⭐ 3星比對戰績"
              subtitle="最近3星預測的實際命中統計，中2得50元、中3得500元。"
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 4 }}>
                <div style={{ background: '#f8f1e6', border: '2px solid #d9c7a8', borderRadius: 14, padding: 14 }}>
                  <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 4 }}>追蹤期數</div>
                  <div style={{ fontSize: 28, fontWeight: 900, color: '#23413a', lineHeight: 1.1 }}>{recent3StarSummary.periodCount} <span style={{ fontSize: 14 }}>期</span></div>
                  <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 4 }}>3星已比對期數</div>
                </div>
                <div style={{ background: '#f8f1e6', border: '2px solid #d9c7a8', borderRadius: 14, padding: 14 }}>
                  <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 4 }}>總組數</div>
                  <div style={{ fontSize: 28, fontWeight: 900, color: '#0f766e', lineHeight: 1.1 }}>{recent3StarSummary.groupCount} <span style={{ fontSize: 14 }}>組</span></div>
                  <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 4 }}>每期動態組數（1~8組）</div>
                </div>
                <div style={{ background: '#f8f1e6', border: '2px solid #fecaca', borderRadius: 14, padding: 14 }}>
                  <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 4 }}>中3組數</div>
                  <div style={{ fontSize: 28, fontWeight: 900, color: '#dc2626', lineHeight: 1.1 }}>{recent3StarSummary.hit3} <span style={{ fontSize: 14 }}>組</span></div>
                  <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 4 }}>+475元/組</div>
                </div>
                <div style={{ background: '#f8f1e6', border: '2px solid #d9c7a8', borderRadius: 14, padding: 14 }}>
                  <div style={{ fontSize: 13, color: '#7b6e5c', marginBottom: 4 }}>中2組數</div>
                  <div style={{ fontSize: 28, fontWeight: 900, color: '#0f766e', lineHeight: 1.1 }}>{recent3StarSummary.hit2} <span style={{ fontSize: 14 }}>組</span></div>
                  <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 4 }}>+25元/組</div>
                </div>
              </div>

              <div style={{ ...styles.metaChipRow, marginTop: 12 }}>
                <MetaChip label="中0" value={recent3StarSummary.hit0} />
                <MetaChip label="中1" value={recent3StarSummary.hit1} />
                <MetaChip label="中2" value={recent3StarSummary.hit2} />
                <MetaChip label="中3" value={recent3StarSummary.hit3} />
                <MetaChip label="中2+率" value={recent3StarSummary.groupCount ? `${Math.round((recent3StarSummary.hit2 + recent3StarSummary.hit3) / recent3StarSummary.groupCount * 100)}%` : '--'} />
              </div>
            </Card>

            <Card
              title="⭐ 3星策略競爭排行"
              subtitle="按中3率排序，AI自動選用表現最好的策略出組。"
            >
              {(() => {
                const lb = toArray(predictionSummary?.threeStarLeaderboard).slice(0, 10);
                if (!lb.length) return <div style={styles.emptyBox}>累積數據中...</div>;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {lb.map((row, idx) => (
                      <div key={row.strategy_key} style={{ background: idx === 0 ? '#f0fdf4' : '#f8f1e6', border: `2px solid ${idx === 0 ? '#86efac' : '#d9c7a8'}`, borderRadius: 12, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <span style={{ fontSize: 13, fontWeight: 800, color: '#0f766e' }}>#{idx + 1} {row.strategy_key}</span>
                          <div style={{ fontSize: 12, color: '#7b6e5c', marginTop: 2 }}>期數：{row.total_rounds} | 中3：{row.hit3}次 | 中2：{row.hit2}次</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 16, fontWeight: 900, color: row.hit3_rate > 5 ? '#dc2626' : '#0f766e' }}>{row.hit3_rate}%</div>
                          <div style={{ fontSize: 11, color: '#7b6e5c' }}>中3率</div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </Card>

          </div>
        )}

        {!loading && activeTab === TABS.MARKET && (
          <div style={styles.sectionStack}>
            <Card
              title="最新開獎盤面"
              subtitle="市場資料不是水晶球，但至少比閉著眼睛好。"
              right={<div style={styles.predictTopTag}>現在時間：{marketNowText}</div>}
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="最新期數"
                  value={fmtText(latestDrawNo)}
                  hint={`開獎時間：${fmtText(latestDrawTime)}`}
                />
                <StatBox
                  label="分析期數"
                  value={`${displayedAnalysisPeriod} 期`}
                  hint="由後台 AI 自動判斷"
                />
                <StatBox
                  label="策略模式"
                  value={getStrategyModeLabel(displayedStrategyMode)}
                  hint={displayedSelection.marketPhase ? `盤相：${fmtText(displayedSelection.marketPhase)} / 信心 ${displayedSelection.confidenceScore || '--'}` : '後端會依盤面自動微調'}
                />
                <StatBox
                  label="下注風格"
                  value={getRiskModeLabel(displayedRiskMode)}
                  hint="由後台 AI 自動分配保守 / 平衡 / 進攻 / 衝高"
                />
              </div>

              <div style={styles.marketPanel}>
                <div style={styles.marketPanelTitle}>最新 20 顆號碼</div>
                <div style={styles.marketBallsWrap}>
                  {latestNumbers.length ? (
                    latestNumbers.map((n) => <MarketBall key={n} n={n} highlight />)
                  ) : (
                    <div style={styles.emptyBox}>目前沒有最新開獎號碼。</div>
                  )}
                </div>
              </div>

              <div style={styles.marketPanel}>
                <div style={styles.marketPanelTitle}>熱門號分析</div>
                <div style={styles.historyRows}>
                  {[
                    { label: '5期（短期爆發）', lookback: 5 },
                    { label: '10期（趨勢延續）', lookback: 10 },
                    { label: '20期（穩定底盤）', lookback: 20 }
                  ].map((section) => {
                    const hotItems = calcHotNumbers(recent20, section.lookback);
                    return (
                      <div key={section.label} style={styles.historyRow}>
                        <div style={styles.historyMeta}>
                          <span>{section.label}</span>
                        </div>
                        <div style={styles.marketBallsWrap}>
                          {hotItems.length ? (
                            hotItems.map((item) => (
                              <div key={`${section.lookback}_${item.num}`} style={styles.hotBallWrap}>
                                <MarketBall n={item.num} />
                                <div style={styles.hotBallCount}>{item.count}</div>
                              </div>
                            ))
                          ) : (
                            <div style={styles.emptyBox}>目前沒有熱號資料。</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={styles.marketPanel}>
                <div style={styles.marketPanelTitle}>近期資料列</div>
                <div style={styles.historyRows}>
                  {recent20.slice(0, 5).length ? (
                    recent20.slice(0, 5).map((row, idx) => {
                      const nums = parseNums(row?.numbers || row?.nums);
                      return (
                        <div key={`${row?.draw_no || idx}`} style={styles.historyRow}>
                          <div style={styles.historyMeta}>
                            <span>期數：{fmtText(row?.draw_no || row?.drawNo)}</span>
                            <span>時間：{fmtText(row?.draw_time || row?.drawTime, '--')}</span>
                          </div>
                          <div style={styles.historyBalls}>
                            {nums.map((n) => (
                              <MarketBall key={`${row?.draw_no || idx}_${n}`} n={n} />
                            ))}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div style={styles.emptyBox}>目前沒有近期資料列。</div>
                  )}
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#f3ece0',
    padding: '12px 12px 32px',
    color: '#23413a',
    boxSizing: 'border-box'
  },
  app: {
    maxWidth: 480,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 14
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    padding: '4px 2px 0'
  },
  brand: {
    fontSize: 24,
    fontWeight: 900,
    color: '#0f766e',
    letterSpacing: '0.5px'
  },
  headerSub: {
    marginTop: 4,
    color: '#7b6e5c',
    fontSize: 12
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8
  },
  tabBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 8
  },
  tabButton: {
    border: '2px solid #2e4b44',
    background: '#f7f1e7',
    color: '#23413a',
    borderRadius: 14,
    padding: '12px 8px',
    fontSize: 16,
    fontWeight: 800,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    transition: 'all .15s ease',
    minHeight: 52
  },
  tabButtonActive: {
    background: '#0f766e',
    color: '#fff',
    borderColor: '#0f766e'
  },
  tabIcon: {
    fontSize: 18
  },
  sectionStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14
  },
  card: {
    background: '#efe8db',
    border: '2px solid #d8c7ad',
    borderRadius: 18,
    padding: 14,
    boxShadow: '0 2px 0 rgba(124, 90, 34, 0.04)'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 14
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 900,
    color: '#0f766e'
  },
  cardSubtitle: {
    marginTop: 4,
    color: '#7b6e5c',
    fontSize: 13,
    lineHeight: 1.5
  },
  statsGrid4: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 10
  },
  statsGrid2: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 10
  },
  statBox: {
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 14,
    padding: 12,
    minHeight: 90,
    boxSizing: 'border-box'
  },
  statLabel: {
    fontSize: 13,
    color: '#7b6e5c',
    marginBottom: 8
  },
  statValue: {
    fontSize: 20,
    fontWeight: 900,
    color: '#d2534f',
    lineHeight: 1.2
  },
  statHint: {
    marginTop: 8,
    color: '#7b6e5c',
    fontSize: 13,
    lineHeight: 1.5
  },
  resultPanel: {
    marginTop: 18,
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 16
  },
  resultTitle: {
    fontSize: 16,
    fontWeight: 800,
    color: '#0f766e',
    marginBottom: 8
  },
  resultText: {
    color: '#23413a',
    fontSize: 14,
    lineHeight: 1.65
  },
  miniStatsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10
  },
  metaChipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10
  },
  metaChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: '#f0e4c8',
    border: '1px solid #d1b989',
    color: '#5f5139',
    borderRadius: 999,
    padding: '6px 10px',
    fontSize: 13,
    fontWeight: 700
  },
  metaChipLabel: {
    color: '#886f46'
  },
  controlGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 16
  },
  controlBox: {
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 16
  },
  controlTitle: {
    fontSize: 16,
    fontWeight: 800,
    color: '#0f766e'
  },
  controlDesc: {
    marginTop: 8,
    color: '#7b6e5c',
    fontSize: 14,
    lineHeight: 1.6
  },
  inlineButtonRow: {
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap',
    marginTop: 14
  },
  primaryButton: {
    marginTop: 12,
    background: '#0f766e',
    color: '#fff',
    border: 'none',
    borderRadius: 14,
    padding: '14px 18px',
    fontSize: 16,
    fontWeight: 800,
    cursor: 'pointer',
    width: '100%',
    minHeight: 50
  },
  secondaryButton: {
    background: '#f8f1e6',
    color: '#23413a',
    border: '2px solid #d9c7a8',
    borderRadius: 14,
    padding: '14px 18px',
    fontSize: 16,
    fontWeight: 800,
    cursor: 'pointer',
    minHeight: 50
  },
  stopButton: {
    background: '#a1433d'
  },
  warningButton: {
    background: '#c0841c'
  },
  pipelineRow: {
    marginTop: 18,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10
  },
  pipelineBadge: {
    background: '#efe3cb',
    border: '1px solid #d3b88e',
    borderRadius: 999,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 700,
    color: '#6a583a'
  },
  predictTopTag: {
    background: '#efe3cb',
    border: '1px solid #d3b88e',
    borderRadius: 999,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 700,
    color: '#6a583a',
    whiteSpace: 'nowrap'
  },
  predictControlStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18
  },
  selectorBlock: {
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 16
  },
  selectorTitle: {
    fontSize: 16,
    fontWeight: 800,
    color: '#0f766e'
  },
  selectorDesc: {
    marginTop: 6,
    color: '#7b6e5c',
    fontSize: 14,
    lineHeight: 1.6
  },
  selectorRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 14
  },
  selectorGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 12,
    marginTop: 14
  },
  selectorButton: {
    background: '#f0e4c8',
    border: '2px solid #d3b88e',
    color: '#5f5139',
    borderRadius: 14,
    padding: '10px 14px',
    fontSize: 14,
    fontWeight: 800,
    cursor: 'pointer'
  },
  selectorButtonActive: {
    background: '#0f766e',
    borderColor: '#0f766e',
    color: '#fff'
  },
  modeCard: {
    textAlign: 'left',
    background: '#f7f0e4',
    border: '2px solid #dcc9ad',
    borderRadius: 16,
    padding: 16,
    cursor: 'pointer'
  },
  modeCardActive: {
    background: '#e0f0ea',
    borderColor: '#0f766e'
  },
  modeCardTitle: {
    fontSize: 16,
    fontWeight: 800,
    color: '#23413a'
  },
  modeCardDesc: {
    marginTop: 8,
    fontSize: 13,
    color: '#7b6e5c',
    lineHeight: 1.6
  },
  selectionSummaryBox: {
    background: '#f8f1e6',
    border: '2px dashed #d3b88e',
    borderRadius: 18,
    padding: 16
  },
  predictOnlyHint: {
    marginTop: 4,
    padding: 14,
    borderRadius: 16,
    border: '1px dashed #d3b88e',
    background: '#faf6f0',
    color: '#7b6e5c',
    fontSize: 13,
    lineHeight: 1.7
  },
  selectionSummaryTitle: {
    fontSize: 17,
    fontWeight: 800,
    color: '#0f766e',
    marginBottom: 10
  },
  predictActionBox: {
    marginTop: 18,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 16
  },
  predictActionText: {
    color: '#6f624d',
    fontSize: 14,
    lineHeight: 1.6,
    flex: 1
  },
  groupGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(1, minmax(0, 1fr))',
    gap: 12
  },
  compactBetCard: {
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 16
  },
  compactBetHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12
  },
  compactBetTitle: {
    fontSize: 21,
    fontWeight: 900,
    color: '#0f766e'
  },
  compactBetSub: {
    color: '#8a7d66',
    fontSize: 13,
    fontWeight: 700
  },
  decisionHeadline: {
    display: 'flex',
    alignItems: 'center',
    gap: 12
  },
  decisionBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f0e4c8',
    border: '1px solid #d1b989',
    borderRadius: 999,
    padding: '8px 12px',
    fontSize: 18,
    fontWeight: 900
  },
  formalActionBar: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    marginBottom: 16
  },
  formalActionHint: {
    color: '#7b6e5c',
    fontSize: 13,
    lineHeight: 1.6
  },
  groupCard: {
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 16
  },
  groupHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12
  },
  groupTitleWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  },
  groupTitle: {
    fontSize: 16,
    fontWeight: 900,
    color: '#0f766e'
  },
  groupReason: {
    fontSize: 13,
    color: '#7b6e5c',
    lineHeight: 1.5
  },
  groupBalls: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
    marginBottom: 14
  },
  pickBall: {
    width: 46,
    height: 46,
    borderRadius: '50%',
    background: '#0f766e',
    color: '#fff',
    fontSize: 16,
    fontWeight: 900,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: 'inset 0 -3px 0 rgba(0,0,0,0.12)'
  },
  batchCard: {
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 16
  },
  batchCardHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    marginBottom: 16
  },
  batchCardTitle: {
    fontSize: 16,
    fontWeight: 900,
    color: '#0f766e'
  },
  batchCardSub: {
    marginTop: 6,
    fontSize: 13,
    color: '#7b6e5c'
  },
  marketPanel: {
    marginTop: 18,
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 16
  },
  marketPanelTitle: {
    fontSize: 16,
    fontWeight: 900,
    color: '#0f766e',
    marginBottom: 12
  },
  marketGrid2: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 16
  },
  marketGrid3: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 10
  },
  marketBallsWrap: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10
  },
  marketBall: {
    width: 46,
    height: 46,
    borderRadius: '50%',
    background: '#efe3cb',
    border: '2px solid #d3b88e',
    color: '#4a4031',
    fontSize: 15,
    fontWeight: 900,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  marketBallHighlight: {
    background: '#0f766e',
    borderColor: '#0f766e',
    color: '#fff'
  },
  hotBallWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4
  },
  hotBallCount: {
    fontSize: 12,
    color: '#7b6e5c',
    fontWeight: 700
  },
  streakBallWrap: {
    position: 'relative',
    width: 48,
    height: 56
  },
  streakBall: {
    width: 46,
    height: 46,
    borderRadius: '50%',
    background: '#f0e4c8',
    border: '2px solid #d3b88e',
    color: '#4a4031',
    fontSize: 15,
    fontWeight: 900,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  streakBadge: {
    position: 'absolute',
    right: -2,
    bottom: 0,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    background: '#c84a4a',
    color: '#fff',
    fontSize: 11,
    fontWeight: 900,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 5px'
  },
  zoneGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: 12
  },
  zoneBox: {
    background: '#efe3cb',
    border: '1px solid #d3b88e',
    borderRadius: 16,
    padding: 16,
    textAlign: 'center'
  },
  zoneLabel: {
    fontSize: 14,
    color: '#7b6e5c',
    marginBottom: 8
  },
  zoneCount: {
    fontSize: 26,
    fontWeight: 900,
    color: '#0f766e'
  },
  historyRows: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  historyRow: {
    background: '#fbf6ee',
    border: '1px solid #ddcfbb',
    borderRadius: 14,
    padding: 14
  },
  historyMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 10,
    color: '#7b6e5c',
    fontSize: 13
  },
  historyBalls: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8
  },
  emptyBox: {
    width: '100%',
    minHeight: 72,
    border: '2px dashed #d3b88e',
    background: '#faf6f0',
    borderRadius: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#8a7d66',
    fontSize: 14,
    padding: 16,
    boxSizing: 'border-box'
  },
  errorBanner: {
    background: '#f8d7d7',
    color: '#9f2f2f',
    border: '1px solid #e8b7b7',
    borderRadius: 16,
    padding: 14,
    fontWeight: 700
  },
  loading: {
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 16,
    padding: 18,
    textAlign: 'center',
    color: '#7b6e5c',
    fontWeight: 700
  },
  comparePeriodsWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16
  },
  comparePeriodCard: {
    border: '1px solid #d6c3a3',
    borderRadius: 18,
    padding: 14,
    background: '#fbf6ec',
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  comparePeriodHead: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'flex-start',
    flexWrap: 'wrap'
  },
  comparePeriodTitle: {
    fontSize: 16,
    fontWeight: 800,
    color: '#0f766e'
  },
  comparePeriodSub: {
    fontSize: 12,
    color: '#7c6a4d',
    marginTop: 4
  },
  compareBatchStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  compareBatchCard: {
    border: '1px dashed #d6c3a3',
    borderRadius: 16,
    padding: 12,
    background: '#fffaf1'
  },
  compareBatchHead: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 10
  },
  compareBatchTitle: {
    fontSize: 14,
    fontWeight: 800,
    color: '#23413a'
  },
  compareBatchSub: {
    fontSize: 12,
    color: '#7c6a4d'
  },
  compareGroupGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 12
  },
  compareGroupCard: {
    border: '1px solid #e7d6b8',
    borderRadius: 14,
    padding: 12,
    background: '#ffffff'
  },
  compareGroupHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10
  },
  compareGroupTitle: {
    fontSize: 13,
    fontWeight: 800,
    color: '#23413a'
  },
  compareHitBadge: {
    minWidth: 48,
    textAlign: 'center',
    padding: '4px 8px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    color: '#7c6a4d',
    background: '#efe3ca'
  },
  compareHitBadgeMid: {
    color: '#b45309',
    background: '#fde7c2'
  },
  compareHitBadgeStrong: {
    color: '#0f766e',
    background: '#ccefe8'
  },
};

// 攻擊型分數
function calcFrontScore(groups = []) { let total=0; groups.forEach(g=>{const h=Number(g?.meta?.avg_hit||0); const r=Number(g?.meta?.roi||0); total+=h*50+Math.max(r,-1)*30;}); return Math.min(100,total/(groups.length||1)); }
