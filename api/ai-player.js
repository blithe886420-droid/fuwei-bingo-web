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

function takeCandidates(sorted, count = 20) {
  return sorted.slice(0, count).map(x => x.num);
}

function fillFallbackAny(usageMap, result, need = 4, limitPerNum = 3) {
  for (let i = 1; i <= 80; i++) {
    const num = pad2(i);
    const used = usageMap[num] || 0;
    if (used >= limitPerNum) continue;
    if (result.includes(num)) continue;

    result.push(num);
    usageMap[num] = used + 1;
    if (result.length >= need) break;
  }
  return result.slice(0, need);
}

function diversifyGroups(groups) {
  const usageMap = {};
  const diversified = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const candidates = uniq(g.candidates || []);
    let result = [];

    for (const num of candidates) {
      if (result.length >= 4) break;
      const used = usageMap[num] || 0;
      if (used >= 2) continue;
      if (result.includes(num)) continue;

      result.push(num);
      usageMap[num] = used + 1;
    }

    if (result.length < 4) {
      for (const num of candidates) {
        if (result.length >= 4) break;
        const used = usageMap[num] || 0;
        if (used >= 3) continue;
        if (result.includes(num)) continue;

        result.push(num);
        usageMap[num] = used + 1;
      }
    }

    if (result.length < 4) {
      result = fillFallbackAny(usageMap, result, 4, 3);
    }

    diversified.push({
      ...g,
      nums: result.slice(0, 4)
    });
  }

  return diversified;
}

function buildHotChase(todayRows, recent20Rows, recent80Rows) {
  const todayScore = countFreq(todayRows, 5);
  const recent20Score = countFreq(recent20Rows, 3);
  const recent80Score = countFreq(recent80Rows, 1);

  const merged = mergeScores(todayScore, recent20Score, recent80Score);
  const sorted = sortByScore(merged);

  return {
    key: "hot_chase",
    label: "第1組｜熱門追擊型",
    reason: "今日盤高頻 + 近20期熱號 + 長期底盤（權重 1.00）",
    candidates: takeCandidates(sorted, 16)
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

  return {
    key: "rebound",
    label: "第2組｜回補反彈型",
    reason: "近80期常見，但今日與近20期相對沉寂（權重 1.00）",
    candidates: takeCandidates(sorted, 20)
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
  const zoneFirst = [];

  for (const zone of zones) {
    const one = sorted.find(x => getZone(x.num) === zone);
    if (one) zoneFirst.push(one.num);
  }

  const allCandidates = uniq([
    ...zoneFirst,
    ...takeCandidates(sorted, 20)
  ]);

  return {
    key: "zone_balanced",
    label: "第3組｜區段平衡型",
    reason: "四大區段分散配置，降低單區過熱風險（權重 1.00）",
    candidates: allCandidates
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

  const sameTail = sorted
    .filter(x => String(getTail(x.num)) === String(bestTail))
    .map(x => x.num);

  const ordered = sorted.map(x => Number(x.num)).sort((a, b) => a - b);
  const nearNums = [];

  for (let i = 0; i < ordered.length; i++) {
    const n = ordered[i];
    if (ordered.includes(n + 1)) {
      nearNums.push(pad2(n), pad2(n + 1));
    }
  }

  const candidates = uniq([
    ...sameTail,
    ...nearNums,
    ...takeCandidates(sorted, 20)
  ]);

  return {
    key: "pattern_structure",
    label: "第4組｜盤型結構型",
    reason: "同尾優先，輔以鄰號與盤型結構（權重 1.00）",
    candidates
  };
}

function buildGroupsFromRows(rows) {
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

  if (cleanRows.length < 20) return [];

  const recent20Rows = cleanRows.slice(0, 20);
  const todayRows = cleanRows.slice(0, Math.min(120, cleanRows.length));
  const recent80Rows = cleanRows.slice(0, Math.min(80, cleanRows.length));

  const rawGroups = [
    buildHotChase(todayRows, recent20Rows, recent80Rows),
    buildRebound(todayRows, recent20Rows, recent80Rows),
    buildZoneBalanced(todayRows, recent20Rows, recent80Rows),
    buildPatternStructure(todayRows, recent20Rows, recent80Rows)
  ];

  const diversified = diversifyGroups(rawGroups);

  return diversified
    .map((g) => ({
      key: g.key,
      label: g.label,
      nums: uniq(g.nums).slice(0, 4).map(n => Number(n)),
      reason: g.reason
    }))
    .filter(g => g.nums.length === 4);
}

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      process.env.SUPABASE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing environment variables"
      });
    }

    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json"
    };

    const runningRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?select=id,created_at,source_draw_no&mode=eq.ai_train&status=eq.created&order=source_draw_no.desc,created_at.desc&limit=1`,
      { headers }
    );

    const runningText = await runningRes.text();

    if (!runningRes.ok) {
      return res.status(500).json({
        ok: false,
        error: "check running prediction failed",
        detail: runningText.slice(0, 500)
      });
    }

    let runningRows = [];
    try {
      runningRows = JSON.parse(runningText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "running prediction parse failed",
        detail: runningText.slice(0, 500)
      });
    }

    if (Array.isArray(runningRows) && runningRows.length > 0) {
      return res.status(200).json({
        ok: true,
        message: "ai_train prediction already running"
      });
    }

    const recentRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=draw_no,draw_time,numbers&order=draw_no.desc&limit=120`,
      { headers }
    );

    const recentText = await recentRes.text();

    if (!recentRes.ok) {
      return res.status(500).json({
        ok: false,
        error: "recent draws fetch failed",
        detail: recentText.slice(0, 500)
      });
    }

    let rows = [];
    try {
      rows = JSON.parse(recentText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "recent draws parse failed",
        detail: recentText.slice(0, 500)
      });
    }

    const groups = buildGroupsFromRows(rows);

    if (!groups.length) {
      return res.status(200).json({
        ok: true,
        message: "no strategy available"
      });
    }

    const latestDrawNo = Number(rows?.[0]?.draw_no || 0);

    if (!Number.isInteger(latestDrawNo) || latestDrawNo <= 0) {
      return res.status(500).json({
        ok: false,
        error: "invalid latest draw no"
      });
    }

    const payload = {
      id: Date.now(),
      mode: "ai_train",
      status: "created",
      source_draw_no: String(latestDrawNo),
      target_periods: 2,
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const saveRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions`,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify(payload)
      }
    );

    const saveText = await saveRes.text();

    if (!saveRes.ok) {
      return res.status(500).json({
        ok: false,
        error: "create ai_train prediction failed",
        detail: saveText.slice(0, 500)
      });
    }

    return res.status(200).json({
      ok: true,
      created: true,
      source_draw_no: String(latestDrawNo),
      target_periods: 2,
      groups
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "ai player failed"
    });
  }
}
