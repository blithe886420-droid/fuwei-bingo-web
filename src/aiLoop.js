let loopTimer = null;
let nightPauseTimer = null;
let isCycleRunning = false;

const LOOP_INTERVAL_MS = 180000;
const NIGHT_STOP_START_MINUTES = 0;
const NIGHT_STOP_END_MINUTES = 7 * 60 + 30;

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

async function loadConfig() {
  try {
    const data = await safeFetchJson('/api/system-config');
    return data || {};
  } catch (err) {
    console.error('AI LOOP loadConfig error', err);
    return {};
  }
}

function readAutoTrainEnabled(cfg) {
  const rows = Array.isArray(cfg?.rows) ? cfg.rows : [];
  const row = rows.find((r) => r?.key === 'auto_train_enabled');

  if (row) {
    return row.value === true || String(row.value) === 'true';
  }

  if (cfg?.key === 'auto_train_enabled') {
    return cfg.value === true || String(cfg.value) === 'true';
  }

  if (typeof cfg?.auto_train_enabled !== 'undefined') {
    return cfg.auto_train_enabled === true || String(cfg.auto_train_enabled) === 'true';
  }

  return false;
}

function buildLoopStatusText(result) {
  const compared = Number(result?.compared_count || 0);
  const created = Number(result?.created_count || 0);
  const pending = Array.isArray(result?.pending_details) ? result.pending_details : [];
  const activeCreated = result?.active_created_prediction || null;

  if (compared > 0 || created > 0) {
    const parts = [`本輪完成：比對 ${compared} 筆 / 新建 ${created} 筆`];
    if (activeCreated?.source_draw_no) {
      parts.push(`目前訓練來源期數 ${activeCreated.source_draw_no}`);
    }
    return parts.join('，');
  }

  if (pending.length > 0) {
    const msg = pending[0]?.message || '等待下一期資料';
    if (activeCreated?.source_draw_no) {
      return `等待中：${msg}（目前訓練來源期數 ${activeCreated.source_draw_no}）`;
    }
    return `等待中：${msg}`;
  }

  if (activeCreated?.source_draw_no) {
    return `待命中，目前訓練來源期數 ${activeCreated.source_draw_no}`;
  }

  return '待命中';
}

function clearAllTimers() {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }

  if (nightPauseTimer) {
    clearTimeout(nightPauseTimer);
    nightPauseTimer = null;
  }
}

async function runAiCycle(setStatus) {
  if (isCycleRunning) return null;
  isCycleRunning = true;

  try {
    if (isNightStopWindow()) {
      setStatus('夜間停訓中（00:00～07:30 不訓練）');
      return null;
    }

    setStatus('同步期數中...');
    await safeFetchJson('/api/sync', { method: 'POST' }).catch(async () => {
      await safeFetchJson('/api/sync');
    });

    setStatus('更新 recent20...');
    await safeFetchJson('/api/recent20');

    setStatus('檢查補期...');
    await safeFetchJson('/api/catchup', { method: 'POST' }).catch(async () => {
      await safeFetchJson('/api/catchup');
    });

    setStatus('AI 訓練中...');
    const autoTrainResult = await safeFetchJson('/api/auto-train', { method: 'POST' });

    setStatus(buildLoopStatusText(autoTrainResult));
    return autoTrainResult;
  } catch (err) {
    console.error('AI LOOP error', err);
    setStatus('AI 循環錯誤');
    return null;
  } finally {
    isCycleRunning = false;
  }
}

function scheduleNightResume(setStatus) {
  clearAllTimers();
  setStatus('夜間停訓中（00:00～07:30 不訓練）');

  nightPauseTimer = setTimeout(async () => {
    const cfg = await loadConfig();
    const enabled = readAutoTrainEnabled(cfg);

    if (!enabled) {
      setStatus('已停止');
      return;
    }

    await runAiCycle(setStatus);
    startAiLoop(setStatus);
  }, msUntilNightWindowEnd());
}

export async function runAiLoopOnce(setStatus) {
  return await runAiCycle(setStatus);
}

export async function startAiLoop(setStatus) {
  clearAllTimers();

  const cfg = await loadConfig();
  const enabled = readAutoTrainEnabled(cfg);

  if (!enabled) {
    setStatus('已停止');
    return;
  }

  if (isNightStopWindow()) {
    scheduleNightResume(setStatus);
    return;
  }

  setStatus('AI LOOP 啟動');
  await runAiCycle(setStatus);

  loopTimer = setTimeout(async function loopRunner() {
    const latestCfg = await loadConfig();
    const latestEnabled = readAutoTrainEnabled(latestCfg);

    if (!latestEnabled) {
      clearAllTimers();
      setStatus('已停止');
      return;
    }

    if (isNightStopWindow()) {
      scheduleNightResume(setStatus);
      return;
    }

    await runAiCycle(setStatus);
    loopTimer = setTimeout(loopRunner, LOOP_INTERVAL_MS);
  }, LOOP_INTERVAL_MS);
}

export function stopAiLoop() {
  clearAllTimers();
}
