import { parseAuzoBingoDraws } from "../lib/parseAuzoBingo.js";

export default async function handler(req, res) {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_KEY;

    const now = new Date();

    const dateStr = now.toLocaleDateString("sv-SE", {
      timeZone: "Asia/Taipei"
    }).replaceAll("-", "");

    const sourceUrl =
      `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

    const resp = await fetch(sourceUrl);

    const html = await resp.text();

    const draws = parseAuzoBingoDraws(html, dateStr);

    let inserted = 0;

    for (const draw of draws) {

      const drawNo = Number(draw.draw_no);

      const check = await fetch(
        `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no&draw_no=eq.${drawNo}&limit=1`,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`
          }
        }
      );

      const exist = await check.json();

      if (!exist || exist.length === 0) {

        await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            draw_no: drawNo,
            draw_time: draw.draw_time,
            numbers: draw.numbers
          })
        });

        inserted++;
      }

    }

    res.json({
      ok: true,
      parsed: draws.length,
      inserted
    });

  } catch (err) {

    res.status(500).json({
      ok: false,
      error: err.message
    });

  }
}
