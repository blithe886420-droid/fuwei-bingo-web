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

    return res.status(200).json({
      ok: true,
      source: sourceUrl,
      length: html.length,
      previewStart: html.slice(0, 3000),
      previewMiddle: html.slice(
        Math.max(0, Math.floor(html.length / 2) - 1500),
        Math.min(html.length, Math.floor(html.length / 2) + 1500)
      ),
      previewEnd: html.slice(-3000)
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "inspect failed"
    });
  }
}
