export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL || "";
    const SUPABASE_KEY_NAME =
      process.env.SUPABASE_SECRET_KEY
        ? "SUPABASE_SECRET_KEY"
        : process.env.SUPABASE_SERVICE_ROLE_KEY
        ? "SUPABASE_SERVICE_ROLE_KEY"
        : process.env.SUPABASE_KEY
        ? "SUPABASE_KEY"
        : "missing";

    const SUPABASE_KEY =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_KEY ||
      "";

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "missing supabase env"
      });
    }

    const urlObj = new URL(SUPABASE_URL);
    const projectHint = urlObj.host;

    const drawsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time&order=draw_no.desc&limit=5`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const drawsText = await drawsResp.text();

    let drawsData = null;
    try {
      drawsData = JSON.parse(drawsText);
    } catch {
      drawsData = drawsText;
    }

    const predResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?select=id,source_draw_no,created_at&order=created_at.desc&limit=5`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const predText = await predResp.text();

    let predData = null;
    try {
      predData = JSON.parse(predText);
    } catch {
      predData = predText;
    }

    return res.status(200).json({
      ok: true,
      projectHint,
      usingKeyName: SUPABASE_KEY_NAME,
      bingo_draws: {
        ok: drawsResp.ok,
        status: drawsResp.status,
        data: drawsData
      },
      bingo_predictions: {
        ok: predResp.ok,
        status: predResp.status,
        data: predData
      }
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "debug failed"
    });
  }
}
