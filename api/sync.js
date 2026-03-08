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

    // 台北日期 YYYYMMDD
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

    // 抓澳所頁面
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

    // 只抓最上面最新一期 20 顆球號
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

    // 先查資料庫是否已經有相同號碼，避免重複寫入
    // 注意：這裡沿用你現有 bingo_draws 表，不新增欄位
    let skipped = false;
    let saved = false;

    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=id,numbers&numbers=eq.${encodeURIComponent(numbersText)}&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (checkRes.ok) {
      const checkJson = await checkRes.json();
      if (Array.isArray(checkJson) && checkJson.length > 0) {
        skipped = true;
      }
    }

    // 如果沒有相同號碼，就自動存進去
    if (!skipped) {
      const payload = {
        // 先用時間戳當臨時 draw_no，讓資料可排序
        draw_no: Date.now(),
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

      saved = true;
    }

    // 再抓最近 20 筆，給前端測試模式 / 正式模式用
    let recent20 = [];
    const recent20Res = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers,created_at&order=created_at.desc&limit=20`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (recent20Res.ok) {
      recent20 = await recent20Res.json();
    }

    return res.status(200).json({
      ok: true,
      source: sourceUrl,
      latest: {
        drawNo: "即時同步",
        drawTime: capturedTime,
        numbers
      },
      saved,
      skipped,
      recent20
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "fetch failed"
    });
  }
}
