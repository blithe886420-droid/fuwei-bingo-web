import { createClient } from '@supabase/supabase-js';

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

function takeCandidates(sorted, count = 20) {
  return sorted.slice(0, count).map(x => x.num);
}

function fillGroupWithUsage(candidates, usageMap, base = [], need = 4, limitPerNum = 2) {
  const result = [...base];

  for (const num of candidates) {
    if (result.length >= need) break;
    const used = usageMap[num] || 0;
    if (used >= limitPerNum) continue;
    if (result.includes(num)) continue;

    result.push(num);
    usageMap[num] = used + 1;
  }

  return result.slice(0, need);
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

    result = fillGroupWithUsage(candidates, usageMap, [], 4, 2);

    if (result.length < 4) {
      for (const num of candidates) {
        const used = usageMap[num] || 0;
        if (used >= 3) continue;
        if (result.includes(num)) continue;

        result.push(num);
        usageMap[num] = used + 1;
        if (result.length >= 4) break;
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

/* ================= 盤面特徵分析 ================= */

function analyzeBoardFeatures(rows) {
  const recent = rows.slice(0, 10);

  const validRows = recent.filter(r =>
    r.sum_value != null &&
    r.big_count != null &&
    r.odd_count != null
  );

  if (validRows.length === 0) {
    return {
      avgSum: 800,
      avgBig: 10,
      avgOdd: 10,
      bigTrend: "neutral",
      oddTrend: "neutral",
      sumTrend: "neutral",
      marketPhase: "rotation"
    };
  }

  const avgSum = validRows.reduce((a, r) => a + Number(r.sum_value), 0) / validRows.length;
  const avgBig = validRows.reduce((a, r) => a + Number(r.big_count), 0) / validRows.length;
  const avgOdd = validRows.reduce((a, r) => a + Number(r.odd_count), 0) / validRows.length;

  const bigTrend = avgBig > 10.5 ? "big" : avgBig < 9.5 ? "small" : "neutral";
  const oddTrend = avgOdd > 10.5 ? "odd" : avgOdd < 9.5 ? "even" : "neutral";
  const sumTrend = avgSum > 820 ? "high" : avgSum < 760 ? "low" : "neutral";

  // 判斷盤面階段：看最近5期號碼重複率
  // 重複率高 → continuation（延續盤），重複率低 → rotation（輪動盤）
  const recentNums = rows.slice(0, 5).map(r => new Set(parseNumbers(r.numbers)));
  let overlapScore = 0;
  if (recentNums.length >= 2) {
    const latest = recentNums[0];
    for (let i = 1; i < recentNums.length; i++) {
      const prev = recentNums[i];
      let overlap = 0;
      for (const n of latest) {
        if (prev.has(n)) overlap++;
      }
      overlapScore += overlap;
    }
  }
  const marketPhase = overlapScore > 20 ? "continuation" : "rotation";

  return { avgSum, avgBig, avgOdd, bigTrend, oddTrend, sumTrend, marketPhase };
}

/* 根據盤面特徵調整候選號碼的分數 */
function applyBoardBias(scoreMap, features) {
  const biased = { ...scoreMap };

  for (const num of Object.keys(biased)) {
    const n = Number(num);
    const isBig = n >= 41;
    const isOdd = n % 2 === 1;
    const isHigh = n >= 41;

    if (features.bigTrend === "big" && isBig) {
      biased[num] = (biased[num] || 0) * 1.2;
    } else if (features.bigTrend === "small" && !isBig) {
      biased[num] = (biased[num] || 0) * 1.2;
    }

    if (features.oddTrend === "odd" && isOdd) {
      biased[num] = (biased[num] || 0) * 1.15;
    } else if (features.oddTrend === "even" && !isOdd) {
      biased[num] = (biased[num] || 0) * 1.15;
    }

    if (features.sumTrend === "high" && isHigh) {
      biased[num] = (biased[num] || 0) * 1.1;
    } else if (features.sumTrend === "low" && !isHigh) {
      biased[num] = (biased[num] || 0) * 1.1;
    }
  }

  return biased;
}

/* ================= AI：根據當前盤面選強策略 ================= */

function getPhaseHit3Rate(s, marketPhase) {
  // 從 phase_stats_json 取出當前盤面下的 hit3 率
  try {
    const phaseStats = typeof s.phase_stats_json === 'string'
      ? JSON.parse(s.phase_stats_json)
      : s.phase_stats_json;

    if (!phaseStats || typeof phaseStats !== 'object') return null;

    const bucket = phaseStats[marketPhase];
    if (!bucket) return null;

    const rounds = Number(bucket.rounds || bucket.total_rounds || 0);
    const hit3 = Number(bucket.hit3 || bucket.hit3_count || 0);

    if (rounds < 5) return null; // 太少場次不可信
    return hit3 / rounds;
  } catch {
    return null;
  }
}

function selectTopStrategies(statsRows, limit = 20, marketPhase = "rotation") {
  if (!Array.isArray(statsRows)) return [];

  return statsRows
    .map((s) => {
      const rounds = Number(s.total_rounds || 0);
      const profit = Number(s.total_profit || 0);
      const roi = Number(s.roi || 0);
      const hit3Rate = Number(s.hit3_rate || 0);
      const recent50Hit3Rate = Number(s.recent_50_hit3_rate || 0);

      // 取得當前盤面下的歷史 hit3 率
      const phaseHit3Rate = getPhaseHit3Rate(s, marketPhase);

      // 基礎分數
      const baseScore =
        roi * 0.4 +
        profit * 0.2 +
        Math.log1p(rounds) * 8 +
        hit3Rate * 30 +
        recent50Hit3Rate * 20;

      // 盤面加權：在當前盤面下表現好的策略額外加分
      const phaseBonus = phaseHit3Rate !== null ? phaseHit3Rate * 40 : 0;

      const finalScore = baseScore + phaseBonus;

      return {
        ...s,
        score: finalScore,
        phaseHit3Rate,
        phaseBonus
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* ================= 原策略（加入盤面偏向） ================= */

function buildHotChase(todayRows, recent20Rows, recent80Rows, features) {
  const todayScore = countFreq(todayRows, 5);
  const recent20Score = countFreq(recent20Rows, 3);
  const recent80Score = countFreq(recent80Rows, 1);

  const merged = mergeScores(todayScore, recent20Score, recent80Score);
  const biased = applyBoardBias(merged, features);
  const sorted = sortByScore(biased);

  return {
    key: "hot_chase",
    label: "熱門追擊型",
    reason: `今日盤高頻 + 近20期熱號 + 近80期底盤｜盤面偏向：大小${features.bigTrend}/奇偶${features.oddTrend}`,
    candidates: takeCandidates(sorted, 16),
    scorePreview: sorted.slice(0, 8)
  };
}

function buildRebound(todayRows, recent20Rows, recent80Rows, features) {
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

  const rawSorted = sortByScore(reboundMap).filter(x => (recent80Score[x.num] || 0) > 0);
  const rawMap = {};
  for (const x of rawSorted) rawMap[x.num] = x.score;

  const biased = applyBoardBias(rawMap, features);
  const sorted = sortByScore(biased);

  return {
    key: "rebound",
    label: "回補反彈型",
    reason: `近80期常見，今日與近20期相對沉寂｜盤面偏向：大小${features.bigTrend}/奇偶${features.oddTrend}`,
    candidates: takeCandidates(sorted, 20),
    scorePreview: sorted.slice(0, 8)
  };
}

function buildZoneBalanced(todayRows, recent20Rows, recent80Rows, features) {
  const merged = mergeScores(
    countFreq(todayRows, 3),
    countFreq(recent20Rows, 2),
    countFreq(recent80Rows, 1)
  );

  const biased = applyBoardBias(merged, features);
  const sorted = sortByScore(biased);
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
    label: "區段平衡型",
    reason: `四大區段各取一碼｜盤面偏向：大小${features.bigTrend}/奇偶${features.oddTrend}`,
    candidates: allCandidates,
    scorePreview: sorted.slice(0, 8)
  };
}

function buildPatternStructure(todayRows, recent20Rows, recent80Rows, features) {
  const merged = mergeScores(
    countFreq(todayRows, 4),
    countFreq(recent20Rows, 2),
    countFreq(recent80Rows, 1)
  );

  const biased = applyBoardBias(merged, features);
  const sorted = sortByScore(biased).slice(0, 24);
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
    label: "盤型結構型",
    reason: `優先抓同尾結構${bestTail !== undefined ? `（尾數 ${bestTail}）` : ""}｜盤面偏向：大小${features.bigTrend}/奇偶${features.oddTrend}`,
    candidates,
    scorePreview: sorted.slice(0, 8)
  };
}

/* ================= 主流程 ================= */

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

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const nRaw = Number(req.query?.n || 80);
    const n = Number.isInteger(nRaw) ? Math.max(20, Math.min(nRaw, 300)) : 80;

    // 撈資料時加入6個特徵欄位
    const query =
      `${SUPABASE_URL}/rest/v1/bingo_draws` +
      `?select=draw_no,draw_time,numbers,sum_value,span_value,big_count,small_count,odd_count,even_count` +
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
        numbers: r.numbers,
        sum_value: r.sum_value != null ? Number(r.sum_value) : null,
        span_value: r.span_value != null ? Number(r.span_value) : null,
        big_count: r.big_count != null ? Number(r.big_count) : null,
        small_count: r.small_count != null ? Number(r.small_count) : null,
        odd_count: r.odd_count != null ? Number(r.odd_count) : null,
        even_count: r.even_count != null ? Number(r.even_count) : null,
      }));

    const recent20Rows = cleanRows.slice(0, 20);
    const todayRows = cleanRows.slice(0, Math.min(120, cleanRows.length));
    const recent80Rows = cleanRows.slice(0, Math.min(80, cleanRows.length));

    // 分析盤面特徵（含 marketPhase）
    const features = analyzeBoardFeatures(cleanRows);

    const sectionStats = buildSectionStats(recent20Rows);
    const tailStats = buildTailStats(recent20Rows);

    let rawGroups = [
      buildHotChase(todayRows, recent20Rows, recent80Rows, features),
      buildRebound(todayRows, recent20Rows, recent80Rows, features),
      buildZoneBalanced(todayRows, recent20Rows, recent80Rows, features),
      buildPatternStructure(todayRows, recent20Rows, recent80Rows, features)
    ];

    /* 🔥 AI進化：根據當前盤面選最強策略 */
    try {
      const { data: stats } = await supabase
        .from('strategy_stats')
        .select('*');

      // 傳入 marketPhase，讓 AI 優先選在這種盤面下表現好的策略
      const topStrategies = selectTopStrategies(stats, 4, features.marketPhase);

      if (topStrategies.length === 4) {
        rawGroups = rawGroups.map((g, idx) => {
          const s = topStrategies[idx];
          const phaseNote = s.phaseHit3Rate !== null
            ? `｜${features.marketPhase}盤命中率${(s.phaseHit3Rate * 100).toFixed(1)}%`
            : '';
          return {
            ...g,
            key: s.strategy_key || g.key,
            reason: `[AI進化${phaseNote}] ${g.reason}`
          };
        });
      }
    } catch (e) {}

    const diversified = diversifyGroups(rawGroups);

    const groups = diversified.map((g, idx) => ({
      groupNo: idx + 1,
      key: g.key,
      label: `第${idx + 1}組｜${g.label}`,
      nums: uniq(g.nums).slice(0, 4),
      reason: g.reason
    }));

    return res.status(200).json({
      ok: true,
      mode: "bingo_strategy_generate_v4_phase_aware",
      target: {
        stars: 4,
        groups: 4,
        periods: 4
      },
      usedRows: cleanRows.length,
      recentWindow: n,
      latestDrawNo: cleanRows[0]?.draw_no || null,
      latestDrawTime: cleanRows[0]?.draw_time || null,
      boardFeatures: features,
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
