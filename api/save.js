import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js";

function isValidDrawNo(drawNo) {
  return Number.isInteger(drawNo) && drawNo >= 100000000 && drawNo <= 999999999;
}

function isValidDrawTime(drawTime) {
  return typeof drawTime === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(drawTime);
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
    const draws = parseAuzoBingoDraws(html, dateStr);

    if (!Array.isArray(draws) || draws.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "parse bingo rows failed",
        source: sourceUrl
      });
    }

    const latest = draws[0];
    const latestDrawNo = Number(latest.draw_no);
    const latestDrawTime = latest.draw_time;
    const latestNumbers = latest.numbers;

    if (!isValidDrawNo(latestDrawNo)) {
      return res.status(500).json({
        ok: false,
        error: "invalid draw_no parsed",
        latest
      });
    }

    if (!isValidDrawTime(latestDrawTime)) {
      return res.status(500).json({
        ok: false,
        error: "invalid draw_time parsed",
        latest
      });
    }

    if (!latestNumbers || typeof latestNumbers !== "string") {
      return res.status(500).json({
        ok: false,
        error: "invalid numbers parsed",
        latest
      });
    }

    const insertPayload = {
      draw_no: latestDrawNo,
      draw_time: latestDrawTime,
      numbers: latestNumbers
    };

    const insertResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?on_conflict=draw_no`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates,return=representation"
        },
        body: JSON.stringify(insertPayload)
      }
    );

    const insertText = await insertResp.text();

    if (!insertResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `insert failed: ${insertResp.status}`,
        rawPreview: insertText.slice(0, 500),
        tryingToInsert: insertPayload
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

    let saved = false;
    let skipped = false;

    if (Array.isArray(insertRows) && insertRows.length > 0) {
      saved = true;
    } else if (latestInDb && Number(latestInDb.draw_no) === latestDrawNo) {
      skipped = true;
    }

    return res.status(200).json({
      ok: true,
      saved,
      skipped,
      latest: {
        draw_no: latestDrawNo,
        draw_time: latestDrawTime,
        numbers: latestNumbers
      },
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
