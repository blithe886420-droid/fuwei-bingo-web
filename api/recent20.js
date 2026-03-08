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

    const recentResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers&order=draw_no.desc&limit=20`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const recentText = await recentResp.text();

    if (!recentResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `recent20 fetch failed: ${recentResp.status}`,
        rawPreview: recentText.slice(0, 500)
      });
    }

    let recent20 = [];
    try {
      recent20 = JSON.parse(recentText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "recent20 parse failed",
        rawPreview: recentText.slice(0, 500)
      });
    }

    // 保險：後端再強制做一次排序與去重，避免前端看到重複期號
    const deduped = [];
    const seen = new Set();

    for (const row of Array.isArray(recent20) ? recent20 : []) {
      const drawNo = Number(row?.draw_no);
      if (!Number.isInteger(drawNo)) continue;
      if (seen.has(drawNo)) continue;

      seen.add(drawNo);
      deduped.push({
        draw_no: drawNo,
        draw_time: row?.draw_time || "",
        numbers: row?.numbers || ""
      });
    }

    deduped.sort((a, b) => b.draw_no - a.draw_no);

    return res.status(200).json({
      ok: true,
      count: deduped.length,
      recent20: deduped.slice(0, 20)
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "recent20 failed"
    });
  }
}
