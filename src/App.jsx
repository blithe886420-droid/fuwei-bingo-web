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

  const trainingRow =
    data?.training_row ||
    getPredictionLatestRow(data?.training || data?.ai_train || data, 'test') ||
    null;

  const formalRow =
    data?.formal_row ||
    getPredictionLatestRow(data?.formal || data, 'formal') ||
    null;

  const instantFormalRow =
    data?.instant_formal ||
    data?.instantFormal ||
    data?.active_formal_candidate ||
    getPredictionLatestRow(data?.instant_formal || data?.candidate || data, 'formal_candidate') ||
    null;

  const displayFormalRow = instantFormalRow || formalRow || null;

  return {
    apiVersion: data?.api_version || '--',
    trainingRow,
    formalRow,
    instantFormalRow,
    displayFormalRow,
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

function getStrategyModeLabel(mode) {
  const found = STRATEGY_MODE_OPTIONS.find((item) => item.key === mode);
  return found ? found.label : mode;
}

function getRiskModeLabel(mode) {
  const found = RISK_MODE_OPTIONS.find((item) => item.key === mode);
  return found ? found.label : mode;
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
        <MetaChip label="角色" value={fmtText(meta?.role_label || meta?.type || '--')} />
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

  const [analysisPeriod, setAnalysisPeriod] = useState(20);
  const [strategyMode, setStrategyMode] = useState('mix');
  const [riskMode, setRiskMode] = useState('balanced');

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
      setFormalLatest(normalizedPrediction.displayFormalRow || null);
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
  trigger_source: 'app_button',
  analysisPeriod,
  strategyMode,
  riskMode
})
      });
    });
  }, [runAction, analysisPeriod, strategyMode, riskMode]);

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

  const recentRowsByPeriod = useMemo(() => {
    return toArray(recent20).slice(0, analysisPeriod);
  }, [recent20, analysisPeriod]);

  const trainingGroups = useMemo(() => getPredictionGroups(trainingLatest), [trainingLatest]);
  const formalGroups = useMemo(() => getPredictionGroups(formalLatest), [formalLatest]);

  const hotNumbers = useMemo(() => calcHotNumbers(recentRowsByPeriod, Math.min(analysisPeriod, 10)), [recentRowsByPeriod, analysisPeriod]);
  const streakNumbers = useMemo(() => calcCurrentStreakNumbers(recentRowsByPeriod, Math.min(analysisPeriod, 5)), [recentRowsByPeriod, analysisPeriod]);
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

  const formalButtonDisabled =
    busyKey !== '' ||
    !canFormalBet ||
    formalRemainingBatchCount <= 0;

  const formalButtonLabel = !canFormalBet
    ? '暫不建議正式下注'
    : formalRemainingBatchCount <= 0
      ? '本期已達 3 批上限'
      : '手動產生一批正式下注';

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
                <span style={styles.pipelineBadge}>
                  同步：{pipelineStatusText(lastAutoTrainResult, 'sync')}
                </span>
                <span style={styles.pipelineBadge}>
                  補抓：{pipelineStatusText(lastAutoTrainResult, 'catchup')}
                </span>
                <span style={styles.pipelineBadge}>
                  比對：{pipelineStatusText(lastAutoTrainResult, 'compare_before_create')}
                </span>
                <span style={styles.pipelineBadge}>
                  建立後比對：{pipelineStatusText(lastAutoTrainResult, 'compare_after_create')}
                </span>
              </div>
            </Card>
          </div>
        )}

        {!loading && activeTab === TABS.PREDICT && (
          <div style={styles.sectionStack}>
            <Card
              title="預測控制面板"
              subtitle="先決定你想看幾期、偏好什麼策略、要走哪一種風險風格。"
            >
              <div style={styles.predictControlStack}>
                <div style={styles.selectorBlock}>
                  <div style={styles.selectorTitle}>分析期數</div>
                  <div style={styles.selectorDesc}>
                    選擇較少期數可觀察近期變動，較多期數可看長一點的分布。
                  </div>
                  <div style={styles.selectorRow}>
                    {ANALYSIS_PERIOD_OPTIONS.map((period) => (
                      <SelectorButton
                        key={period}
                        active={analysisPeriod === period}
                        onClick={() => setAnalysisPeriod(period)}
                      >
                        {period} 期
                      </SelectorButton>
                    ))}
                  </div>
                </div>

                <div style={styles.selectorBlock}>
                  <div style={styles.selectorTitle}>策略模式</div>
                  <div style={styles.selectorDesc}>
                    先做前端操作面板，這一版先不改後端 API 計算邏輯。
                  </div>
                  <div style={styles.selectorGrid}>
                    {STRATEGY_MODE_OPTIONS.map((item) => (
                      <SelectorCard
                        key={item.key}
                        active={strategyMode === item.key}
                        onClick={() => setStrategyMode(item.key)}
                        title={item.label}
                        desc={item.desc}
                      />
                    ))}
                  </div>
                </div>

                <div style={styles.selectorBlock}>
                  <div style={styles.selectorTitle}>下注風格</div>
                  <div style={styles.selectorDesc}>
                    對應目前四組分工：保守、平衡、進攻、衝高。
                  </div>
                  <div style={styles.selectorGrid}>
                    {RISK_MODE_OPTIONS.map((item) => (
                      <SelectorCard
                        key={item.key}
                        active={riskMode === item.key}
                        onClick={() => setRiskMode(item.key)}
                        title={item.label}
                        desc={item.desc}
                      />
                    ))}
                  </div>
                </div>

                <div style={styles.selectionSummaryBox}>
                  <div style={styles.selectionSummaryTitle}>目前選擇摘要</div>
                  <div style={styles.metaChipRow}>
                    <MetaChip label="分析期數" value={`${analysisPeriod} 期`} />
                    <MetaChip label="策略模式" value={getStrategyModeLabel(strategyMode)} />
                    <MetaChip label="下注風格" value={getRiskModeLabel(riskMode)} />
                    <MetaChip label="最新期數" value={fmtText(latestDrawNo)} />
                  </div>
                </div>
              </div>
            </Card>

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
                  valueStyle={{
                    color: formalRemainingBatchCount > 0 ? '#0f766e' : '#b45309'
                  }}
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
                  目前邏輯：只要偵測到新的可下注 source_draw_no，formal 批次會自動歸零；同一個 source_draw_no 最多三批。
                </div>
                <button
                  style={{
                    ...styles.primaryButton,
                    ...((!canFormalBet || formalRemainingBatchCount <= 0)
                      ? styles.warningButton
                      : {})
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
              right={
                <div style={styles.predictTopTag}>
                  顯示偏好：{getStrategyModeLabel(strategyMode)} / {getRiskModeLabel(riskMode)}
                </div>
              }
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
                <MetaChip
                  label="source_draw_no"
                  value={fmtText(predictionSummary.formalSourceDrawNo)}
                />
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
  title="現在可下注號碼"
  subtitle="優先顯示即戰候選（instant_formal），沒有才退回最近 formal。"
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
                  <MetaChip
                    label="source_draw_no"
                    value={fmtText(formalLatest?.source_draw_no)}
                  />
                  <MetaChip
                    label="target_periods"
                    value={fmtText(formalLatest?.target_periods)}
                  />
                  <MetaChip label="建立時間" value={fmtDateTime(formalLatest?.created_at)} />
                </div>
              </div>
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
                  value={`${analysisPeriod} 期`}
                  hint="可從預測下注面板切換"
                />
                <StatBox
                  label="策略模式"
                  value={getStrategyModeLabel(strategyMode)}
                  hint="目前只影響前端顯示偏好"
                />
                <StatBox
                  label="下注風格"
                  value={getRiskModeLabel(riskMode)}
                  hint="對應保守 / 平衡 / 進攻 / 衝高"
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

              <div style={styles.marketGrid2}>
                <div style={styles.marketPanel}>
                  <div style={styles.marketPanelTitle}>近期熱號（依目前分析期數）</div>
                  <div style={styles.marketBallsWrap}>
                    {hotNumbers.length ? (
                      hotNumbers.map((item) => (
                        <div key={item.num} style={styles.hotBallWrap}>
                          <MarketBall n={item.num} />
                          <div style={styles.hotBallCount}>{item.count}</div>
                        </div>
                      ))
                    ) : (
                      <div style={styles.emptyBox}>目前沒有熱號資料。</div>
                    )}
                  </div>
                </div>

                <div style={styles.marketPanel}>
                  <div style={styles.marketPanelTitle}>連莊號</div>
                  <div style={styles.marketBallsWrap}>
                    {streakNumbers.length ? (
                      streakNumbers.map((item) => (
                        <StreakBall key={item.num} n={item.num} streak={item.streak} />
                      ))
                    ) : (
                      <div style={styles.emptyBox}>目前沒有連莊號。</div>
                    )}
                  </div>
                </div>
              </div>

              <div style={styles.marketPanel}>
                <div style={styles.marketPanelTitle}>分區分布</div>
                <div style={styles.zoneGrid}>
                  {zoneCounts.map((zone) => (
                    <div key={zone.label} style={styles.zoneBox}>
                      <div style={styles.zoneLabel}>{zone.label}</div>
                      <div style={styles.zoneCount}>{zone.count}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={styles.marketPanel}>
                <div style={styles.marketPanelTitle}>近期資料列</div>
                <div style={styles.historyRows}>
                  {recentRowsByPeriod.length ? (
                    recentRowsByPeriod.map((row, idx) => {
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

              <div style={styles.marketPanel}>
                <div style={styles.marketPanelTitle}>排行榜摘要</div>
                <div style={styles.groupGrid}>
                  {leaderboard.length ? (
                    leaderboard.slice(0, 6).map((row, idx) => (
                      <div key={`${row?.strategy_key || idx}`} style={styles.groupCard}>
                        <div style={styles.groupTitle}>
                          第 {idx + 1} 名｜{fmtText(row?.strategy_key)}
                        </div>
                        <div style={styles.metaChipRow}>
                          <MetaChip
                            label="avg_hit"
                            value={
                              Number.isFinite(Number(row?.avg_hit))
                                ? Number(row.avg_hit).toFixed(2)
                                : '--'
                            }
                          />
                          <MetaChip
                            label="recent_50_roi"
                            value={fmtPercent(row?.recent_50_roi)}
                          />
                          <MetaChip label="rounds" value={fmtText(row?.total_rounds)} />
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={styles.emptyBox}>目前沒有 leaderboard 資料。</div>
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
    padding: 24,
    color: '#23413a',
    boxSizing: 'border-box'
  },
  app: {
    maxWidth: 1400,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 20
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    padding: '8px 4px 0'
  },
  brand: {
    fontSize: 38,
    fontWeight: 900,
    color: '#0f766e',
    letterSpacing: '0.5px'
  },
  headerSub: {
    marginTop: 6,
    color: '#7b6e5c',
    fontSize: 15
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 12
  },
  tabBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 12
  },
  tabButton: {
    border: '2px solid #2e4b44',
    background: '#f7f1e7',
    color: '#23413a',
    borderRadius: 18,
    padding: '18px 16px',
    fontSize: 28,
    fontWeight: 800,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    transition: 'all .15s ease'
  },
  tabButtonActive: {
    background: '#0f766e',
    color: '#fff',
    borderColor: '#0f766e'
  },
  tabIcon: {
    fontSize: 24
  },
  sectionStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20
  },
  card: {
    background: '#efe8db',
    border: '2px solid #d8c7ad',
    borderRadius: 24,
    padding: 20,
    boxShadow: '0 2px 0 rgba(124, 90, 34, 0.04)'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 16,
    marginBottom: 18
  },
  cardTitle: {
    fontSize: 24,
    fontWeight: 900,
    color: '#0f766e'
  },
  cardSubtitle: {
    marginTop: 6,
    color: '#7b6e5c',
    fontSize: 14,
    lineHeight: 1.6
  },
  statsGrid4: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: 16
  },
  statBox: {
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 16,
    minHeight: 120,
    boxSizing: 'border-box'
  },
  statLabel: {
    fontSize: 14,
    color: '#7b6e5c',
    marginBottom: 10
  },
  statValue: {
    fontSize: 22,
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
    fontSize: 18,
    fontWeight: 800,
    color: '#0f766e',
    marginBottom: 10
  },
  resultText: {
    color: '#23413a',
    fontSize: 15,
    lineHeight: 1.7
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
    fontSize: 18,
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
    marginTop: 14,
    background: '#0f766e',
    color: '#fff',
    border: 'none',
    borderRadius: 16,
    padding: '14px 18px',
    fontSize: 16,
    fontWeight: 800,
    cursor: 'pointer'
  },
  secondaryButton: {
    background: '#f8f1e6',
    color: '#23413a',
    border: '2px solid #d9c7a8',
    borderRadius: 14,
    padding: '12px 16px',
    fontSize: 15,
    fontWeight: 800,
    cursor: 'pointer'
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
    fontSize: 18,
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
    padding: '12px 16px',
    fontSize: 15,
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
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 16
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
    fontSize: 18,
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
    width: 52,
    height: 52,
    borderRadius: '50%',
    background: '#0f766e',
    color: '#fff',
    fontSize: 18,
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
    fontSize: 18,
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
    fontSize: 18,
    fontWeight: 900,
    color: '#0f766e',
    marginBottom: 12
  },
  marketGrid2: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 16
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
  }
};
