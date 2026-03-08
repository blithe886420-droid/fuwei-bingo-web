import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js";

export default async function handler(req, res) {
  try {
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
        error: "Could not parse bingo rows",
        source: sourceUrl
      });
    }

    const latest = draws[0];
    const numbers = String(latest.numbers || "")
      .split(/\s+/)
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 20);

    if (numbers.length !== 20) {
      return res.status(500).json({
        ok: false,
        error: "未取得完整 20 顆號碼",
        source: sourceUrl,
        count: numbers.length
      });
    }

    return res.status(200).json({
      ok: true,
      source: sourceUrl,
      capturedAt: new Date().toLocaleTimeString("zh-TW", {
        hour12: false,
        timeZone: "Asia/Taipei"
      }),
      draw_no: Number(latest.draw_no),
      draw_time: latest.draw_time,
      numbers
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "sync failed"
    });
  }
}
