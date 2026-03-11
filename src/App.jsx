// v3.6.2 PROFESSIONAL AI EVALUATION + AUTO TRAIN TOGGLE
import React, { useEffect, useMemo, useRef, useState } from "react";
import { buildBingoV1Strategies } from "../lib/buildBingoV1Strategies";
import {
  applyCompareLearningOnce,
  createLearningStorageKeys,
  getStrategyWeightMap,
  readStrategyStats
} from "../lib/strategySelfOptimizer";

const STORAGE_KEYS = {
  latest: "fuwei_bingo_latest_v24_hobby",
  testPlan: "fuwei_bingo_test_plan_v24_hobby",
  formalPlan: "fuwei_bingo_formal_plan_v24_hobby",
  testResult: "fuwei_bingo_test_result_v24_hobby",
  formalResult: "fuwei_bingo_formal_result_v24_hobby",
  autoRunAt: "fuwei_bingo_auto_run_at_v24_hobby",
  autoTrainLast: "fuwei_bingo_auto_train_last_v362",
  autoTrainHistory: "fuwei_bingo_auto_train_history_v362",
  strategyLeaderboard: "fuwei_bingo_strategy_leaderboard_v362",
  autoTrainEnabled: "fuwei_bingo_auto_train_enabled_v362"
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
  if (Array.isArray(str)) {
    return str.map((x) => String(x).padStart(2, "0")).slice(0, 20);
  }

  return String(str || "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => String(x).padStart(2, "0"))
    .slice(0, 20);
}

function withTs(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}ts=${Date.now()}`;
}

function isBingoRestTime() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const total = hour * 60 + minute;
  return total < 450; // 00:00 ~ 07:29
}

function getClockText() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round1(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : "0.0";
}

function mergeAutoTrainHistory(prevHistory, autoTrainData) {
  const prev = Array.isArray(prevHistory) ? prevHistory : [];
  const compared = Array.isArray(autoTrainData?.compared_details)
    ? autoTrainData.compared_details
    : [];

  if (!compared.length) return prev;

  const map = new Map(prev.map((item) => [String(item.predictionId), item]));
  const now = Date.now();

  compared.forEach((item, idx) => {
    const predictionId = String(item?.prediction_id ?? `${now}-${idx}`);
    const previous = map.get(predictionId) || {};

    map.set(predictionId, {
      ...previous,
      predictionId,
      sourceDrawNo: String(item?.source_draw_no ?? ""),
      totalCost: normalizeNumber(item?.total_cost, 0),
      totalReward: normalizeNumber(item?.total_reward, 0),
      profit: normalizeNumber(item?.profit, 0),
      bestSingleHit: normalizeNumber(item?.best_single_hit, 0),
      totalHitCount: normalizeNumber(item?.total_hit_count, 0),
      strategies: Array.isArray(item?.strategies) ? item.strategies : previous.strategies || [],
      comparedAt: now + idx
    });
  });

  return [...map.values()]
    .sort((a, b) => normalizeNumber(b.comparedAt, 0) - normalizeNumber(a.comparedAt, 0))
    .slice(0, 150);
}

function buildTrendText(label, current, previous) {
  if (!Number.isFinite(current)) return `${label}：尚無資料`;
  if (!Number.isFinite(previous)) return `${label}：資料不足`;
  if (current > previous) return `${label}比前 5 次高`;
  if (current < previous) return `${label}比前 5 次低`;
  return `${label}持平`;
}

export default function App() {
  const [latest, setLatest] = useState(() => readLocal(STORAGE_KEYS.latest, TXT_LATEST));
  const [recent20, setRecent20] = useState([]);
  const [recent20Status, setRecent20Status] = useState("尚未載入 recent20");

  const [autoTrainLast, setAutoTrainLast] = useState(() =>
    readLocal(STORAGE_KEYS.autoTrainLast, null)
  );
  const [autoTrainHistory, setAutoTrainHistory] = useState(() =>
    readLocal(STORAGE_KEYS.autoTrainHistory, [])
  );
  const [strategyLeaderboard, setStrategyLeaderboard] = useState(() =>
    readLocal(STORAGE_KEYS.strategyLeaderboard, [])
  );
  const [autoTrainEnabled, setAutoTrainEnabled] = useState(() =>
    readLocal(STORAGE_KEYS.autoTrainEnabled, true)
  );

  const [syncStatus, setSyncStatus] = useState("尚未同步");
  const [notice, setNotice] = useState("系統啟動中，準備接即時資料。");
  const [autoStatus, setAutoStatus] = useState("尚未執行補抓補比對");
  const [loopStatus, setLoopStatus] = useState("自動循環待啟動");

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
  useEffect(() => writeLocal(STORAGE_KEYS.autoTrainLast, autoTrainLast), [autoTrainLast]);
  useEffect(() => writeLocal(STORAGE_KEYS.autoTrainHistory, autoTrainHistory), [autoTrainHistory]);
  useEffect(() => writeLocal(STORAGE_KEYS.strategyLeaderboard, strategyLeaderboard), [strategyLeaderboard]);
  useEffect(() => writeLocal(STORAGE_KEYS.autoTrainEnabled, autoTrainEnabled), [autoTrainEnabled]);

  async function loadSystemConfig(silent = false) {
    try {
      const res = await fetch(withTs("/api/system-config"), {
        cache: "no-store"
      });
      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || "system-config failed");
      }

      const enabled = !!data.value;
      setAutoTrainEnabled(enabled);
      return enabled;
    } catch (err) {
      if (!silent) {
        setNotice(`讀取自動訓練開關失敗：${err.message}`);
      }
      return autoTrainEnabled;
    }
  }

  async function setSystemAutoTrain(enabled) {
    try {
      const res = await fetch(withTs("/api/system-config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ enabled })
      });

      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || "system-config POST failed");
      }

      setAutoTrainEnabled(!!data.value);

      if (data.value) {
        setNotice("自動訓練已開啟，立即執行一輪訓練。");
        await runAutoTrain();
      } else {
        setAutoStatus("自動訓練已關閉，本輪後不再自動執行。");
        setNotice("自動訓練已關閉。");
      }
    } catch (err) {
      setNotice(`切換自動訓練失敗：${err.message}`);
    }
  }

  async function loadRecent20(silent = false) {
    try {
      const res = await fetch(withTs("/api/recent20"), {
        cache: "no-store"
      });
      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || "recent20 載入失敗");
      }

      const rows = Array.isArray(data.recent20) ? data.recent20 : [];
      setRecent20(rows);

      if (rows.length > 0) {
        const newest = rows[0];
        setLatest((prev) => ({
          drawNo: Number(newest.draw_no || prev?.drawNo || 0) || prev?.drawNo || null,
          drawTime: newest.draw_time || prev?.drawTime || "即時更新",
          numbers: parseNumbers(newest.numbers || prev?.numbers || []),
          source: "recent20 最新期數"
        }));
      }

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

  async function syncLatestCore(silent = false) {
    const res = await fetch(withTs("/api/sync"), { cache: "no-store" });
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

    try {
      const saveRes = await fetch(withTs("/api/save"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({})
      });

      const saveData = await saveRes.json();

      if (saveData.ok && Array.isArray(saveData.recent20) && saveData.recent20.length > 0) {
        setRecent20(saveData.recent20);
        setRecent20Status(`recent20 已更新，共 ${saveData.recent20.length} 期。`);

        const newest = saveData.recent20[0];
        if (newest) {
          setLatest({
            drawNo: Number(newest.draw_no || newLatest.drawNo || 0) || newLatest.drawNo,
            drawTime: newest.draw_time || newLatest.drawTime,
            numbers: parseNumbers(newest.numbers || newLatest.numbers),
            source: "recent20 最新期數"
          });
        }
      } else {
        await loadRecent20(true);
      }
    } catch {
      await loadRecent20(true);
    }

    if (!silent) {
      setSyncStatus("已同步最新資料");
      setNotice("已抓到最新 20 顆號碼，並已同步更新。");
    }

    return newLatest;
  }

  async function syncLatest() {
    try {
      setSyncStatus("同步中...");
      await syncLatestCore(false);
    } catch (err) {
      setSyncStatus(`同步失敗：${err.message}`);
    }
  }

  async function runAutoTrain() {
    try {
      setAutoStatus("自動訓練執行中...");

      const res = await fetch(withTs("/api/auto-train"), {
        method: "GET",
        cache: "no-store"
      });

      const raw = await res.text();
      let data = null;

      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`auto-train 回傳非 JSON：${raw.slice(0, 120)}`);
      }

      if (!data.ok) {
        throw new Error(data.error || "auto-train failed");
      }

      await syncLatestCore(true);
      await loadRecent20(true);

      setAutoTrainLast(data);
      setAutoTrainHistory((prev) => mergeAutoTrainHistory(prev, data));
      setStrategyLeaderboard(Array.isArray(data.leaderboard) ? data.leaderboard : []);

      const latestDrawNo = data?.latest_draw_no ?? "未知";
      const comparedCount = Number(data?.compared_count || 0);
      const createdCount = Number(data?.created_count || 0);

      setAutoStatus(`自動訓練完成：到期比對 ${comparedCount} 筆，新建訓練 ${createdCount} 筆。`);
      setNotice(`自動訓練已完成，目前最新期數第 ${latestDrawNo} 期。`);
    } catch (err) {
      setAutoStatus(`自動訓練失敗：${err.message}`);
    }
  }

  async function savePrediction(mode, targetPeriods, groups, sourceDrawNo) {
    const res = await fetch(withTs("/api/prediction-save"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        mode,
        sourceDrawNo,
        targetPeriods,
        groups
      })
    });

    return await res.json();
  }

  async function comparePrediction(predictionId) {
    const res = await fetch(withTs("/api/prediction-compare"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ predictionId })
    });

    return await res.json();
  }

  function buildWeightedStrategies() {
    const weightMap = getStrategyWeightMap(strategyStats);
    const built = buildBingoV1Strategies(recent20, weightMap);

    return built.strategies.map((s) => {
      const weight = Number(s.meta?.optimizerWeight || 1);
      const rounds = normalizeNumber(strategyStats?.[s.key]?.rounds, 0);
      const avgHit = normalizeNumber(strategyStats?.[s.key]?.avgHit, 0);
      const score = weight * 100 + avgHit * 10 + rounds * 0.1;

      return {
        key: s.key,
        groupNo: s.groupNo,
        label: s.label,
        nums: s.nums,
        reason: s.reason,
        meta: s.meta || {},
        weight,
        rounds,
        avgHit,
        score
      };
    });
  }

  function buildTestGroups() {
    const ranked = buildWeightedStrategies().sort((a, b) => b.score - a.score);
    return ranked.slice(0, 4).map((s, idx) => ({
      label: `測試第${idx + 1}名｜${s.label}`,
      nums: s.nums,
      reason: `${s.reason}（權重 ${s.weight.toFixed(2)} / 平均命中 ${s.avgHit.toFixed(2)} / 累計回合 ${s.rounds}）`,
      key: s.key,
      meta: { ...s.meta, rank: idx + 1 }
    }));
  }

  function buildFormalGroupsFromLeaderboard() {
    const top4 = Array.isArray(strategyLeaderboard) ? strategyLeaderboard.slice(0, 4) : [];
    const fallback = buildTestGroups();

    if (!top4.length) {
      return fallback.map((g, idx) => ({
        ...g,
        label: `正式第${idx + 1}名｜${g.label.replace(/^測試第\d+名｜/, "")}`,
        reason: `暫無排行榜資料，退回本機權重模式：${g.reason}`
      }));
    }

    const built = buildWeightedStrategies();
    const strategyMap = new Map(built.map((s) => [s.key, s]));

    return top4
      .map((ranked, idx) => {
        const matched = strategyMap.get(ranked.key);

        return {
          label: `正式第${idx + 1}名｜${ranked.label}`,
          nums: matched?.nums || [],
          reason: `採用排行榜第 ${idx + 1} 名：平均命中 ${ranked.avg_hit} / 平均淨損益 ${ranked.avg_profit} / 中獎率 ${ranked.payout_rate}% / 盈利率 ${ranked.profit_win_rate}% / ROI ${ranked.roi}%`,
          key: ranked.key,
          meta: {
            rank: idx + 1,
            avgHit: ranked.avg_hit,
            avgProfit: ranked.avg_profit,
            payoutRate: ranked.payout_rate,
            profitWinRate: ranked.profit_win_rate,
            roi: ranked.roi,
            totalRounds: ranked.total_rounds,
            score: ranked.score
          }
        };
      })
      .filter((g) => Array.isArray(g.nums) && g.nums.length > 0);
  }

  async function startTestMode() {
    const currentDrawNo = Number(recent20?.[0]?.draw_no || latest.drawNo || 0);
    if (!currentDrawNo) {
      setNotice("目前抓不到最新期數，請先按一次同步最新一期。");
      return;
    }

    const sourceGroups = buildTestGroups();

    const plan = {
      mode: "test",
      createdAt: new Date().toISOString(),
      sourceDrawNo: currentDrawNo,
      targetPeriods: 2,
      targetDrawNo: currentDrawNo + 2,
      strategyMode: "test_use_best_local_weighted_strategies_v362",
      groups: sourceGroups,
      predictionId: null
    };

    try {
      const saved = await savePrediction("test", 2, sourceGroups, currentDrawNo);
      if (saved.ok) {
        plan.predictionId = saved.id;
        setNotice(`已建立四星賓果四組二期測試模式，來源第 ${currentDrawNo} 期。`);
      } else {
        setNotice(`測試模式建立失敗：${saved.error || "預測資料庫寫入失敗"}`);
      }
    } catch (err) {
      setNotice(`測試模式建立失敗：${err.message}`);
    }

    setTestPlan(plan);
    setTestResult(null);
  }

  async function startFormalMode() {
    const currentDrawNo = Number(recent20?.[0]?.draw_no || latest.drawNo || 0);
    if (!currentDrawNo) {
      setNotice("目前抓不到最新期數，請先按一次同步最新一期。");
      return;
    }

    const sourceGroups = buildFormalGroupsFromLeaderboard();

    if (!sourceGroups.length) {
      setNotice("目前還沒有可用的排行榜策略，請先讓系統累積更多已比對訓練結果。");
      return;
    }

    const plan = {
      mode: "formal",
      createdAt: new Date().toISOString(),
      sourceDrawNo: currentDrawNo,
      targetPeriods: 4,
      targetDrawNo: currentDrawNo + 4,
      strategyMode: "formal_use_top4_leaderboard_strategies_v362",
      groups: sourceGroups,
      predictionId: null
    };

    try {
      const saved = await savePrediction("formal", 4, sourceGroups, currentDrawNo);
      if (saved.ok) {
        plan.predictionId = saved.id;
        setNotice(`已建立正式投注：本次直接採用 AI 專業評估排行榜前 4 名。`);
      } else {
        setNotice(`正式投注建立失敗：${saved.error || "預測資料庫寫入失敗"}`);
      }
    } catch (err) {
      setNotice(`正式投注建立失敗：${err.message}`);
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

      const catchupRes = await fetch(withTs("/api/catchup"), { cache: "no-store" });
      const catchupRaw = await catchupRes.text();

      let catchupData = null;
      try {
        catchupData = JSON.parse(catchupRaw);
      } catch {
        throw new Error(`catchup 回傳非 JSON：${catchupRaw.slice(0, 120)}`);
      }

      if (!catchupData.ok) {
        throw new Error(catchupData.error || catchupData.message || "補抓失敗");
      }

      const latestAfterSync = await syncLatestCore(true);
      await loadRecent20(true);

      let done = 0;
      let learnedCount = 0;

      if (testPlan?.predictionId && Number(latestAfterSync.drawNo || 0) >= Number(testPlan.targetDrawNo || 0)) {
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

      if (formalPlan?.predictionId && Number(latestAfterSync.drawNo || 0) >= Number(formalPlan.targetDrawNo || 0)) {
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

  async function runAutoLoopOnce(fromTimer = false, skipTrain = false) {
    const nowText = getClockText();

    if (isBingoRestTime()) {
      setLoopStatus(`目前為休息時段（00:00~07:29），已暫停自動更新。${nowText}`);
      setNotice(`目前為休息時段（00:00~07:29），系統暫停自動同步與訓練。`);
      return;
    }

    const enabled = await loadSystemConfig(true);

    setLoopStatus(`自動循環執行中：${nowText}${fromTimer ? "（定時）" : "（啟動）"}`);

    try {
      await syncLatest();
    } catch (err) {
      console.error("syncLatest failed:", err);
    }

    try {
      await autoCatchupAndCompare();
    } catch (err) {
      console.error("autoCatchupAndCompare failed:", err);
    }

    if (skipTrain) {
      setAutoStatus("啟動時先不自動訓練，等待你手動開啟。");
    } else if (enabled) {
      try {
        await runAutoTrain();
      } catch (err) {
        console.error("runAutoTrain failed:", err);
      }
    } else {
      setAutoStatus("自動訓練已關閉，本輪僅執行同步 / 補抓 / 比對。");
    }

    setLoopStatus(`自動循環完成：${getClockText()}`);
  }

  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;

    loadSystemConfig(true);
    loadRecent20(true);
    runAutoLoopOnce(false, true);

    const timer = setInterval(() => {
      runAutoLoopOnce(true, false);
    }, 180000);

    return () => clearInterval(timer);
  }, []);

  const trainingProgress = useMemo(() => {
    const history = Array.isArray(autoTrainHistory)
      ? [...autoTrainHistory].sort((a, b) => normalizeNumber(b.comparedAt, 0) - normalizeNumber(a.comparedAt, 0))
      : [];

    const recent10 = history.slice(0, 10);
    const latest5 = history.slice(0, 5);
    const previous5 = history.slice(5, 10);

    const avgOf = (arr, getter) => {
      if (!arr.length) return NaN;
      return arr.reduce((sum, item) => sum + getter(item), 0) / arr.length;
    };

    const avgHit10 = avgOf(recent10, (item) => normalizeNumber(item.totalHitCount, 0));
    const avgReward10 = avgOf(recent10, (item) => normalizeNumber(item.totalReward, 0));
    const avgProfit10 = avgOf(recent10, (item) => normalizeNumber(item.profit, 0));
    const bestHit10 = recent10.length
      ? Math.max(...recent10.map((item) => normalizeNumber(item.bestSingleHit, 0)))
      : 0;

    const latest5AvgHit = avgOf(latest5, (item) => normalizeNumber(item.totalHitCount, 0));
    const previous5AvgHit = avgOf(previous5, (item) => normalizeNumber(item.totalHitCount, 0));

    const latest5AvgReward = avgOf(latest5, (item) => normalizeNumber(item.totalReward, 0));
    const previous5AvgReward = avgOf(previous5, (item) => normalizeNumber(item.totalReward, 0));

    const latest5BestHit = latest5.length
      ? Math.max(...latest5.map((item) => normalizeNumber(item.bestSingleHit, 0)))
      : NaN;
    const previous5BestHit = previous5.length
      ? Math.max(...previous5.map((item) => normalizeNumber(item.bestSingleHit, 0)))
      : NaN;

    return {
      count: history.length,
      avgHit10,
      avgReward10,
      avgProfit10,
      bestHit10,
      hitTrend: buildTrendText("最近 5 次平均命中", latest5AvgHit, previous5AvgHit),
      rewardTrend: buildTrendText("最近 5 次平均中獎", latest5AvgReward, previous5AvgReward),
      bestHitTrend: buildTrendText("最近 5 次最佳單期命中", latest5BestHit, previous5BestHit)
    };
  }, [autoTrainHistory]);

  return (
    <div style={styles.page}>
      <div style={styles.wrap}>
        <section style={styles.hero}>
          <div style={styles.kicker}>FUWEI BINGO SYSTEM</div>
          <h1 style={styles.h1}>富緯賓果系統 v3.6.2 專業 AI 評估版</h1>
          <p style={styles.p}>
            已加入跨裝置共用的自動訓練開關。啟動 APP 時先不同步自動訓練，等你按下開啟後才開始跑。
          </p>

          <div style={styles.notice}>{notice}</div>
          <div style={{ ...styles.notice, marginTop: 12, background: "#0a2440" }}>{autoStatus}</div>
          <div style={{ ...styles.notice, marginTop: 12, background: "#0d2744" }}>{recent20Status}</div>
          <div style={{ ...styles.notice, marginTop: 12, background: "#12345b" }}>{loopStatus}</div>

          <div
            style={{
              ...styles.notice,
              marginTop: 12,
              background: autoTrainEnabled ? "#0b3a21" : "#4a1f1f"
            }}
          >
            自動訓練狀態：{autoTrainEnabled ? "開啟中" : "已關閉"}
          </div>

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

          <div style={styles.btnRow}>
            <button style={styles.primaryBtn} onClick={syncLatest}>同步最新一期</button>
            <button style={styles.secondaryBtn} onClick={autoCatchupAndCompare}>立即補抓補比對</button>
            <button style={styles.secondaryBtn} onClick={startTestMode}>建立測試模式</button>
            <button style={styles.secondaryBtn} onClick={startFormalMode}>建立正式投注</button>
          </div>

          <div style={styles.btnRow}>
            <button
              style={{ ...styles.primaryBtn, background: "#33c46b" }}
              onClick={() => setSystemAutoTrain(true)}
            >
              開啟自動訓練
            </button>
            <button
              style={{ ...styles.primaryBtn, background: "#d9534f", color: "#fff" }}
              onClick={() => setSystemAutoTrain(false)}
            >
              關閉自動訓練
            </button>
          </div>
        </section>

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
          <h2 style={styles.h2}>AI 策略排行榜（專業版）</h2>
          <div style={styles.subtle}>
            勝率已拆成「中獎率」與「盈利率」。平均收益為平均淨損益，ROI 為總淨損益 ÷ 總成本。
          </div>

          {Array.isArray(strategyLeaderboard) && strategyLeaderboard.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              {strategyLeaderboard.map((item, idx) => (
                <div key={item.key} style={styles.groupCard}>
                  <div style={styles.groupTitle}>
                    {idx + 1}️⃣ {item.label}（{item.key}）
                  </div>
                  <div style={styles.subtle}>平均命中：{item.avg_hit}</div>
                  <div style={styles.subtle}>平均收益：{item.avg_profit}</div>
                  <div style={styles.subtle}>中獎率：{item.payout_rate}%</div>
                  <div style={styles.subtle}>盈利率：{item.profit_win_rate}%</div>
                  <div style={styles.subtle}>ROI：{item.roi}%</div>
                  <div style={styles.subtle}>最佳單期命中：{item.best_hit}</div>
                  <div style={styles.subtle}>累計回合：{item.total_rounds}</div>
                  <div style={styles.subtle}>綜合分數：{item.score}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ ...styles.subtle, marginTop: 14 }}>
              目前尚未建立排行榜，先讓系統累積更多 compare 結果。
            </div>
          )}
        </section>

        {autoTrainLast ? (
          <section style={styles.panel}>
            <h2 style={styles.h2}>自動訓練摘要</h2>
            <div style={styles.subtle}>模式：{autoTrainLast.mode || "auto_train_v3"}</div>
            <div style={styles.subtle}>最新期數：第 {autoTrainLast.latest_draw_no ?? "未知"} 期</div>
            <div style={styles.subtle}>每輪比對上限：{autoTrainLast.compare_limit ?? 0} 筆</div>
            <div style={styles.subtle}>每輪新建上限：{autoTrainLast.create_limit ?? 0} 筆</div>
            <div style={styles.subtle}>到期比對：{autoTrainLast.compared_count ?? 0} 筆</div>
            <div style={styles.subtle}>新建訓練：{autoTrainLast.created_count ?? 0} 筆</div>
            <div style={styles.subtle}>最佳單期命中：{autoTrainLast.best_single_hit ?? 0}</div>
            <div style={styles.subtle}>訊息：{autoTrainLast.message || "無"}</div>
          </section>
        ) : null}

        <section style={styles.panel}>
          <h2 style={styles.h2}>訓練進步面板</h2>
          <div style={styles.subtle}>
            顯示最近 10 次訓練成果，觀察系統是否正在朝更高命中與更低虧損前進。
          </div>

          {trainingProgress.count > 0 ? (
            <>
              <div style={styles.progressGrid}>
                <div style={styles.progressCard}>
                  <div style={styles.statLabel}>最近 10 次平均命中</div>
                  <div style={styles.progressValue}>{round1(trainingProgress.avgHit10)} 碼</div>
                </div>

                <div style={styles.progressCard}>
                  <div style={styles.statLabel}>最近 10 次平均中獎</div>
                  <div style={styles.progressValue}>{round1(trainingProgress.avgReward10)} 元</div>
                </div>

                <div style={styles.progressCard}>
                  <div style={styles.statLabel}>最近 10 次平均損益</div>
                  <div style={styles.progressValue}>{round1(trainingProgress.avgProfit10)} 元</div>
                </div>

                <div style={styles.progressCard}>
                  <div style={styles.statLabel}>最近 10 次最佳單期命中</div>
                  <div style={styles.progressValue}>{trainingProgress.bestHit10} 碼</div>
                </div>
              </div>

              <div style={{ marginTop: 18 }}>
                <div style={styles.groupTitle}>最近 5 次是否有進步</div>
                <div style={styles.subtle}>• {trainingProgress.hitTrend}</div>
                <div style={styles.subtle}>• {trainingProgress.rewardTrend}</div>
                <div style={styles.subtle}>• {trainingProgress.bestHitTrend}</div>
              </div>
            </>
          ) : (
            <div style={{ ...styles.subtle, marginTop: 14 }}>
              目前尚未累積到足夠已比對成果。
            </div>
          )}
        </section>

        <section style={styles.panel}>
          <h2 style={styles.h2}>最近 20 期底稿</h2>
          <div style={styles.subtle}>
            固定優先讀取 /api/recent20，供策略生成與補比對使用。
          </div>
          <div style={{ maxHeight: 260, overflow: "auto", marginTop: 12 }}>
            {recent20.map((row, idx) => (
              <div
                key={`${row.draw_no}-${idx}`}
                style={{ ...styles.row, borderBottom: "1px solid rgba(255,255,255,0.08)" }}
              >
                <span>{row.draw_no || "-"}</span>
                <span style={{ fontSize: 12, opacity: 0.8 }}>{row.draw_time || ""}</span>
              </div>
            ))}
          </div>
        </section>

        <div style={styles.grid2}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>測試模式（四星賓果 / 四組 / 二期）</h2>
            {testPlan ? (
              <>
                <div style={styles.subtle}>Prediction ID：{testPlan.predictionId || "尚未寫入"}</div>
                <div style={styles.subtle}>策略模式：{testPlan.strategyMode}</div>
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
                    {testResult.compareDrawRange && (
                      <div style={styles.resultLine}>比對區間：{testResult.compareDrawRange}</div>
                    )}
                    <div style={styles.resultLine}>估計成本：{testResult.totalCost}</div>
                    <div style={styles.resultLine}>估計回收：{testResult.estimatedReturn}</div>
                    <div style={styles.resultLine}>估計損益：{testResult.profit}</div>
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
                <div style={styles.subtle}>策略模式：{formalPlan.strategyMode}</div>
                <div style={styles.subtle}>來源期數：第 {formalPlan.sourceDrawNo} 期</div>
                <div style={styles.subtle}>目標期數：第 {formalPlan.targetDrawNo} 期</div>

                <div style={{ marginTop: 12 }}>
                  <div style={styles.groupTitle}>本次正式下注採用專業 AI 評估前 4 名</div>
                </div>

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
                    {formalResult.compareDrawRange && (
                      <div style={styles.resultLine}>比對區間：{formalResult.compareDrawRange}</div>
                    )}
                    <div style={styles.resultLine}>估計成本：{formalResult.totalCost}</div>
                    <div style={styles.resultLine}>估計回收：{formalResult.estimatedReturn}</div>
                    <div style={styles.resultLine}>估計損益：{formalResult.profit}</div>
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
  grid2: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))",
    gap: 18,
    marginTop: 20
  },
  progressGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
    gap: 14,
    marginTop: 16
  },
  progressCard: {
    background: "#0b203f",
    borderRadius: 20,
    padding: 18
  },
  progressValue: {
    fontSize: 28,
    fontWeight: 800,
    marginTop: 10,
    color: "#ffffff"
  }
};
