import React, { useEffect, useMemo, useState } from "react";

const STORAGE_KEYS = {
  latest: "fuwei_bingo_latest_v09",
  recent20: "fuwei_bingo_recent20_v09",
  testPlan: "fuwei_bingo_test_plan_v09",
  formalPlan: "fuwei_bingo_formal_plan_v09",
  testResult: "fuwei_bingo_test_result_v09"
};

const TXT_LATEST = {
  drawNo: 115013398,
  drawTime: "TXT 匯入",
  numbers: [
    "01","08","11","15","18","22","25","39","41","43",
    "46","51","55","60","61","65","66","69","73","76"
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
  const rows = Object.entries(freq)
    .map(([num, count]) => ({
      num,
      count,
      tail: tail(num)
    }))
    .sort((a, b) => b.count - a.count || Number(a.num) - Number(b.num));

  return rows;
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
    .concat(
      top.filter(x => Number(x.num) % 2 === 0).slice(0, 2).map(x => x.num)
    );

  const sequentialHint = top
    .map(x => Number(x.num))
    .sort((a, b) => a - b);

  const nearGroup = [];
  for (let i = 0; i < sequentialHint.length; i++) {
    const n = sequentialHint[i];
    if (sequentialHint.includes(n + 1)) {
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

function calcHit(groupNums, drawNums) {
  const set = new Set(drawNums);
  return groupNums.filter(n => set.has(n));
}

function calcPlanResult(plan, drawText) {
  const drawNums = parseNumbers(drawText);
  const perBetCost = 4 * 25; // 四星一組 25，四組=100，純示意
  const periodCost = plan.groups.length * 25;
  const totalCost = plan.targetPeriods * periodCost;

  const results = plan.groups.map(g => {
    const hits = calcHit(g.nums, drawNums);
    return {
      label: g.label,
      nums: g.nums,
      hits,
      hitCount: hits.length
    };
  });

  const totalHitCount = results.reduce((sum, r) => sum + r.hitCount, 0);

  // 先用保守測試規則：每組中2碼以上視為有效訊號
  const effectiveGroups = results.filter(r => r.hitCount >= 2).length;
  const estimatedReturn = effectiveGroups * 100;
  const profit = estimatedReturn - totalCost;

  return {
    drawNums,
    results,
    totalCost,
    estimatedReturn,
    profit,
    verdict:
      profit > 0
        ? "小贏以上"
        : profit === 0
        ? "打平"
        : profit >= -50
        ? "接近成本"
        : "被咬"
  };
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

  const [testPlan, setTestPlan] = useState(() =>
    readLocal(STORAGE_KEYS.testPlan, null)
  );
  const [formalPlan, setFormalPlan] = useState(() =>
    readLocal(STORAGE_KEYS.formalPlan, null)
  );
  const [testResult, setTestResult] = useState(() =>
    readLocal(STORAGE_KEYS.testResult, null)
  );

  const [manualDraw, setManualDraw] = useState("");

  useEffect(() => {
    writeLocal(STORAGE_KEYS.latest, latest);
  }, [latest]);

  useEffect(() => {
    writeLocal(STORAGE_KEYS.recent20, recent20);
  }, [recent20]);

  useEffect(() => {
    writeLocal(STORAGE_KEYS.testPlan, testPlan);
  }, [testPlan]);

  useEffect(() => {
    writeLocal(STORAGE_KEYS.formalPlan, formalPlan);
  }, [formalPlan]);

  useEffect(() => {
    writeLocal(STORAGE_KEYS.testResult, testResult);
  }, [testResult]);

  async function syncLatest() {
    try {
      setSyncStatus("同步中...");
      const res = await fetch("/api/sync");
      const data = await res.json();

      if (!data.ok) {
        setSyncStatus(`同步失敗：${data.error || "未知錯誤"}`);
        return;
      }

      const latestBlock = data.latest || {};
      const numbers = Array.isArray(latestBlock.numbers)
        ? latestBlock.numbers
        : [];

      if (numbers.length > 0) {
        setLatest({
          drawNo: latestBlock.drawNo || "即時同步",
          drawTime: latestBlock.drawTime || "即時更新",
          numbers,
          source: "澳所即時同步"
        });
      }

      if (Array.isArray(data.recent20) && data.recent20.length > 0) {
        setRecent20(data.recent20);
      }

      setSyncStatus("已同步最新資料");
      setNotice("已抓到最新一期與最近20期，可直接進行測試模式或正式投注。");
    } catch (err) {
      setSyncStatus(`同步失敗：${err.message}`);
    }
  }

  function startTestMode() {
    const groups = generateFourGroups(recent20);
    const plan = {
      mode: "test",
      createdAt: new Date().toISOString(),
      sourceDrawNo: latest.drawNo,
      targetPeriods: 2,
      groups
    };
    setTestPlan(plan);
    setNotice("已建立測試模式：四組四星，先追 2 期。");
  }

  function startFormalMode() {
    const groups = generateFourGroups(recent20);
    const plan = {
      mode: "formal",
      createdAt: new Date().toISOString(),
      sourceDrawNo: latest.drawNo,
      targetPeriods: 4,
      groups
    };
    setFormalPlan(plan);
    setNotice("已建立正式投注：四組四星，追 4 期。");
  }

  function evaluateTestPlan() {
    if (!testPlan) {
      setNotice("尚未建立測試模式。");
      return;
    }
    if (!manualDraw.trim()) {
      setNotice("請先輸入最新一期 20 顆號碼，再進行對號。");
      return;
    }

    const result = calcPlanResult(testPlan, manualDraw);
    setTestResult(result);

    if (result.verdict === "小贏以上" || result.verdict === "接近成本") {
      setNotice(`測試結果：${result.verdict}，可考慮按下正式投注。`);
    } else {
      setNotice(`測試結果：${result.verdict}，建議保守觀察。`);
    }
  }

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
          <h1 style={styles.h1}>富緯賓果系統 v1.0 雙模式版</h1>
          <p style={styles.p}>
            A 保留 TXT 歷史底庫，B 接上澳所即時同步。現在可先同步最新一期，再選擇「測試模式」或「直接正式投注」。
          </p>

          <div style={styles.notice}>{notice}</div>

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
              <div style={styles.statValue}>{latest.source || "TXT 底庫"}</div>
            </div>

            <div style={styles.statCard}>
              <div style={styles.statLabel}>同步狀態</div>
              <div style={styles.statValue}>{syncStatus}</div>
            </div>
          </div>

          <div style={styles.btnRow}>
            <button style={styles.primaryBtn} onClick={syncLatest}>
              同步最新一期
            </button>
            <button style={styles.secondaryBtn} onClick={startTestMode}>
              測試模式
            </button>
            <button style={styles.secondaryBtn} onClick={startFormalMode}>
              直接正式投注
            </button>
          </div>
        </section>

        <div style={styles.grid2}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>最新一期資訊</h2>
            <div style={styles.subtle}>
              {latest.drawNo ? `第 ${latest.drawNo} 期` : "即時同步"} / {latest.drawTime || "未提供時間"}
            </div>
            <div style={styles.numbersWrap}>
              {latest.numbers?.map((n, i) => (
                <span key={i} style={styles.numBall}>{n}</span>
              ))}
            </div>
            <div style={styles.subtle}>來源：{latest.source || "TXT"}</div>
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
            <h2 style={styles.h2}>區段統計</h2>
            {sectionStats.map(([label, count]) => (
              <div key={label} style={styles.row}>
                <span>{label}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>最近 20 期底稿</h2>
            <div style={styles.subtle}>供測試模式 / 正式投注生成四星號碼使用</div>
            <div style={{ maxHeight: 220, overflow: "auto", marginTop: 12 }}>
              {recent20.map((row, idx) => (
                <div key={idx} style={{ ...styles.row, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <span>{row.draw_no || "TXT"}</span>
                  <span style={{ fontSize: 12, opacity: 0.8 }}>{row.draw_time || ""}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div style={styles.grid2}>
          <section style={styles.panel}>
            <h2 style={styles.h2}>測試模式（四組四星 / 追 2 期）</h2>
            {testPlan ? (
              <>
                {testPlan.groups.map((g, idx) => (
                  <div key={idx} style={styles.groupCard}>
                    <div style={styles.groupTitle}>{g.label}</div>
                    <div style={styles.groupNums}>{g.nums.join(" ")}</div>
                    <div style={styles.subtle}>{g.reason}</div>
                  </div>
                ))}
              </>
            ) : (
              <div style={styles.subtle}>尚未建立測試模式。</div>
            )}
          </section>

          <section style={styles.panel}>
            <h2 style={styles.h2}>正式投注（四組四星 / 追 4 期）</h2>
            {formalPlan ? (
              <>
                {formalPlan.groups.map((g, idx) => (
                  <div key={idx} style={styles.groupCard}>
                    <div style={styles.groupTitle}>{g.label}</div>
                    <div style={styles.groupNums}>{g.nums.join(" ")}</div>
                    <div style={styles.subtle}>{g.reason}</div>
                  </div>
                ))}
              </>
            ) : (
              <div style={styles.subtle}>尚未建立正式投注。</div>
            )}
          </section>
        </div>

        <section style={styles.panel}>
          <h2 style={styles.h2}>自動對號 / 損益評估</h2>
          <div style={styles.subtle}>
            輸入最新一期 20 顆號碼後，可先對「測試模式」做損益判斷；若接近成本或小贏，再按正式投注。
          </div>

          <textarea
            value={manualDraw}
            onChange={(e) => setManualDraw(e.target.value)}
            placeholder="請輸入最新一期 20 顆號碼，例如：11 12 13 18 21 30 32 35 41 45 52 57 58 59 61 63 64 71 77 79"
            style={styles.textarea}
          />

          <div style={styles.btnRow}>
            <button style={styles.primaryBtn} onClick={evaluateTestPlan}>
              對測試模式進行對號 / 損益計算
            </button>
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
        </section>
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
  textarea: {
    width: "100%",
    minHeight: 120,
    marginTop: 16,
    borderRadius: 18,
    padding: 16,
    fontSize: 18,
    background: "#041126",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.12)",
    boxSizing: "border-box"
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
