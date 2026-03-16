// v2.7 full rewrite + AI evolution speed card
import React, { useEffect, useMemo, useRef, useState } from "react";
import { buildBingoV1Strategies } from "../lib/buildBingoV1Strategies";
import {
  applyCompareLearningOnce,
  createLearningStorageKeys,
  getStrategyWeightMap,
  readStrategyStats,
  summarizeStrategyStats
} from "../lib/strategySelfOptimizer";

const STORAGE_KEYS = {
  latest: "fuwei_bingo_latest_v27_hobby",
  testPlan: "fuwei_bingo_test_plan_v27_hobby",
  formalPlan: "fuwei_bingo_formal_plan_v27_hobby",
  testResult: "fuwei_bingo_test_result_v27_hobby",
  formalResult: "fuwei_bingo_formal_result_v27_hobby",
  autoRunAt: "fuwei_bingo_auto_run_at_v27_hobby",
  generatedPlan: "fuwei_bingo_generated_plan_v27_hobby",
  autoTrainLast: "fuwei_bingo_auto_train_last_v27_hobby_clean",
  aiEvolutionLast: "fuwei_bingo_ai_evolution_last_v27_hobby"
};

const LEARNING_KEYS = createLearningStorageKeys("fuwei_bingo_strategy_learning_v2");

const TXT_LATEST = {
  drawNo: 115013398,
  drawTime: "TXT 匯入",
  numbers: [
    "01", "08", "11", "15", "18", "22", "25", "39", "41", "43",
    "46", "51", "55", "60", "61", "65", "66", "69", "73", "76"
  ],
  source: "3/7 完整 TXT 匯入"
};

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function parseNumbers(str) {
  return String(str || "")
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => String(x).padStart(2, "0"))
    .slice(0, 20);
}

function freqMap(recent20) {
  const map = {};
  recent20.forEach(row => {
    parseNumbers(row.numbers).forEach(n => {
      map[n] = (map[n] || 0) + 1;
    });
  });
  return map;
}

function tail(n) {
  return Number(n) % 10;
}

function buildCandidates(recent20) {
  const freq = freqMap(recent20);
  return Object.entries(freq)
    .map(([num, count]) => ({ num, count, tail: tail(num) }))
    .sort((a, b) => b.count - a.count || Number(a.num) - Number(b.num));
}

function compareTone(verdict) {
  switch (verdict) {
    case "小贏以上":
    case "小贏":
    case "win":
      return "#7ef0a5";
    case "打平":
    case "tie":
      return "#ffd36b";
    case "compare_failed":
      return "#ff9f9f";
    case "被咬":
    case "lose":
      return "#ffb0b0";
    default:
      return "#d9e6ff";
  }
}

function normalizeAutoTrainResult(data) {
  const list = Array.isArray(data?.compareResults) ? data.compareResults : [];
  return {
    mode: data?.mode || "unknown",
    latestDrawNo: Number(data?.latestDrawNo || 0) || null,
    latestDrawTime: data?.latestDrawTime || "",
    catchupInserted: Number(data?.catchupInserted || 0),
    catchupWarning: data?.catchupWarning || null,
    created: Number(data?.created || 0),
    skippedCreate: !!data?.skippedCreate,
    maturedCompared: Number(data?.maturedCompared || 0),
    createdPrediction: data?.createdPrediction || null,
    compareResults: list.map((r, idx) => ({
      idx,
      sourceDrawNo: Number(r?.sourceDrawNo || 0) || null,
      targetDrawNo: Number(r?.targetDrawNo || 0) || null,
      compareDrawNo: Number(r?.compareDrawNo || 0) || null,
      verdict: r?.verdict || "unknown",
      error: r?.error || null
    }))
  };
}

function normalizeAiEvolution(data) {
  const strength = Math.max(0, Math.min(100, Number(data?.trainingStrength || 0)));
  const arrow = data?.statusArrow || "→";
  const label = data?.statusLabel || "探索中";
  const color = data?.statusColor || "#79b8ff";

  return {
    ok: !!data?.ok,
    statusArrow: arrow,
    statusLabel: label,
    statusText: data?.statusText || "AI 正在觀察與測試策略。",
    trainingStrength: strength,
    trainingStrengthText: `訓練強度 ${strength}%`,
    statusColor: color,
    comparedLastHour: Number(data?.comparedLastHour || 0),
    createdLastHour: Number(data?.createdLastHour || 0),
    retiredLastHour: Number(data?.retiredLastHour || 0),
    activeCount: Number(data?.activeCount || 0),
    topStrategyKey: data?.topStrategyKey || "-",
    topStrategyScore: Number(data?.topStrategyScore || 0),
    topStrategyAvgHit: Number(data?.topStrategyAvgHit || 0),
    topStrategyRoi: Number(data?.topStrategyRoi || 0),
    topStrategyRecent50Roi: Number(data?.topStrategyRecent50Roi || 0),
    sinceText: data?.sinceText || "最近 1 小時"
  };
}

function getEvolutionFillWidth(value) {
  const v = Math.max(0, Math.min(100, Number(value || 0)));
  return `${v}%`;
}

