export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL
    const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY

    const apiUrl =
      "https://api.taiwanlottery.com/TLCAPIWeB/Lottery/BingoBingoResult"

    const r = await fetch(apiUrl)
    const data = await r.json()

    const draws = data?.content?.lotteryDrawResult || []

    if (!draws.length) {
      return res.json({
        ok: false,
        message: "沒有抓到資料"
      })
    }

    const rows = draws.map(d => ({
      draw_no: Number(d.drawNumber),
      draw_time: d.drawDate + " " + d.drawTime,
      numbers: d.drawNumberSize
        .map(n => String(n).padStart(2, "0"))
        .join(" ")
    }))

    const check = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no&order=draw_no.desc&limit=200`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    )

    const existing = await check.json()

    const existSet = new Set(existing.map(x => String(x.draw_no)))

    const missing = rows.filter(
      r => !existSet.has(String(r.draw_no))
    )

    if (!missing.length) {
      return res.json({
        ok: true,
        inserted: 0,
        message: "沒有缺期"
      })
    }

    const insert = await fetch(
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

    const inserted = await insert.json()

    res.json({
      ok: true,
      inserted: inserted.length,
      drawNos: inserted.map(x => x.draw_no)
    })
  } catch (err) {
    res.json({
      ok: false,
      error: err.message
    })
  }
}
