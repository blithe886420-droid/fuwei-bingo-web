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

    const now = new Date();

    const taipeiDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now).replace(/-/g, "");

    const sourceUrl = `https://lotto.auzo.tw/bingobingo/list_${taipeiDate}.html`;

    const pageRes = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const html = await pageRes.text();

    const matches = html.match(/\b\d{2}\b/g) || [];
    const numbers = matches.slice(0, 20);

    const payload = {
      draw_no: Date.now(),
      draw_time: new Date().toISOString(),
      numbers: numbers.join(" ")
    };

    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    return res.status(200).json({
      ok: true,
      source: sourceUrl,
      saved: payload
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
