import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js"

export default async function handler(req, res) {

  try {

    const now = new Date()

    const dateStr = now.toLocaleDateString("sv-SE", {
      timeZone: "Asia/Taipei"
    }).replaceAll("-", "")

    const sourceUrl =
      `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`

    const response = await fetch(sourceUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9"
      }
    })

    if (!response.ok) {

      return res.status(500).json({
        ok: false,
        error: `fetch failed: ${response.status}`,
        source: sourceUrl
      })

    }

    const html = await response.text()

    const draws = parseAuzoBingoDraws(html, dateStr)

    if (!draws.length) {

      return res.status(500).json({
        ok: false,
        error: "Could not parse bingo rows",
        source: sourceUrl
      })

    }

    const latest = draws[0]

    return res.status(200).json({
      ok: true,
      source: sourceUrl,
      draw: latest
    })

  } catch (err) {

    return res.status(500).json({
      ok: false,
      error: err.message || "sync failed"
    })

  }

}
