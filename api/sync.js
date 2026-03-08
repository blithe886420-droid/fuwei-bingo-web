export default async function handler(req, res) {
  try {

    const now = new Date();
    const dateStr = now.toLocaleDateString("sv-SE", {
      timeZone: "Asia/Taipei"
    }).replaceAll("-", "");

    const sourceUrl =
      `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

    const response = await fetch(sourceUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9",
        "Referer": "https://lotto.auzo.tw/"
      }
    });

    if (!response.ok) {
      throw new Error("fetch failed");
    }

    const html = await response.text();

    const numbers =
      html.match(/\b\d{2}\b/g)?.slice(0, 20) || [];

    return res.json({
      ok: true,
      source: sourceUrl,
      numbers
    });

  } catch (err) {

    return res.json({
      ok: false,
      error: err.message
    });

  }
}
