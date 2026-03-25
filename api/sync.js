import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js";

const FETCH_TIMEOUT_MS = 10000;

function buildTaipeiDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value || "";
  const month = parts.find((p) => p.type === "month")?.value || "";
  const day = parts.find((p) => p.type === "day")?.value || "";

  return {
    year,
    month,
    day,
    dateStr: `${year}${month}${day}`
  };
}

function buildTaipeiTimeString(date = new Date()) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeNumbers(rawNumbers) {
  if (Array.isArray(rawNumbers)) {
    return rawNumbers
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  return String(rawNumbers || "")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function buildFallbackRegexDraws(html, dateStr) {
  const rows = [];
  const rowRegex = /<tr[^>]*class="bingo_row"[^>]*>([\s\S]*?)<\/tr>/g;

  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1];

    const periodMatch =
      rowHtml.match(/<td[^>]*class="BPeriod"[^>]*>\s*<b>(\d+)<\/b>\s*<br>\s*(\d{2}:\d{2})\s*<\/td>/i) ||
      rowHtml.match(/<td[^>]*class="BPeriod"[^>]*>[\s\S]*?(\d+)[\s\S]*?(\d{2}:\d{2})[\s\S]*?<\/td>/i);

    if (!periodMatch) continue;

    const draw_no = periodMatch[1];
    const drawClock = periodMatch[2];

    const divMatches = [
      ...rowHtml.matchAll(/<div[^>]*>(\d{2})<\/div>/g)
    ];

    const numbers = divMatches.map((m) => m[1]);

    if (numbers.length !== 20) continue;

    const yyyy = dateStr.slice(0, 4);
    const mm = dateStr.slice(4, 6);
    const dd = dateStr.slice(6, 8);

    rows.push({
      draw_no,
      draw_time: `${yyyy}-${mm}-${dd} ${drawClock}:00`,
      numbers: numbers.join(" ")
    });
  }

  return rows;
}

function safeParseDraws(html, dateStr) {
  try {
    const parsed = parseAuzoBingoDraws(html, dateStr);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch {
    // 交由 fallback parser
  }

  return buildFallbackRegexDraws(html, dateStr);
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const now = new Date();
    const { dateStr } = buildTaipeiDateParts(now);

    const sourceUrl = `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

    let response;
    try {
      response = await fetchWithTimeout(
        sourceUrl,
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-TW,zh;q=0.9"
          }
        },
        FETCH_TIMEOUT_MS
      );
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? `fetch timeout after ${FETCH_TIMEOUT_MS}ms`
          : error?.message || "fetch failed";

      return res.status(500).json({
        ok: false,
        error: message,
        source: sourceUrl
      });
    }

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: `fetch failed: ${response.status}`,
        source: sourceUrl
      });
    }

    const html = await response.text();
    const draws = safeParseDraws(html, dateStr);

    if (!Array.isArray(draws) || draws.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "Could not parse bingo rows",
        source: sourceUrl
      });
    }

    const latest = draws[0];
    const numbers = normalizeNumbers(latest?.numbers);

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
      capturedAt: buildTaipeiTimeString(new Date()),
      draw_no: Number(latest.draw_no),
      draw_time: latest.draw_time,
      numbers
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "sync failed"
    });
  }
}
