export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      process.env.SUPABASE_KEY;

    const APP_URL =
      process.env.APP_URL ||
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "";

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing environment variables"
      });
    }

    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    };

    const runningRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?select=id,created_at&mode=eq.test&status=eq.created&order=created_at.desc&limit=1`,
      { headers }
    );

    const runningText = await runningRes.text();

    if (!runningRes.ok) {
      return res.status(500).json({
        ok: false,
        error: "check running prediction failed",
        detail: runningText.slice(0, 500)
      });
    }

    let runningRows = [];
    try {
      runningRows = JSON.parse(runningText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "running prediction parse failed",
        detail: runningText.slice(0, 500)
      });
    }

    if (Array.isArray(runningRows) && runningRows.length > 0) {
      return res.status(200).json({
        ok: true,
        message: "test prediction already running"
      });
    }

    const strategyUrl = APP_URL
      ? `${APP_URL}/api/strategy-generate`
      : `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/strategy-generate`;

    const strategyRes = await fetch(strategyUrl, {
      headers: {
        "Content-Type": "application/json"
      }
    });

    const strategyText = await strategyRes.text();

    if (!strategyRes.ok) {
      return res.status(500).json({
        ok: false,
        error: "strategy generate failed",
        detail: strategyText.slice(0, 500)
      });
    }

    let strategyData = null;
    try {
      strategyData = JSON.parse(strategyText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "strategy response parse failed",
        detail: strategyText.slice(0, 500)
      });
    }

    const groups = Array.isArray(strategyData?.groups)
      ? strategyData.groups
          .map((g, idx) => ({
            key: g?.key || `group_${idx + 1}`,
            label: g?.label || `第${idx + 1}組`,
            nums: Array.isArray(g?.nums) ? g.nums.slice(0, 4) : [],
            reason: g?.reason || "AI Player strategy"
          }))
          .filter((g) => g.nums.length === 4)
          .slice(0, 4)
      : [];

    if (!groups.length) {
      return res.status(200).json({
        ok: true,
        message: "no strategy available"
      });
    }

    const latestDrawRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no&order=draw_no.desc&limit=1`,
      { headers }
    );

    const latestDrawText = await latestDrawRes.text();

    if (!latestDrawRes.ok) {
      return res.status(500).json({
        ok: false,
        error: "latest draw fetch failed",
        detail: latestDrawText.slice(0, 500)
      });
    }

    let latestDrawRows = [];
    try {
      latestDrawRows = JSON.parse(latestDrawText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "latest draw parse failed",
        detail: latestDrawText.slice(0, 500)
      });
    }

    const latestDrawNo = Number(latestDrawRows?.[0]?.draw_no || 0);

    if (!Number.isInteger(latestDrawNo) || latestDrawNo <= 0) {
      return res.status(500).json({
        ok: false,
        error: "invalid latest draw no"
      });
    }

    const payload = {
      id: Date.now(),
      mode: "test",
      status: "created",
      source_draw_no: String(latestDrawNo),
      target_periods: 2,
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const saveRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions`,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify(payload)
      }
    );

    const saveText = await saveRes.text();

    if (!saveRes.ok) {
      return res.status(500).json({
        ok: false,
        error: "create ai player prediction failed",
        detail: saveText.slice(0, 500)
      });
    }

    return res.status(200).json({
      ok: true,
      created: true,
      source_draw_no: String(latestDrawNo),
      target_periods: 2,
      groups
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "ai player failed"
    });
  }
}
