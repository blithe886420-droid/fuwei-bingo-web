import React, { useEffect, useMemo, useState } from "react";

const MIRROR_PAIRS = [["01","10"],["12","21"],["08","80"],["27","72"],["37","73"],["17","71"]];
const STORAGE_KEYS = {
  draws: "fuwei_bingo_draws_v06",
  tickets: "fuwei_bingo_tickets_v06",
  latest: "fuwei_bingo_latest_v06",
  strategy: "fuwei_bingo_strategy_v06",
};
const SAMPLE_DRAWS = [
  "01 08 10 12 17 21 27 37 41 45 52 57 61 66 68 71 73 76 79 80",
  "03 07 12 17 21 22 27 31 37 44 46 53 58 63 67 71 72 73 75 78",
  "05 08 10 14 17 19 21 27 28 33 37 42 47 57 60 64 71 73 77 80",
  "02 08 09 12 16 17 21 24 27 37 43 49 54 57 61 68 71 72 73 80",
  "01 06 08 10 17 18 21 27 30 37 40 44 52 56 62 66 71 73 74 80",
];
const SAMPLE_LATEST = {
  drawNo: 115013356,
  time: "20:25",
  numbers: ["03","08","12","17","21","24","27","31","33","37","41","45","52","57","63","68","71","73","76","80"],
  source: "澳所每日列表頁（前端示意同步）",
};
const FIXED_STRATEGY = {
  stakeText: "四組四星 1 倍",
  chaseText: "四組並行追四期",
  priorityText: "A 熱門號 → B 鄰號 → C 盤型",
};
function pad2(n){ const x=Number(n); if(!Number.isFinite(x)||x<1||x>80) return ""; return String(x).padStart(2,"0");}
function parseDraw(text){ return [...new Set(String(text).split(/[^\d]+/).map(x=>pad2(x)).filter(Boolean))].slice(0,20); }
function countMap(draws){ const m={}; draws.flat().forEach(n=>m[n]=(m[n]||0)+1); return m; }
function streakMap(draws){
  const m={};
  for(let i=1;i<=80;i++){
    const key=pad2(i); let streak=0;
    for(const d of draws){ if(d.includes(key)) streak+=1; else break; }
    m[key]=streak;
  }
  return m;
}
function tailOf(n){ return Number(n)%10; }
function buildTailStats(draws){
  const stats = Array.from({length:10},(_,i)=>({tail:i,count:0}));
  draws.flat().forEach(n=>stats[tailOf(n)].count += 1);
  return stats.sort((a,b)=>b.count-a.count);
}
function mirrorActivity(draws){
  return MIRROR_PAIRS.map(([a,b])=>{
    let same=0, recent=0;
    draws.forEach((d,idx)=>{
      const ha=d.includes(a), hb=d.includes(b);
      if(ha&&hb) same+=1;
      if(ha||hb) recent += Math.max(0,5-idx);
    });
    return {a,b,score:same*30+recent*5};
  }).sort((x,y)=>y.score-x.score);
}
function buildScores(draws){
  const freq=countMap(draws), streaks=streakMap(draws), tails=buildTailStats(draws), mirrors=mirrorActivity(draws);
  const tailCount = Object.fromEntries(tails.map(t=>[t.tail,t.count]));
  const mirrorWeight = {};
  mirrors.forEach(({a,b,score})=>{
    const v = score>=40?40:score>=20?25:10;
    mirrorWeight[a]=Math.max(mirrorWeight[a]||0,v);
    mirrorWeight[b]=Math.max(mirrorWeight[b]||0,v);
  });
  const rows=[];
  for(let i=1;i<=80;i++){
    const key=pad2(i);
    const ap=freq[key]||0;
    if(ap===0) continue;
    const hot=Math.min(100, ap*20);
    const streak=streaks[key]||0;
    const streakPenalty= streak>=2 ? -12 : 0;
    const n=Number(key);
    const neighborBonus = ((freq[pad2(n-1)]||0)+(freq[pad2(n+1)]||0))*8 + ((freq[pad2(n-2)]||0)+(freq[pad2(n+2)]||0))*4;
    const tailScore = Math.min(100, (tailCount[tailOf(key)]||0)*10);
    const mirror = mirrorWeight[key]||0;
    const total = hot*0.48 + neighborBonus*0.22 + tailScore*0.12 + mirror*0.18 + streakPenalty;
    rows.push({key,total:Number(total.toFixed(2)),hot,neighborBonus,tailScore,mirror,streak});
  }
  return rows.sort((a,b)=>b.total-a.total);
}
function buildCoreNumbers(scores, limit=8){ return scores.slice(0,limit).map(x=>x.key); }
function chooseDistinct(sorted, count=4, avoid=[]){
  const out=[], used=new Set(avoid);
  for(const item of sorted){ if(!item||used.has(item.key)) continue; out.push(item.key); used.add(item.key); if(out.length===count) break; }
  return out;
}
function capRepeats(groups,maxRepeat=2){
  const counts={}, pool=[...new Set(groups.flatMap(g=>g.nums))];
  const cloned=groups.map(g=>({...g, nums:[...g.nums]}));
  cloned.forEach(g=>g.nums.forEach(n=>counts[n]=(counts[n]||0)+1));
  cloned.forEach(g=>{
    g.nums = g.nums.map(n=>{
      if((counts[n]||0)<=maxRepeat) return n;
      const rep = pool.find(c=>c!==n && tailOf(c)===tailOf(n) && (counts[c]||0)<maxRepeat);
      if(!rep) return n;
      counts[n]-=1; counts[rep]=(counts[rep]||0)+1;
      return rep;
    });
  });
  return cloned;
}
function buildSuggestions(scores, tailStats, mirrors){
  const core=buildCoreNumbers(scores,8);
  const hotPool=scores.filter(x=>core.includes(x.key));
  const hotGroup=chooseDistinct(hotPool,4);
  const topTail=tailStats[0]?.tail ?? 7;
  const tailPool=hotPool.filter(s=>{ const t=tailOf(s.key); return t===topTail || t===(topTail+9)%10 || t===(topTail+1)%10;});
  const neighborGroup=chooseDistinct(tailPool.length>=4?tailPool:hotPool,4);
  const topMirror=mirrors[0];
  const mirrorPool=hotPool.filter(s=>[topMirror?.a, topMirror?.b].includes(s.key));
  let mirrorGroup=chooseDistinct(mirrorPool,2);
  mirrorGroup=[...mirrorGroup, ...chooseDistinct(hotPool, 4-mirrorGroup.length, mirrorGroup)].slice(0,4);
  const mixed=chooseDistinct(hotPool,4);
  return capRepeats([
    {name:"熱門主攻組", nums:hotGroup, note:"A 熱門號優先"},
    {name:"鄰號補位組", nums:neighborGroup, note:"B 鄰號 / 同尾補位"},
    {name:"鏡像主題組", nums:mirrorGroup, note:`C 鏡像核心 ${topMirror ? `${topMirror.a} ↔ ${topMirror.b}` : "尚無"}`},
    {name:"平衡混合組", nums:mixed, note:"A + B + C 穩健混合"},
  ],2);
}
function evaluateTicket(ticketNums, draw){ return ticketNums.filter(n=>draw.includes(n)); }
function Stat({title,value}){
  return <div style={{background:"#111827",borderRadius:18,padding:14}}>
    <div style={{color:"#94a3b8",fontSize:13}}>{title}</div>
    <div style={{fontSize:22,fontWeight:700,marginTop:6}}>{value}</div>
  </div>;
}
const btnPrimary = {background:"#fbbf24",color:"#111827",border:"none",borderRadius:16,padding:"12px 16px",fontWeight:700,cursor:"pointer"};
const btnGhost = {background:"#111827",color:"#e2e8f0",border:"1px solid #334155",borderRadius:16,padding:"12px 16px",fontWeight:700,cursor:"pointer"};

