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
function normalizePredictionRow(row) {
  if (!row || typeof row !== 'object') return null;

  return {
    ...row,
    source_draw_no: toNum(row?.source_draw_no, 0),
    target_periods: toNum(row?.target_periods, 1),
    hit_count: toNum(row?.hit_count, 0),
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

  return {
    raw: latest,

    trainingRow,
    formalRow,
    formalBatches,

    leaderboard,
    currentTopStrategies,
    marketStreakBuckets,

    summaryLabel,
    summaryText,
    readyForFormal,
    adviceLevel,
    assistantMode,

    formalBatchLimit,
    formalBatchCount,
    formalRemainingBatchCount,
    formalSourceDrawNo
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
    formalBatches: [],
    marketStreakBuckets: {
      streak2: [],
      streak3: [],
      streak4: [],
      lookback: 0,
      latestDrawNo: null
    }
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
        formalBatches: normalizedPrediction.formalBatches,
        marketStreakBuckets: normalizedPrediction.marketStreakBuckets
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

  const strategyStabilityScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        aiPlayer.activeCount * 0.8 +
          Math.min(30, formalBatchCount * 8) +
          Math.max(0, toNum(aiPlayer.topStrategyRecent50Roi, 0) * 100 * 0.6)
      )
    )
  );

  const marketFitScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        toNum(aiPlayer.trainingStrength, 0) * 0.7 +
          (predictionSummary.readyForFormal ? 18 : 0) +
          (aiPlayer.decisionPhase === 'good' ? 10 : 0)
      )
    )
  );

  const decisionTitle = canFormalBet ? '可小試' : '暫不建議正式下注';
  const decisionColor = canFormalBet ? '#0f766e' : '#b45309';
  const decisionSubtitle = predictionSummary.summaryText || aiPlayer.statusText || '先觀察再行動。';

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
              <div style={styles.statsGrid2}>
                <StatBox
                  label="策略穩定度"
                  value={`${strategyStabilityScore} / 100`}
                  hint={`活躍策略 ${aiPlayer.activeCount} / 策略池 ${aiPlayer.totalPoolCount}`}
                  valueStyle={{ color: '#0f766e' }}
                />
                <StatBox
                  label="市場適應度"
                  value={`${marketFitScore} / 100`}
                  hint={`最新期數 ${fmtText(latestDrawNo)} / ${fmtText(latestDrawTime)}`}
                  valueStyle={{ color: decisionColor }}
                />
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
                  <MetaChip label="自動訓練" value={autoTrainEnabled ? '運行中' : '停止'} />
                </div>
              </div>

              <div style={styles.predictControlStack}>
                <div style={styles.selectorBlock}>
                  <div style={styles.selectorTitle}>分析期數</div>
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
              </div>
            </Card>

            <Card
              title="正式下注"
              subtitle="用現在選定的條件建立正式下注；下方會累積顯示同一期最多三批，共十二組。"
              right={
                <div style={styles.metaChipRow}>
                  <MetaChip label="每組" value={fmtMoney(COST_PER_GROUP)} />
                  <MetaChip label="剩餘批次" value={formalRemainingBatchCount} />
                </div>
              }
            >
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
                  條件：{analysisPeriod}期｜{getStrategyModeLabel(strategyMode)}｜{getRiskModeLabel(riskMode)}
                </div>
              </div>

              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {formalBatches.length ? (
                  formalBatches.map((batch, idx) => (
                    <FormalBatchCard key={batch?.id || idx} batch={batch} idx={idx} />
                  ))
                ) : formalDisplayGroups.length ? (
                  <div style={styles.groupGrid}>
                    {formalDisplayGroups.slice(0, 4).map((group, idx) => (
                      <CompactBetCard
                        key={`${group?.key || idx}_${idx}`}
                        group={group}
                        idx={idx}
                      />
                    ))}
                  </div>
                ) : (
                  <div style={styles.emptyBox}>尚未產生正式下注四組，先按上方按鈕建立一批。</div>
                )}
              </div>
            </Card>
          </div>
        )}

        {!loading && activeTab === TABS.PREDICT && (

          <div style={styles.sectionStack}>
            <Card
              title="預測控制面板"
              subtitle="這一頁只保留條件設定；正式下注按鈕與正式下注四組已移到第一頁。"
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
                    目前先作為前端操作條件，會同步帶到第一頁正式下注。
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

                <div style={styles.predictOnlyHint}>
                  第二頁現在只負責設定條件。
                  正式下注按鈕、正式下注四組、批次狀態與下注建議，都已集中到第一頁顯示。
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
                <div style={styles.marketPanelTitle}>近期連續號碼（連2／連3／連4）</div>
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
    fontSize: 32,
    fontWeight: 900,
    color: '#0f766e',
    letterSpacing: '0.5px'
  },
  headerSub: {
    marginTop: 6,
    color: '#7b6e5c',
    fontSize: 14
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 10
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
    padding: '14px 12px',
    fontSize: 22,
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
    fontSize: 20
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
    padding: 18,
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
    fontSize: 21,
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
  statsGrid2: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 16
  },
  statBox: {
    background: '#f8f1e6',
    border: '2px solid #d9c7a8',
    borderRadius: 18,
    padding: 14,
    minHeight: 108,
    boxSizing: 'border-box'
  },
  statLabel: {
    fontSize: 14,
    color: '#7b6e5c',
    marginBottom: 10
  },
  statValue: {
    fontSize: 18,
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
    marginTop: 14,
    background: '#0f766e',
    color: '#fff',
    border: 'none',
    borderRadius: 16,
    padding: '10px 14px',
    fontSize: 14,
    fontWeight: 800,
    cursor: 'pointer'
  },
  secondaryButton: {
    background: '#f8f1e6',
    color: '#23413a',
    border: '2px solid #d9c7a8',
    borderRadius: 14,
    padding: '10px 14px',
    fontSize: 14,
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
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 16
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
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 12
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
