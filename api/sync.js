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

    return res.status(200).json({
      ok: true,
      source: sourceUrl,
      capturedAt: new Date().toLocaleTimeString("zh-TW", {
        hour12: false,
        timeZone: "Asia/Taipei"
      }),
      numbers
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "fetch failed"
    });
  }
}
