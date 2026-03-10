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

    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers&order=draw_no.desc&limit=20`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const text = await resp.text();

    if (!resp.ok) {
      return res.status(500).json({
        ok: false,
        error: `recent20 fetch failed: ${resp.status}`,
        rawPreview: text.slice(0, 300)
      });
    }

    let rows = [];

    try {
      rows = JSON.parse(text);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "recent20 parse failed",
        rawPreview: text.slice(0, 300)
      });
    }

    const seen = new Set();
    const clean = [];

    for (const row of Array.isArray(rows) ? rows : []) {
      const drawNo = Number(row?.draw_no);

      if (!Number.isInteger(drawNo)) continue;
      if (seen.has(drawNo)) continue;

      seen.add(drawNo);

      clean.push({
        draw_no: drawNo,
        draw_time: row?.draw_time || "",
        numbers: row?.numbers || ""
      });
    }

    clean.sort((a, b) => b.draw_no - a.draw_no);

    return res.status(200).json({
      ok: true,
      count: clean.length,
      recent20: clean.slice(0, 20)
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "recent20 failed"
    });
  }
}
