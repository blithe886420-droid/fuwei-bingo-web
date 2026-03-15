let loopTimer = null;

async function loadConfig() {
  try {
    const res = await fetch("/api/system-config");
    const data = await res.json();
    return data || {};
  } catch (err) {
    console.error("AI LOOP loadConfig error", err);
    return {};
  }
}

async function runAiCycle(setStatus) {

  try {

    setStatus("同步期數中...");
    await fetch("/api/sync");

    setStatus("更新 recent20...");
    await fetch("/api/recent20");

    setStatus("更新 prediction...");
    await fetch("/api/prediction-latest");

    setStatus("檢查補期...");
    await fetch("/api/catchup");

    setStatus("AI 訓練中...");
    await fetch("/api/auto-train", { method: "POST" });

    setStatus("AI 訓練完成");

  } catch (err) {

    console.error("AI LOOP error", err);
    setStatus("AI 循環錯誤");

  }

}

export function startAiLoop(setStatus) {

  if (loopTimer) return;

  setStatus("AI LOOP 啟動");

  loopTimer = setInterval(async () => {

    const cfg = await loadConfig();

    if (
      cfg.auto_train_enabled === true ||
      cfg.auto_train_enabled === "true"
    ) {

      await runAiCycle(setStatus);

    }

  }, 20000);

}

export function stopAiLoop() {

  if (loopTimer) {

    clearInterval(loopTimer);
    loopTimer = null;

  }

}
