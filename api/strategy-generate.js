function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseNumbers(str) {
  return String(str || "")
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => pad2(x))
    .slice(0, 20);
}

function countFreq(rows, weight = 1) {
  const map = {};
  for (const row of rows) {
    const nums = parseNumbers(row.numbers);
    for (const n of nums) {
      map[n] = (map[n] || 0) + weight;
    }
  }
  return map;
}

function mergeScores(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [num, score] of Object.entries(map)) {
      merged[num] = (merged[num] || 0) + score;
    }
  }
  return merged;
}

function sortByScore(scoreMap) {
  return Object.entries(scoreMap)
    .map(([num, score]) => ({ num, score }))
    .sort((a, b) => b.score - a.score || Number(a.num) - Number(b.num));
}

function uniq(arr) {
  return [...new Set(arr)];
}

function takeTopDistinct(sorted, count, exclude = []) {
  const excludeSet = new Set(exclude);
  const result = [];

  for (const item of sorted) {
    if (excludeSet.has(item.num)) continue;
    if (!result.includes(item.num)) {
      result.push(item.num);
    }
    if (result.length >= count) break;
  }

  return result;
}

function takeTopByCondition(sorted, count, condition, exclude = []) {
  const excludeSet = new Set(exclude);
  const result = [];

  for (const item of sorted) {
    if (excludeSet.has(item.num)) continue;
    if (!condition(item.num, item.score)) continue;
    if (!result.includes(item.num)) {
      result.push(item.num);
    }
    if (result.length >= count) break;
  }

  return result;
}

function getZone(num) {
  const n = Number(num);
  if (n <= 20) return "01-20";
  if (n <= 40) return "21-40";
  if (n <= 60) return "41-60";
  return "61-80";
}

function getTail(num) {
  return Number(num) % 10;
}

function buildSectionStats(rows) {
  const counts = {
    "01-20": 0,
    "21-40": 0,
    "41-60": 0,
    "61-80": 0
  };

  for (const row of rows) {
    for (const n of parseNumbers(row.numbers)) {
      counts[getZone(n)] += 1;
    }
  }

  return counts;
}

