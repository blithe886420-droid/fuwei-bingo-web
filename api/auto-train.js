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

    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL
        ? process.env.NEXT_PUBLIC_SITE_URL
        : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

    async function safeJsonFetch(path, options = {}) {
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

    // 1. catchup 改成可失敗但不中止整輪
    let catchupInserted = 0;
    let catchupWarning = null;

    const catchup = await safeJsonFetch("/api/catchup");

    if (catchup.ok) {
      catchupInserted = Number(catchup.data?.inserted || 0);
    } else {
      catchupWarning = catchup.error || catchup.data?.error || "catchup failed";
    }

    // 2. sync
    const sync = await safeJsonFetch("/api/sync");
    if (!sync.ok) {
      return res.status(500).json({
        ok: false,
        step: "sync",
        error: sync.error || sync.data?.error || "sync failed",
        rawPreview: sync.rawPreview || null
      });
    }

    const latestDrawNo = Number(sync.data?.draw_no || 0);
    if (!latestDrawNo) {
      return res.status(500).json({
        ok: false,
        step: "sync",
        error: "latest draw_no missing"
      });
    }

    // 3. save latest
    const save = await safeJsonFetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });

    if (!save.ok) {
      return res.status(500).json({
        ok: false,
        step: "save",
        error: save.error || save.data?.error || "save failed",
        rawPreview: save.rawPreview || null
      });
    }

    // 4. generate strategy
    const strategy = await safeJsonFetch("/api/strategy-generate?n=80");
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

    // 5. 檢查同一期是否已建立 auto training test
    const existingPredictionResp = await fetch(
      `${SUPABASE_URL}/rest/v1/predictions?select=id,source_draw_no,target_draw_no,status,mode&mode=eq.test&source_draw_no=eq.${latestDrawNo}&order=created_at.desc&limit=1`,
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
      createdPrediction = existingPredictions[0];
      skippedCreate = true;
    } else {
      const predictionSave = await safeJsonFetch("/api/prediction-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "test",
          sourceDrawNo: latestDrawNo,
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
        source_draw_no: predictionSave.data?.sourceDrawNo,
        target_draw_no: predictionSave.data?.targetDrawNo,
        status: predictionSave.data?.status || "pending",
        mode: "test"
      };
    }

    // 6. 找出已到比對期的 test prediction
    const pendingResp = await fetch(
      `${SUPABASE_URL}/rest/v1/predictions?select=id,source_draw_no,target_draw_no,status,mode&mode=eq.test&or=(status.eq.pending,status.eq.created)&order=created_at.asc&limit=50`,
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
      const targetDrawNo = Number(p.target_draw_no || 0);
      return targetDrawNo > 0 && latestDrawNo >= targetDrawNo;
    });

    const compareResults = [];

    for (const p of matured) {
      const compare = await safeJsonFetch("/api/prediction-compare", {
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
          targetDrawNo: Number(p.target_draw_no || 0),
          verdict: compare.data?.result?.verdict || "unknown",
          compareDrawNo: compare.data?.result?.compareDrawNo || null
        });
      } else {
        compareResults.push({
          predictionId: p.id,
          sourceDrawNo: Number(p.source_draw_no || 0),
          targetDrawNo: Number(p.target_draw_no || 0),
          verdict: "compare_failed",
          error: compare.error || compare.data?.error || "compare failed"
        });
      }
    }

    return res.status(200).json({
      ok: true,
      mode: "auto_train_v1_stable",
      latestDrawNo,
      latestDrawTime: sync.data?.draw_time || null,
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
