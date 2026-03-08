import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js"

export default async function handler(req, res) {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL

    const SUPABASE_KEY =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_KEY

    if (!SUPABASE_URL || !SUPABASE_KEY) {

      return res.status(500).json({
        ok: false,
        error: "missing supabase env"
      })

    }

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
        error: "parse bingo rows failed"
      })

    }

    const checkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no&order=draw_no.desc&limit=300`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    )

    const existing = await checkResp.json()

    const existSet =
      new Set(existing.map(x => String(x.draw_no)))

    const missing =
      draws.filter(r => !existSet.has(String(r.draw_no)))

    if (!missing.length) {

      return res.status(200).json({
        ok: true,
        inserted: 0,
        message: "沒有缺期",
        parsed: draws.length
      })

    }

    const insertResp = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(missing)
      }
    )

    const inserted = await insertResp.json()

    return res.status(200).json({
      ok: true,
      inserted: inserted.length,
      drawNos: inserted.map(x => x.draw_no),
      parsed: draws.length
    })

  } catch (err) {

    return res.status(500).json({
      ok: false,
      error: err.message || "catchup failed"
    })

  }

}
