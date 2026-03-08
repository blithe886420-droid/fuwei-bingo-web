export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE_SECRET_KEY"
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

    const body = req.body || {};
    const mode = body.mode || "test";
    const sourceDrawNo = String(body.sourceDrawNo || "即時同步");
    const targetPeriods = Number(body.targetPeriods || 2);
    const groups = Array.isArray(body.groups) ? body.groups : [];

    if (!groups.length) {
      return res.status(400).json({
        ok: false,
        error: "groups is required"
      });
    }

    const id = Date.now();

    const payload = {
      id,
      mode,
      status: "created",
      source_draw_no: sourceDrawNo,
      target_periods: targetPeriods,
      groups_json: groups
    };

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/bingo_predictions`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(payload)
    });

    if (!saveRes.ok) {
      const detail = await saveRes.text();
      return res.status(500).json({
        ok: false,
        error: "Prediction save failed",
        detail
      });
    }

    const row = await saveRes.json();

    return res.status(200).json({
      ok: true,
      id,
      row
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "prediction save failed"
    });
  }
}
