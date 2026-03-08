// v1.6 hobby deploy test 2
import React, { useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEYS = {
  latest: "fuwei_bingo_latest_v16_hobby",
  recent20: "fuwei_bingo_recent20_v16_hobby",
  testPlan: "fuwei_bingo_test_plan_v16_hobby",
  formalPlan: "fuwei_bingo_formal_plan_v16_hobby",
  testResult: "fuwei_bingo_test_result_v16_hobby",
  formalResult: "fuwei_bingo_formal_result_v16_hobby",
  autoRunAt: "fuwei_bingo_auto_run_at_v16_hobby"
};

const TXT_LATEST = {
  drawNo: 115013398,
  drawTime: "TXT 匯入",
  numbers: [
    "01", "08", "11", "15", "18", "22", "25", "39", "41", "43",
    "46", "51", "55", "60", "61", "65", "66", "69", "73", "76"
  ],
  source: "3/7 完整 TXT 匯入"
};

const TXT_RECENT20 = [
  { draw_no: 115013398, draw_time: "TXT", numbers: "01 08 11 15 18 22 25 39 41 43 46 51 55 60 61 65 66 69 73 76" },
  { draw_no: 115013397, draw_time: "TXT", numbers: "03 08 13 16 17 20 26 28 31 34 35 37 39 41 42 45 53 55 66 78" },
  { draw_no: 115013396, draw_time: "TXT", numbers: "19 24 26 27 30 32 33 35 37 38 40 47 49 51 57 60 61 62 74 79" },
  { draw_no: 115013395, draw_time: "TXT", numbers: "05 07 09 10 11 13 14 21 22 28 30 37 44 52 55 66 68 69 71 79" },
  { draw_no: 115013394, draw_time: "TXT", numbers: "02 03 07 11 21 22 30 31 33 42 46 49 59 63 64 66 69 71 77 79" }
];

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
  return String(str)
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

function uniquePush(arr, val) {
  if (!arr.includes(val)) arr.push(val);
  return arr;
}

function generateFourGroups(recent20) {
  const candidates = buildCandidates(recent20);
  const top = candidates.slice(0, 20);
  const hot = top.slice(0, 8).map(x => x.num);

  const tails = {};
  top.forEach(x => {
    tails[x.tail] = (tails[x.tail] || 0) + 1;
  });

  const topTail = Object.entries(tails)
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  const sameTailPool = top
    .filter(x => String(x.tail) === String(topTail))
    .map(x => x.num);

  const oddEvenMix = top
    .filter(x => Number(x.num) % 2 === 1)
    .slice(0, 2)
    .map(x => x.num)
    .concat(top.filter(x => Number(x.num) % 2 === 0).slice(0, 2).map(x => x.num));

  const orderedNums = top
    .map(x => Number(x.num))
    .sort((a, b) => a - b);

  const nearGroup = [];
  for (let i = 0; i < orderedNums.length; i++) {
    const n = orderedNums[i];
    if (orderedNums.includes(n + 1)) {
      uniquePush(nearGroup, String(n).padStart(2, "0"));
      uniquePush(nearGroup, String(n + 1).padStart(2, "0"));
    }
    if (nearGroup.length >= 4) break;
  }

  const g1 = hot.slice(0, 4);
  const g2 = sameTailPool.slice(0, 4).length >= 4 ? sameTailPool.slice(0, 4) : hot.slice(2, 6);
  const g3 = oddEvenMix.slice(0, 4);
  const g4 = nearGroup.length >= 4 ? nearGroup.slice(0, 4) : hot.slice(4, 8);

  return [
    { label: "A 熱門主攻組", nums: g1, reason: "近20期熱門號優先" },
    { label: "B 同尾主題組", nums: g2, reason: "近20期強尾數延伸" },
    { label: "C 平衡混合組", nums: g3, reason: "奇偶與熱門平衡" },
    { label: "D 鄰號盤型組", nums: g4, reason: "近20期盤型相鄰結構" }
  ];
}

export default function App() {
  const [latest, setLatest] = useState(() =>
    readLocal(STORAGE_KEYS.latest, TXT_LATEST)
  );
  const [recent20, setRecent20] = useState(() =>
    readLocal(STORAGE_KEYS.recent20, TXT_RECENT20)
  );
  const [syncStatus, setSyncStatus] = useState("尚未同步");
  const [notice, setNotice] = useState("系統已載入歷史底庫，準備接即時資料。");
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

  const autoRanRef = useRef(false);

  useEffect(() => writeLocal(STORAGE_KEYS.latest, latest), [latest]);
  useEffect(() => writeLocal(STORAGE_KEYS.recent20, recent20), [recent20]);
  useEffect(() => writeLocal(STORAGE_KEYS.testPlan, testPlan), [testPlan]);
  useEffect(() => writeLocal(STORAGE_KEYS.formalPlan, formalPlan), [formalPlan]);
  useEffect(() => writeLocal(STORAGE_KEYS.testResult, testResult), [testResult]);
  useEffect(() => writeLocal(STORAGE_KEYS.formalResult, formalResult), [formalResult]);

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
      drawNo: data.latest?.drawNo || "即時同步",
      drawTime: data.capturedAt || data.latest?.drawTime || "即時更新",
      numbers,
      source: "澳所即時同步"
    };

    setLatest(newLatest);

    let saveNotice = "";
    try {
      const saveRes = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numbers })
      });

      const saveData = await saveRes.json();

      if (saveData.ok && saveData.saved) {
        saveNotice = "，並已自動建檔";
      } else if (saveData.ok && saveData.skipped) {
        saveNotice = "，此組號碼已存在資料庫";
      } else {
        saveNotice = "，但建檔未成功";
      }

      if (saveData.ok && Array.isArray(saveData.recent20) && saveData.recent20.length > 0) {
        setRecent20(saveData.recent20);
      }
    } catch {
      saveNotice = "，但建檔失敗";
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
    } catch (err) {
      setSyncStatus(`同步失敗：${err.message}`);
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

  async function comparePrediction(predictionId, drawNumbers) {
    const res = await fetch("/api/prediction-compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        predictionId,
        drawNumbers
      })
    });

    return await res.json();
  }

  async function startTestMode() {
    const groups = generateFourGroups(recent20);
    const plan = {
      mode: "test",
      createdAt: new Date().toISOString(),
      sourceDrawNo: latest.drawNo,
      targetPeriods: 2,
      groups,
      predictionId: null
    };

    try {
      const saved = await savePrediction("test", 2, groups);
      if (saved.ok) {
        plan.predictionId = saved.id;
        setNotice("已建立測試模式，並寫入預測資料庫。");
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
    const groups = generateFourGroups(recent20);
    const plan = {
      mode: "formal",
      createdAt: new Date().toISOString(),
      sourceDrawNo: latest.drawNo,
      targetPeriods: 4,
      groups,
      predictionId: null
    };

    try {
      const saved = await savePrediction("formal", 4, groups);
      if (saved.ok) {
        plan.predictionId = saved.id;
        setNotice("已建立正式投注，並寫入預測資料庫。");
      } else {
        setNotice("已建立正式投注，但預測資料庫寫入失敗。");
      }
    } catch {
      setNotice("已建立正式投注，但預測資料庫寫入失敗。");
    }

    setFormalPlan(plan);
    setFormalResult(null);
  }

  async function compareTestMode() {
    if (!testPlan?.predictionId) {
      setNotice("測試模式尚未建立完成，無法比對。");
      return;
    }

    const data = await comparePrediction(testPlan.predictionId, latest.numbers);
    if (!data.ok) {
      setNotice(`測試模式比對失敗：${data.error || "未知錯誤"}`);
      return;
    }

    setTestResult(data.result);
    setNotice(`測試模式比對完成：${data.result.verdict}`);
  }

  async function compareFormalMode() {
    if (!formalPlan?.predictionId) {
      setNotice("正式投注尚未建立完成，無法比對。");
      return;
    }

    const data = await comparePrediction(formalPlan.predictionId, latest.numbers);
    if (!data.ok) {
      setNotice(`正式投注比對失敗：${data.error || "未知錯誤"}`);
      return;
    }

    setFormalResult(data.result);
    setNotice(`正式投注比對完成：${data.result.verdict}`);
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

      const latestData = await syncLatestCore(true);

      let done = 0;

      if (testPlan?.predictionId) {
        const result = await comparePrediction(testPlan.predictionId, latestData.numbers);
        if (result.ok) {
          setTestResult(result.result);
          done += 1;
        }
      }

      if (formalPlan?.predictionId) {
        const result = await comparePrediction(formalPlan.predictionId, latestData.numbers);
        if (result.ok) {
          setFormalResult(result.result);
          done += 1;
        }
      }

      writeLocal(STORAGE_KEYS.autoRunAt, now);
      setAutoStatus(`補抓補比對完成，已處理 ${done} 筆預測。`);
    } catch (err) {
      setAutoStatus(`補抓補比對失敗：${err.message}`);
    }
  }

  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    autoCatchupAndCompare();
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

  return (
    <div style={styles.page}>
      <div style={styles.wrap}>
        <section style={styles.hero}>
          <div style={styles.kicker}>FUWEI BINGO SYSTEM</div>
          <h1 style={styles.h1}>富緯賓果系統 v1.6 Hobby 補抓版</h1>
          <p style={styles.p}>
            不依賴付費 Cron。你每次打開網站，系統都會自動補抓最新號碼、補存資料、補比對測試結果。
          </p>

          <div style={styles.notice}>{notice}</div>
          <div style={{ ...styles.notice, marginTop: 12, background: "#0a2440" }}>{autoStatus}</div>

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

        <div style={styles.grid2}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>最近 20 期底稿</h2>
            <div style={styles.subtle}>供策略生成與補比對使用</div>
            <div style={{ maxHeight: 220, overflow: "auto", marginTop: 12 }}>
              {recent20.map((row, idx) => (
                <div key={idx} style={{ ...styles.row, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <span>{row.draw_no || "TXT"}</span>
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

        <div style={styles.grid2}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>測試模式（四組四星 / 追 2 期）</h2>
            {testPlan ? (
              <>
                <div style={styles.subtle}>Prediction ID：{testPlan.predictionId || "尚未寫入"}</div>
                {testPlan.groups.map((g, idx) => (
                  <div key={idx} style={styles.groupCard}>
                    <div style={styles.groupTitle}>{g.label}</div>
                    <div style={styles.groupNums}>{g.nums.join(" ")}</div>
                    <div style={styles.subtle}>{g.reason}</div>
                  </div>
                ))}
                <div style={styles.btnRow}>
                  <button style={styles.primaryBtn} onClick={compareTestMode}>用目前最新一期比對測試模式</button>
                </div>
                {testResult && (
                  <div style={styles.resultBox}>
                    <div style={styles.resultLine}>判定：<strong>{testResult.verdict}</strong></div>
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
            <h2 style={styles.h2}>正式投注（四組四星 / 追 4 期）</h2>
            {formalPlan ? (
              <>
                <div style={styles.subtle}>Prediction ID：{formalPlan.predictionId || "尚未寫入"}</div>
                {formalPlan.groups.map((g, idx) => (
                  <div key={idx} style={styles.groupCard}>
                    <div style={styles.groupTitle}>{g.label}</div>
                    <div style={styles.groupNums}>{g.nums.join(" ")}</div>
                    <div style={styles.subtle}>{g.reason}</div>
                  </div>
                ))}
                <div style={styles.btnRow}>
                  <button style={styles.primaryBtn} onClick={compareFormalMode}>用目前最新一期比對正式投注</button>
                </div>
                {formalResult && (
                  <div style={styles.resultBox}>
                    <div style={styles.resultLine}>判定：<strong>{formalResult.verdict}</strong></div>
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
    border: "1px solid rgba(255,255,255,0.06)"
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
  }
};
