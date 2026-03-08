function normalizeNums(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map(x => String(x).padStart(2, "0"))
    .slice(0, 4);
}

function calcGroupResult(group, drawNumbers) {
  const groupNums = normalizeNums(group?.nums);
  const drawSet = new Set((Array.isArray(drawNumbers) ? drawNumbers : []).map(x => String(x).padStart(2, "0")));
  const hitNums = groupNums.filter(n => drawSet.has(n));
  const hitCount = hitNums.length;

  return {
    label: group?.label || "",
    nums: groupNums,
    hitNums,
    hitCount
  };
}

function calcEstimatedReturn(hitCount) {
  // 這裡先維持簡化估算，不做獎金表硬編碼
  // 之後若你有固定四星賓果對照表，再換成真實賠率
  if (hitCount <= 0) return 0;
  if (hitCount === 1) return 0;
  if (hitCount === 2) return 0;
  if (hitCount === 3) return 0;
  if (hitCount >= 4) return 0;
  return 0;
}

function buildVerdict(results) {
  const maxHit = Math.max(...results.map(r => r.hitCount), 0);

  if (maxHit >= 4) return "中四";
  if (maxHit === 3) return "中三";
  if (maxHit === 2) return "中二";
  if (maxHit === 1) return "中一";
  return "未中";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

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

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const predictionId = body.predictionId;

    if (!predictionId) {
      return res.status(400).json({
        ok: false,
        error: "predictionId is required"
      });
    }

    // 1. 讀取 prediction
    const predResp = await fetch(
      `${SUPABASE_URL}/rest/v1/predictions?id=eq.${encodeURIComponent(predictionId)}&select=*`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const predText = await predResp.text();

    if (!predResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `prediction fetch failed: ${predResp.status}`,
        rawPreview: predText.slice(0, 300)
      });
    }

    let predRows = [];
    try {
      predRows = JSON.parse(predText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "prediction parse failed",
        rawPreview: predText.slice(0, 300)
      });
    }

    const prediction = predRows?.[0];

    if (!prediction) {
      return res.status(404).json({
        ok: false,
        error: "prediction not found"
      });
    }

    const sourceDrawNo = Number(prediction.source_draw_no || 0);
    const targetPeriods = Number(prediction.target_periods || 0);
    const targetDrawNo = Number(prediction.target_draw_no || (sourceDrawNo + targetPeriods));

    if (!sourceDrawNo || !targetPeriods || !targetDrawNo) {
      return res.status(400).json({
        ok: false,
        error: "prediction fields are incomplete"
      });
    }

    // 2. 抓目前資料庫最新一期
    const latestResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers&order=draw_no.desc&limit=1`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const latestText = await latestResp.text();

    if (!latestResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `latest draw fetch failed: ${latestResp.status}`,
        rawPreview: latestText.slice(0, 300)
      });
    }

    let latestRows = [];
    try {
      latestRows = JSON.parse(latestText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "latest draw parse failed",
        rawPreview: latestText.slice(0, 300)
      });
    }

    const latestRow = latestRows?.[0];
    const currentDrawNo = Number(latestRow?.draw_no || 0);

    if (!currentDrawNo) {
      return res.status(500).json({
        ok: false,
        error: "current draw not found"
      });
    }

    // 3. 還沒到目標期，不允許比對
    if (currentDrawNo < targetDrawNo) {
      return res.status(200).json({
        ok: false,
        waiting: true,
        error: `尚未到比對期數，目前最新期數 ${currentDrawNo}，需等到第 ${targetDrawNo} 期`,
        currentDrawNo,
        sourceDrawNo,
        targetPeriods,
        targetDrawNo,
        remaining: targetDrawNo - currentDrawNo
      });
    }

    // 4. 抓真正要比對的目標期
    const targetResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?draw_no=eq.${targetDrawNo}&select=draw_no,draw_time,numbers&limit=1`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const targetText = await targetResp.text();

    if (!targetResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `target draw fetch failed: ${targetResp.status}`,
        rawPreview: targetText.slice(0, 300)
      });
    }

    let targetRows = [];
    try {
      targetRows = JSON.parse(targetText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "target draw parse failed",
        rawPreview: targetText.slice(0, 300)
      });
    }

    const targetRow = targetRows?.[0];

    if (!targetRow) {
      return res.status(200).json({
        ok: false,
        waiting: true,
        error: `目標期數第 ${targetDrawNo} 期尚未入庫`,
        currentDrawNo,
        sourceDrawNo,
        targetPeriods,
        targetDrawNo
      });
    }

    const drawNumbers = String(targetRow.numbers || "")
      .split(/[,\s]+/)
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => String(x).padStart(2, "0"))
      .slice(0, 20);

    if (drawNumbers.length !== 20) {
      return res.status(500).json({
        ok: false,
        error: "target draw numbers invalid",
        targetDrawNo
      });
    }

    const groups = Array.isArray(prediction.groups) ? prediction.groups : [];
    if (!groups.length) {
      return res.status(400).json({
        ok: false,
        error: "prediction groups missing"
      });
    }

    const results = groups.map(group => calcGroupResult(group, drawNumbers));
    const verdict = buildVerdict(results);

    const totalCost = groups.length;
    const estimatedReturn = results.reduce((sum, r) => sum + calcEstimatedReturn(r.hitCount), 0);
    const profit = estimatedReturn - totalCost;

    const compareResult = {
      mode: prediction.mode,
      predictionId: prediction.id,
      sourceDrawNo,
      targetPeriods,
      targetDrawNo,
      compareDrawNo: Number(targetRow.draw_no),
      compareDrawTime: targetRow.draw_time,
      drawNumbers,
      verdict,
      totalCost,
      estimatedReturn,
      profit,
      results
    };

    // 5. 更新 prediction 狀態
    const patchResp = await fetch(
      `${SUPABASE_URL}/rest/v1/predictions?id=eq.${encodeURIComponent(prediction.id)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          status: "compared",
          compared_draw_no: Number(targetRow.draw_no),
          compared_at: new Date().toISOString(),
          compare_result: compareResult
        })
      }
    );

    const patchText = await patchResp.text();

    if (!patchResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `prediction update failed: ${patchResp.status}`,
        rawPreview: patchText.slice(0, 300)
      });
    }

    return res.status(200).json({
      ok: true,
      result: compareResult
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "prediction-compare failed"
    });
  }
}
