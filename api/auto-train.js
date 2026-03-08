import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js";

function isValidDrawNo(drawNo) {
  return Number.isInteger(drawNo) && drawNo >= 100000000 && drawNo <= 999999999;
}

function isValidDrawTime(drawTime) {
  return typeof drawTime === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(drawTime);
}

function calcTargetDrawNo(sourceDrawNo, targetPeriods) {
  const source = Number(sourceDrawNo || 0);
  const periods = Number(targetPeriods || 0);
  if (!Number.isInteger(source) || !Number.isInteger(periods)) return 0;
  return source + periods;
}

async function fetchTodayAuzoLatest() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("sv-SE", {
    timeZone: "Asia/Taipei"
  }).replaceAll("-", "");

  const sourceUrl = `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

  const response = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9"
    }
  });

  if (!response.ok) {
    throw new Error(`auzo fetch failed: ${response.status}`);
  }

  const html = await response.text();
  const draws = parseAuzoBingoDraws(html, dateStr);

  if (!Array.isArray(draws) || draws.length === 0) {
    throw new Error("parse bingo rows failed");
  }

  const latest = draws[0];
  const latestDrawNo = Number(latest.draw_no);
  const latestDrawTime = latest.draw_time;
  const latestNumbers = latest.numbers;

  if (!isValidDrawNo(latestDrawNo)) {
    throw new Error("invalid latest draw_no");
  }

  if (!isValidDrawTime(latestDrawTime)) {
    throw new Error("invalid latest draw_time");
  }

  if (!latestNumbers || typeof latestNumbers !== "string") {
    throw new Error("invalid latest numbers");
  }

  return {
    sourceUrl,
    dateStr,
    latestDrawNo,
    latestDrawTime,
    latestNumbers
  };
}

async function safeJsonFetchAbsolute(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const raw = await response.text();

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      responseOk: response.ok,
      status: response.status,
      error: `non-json response from ${path}`,
      rawPreview: raw.slice(0, 300)
    };
  }

  return {
    ok: response.ok && !!data?.ok,
    responseOk: response.ok,
    status: response.status,
    data
  };
}

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "missing supabase env"
      });
    }

    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    // 1) catchup 可失敗但不中止
    let catchupInserted = 0;
    let catchupWarning = null;

    const catchup = await safeJsonFetchAbsolute(baseUrl, "/api/catchup");
    if (catchup.ok) {
      catchupInserted = Number(catchup.data?.inserted || 0);
    } else {
      catchupWarning = catchup.error || catchup.data?.error || "catchup failed";
    }

    // 2) 直接抓最新
    const latest = await fetchTodayAuzoLatest();

    // 3) 寫入最新一期，重複就忽略
    const insertPayload = {
      draw_no: latest.latestDrawNo,
      draw_time: latest.latestDrawTime,
      numbers: latest.latestNumbers
    };

    const saveResp = await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws?on_conflict=draw_no`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=representation"
      },
      body: JSON.stringify(insertPayload)
    });

    const saveText = await saveResp.text();

    if (!saveResp.ok) {
      return res.status(500).json({
        ok: false,
        step: "save-latest",
        error: `save latest failed: ${saveResp.status}`,
        rawPreview: saveText.slice(0, 300)
      });
    }

    // 4) 生成策略
    const strategy = await safeJsonFetchAbsolute(baseUrl, "/api/strategy-generate?n=80");
    if (!strategy.ok) {
      return res.status(500).json({
        ok: false,
        step: "strategy-generate",
        error: strategy.error || strategy.data?.error || "strategy generate failed",
        rawPreview: strategy.rawPreview || null
      });
    }

    const groups = Array.isArray(strategy.data?.groups) ? strategy.data.groups : [];
    if (groups.length !== 4) {
      return res.status(500).json({
        ok: false,
        step: "strategy-generate",
        error: "strategy groups invalid",
        count: groups.length
      });
    }

    const normalizedGroups = groups.map(g => ({
      label: g.label,
      nums: Array.isArray(g.nums) ? g.nums.slice(0, 4) : [],
      reason: g.reason || "",
      key: g.key || "",
      meta: {
        autoTrain: true,
        strategyMode: strategy.data?.mode || "unknown"
      }
    }));

    // 5) 檢查同一期是否已建立 auto training 測試
    const existingPredictionResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?select=id,source_draw_no,target_periods,status,mode&mode=eq.test&source_draw_no=eq.${latest.latestDrawNo}&order=created_at.desc&limit=1`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const existingPredictionText = await existingPredictionResp.text();

    if (!existingPredictionResp.ok) {
      return res.status(500).json({
        ok: false,
        step: "check-existing-prediction",
        error: `prediction check failed: ${existingPredictionResp.status}`,
        rawPreview: existingPredictionText.slice(0, 300)
      });
    }

    let existingPredictions = [];
    try {
      existingPredictions = JSON.parse(existingPredictionText);
    } catch {
      return res.status(500).json({
        ok: false,
        step: "check-existing-prediction",
        error: "prediction check parse failed",
        rawPreview: existingPredictionText.slice(0, 300)
      });
    }

    let createdPrediction = null;
    let skippedCreate = false;

    if (Array.isArray(existingPredictions) && existingPredictions.length > 0) {
      const row = existingPredictions[0];
      createdPrediction = {
        id: row.id,
        source_draw_no: Number(row.source_draw_no || 0),
        target_periods: Number(row.target_periods || 0),
        target_draw_no: calcTargetDrawNo(row.source_draw_no, row.target_periods),
        status: row.status || "created",
        mode: row.mode || "test"
      };
      skippedCreate = true;
    } else {
      const predictionSave = await safeJsonFetchAbsolute(baseUrl, "/api/prediction-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "test",
          sourceDrawNo: latest.latestDrawNo,
          targetPeriods: 4,
          groups: normalizedGroups
        })
      });

      if (!predictionSave.ok) {
        return res.status(500).json({
          ok: false,
          step: "prediction-save",
          error: predictionSave.error || predictionSave.data?.error || "prediction save failed",
          rawPreview: predictionSave.rawPreview || null
        });
      }

      createdPrediction = {
        id: predictionSave.data?.id,
        source_draw_no: Number(predictionSave.data?.sourceDrawNo || 0),
        target_periods: Number(predictionSave.data?.targetPeriods || 4),
        target_draw_no:
          Number(predictionSave.data?.targetDrawNo || 0) ||
          calcTargetDrawNo(predictionSave.data?.sourceDrawNo, predictionSave.data?.targetPeriods || 4),
        status: predictionSave.data?.status || "created",
        mode: "test"
      };
    }

    // 6) 找出已成熟的測試單
    const pendingResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?select=id,source_draw_no,target_periods,status,mode&mode=eq.test&or=(status.eq.pending,status.eq.created)&order=created_at.asc&limit=50`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const pendingText = await pendingResp.text();

    if (!pendingResp.ok) {
      return res.status(500).json({
        ok: false,
        step: "load-pending-predictions",
        error: `pending fetch failed: ${pendingResp.status}`,
        rawPreview: pendingText.slice(0, 300)
      });
    }

    let pendingPredictions = [];
    try {
      pendingPredictions = JSON.parse(pendingText);
    } catch {
      return res.status(500).json({
        ok: false,
        step: "load-pending-predictions",
        error: "pending parse failed",
        rawPreview: pendingText.slice(0, 300)
      });
    }

    const matured = (Array.isArray(pendingPredictions) ? pendingPredictions : []).filter(p => {
      const targetDrawNo = calcTargetDrawNo(p.source_draw_no, p.target_periods);
      return targetDrawNo > 0 && latest.latestDrawNo >= targetDrawNo;
    });

    const compareResults = [];

    for (const p of matured) {
      const targetDrawNo = calcTargetDrawNo(p.source_draw_no, p.target_periods);

      const compare = await safeJsonFetchAbsolute(baseUrl, "/api/prediction-compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          predictionId: p.id
        })
      });

      if (compare.ok) {
        compareResults.push({
          predictionId: p.id,
          sourceDrawNo: Number(p.source_draw_no || 0),
          targetPeriods: Number(p.target_periods || 0),
          targetDrawNo,
          compareDrawNo: Number(compare.data?.result?.compareDrawNo || 0) || null,
          verdict: compare.data?.result?.verdict || "unknown",
          error: null
        });
      } else {
        compareResults.push({
          predictionId: p.id,
          sourceDrawNo: Number(p.source_draw_no || 0),
          targetPeriods: Number(p.target_periods || 0),
          targetDrawNo,
          compareDrawNo: null,
          verdict: "compare_failed",
          error: compare.error || compare.data?.error || "compare failed"
        });
      }
    }

    return res.status(200).json({
      ok: true,
      mode: "auto_train_v4_readable_summary",
      latestDrawNo: latest.latestDrawNo,
      latestDrawTime: latest.latestDrawTime,
      catchupInserted,
      catchupWarning,
      strategyMode: strategy.data?.mode || null,
      created: skippedCreate ? 0 : 1,
      skippedCreate,
      createdPrediction,
      maturedCompared: compareResults.length,
      compareResults,
      groups: normalizedGroups
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "auto-train failed"
    });
  }
}
