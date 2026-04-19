import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js";

function calcFeatures(numbersStr) {
  const nums = String(numbersStr || "")
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter(n => n >= 1 && n <= 80);

  if (nums.length === 0) return {};

  return {
    sum_value: nums.reduce((a, b) => a + b, 0),
    span_value: Math.max(...nums) - Math.min(...nums),
    big_count: nums.filter(n => n >= 41).length,
    small_count: nums.filter(n => n <= 40).length,
    odd_count: nums.filter(n => n % 2 === 1).length,
    even_count: nums.filter(n => n % 2 === 0).length
  };
}

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

    const now = new Date();
    const dateStr = now.toLocaleDateString("sv-SE", {
      timeZone: "Asia/Taipei"
    }).replaceAll("-", "");

    const sourceUrl = `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

    const response = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
    const draws = parseAuzoBingoDraws(html, dateStr);

    if (!Array.isArray(draws) || draws.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "parse bingo rows failed",
        source: sourceUrl
      });
    }

    // 只抓今天頁面解析出的期號範圍
    const parsedDrawNos = draws
      .map(d => Number(d.draw_no))
      .filter(n => Number.isInteger(n) && n > 0);

    const minDrawNo = Math.min(...parsedDrawNos);
    const maxDrawNo = Math.max(...parsedDrawNos);

    // 一次查出這個範圍內已存在的 draw_no
    const checkUrl =
      `${SUPABASE_URL}/rest/v1/bingo_draws` +
      `?select=draw_no` +
      `&draw_no=gte.${minDrawNo}` +
      `&draw_no=lte.${maxDrawNo}` +
      `&limit=300`;

    const checkResp = await fetch(checkUrl, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });

    const checkText = await checkResp.text();

    if (!checkResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `check failed: ${checkResp.status}`,
        rawPreview: checkText.slice(0, 500)
      });
    }

    let existingRows = [];
    try {
      existingRows = JSON.parse(checkText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "check parse failed",
        rawPreview: checkText.slice(0, 500)
      });
    }

    const existingSet = new Set(
      (Array.isArray(existingRows) ? existingRows : [])
        .map(r => Number(r.draw_no))
        .filter(n => Number.isInteger(n))
    );

    const missing = draws
      .map(d => ({
        draw_no: Number(d.draw_no),
        draw_time: d.draw_time,
        numbers: d.numbers,
        ...calcFeatures(d.numbers)
      }))
      .filter(d =>
        Number.isInteger(d.draw_no) &&
        d.draw_no > 0 &&
        typeof d.draw_time === "string" &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.draw_time) &&
        typeof d.numbers === "string" &&
        !existingSet.has(d.draw_no)
      )
      .sort((a, b) => a.draw_no - b.draw_no);

    if (missing.length === 0) {
      return res.status(200).json({
        ok: true,
        inserted: 0,
        message: "沒有缺期",
        parsed: draws.length,
        minDrawNo,
        maxDrawNo
      });
    }

    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(missing)
    });

    const insertText = await insertResp.text();

    if (!insertResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `insert failed: ${insertResp.status}`,
        rawPreview: insertText.slice(0, 500),
        tryingToInsertCount: missing.length,
        firstMissing: missing[0] || null
      });
    }

    let insertedRows = [];
    try {
      insertedRows = JSON.parse(insertText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "insert parse failed",
        rawPreview: insertText.slice(0, 500)
      });
    }

    return res.status(200).json({
      ok: true,
      inserted: Array.isArray(insertedRows) ? insertedRows.length : missing.length,
      parsed: draws.length,
      minDrawNo,
      maxDrawNo
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "catchup failed"
    });
  }
}
