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
    const numbers = Array.isArray(body.numbers)
      ? body.numbers.map(x => String(x).padStart(2, "0")).slice(0, 20)
      : [];

    if (numbers.length !== 20) {
      return res.status(400).json({
        ok: false,
        error: "numbers must be an array of 20 values"
      });
    }

    const numbersText = numbers.join(" ");

    const now = new Date();
    const taipeiNow = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })
    );

    const hh = String(taipeiNow.getHours()).padStart(2, "0");
    const mi = String(taipeiNow.getMinutes()).padStart(2, "0");
    const ss = String(taipeiNow.getSeconds()).padStart(2, "0");
    const capturedAt = `${hh}:${mi}:${ss}`;

    // 先查有沒有相同號碼，避免重複存
    const checkUrl = `${SUPABASE_URL}/rest/v1/bingo_draws?select=id,numbers&numbers=eq.${encodeURIComponent(numbersText)}&limit=1`;

    const checkRes = await fetch(checkUrl, {
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
      }
    });

    if (!checkRes.ok) {
      const detail = await checkRes.text();
      return res.status(500).json({
        ok: false,
        error: "Supabase check failed",
        detail
      });
    }

    const existing = await checkRes.json();

    if (Array.isArray(existing) && existing.length > 0) {
      const recent20Res = await fetch(
        `${SUPABASE_URL}/rest/v1/bingo_draws?select=id,draw_no,draw_time,numbers,created_at&order=created_at.desc&limit=20`,
        {
          headers: {
            apikey: SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
          }
        }
      );

      let recent20 = [];
      if (recent20Res.ok) {
        recent20 = await recent20Res.json();
      }

      return res.status(200).json({
        ok: true,
        saved: false,
        skipped: true,
        reason: "same numbers already exists",
        recent20
      });
    }

    // 這裡是關鍵：補上 id
    const uniqueId = Date.now();

    const payload = {
      id: uniqueId,
      draw_no: uniqueId,
      draw_time: capturedAt,
      numbers: numbersText
    };

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws`, {
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
        error: "Supabase insert failed",
        detail
      });
    }

    const savedRow = await saveRes.json();

    const recent20Res = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=id,draw_no,draw_time,numbers,created_at&order=created_at.desc&limit=20`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    let recent20 = [];
    if (recent20Res.ok) {
      recent20 = await recent20Res.json();
    }

    return res.status(200).json({
      ok: true,
      saved: true,
      skipped: false,
      row: savedRow,
      recent20
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "save failed"
    });
  }
}
