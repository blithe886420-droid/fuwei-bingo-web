import React, { useEffect, useMemo, useState } from "react";

const MIRROR_PAIRS = [
  ["01", "10"],
  ["12", "21"],
  ["08", "80"],
  ["27", "72"],
  ["37", "73"],
  ["17", "71"],
];

const STORAGE_KEYS = {
  draws: "fuwei_bingo_draws_v01",
  tickets: "fuwei_bingo_tickets_v01",
  usageStart: "fuwei_bingo_usage_start_v01",
};

const SAMPLE_DRAWS = [
  "01 08 10 12 17 21 27 37 41 45 52 57 61 66 68 71 73 76 79 80",
  "03 07 12 17 21 22 27 31 37 44 46 53 58 63 67 71 72 73 75 78",
  "05 08 10 14 17 19 21 27 28 33 37 42 47 57 60 64 71 73 77 80",
  "02 08 09 12 16 17 21 24 27 37 43 49 54 57 61 68 71 72 73 80",
  "01 06 08 10 17 18 21 27 30 37 40 44 52 56 62 66 71 73 74 80",
];

const IMPORT_STATUS = {
  importedDraws: 1624,
  minDraw: 115011572,
  maxDraw: 115013195,
  source: "TXT 歷史資料匯入",
};

function normalizeNumber(value) {
  const n = String(value).replace(/\D/g, "");
  if (!n) return "";
  const parsed = Number(n);
  if (parsed < 1 || parsed > 80) return "";
  return String(parsed).padStart(2, "0");
}

function parseDraw(text) {
  const nums = text.split(/[^\d]+/).map(normalizeNumber).filter(Boolean);
  const unique = [...new Set(nums)];
  return unique.slice(0, 20);
}

function countMap(draws) {
  const map = {};
  draws.flat().forEach((n) => {
    map[n] = (map[n] || 0) + 1;
  });
  return map;
}

function streakMap(draws) {
  const map = {};
  for (let n = 1; n <= 80; n += 1) {
    const key = String(n).padStart(2, "0");
    let streak = 0;
    for (const draw of draws) {
      if (draw.includes(key)) streak += 1;
      else break;
    }
    map[key] = streak;
  }
  return map;
}

function tail(n) {
  return Number(n) % 10;
}

function buildTailStats(draws) {
  const stats = Array.from({ length: 10 }, (_, i) => ({ tail: i, count: 0 }));
  draws.flat().forEach((n) => {
    stats[tail(n)].count += 1;
  });
  return stats.sort((a, b) => b.count - a.count);
}

function mirrorActivity(draws) {
  return MIRROR_PAIRS.map(([a, b]) => {
    let sameDrawHits = 0;
    let recentHits = 0;
    draws.forEach((draw, idx) => {
      const hasA = draw.includes(a);
      const hasB = draw.includes(b);
      if (hasA && hasB) sameDrawHits += 1;
      if (hasA || hasB) recentHits += Math.max(0, 5 - idx);
    });
    return { a, b, score: sameDrawHits * 30 + recentHits * 5 };
  }).sort((x, y) => y.score - x.score);
}

function getHotScore(freq) {
  return Math.min(100, freq * 20);
}

function getStreakScore(streak) {
  if (streak >= 4) return 100;
  if (streak === 3) return 80;
  if (streak === 2) return 60;
  if (streak === 1) return 20;
  return 0;
}

function buildNeighborTailMap(tailStats) {
  const base = {};
  tailStats.forEach(({ tail, count }) => {
    const left = (tail + 9) % 10;
    const right = (tail + 1) % 10;
    const strength = count >= 8 ? 30 : count >= 6 ? 20 : count >= 4 ? 10 : 0;
    base[left] = Math.max(base[left] || 0, strength);
    base[right] = Math.max(base[right] || 0, strength);
  });
  return base;
}

