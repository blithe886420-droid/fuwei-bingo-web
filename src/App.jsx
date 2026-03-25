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

// 🔒 正式下注固定設定
const FORMAL_FIXED_GROUP_COUNT = 4;
const FORMAL_FIXED_TARGET_PERIODS = 4;
const FORMAL_FIXED_BET_PER_GROUP = 25;
const FORMAL_FIXED_TOTAL_PER_PERIOD =
  FORMAL_FIXED_GROUP_COUNT * FORMAL_FIXED_BET_PER_GROUP;
const FORMAL_FIXED_TOTAL_ALL_PERIODS =
  FORMAL_FIXED_TOTAL_PER_PERIOD * FORMAL_FIXED_TARGET_PERIODS;

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmtPercent(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${n.toFixed(digits)}%`;
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

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${n} 元`;
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

function getRecentRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.recent20)) return data.recent20;
  if (Array.isArray(data?.data)) return data.data;
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

      // 🔒 正式下注前端固定顯示，不再使用倍率配重語意
      const isFormalGroup =
        String(meta?.profit_mode || '').toLowerCase().includes('profit_mode') ||
        String(group?.reason || '').includes('正式下注') ||
        String(group?.key || '').startsWith('formal_') ||
        String(meta?.strategy_key || '').startsWith('formal_') ||
        String(meta?.selection_rank || '').length > 0;

      const weight = isFormalGroup
        ? 1
        : Number.isFinite(Number(group?.weight))
          ? Number(group.weight)
          : Number.isFinite(Number(meta?.weight_multiplier))
            ? Number(meta.weight_multiplier)
            : Number.isFinite(Number(meta?.bet_multiplier))
              ? Number(meta.bet_multiplier)
              : null;

      const betAmount = isFormalGroup
        ? FORMAL_FIXED_BET_PER_GROUP
        : Number.isFinite(Number(group?.bet_amount))
          ? Number(group.bet_amount)
          : Number.isFinite(Number(meta?.bet_amount))
            ? Number(meta.bet_amount)
            : null;

      const betWeight = isFormalGroup
        ? 2500
        : Number.isFinite(Number(group?.bet_weight))
          ? Number(group.bet_weight)
          : Number.isFinite(Number(meta?.bet_weight))
            ? Number(meta.bet_weight)
            : null;

      return {
        key: String(group?.key || meta?.strategy_key || `group_${idx + 1}`),
        label: String(group?.label || meta?.strategy_name || `第${idx + 1}組`),
        nums,
        reason: String(group?.reason || meta?.strategy_name || '--'),
        weight,
        bet_amount: betAmount,
        bet_weight: betWeight,
        meta
      };
    })
    .filter(Boolean);
}

function getPredictionGroups(row) {
  return normalizeGroups(
    row?.groups_json ||
      row?.groups ||
      row?.strategies ||
      row?.prediction_groups ||
      []
  );
}

function groupTitle(group, idx) {
  return (
    group?.label ||
    group?.name ||
    group?.strategy_name ||
    group?.key ||
    `第${idx + 1}組`
  );
}

function groupReason(group, latestMode = '') {
  const mode = String(latestMode || '').toLowerCase();

  if (mode === 'formal') {
    return (
      group?.reason ||
      '固定四組四期正式下注（每組 25 元，不使用倍率配重）'
    );
  }

  return group?.reason || group?.meta?.strategy_name || group?.meta?.strategy_key || '--';
}

function fmtMetaNumber(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return n.toFixed(digits);
}

async function safeFetchJson(url, options) {
  const res = await fetch(url, options);
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
    text.includes('unique_draw_mode') ||
    text.includes('already exists') ||
    text.includes('prediction already exists')
  );
}

