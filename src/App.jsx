import React, { useEffect, useState } from "react";
import { startAiLoop, stopAiLoop } from "./aiLoop";

export default function App() {

  const [config, setConfig] = useState({});
  const [statusText, setStatusText] = useState("系統啟動中...");
  const [page, setPage] = useState("ai");

  async function loadConfig() {
    try {
      const res = await fetch("/api/system-config");
      const data = await res.json();
      setConfig(data || {});
    } catch (err) {
      console.error(err);
    }
  }

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

    loadConfig();

    startAiLoop(setStatusText);

    return () => {
      stopAiLoop();
    };

  }, []);

  const autoTrainEnabled =
    config.auto_train_enabled === true ||
    config.auto_train_enabled === "true";

  return (
    <div style={{background:"#0B2340",minHeight:"100vh",color:"#fff",padding:"30px"}}>

      <h1>富緯賓果系統</h1>

      <div style={{marginBottom:20}}>
        <button onClick={()=>setPage("ai")}>AI狀態</button>
        <button onClick={()=>setPage("predict")}>預測下注</button>
        <button onClick={()=>setPage("market")}>市場資料</button>
      </div>

      {page === "ai" && (
        <div>

          <h2>AI狀態</h2>

          <p>{statusText}</p>

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

      {page === "predict" && (
        <div>
          <h2>預測下注</h2>
          <p>未來放正式下注邏輯</p>
        </div>
      )}

      {page === "market" && (
        <div>
          <h2>市場資料</h2>
          <p>顯示 recent20 / 歷史資料</p>
        </div>
      )}

    </div>
  );
}
