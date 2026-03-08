import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js";

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

    // 1. 直接抓今天奧索頁面
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

    if (!draws.length) {
      return res.status(500).json({
        ok: false,
        error: "parse bingo rows failed",
        source: sourceUrl
      });
    }

    // 2. 取最新一期
    const latest = draws[0];

    if (!latest?.draw_no || !latest?.draw_time || !latest?.numbers) {
      return res.status(500).json({
        ok: false,
        error: "latest draw is incomplete",
        latest
      });
    }

    // 3. 先檢查資料庫有沒有這一期
    const checkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?draw_no=eq.${encodeURIComponent(latest.draw_no)}&select=id,draw_no&limit=1`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const checkText = await checkResp.text();

    if (!checkResp.ok) {
      return res.status(500).json({
        ok: false,
        error: `check failed: ${checkResp.status}`,
        rawPreview: checkText.slice(0, 500)
      });
    }

    let checkRows = [];
    try {
      checkRows = JSON.parse(checkText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "check parse failed",
        rawPreview: checkText.slice(0, 500)
      });
    }

    let saved = false;
    let skipped = false;

    // 4. 沒有才寫入
    if (!checkRows.length) {
      const insertPayload = {
        draw_no: Number(latest.draw_no),
        draw_time: latest.draw_time,
        numbers: latest.numbers
      };

      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(insertPayload)
      });

      const insertText = await insertResp.text();

      if (!insertResp.ok) {
        return res.status(500).json({
          ok: false,
          error: `insert failed: ${insertResp.status}`,
          rawPreview: insertText.slice(0, 500),
          tryingToInsert: insertPayload
        });
      }

      saved = true;
    } else {
      skipped = true;
    }

    // 5. 回傳資料庫最新 20 期
    const recentResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers&order=draw_no.desc&limit=20`,
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
        error: `recent20 fetch failed: ${recentResp.status}`,
        rawPreview: recentText.slice(0, 500)
      });
    }

    let recent20 = [];
    try {
      recent20 = JSON.parse(recentText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "recent20 parse failed",
        rawPreview: recentText.slice(0, 500)
      });
    }

    return res.status(200).json({
      ok: true,
      saved,
      skipped,
      latest: {
        draw_no: Number(latest.draw_no),
        draw_time: latest.draw_time,
        numbers: latest.numbers
      },
      recent20
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "save failed"
    });
  }
}
