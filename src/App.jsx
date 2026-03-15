import React, { useEffect, useState, useRef } from "react";

export default function App() {

  const [config, setConfig] = useState({});
  const [statusText, setStatusText] = useState("系統啟動中...");
  const [page, setPage] = useState("ai"); // ai / predict / market
  const loopRef = useRef(null);

  // 讀 system-config
  async function loadConfig() {
    try {
      const res = await fetch("/api/system-config");
      const data = await res.json();
      setConfig(data || {});
      return data;
    } catch (e) {
      console.error("loadConfig error", e);
      return {};
    }
  }

  // AI 主循環
  async function runAiCycle() {
    try {

      setStatusText("同步期數中...");
      await fetch("/api/sync");

      setStatusText("更新 recent20...");
      await fetch("/api/recent20");

      setStatusText("更新 prediction...");
      await fetch("/api/prediction-latest");

      setStatusText("檢查補期...");
      await fetch("/api/catchup");

      setStatusText("AI 訓練中...");
      await fetch("/api/auto-train", { method: "POST" });

      setStatusText("AI 訓練完成");

    } catch (err) {
      console.error("AI cycle error", err);
      setStatusText("AI 循環發生錯誤");
    }
  }

  // 啟動 AI LOOP
  function startLoop() {

    if (loopRef.current) return;

    setStatusText("AI 循環啟動");

    loopRef.current = setInterval(async () => {

      const cfg = await loadConfig();

      if (
        cfg.auto_train_enabled === true ||
        cfg.auto_train_enabled === "true"
      ) {
        await runAiCycle();
      }

    }, 20000);
  }

  function stopLoop() {
    if (loopRef.current) {
      clearInterval(loopRef.current);
      loopRef.current = null;
    }
  }

  // 開啟自動訓練
  async function enableAutoTrain() {

    await fetch("/api/system-config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: "auto_train_enabled",
        value: true
      })
    });

    await loadConfig();
  }

  // 關閉自動訓練
  async function disableAutoTrain() {

    await fetch("/api/system-config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: "auto_train_enabled",
        value: false
      })
    });

    await loadConfig();
  }

  useEffect(() => {

    async function init() {
      await loadConfig();
      startLoop();
    }

    init();

    return () => stopLoop();

  }, []);

  const autoTrainEnabled =
    config.auto_train_enabled === true ||
    config.auto_train_enabled === "true";

  return (
    <div style={{background:"#0B2340",minHeight:"100vh",color:"#fff",padding:"30px"}}>

      <h1>富緯賓果系統 v4.3</h1>

      {/* 頁面切換 */}
      <div style={{marginBottom:20}}>
        <button onClick={()=>setPage("ai")}>AI狀態</button>
        <button onClick={()=>setPage("predict")}>預測下注</button>
        <button onClick={()=>setPage("market")}>市場資料</button>
      </div>

      {/* AI狀態頁 */}
      {page === "ai" && (
        <div>
          <h2>AI狀態</h2>

          <p>AI 狀態：{statusText}</p>

          <p>
            自動訓練狀態：
            <b style={{marginLeft:10}}>
              {autoTrainEnabled ? "開啟中" : "關閉"}
            </b>
          </p>

          {!autoTrainEnabled && (
            <button onClick={enableAutoTrain}>
              開啟自動訓練
            </button>
          )}

          {autoTrainEnabled && (
            <button onClick={disableAutoTrain}>
              關閉自動訓練
            </button>
          )}

        </div>
      )}

      {/* 預測下注 */}
      {page === "predict" && (
        <div>
          <h2>預測下注</h2>
          <p>這裡放正式投注 / 測試投注畫面</p>
        </div>
      )}

      {/* 市場資料 */}
      {page === "market" && (
        <div>
          <h2>市場資料</h2>
          <p>這裡顯示 recent20 / 開獎資料</p>
        </div>
      )}

    </div>
  );
}
