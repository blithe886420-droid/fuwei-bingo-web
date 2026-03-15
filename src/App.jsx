import React, { useEffect, useState } from "react";

export default function App() {

  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  const [aiStatus, setAiStatus] = useState({
    score: 0,
    roi: 0,
    hit: 0,
    mode: "test",
    strategies: 0
  });

  // 讀 system config
  async function loadConfig() {
    try {
      const res = await fetch("/api/system-config");
      const data = await res.json();

      setConfig(data);
    } catch (err) {
      console.error("loadConfig error", err);
    }
  }

  // 讀 AI 狀態
  async function loadStatus() {
    try {
      const res = await fetch("/api/prediction-latest");
      const data = await res.json();

      if (data && data.ok && data.data) {
        setAiStatus({
          score: data.data.score || 0,
          roi: data.data.roi || 0,
          hit: data.data.hit || 0,
          mode: data.data.mode || "test",
          strategies: data.data.strategy_count || 0
        });
      }
    } catch (err) {
      console.error("loadStatus error", err);
    }
  }

  // 初始載入
  useEffect(() => {
    async function init() {
      await loadConfig();
      await loadStatus();
      setLoading(false);
    }

    init();
  }, []);

  // 啟動自動訓練
  async function startAutoTrain() {

    try {

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

      const res = await fetch("/api/auto-train", {
        method: "POST"
      });

      const data = await res.json();

      console.log("auto-train result", data);

      await loadConfig();

    } catch (err) {

      console.error("startAutoTrain error", err);

    }

  }

  // 停止自動訓練
  async function stopAutoTrain() {

    try {

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

    } catch (err) {

      console.error("stopAutoTrain error", err);

    }

  }

  if (loading) {
    return <div style={{ padding: 40 }}>載入中...</div>;
  }

  const autoTrainEnabled =
    config?.auto_train_enabled === true ||
    config?.auto_train_enabled === "true";

  return (
    <div
      style={{
        background: "#F6F0D6",
        minHeight: "100vh",
        padding: "30px",
        fontFamily: "Arial"
      }}
    >

      <h1 style={{ color: "#2F6B5F" }}>
        FUWEI BINGO AI
      </h1>

      <p style={{ color: "#555" }}>
        淺黃台彩風，舒服一點，也看得久一點。
      </p>

      <div
        style={{
          background: "#FFFFFF",
          borderRadius: 12,
          padding: 20,
          marginTop: 20
        }}
      >

        <h2>AI 狀態總覽</h2>

        <div style={{ display: "flex", gap: 20 }}>

          <div>
            <b>AI 信心指數</b>
            <div style={{ fontSize: 28 }}>
              {aiStatus.score} / 100
            </div>
          </div>

          <div>
            <b>平均 ROI</b>
            <div style={{ fontSize: 28 }}>
              {aiStatus.roi}%
            </div>
          </div>

          <div>
            <b>平均命中</b>
            <div style={{ fontSize: 28 }}>
              {aiStatus.hit}
            </div>
          </div>

          <div>
            <b>策略數量</b>
            <div style={{ fontSize: 28 }}>
              {aiStatus.strategies}
            </div>
          </div>

        </div>

      </div>


      <div
        style={{
          background: "#FFFFFF",
          borderRadius: 12,
          padding: 20,
          marginTop: 20
        }}
      >

        <h2>系統控制</h2>

        <div style={{ marginBottom: 10 }}>
          目前狀態：
          <b style={{ marginLeft: 10 }}>
            {autoTrainEnabled ? "開啟中" : "關閉"}
          </b>
        </div>

        {!autoTrainEnabled && (
          <button
            onClick={startAutoTrain}
            style={{
              padding: "10px 20px",
              background: "#2F6B5F",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer"
            }}
          >
            啟動自動訓練
          </button>
        )}

        {autoTrainEnabled && (
          <button
            onClick={stopAutoTrain}
            style={{
              padding: "10px 20px",
              background: "#D96C3B",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer"
            }}
          >
            停止自動訓練
          </button>
        )}

      </div>

    </div>
  );
}
