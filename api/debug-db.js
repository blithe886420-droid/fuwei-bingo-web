function getProjectHint(url = "") {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url || "unknown";
  }
}

async function fetchJson(url, key) {
  const resp = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`
    }
  });

  const text = await resp.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { rawText: text.slice(0, 1000) };
  }

  return {
    ok: resp.ok,
    status: resp.status,
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

    const projectHint = getProjectHint(SUPABASE_URL);

    const drawsUrl =
      `${SUPABASE_URL}/rest/v1/bingo_draws` +
      `?select=id,draw_no,draw_time,numbers&order=draw_no.desc&limit=5`;

    const predictionsUrl =
      `${SUPABASE_URL}/rest/v1/bingo_predictions` +
      `?select=*&limit=5`;

    const draws = await fetchJson(drawsUrl, SUPABASE_KEY);
    const predictions = await fetchJson(predictionsUrl, SUPABASE_KEY);

    return res.status(200).json({
      ok: true,
      projectHint,
      usingKeyName: process.env.SUPABASE_SECRET_KEY
        ? "SUPABASE_SECRET_KEY"
        : process.env.SUPABASE_SERVICE_ROLE_KEY
        ? "SUPABASE_SERVICE_ROLE_KEY"
        : process.env.SUPABASE_KEY
        ? "SUPABASE_KEY"
        : "none",
      bingo_draws: draws,
      bingo_predictions: predictions
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "debug-db failed"
    });
  }
}
