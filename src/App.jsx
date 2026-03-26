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
const NIGHT_STOP_END_MINUTES = 7 * 60 + 30;

const FORMAL_BATCH_LIMIT = 3;
const FORMAL_GROUP_COUNT = 4;
const COST_PER_GROUP = 25;

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

function normalizeGroups(rawGroups) {
  const groups = Array.isArray(rawGroups) ? rawGroups : [];

  return groups
    .map((group, idx) => {
      if (!group || typeof group !== 'object') return null;

      const nums = parseNums(group?.nums || group?.numbers || []);
      if (nums.length !== 4) return null;

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

function safeFetchJson(url, options) {
  return fetch(url, options).then(async (res) => {
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

async function safeFetchJsonAllowHttpError(url, options) {
  const res = await fetch(url, options);
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

function normalizePredictionLatest(data) {
  const formalBatches = toArray(data?.formal_batches);
  const normalizedFormalBatches = formalBatches.map((batch, idx) => ({
    ...batch,
    formal_batch_no: toNum(batch?.formal_batch_no, idx + 1)
  }));

  return {
    apiVersion: data?.api_version || '--',
    trainingRow:
      data?.training_row ||
      getPredictionLatestRow(data?.training || data?.ai_train || data, 'test') ||
      null,
    formalRow:
      data?.formal_row ||
      getPredictionLatestRow(data?.formal || data, 'formal') ||
      null,
    leaderboard: toArray(data?.leaderboard),
    summaryLabel: data?.summaryLabel || '--',
    summaryText: data?.summaryText || '--',
    assistantMode: data?.assistantMode || 'decision_support',
    readyForFormal: Boolean(data?.readyForFormal),
    adviceLevel: data?.adviceLevel || 'watch',
    decisionPhase: data?.decisionPhase || 'watch_only',
    currentTopStrategies: toArray(data?.currentTopStrategies),
    formalBatchLimit: toNum(data?.formal_batch_limit, FORMAL_BATCH_LIMIT),
    formalBatchCount: toNum(data?.formal_batch_count, 0),
    formalRemainingBatchCount: toNum(data?.formal_remaining_batch_count, FORMAL_BATCH_LIMIT),
    formalSourceDrawNo: data?.formal_source_draw_no || null,
    formalBatches: normalizedFormalBatches
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
      <div style={{ ...styles.statValue, ...valueStyle }}>{value}</div>
      {hint ? <div style={styles.statHint}>{hint}</div> : null}
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
  return (
    <div style={styles.groupCard}>
      <div style={styles.groupHeader}>
        <div style={styles.groupTitleWrap}>
          <div style={styles.groupTitle}>
            {showRank ? `第 ${idx + 1} 名｜` : ''}
            {fmtText(group?.label || group?.key, `第${idx + 1}組`)}
          </div>
          <div style={styles.groupReason}>{fmtText(group?.reason)}</div>
        </div>
      </div>

      <div style={styles.groupBalls}>
        {toArray(group?.nums).map((n) => (
          <div key={`${group?.key}_${n}`} style={styles.pickBall}>
            {formatBallNumber(n)}
          </div>
        ))}
      </div>

      <div style={styles.metaChipRow}>
        <MetaChip label="策略" value={fmtText(meta?.strategy_key || group?.key)} />
        <MetaChip label="排序" value={fmtText(meta?.selection_rank, idx + 1)} />
        <MetaChip label="ROI" value={fmtPercent(meta?.recent_50_roi ?? meta?.roi)} />
        <MetaChip
          label="平均命中"
          value={fmtText(
            Number.isFinite(Number(meta?.avg_hit)) ? Number(meta.avg_hit).toFixed(2) : '--'
          )}
        />
      </div>
    </div>
  );
}

function FormalBatchCard({ batch, idx }) {
  const groups = getPredictionGroups(batch);

  return (
    <div style={styles.batchCard}>
      <div style={styles.batchCardHead}>
        <div>
          <div style={styles.batchCardTitle}>
            第 {fmtText(batch?.formal_batch_no, idx + 1)} 批
          </div>
          <div style={styles.batchCardSub}>
            建立時間：{fmtDateTime(batch?.created_at)}
          </div>
        </div>

        <div style={styles.metaChipRow}>
          <MetaChip label="status" value={fmtText(batch?.status)} />
          <MetaChip label="source_draw_no" value={fmtText(batch?.source_draw_no)} />
          <MetaChip label="groups" value={groups.length} />
        </div>
      </div>

      <div style={styles.groupGrid}>
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

export default function App() {
  const [activeTab, setActiveTab] = useState(TABS.DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [loopStatusText, setLoopStatusText] = useState('待命中');

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
    formalBatches: []
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
        formalBatches: normalizedPrediction.formalBatches
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

 const handleFormalBet = async () => {
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
};

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

  const handleToggleAutoTrain = async () => {
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
  };

  const latestDraw = recent20[0] || null;
  const latestDrawNo = latestDraw?.draw_no || latestDraw?.drawNo || aiPlayer?.latestDrawNo || '--';
  const latestDrawTime = latestDraw?.draw_time || latestDraw?.drawTime || aiPlayer?.latestDrawTime || '--';
  const latestNumbers = parseNums(latestDraw?.numbers || latestDraw?.nums);

  const trainingGroups = getPredictionGroups(trainingLatest);
  const formalGroups = getPredictionGroups(formalLatest);

  const hotNumbers = useMemo(() => calcHotNumbers(recent20, 10), [recent20]);
  const streakNumbers = useMemo(() => calcCurrentStreakNumbers(recent20, 5), [recent20]);
  const zoneCounts = useMemo(() => calcZoneCounts(latestNumbers), [latestNumbers]);

  const lastCycleSummary = useMemo(() => buildLoopStatusText(lastAutoTrainResult), [lastAutoTrainResult]);

  const currentTopStrategies = predictionSummary.currentTopStrategies.length
    ? predictionSummary.currentTopStrategies
    : aiPlayer.currentTopStrategies;

  const canFormalBet = predictionSummary.readyForFormal || aiPlayer.readyForFormal;
  const formalBatchCount = predictionSummary.formalBatchCount;
  const formalRemainingBatchCount = predictionSummary.formalRemainingBatchCount;
  const formalBatchLimit = predictionSummary.formalBatchLimit || FORMAL_BATCH_LIMIT;
  const formalBatches = predictionSummary.formalBatches || [];
  const formalBatchProgressText = `${formalBatchCount} / ${formalBatchLimit}`;
  const formalButtonDisabled = busyKey !== '' || formalRemainingBatchCount <= 0;
  const formalButtonLabel =
    formalRemainingBatchCount <= 0 ? '本期已達 3 批上限' : '產生一批正式下注';

  return (
    <div style={styles.page}>
      <div style={styles.app}>
        <header style={styles.header}>
          <div>
            <div style={styles.brand}>FUWEI BINGO AI</div>
            <div style={styles.headerSub}>策略輪動、單期決策、分批下注。</div>
          </div>

          <div style={styles.headerActions}>
            <button
              style={styles.secondaryButton}
              onClick={loadAll}
              disabled={busyKey !== ''}
            >
              重新整理
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
              title="決策總覽"
              subtitle="這裡不是看 AI 有沒有做夢，而是看現在能不能小試。"
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="目前判斷"
                  value={fmtText(aiPlayer.statusLabel)}
                  hint={fmtText(aiPlayer.decisionPhase)}
                  valueStyle={{ color: aiPlayer.statusColor }}
                />
                <StatBox
                  label="決策準備度"
                  value={`${aiPlayer.trainingStrength} / 100`}
                  hint="依近期比對、策略品質與活躍數估算"
                  valueStyle={{ color: aiPlayer.statusColor }}
                />
                <StatBox
                  label="第一名策略"
                  value={fmtText(aiPlayer.topStrategyKey)}
                  hint={`平均命中 ${Number.isFinite(aiPlayer.topStrategyAvgHit) ? aiPlayer.topStrategyAvgHit.toFixed(1) : '--'} / 近50 ROI ${fmtPercent(aiPlayer.topStrategyRecent50Roi)}`}
                />
                <StatBox
                  label="是否建議正式下注"
                  value={canFormalBet ? '可小試' : '先觀察'}
                  hint={`活躍策略 ${aiPlayer.activeCount} / 策略池 ${aiPlayer.totalPoolCount}`}
                  valueStyle={{ color: canFormalBet ? '#0f766e' : '#b45309' }}
                />
              </div>

              <div style={styles.resultPanel}>
                <div style={styles.resultTitle}>系統狀態</div>
                <div style={styles.resultText}>
                  {aiPlayer.statusArrow} {aiPlayer.statusText}
                </div>
                <div style={{ ...styles.resultText, marginTop: 8, color: '#8a7d66' }}>
                  最近一輪摘要：{lastCycleSummary}
                </div>
              </div>

              <div style={styles.resultPanel}>
                <div style={styles.resultTitle}>本小時動作</div>
                <div style={styles.miniStatsRow}>
                  <MetaChip label="Compare" value={aiPlayer.comparedLastHour} />
                  <MetaChip label="Create" value={aiPlayer.createdLastHour} />
                  <MetaChip label="停用" value={aiPlayer.disabledLastHour} />
                  <MetaChip label="最新期數" value={fmtText(latestDrawNo)} />
                </div>
              </div>

              <div style={styles.resultPanel}>
                <div style={styles.resultTitle}>目前前四策略</div>
                <div style={styles.groupGrid}>
                  {currentTopStrategies.length ? (
                    currentTopStrategies.slice(0, 4).map((row, idx) => (
                      <div key={row?.strategy_key || idx} style={styles.groupCard}>
                        <div style={styles.groupTitle}>第 {idx + 1} 名｜{fmtText(row?.strategy_key)}</div>
                        <div style={styles.metaChipRow}>
                          <MetaChip label="平均命中" value={Number.isFinite(Number(row?.avg_hit)) ? Number(row.avg_hit).toFixed(2) : '--'} />
                          <MetaChip label="ROI" value={fmtPercent(row?.recent_50_roi ?? row?.roi)} />
                          <MetaChip label="回合" value={fmtText(row?.total_rounds)} />
                          <MetaChip label="分數" value={Number.isFinite(Number(row?.strategy_score ?? row?.score)) ? Number(row?.strategy_score ?? row?.score).toFixed(1) : '--'} />
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={styles.emptyBox}>目前沒有前四策略資料。</div>
                  )}
                </div>
              </div>
            </Card>

            <Card
              title="策略模擬控制"
              subtitle="這裡是模擬系統，不是無腦長開鍋爐房。"
            >
              <div style={styles.controlGrid}>
                <div style={styles.controlBox}>
                  <div style={styles.controlTitle}>自動模擬</div>
                  <div style={styles.controlDesc}>
                    夜間 00:00～07:30 暫停，平常每 3 分鐘循環一次。
                  </div>
                  <button
                    style={{
                      ...styles.primaryButton,
                      ...(autoTrainEnabled ? styles.stopButton : {})
                    }}
                    onClick={handleToggleAutoTrain}
                    disabled={busyKey !== '' && busyKey !== 'toggleAutoTrain'}
                  >
                    {autoTrainEnabled ? '停止模擬' : '啟動模擬'}
                  </button>
                </div>

                <div style={styles.controlBox}>
                  <div style={styles.controlTitle}>資料同步</div>
                  <div style={styles.controlDesc}>同步最新期數與補抓遺漏資料。</div>
                  <div style={styles.inlineButtonRow}>
                    <button
                      style={styles.secondaryButton}
                      onClick={handleSync}
                      disabled={busyKey !== ''}
                    >
                      同步最新期數
                    </button>
                    <button
                      style={styles.secondaryButton}
                      onClick={handleCatchup}
                      disabled={busyKey !== ''}
                    >
                      補抓期數
                    </button>
                  </div>
                </div>
              </div>

              <div style={styles.pipelineRow}>
                <span style={styles.pipelineBadge}>同步：{pipelineStatusText(lastAutoTrainResult, 'sync')}</span>
                <span style={styles.pipelineBadge}>補抓：{pipelineStatusText(lastAutoTrainResult, 'catchup')}</span>
                <span style={styles.pipelineBadge}>比對：{pipelineStatusText(lastAutoTrainResult, 'compare')}</span>
              </div>
            </Card>
          </div>
        )}

        {!loading && activeTab === TABS.PREDICT && (
          <div style={styles.sectionStack}>
            <Card
              title="正式下注面板"
              subtitle="正式下注改為單期、前四策略、同一期最多三批。"
              right={
                <div style={styles.predictTopTag}>
                  每組 {COST_PER_GROUP} 元 × {FORMAL_GROUP_COUNT} 組 × 最多 {formalBatchLimit} 批
                </div>
              }
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="下注建議"
                  value={fmtText(predictionSummary.summaryLabel)}
                  hint={fmtText(predictionSummary.summaryText)}
                  valueStyle={{ color: canFormalBet ? '#0f766e' : '#b45309' }}
                />
                <StatBox
                  label="批次進度"
                  value={formalBatchProgressText}
                  hint={`剩餘 ${formalRemainingBatchCount} 批`}
                  valueStyle={{ color: formalRemainingBatchCount > 0 ? '#0f766e' : '#b45309' }}
                />
                <StatBox
                  label="formal source_draw_no"
                  value={fmtText(predictionSummary.formalSourceDrawNo)}
                  hint={`API：${fmtText(predictionSummary.apiVersion)}`}
                />
                <StatBox
                  label="單批成本"
                  value={fmtMoney(COST_PER_GROUP * FORMAL_GROUP_COUNT)}
                  hint="每批固定 100 元"
                />
              </div>

              <div style={styles.predictActionBox}>
                <div style={styles.predictActionText}>
                  目前邏輯：同一期最多三批，formal 會鎖定同一個 source_draw_no，直到 3 批滿為止。
                </div>
                <button
                  style={{
                    ...styles.primaryButton,
                    ...((!canFormalBet || formalRemainingBatchCount <= 0) ? styles.warningButton : {})
                  }}
                  onClick={handleFormalBet}
                  disabled={formalButtonDisabled}
                >
                  {formalButtonLabel}
                </button>
              </div>
            </Card>

            <Card
              title="最新 test 模擬前四組"
              subtitle="這是正式下注的來源，先看它再決定要不要按。"
            >
              <div style={styles.groupGrid}>
                {trainingGroups.length ? (
                  trainingGroups.slice(0, 4).map((group, idx) => (
                    <GroupCard key={group?.key || idx} group={group} idx={idx} showRank />
                  ))
                ) : (
                  <div style={styles.emptyBox}>目前沒有 test prediction 可顯示。</div>
                )}
              </div>
            </Card>

            <Card
              title="本期 formal 批次總覽"
              subtitle="這裡才是你現在真正的實戰面板。"
            >
              <div style={styles.metaChipRow}>

                <MetaChip label="已下注" value={formalBatchCount} />
                <MetaChip label="上限" value={formalBatchLimit} />
                <MetaChip label="剩餘" value={formalRemainingBatchCount} />
                <MetaChip label="source_draw_no" value={fmtText(predictionSummary.formalSourceDrawNo)} />
              </div>

              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {formalBatches.length ? (
                  formalBatches.map((batch, idx) => (
                    <FormalBatchCard key={batch?.id || idx} batch={batch} idx={idx} />
                  ))
                ) : (
                  <div style={styles.emptyBox}>目前這一期還沒有 formal 批次資料。</div>
                )}
              </div>
            </Card>

            <Card
              title="最新 formal 正式下注"
              subtitle="保留最近一批摘要，方便你快速看最後一手。"
            >
              <div style={styles.groupGrid}>
                {formalGroups.length ? (
                  formalGroups.map((group, idx) => (
                    <GroupCard key={group?.key || idx} group={group} idx={idx} />
                  ))
                ) : (
                  <div style={styles.emptyBox}>目前沒有正式下注資料。</div>
                )}
              </div>

              <div style={{ marginTop: 16 }}>
                <div style={styles.metaChipRow}>
                  <MetaChip label="mode" value={fmtText(formalLatest?.mode)} />
                  <MetaChip label="status" value={fmtText(formalLatest?.status)} />
                  <MetaChip label="source_draw_no" value={fmtText(formalLatest?.source_draw_no)} />
                  <MetaChip label="target_periods" value={fmtText(formalLatest?.target_periods)} />
                  <MetaChip label="建立時間" value={fmtDateTime(formalLatest?.created_at)} />
                </div>
              </div>
            </Card>

            <Card
              title="策略排行榜"
              subtitle="不是誰名字帥，是誰最近真的有在贏。"
            >
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>排名</th>
                      <th style={styles.th}>策略</th>
                      <th style={styles.th}>平均命中</th>
                      <th style={styles.th}>近50 ROI</th>
                      <th style={styles.th}>回合</th>
                      <th style={styles.th}>分數</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.length ? (
                      leaderboard.slice(0, 10).map((row, idx) => (
                        <tr key={row?.key || idx}>
                          <td style={styles.td}>{idx + 1}</td>
                          <td style={styles.td}>{fmtText(row?.label || row?.key)}</td>
                          <td style={styles.td}>
                            {Number.isFinite(Number(row?.avg_hit))
                              ? Number(row.avg_hit).toFixed(2)
                              : '--'}
                          </td>
                          <td style={styles.td}>
                            {fmtPercent(row?.recent_50_roi ?? row?.roi)}
                          </td>
                          <td style={styles.td}>{fmtText(row?.total_rounds)}</td>
                          <td style={styles.td}>
                            {Number.isFinite(Number(row?.score))
                              ? Number(row.score).toFixed(1)
                              : '--'}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td style={styles.td} colSpan={6}>
                          目前無排行榜資料。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {!loading && activeTab === TABS.MARKET && (
          <div style={styles.sectionStack}>
            <Card
              title="市場即時資訊"
              subtitle="盤面是基礎，策略是決策。"
              right={<div style={styles.marketInfoTag}>最近五期連莊 / 最近十期熱號</div>}
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="最新期數"
                  value={fmtText(latestDrawNo)}
                  hint="即時最新一期"
                  valueStyle={{ color: '#d97706' }}
                />
                <StatBox
                  label="目前時間"
                  value={marketNowText}
                  hint="前端即時顯示"
                />
                <StatBox
                  label="開出號碼數"
                  value={latestNumbers.length}
                  hint="BINGO 1~80"
                />
                <StatBox
                  label="五期內連莊數"
                  value={streakNumbers.length}
                  hint="只算目前連開 2 期以上"
                  valueStyle={{ color: '#c2410c' }}
                />
              </div>
            </Card>

            <Card
              title="本期球號"
              subtitle="最新一期的 20 顆球。"
            >
              <div style={styles.marketHeroBox}>
                <div style={styles.marketDrawNoLine}>
                  最新期數：
                  <span style={styles.marketDrawNoValue}>{fmtText(latestDrawNo)}</span>
                  <span style={styles.marketDrawTimeText}>　{fmtDateTime(latestDrawTime)}</span>
                </div>

                <div style={styles.marketBallsHero}>
                  {latestNumbers.length ? (
                    latestNumbers.map((n) => <MarketBall key={n} n={n} />)
                  ) : (
                    <div style={styles.emptyBox}>目前沒有本期球號資料。</div>
                  )}
                </div>
              </div>
            </Card>

            <Card
              title="五期內連莊號碼"
              subtitle="從最新一期往前看，只顯示目前連開中的號碼。"
            >
              <div style={styles.streakWrap}>
                {streakNumbers.length ? (
                  streakNumbers.map((item) => (
                    <StreakBall key={item.num} n={item.num} streak={item.streak} />
                  ))
                ) : (
                  <div style={styles.emptyBox}>目前沒有連莊中的號碼。</div>
                )}
              </div>
            </Card>

            <Card
              title="最近十期熱號"
              subtitle="統計最近十期出現次數最多的號碼。"
            >
              <div style={styles.hotWrap}>
                {hotNumbers.length ? (
                  hotNumbers.map((item) => (
                    <div key={item.num} style={styles.hotItem}>
                      <div style={styles.hotBall}>{formatBallNumber(item.num)}</div>
                      <div style={styles.hotCount}>{item.count} 次</div>
                    </div>
                  ))
                ) : (
                  <div style={styles.emptyBox}>目前沒有熱號資料。</div>
                )}
              </div>
            </Card>

            <Card
              title="本期區間分布"
              subtitle="看 1~80 四區目前各開幾顆。"
            >
              <div style={styles.zoneGrid}>
                {zoneCounts.map((zone) => (
                  <div key={zone.label} style={styles.zoneBox}>
                    <div style={styles.zoneLabel}>{zone.label}</div>
                    <div style={styles.zoneCount}>{zone.count}</div>
                  </div>
                ))}
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
    background: '#f6efd7',
    padding: 20,
    boxSizing: 'border-box',
    color: '#3c3428',
    fontFamily:
      '"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif'
  },
  app: {
    maxWidth: 1320,
    margin: '0 auto'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    marginBottom: 18
  },
  brand: {
    fontSize: 24,
    fontWeight: 800,
    color: '#0f766e',
    letterSpacing: 0.5
  },
  headerSub: {
    marginTop: 4,
    color: '#8a7d66',
    fontSize: 14
  },
  headerActions: {
    display: 'flex',
    gap: 10
  },
  tabBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 12,
    marginBottom: 18
  },
  tabButton: {
    border: '1px solid #d7c89a',
    borderRadius: 16,
    background: '#fffaf0',
    padding: '14px 18px',
    fontSize: 22,
    fontWeight: 700,
    color: '#4b4436',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10
  },
  tabButtonActive: {
    background: '#12806d',
    color: '#fff',
    borderColor: '#12806d'
  },
  tabIcon: {
    fontSize: 18
  },
  loading: {
    background: '#fffaf0',
    border: '1px solid #ead9a9',
    borderRadius: 16,
    padding: 18,
    fontSize: 16
  },
  errorBanner: {
    background: '#fff1f2',
    color: '#b42318',
    border: '1px solid #f4c7cc',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14
  },
  sectionStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16
  },
  card: {
    background: '#fffaf0',
    border: '1px solid #e7d7a9',
    borderRadius: 22,
    padding: 18,
    boxShadow: '0 4px 14px rgba(120, 100, 50, 0.06)'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    marginBottom: 14
  },
  cardTitle: {
    fontSize: 28,
    fontWeight: 800,
    color: '#0b7c72'
  },
  cardSubtitle: {
    marginTop: 4,
    fontSize: 14,
    color: '#8b7b5b'
  },
  statsGrid4: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: 14
  },
  statBox: {
    border: '1px solid #e7d7a9',
    borderRadius: 18,
    padding: 16,
    background: '#fffdf6'
  },
  statLabel: {
    fontSize: 13,
    color: '#8b7b5b',
    marginBottom: 8
  },
  statValue: {
    fontSize: 22,
    fontWeight: 800,
    color: '#b45309',
    lineHeight: 1.2
  },
  statHint: {
    marginTop: 8,
    fontSize: 12,
    color: '#9a8c70'
  },
  resultPanel: {
    marginTop: 16,
    border: '1px solid #ead9a9',
    borderRadius: 18,
    padding: 16,
    background: '#fffdf8'
  },
  resultTitle: {
    fontSize: 17,
    fontWeight: 800,
    color: '#0f766e',
    marginBottom: 8
  },
  resultText: {
    fontSize: 15,
    color: '#544936',
    lineHeight: 1.65
  },
  miniStatsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10
  },
  pipelineRow: {
    marginTop: 14,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10
  },
  pipelineBadge: {
    background: '#f8edc8',
    border: '1px solid #dfcb8f',
    color: '#6e5a28',
    borderRadius: 999,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 700
  },
  controlGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16
  },
  controlBox: {
    border: '1px solid #e7d7a9',
    borderRadius: 18,
    background: '#fffdf6',
    padding: 16
  },
  controlTitle: {
    fontSize: 18,
    fontWeight: 800,
    color: '#0f766e',
    marginBottom: 8
  },
  controlDesc: {
    fontSize: 14,
    color: '#8a7d66',
    lineHeight: 1.6,
    marginBottom: 12
  },
  inlineButtonRow: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap'
  },
  primaryButton: {
    border: 'none',
    borderRadius: 14,
    background: '#0f766e',
    color: '#fff',
    padding: '12px 16px',
    fontSize: 15,
    fontWeight: 800,
    cursor: 'pointer'
  },
  secondaryButton: {
    border: '1px solid #d9c88f',
    borderRadius: 14,
    background: '#fff7df',
    color: '#5a4b2f',
    padding: '12px 16px',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer'
  },
  stopButton: {
    background: '#b42318'
  },
  warningButton: {
    background: '#b45309'
  },
  predictTopTag: {
    background: '#f8edc8',
    border: '1px solid #dfcb8f',
    borderRadius: 999,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 700,
    color: '#6e5a28'
  },
  predictActionBox: {
    marginTop: 16,
    border: '1px dashed #d7c27d',
    borderRadius: 18,
    padding: 16,
    background: '#fffdf6',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16
  },
  predictActionText: {
    fontSize: 14,
    color: '#665941',
    lineHeight: 1.7
  },
  groupGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 14
  },
  groupCard: {
    border: '1px solid #ead9a9',
    borderRadius: 18,
    padding: 16,
    background: '#fffdf7'
  },
  groupHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10
  },
  groupTitleWrap: {
    flex: 1
  },
  groupTitle: {
    fontSize: 17,
    fontWeight: 800,
    color: '#0f766e'
  },
  groupReason: {
    marginTop: 6,
    fontSize: 13,
    color: '#8b7b5b',
    lineHeight: 1.6
  },
  groupBalls: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    margin: '14px 0'
  },
  pickBall: {
    width: 44,
    height: 44,
    borderRadius: 999,
    background: '#12806d',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    fontSize: 16
  },
  metaChipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8
  },
  metaChip: {
    background: '#f7efcf',
    border: '1px solid #e0cf95',
    borderRadius: 999,
    padding: '6px 10px',
    display: 'inline-flex',
    gap: 6,
    fontSize: 12,
    color: '#5c4d30'
  },
  metaChipLabel: {
    fontWeight: 800
  },
  batchCard: {
    border: '1px solid #e0cf95',
    borderRadius: 20,
    background: '#fffdf7',
    padding: 16
  },
  batchCardHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 14
  },
  batchCardTitle: {
    fontSize: 20,
    fontWeight: 800,
    color: '#0f766e'
  },
  batchCardSub: {
    marginTop: 4,
    fontSize: 13,
    color: '#8b7b5b'
  },
  tableWrap: {
    overflowX: 'auto'
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse'
  },
  th: {
    textAlign: 'left',
    padding: '12px 10px',
    background: '#f8efcf',
    borderBottom: '1px solid #e1cf98',
    color: '#6e5a28',
    fontSize: 13
  },
  td: {
    padding: '12px 10px',
    borderBottom: '1px solid #efe2ba',
    fontSize: 14,
    color: '#463c2d'
  },
  marketInfoTag: {
    background: '#f8edc8',
    border: '1px solid #dfcb8f',
    borderRadius: 999,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 700,
    color: '#6e5a28'
  },
  marketHeroBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14
  },
  marketDrawNoLine: {
    fontSize: 16,
    color: '#5c4d30'
  },
  marketDrawNoValue: {
    color: '#c77700',
    fontWeight: 800,
    fontSize: 22
  },
  marketDrawTimeText: {
    color: '#8a7d66',
    fontSize: 13
  },
  marketBallsHero: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10
  },
  marketBall: {
    width: 42,
    height: 42,
    borderRadius: 999,
    background: '#efe3b2',
    border: '1px solid #dcc98a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    color: '#6d561c'
  },
  marketBallHighlight: {
    background: '#d97706',
    color: '#fff',
    borderColor: '#d97706'
  },
  streakWrap: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 14
  },
  streakBallWrap: {
    position: 'relative',
    width: 50,
    height: 58
  },
  streakBall: {
    width: 44,
    height: 44,
    borderRadius: 999,
    background: '#c2410c',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800
  },
  streakBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    minWidth: 22,
    height: 22,
    borderRadius: 999,
    background: '#12806d',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    fontSize: 12
  },
  hotWrap: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12
  },
  hotItem: {
    width: 76,
    border: '1px solid #ead9a9',
    borderRadius: 16,
    padding: 10,
    background: '#fffdf7',
    textAlign: 'center'
  },
  hotBall: {
    width: 40,
    height: 40,
    margin: '0 auto 8px',
    borderRadius: 999,
    background: '#d97706',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800
  },
  hotCount: {
    fontSize: 13,
    color: '#7b6540',
    fontWeight: 700
  },
  zoneGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: 12
  },
  zoneBox: {
    border: '1px solid #ead9a9',
    borderRadius: 18,
    padding: 16,
    background: '#fffdf6',
    textAlign: 'center'
  },
  zoneLabel: {
    fontSize: 14,
    color: '#8a7d66',
    marginBottom: 8
  },
  zoneCount: {
    fontSize: 28,
    fontWeight: 800,
    color: '#0f766e'
  },
  emptyBox: {
    padding: 18,
    border: '1px dashed #d9c98f',
    borderRadius: 16,
    background: '#fffdf7',
    color: '#8a7d66',
    fontSize: 14
  }
};