function normalizeAutoTrainResult(payload, status) {
  const result = payload && typeof payload === 'object' ? payload : {};

  const train = result?.train && typeof result.train === 'object' ? result.train : null;
  const topError =
    result?.error ||
    result?.message ||
    train?.error ||
    '';

  if (train?.skipped) {
    return {
      ok: true,
      skipped: true,
      reason: train?.reason || 'already_exists',
      existing: train?.existing || null,
      pipeline: result?.pipeline || null,
      raw: result
    };
  }

  if (isDuplicateOrAlreadyExistsMessage(topError)) {
    return {
      ok: true,
      skipped: true,
      reason: 'Prediction already exists for current draw and mode',
      existing: train?.existing || null,
      pipeline: result?.pipeline || null,
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

function calcSimpleAiStatus(trainingPrediction, leaderboard) {
  const lb = toArray(leaderboard);
  const active = lb.length;

  const roiValues = lb
    .map((x) => Number(x?.recent_50_roi ?? x?.roi))
    .filter(Number.isFinite);

  const avgHitValues = lb
    .map((x) => Number(x?.avg_hit))
    .filter(Number.isFinite);

  const topScore = Number(lb?.[0]?.score);
  const avgRoi = roiValues.length
    ? roiValues.reduce((a, b) => a + b, 0) / roiValues.length
    : null;
  const avgHit = avgHitValues.length
    ? avgHitValues.reduce((a, b) => a + b, 0) / avgHitValues.length
    : null;

  let confidence = 50;

  if (Number.isFinite(avgRoi)) {
    if (avgRoi >= 10) confidence += 20;
    else if (avgRoi >= 0) confidence += 10;
    else if (avgRoi <= -20) confidence -= 15;
    else if (avgRoi < 0) confidence -= 8;
  }

  if (Number.isFinite(avgHit)) {
    if (avgHit >= 2) confidence += 18;
    else if (avgHit >= 1.5) confidence += 10;
    else if (avgHit < 1) confidence -= 10;
  }

  if (active >= 10) confidence += 5;
  if (Number.isFinite(topScore) && topScore > 0) confidence += 5;

  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  let advice = '觀望';
  let adviceColor = '#b45309';

  if (confidence >= 70) {
    advice = '可下注';
    adviceColor = '#0f766e';
  } else if (confidence <= 40) {
    advice = '先觀望';
    adviceColor = '#c2410c';
  }

  return {
    confidence,
    advice,
    adviceColor,
    activeStrategies: active,
    avgRoi,
    avgHit,
    latestTrainingMode: trainingPrediction?.mode || '--'
  };
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

function normalizeAiEvolution(data) {
  return {
    statusArrow: data?.statusArrow || '→',
    statusLabel: data?.statusLabel || '探索中',
    statusText: data?.statusText || 'AI 正在測試新策略。',
    statusColor: data?.statusColor || '#2563eb',
    trainingStrength: Math.max(0, Math.min(100, toNum(data?.trainingStrength, 0))),
    comparedLastHour: toNum(data?.comparedLastHour, 0),
    createdLastHour: toNum(data?.createdLastHour, 0),
    retiredLastHour: toNum(data?.retiredLastHour, 0),
    activeCount: toNum(data?.activeCount, 0)
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
  if (item.ok === false) {
    if (item.status === 401) return '401';
    return '失敗';
  }

  return '未執行';
}

function buildLastCycleSummary(result) {
  if (!result) {
    if (isNightStopWindow()) return '夜間停訓中';
    return '--';
  }

  if (result?.skipped || result?.train?.skipped) {
    const existingDrawNo =
      result?.existing?.source_draw_no ||
      result?.train?.existing?.source_draw_no ||
      '--';

    return `本期已存在，略過建立（來源期數 ${existingDrawNo}）`;
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

  const activeCreated =
    result?.active_created_prediction ||
    result?.train?.existing ||
    result?.train?.inserted ||
    null;

  if (compared > 0 || created > 0) {
    const sourceText = fmtText(activeCreated?.source_draw_no, '--');
    return `本輪：比對 ${compared} 筆 / 新建 ${created} 筆 / 來源期數 ${sourceText}`;
  }

  if (activeCreated?.source_draw_no) {
    return `目前掛單訓練來源 ${activeCreated.source_draw_no}`;
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
  const [autoTrainEnabled, setAutoTrainEnabled] = useState(false);
  const [lastAutoTrainResult, setLastAutoTrainResult] = useState(null);
  const [aiEvolution, setAiEvolution] = useState(normalizeAiEvolution({}));

  const mountedRef = useRef(false);
  const schedulerRef = useRef(null);
  const cycleRunningRef = useRef(false);
  const sessionStartedRef = useRef(false);
  const nightPauseTimerRef = useRef(null);

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

      const trainingRow =
        predictionRes?.training_row ||
        getPredictionLatestRow(predictionRes?.test || predictionRes?.training || predictionRes, 'test') ||
        getPredictionLatestRow(predictionRes?.row ? { row: predictionRes.row } : predictionRes, 'test');

      const formalRow =
        predictionRes?.formal_row ||
        getPredictionLatestRow(predictionRes?.formal || predictionRes, 'formal') ||
        null;

      setTrainingLatest(trainingRow || null);
      setFormalLatest(formalRow || null);

      const lb =
        predictionRes?.leaderboard ||
        predictionRes?.auto_train_result?.leaderboard ||
        predictionRes?.test?.leaderboard ||
        [];

      setLeaderboard(toArray(lb));
      setLastAutoTrainResult(predictionRes?.auto_train_result || null);
      setAiEvolution(normalizeAiEvolution(aiPlayerRes));
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

  const buildLoopStatusText = useCallback((result) => {
    if (!result) {
      if (isNightStopWindow()) return '夜間停訓中（00:00～07:30 不訓練）';
      return '待命中';
    }

    if (result?.skipped || result?.train?.skipped) {
      const existingDrawNo =
        result?.existing?.source_draw_no ||
        result?.train?.existing?.source_draw_no ||
        '--';

      return `本期已存在（正常略過），目前訓練來源期數 ${existingDrawNo}`;
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

    const activeCreated =
      result?.active_created_prediction ||
      result?.train?.existing ||
      result?.train?.inserted ||
      null;

    if (compared > 0 || created > 0) {
      return `本輪完成（本輪結果）：比對 ${compared} 筆 / 新建 ${created} 筆 / 目前訓練來源期數 ${fmtText(activeCreated?.source_draw_no, '--')}`;
    }

    if (activeCreated?.source_draw_no) {
      return `等待中：尚未收齊第 ${toNum(activeCreated.source_draw_no, 0) + 1} 到第 ${toNum(activeCreated.source_draw_no, 0) + toNum(activeCreated.target_periods, 2)} 期開獎資料（目前訓練來源期數 ${activeCreated.source_draw_no}）`;
    }

    return '待命中';
  }, []);

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

      setLoopStatusText('自動訓練中...');

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
  }, [buildLoopStatusText, loadAll]);

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
          setLoopStatusText('AI 循環啟動');
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

  const handleFormalBet = async () => {
    await runAction('formalBet', async () => {
      await safeFetchJson('/api/prediction-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'formal'
        })
      });
    });
  };

  const aiStatus = useMemo(
    () => calcSimpleAiStatus(trainingLatest, leaderboard),
    [trainingLatest, leaderboard]
  );

  const latestDraw = recent20[0] || null;
  const latestDrawNo = latestDraw?.draw_no || latestDraw?.drawNo || '--';
  const latestDrawTime = latestDraw?.draw_time || latestDraw?.drawTime || '--';
  const latestNumbers = parseNums(latestDraw?.numbers || latestDraw?.nums || []);

  const trainingGroups = getPredictionGroups(trainingLatest);
  const formalGroups = getPredictionGroups(formalLatest);

  // 🔒 正式下注前端固定統計，不吃後端倍率金額
  const formalTotalPerPeriod = useMemo(() => {
    if (!formalGroups.length) return 0;
    return FORMAL_FIXED_TOTAL_PER_PERIOD;
  }, [formalGroups]);

  const formalTargetPeriods = useMemo(() => {
    if (!formalGroups.length) return toNum(formalLatest?.target_periods, 0);
    return FORMAL_FIXED_TARGET_PERIODS;
  }, [formalGroups, formalLatest]);

  const formalTotalAllPeriods = useMemo(() => {
    if (!formalGroups.length) return 0;
    return FORMAL_FIXED_TOTAL_ALL_PERIODS;
  }, [formalGroups]);

  const lastCycleSummary = useMemo(
    () => buildLastCycleSummary(lastAutoTrainResult),
    [lastAutoTrainResult]
  );

  return (
    <div style={styles.page}>
      <div style={styles.app}>
        <header style={styles.header}>
          <div>
            <div style={styles.brand}>FUWEI BINGO AI</div>
            <div style={styles.headerSub}>淺黃台彩風，舒服一點，也看得久一點。</div>
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
              title="AI 狀態總覽"
              subtitle="先看 AI 狀態，再決定要不要正式下注。"
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="AI 信心指數"
                  value={`${aiStatus.confidence} / 100`}
                  hint={`模式：${aiStatus.latestTrainingMode}`}
                  valueStyle={{ color: aiStatus.adviceColor }}
                />
                <StatBox
                  label="平均 ROI"
                  value={fmtPercent(aiStatus.avgRoi)}
                  hint="來自目前策略池"
                />
                <StatBox
                  label="平均命中"
                  value={
                    Number.isFinite(aiStatus.avgHit)
                      ? aiStatus.avgHit.toFixed(2)
                      : '--'
                  }
                  hint="策略池平均"
                />
                <StatBox
                  label="建議狀態"
                  value={aiStatus.advice}
                  hint={`活躍策略：${aiStatus.activeStrategies}`}
                  valueStyle={{ color: aiStatus.adviceColor }}
                />
              </div>

              <div style={styles.resultPanel}>
                <div style={styles.resultTitle}>AI 循環狀態</div>
                <div style={styles.resultText}>{loopStatusText}</div>
                <div style={{ ...styles.resultText, marginTop: 8, color: '#8a7d66' }}>
                  最近一輪摘要：{lastCycleSummary}
                </div>

                <div style={styles.pipelineRow}>
                  <span style={styles.pipelineBadge}>同步：{pipelineStatusText(lastAutoTrainResult, 'sync')}</span>
                  <span style={styles.pipelineBadge}>補抓：{pipelineStatusText(lastAutoTrainResult, 'catchup')}</span>
                  <span style={styles.pipelineBadge}>比對：{pipelineStatusText(lastAutoTrainResult, 'compare')}</span>
                </div>
              </div>

              <div style={styles.resultPanel}>
                <div style={styles.resultTitle}>AI 進化速度</div>
                <div
                  style={{
                    ...styles.evolutionHeadline,
                    color: aiEvolution.statusColor
                  }}
                >
                  {aiEvolution.statusArrow} {aiEvolution.statusLabel}
                </div>

                <div style={styles.evolutionBarBg}>
                  <div
                    style={{
                      ...styles.evolutionBarFill,
                      width: `${aiEvolution.trainingStrength}%`,
                      background: aiEvolution.statusColor
                    }}
                  />
                </div>

                <div style={styles.evolutionStrengthText}>
                  訓練強度 {aiEvolution.trainingStrength}%
                </div>

                <div style={{ ...styles.resultText, marginTop: 8 }}>
                  {aiEvolution.statusText}
                </div>

                <div style={styles.evolutionMiniGrid}>
                  <div style={styles.evolutionMiniBox}>
                    <div style={styles.evolutionMiniLabel}>本小時 Compare 累計</div>
                    <div style={styles.evolutionMiniValue}>{aiEvolution.comparedLastHour}</div>
                  </div>
                  <div style={styles.evolutionMiniBox}>
                    <div style={styles.evolutionMiniLabel}>本小時 Create 累計</div>
                    <div style={styles.evolutionMiniValue}>{aiEvolution.createdLastHour}</div>
                  </div>
                  <div style={styles.evolutionMiniBox}>
                    <div style={styles.evolutionMiniLabel}>本小時淘汰累計</div>
                    <div style={styles.evolutionMiniValue}>{aiEvolution.retiredLastHour}</div>
                  </div>
                </div>
              </div>
            </Card>

            <Card
              title="系統控制"
              subtitle="保留你平常真的會用到的控制項。"
            >
              <div style={styles.controlGrid}>
                <div style={styles.controlItem}>
                  <div style={styles.controlTitle}>自動訓練</div>
                  <div style={styles.controlText}>
                    目前狀態：
                    <span
                      style={{
                        color: autoTrainEnabled ? '#0f766e' : '#dc2626',
                        fontWeight: 800,
                        marginLeft: 6
                      }}
                    >
                      {autoTrainEnabled ? '開啟中' : '已關閉'}
                    </span>
                  </div>
                  <div style={styles.controlHint}>
                    打開網頁一律不自動訓練；只有你手動按下開關後，才會開始循環。夜間 00:00～07:30 自動停訓。循環頻率：每 180 秒。
                  </div>
                  <button
                    style={autoTrainEnabled ? styles.warnButton : styles.primaryButton}
                    onClick={handleToggleAutoTrain}
                    disabled={busyKey !== ''}
                  >
                    {busyKey === 'toggleAutoTrain'
                      ? '切換中...'
                      : autoTrainEnabled
                        ? '停止自動訓練'
                        : '開啟自動訓練'}
                  </button>
                </div>

                <div style={styles.controlItem}>
                  <div style={styles.controlTitle}>資料同步</div>
                  <div style={styles.controlText}>同步最新開獎與補抓遺漏期數。</div>
                  <div style={styles.inlineButtons}>
                    <button
                      style={styles.secondaryButton}
                      onClick={handleSync}
                      disabled={busyKey !== ''}
                    >
                      {busyKey === 'sync' ? '同步中...' : '同步最新期數'}
                    </button>
                    <button
                      style={styles.secondaryButton}
                      onClick={handleCatchup}
                      disabled={busyKey !== ''}
                    >
                      {busyKey === 'catchup' ? '補抓中...' : '補抓期數'}
                    </button>
                  </div>
                </div>
              </div>
            </Card>

            <Card
              title="訓練摘要"
              subtitle="顯示目前最近一輪自動訓練資料。"
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="最新訓練期數"
                  value={fmtText(trainingLatest?.source_draw_no)}
                  hint={`目標：${fmtText(trainingLatest?.target_periods)} 期`}
                />
                <StatBox
                  label="最佳策略分數"
                  value={fmtText(
                    leaderboard?.[0]?.score
                      ? Number(leaderboard[0].score).toFixed(1)
                      : '--'
                  )}
                  hint={leaderboard?.[0]?.label || '尚無資料'}
                />
                <StatBox
                  label="最佳策略 ROI"
                  value={fmtPercent(leaderboard?.[0]?.recent_50_roi ?? leaderboard?.[0]?.roi)}
                  hint="取排行榜第一名"
                />
                <StatBox
                  label="最新開獎期數"
                  value={fmtText(latestDrawNo)}
                  hint={fmtDateTime(latestDrawTime)}
                />
              </div>
            </Card>
          </div>
        )}

        {!loading && activeTab === TABS.PREDICT && (
          <div style={styles.sectionStack}>
            <Card
              title="正式下注"
              subtitle="正式下注的建立與重建，都集中在這一頁。"
              right={<div style={styles.tag}>四星賓果 / 四組 / 四期</div>}
            >
              <div style={styles.summaryLine}>
                <span>模式：</span>
                <strong>{fmtText(formalLatest?.mode, 'formal')}</strong>
                <span style={{ marginLeft: 16 }}>來源期數：</span>
                <strong>{fmtText(formalLatest?.source_draw_no)}</strong>
                <span style={{ marginLeft: 16 }}>目標期數：</span>
                <strong>{formalGroups.length ? FORMAL_FIXED_TARGET_PERIODS : fmtText(formalLatest?.target_periods)}</strong>
              </div>

              <div style={styles.infoBannerStrong}>
                <div style={styles.infoBannerTitle}>正式下注＝固定四組四期模式</div>
                <div>
                  建立邏輯：先從 strategy_stats 挑出較強策略，再建立
                  <strong> 固定四組、固定四期、每組 25 元 </strong>
                  的正式下注。正式下注現在只負責
                  <strong> 選策略與產號 </strong>
                  ，不再使用倍率加碼或權重放大，避免總投入偏離固定成本框架。
                </div>
              </div>

              <div style={styles.statsGrid4}>
                <StatBox
                  label="每期總投入"
                  value={fmtMoney(formalTotalPerPeriod)}
                  hint="固定四組合計 100 元"
                />
                <StatBox
                  label="本輪總投入"
                  value={fmtMoney(formalTotalAllPeriods)}
                  hint={`固定 ${FORMAL_FIXED_TARGET_PERIODS} 期，共 400 元`}
                />
                <StatBox
                  label="組數"
                  value={formalGroups.length || 0}
                  hint="正式下注組數"
                />
                <StatBox
                  label="每組固定"
                  value={fmtMoney(formalGroups.length ? FORMAL_FIXED_BET_PER_GROUP : '--')}
                  hint="不使用倍率配重"
                />
              </div>

              <div style={styles.actionRow}>
                <button
                  style={styles.primaryButton}
                  onClick={handleFormalBet}
                  disabled={busyKey !== ''}
                >
                  {busyKey === 'formalBet'
                    ? '建立中...'
                    : formalGroups.length
                      ? '重新建立正式下注'
                      : '建立正式下注'}
                </button>
              </div>

              <div style={styles.groupGrid}>
                {formalGroups.length ? (
                  formalGroups.map((group, idx) => (
                    <div key={`${group?.key || idx}`} style={styles.groupCard}>
                      <div style={styles.groupHead}>
                        <div>
                          <div style={styles.groupTitle}>{groupTitle(group, idx)}</div>
                          <div style={styles.groupMeta}>
                            {fmtText(group?.meta?.strategy_key || group?.key)}
                          </div>
                        </div>
                        <div style={styles.modeBadge}>
                          {fmtText(group?.meta?.profit_mode, 'formal')}
                        </div>
                      </div>

                      <div style={styles.ballRow}>
                        {parseNums(group?.nums).map((n) => (
                          <div key={n} style={styles.ballLarge}>
                            {String(n).padStart(2, '0')}
                          </div>
                        ))}
                      </div>

                      <div style={styles.groupReason}>
                        {groupReason(group, 'formal')}
                      </div>

                      <div style={styles.betRowSingle}>
                        <div style={styles.betBox}>
                          <div style={styles.betLabel}>單組金額</div>
                          <div style={styles.betValue}>{fmtMoney(FORMAL_FIXED_BET_PER_GROUP)}</div>
                        </div>
                      </div>

                      <div style={styles.metaChipRow}>
                        <MetaChip label="score" value={fmtMetaNumber(group?.meta?.score, 1)} />
                        <MetaChip label="avg_hit" value={fmtMetaNumber(group?.meta?.avg_hit, 2)} />
                        <MetaChip label="roi" value={fmtPercent(group?.meta?.roi)} />
                        <MetaChip label="rounds" value={fmtText(group?.meta?.total_rounds)} />
                        <MetaChip label="filter" value={fmtText(group?.meta?.filter_pass)} />
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={styles.emptyBox}>目前還沒有正式下注資料。</div>
                )}
              </div>
            </Card>

            <Card
              title="AI 自動訓練"
              subtitle="這塊顯示目前最近一輪自動訓練資料。"
              right={<div style={styles.tag}>四星賓果 / 四組 / 二期</div>}
            >
              <div style={styles.summaryLine}>
                <span>模式：</span>
                <strong>{fmtText(trainingLatest?.mode, 'test')}</strong>
                <span style={{ marginLeft: 16 }}>來源期數：</span>
                <strong>{fmtText(trainingLatest?.source_draw_no)}</strong>
                <span style={{ marginLeft: 16 }}>目標期數：</span>
                <strong>{fmtText(trainingLatest?.target_periods)}</strong>
              </div>

              <div style={styles.groupGrid}>
                {trainingGroups.length ? (
                  trainingGroups.map((group, idx) => (
                    <div key={`${group?.key || idx}`} style={styles.groupCard}>
                      <div style={styles.groupHead}>
                        <div style={styles.groupTitle}>{groupTitle(group, idx)}</div>
                        <div style={styles.groupMeta}>
                          {fmtText(group?.meta?.strategy_key || group?.key)}
                        </div>
                      </div>
                      <div style={styles.ballRow}>
                        {parseNums(group?.nums).map((n) => (
                          <div key={n} style={styles.ballLarge}>
                            {String(n).padStart(2, '0')}
                          </div>
                        ))}
                      </div>
                      <div style={styles.groupReason}>{groupReason(group, 'test')}</div>
                    </div>
                  ))
                ) : (
                  <div style={styles.emptyBox}>目前還沒有自動訓練資料。</div>
                )}
              </div>
            </Card>

            <Card
              title="策略排行榜（精簡版）"
              subtitle="先看前 10 名就夠，不要每次都被 50 個策略轟炸。"
            >
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>排名</th>
                      <th style={styles.th}>策略</th>
                      <th style={styles.th}>平均命中</th>
                      <th style={styles.th}>ROI</th>
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
              title="最新開獎"
              subtitle="市場資料和 AI 頁分開後，資訊會清爽很多。"
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="最新期數"
                  value={fmtText(latestDrawNo)}
                  hint={fmtDateTime(latestDrawTime)}
                />
                <StatBox
                  label="開出號碼數"
                  value={latestNumbers.length}
                  hint="BINGO 1~80"
                />
                <StatBox
                  label="奇數數量"
                  value={latestNumbers.filter((n) => n % 2 === 1).length}
                />
                <StatBox
                  label="偶數數量"
                  value={latestNumbers.filter((n) => n % 2 === 0).length}
                />
              </div>

              <div style={styles.marketBalls}>
                {latestNumbers.map((n) => (
                  <div key={n} style={styles.marketBall}>
                    {String(n).padStart(2, '0')}
                  </div>
                ))}
              </div>
            </Card>

            <Card
              title="最近 20 期"
              subtitle="市場資料頁只放資料，不再把下注和策略摻在一起。"
            >
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>期數</th>
                      <th style={styles.th}>時間</th>
                      <th style={styles.th}>號碼</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent20.length ? (
                      recent20.map((row, idx) => {
                        const nums = parseNums(row?.numbers || row?.nums);
                        return (
                          <tr key={row?.draw_no || row?.drawNo || idx}>
                            <td style={styles.td}>
                              {fmtText(row?.draw_no || row?.drawNo)}
                            </td>
                            <td style={styles.td}>
                              {fmtDateTime(row?.draw_time || row?.drawTime)}
                            </td>
                            <td style={styles.td}>
                              <div style={styles.numsInline}>
                                {nums.map((n) => (
                                  <span key={n} style={styles.numChip}>
                                    {String(n).padStart(2, '0')}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td style={styles.td} colSpan={3}>
                          沒有 recent20 資料。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
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
    background: 'linear-gradient(180deg, #f7f0cb 0%, #f9f5df 48%, #fdfaf0 100%)',
    color: '#4c4332',
    padding: '20px 12px 90px'
  },
  app: {
    maxWidth: 1200,
    margin: '0 auto'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'center',
    marginBottom: 16,
    flexWrap: 'wrap'
  },
  brand: {
    fontSize: 28,
    fontWeight: 900,
    letterSpacing: 0.6,
    color: '#176b5f'
  },
  headerSub: {
    color: '#7b705d',
    marginTop: 6,
    fontSize: 14
  },
  headerActions: {
    display: 'flex',
    gap: 10
  },
  tabBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 10,
    marginBottom: 16,
    position: 'sticky',
    top: 8,
    zIndex: 5,
    background: 'rgba(249,245,223,0.9)',
    padding: 8,
    borderRadius: 18,
    backdropFilter: 'blur(10px)'
  },
  tabButton: {
    border: '1px solid #d8ceb1',
    background: '#fffdf6',
    color: '#5a5345',
    borderRadius: 14,
    padding: '14px 10px',
    fontSize: 15,
    fontWeight: 800,
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(180,160,110,0.08)'
  },
  tabButtonActive: {
    background: '#1c8a73',
    color: '#fffef8',
    borderColor: '#1c8a73',
    boxShadow: '0 10px 24px rgba(28,138,115,0.22)'
  },
  tabIcon: {
    marginRight: 6
  },
  errorBanner: {
    background: '#fff1f2',
    border: '1px solid #fecdd3',
    color: '#9f1239',
    padding: 14,
    borderRadius: 14,
    marginBottom: 16,
    fontWeight: 700
  },
  loading: {
    padding: 30,
    textAlign: 'center',
    color: '#7b705d'
  },
  sectionStack: {
    display: 'grid',
    gap: 16
  },
  card: {
    background: 'rgba(255,250,240,0.88)',
    border: '1px solid #e4d9bd',
    borderRadius: 20,
    padding: 18,
    boxShadow: '0 12px 24px rgba(179,161,111,0.10)'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'flex-start',
    marginBottom: 16,
    flexWrap: 'wrap'
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: 900,
    color: '#176b5f'
  },
  cardSubtitle: {
    fontSize: 14,
    color: '#877b68',
    marginTop: 6
  },
  tag: {
    padding: '8px 12px',
    borderRadius: 999,
    background: '#f4ecd3',
    border: '1px solid #ddd0aa',
    fontSize: 13,
    color: '#5c5344',
    fontWeight: 800
  },
  statsGrid4: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 12,
    marginTop: 14
  },
  statBox: {
    background: '#fffdf8',
    border: '1px solid #e7dcc0',
    borderRadius: 16,
    padding: 16
  },
  statLabel: {
    fontSize: 13,
    color: '#8a7d66',
    marginBottom: 8
  },
  statValue: {
    fontSize: 28,
    fontWeight: 900,
    lineHeight: 1.1,
    color: '#4b4334'
  },
  statHint: {
    marginTop: 8,
    fontSize: 12,
    color: '#9a8e77'
  },
  actionRow: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
    marginTop: 16
  },
  primaryButton: {
    border: 'none',
    borderRadius: 14,
    background: '#1c8a73',
    color: '#fffef8',
    fontWeight: 900,
    padding: '12px 18px',
    cursor: 'pointer',
    boxShadow: '0 8px 18px rgba(28,138,115,0.18)'
  },
  secondaryButton: {
    border: '1px solid #d8ceb1',
    borderRadius: 14,
    background: '#fffdf6',
    color: '#5a5345',
    fontWeight: 800,
    padding: '12px 18px',
    cursor: 'pointer'
  },
  warnButton: {
    border: 'none',
    borderRadius: 14,
    background: '#d97706',
    color: '#fffef8',
    fontWeight: 900,
    padding: '12px 18px',
    cursor: 'pointer'
  },
  controlGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 14
  },
  controlItem: {
    background: '#fffdf8',
    border: '1px solid #e7dcc0',
    borderRadius: 16,
    padding: 16
  },
  controlTitle: {
    fontSize: 17,
    fontWeight: 900,
    marginBottom: 8,
    color: '#176b5f'
  },
  controlText: {
    fontSize: 14,
    color: '#685f50',
    marginBottom: 8
  },
  controlHint: {
    fontSize: 12,
    color: '#8f836d',
    marginBottom: 14,
    lineHeight: 1.6
  },
  inlineButtons: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap'
  },
  resultPanel: {
    marginTop: 16,
    background: '#fffdf8',
    border: '1px solid #e7dcc0',
    borderRadius: 16,
    padding: 16
  },
  resultTitle: {
    fontWeight: 900,
    marginBottom: 8,
    color: '#176b5f'
  },
  resultText: {
    color: '#63594b',
    lineHeight: 1.6
  },
  pipelineRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 12
  },
  pipelineBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 10px',
    borderRadius: 999,
    background: '#f4ecd3',
    border: '1px solid #ddd0aa',
    fontSize: 12,
    color: '#5c5344',
    fontWeight: 800
  },
  evolutionHeadline: {
    fontSize: 30,
    fontWeight: 900,
    lineHeight: 1.2,
    marginBottom: 12
  },
  evolutionBarBg: {
    width: '100%',
    height: 18,
    borderRadius: 999,
    background: '#efe5c9',
    overflow: 'hidden',
    border: '1px solid #dfd3b2'
  },
  evolutionBarFill: {
    height: '100%',
    borderRadius: 999,
    transition: 'width 0.3s ease'
  },
  evolutionStrengthText: {
    marginTop: 10,
    fontSize: 18,
    fontWeight: 900,
    color: '#6d5f36'
  },
  evolutionMiniGrid: {
    marginTop: 14,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 10
  },
  evolutionMiniBox: {
    background: '#fff9ea',
    border: '1px solid #eadfc0',
    borderRadius: 14,
    padding: 12
  },
  evolutionMiniLabel: {
    fontSize: 12,
    color: '#8a7d66'
  },
  evolutionMiniValue: {
    marginTop: 6,
    fontSize: 30,
    fontWeight: 900,
    color: '#4c4332'
  },
  summaryLine: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    alignItems: 'center',
    color: '#6a604f',
    marginBottom: 12
  },
  infoBannerStrong: {
    background: '#fff7df',
    border: '1px solid #e9d59b',
    borderRadius: 16,
    padding: 14,
    color: '#705f34',
    lineHeight: 1.7,
    marginTop: 8
  },
  infoBannerTitle: {
    fontWeight: 900,
    marginBottom: 6,
    color: '#8a5a00'
  },
  groupGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: 14,
    marginTop: 14
  },
  groupCard: {
    background: '#fffdf8',
    border: '1px solid #e7dcc0',
    borderRadius: 16,
    padding: 14
  },
  groupHead: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    alignItems: 'flex-start',
    marginBottom: 10
  },
  groupTitle: {
    fontWeight: 900,
    color: '#176b5f',
    fontSize: 18,
    lineHeight: 1.3
  },
  groupMeta: {
    marginTop: 4,
    fontSize: 12,
    color: '#8f836d'
  },
  modeBadge: {
    padding: '6px 10px',
    borderRadius: 999,
    background: '#f0f9f4',
    border: '1px solid #b6dcc8',
    color: '#176b5f',
    fontWeight: 900,
    fontSize: 12,
    whiteSpace: 'nowrap'
  },
  ballRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 12
  },
  ballLarge: {
    width: 42,
    height: 42,
    borderRadius: '50%',
    background: '#f0b22b',
    color: '#fffef8',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 900,
    fontSize: 18,
    boxShadow: '0 10px 20px rgba(240,178,43,0.22)'
  },
  groupReason: {
    color: '#7a6d57',
    fontSize: 13,
    lineHeight: 1.6
  },
  betRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 10,
    marginTop: 12
  },
  betRowSingle: {
    display: 'grid',
    gridTemplateColumns: 'repeat(1, minmax(0, 1fr))',
    gap: 10,
    marginTop: 12
  },
  betBox: {
    background: '#fff9ea',
    border: '1px solid #eadfc0',
    borderRadius: 12,
    padding: 10
  },
  betLabel: {
    fontSize: 12,
    color: '#8a7d66',
    marginBottom: 6
  },
  betValue: {
    fontSize: 22,
    fontWeight: 900,
    color: '#6d5f36'
  },
  metaChipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12
  },
  metaChip: {
    display: 'inline-flex',
    gap: 6,
    alignItems: 'center',
    padding: '6px 10px',
    borderRadius: 999,
    background: '#f7f1de',
    border: '1px solid #e3d7b4',
    fontSize: 12,
    color: '#5d5343'
  },
  metaChipLabel: {
    fontWeight: 900,
    color: '#8a5a00'
  },
  emptyBox: {
    background: '#fffdf8',
    border: '1px dashed #d8ceb1',
    borderRadius: 16,
    padding: 20,
    color: '#8a7d66'
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
    borderBottom: '1px solid #e7dcc0',
    color: '#7a6f5e',
    fontSize: 13
  },
  td: {
    padding: '12px 10px',
    borderBottom: '1px solid #f0e7d2',
    color: '#4c4332',
    fontSize: 14,
    verticalAlign: 'top'
  },
  marketBalls: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14
  },
  marketBall: {
    minWidth: 42,
    height: 42,
    borderRadius: '50%',
    background: '#f0b22b',
    color: '#fffef8',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 900,
    fontSize: 16
  },
  numsInline: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6
  },
  numChip: {
    display: 'inline-flex',
    padding: '4px 8px',
    borderRadius: 999,
    background: '#f7f1de',
    border: '1px solid #e3d7b4',
    color: '#6a604f',
    fontSize: 12,
    fontWeight: 800
  }
};