export default function App() {
  const [latest, setLatest] = useState(() =>
    readLocal(STORAGE_KEYS.latest, TXT_LATEST)
  );

  const [recent20, setRecent20] = useState([]);
  const [recent20Status, setRecent20Status] = useState("尚未載入 recent20");

  const [generatedPlan, setGeneratedPlan] = useState(() =>
    readLocal(STORAGE_KEYS.generatedPlan, null)
  );

  const [autoTrainLast, setAutoTrainLast] = useState(() =>
    readLocal(STORAGE_KEYS.autoTrainLast, null)
  );

  const [aiEvolution, setAiEvolution] = useState(() =>
    readLocal(STORAGE_KEYS.aiEvolutionLast, {
      ok: true,
      statusArrow: "→",
      statusLabel: "探索中",
      statusText: "AI 正在測試新策略。",
      trainingStrength: 0,
      trainingStrengthText: "訓練強度 0%",
      statusColor: "#79b8ff",
      comparedLastHour: 0,
      createdLastHour: 0,
      retiredLastHour: 0,
      activeCount: 0,
      topStrategyKey: "-",
      topStrategyScore: 0,
      topStrategyAvgHit: 0,
      topStrategyRoi: 0,
      topStrategyRecent50Roi: 0,
      sinceText: "最近 1 小時"
    })
  );

  const [syncStatus, setSyncStatus] = useState("尚未同步");
  const [notice, setNotice] = useState("系統啟動中，準備接即時資料。");
  const [autoStatus, setAutoStatus] = useState("尚未執行補抓補比對");

  const [testPlan, setTestPlan] = useState(() =>
    readLocal(STORAGE_KEYS.testPlan, null)
  );
  const [formalPlan, setFormalPlan] = useState(() =>
    readLocal(STORAGE_KEYS.formalPlan, null)
  );
  const [testResult, setTestResult] = useState(() =>
    readLocal(STORAGE_KEYS.testResult, null)
  );
  const [formalResult, setFormalResult] = useState(() =>
    readLocal(STORAGE_KEYS.formalResult, null)
  );
  const [strategyStats, setStrategyStats] = useState(() =>
    readStrategyStats(LEARNING_KEYS.stats)
  );

  const autoRanRef = useRef(false);

  useEffect(() => writeLocal(STORAGE_KEYS.latest, latest), [latest]);
  useEffect(() => writeLocal(STORAGE_KEYS.testPlan, testPlan), [testPlan]);
  useEffect(() => writeLocal(STORAGE_KEYS.formalPlan, formalPlan), [formalPlan]);
  useEffect(() => writeLocal(STORAGE_KEYS.testResult, testResult), [testResult]);
  useEffect(() => writeLocal(STORAGE_KEYS.formalResult, formalResult), [formalResult]);
  useEffect(() => writeLocal(STORAGE_KEYS.generatedPlan, generatedPlan), [generatedPlan]);
  useEffect(() => writeLocal(STORAGE_KEYS.autoTrainLast, autoTrainLast), [autoTrainLast]);
  useEffect(() => writeLocal(STORAGE_KEYS.aiEvolutionLast, aiEvolution), [aiEvolution]);

  async function loadRecent20(silent = false) {
    try {
      const res = await fetch("/api/recent20");
      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || "recent20 載入失敗");
      }

      const rows = Array.isArray(data.recent20) ? data.recent20 : [];
      setRecent20(rows);

      if (!silent) {
        setRecent20Status(`recent20 已更新，共 ${rows.length} 期。`);
      }

      return rows;
    } catch (err) {
      if (!silent) {
        setRecent20Status(`recent20 載入失敗：${err.message}`);
      }
      return [];
    }
  }

  async function loadAiEvolution(silent = false) {
    try {
      const res = await fetch("/api/ai-player");
      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || "AI 進化速度載入失敗");
      }

      const normalized = normalizeAiEvolution(data);
      setAiEvolution(normalized);

      if (!silent) {
        setNotice(`AI進化速度：${normalized.statusArrow} ${normalized.statusLabel}`);
      }

      return normalized;
    } catch (err) {
      if (!silent) {
        setNotice(`AI進化速度載入失敗：${err.message}`);
      }
      return null;
    }
  }

  async function syncLatestCore(silent = false) {
    const res = await fetch("/api/sync");
    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.error || "同步失敗");
    }

    const numbers = Array.isArray(data.numbers)
      ? data.numbers
      : Array.isArray(data.latest?.numbers)
      ? data.latest.numbers
      : [];

    if (numbers.length !== 20) {
      throw new Error("未取得完整 20 顆號碼");
    }

    const newLatest = {
      drawNo: Number(data.draw_no || data.latest?.drawNo || 0) || null,
      drawTime: data.draw_time || data.capturedAt || data.latest?.drawTime || "即時更新",
      numbers,
      source: "澳所即時同步"
    };

    setLatest(newLatest);

    let saveNotice = "";
    try {
      const saveRes = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });

      const saveData = await saveRes.json();

      if (!saveData.ok) {
        throw new Error(saveData.error || "save failed");
      }

      if (saveData.saved) {
        saveNotice = "，並已自動建檔";
      } else if (saveData.skipped) {
        saveNotice = "，此組號碼已存在資料庫";
      } else {
        saveNotice = "，建檔狀態未知";
      }

      if (Array.isArray(saveData.recent20) && saveData.recent20.length > 0) {
        setRecent20(saveData.recent20);
        setRecent20Status(`recent20 已更新，共 ${saveData.recent20.length} 期。`);
      } else {
        await loadRecent20(true);
      }
    } catch (err) {
      saveNotice = `，但建檔失敗：${err.message}`;
      await loadRecent20(true);
    }

    if (!silent) {
      setSyncStatus("已同步最新資料");
      setNotice(`已抓到最新 20 顆號碼${saveNotice}`);
    }

    return newLatest;
  }

  async function syncLatest() {
    try {
      setSyncStatus("同步中...");
      await syncLatestCore(false);
      await loadAiEvolution(true);
    } catch (err) {
      setSyncStatus(`同步失敗：${err.message}`);
    }
  }

  async function generateStrategyPlan() {
    try {
      const res = await fetch("/api/strategy-generate?n=80");
      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || "策略生成失敗");
      }

      setGeneratedPlan(data);
      setNotice(`已生成四星賓果四組四期方案，資料期數到第 ${data.latestDrawNo} 期。`);
    } catch (err) {
      setNotice(`策略生成失敗：${err.message}`);
    }
  }

  async function runAutoTrain() {
    try {
      setAutoStatus("自動訓練執行中...");

      const res = await fetch("/api/auto-train");
      const raw = await res.text();

      let data = null;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`auto-train 回傳非 JSON：${raw.slice(0, 80)}`);
      }

      if (!data.ok) {
        throw new Error(data.error || data.step || "auto-train failed");
      }

      await syncLatestCore(true);
      await loadRecent20(true);
      await loadAiEvolution(true);

      const generated = {
        ok: true,
        mode: data.strategyMode || "auto_train",
        target: {
          stars: 4,
          groups: 4,
          periods: 4
        },
        latestDrawNo: data.latestDrawNo,
        latestDrawTime: data.latestDrawTime,
        usedRows: 80,
        groups: Array.isArray(data.groups)
          ? data.groups.map((g, idx) => ({
              groupNo: idx + 1,
              key: g.key,
              label: g.label,
              nums: g.nums,
              reason: g.reason
            }))
          : []
      };

      setGeneratedPlan(generated);
      setAutoTrainLast(normalizeAutoTrainResult(data));

      const matured = Number(data.maturedCompared || 0);
      const created = Number(data.created || 0);
      const catchupInserted = Number(data.catchupInserted || 0);

      setAutoStatus(
        `自動訓練完成：補抓 ${catchupInserted} 期；新建訓練 ${created} 筆；到期比對 ${matured} 筆。`
      );
      setNotice(`自動訓練已完成，目前最新期數第 ${data.latestDrawNo} 期。`);
    } catch (err) {
      setAutoStatus(`自動訓練失敗：${err.message}`);
    }
  }

  async function savePrediction(mode, targetPeriods, groups) {
    const res = await fetch("/api/prediction-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        sourceDrawNo: latest.drawNo,
        targetPeriods,
        groups
      })
    });

    return await res.json();
  }

  async function comparePrediction(predictionId) {
    const res = await fetch("/api/prediction-compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        predictionId
      })
    });

    return await res.json();
  }

  function buildStrategyGroups() {
    const weightMap = getStrategyWeightMap(strategyStats);
    const built = buildBingoV1Strategies(recent20, weightMap);

    return {
      built,
      groups: built.strategies.map(s => ({
        label: `第${s.groupNo}組｜${s.label}`,
        nums: s.nums,
        reason: `${s.reason}（權重 ${Number(s.meta?.optimizerWeight || 1).toFixed(2)}）`,
        key: s.key,
        meta: s.meta
      }))
    };
  }

  async function startTestMode() {
    const sourceGroups = generatedPlan?.groups?.length
      ? generatedPlan.groups.map(g => ({
          label: g.label,
          nums: g.nums,
          reason: g.reason,
          key: g.key,
          meta: {}
        }))
      : buildStrategyGroups().groups;

    const plan = {
      mode: "test",
      createdAt: new Date().toISOString(),
      sourceDrawNo: latest.drawNo,
      targetPeriods: 4,
      targetDrawNo: Number(latest.drawNo || 0) + 4,
      strategyMode: generatedPlan?.mode || "bingo_v2_4star_4group_4period_self_optimized",
      groups: sourceGroups,
      predictionId: null
    };

    try {
      const saved = await savePrediction("test", 4, sourceGroups);
      if (saved.ok) {
        plan.predictionId = saved.id;
        plan.targetDrawNo = Number(saved.targetDrawNo || plan.targetDrawNo);
        setNotice(`已建立四星賓果四組四期測試模式，需等到第 ${plan.targetDrawNo} 期才可比對。`);
      } else {
        setNotice("已建立測試模式，但預測資料庫寫入失敗。");
      }
    } catch {
      setNotice("已建立測試模式，但預測資料庫寫入失敗。");
    }

    setTestPlan(plan);
    setTestResult(null);
  }

  async function startFormalMode() {
    const sourceGroups = generatedPlan?.groups?.length
      ? generatedPlan.groups.map(g => ({
          label: g.label,
          nums: g.nums,
          reason: g.reason,
          key: g.key,
          meta: {}
        }))
      : buildStrategyGroups().groups;

    const plan = {
      mode: "formal",
      createdAt: new Date().toISOString(),
      sourceDrawNo: latest.drawNo,
      targetPeriods: 4,
      targetDrawNo: Number(latest.drawNo || 0) + 4,
      strategyMode: generatedPlan?.mode || "bingo_v2_4star_4group_4period_self_optimized",
      groups: sourceGroups,
      predictionId: null
    };

    try {
      const saved = await savePrediction("formal", 4, sourceGroups);
      if (saved.ok) {
        plan.predictionId = saved.id;
        plan.targetDrawNo = Number(saved.targetDrawNo || plan.targetDrawNo);
        setNotice(`已建立四星賓果四組四期正式方案，需等到第 ${plan.targetDrawNo} 期才可比對。`);
      } else {
        setNotice("已建立正式方案，但預測資料庫寫入失敗。");
      }
    } catch {
      setNotice("已建立正式方案，但預測資料庫寫入失敗。");
    }

    setFormalPlan(plan);
    setFormalResult(null);
  }

  function learnFromCompare({ mode, predictionId, compareResult }) {
    const learned = applyCompareLearningOnce({
      statsKey: LEARNING_KEYS.stats,
      seenKey: LEARNING_KEYS.seen,
      mode,
      predictionId,
      drawNo: compareResult?.compareDrawNo,
      compareResult
    });

    setStrategyStats(learned.stats);
    return learned;
  }

  async function compareTestMode() {
    if (!testPlan?.predictionId) {
      setNotice("測試模式尚未建立完成，無法比對。");
      return;
    }

    if (!latest.drawNo || Number(latest.drawNo) < Number(testPlan.targetDrawNo || 0)) {
      setNotice(`測試模式尚未到比對期數，目前第 ${latest.drawNo || "?"} 期，需等到第 ${testPlan.targetDrawNo} 期。`);
      return;
    }

    const data = await comparePrediction(testPlan.predictionId);

    if (!data.ok) {
      if (data.waiting) {
        setNotice(data.error || "尚未到比對期數");
        return;
      }
      setNotice(`測試模式比對失敗：${data.error || "未知錯誤"}`);
      return;
    }

    setTestResult(data.result);

    const learned = learnFromCompare({
      mode: "test",
      predictionId: testPlan.predictionId,
      compareResult: data.result
    });

    await loadAiEvolution(true);

    if (learned.applied) {
      setNotice(`測試模式比對完成：${data.result.verdict}，系統已更新策略權重。`);
    } else {
      setNotice(`測試模式比對完成：${data.result.verdict}，此期已學習過。`);
    }
  }

  async function compareFormalMode() {
    if (!formalPlan?.predictionId) {
      setNotice("正式投注尚未建立完成，無法比對。");
      return;
    }

    if (!latest.drawNo || Number(latest.drawNo) < Number(formalPlan.targetDrawNo || 0)) {
      setNotice(`正式投注尚未到比對期數，目前第 ${latest.drawNo || "?"} 期，需等到第 ${formalPlan.targetDrawNo} 期。`);
      return;
    }

    const data = await comparePrediction(formalPlan.predictionId);

    if (!data.ok) {
      if (data.waiting) {
        setNotice(data.error || "尚未到比對期數");
        return;
      }
      setNotice(`正式投注比對失敗：${data.error || "未知錯誤"}`);
      return;
    }

    setFormalResult(data.result);

    const learned = learnFromCompare({
      mode: "formal",
      predictionId: formalPlan.predictionId,
      compareResult: data.result
    });

    await loadAiEvolution(true);

    if (learned.applied) {
      setNotice(`正式投注比對完成：${data.result.verdict}，系統已更新策略權重。`);
    } else {
      setNotice(`正式投注比對完成：${data.result.verdict}，此期已學習過。`);
    }
  }

  async function autoCatchupAndCompare() {
    try {
      setAutoStatus("自動補抓補比對執行中...");

      const lastRun = readLocal(STORAGE_KEYS.autoRunAt, null);
      const now = Date.now();

      if (lastRun && now - Number(lastRun) < 60 * 1000) {
        setAutoStatus("1 分鐘內已執行過補抓補比對，略過。");
        return;
      }

      const catchupRes = await fetch("/api/catchup");
      const catchupRaw = await catchupRes.text();

      let catchupData = null;
      try {
        catchupData = JSON.parse(catchupRaw);
      } catch {
        throw new Error(`catchup 回傳非 JSON：${catchupRaw.slice(0, 80)}`);
      }

      if (!catchupData.ok) {
        throw new Error(catchupData.error || catchupData.message || "補抓失敗");
      }

      const latestData = await syncLatestCore(true);
      await loadRecent20(true);

      let done = 0;
      let learnedCount = 0;

      if (testPlan?.predictionId && Number(latestData.drawNo || 0) >= Number(testPlan.targetDrawNo || 0)) {
        const result = await comparePrediction(testPlan.predictionId);
        if (result.ok) {
          setTestResult(result.result);
          done += 1;

          const learned = learnFromCompare({
            mode: "test",
            predictionId: testPlan.predictionId,
            compareResult: result.result
          });

          if (learned.applied) learnedCount += 1;
        }
      }

      if (formalPlan?.predictionId && Number(latestData.drawNo || 0) >= Number(formalPlan.targetDrawNo || 0)) {
        const result = await comparePrediction(formalPlan.predictionId);
        if (result.ok) {
          setFormalResult(result.result);
          done += 1;

          const learned = learnFromCompare({
            mode: "formal",
            predictionId: formalPlan.predictionId,
            compareResult: result.result
          });

          if (learned.applied) learnedCount += 1;
        }
      }

      writeLocal(STORAGE_KEYS.autoRunAt, now);
      await loadAiEvolution(true);

      const inserted = Number(catchupData.inserted || 0);

      if (inserted > 0) {
        setAutoStatus(`補抓成功，新增 ${inserted} 期；已處理 ${done} 筆預測；學習 ${learnedCount} 次。`);
      } else {
        setAutoStatus(`補抓完成，沒有缺期；已處理 ${done} 筆預測；學習 ${learnedCount} 次。`);
      }
    } catch (err) {
      setAutoStatus(`補抓補比對失敗：${err.message}`);
    }
  }

  useEffect(() => {
    loadRecent20(false);
    loadAiEvolution(true);
  }, []);

  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    autoCatchupAndCompare();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      loadAiEvolution(true);
    }, 60 * 1000);

    return () => clearInterval(timer);
  }, []);

  const core8 = useMemo(() => {
    const candidates = buildCandidates(recent20).slice(0, 8);
    return candidates.map(x => x.num);
  }, [recent20]);

  const sectionStats = useMemo(() => {
    const counts = { "01-20": 0, "21-40": 0, "41-60": 0, "61-80": 0 };
    recent20.forEach(row => {
      parseNumbers(row.numbers).forEach(n => {
        const x = Number(n);
        if (x <= 20) counts["01-20"] += 1;
        else if (x <= 40) counts["21-40"] += 1;
        else if (x <= 60) counts["41-60"] += 1;
        else counts["61-80"] += 1;
      });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [recent20]);

  const strategySummary = useMemo(() => {
    return summarizeStrategyStats(strategyStats);
  }, [strategyStats]);

  return (
    <div style={styles.page}>
      <div style={styles.wrap}>
        <section style={styles.hero}>
          <div style={styles.kicker}>FUWEI BINGO SYSTEM</div>
          <h1 style={styles.h1}>富緯賓果系統 v2.7 AI進化速度版</h1>
          <p style={styles.p}>
            首頁直接顯示 AI 有沒有進步，不再只看數字。你現在看到的是最直白版本：
            進化中、探索中、停滯，外加訓練強度條。
          </p>

          <div style={styles.notice}>{notice}</div>
          <div style={{ ...styles.notice, marginTop: 12, background: "#0a2440" }}>{autoStatus}</div>
          <div style={{ ...styles.notice, marginTop: 12, background: "#0d2744" }}>{recent20Status}</div>

          <div style={styles.statsGrid}>
            <div style={styles.statCard}>
              <div style={styles.statLabel}>最新期數</div>
              <div style={styles.statValue}>
                {latest.drawNo ? `第 ${latest.drawNo} 期` : "即時同步"}
              </div>
            </div>

            <div style={styles.statCard}>
              <div style={styles.statLabel}>最新時間</div>
              <div style={styles.statValue}>{latest.drawTime || "即時更新"}</div>
            </div>

            <div style={styles.statCard}>
              <div style={styles.statLabel}>資料來源</div>
              <div style={styles.statValue}>{latest.source || "澳所即時同步"}</div>
            </div>

            <div style={styles.statCard}>
              <div style={styles.statLabel}>同步狀態</div>
              <div style={styles.statValue}>{syncStatus}</div>
            </div>
          </div>

          <div style={styles.evolutionCard}>
            <div style={styles.evolutionHead}>
              <div>
                <div style={styles.evolutionTitle}>AI進化速度</div>
                <div
                  style={{
                    ...styles.evolutionStatus,
                    color: aiEvolution.statusColor
                  }}
                >
                  {aiEvolution.statusArrow} {aiEvolution.statusLabel}
                </div>
              </div>

              <div style={styles.evolutionMiniStats}>
                <div style={styles.evolutionMiniItem}>
                  <span style={styles.evolutionMiniLabel}>最近1小時 Compare</span>
                  <strong style={styles.evolutionMiniValue}>{aiEvolution.comparedLastHour}</strong>
                </div>
                <div style={styles.evolutionMiniItem}>
                  <span style={styles.evolutionMiniLabel}>最近1小時 Create</span>
                  <strong style={styles.evolutionMiniValue}>{aiEvolution.createdLastHour}</strong>
                </div>
                <div style={styles.evolutionMiniItem}>
                  <span style={styles.evolutionMiniLabel}>最近1小時 淘汰</span>
                  <strong style={styles.evolutionMiniValue}>{aiEvolution.retiredLastHour}</strong>
                </div>
              </div>
            </div>

            <div style={styles.evolutionText}>{aiEvolution.statusText}</div>

            <div style={styles.evolutionBarWrap}>
              <div style={styles.evolutionBarBg}>
                <div
                  style={{
                    ...styles.evolutionBarFill,
                    width: getEvolutionFillWidth(aiEvolution.trainingStrength),
                    background: aiEvolution.statusColor
                  }}
                />
              </div>
              <div style={styles.evolutionStrengthText}>
                {aiEvolution.trainingStrengthText}
              </div>
            </div>

            <div style={styles.evolutionFoot}>
              <div style={styles.evolutionFootItem}>
                <span style={styles.evolutionFootLabel}>活躍策略</span>
                <strong>{aiEvolution.activeCount}</strong>
              </div>
              <div style={styles.evolutionFootItem}>
                <span style={styles.evolutionFootLabel}>第一名策略</span>
                <strong>{aiEvolution.topStrategyKey || "-"}</strong>
              </div>
              <div style={styles.evolutionFootItem}>
                <span style={styles.evolutionFootLabel}>第一名分數</span>
                <strong>{Number(aiEvolution.topStrategyScore || 0).toFixed(1)}</strong>
              </div>
            </div>
          </div>

          <div style={styles.btnRow}>
            <button style={styles.primaryBtn} onClick={syncLatest}>同步最新一期</button>
            <button style={styles.secondaryBtn} onClick={autoCatchupAndCompare}>立即補抓補比對</button>
            <button style={styles.secondaryBtn} onClick={generateStrategyPlan}>自動產生四組四期</button>
            <button style={styles.secondaryBtn} onClick={runAutoTrain}>啟動自動訓練</button>
            <button style={styles.secondaryBtn} onClick={startTestMode}>建立測試模式</button>
            <button style={styles.secondaryBtn} onClick={startFormalMode}>建立正式投注</button>
          </div>
        </section>

        <div style={styles.grid2}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>最新一期資訊</h2>
            <div style={styles.subtle}>
              {latest.drawNo ? `第 ${latest.drawNo} 期` : "即時同步"} / {latest.source || "澳所即時同步"}
            </div>

            <div style={styles.numbersWrap}>
              {(latest.numbers || []).map((n, i) => (
                <span key={i} style={styles.numBall}>{n}</span>
              ))}
            </div>

            <div style={styles.subtle}>來源：{latest.source || "澳所即時同步"}</div>
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>核心 8 號</h2>
            <div style={styles.coreGrid}>
              {core8.map((n, i) => (
                <div key={i} style={styles.coreCard}>
                  <div style={styles.coreLabel}>核心 {i + 1}</div>
                  <div style={styles.coreValue}>{n}</div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {generatedPlan?.groups?.length ? (
          <section style={styles.panel}>
            <h2 style={styles.h2}>自動產生四組四期方案</h2>
            <div style={styles.subtle}>策略模式：{generatedPlan.mode}</div>
            <div style={styles.subtle}>資料期數：第 {generatedPlan.latestDrawNo} 期 / 使用 {generatedPlan.usedRows || 80} 筆資料</div>
            <div style={{ marginTop: 12 }}>
              {generatedPlan.groups.map((g, idx) => (
                <div key={idx} style={styles.groupCard}>
                  <div style={styles.groupTitle}>{g.label}</div>
                  <div style={styles.groupNums}>{g.nums.join(" ")}</div>
                  <div style={styles.subtle}>{g.reason}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {autoTrainLast ? (
          <section style={styles.panel}>
            <h2 style={styles.h2}>自動訓練摘要</h2>
            <div style={styles.subtle}>模式：{autoTrainLast.mode}</div>
            <div style={styles.subtle}>最新期數：第 {autoTrainLast.latestDrawNo || "-"} 期</div>
            <div style={styles.subtle}>補抓新增：{autoTrainLast.catchupInserted || 0} 期</div>
            <div style={styles.subtle}>新建訓練：{autoTrainLast.created || 0} 筆</div>
            <div style={styles.subtle}>到期比對：{autoTrainLast.maturedCompared || 0} 筆</div>
            {autoTrainLast.catchupWarning ? (
              <div style={{ ...styles.subtle, color: "#ffd36b", marginTop: 8 }}>
                補抓警告：{autoTrainLast.catchupWarning}
              </div>
            ) : null}

            <div style={{ marginTop: 14 }}>
              {(autoTrainLast.compareResults || []).map((r, idx) => (
                <div key={idx} style={styles.autoTrainCard}>
                  <div style={styles.autoTrainTop}>
                    <strong>來源期數：{r.sourceDrawNo || "-"}</strong>
                    <span style={{ color: compareTone(r.verdict), fontWeight: 700 }}>
                      {r.verdict || "unknown"}
                    </span>
                  </div>
                  <div style={styles.subtle}>目標期數：{r.targetDrawNo || "-"}</div>
                  <div style={styles.subtle}>實際比對期數：{r.compareDrawNo || "-"}</div>
                  {r.error ? (
                    <div style={{ ...styles.subtle, color: "#ff9f9f" }}>
                      錯誤：{r.error}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div style={styles.grid2}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>最近 20 期底稿</h2>
            <div style={styles.subtle}>固定優先讀取 /api/recent20，供四星賓果四組四期策略生成與補比對使用</div>
            <div style={{ maxHeight: 260, overflow: "auto", marginTop: 12 }}>
              {recent20.map((row, idx) => (
                <div key={`${row.draw_no}-${idx}`} style={{ ...styles.row, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <span>{row.draw_no || "-"}</span>
                  <span style={{ fontSize: 12, opacity: 0.8 }}>{row.draw_time || ""}</span>
                </div>
              ))}
            </div>
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>區段統計</h2>
            {sectionStats.map(([label, count]) => (
              <div key={label} style={styles.row}>
                <span>{label}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </section>
        </div>

        <section style={styles.panel}>
          <h2 style={styles.h2}>自我優化權重面板</h2>
          <div style={styles.subtle}>每次比對後，系統會更新各策略平均命中與權重。權重越高，下一輪生成時該策略內部權重越強。</div>
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14 }}>
            {strategySummary.map(item => (
              <div key={item.key} style={styles.groupCard}>
                <div style={styles.groupTitle}>{item.label}</div>
                <div style={{ ...styles.subtle, marginTop: 8 }}>累計回合：{item.rounds}</div>
                <div style={styles.subtle}>平均命中：{item.avgHit}</div>
                <div style={styles.subtle}>目前權重：{item.weight}</div>
                <div style={styles.subtle}>0碼：{item.hit0} / 1碼：{item.hit1} / 2碼：{item.hit2} / 3碼：{item.hit3} / 4碼：{item.hit4}</div>
                <div style={styles.subtle}>近12次：{item.recentHits.length ? item.recentHits.join("、") : "尚無資料"}</div>
              </div>
            ))}
          </div>
        </section>

        <div style={styles.grid2}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>測試模式（四星賓果 / 四組 / 四期）</h2>
            {testPlan ? (
              <>
                <div style={styles.subtle}>Prediction ID：{testPlan.predictionId || "尚未寫入"}</div>
                <div style={styles.subtle}>策略模式：{testPlan.strategyMode || "bingo_v2_4star_4group_4period_self_optimized"}</div>
                <div style={styles.subtle}>來源期數：第 {testPlan.sourceDrawNo} 期</div>
                <div style={styles.subtle}>目標期數：第 {testPlan.targetDrawNo} 期</div>
                {testPlan.groups.map((g, idx) => (
                  <div key={idx} style={styles.groupCard}>
                    <div style={styles.groupTitle}>{g.label}</div>
                    <div style={styles.groupNums}>{g.nums.join(" ")}</div>
                    <div style={styles.subtle}>{g.reason}</div>
                  </div>
                ))}
                <div style={styles.btnRow}>
                  <button style={styles.primaryBtn} onClick={compareTestMode}>用目標期數比對測試模式</button>
                </div>
                {testResult && (
                  <div style={styles.resultBox}>
                    <div style={styles.resultLine}>判定：<strong>{testResult.verdict}</strong></div>
                    <div style={styles.resultLine}>來源期數：{testResult.sourceDrawNo}</div>
                    <div style={styles.resultLine}>目標期數：{testResult.targetDrawNo}</div>
                    <div style={styles.resultLine}>實際比對期數：{testResult.compareDrawNo}</div>
                    <div style={styles.resultLine}>估計成本：{testResult.totalCost}</div>
                    <div style={styles.resultLine}>估計回收：{testResult.estimatedReturn}</div>
                    <div style={styles.resultLine}>估計損益：{testResult.profit}</div>
                    <div style={{ marginTop: 12 }}>
                      {testResult.results.map((r, idx) => (
                        <div key={idx} style={styles.resultRow}>
                          <span>{r.label}</span>
                          <span>{r.nums.join(" ")}</span>
                          <span>命中 {r.hitCount} 碼</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={styles.subtle}>尚未建立測試模式。</div>
            )}
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>正式投注（四星賓果 / 四組 / 四期）</h2>
            {formalPlan ? (
              <>
                <div style={styles.subtle}>Prediction ID：{formalPlan.predictionId || "尚未寫入"}</div>
                <div style={styles.subtle}>策略模式：{formalPlan.strategyMode || "bingo_v2_4star_4group_4period_self_optimized"}</div>
                <div style={styles.subtle}>來源期數：第 {formalPlan.sourceDrawNo} 期</div>
                <div style={styles.subtle}>目標期數：第 {formalPlan.targetDrawNo} 期</div>
                {formalPlan.groups.map((g, idx) => (
                  <div key={idx} style={styles.groupCard}>
                    <div style={styles.groupTitle}>{g.label}</div>
                    <div style={styles.groupNums}>{g.nums.join(" ")}</div>
                    <div style={styles.subtle}>{g.reason}</div>
                  </div>
                ))}
                <div style={styles.btnRow}>
                  <button style={styles.primaryBtn} onClick={compareFormalMode}>用目標期數比對正式投注</button>
                </div>
                {formalResult && (
                  <div style={styles.resultBox}>
                    <div style={styles.resultLine}>判定：<strong>{formalResult.verdict}</strong></div>
                    <div style={styles.resultLine}>來源期數：{formalResult.sourceDrawNo}</div>
                    <div style={styles.resultLine}>目標期數：{formalResult.targetDrawNo}</div>
                    <div style={styles.resultLine}>實際比對期數：{formalResult.compareDrawNo}</div>
                    <div style={styles.resultLine}>估計成本：{formalResult.totalCost}</div>
                    <div style={styles.resultLine}>估計回收：{formalResult.estimatedReturn}</div>
                    <div style={styles.resultLine}>估計損益：{formalResult.profit}</div>
                    <div style={{ marginTop: 12 }}>
                      {formalResult.results.map((r, idx) => (
                        <div key={idx} style={styles.resultRow}>
                          <span>{r.label}</span>
                          <span>{r.nums.join(" ")}</span>
                          <span>命中 {r.hitCount} 碼</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={styles.subtle}>尚未建立正式投注。</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    background: "#020b25",
    minHeight: "100vh",
    color: "#f3f6ff",
    padding: "24px"
  },
  wrap: {
    maxWidth: "1200px",
    margin: "0 auto"
  },
  hero: {
    background: "linear-gradient(180deg, #071938 0%, #09142b 100%)",
    border: "1px solid rgba(100,180,255,0.18)",
    borderRadius: 28,
    padding: 28,
    boxShadow: "0 20px 50px rgba(0,0,0,0.35)"
  },
  kicker: {
    color: "#ffcf4d",
    letterSpacing: 3,
    fontSize: 14,
    marginBottom: 10
  },
  h1: {
    margin: 0,
    fontSize: 44,
    lineHeight: 1.15
  },
  p: {
    color: "#b7c5e4",
    fontSize: 18,
    lineHeight: 1.8,
    marginTop: 16
  },
  notice: {
    marginTop: 18,
    border: "1px solid #1f88c7",
    background: "#083150",
    color: "#dff2ff",
    borderRadius: 18,
    padding: "16px 18px",
    fontSize: 18
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
    gap: 16,
    marginTop: 22
  },
  statCard: {
    background: "#081731",
    borderRadius: 20,
    padding: 18
  },
  statLabel: {
    color: "#9eb4dc",
    fontSize: 14,
    marginBottom: 8
  },
  statValue: {
    fontSize: 18,
    fontWeight: 700
  },
  evolutionCard: {
    marginTop: 22,
    background: "linear-gradient(180deg, #0b203f 0%, #091a34 100%)",
    borderRadius: 24,
    padding: 22,
    border: "1px solid rgba(255,255,255,0.08)"
  },
  evolutionHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    flexWrap: "wrap"
  },
  evolutionTitle: {
    fontSize: 18,
    color: "#9eb4dc",
    marginBottom: 8
  },
  evolutionStatus: {
    fontSize: 34,
    fontWeight: 800,
    lineHeight: 1.2
  },
  evolutionText: {
    marginTop: 12,
    color: "#dce9ff",
    fontSize: 18,
    lineHeight: 1.7
  },
  evolutionMiniStats: {
    display: "grid",
    gridTemplateColumns: "repeat(3,minmax(120px,1fr))",
    gap: 12,
    minWidth: "340px"
  },
  evolutionMiniItem: {
    background: "#081731",
    borderRadius: 16,
    padding: 14
  },
  evolutionMiniLabel: {
    display: "block",
    color: "#9eb4dc",
    fontSize: 13,
    marginBottom: 8
  },
  evolutionMiniValue: {
    fontSize: 24,
    fontWeight: 800,
    color: "#f3f6ff"
  },
  evolutionBarWrap: {
    marginTop: 18
  },
  evolutionBarBg: {
    width: "100%",
    height: 20,
    borderRadius: 999,
    background: "#162947",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.08)"
  },
  evolutionBarFill: {
    height: "100%",
    borderRadius: 999,
    transition: "width 0.3s ease"
  },
  evolutionStrengthText: {
    marginTop: 10,
    fontSize: 18,
    fontWeight: 800,
    color: "#f7cf52"
  },
  evolutionFoot: {
    marginTop: 16,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
    gap: 12
  },
  evolutionFootItem: {
    background: "#081731",
    borderRadius: 16,
    padding: 14
  },
  evolutionFootLabel: {
    display: "block",
    color: "#9eb4dc",
    fontSize: 13,
    marginBottom: 8
  },
  btnRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 20
  },
  primaryBtn: {
    background: "#f7bf19",
    color: "#111",
    border: 0,
    borderRadius: 18,
    padding: "14px 22px",
    fontSize: 18,
    fontWeight: 700,
    cursor: "pointer"
  },
  secondaryBtn: {
    background: "transparent",
    color: "#eef4ff",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 18,
    padding: "14px 22px",
    fontSize: 18,
    fontWeight: 700,
    cursor: "pointer"
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))",
    gap: 18,
    marginTop: 20
  },
  panel: {
    background: "#071938",
    borderRadius: 28,
    padding: 24,
    border: "1px solid rgba(255,255,255,0.06)",
    marginTop: 20
  },
  h2: {
    marginTop: 0,
    fontSize: 24
  },
  subtle: {
    color: "#9eb4dc",
    fontSize: 16,
    lineHeight: 1.7
  },
  numbersWrap: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
    marginBottom: 16
  },
  numBall: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 52,
    height: 52,
    borderRadius: 999,
    background: "#b11f2d",
    color: "#fff",
    fontWeight: 800,
    fontSize: 22
  },
  coreGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(80px,1fr))",
    gap: 12
  },
  coreCard: {
    background: "#081731",
    borderRadius: 18,
    padding: 18,
    textAlign: "center"
  },
  coreLabel: {
    color: "#9eb4dc",
    fontSize: 14
  },
  coreValue: {
    marginTop: 10,
    fontSize: 28,
    fontWeight: 800
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 0"
  },
  groupCard: {
    background: "#0b203f",
    borderRadius: 20,
    padding: 18,
    marginTop: 12
  },
  groupTitle: {
    color: "#ffcf4d",
    fontSize: 18,
    fontWeight: 700
  },
  groupNums: {
    marginTop: 10,
    fontSize: 30,
    fontWeight: 800,
    letterSpacing: 1
  },
  resultBox: {
    marginTop: 18,
    background: "#081731",
    borderRadius: 18,
    padding: 18
  },
  resultLine: {
    fontSize: 18,
    marginBottom: 8
  },
  resultRow: {
    display: "grid",
    gridTemplateColumns: "1.2fr 2fr 1fr",
    gap: 12,
    padding: "8px 0",
    borderBottom: "1px solid rgba(255,255,255,0.08)"
  },
  autoTrainCard: {
    background: "#0b203f",
    borderRadius: 18,
    padding: 16,
    marginTop: 10
  },
  autoTrainTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 6
  }
};