function buildTailStats(rows) {
  const counts = {};
  for (const row of rows) {
    for (const n of parseNumbers(row.numbers)) {
      const t = getTail(n);
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return counts;
}

function buildHotChase(todayRows, recent20Rows, recent80Rows) {
  const todayScore = countFreq(todayRows, 5);
  const recent20Score = countFreq(recent20Rows, 3);
  const recent80Score = countFreq(recent80Rows, 1);

  const merged = mergeScores(todayScore, recent20Score, recent80Score);
  const sorted = sortByScore(merged);
  const nums = takeTopDistinct(sorted, 4);

  return {
    key: "hot_chase",
    label: "熱門追擊型",
    nums,
    reason: "今日盤高頻 + 近20期熱號 + 近80期底盤",
    scorePreview: sorted.slice(0, 8)
  };
}

function buildRebound(todayRows, recent20Rows, recent80Rows) {
  const todayScore = countFreq(todayRows, 1);
  const recent20Score = countFreq(recent20Rows, 1);
  const recent80Score = countFreq(recent80Rows, 4);

  const reboundMap = {};
  const baseSorted = sortByScore(recent80Score);

  for (const item of baseSorted) {
    const num = item.num;
    const base = recent80Score[num] || 0;
    const today = todayScore[num] || 0;
    const recent = recent20Score[num] || 0;

    reboundMap[num] = base - today * 1.25 - recent * 0.85;
  }

  const sorted = sortByScore(reboundMap).filter(x => (recent80Score[x.num] || 0) > 0);
  const nums = takeTopDistinct(sorted, 4);

  return {
    key: "rebound",
    label: "回補反彈型",
    nums,
    reason: "近80期常見，但今日與近20期相對沉寂",
    scorePreview: sorted.slice(0, 8)
  };
}

function buildZoneBalanced(todayRows, recent20Rows, recent80Rows) {
  const merged = mergeScores(
    countFreq(todayRows, 3),
    countFreq(recent20Rows, 2),
    countFreq(recent80Rows, 1)
  );

  const sorted = sortByScore(merged);
  const zones = ["01-20", "21-40", "41-60", "61-80"];
  const nums = [];

  for (const zone of zones) {
    const one = takeTopByCondition(
      sorted,
      1,
      num => getZone(num) === zone,
      nums
    );
    nums.push(...one);
  }

  if (nums.length < 4) {
    nums.push(...takeTopDistinct(sorted, 4 - nums.length, nums));
  }

  return {
    key: "zone_balanced",
    label: "區段平衡型",
    nums: nums.slice(0, 4),
    reason: "四大區段各取一碼，降低單區過熱風險",
    scorePreview: sorted.slice(0, 8)
  };
}

function buildPatternStructure(todayRows, recent20Rows, recent80Rows) {
  const merged = mergeScores(
    countFreq(todayRows, 4),
    countFreq(recent20Rows, 2),
    countFreq(recent80Rows, 1)
  );

  const sorted = sortByScore(merged).slice(0, 24);
  const tailMap = {};

  for (const item of sorted) {
    const t = getTail(item.num);
    tailMap[t] = (tailMap[t] || 0) + item.score;
  }

  const bestTail = Object.entries(tailMap)
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  let nums = takeTopByCondition(
    sorted,
    4,
    num => String(getTail(num)) === String(bestTail)
  );

  if (nums.length < 4) {
    const ordered = sorted.map(x => Number(x.num)).sort((a, b) => a - b);
    for (let i = 0; i < ordered.length; i++) {
      const n = ordered[i];
      if (ordered.includes(n + 1)) {
        nums = uniq([...nums, pad2(n), pad2(n + 1)]);
      }
      if (nums.length >= 4) break;
    }
  }

  if (nums.length < 4) {
    nums.push(...takeTopDistinct(sorted, 4 - nums.length, nums));
  }

  return {
    key: "pattern_structure",
    label: "盤型結構型",
    nums: nums.slice(0, 4),
    reason: `優先抓同尾結構${bestTail !== undefined ? `（尾數 ${bestTail}）` : ""}，不足再補鄰號`,
    scorePreview: sorted.slice(0, 8)
  };
}

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "missing supabase env"
      });
    }

    const nRaw = Number(req.query?.n || 80);
    const n = Number.isInteger(nRaw) ? Math.max(20, Math.min(nRaw, 300)) : 80;

    const query =
      `${SUPABASE_URL}/rest/v1/bingo_draws` +
      `?select=draw_no,draw_time,numbers` +
      `&order=draw_no.desc` +
      `&limit=${n}`;

    const resp = await fetch(query, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });

    const text = await resp.text();

    if (!resp.ok) {
      return res.status(500).json({
        ok: false,
        error: `recent rows fetch failed: ${resp.status}`,
        rawPreview: text.slice(0, 500)
      });
    }

    let rows = [];
    try {
      rows = JSON.parse(text);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "recent rows parse failed",
        rawPreview: text.slice(0, 500)
      });
    }

    if (!Array.isArray(rows) || rows.length < 20) {
      return res.status(500).json({
        ok: false,
        error: "not enough rows in bingo_draws",
        count: Array.isArray(rows) ? rows.length : 0
      });
    }

    const cleanRows = rows
      .filter(r =>
        Number.isInteger(Number(r.draw_no)) &&
        typeof r.draw_time === "string" &&
        typeof r.numbers === "string"
      )
      .map(r => ({
        draw_no: Number(r.draw_no),
        draw_time: r.draw_time,
        numbers: r.numbers
      }));

    const recent20Rows = cleanRows.slice(0, 20);
    const todayRows = cleanRows.slice(0, Math.min(120, cleanRows.length));
    const recent80Rows = cleanRows.slice(0, Math.min(80, cleanRows.length));

    const sectionStats = buildSectionStats(recent20Rows);
    const tailStats = buildTailStats(recent20Rows);

    const s1 = buildHotChase(todayRows, recent20Rows, recent80Rows);
    const s2 = buildRebound(todayRows, recent20Rows, recent80Rows);
    const s3 = buildZoneBalanced(todayRows, recent20Rows, recent80Rows);
    const s4 = buildPatternStructure(todayRows, recent20Rows, recent80Rows);

    const groups = [s1, s2, s3, s4].map((s, idx) => ({
      groupNo: idx + 1,
      key: s.key,
      label: `第${idx + 1}組｜${s.label}`,
      nums: uniq(s.nums).slice(0, 4),
      reason: s.reason
    }));

    return res.status(200).json({
      ok: true,
      mode: "bingo_strategy_generate_v1",
      target: {
        stars: 4,
        groups: 4,
        periods: 4
      },
      usedRows: cleanRows.length,
      recentWindow: n,
      latestDrawNo: cleanRows[0]?.draw_no || null,
      latestDrawTime: cleanRows[0]?.draw_time || null,
      sectionStats,
      tailStats,
      groups
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "strategy-generate failed"
    });
  }
}
