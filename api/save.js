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

    const mode = String(body.mode || "").trim();
    const sourceDrawNo = Number(body.sourceDrawNo || 0);
    const targetPeriods = Number(body.targetPeriods || 0);
    const groups = Array.isArray(body.groups) ? body.groups : [];

    if (!mode) {
      return res.status(400).json({
        ok: false,
        error: "mode is required"
      });
    }

    if (!sourceDrawNo || Number.isNaN(sourceDrawNo)) {
      return res.status(400).json({
        ok: false,
        error: "sourceDrawNo is required"
      });
    }

    if (!targetPeriods || Number.isNaN(targetPeriods) || targetPeriods < 1) {
      return res.status(400).json({
        ok: false,
        error: "targetPeriods is invalid"
      });
    }

    if (!groups.length) {
      return res.status(400).json({
        ok: false,
        error: "groups is required"
      });
    }

    const normalizedGroups = groups.map((g, idx) => ({
      label: g?.label || `第${idx + 1}組`,
      nums: Array.isArray(g?.nums)
        ? g.nums.map(x => String(x).padStart(2, "0")).slice(0, 4)
        : [],
      reason: g?.reason || "",
      key: g?.key || "",
      meta: g?.meta || {}
    }));

    const invalidGroup = normalizedGroups.find(g => g.nums.length !== 4);
    if (invalidGroup) {
      return res.status(400).json({
        ok: false,
        error: "every group must contain 4 numbers"
      });
    }

    const targetDrawNo = sourceDrawNo + targetPeriods;

    const payload = {
      mode,
      source_draw_no: sourceDrawNo,
      target_periods: targetPeriods,
      target_draw_no: targetDrawNo,
      groups: normalizedGroups,
      status: "pending",
      created_at: new Date().toISOString()
    };

    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/predictions`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(payload)
    });

    const insertText = await insertResp.text();

    if (!insertResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `insert failed: ${insertResp.status}`,
        rawPreview: insertText.slice(0, 300)
      });
    }

    let inserted = [];
    try {
      inserted = JSON.parse(insertText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "insert parse failed",
        rawPreview: insertText.slice(0, 300)
      });
    }

    const row = inserted?.[0];

    return res.status(200).json({
      ok: true,
      id: row?.id,
      mode: row?.mode,
      sourceDrawNo: row?.source_draw_no,
      targetPeriods: row?.target_periods,
      targetDrawNo: row?.target_draw_no,
      status: row?.status || "pending"
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "prediction-save failed"
    });
  }
}
