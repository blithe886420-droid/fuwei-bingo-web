export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE_SECRET_KEY"
      });
    }

    // 台灣日期 YYYYMMDD
    const now = new Date();
    const taipeiDate = now
      .toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" })
      .replaceAll("-", "");

    const sourceUrl = `https://lotto.auzo.tw/bingobingo/list_${taipeiDate}.html`;

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
        error: `Source fetch failed: ${response.status}`,
        sourceUrl
      });
    }

    const html = await response.text();

    // 先抓最上面 20 顆紅球
    const topBallMatches = html.match(/>\d{2}</g) || [];
    const latestNumbers = topBallMatches
      .slice(0, 20)
      .map(x => x.replace(/[^\d]/g, ""));

    // 期數與時間改用更寬鬆方式抓
    const drawNoMatch = html.match(/第\s*(\d{8,})\s*期/);
    const drawTimeMatch = html.match(/\(\s*\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})\s*\)/);

    const latestDrawNo = drawNoMatch ? Number(drawNoMatch[1]) : null;
    const latestDrawTime = drawTimeMatch ? drawTimeMatch[1] : null;

    if (!latestDrawNo || !latestDrawTime || latestNumbers.length !== 20) {
      return res.status(500).json({
        ok: false,
        error: "Could not parse latest draw",
        sourceUrl,
        latestDrawNo,
        latestDrawTime,
        latestNumbersCount: latestNumbers.length
      });
    }

    // 抓當日頁全部期數
    const dayRows = [];
    const rowRegex = /(\d{8})[\s\S]{0,160}?(\d{2}:\d{2})[\s\S]{0,1800}?((?:>\d{2}<[\s\S]{0,80}){20})/g;

    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const drawNo = Number(match[1]);
      const drawTime = match[2];
      const numbers = [...match[3].matchAll(/>(\d{2})</g)]
        .map(x => x[1])
        .slice(0, 20);

      if (drawNo && drawTime && numbers.length === 20) {
        dayRows.push({
          draw_no: drawNo,
          draw_time: drawTime,
          numbers: numbers.join(" ")
        });
      }
    }

    // 補上最新一期
    if (!dayRows.some(row => row.draw_no === latestDrawNo)) {
      dayRows.unshift({
        draw_no: latestDrawNo,
        draw_time: latestDrawTime,
        numbers: latestNumbers.join(" ")
      });
    }

    // 去重
    const uniqueRows = [];
    const seen = new Set();

    for (const row of dayRows) {
      if (!seen.has(row.draw_no)) {
        seen.add(row.draw_no);
        uniqueRows.push(row);
      }
    }

    // 查既有期數
    const drawNos = uniqueRows.map(row => row.draw_no);
    let existingSet = new Set();

    if (drawNos.length > 0) {
      const existingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no&draw_no=in.(${drawNos.join(",")})`,
        {
          headers: {
            apikey: SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
          }
        }
      );

      if (existingRes.ok) {
        const existingJson = await existingRes.json();
        existingSet = new Set(existingJson.map(item => Number(item.draw_no)));
      }
    }

    const newRows = uniqueRows.filter(row => !existingSet.has(row.draw_no));

    if (newRows.length > 0) {
      const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/bingo_draws`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(newRows)
      });

      if (!saveRes.ok) {
        const detail = await saveRes.text();
        return res.status(500).json({
          ok: false,
          error: "Supabase insert failed",
          detail
        });
      }
    }

    const recent20Res = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers&order=draw_no.desc&limit=20`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (!recent20Res.ok) {
      const detail = await recent20Res.text();
      return res.status(500).json({
        ok: false,
        error: "Failed to fetch recent 20 draws",
        detail
      });
    }

    const recent20 = await recent20Res.json();

    return res.status(200).json({
      ok: true,
      sourceUrl,
      latest: {
        drawNo: latestDrawNo,
        drawTime: latestDrawTime,
        numbers: latestNumbers
      },
      recent20,
      modes: {
        testMode: {
          label: "測試模式",
          description: "用最新20期生成四組四星，先追2期，再看損益是否接近成本或小贏"
        },
        directMode: {
          label: "直接正式投注",
          description: "直接生成四組四星，追4期"
        }
      },
      stats: {
        dayParsedCount: uniqueRows.length,
        insertedCount: newRows.length,
        skippedExistingCount: uniqueRows.length - newRows.length
      }
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Unknown error"
    });
  }
}
