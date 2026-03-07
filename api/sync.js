export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE_SECRET_KEY",
      });
    }

    const sourceUrl = "https://lotto.auzo.tw/bingobingo/list_20260307.html";
    const pageRes = await fetch(sourceUrl);
    const html = await pageRes.text();

    const matches = html.match(/\d{2}/g) || [];
    const numbers = matches.slice(0, 20);

    if (numbers.length < 20) {
      return res.status(500).json({
        ok: false,
        error: "Could not parse 20 numbers from source page",
      });
    }

    const payload = {
      draw_no: Date.now(),
      draw_time: new Date().toISOString(),
      numbers: numbers.join(" "),
    };

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    const saveText = await saveRes.text();

    if (!saveRes.ok) {
      return res.status(500).json({
        ok: false,
        error: "Supabase insert failed",
        detail: saveText,
      });
    }

    return res.status(200).json({
      ok: true,
      saved: payload,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Unknown error",
    });
  }
}
