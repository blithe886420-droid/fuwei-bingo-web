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

    // 用台灣時間組成今天日期：YYYYMMDD
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);

    const year = parts.find((p) => p.type === "year")?.value || "";
    const month = parts.find((p) => p.type === "month")?.value || "";
    const day = parts.find((p) => p.type === "day")?.value || "";
    const dateStr = `${year}${month}${day}`;

    // 明確指向澳所每日網址
    const sourceUrl = `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

    // 先抓頁面
    const pageRes = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
    });

    if (!pageRes.ok) {
      return res.status(500).json({
        ok: false,
        error: `Source fetch failed: ${pageRes.status}`,
        sourceUrl,
      });
    }

    const html = await pageRes.text();

    // 抓出所有兩位數
    const matches = html.match(/\b\d{2}\b/g) || [];

    if (matches.length < 20) {
      return res.status(500).json({
        ok: false,
        error: "Could not parse enough numbers from source page",
        sourceUrl,
        sample: matches.slice(0, 60),
      });
    }

    // 先取前 20 個號碼當最新一期測試資料
    const numbers = matches.slice(0, 20).join(" ");

    const payload = {
      draw_no: Date.now(),
      draw_time: new Date().toISOString(),
      numbers,
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
        sourceUrl,
      });
    }

    return res.status(200).json({
      ok: true,
      sourceUrl,
      dateStr,
      saved: payload,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Unknown error",
    });
  }
}
