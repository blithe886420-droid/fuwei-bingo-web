import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js";

function isValidDrawNo(drawNo) {
  return Number.isInteger(drawNo) && drawNo >= 100000000 && drawNo <= 999999999;
}

function isValidDrawTime(drawTime) {
  return typeof drawTime === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(drawTime);
}

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

function normalizeDrawRow(row) {
  const drawNo = Number(row?.draw_no);
  const drawTime = row?.draw_time || "";
  const numbers = typeof row?.numbers === "string"
    ? row.numbers
    : Array.isArray(row?.numbers)
      ? row.numbers.join(",")
      : "";

  if (!isValidDrawNo(drawNo)) return null;
  if (!isValidDrawTime(drawTime)) return null;
  if (!numbers) return null;

  return {
    draw_no: drawNo,
    draw_time: drawTime,
    numbers,
    ...calcFeatures(numbers)
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

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
    const parsedDraws = parseAuzoBingoDraws(html, dateStr);

    if (!Array.isArray(parsedDraws) || parsedDraws.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "parse bingo rows failed",
        source: sourceUrl
      });
    }

    const normalizedDraws = parsedDraws
      .map(normalizeDrawRow)
      .filter(Boolean)
      .sort((a, b) => b.draw_no - a.draw_no);

    if (!normalizedDraws.length) {
      return res.status(500).json({
        ok: false,
        error: "all parsed rows invalid",
        source: sourceUrl
      });
    }

    const latest = normalizedDraws[0];

    const insertResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?on_conflict=draw_no`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify(normalizedDraws)
      }
    );

    const insertText = await insertResp.text();

    if (!insertResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `insert failed: ${insertResp.status}`,
        rawPreview: insertText.slice(0, 500),
        tryingToInsertCount: normalizedDraws.length,
        tryingToInsertLatest: latest
      });
    }

    let insertRows = [];
    try {
      insertRows = insertText ? JSON.parse(insertText) : [];
    } catch {
      return res.status(500).json({
        ok: false,
        error: "insert parse failed",
        rawPreview: insertText.slice(0, 500)
      });
    }

    const recentResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers&order=draw_no.desc&limit=30`,
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
        error: `recent fetch failed: ${recentResp.status}`,
        rawPreview: recentText.slice(0, 500)
      });
    }

    let recentRows = [];
    try {
      recentRows = JSON.parse(recentText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "recent parse failed",
        rawPreview: recentText.slice(0, 500)
      });
    }

    const deduped = [];
    const seen = new Set();

    for (const row of Array.isArray(recentRows) ? recentRows : []) {
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

    const latestInDb = deduped[0] || null;
    const insertedCount = Array.isArray(insertRows) ? insertRows.length : 0;

    let saved = false;
    let skipped = false;

    if (insertedCount > 0) {
      saved = true;
    } else if (latestInDb && Number(latestInDb.draw_no) === Number(latest.draw_no)) {
      skipped = true;
    }

    return res.status(200).json({
      ok: true,
      saved,
      skipped,
      inserted_count: insertedCount,
      parsed_count: normalizedDraws.length,
      latest: latest,
      latestInDb,
      recent20: deduped.slice(0, 20)
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "save failed"
    });
  }
}