function buildScores(draws) {
  const freq = countMap(draws);
  const streaks = streakMap(draws);
  const tails = buildTailStats(draws);
  const tailCountMap = Object.fromEntries(tails.map((t) => [t.tail, t.count]));
  const neighborMap = buildNeighborTailMap(tails);
  const mirrors = mirrorActivity(draws);
  const mirrorWeight = {};
  mirrors.forEach(({ a, b, score }) => {
    mirrorWeight[a] = Math.max(mirrorWeight[a] || 0, score >= 40 ? 40 : score >= 20 ? 25 : 10);
    mirrorWeight[b] = Math.max(mirrorWeight[b] || 0, score >= 40 ? 40 : score >= 20 ? 25 : 10);
  });

  const rows = [];
  for (let n = 1; n <= 80; n += 1) {
    const key = String(n).padStart(2, "0");
    const hot = getHotScore(freq[key] || 0);
    if ((freq[key] || 0) === 0) continue;
    const streak = getStreakScore(streaks[key] || 0);
    const t = tail(key);
    const tailScore = Math.min(100, (tailCountMap[t] || 0) * 10);
    const neighbor = neighborMap[t] || 0;
    const mirror = mirrorWeight[key] || 0;
    const total = hot * 0.4 + streak * 0.2 + tailScore * 0.15 + neighbor * 0.1 + mirror * 0.15;
    rows.push({ key, total: Number(total.toFixed(2)) });
  }
  return rows.sort((a, b) => b.total - a.total);
}

function chooseDistinct(sorted, count = 4, avoid = []) {
  const out = [];
  const used = new Set(avoid);
  for (const item of sorted) {
    if (used.has(item.key)) continue;
    out.push(item.key);
    used.add(item.key);
    if (out.length === count) break;
  }
  return out;
}

function buildSuggestions(scores, tailStats, mirrors) {
  const hotGroup = chooseDistinct(scores, 4);
  const topTail = tailStats[0]?.tail;
  const tailNums = scores.filter((s) => tail(s.key) === topTail || tail(s.key) === (topTail + 9) % 10 || tail(s.key) === (topTail + 1) % 10);
  const tailGroup = chooseDistinct(tailNums.length >= 4 ? tailNums : scores, 4, []);

  const topMirror = mirrors[0];
  const mirrorCandidates = scores.filter((s) => [topMirror?.a, topMirror?.b].includes(s.key));
  let mirrorGroup = chooseDistinct(mirrorCandidates, 2, []);
  mirrorGroup = [...mirrorGroup, ...chooseDistinct(scores, 4 - mirrorGroup.length, mirrorGroup)].slice(0, 4);

  const mixed = chooseDistinct(scores, 4, [...hotGroup.slice(0, 2)]);
  const mixedGroup = [...hotGroup.slice(0, 2), ...mixed].slice(0, 4);

  return [
    { name: "熱門主攻組", nums: hotGroup, note: "近 5 期熱號 + 連莊加權" },
    { name: "尾數延伸組", nums: tailGroup, note: `主尾 ${topTail ?? "-"} + 鄰尾擴散` },
    { name: "鏡像主題組", nums: mirrorGroup, note: `鏡像核心 ${topMirror ? `${topMirror.a} ↔ ${topMirror.b}` : "尚無"}` },
    { name: "平衡混合組", nums: mixedGroup, note: "熱門 + 尾數 + 鏡像綜合" },
  ];
}

function evaluateTicket(ticket, draw) {
  return ticket.filter((n) => draw.includes(n));
}

