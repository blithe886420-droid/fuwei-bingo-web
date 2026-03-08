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

    // ===== 基本設定：台北時間 + 安全延遲 3 分鐘 =====
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

    const dateStr = `${yyyy}${mm}${dd}`;
    const safeTimeText = `${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;

    // ===== 資料來源 =====
    const OFFICIAL_URL = "https://www.taiwanlottery.com/lotto/result/bingo_bingo";
    const AUZO_URL = `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

    // ===== 共用工具 =====
    async function fetchWithRetry(url, options = {}, retries = 2) {
      let lastErr = null;

      for (let i = 0; i <= retries; i++) {
        try {
          const resp = await fetch(url, options);
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }
          return await resp.text();
        } catch (err) {
          lastErr = err;
        }
      }

      throw lastErr || new Error("fetch failed");
    }

    function toMinutes(text) {
      if (!text) return -1;
      const [h, m] = String(text).split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
      return h * 60 + m;
    }

    function uniqueByDrawNo(rows) {
      const out = [];
      const seen = new Set();

      for (const row of rows) {
        if (!row || !row.draw_no) continue;
        if (!seen.has(row.draw_no)) {
          seen.add(row.draw_no);
          out.push(row);
        }
      }

      return out;
    }

    function pickStableRow(rows, safeMinutes) {
      if (!Array.isArray(rows) || rows.length === 0) return null;

      const sorted = [...rows].sort((a, b) => b.draw_no - a.draw_no);

      const stable =
        sorted.find(row => toMinutes(row.draw_time) <= safeMinutes) || sorted[0];

      return stable || null;
    }

    // ===== 解析台彩官網（主來源）=====
    function parseOfficial(html) {
      const rows = [];

      // 抓所有兩位數號碼（供後面分組用）
      const numberPool = [...html.matchAll(/\b(\d{2})\b/g)].map(x => x[1]);

      // 抓所有時間
      const timePool = [...html.matchAll(/\b(\d{2}:\d{2})\b/g)].map(x => x[1]);

      // 抓所有看起來像期數的 8 碼（Bingo 期數通常 1 開頭）
      const drawNoPool = [...html.matchAll(/\b(1\d{7})\b/g)].map(x => Number(x[1]));

      // 粗略組成當日列
      // 做法：以期數為基準，每筆取一個時間與 20 顆號碼
      for (let i = 0; i < drawNoPool.length; i++) {
        const drawNo = drawNoPool[i];
        const drawTime = timePool[i] || null;
        const numbers = numberPool.slice(i * 20, i * 20 + 20);

        if (drawNo && drawTime && numbers.length === 20) {
          rows.push({
            draw_no: drawNo,
            draw_time: drawTime,
            numbers: numbers.join(" ")
          });
        }
      }

      return uniqueByDrawNo(rows);
    }

    // ===== 解析澳所（備援來源）=====
    function parseAuzo(html) {
      const rows = [];

      // 當日表格列：期數 / 時間 / 20顆號碼
      const rowRegex = /(\d{8})[\s\S]{0,220}?(\d{2}:\d{2})[\s\S]{0,2600}?((?:>\d{2}<[\s\S]{0,120}){20})/g;

      let match;
      while ((match = rowRegex.exec(html)) !== null) {
        const drawNo = Number(match[1]);
        const drawTime = match[2];
        const numbers = [...match[3].matchAll(/>(\d{2})</g)]
          .map(x => x[1])
          .slice(0, 20);

        if (drawNo && drawTime && numbers.length === 20) {
          rows.push({
            draw_no: drawNo,
            draw_time: drawTime,
            numbers: numbers.join(" ")
          });
        }
      }

      // 若 regex 沒抓夠，至少保底抓最上面 20 顆號碼
      const topBallMatches = html.match(/>\d{2}</g) || [];
      const latestNumbers = topBallMatches
        .slice(0, 20)
        .map(x => x.replace(/[^\d]/g, ""));

      const drawNoMatch = html.match(/\b(1\d{7})\b/);
      const timeMatch = html.match(/\(\s*\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})\s*\)/);

      const latestDrawNo = drawNoMatch ? Number(drawNoMatch[1]) : null;
      const latestDrawTime = timeMatch ? timeMatch[1] : null;

      if (
        latestDrawNo &&
        latestDrawTime &&
        latestNumbers.length === 20 &&
        !rows.some(r => r.draw_no === latestDrawNo)
      ) {
        rows.unshift({
          draw_no: latestDrawNo,
          draw_time: latestDrawTime,
          numbers: latestNumbers.join(" ")
        });
      }

      return uniqueByDrawNo(rows);
    }

    // ===== 先取 Supabase 最近 20 期（作為 fallback 與前端 recent20）=====
    async function getRecent20FromDb() {
      const recent20Res = await fetch(
        `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers&order=draw_no.desc&limit=20`,
        {
          headers: {
            apikey: SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
          }
        }
      );

      if (!recent20Res.ok) return [];
      return await recent20Res.json();
    }

    // ===== 寫入 Supabase（避免重複）=====
    async function saveRowsToDb(rows) {
      if (!rows || rows.length === 0) {
        return { insertedCount: 0, skippedExistingCount: 0 };
      }

      const drawNos = rows.map(r => r.draw_no);
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

      const newRows = rows.filter(row => !existingSet.has(row.draw_no));

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
          throw new Error(`Supabase insert failed: ${detail}`);
        }
      }

      return {
        insertedCount: newRows.length,
        skippedExistingCount: rows.length - newRows.length
      };
    }

    // ===== 主流程：官方優先，澳所備援，最後 DB fallback =====
    const safeMinutes = hh * 60 + mi;
    let sourceUsed = null;
    let parsedRows = [];
    let latest = null;
    let recent20 = await getRecent20FromDb();
    let insertedCount = 0;
    let skippedExistingCount = 0;

    // 1) 先試官方
    try {
      const officialHtml = await fetchWithRetry(
        OFFICIAL_URL,
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-TW,zh;q=0.9"
          }
        },
        1
      );

      const officialRows = parseOfficial(officialHtml);

      if (officialRows.length > 0) {
        parsedRows = officialRows;
        latest = pickStableRow(officialRows, safeMinutes);
        sourceUsed = "official";
      }
    } catch (err) {
      // 官方失敗，往下走澳所
    }

    // 2) 官方沒成，再試澳所
    if (!latest) {
      try {
        const auzoHtml = await fetchWithRetry(
          AUZO_URL,
          {
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "zh-TW,zh;q=0.9"
            }
          },
          1
        );

        const auzoRows = parseAuzo(auzoHtml);

        if (auzoRows.length > 0) {
          parsedRows = auzoRows;
          latest = pickStableRow(auzoRows, safeMinutes);
          sourceUsed = "auzo";
        }
      } catch (err) {
        // 澳所也失敗，往下走 fallback
      }
    }

    // 3) 有抓到 rows，就嘗試寫入 DB
    if (parsedRows.length > 0) {
      const saveResult = await saveRowsToDb(parsedRows);
      insertedCount = saveResult.insertedCount;
      skippedExistingCount = saveResult.skippedExistingCount;

      // 重新抓 recent20，讓前端拿到最新 DB 狀態
      recent20 = await getRecent20FromDb();
    }

    // 4) 若外部來源都失敗，就退回 DB 最近一筆
    if (!latest) {
      if (recent20 && recent20.length > 0) {
        latest = recent20[0];
        sourceUsed = "db_fallback";
      }
    }

    // 5) 最後還是沒資料，才真正回錯
    if (!latest) {
      return res.status(500).json({
        ok: false,
        error: "No available data from official, auzo, or database fallback"
      });
    }

    return res.status(200).json({
      ok: true,
      sourceUrl: sourceUsed === "official" ? OFFICIAL_URL : AUZO_URL,
      sourceUsed,
      syncPolicy: {
        timezone: "Asia/Taipei",
        safeDelayMinutes: 3,
        safeTimeUsed: safeTimeText
      },
      latest: {
        drawNo: latest.draw_no || "即時同步",
        drawTime: latest.draw_time || "即時更新",
        numbers: String(latest.numbers).split(" ")
      },
      recent20: Array.isArray(recent20) ? recent20 : [],
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
        dayParsedCount: parsedRows.length,
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
