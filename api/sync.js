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

    // ===== 1) 台北時間 + 安全延遲 3 分鐘 =====
    const now = new Date();
    const taipeiNow = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Taipei" })
    );

    const safeNow = new Date(taipeiNow.getTime() - 3 * 60 * 1000);

    const yyyy = safeNow.getFullYear();
    const mm = String(safeNow.getMonth() + 1).padStart(2, "0");
    const dd = String(safeNow.getDate()).padStart(2, "0");
    const hh = safeNow.getHours();
    const mi = safeNow.getMinutes();

    const taipeiDate = `${yyyy}${mm}${dd}`;
    const safeTimeText = `${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;

    const sourceUrl = `https://lotto.auzo.tw/bingobingo/list_${taipeiDate}.html`;

    // ===== 2) 抓澳所當日頁 =====
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

    // ===== 3) 先抓頁面中所有表格列：期數 / 時間 / 20顆號碼 =====
    const dayRows = [];

    // 比之前更寬鬆，避免頁面格式微調就失效
    const rowRegex = /(\d{8})[\s\S]{0,220}?(\d{2}:\d{2})[\s\S]{0,2600}?((?:>\d{2}<[\s\S]{0,120}){20})/g;

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

    // 去重（同一期若抓到多次只留一筆）
    const uniqueRows = [];
    const seen = new Set();

    for (const row of dayRows) {
      if (!seen.has(row.draw_no)) {
        seen.add(row.draw_no);
        uniqueRows.push(row);
      }
    }

    // 依期數新到舊排序
    uniqueRows.sort((a, b) => b.draw_no - a.draw_no);

    // ===== 4) 依安全延遲 3 分鐘，選出「穩定期數」 =====
    // 規則：只選 draw_time <= safeNow 的最新一筆
    // 若沒有，就退回抓到的第一筆
    function timeToMinutes(text) {
      const [h, m] = String(text).split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
      return h * 60 + m;
    }

    const safeMinutes = hh * 60 + mi;

    let stableLatest =
      uniqueRows.find(row => timeToMinutes(row.draw_time) <= safeMinutes) ||
      uniqueRows[0] ||
      null;

    // ===== 5) 如果表格沒抓到，就退回最上面 20 顆號碼 =====
    // 這是最後保底，至少讓前端先有最新號碼可用
    if (!stableLatest) {
      const topBallMatches = html.match(/>\d{2}</g) || [];
      const latestNumbers = topBallMatches
        .slice(0, 20)
        .map(x => x.replace(/[^\d]/g, ""));

      if (latestNumbers.length !== 20) {
        return res.status(500).json({
          ok: false,
          error: "Could not parse latest numbers",
          sourceUrl,
          safeTimeText
        });
      }

      stableLatest = {
        draw_no: null,
        draw_time: "即時更新",
        numbers: latestNumbers.join(" ")
      };
    }

    // ===== 6) 寫入資料庫（只有抓得到期數時才寫） =====
    let insertedCount = 0;
    let skippedExistingCount = 0;

    const rowsCanSave = uniqueRows.filter(row => row.draw_no);

    if (rowsCanSave.length > 0) {
      const drawNos = rowsCanSave.map(row => row.draw_no);
      let existingSet = new Set();

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

      const newRows = rowsCanSave.filter(row => !existingSet.has(row.draw_no));
      skippedExistingCount = rowsCanSave.length - newRows.length;

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

        if (saveRes.ok) {
          insertedCount = newRows.length;
        }
      }
    }

    // ===== 7) 取最新 20 期給前端 =====
    let recent20 = [];

    const recent20Res = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers&order=draw_no.desc&limit=20`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (recent20Res.ok) {
      recent20 = await recent20Res.json();
    }

    // 如果資料庫還很空，就把今天抓到的 uniqueRows 補給前端一些底稿
    if ((!recent20 || recent20.length === 0) && uniqueRows.length > 0) {
      recent20 = uniqueRows.slice(0, 20);
    }

    // ===== 8) 回傳給前端 =====
    return res.status(200).json({
      ok: true,
      sourceUrl,
      syncPolicy: {
        timezone: "Asia/Taipei",
        safeDelayMinutes: 3,
        safeTimeUsed: safeTimeText
      },
      latest: {
        drawNo: stableLatest.draw_no || "即時同步",
        drawTime: stableLatest.draw_time || "即時更新",
        numbers: String(stableLatest.numbers).split(" ")
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
        insertedCount,
        skippedExistingCount
      }
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Unknown error"
    });
  }
}
