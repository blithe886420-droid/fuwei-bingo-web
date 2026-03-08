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

    const today = new Date();
    const taipeiNow = new Date(
      today.toLocaleString("en-US", { timeZone: "Asia/Taipei" })
    );

    const yyyy = taipeiNow.getFullYear();
    const mm = String(taipeiNow.getMonth() + 1).padStart(2, "0");
    const dd = String(taipeiNow.getDate()).padStart(2, "0");
    const dateStr = `${yyyy}${mm}${dd}`;

    const sourceUrl = `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

    // 1. 抓今天整頁資料
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

    // 2. 抓出所有期數
    const drawNoMatches = [...html.matchAll(/第\s*(\d+)\s*期/g)];
    const drawNos = drawNoMatches.map(m => m[1]);

    // 3. 抓出所有 2 位數字
    const numMatches = html.match(/\b\d{2}\b/g) || [];

    // Bingo 一期 20 顆，所以把所有號碼切成每 20 顆一組
    const groups = [];
    for (let i = 0; i < numMatches.length; i += 20) {
      const slice = numMatches.slice(i, i + 20);
      if (slice.length === 20) {
        groups.push(slice);
      }
    }

    if (!drawNos.length || !groups.length) {
      return res.status(500).json({
        ok: false,
        error: "Could not parse draw numbers or groups",
        source: sourceUrl,
        drawNos: drawNos.length,
        groups: groups.length
      });
    }

    // 4. 取較小長度，避免對不起來
    const count = Math.min(drawNos.length, groups.length);

    // 5. 先查資料庫已經有哪些 draw_no
    const latestCheckUrl =
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no&order=draw_no.desc&limit=300`;

    const latestCheckRes = await fetch(latestCheckUrl, {
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
      }
    });

    if (!latestCheckRes.ok) {
      const detail = await latestCheckRes.text();
      return res.status(500).json({
        ok: false,
        error: "Supabase check failed",
        detail
      });
    }

    const existingRows = await latestCheckRes.json();
    const existingSet = new Set(
      (existingRows || []).map(row => String(row.draw_no))
    );

    // 6. 建立候選清單
    const candidates = [];
    for (let i = 0; i < count; i++) {
      const drawNo = String(drawNos[i]);
      const numbers = groups[i].map(x => String(x).padStart(2, "0"));
      if (!existingSet.has(drawNo)) {
        candidates.push({
          draw_no: Number(drawNo),
          draw_time: "補抓",
          numbers: numbers.join(" ")
        });
      }
    }

    // 7. 沒有缺期
    if (!candidates.length) {
      return res.status(200).json({
        ok: true,
        source: sourceUrl,
        latestParsed: drawNos[0] || null,
        inserted: 0,
        skipped: count,
        message: "沒有缺少期數需要補抓"
      });
    }

    // 8. 由舊到新排序後補進去
    candidates.sort((a, b) => a.draw_no - b.draw_no);

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(candidates)
    });

    if (!insertRes.ok) {
      const detail = await insertRes.text();
      return res.status(500).json({
        ok: false,
        error: "Supabase insert failed",
        detail
      });
    }

    const insertedRows = await insertRes.json();

    return res.status(200).json({
      ok: true,
      source: sourceUrl,
      latestParsed: drawNos[0] || null,
      inserted: insertedRows.length,
      insertedDrawNos: insertedRows.map(r => r.draw_no),
      message: "補抓完成"
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "catchup failed"
    });
  }
}
