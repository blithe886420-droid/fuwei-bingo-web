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

    const now = new Date();
    const taipeiNow = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })
    );

    const yyyy = taipeiNow.getFullYear();
    const mm = String(taipeiNow.getMonth() + 1).padStart(2, "0");
    const dd = String(taipeiNow.getDate()).padStart(2, "0");
    const hh = String(taipeiNow.getHours()).padStart(2, "0");
    const mi = String(taipeiNow.getMinutes()).padStart(2, "0");
    const ss = String(taipeiNow.getSeconds()).padStart(2, "0");

    const dateStr = `${yyyy}${mm}${dd}`;
    const capturedTime = `${hh}:${mi}:${ss}`;

    const sourceUrl = `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

    const response = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9"
      }
    });

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: `fetch failed: ${response.status}`,
        source: sourceUrl
      });
    }

    const html = await response.text();

    const ballMatches = html.match(/>\d{2}</g) || [];
    const numbers = ballMatches
      .slice(0, 20)
      .map(x => x.replace(/[^\d]/g, ""));

    if (numbers.length !== 20) {
      return res.status(500).json({
        ok: false,
        error: "Could not parse latest 20 numbers",
        source: sourceUrl,
        count: numbers.length
      });
    }

    const numbersText = numbers.join(" ");

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
      return res.status(200).json({
        ok: true,
        saved: false,
        skipped: true,
        reason: "same numbers already exists"
      });
    }

    const uniqueId = Date.now();

    const payload = {
      id: uniqueId,
      draw_no: uniqueId,
      draw_time: capturedTime,
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

    return res.status(200).json({
      ok: true,
      saved: true,
      row: savedRow
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "cron sync failed"
    });
  }
}