export default function App() {
  const [drawInputs, setDrawInputs] = useState(SAMPLE_DRAWS);
  const [tickets, setTickets] = useState([]);
  const [currentDrawText, setCurrentDrawText] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [liveStatus, setLiveStatus] = useState("尚未連接外部網站");
  const [usageMinutes, setUsageMinutes] = useState(0);

  useEffect(() => {
    const savedDraws = localStorage.getItem(STORAGE_KEYS.draws);
    const savedTickets = localStorage.getItem(STORAGE_KEYS.tickets);
    const started = localStorage.getItem(STORAGE_KEYS.usageStart);
    if (savedDraws) setDrawInputs(JSON.parse(savedDraws));
    if (savedTickets) setTickets(JSON.parse(savedTickets));
    if (!started) localStorage.setItem(STORAGE_KEYS.usageStart, String(Date.now()));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.draws, JSON.stringify(drawInputs));
  }, [drawInputs]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.tickets, JSON.stringify(tickets));
  }, [tickets]);

  useEffect(() => {
    const interval = setInterval(() => {
      const started = Number(localStorage.getItem(STORAGE_KEYS.usageStart) || Date.now());
      setUsageMinutes(Math.floor((Date.now() - started) / 60000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const parsedDraws = useMemo(() => drawInputs.map(parseDraw).filter((row) => row.length > 0), [drawInputs]);
  const scores = useMemo(() => buildScores(parsedDraws), [parsedDraws]);
  const tailStats = useMemo(() => buildTailStats(parsedDraws), [parsedDraws]);
  const mirrors = useMemo(() => mirrorActivity(parsedDraws), [parsedDraws]);
  const suggestions = useMemo(() => buildSuggestions(scores, tailStats, mirrors), [scores, tailStats, mirrors]);

  const handleChangeRow = (idx, value) => setDrawInputs((prev) => prev.map((row, i) => (i === idx ? value : row)));
  const loadSample = () => setDrawInputs(SAMPLE_DRAWS);
  const clearAll = () => setDrawInputs(["", "", "", "", ""]);

  const createTickets = () => {
    const stamp = new Date().toLocaleString("zh-TW");
    const newTickets = suggestions.map((s, idx) => ({
      id: `${Date.now()}-${idx}`,
      name: s.name,
      nums: s.nums,
      note: s.note,
      stage: 1,
      createdAt: stamp,
      status: "追號中",
      hits: [],
    }));
    setTickets(newTickets);
  };

  const runAutoCheck = () => {
    const draw = parseDraw(currentDrawText);
    if (draw.length === 0) return;
    setTickets((prev) =>
      prev.map((ticket) => {
        const matched = evaluateTicket(ticket.nums, draw);
        const nextStage = Math.min(ticket.stage + 1, 4);
        const newHits = [...ticket.hits, { stage: ticket.stage, matched, draw }];
        let status = nextStage >= 4 ? "最後一期 / 完成" : "追號中";
        if (ticket.stage === 3) status = "第 3 期請評估是否換號";
        return { ...ticket, stage: nextStage, status, hits: newHits };
      })
    );
  };

  const simulateConnectLive = () => {
    if (!liveUrl.trim()) {
      setLiveStatus("請先填入外部網站或資料 API 位址");
      return;
    }
    setLiveStatus("已預留連接邏輯。正式版可從外部網站 / API 即時抓號並自動存檔。");
  };

  const topHot = scores.slice(0, 10);
  const usageAlert = usageMinutes >= 50;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <header className="rounded-3xl border border-slate-800 bg-slate-900/80 shadow-2xl p-6 md:p-8">
          <div className="mb-6 rounded-3xl bg-cyan-500/10 border border-cyan-500/20 p-5">
            <div className="mb-4 grid md:grid-cols-4 gap-3 text-sm">
              <div className="rounded-2xl bg-slate-950/60 p-3"><div className="text-slate-400">已匯入期數</div><div className="text-xl font-semibold mt-1">{IMPORT_STATUS.importedDraws}</div></div>
              <div className="rounded-2xl bg-slate-950/60 p-3"><div className="text-slate-400">最早期數</div><div className="text-xl font-semibold mt-1">{IMPORT_STATUS.minDraw}</div></div>
              <div className="rounded-2xl bg-slate-950/60 p-3"><div className="text-slate-400">最新期數</div><div className="text-xl font-semibold mt-1">{IMPORT_STATUS.maxDraw}</div></div>
              <div className="rounded-2xl bg-slate-950/60 p-3"><div className="text-slate-400">來源</div><div className="text-xl font-semibold mt-1">TXT</div></div>
            </div>
            <div className="text-cyan-300 font-semibold">正式版開發四步架構</div>
            <div className="mt-2 grid md:grid-cols-2 xl:grid-cols-4 gap-3 text-sm text-slate-200">
              <div className="rounded-2xl bg-slate-950/60 p-3">1. 匯入 TXT 歷史資料到正式資料結構</div>
              <div className="rounded-2xl bg-slate-950/60 p-3">2. 接上澳所同步抓號模組</div>
              <div className="rounded-2xl bg-slate-950/60 p-3">3. 從 localStorage 升級到正式資料庫</div>
              <div className="rounded-2xl bg-slate-950/60 p-3">4. 前端改讀正式資料來源</div>
            </div>
          </div>
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div>
              <p className="text-sm tracking-[0.25em] uppercase text-amber-400">Fuwei Bingo System</p>
              <h1 className="text-3xl md:text-4xl font-bold mt-2">富緯賓果系統 v0.2 正式版開發原型</h1>
              <p className="text-slate-300 mt-3 max-w-3xl leading-7">已把核心功能做進原型。這一版可以先部署成前端展示網站，之後再接正式後端與資料庫。</p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm min-w-[280px]">
              <div className="rounded-2xl bg-slate-800 p-4"><div className="text-slate-400">主力玩法</div><div className="text-xl font-semibold mt-1">四星</div></div>
              <div className="rounded-2xl bg-slate-800 p-4"><div className="text-slate-400">輸出組數</div><div className="text-xl font-semibold mt-1">4 組</div></div>
              <div className="rounded-2xl bg-slate-800 p-4"><div className="text-slate-400">追號週期</div><div className="text-xl font-semibold mt-1">4 期</div></div>
              <div className={`rounded-2xl p-4 ${usageAlert ? "bg-rose-500/20 border border-rose-500/30" : "bg-slate-800"}`}><div className="text-slate-400">使用時間</div><div className="text-xl font-semibold mt-1">{usageMinutes} 分鐘</div></div>
            </div>
          </div>
        </header>

        {usageAlert && <div className="rounded-3xl bg-rose-500/10 border border-rose-500/20 p-5 text-rose-200">已連續使用系統超過 50 分鐘，建議先休息一下。</div>}

        <section className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 rounded-3xl border border-slate-800 bg-slate-900 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-semibold">最近 5 期輸入區</h2>
              <span className="text-xs rounded-full bg-amber-500/10 text-amber-300 px-3 py-1 border border-amber-500/20">已接上分析邏輯</span>
            </div>
            <div className="space-y-4">
              {drawInputs.map((row, idx) => (
                <div key={idx} className="rounded-2xl bg-slate-800/80 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="font-medium">第 {idx + 1} 期資料</div>
                    <div className="text-xs text-slate-400">輸入 20 顆號碼，系統自動去重與格式化</div>
                  </div>
                  <textarea className="w-full min-h-20 rounded-2xl bg-slate-950 border border-slate-700 px-4 py-3 text-sm outline-none focus:border-amber-400" value={row} onChange={(e) => handleChangeRow(idx, e.target.value)} />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-3 mt-5">
              <button className="rounded-2xl bg-amber-400 text-slate-950 font-semibold px-5 py-3 shadow-lg" onClick={createTickets}>分析並建立 4 組四星</button>
              <button className="rounded-2xl bg-slate-800 border border-slate-700 px-5 py-3" onClick={clearAll}>清空資料</button>
              <button className="rounded-2xl bg-slate-800 border border-slate-700 px-5 py-3" onClick={loadSample}>載入範例</button>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-2xl font-semibold mb-4">即時更新 / 儲存設定</h2>
            <div className="space-y-4 text-sm text-slate-300">
              <div className="rounded-2xl bg-slate-800 p-4">
                <div className="font-semibold text-slate-100 mb-2">本機儲存</div>
                <div>目前已經支援本機 localStorage 儲存：</div>
                <div className="mt-2 text-slate-400">- 最近 5 期資料</div>
                <div className="text-slate-400">- 已建立的四組追號紀錄</div>
                <div className="text-slate-400">- 目前是前端暫存，不是正式資料庫</div>
              </div>
              <div className="rounded-2xl bg-slate-800 p-4">
                <div className="font-semibold text-slate-100 mb-2">外部網站 / API 連接預留</div>
                <div className="text-slate-400 leading-6 mb-3">正式版會以澳所樂透網作為同步來源，並加入 TXT 匯入、缺期補抓與正式資料庫流程。目前已完成 1624 期歷史資料匯入。</div>
                <input className="w-full rounded-2xl bg-slate-950 border border-slate-700 px-4 py-3 outline-none focus:border-amber-400" placeholder="填入外部網站或 API 位址，例如你的資料來源" value={liveUrl} onChange={(e) => setLiveUrl(e.target.value)} />
                <button className="mt-3 w-full rounded-2xl bg-slate-950 border border-slate-700 px-4 py-3 font-medium" onClick={simulateConnectLive}>模擬連接即時更新</button>
                <div className="mt-3 text-slate-400 leading-6">{liveStatus}</div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid xl:grid-cols-3 gap-6">
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-6">
            <h3 className="text-xl font-semibold mb-4">熱門號排行</h3>
            <div className="space-y-3">{topHot.map((n, i) => <div key={n.key} className="flex items-center justify-between rounded-2xl bg-slate-800 px-4 py-3"><div className="flex items-center gap-3"><div className="w-8 h-8 rounded-full bg-amber-400 text-slate-950 font-bold flex items-center justify-center text-sm">{i + 1}</div><div className="text-lg font-semibold">{n.key}</div></div><div className="text-sm text-slate-400">總分 {n.total}</div></div>)}</div>
          </div>
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-6">
            <h3 className="text-xl font-semibold mb-4">尾數 / 鄰尾分析</h3>
            <div className="space-y-4">{tailStats.slice(0,4).map((item) => <div key={item.tail} className="rounded-2xl bg-slate-800 p-4"><div className="flex items-center justify-between"><div><div className="text-slate-400 text-sm">活躍尾數</div><div className="text-2xl font-bold mt-1">尾 {item.tail}</div></div><div className="text-right"><div className="text-slate-400 text-sm">近 5 期次數</div><div className="text-xl font-semibold">{item.count}</div></div></div><div className="mt-3 text-sm text-slate-300">鄰尾觀察：{(item.tail + 9) % 10} / {(item.tail + 1) % 10}</div></div>)}</div>
          </div>
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-6">
            <h3 className="text-xl font-semibold mb-4">鏡像規則活躍度</h3>
            <div className="space-y-3">{mirrors.map((m)=><div key={`${m.a}-${m.b}`} className="rounded-2xl bg-slate-800 p-4 flex items-center justify-between"><div className="text-lg font-semibold">{m.a} ↔ {m.b}</div><div className="text-sm text-slate-400">分數 {m.score}</div></div>)}</div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-900 p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-5"><div><h2 className="text-2xl font-semibold">四星建議組合</h2><p className="text-slate-400 mt-1">固定輸出 4 組。你一旦按下分析建立，系統就視為已下注並開始四期追號。</p></div><div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 px-4 py-2 text-sm">冷號已排除，不進候選池</div></div>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">{suggestions.map((line)=><div key={line.name} className="rounded-3xl bg-slate-800 p-5 shadow-xl"><div className="text-sm text-amber-300 mb-2">{line.name}</div><div className="text-3xl font-bold tracking-wide">{line.nums.join(" ")}</div><div className="text-sm text-slate-400 mt-3 leading-6">{line.note}</div></div>)}</div>
        </section>

        <section className="grid xl:grid-cols-2 gap-6">
          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-2xl font-semibold mb-4">追號紀錄 / 自動兌獎</h2>
            <div className="mb-4 rounded-2xl bg-slate-800 p-4"><div className="font-medium mb-2">輸入最新一期開獎號碼後，自動對號</div><textarea className="w-full min-h-20 rounded-2xl bg-slate-950 border border-slate-700 px-4 py-3 text-sm outline-none focus:border-amber-400" value={currentDrawText} onChange={(e)=>setCurrentDrawText(e.target.value)} /><button className="mt-3 rounded-2xl bg-amber-400 text-slate-950 font-semibold px-5 py-3" onClick={runAutoCheck}>自動對號並推進期數</button></div>
            <div className="overflow-hidden rounded-3xl border border-slate-800"><div className="grid grid-cols-4 bg-slate-800 text-sm font-semibold"><div className="p-3">組別</div><div className="p-3">四星號碼</div><div className="p-3">目前期數</div><div className="p-3">狀態</div></div>{tickets.length === 0 ? <div className="p-6 text-slate-400">還沒有建立追號紀錄。先按「分析並建立 4 組四星」。</div> : tickets.map((ticket, idx)=><div key={ticket.id} className="grid grid-cols-4 border-t border-slate-800 text-sm"><div className="p-3">{String.fromCharCode(65 + idx)}</div><div className="p-3">{ticket.nums.join(" ")}</div><div className="p-3">第 {ticket.stage} / 4 期</div><div className="p-3">{ticket.status}</div></div>)}</div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-2xl font-semibold mb-4">主動提醒中心</h2>
            <div className="space-y-4">
              <div className="rounded-3xl bg-amber-500/10 border border-amber-500/20 p-5"><div className="text-amber-300 font-semibold">第 3 期評估提醒</div><p className="text-slate-200 mt-2 leading-7">正式邏輯已接上：當追號進入第 3 期，狀態會自動標記為「第 3 期請評估是否換號」。</p></div>
              <div className="rounded-3xl bg-emerald-500/10 border border-emerald-500/20 p-5"><div className="text-emerald-300 font-semibold">自動儲存</div><p className="text-slate-200 mt-2 leading-7">關掉頁面再開，最近 5 期與追號紀錄仍會保留。正式版會再改成真正資料庫。</p></div>
              <div className="rounded-3xl bg-sky-500/10 border border-sky-500/20 p-5"><div className="text-sky-300 font-semibold">外部網站即時更新</div><p className="text-slate-200 mt-2 leading-7">前一版還沒有真的接外部資料源。下一步只要有固定來源網址或 API，就能接成真正的即時抓號。</p></div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
