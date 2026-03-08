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
    const dateStr = `${yyyy}${mm}${dd}`;

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

    // 先用「第 XXXXX 期」切段
    const drawHeaderRegex = /第\s*(\d+)\s*期/g;
    const matches = [...html.matchAll(drawHeaderRegex)];

    if (!matches.length) {
      return res.status(500).json({
        ok: false,
        error: "No draw headers found",
        source: sourceUrl
      });
    }

    const parsedRows = [];

    for (let i = 0; i < matches.length; i++) {
      const drawNo = matches[i][1];
      const start = matches[i].index;
      const end = i + 1 < matches.length ? matches[i + 1].index : html.length;

      const block = html.slice(start, end);

      // 只在這一期區塊內抓兩位數
      const nums = (block.match(/\b\d{2}\b/g) || [])
        .map(x => String(x).padStart(2, "0"));

      // 去重後保留順序
      const uniqueNums = [];
      for (const n of nums) {
        if (!uniqueNums.includes(n)) uniqueNums.push(n);
      }

      // Bingo 一期一定要有 20 顆
      if (uniqueNums.length >= 20) {
        parsedRows.push({
          draw_no: Number(drawNo),
          draw_time: "補抓",
          numbers: uniqueNums.slice(0, 20).join(" ")
        });
      }
    }

    if (!parsedRows.length) {
      return res.status(500).json({
        ok: false,
        error: "No valid draw rows parsed",
        source: sourceUrl
      });
    }

    // 查資料庫已存在的期數
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no&order=draw_no.desc&limit=500`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (!existingRes.ok) {
      const detail = await existingRes.text();
      return res.status(500).json({
        ok: false,
        error: "Supabase existing check failed",
        detail
      });
    }

    const existingRows = await existingRes.json();
    const existingSet = new Set(existingRows.map(r => String(r.draw_no)));

    const missingRows = parsedRows
      .filter(row => !existingSet.has(String(row.draw_no)))
      .sort((a, b) => a.draw_no - b.draw_no);

    if (!missingRows.length) {
      return res.status(200).json({
        ok: true,
        source: sourceUrl,
        parsed: parsedRows.length,
        inserted: 0,
        message: "沒有缺少期數需要補抓",
        latestParsedDrawNo: parsedRows[0]?.draw_no || null
      });
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(missingRows)
    });

    if (!insertRes.ok) {
      const detail = await insertRes.text();
      return res.status(500).json({
        ok: false,
        error: "Supabase insert failed",
        detail,
        missingPreview: missingRows.slice(0, 5)
      });
    }

    const inserted = await insertRes.json();

    return res.status(200).json({
      ok: true,
      source: sourceUrl,
      parsed: parsedRows.length,
      inserted: inserted.length,
      insertedDrawNos: inserted.map(r => r.draw_no),
      firstInserted: inserted[0] || null,
      lastInserted: inserted[inserted.length - 1] || null,
      message: "補抓完成"
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "catchup failed"
    });
  }
}