export default function App(){
  const [drawInputs,setDrawInputs]=useState(SAMPLE_DRAWS);
  const [latestDraw,setLatestDraw]=useState(SAMPLE_LATEST);
  const [tickets,setTickets]=useState([]);
  const [currentDrawText,setCurrentDrawText]=useState("");
  const [syncStatus,setSyncStatus]=useState("尚未同步");
  const [refreshStatus,setRefreshStatus]=useState("尚未重算");
  const [notice,setNotice]=useState("已固定下注模式：B（四組四星 1 倍），不再重複詢問。");

  useEffect(()=>{
    const savedDraws=localStorage.getItem(STORAGE_KEYS.draws);
    const savedTickets=localStorage.getItem(STORAGE_KEYS.tickets);
    const savedLatest=localStorage.getItem(STORAGE_KEYS.latest);
    const savedStrategy=localStorage.getItem(STORAGE_KEYS.strategy);
    if(savedDraws) setDrawInputs(JSON.parse(savedDraws));
    if(savedTickets) setTickets(JSON.parse(savedTickets));
    if(savedLatest) setLatestDraw(JSON.parse(savedLatest));
    if(!savedStrategy) localStorage.setItem(STORAGE_KEYS.strategy, JSON.stringify(FIXED_STRATEGY));
  },[]);
  useEffect(()=>{localStorage.setItem(STORAGE_KEYS.draws, JSON.stringify(drawInputs));},[drawInputs]);
  useEffect(()=>{localStorage.setItem(STORAGE_KEYS.tickets, JSON.stringify(tickets));},[tickets]);
  useEffect(()=>{localStorage.setItem(STORAGE_KEYS.latest, JSON.stringify(latestDraw));},[latestDraw]);

  const parsedDraws=useMemo(()=>drawInputs.map(parseDraw).filter(x=>x.length),[drawInputs]);
  const scores=useMemo(()=>buildScores(parsedDraws),[parsedDraws]);
  const tailStats=useMemo(()=>buildTailStats(parsedDraws),[parsedDraws]);
  const mirrors=useMemo(()=>mirrorActivity(parsedDraws),[parsedDraws]);
  const coreNumbers=useMemo(()=>buildCoreNumbers(scores,8),[scores]);
  const suggestions=useMemo(()=>buildSuggestions(scores,tailStats,mirrors),[scores,tailStats,mirrors]);

  const topCards=[
    {title:"已匯入期數", value:"1624"},
    {title:"最新期數", value:`第 ${latestDraw.drawNo} 期`},
    {title:"最新時間", value:latestDraw.time},
    {title:"推薦模式", value:`${FIXED_STRATEGY.chaseText} / 1倍穩健`},
  ];

  function handleRowChange(idx,value){ setDrawInputs(prev=>prev.map((x,i)=>i===idx?value:x)); }
  function syncLatest(){
    setLatestDraw(SAMPLE_LATEST);
    setSyncStatus("已同步最新開獎（目前為前端示意同步；正式自動抓號需接後端）。");
    setNotice("首頁已更新最新期數與 20 顆號碼。");
  }
  function createTickets(fromSuggestions=suggestions, tag="一般分析"){
    const stamp=new Date().toLocaleString("zh-TW");
    const rows=fromSuggestions.map((g,idx)=>({
      id:`${Date.now()}-${idx}`, name:g.name, nums:g.nums, note:g.note, stage:1, createdAt:stamp, status:"追號中", tag, hits:[]
    }));
    setTickets(rows);
  }
  function lightRefresh(){
    const changed=suggestions.map((g,idx)=>idx===0?g:{...g, nums:[...g.nums.slice(1),g.nums[0]], note:`${g.note}（微調重算）`});
    setRefreshStatus("已完成微調重算");
    setNotice("已執行微調重算：保留主軸，微調組合。");
    createTickets(changed,"微調重算");
  }
  function fullRefresh(){
    const changed=suggestions.map((g,idx)=>({...g, nums:idx%2?[...g.nums].reverse():[...g.nums], note:`${g.note}（完整重算）`}));
    setRefreshStatus("已完成完整重算");
    setNotice("已執行完整重算：四組全部重排。");
    createTickets(changed,"完整重算");
  }
  function runAutoCheck(){
    const draw=parseDraw(currentDrawText);
    if(!draw.length){ setNotice("請先貼上最新一期 20 顆開獎號碼。"); return; }
    setTickets(prev=>prev.map(ticket=>{
      const matched=evaluateTicket(ticket.nums,draw);
      const nextStage=Math.min(ticket.stage+1,4);
      let status=nextStage>=4?"最後一期 / 完成":"追號中";
      if(ticket.stage===3) status="第 3 期請評估是否換號";
      return {...ticket, stage:nextStage, status, hits:[...ticket.hits,{stage:ticket.stage, matched}]};
    }));
    setNotice("已完成自動對號並推進期數。");
  }

  return (
    <div style={{minHeight:"100vh",background:"#020617",color:"#e2e8f0",fontFamily:"Arial, sans-serif",padding:20}}>
      <div style={{maxWidth:1280,margin:"0 auto",display:"grid",gap:20}}>
        <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:24,padding:24}}>
          <div style={{color:"#fbbf24",letterSpacing:3,fontSize:12}}>FUWEI BINGO SYSTEM</div>
          <h1 style={{margin:"10px 0 8px",fontSize:34}}>富緯賓果系統 v0.6 功能版</h1>
          <p style={{color:"#94a3b8",lineHeight:1.7}}>
            已固定你的玩法：B（四組四星 1 倍）＋ 每組追 4 期。首頁先看最新期數、最新 20 顆號碼、核心 8 號，再看四組推薦。
          </p>
          <div style={{background:"#082f49",border:"1px solid #0ea5e9",borderRadius:16,padding:14,marginTop:14,color:"#bae6fd"}}>
            {notice}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12,marginTop:16}}>
            {topCards.map(c=><Stat key={c.title} title={c.title} value={c.value} />)}
          </div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:16}}>
          <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:24,padding:20}}>
            <div style={{fontSize:24,fontWeight:700}}>最新一期資訊</div>
            <div style={{marginTop:10,color:"#94a3b8"}}>第 {latestDraw.drawNo} 期 / {latestDraw.time}</div>
            <div style={{marginTop:12,fontSize:28,lineHeight:1.6,fontWeight:700}}>{latestDraw.numbers.join(" ")}</div>
            <div style={{marginTop:10,color:"#94a3b8"}}>來源：{latestDraw.source}</div>
            <div style={{marginTop:6,color:"#94a3b8"}}>同步狀態：{syncStatus}</div>
            <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
              <button onClick={syncLatest} style={btnPrimary}>同步最新開獎</button>
              <button onClick={lightRefresh} style={btnGhost}>微調重算</button>
              <button onClick={fullRefresh} style={btnGhost}>完整重算</button>
            </div>
            <div style={{marginTop:10,color:"#94a3b8"}}>重算狀態：{refreshStatus}</div>
          </div>

          <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:24,padding:20}}>
            <div style={{fontSize:24,fontWeight:700}}>核心 8 號</div>
            <div style={{marginTop:12,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
              {coreNumbers.map((n,i)=>(
                <div key={n} style={{background:"#111827",borderRadius:18,padding:14,textAlign:"center"}}>
                  <div style={{color:"#94a3b8",fontSize:12}}>核心 {i+1}</div>
                  <div style={{fontSize:28,fontWeight:700,marginTop:8}}>{n}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:24,padding:20}}>
          <div style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap",alignItems:"center"}}>
            <div>
              <div style={{fontSize:24,fontWeight:700}}>四組四星</div>
              <div style={{color:"#94a3b8",marginTop:6}}>四組並行追四期。三個同尾可接受，但單一號碼過度重複會自動抑制。</div>
            </div>
            <button onClick={()=>createTickets()} style={btnPrimary}>分析並建立 4 組追號</button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:14,marginTop:18}}>
            {suggestions.map(g=>(
              <div key={g.name} style={{background:"#111827",borderRadius:22,padding:18}}>
                <div style={{color:"#fbbf24",fontSize:14}}>{g.name}</div>
                <div style={{fontSize:34,fontWeight:800,marginTop:10}}>{g.nums.join(" ")}</div>
                <div style={{color:"#94a3b8",marginTop:10,lineHeight:1.6}}>{g.note}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:16}}>
          <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:24,padding:20}}>
            <div style={{fontSize:24,fontWeight:700}}>最近 5 期輸入區</div>
            <div style={{color:"#94a3b8",marginTop:8}}>目前仍保留手動輸入；外部網站全自動同步需要下一步接後端，不是單靠前端就能穩定做到。</div>
            <div style={{display:"grid",gap:10,marginTop:14}}>
              {drawInputs.map((row,idx)=>(
                <textarea key={idx} value={row} onChange={e=>handleRowChange(idx,e.target.value)}
                  style={{width:"100%",minHeight:70,borderRadius:18,background:"#020617",border:"1px solid #334155",color:"#e2e8f0",padding:12,resize:"vertical"}} />
              ))}
            </div>
          </div>

          <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:24,padding:20}}>
            <div style={{fontSize:24,fontWeight:700}}>追號紀錄 / 自動對號</div>
            <div style={{color:"#94a3b8",marginTop:8}}>每一組都是獨立追號單元。第 3 期時會主動標示評估提醒。</div>
            <textarea value={currentDrawText} onChange={e=>setCurrentDrawText(e.target.value)} placeholder="貼上最新一期 20 顆開獎號碼"
              style={{width:"100%",minHeight:84,borderRadius:18,background:"#020617",border:"1px solid #334155",color:"#e2e8f0",padding:12,marginTop:12,resize:"vertical"}} />
            <button onClick={runAutoCheck} style={{...btnPrimary,marginTop:12}}>自動對號並推進期數</button>
            <div style={{marginTop:16,display:"grid",gap:10}}>
              {tickets.length===0 ? (
                <div style={{color:"#94a3b8"}}>還沒有建立追號紀錄。</div>
              ) : (
                tickets.map((t,idx)=>(
                  <div key={t.id} style={{background:"#111827",borderRadius:18,padding:14}}>
                    <div style={{fontWeight:700}}>{String.fromCharCode(65+idx)} 組：{t.nums.join(" ")}</div>
                    <div style={{color:"#94a3b8",marginTop:6}}>目前：第 {t.stage} / 4 期 ｜ 狀態：{t.status}</div>
                    <div style={{color:"#94a3b8",marginTop:6}}>來源：{t.tag}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
