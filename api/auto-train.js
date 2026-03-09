import { createClient } from "@supabase/supabase-js";
import { buildBingoV1Strategies } from "../lib/buildBingoV1Strategies.js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY;

  if (!url) throw new Error("SUPABASE_URL is required");
  if (!key) throw new Error("supabaseKey is required");

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function parseNumbers(input) {
  if (Array.isArray(input)) {
    return input
      .map((x) => String(x).trim())
      .filter(Boolean)
      .map((x) => x.padStart(2, "0"))
      .slice(0, 20);
  }

  return String(input || "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.padStart(2, "0"))
    .slice(0, 20);
}

function safeJsonParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildCompareResult(prediction, drawRows) {
  const sourceDrawNo = Number(prediction.source_draw_no || 0);
  const targetPeriods = Number(prediction.target_periods || 0);
  const targetDrawNo = sourceDrawNo + targetPeriods;

  const groupsRaw = safeJsonParse(prediction.groups_json, []);
  const groups = Array.isArray(groupsRaw) ? groupsRaw : [];

  if (!groups.length) {
    throw new Error("groups_json is empty");
  }

  const compareRounds = drawRows.map((row) => {
    const drawNumbers = parseNumbers(row.numbers);

    if (drawNumbers.length !== 20) {
      throw new Error(`draw_no ${row.draw_no} numbers is not 20`);
    }

    const groupResults = groups.map((g, idx) => {
      const nums = parseNumbers(g.nums);
      const hitNumbers = nums.filter((n) => drawNumbers.includes(n));

      return {
        index: idx + 1,
        key: g.key || `group_${idx + 1}`,
        label: g.label || `第${idx + 1}組`,
        nums,
        hitCount: hitNumbers.length,
        hitNumbers
      };
    });

    return {
      drawNo: Number(row.draw_no),
      drawTime: row.draw_time,
      drawNumbers,
      results: groupResults
    };
  });

  const aggregatedResults = groups.map((g, idx) => {
    const nums = parseNumbers(g.nums);

    let totalHitCount = 0;
    let bestSingleHit = 0;
    const allHitNumbers = new Set();

    const roundHits = compareRounds.map((round) => {
      const hit = round.results[idx];
      totalHitCount += Number(hit.hitCount || 0);
      bestSingleHit = Math.max(bestSingleHit, Number(hit.hitCount || 0));

      (hit.hitNumbers || []).forEach((n) => allHitNumbers.add(n));

      return {
        drawNo: round.drawNo,
        drawTime: round.drawTime,
        hitCount: hit.hitCount,
        hitNumbers: hit.hitNumbers
      };
    });

    return {
      index: idx + 1,
      key: g.key || `group_${idx + 1}`,
      label: g.label || `第${idx + 1}組`,
      nums,
      hitCount: totalHitCount,
      bestSingleHit,
      hitNumbers: Array.from(allHitNumbers),
      roundHits
    };
  });

  const bestSingleOverall = Math.max(
    ...aggregatedResults.map((r) => Number(r.bestSingleHit || 0)),
    0
  );

  const bestTotalOverall = Math.max(
    ...aggregatedResults.map((r) => Number(r.hitCount || 0)),
    0
  );

  const periodsText = `${compareRounds.length}期`;

  let verdict = `${periodsText}累計最佳 ${bestTotalOverall} 碼 / 單期最佳 ${bestSingleOverall} 碼`;

  if (bestSingleOverall >= 4) verdict = `${periodsText}累計最佳 ${bestTotalOverall} 碼 / 單期最佳中4`;
  else if (bestSingleOverall === 3) verdict = `${periodsText}累計最佳 ${bestTotalOverall} 碼 / 單期最佳中3`;
  else if (bestSingleOverall === 2) verdict = `${periodsText}累計最佳 ${bestTotalOverall} 碼 / 單期最佳中2`;
  else if (bestSingleOverall === 1) verdict = `${periodsText}累計最佳 ${bestTotalOverall} 碼 / 單期最佳中1`;

  return {
    sourceDrawNo,
    targetDrawNo,
    compareDrawNo: targetDrawNo,
    compareDrawRange: compareRounds.map((r) => r.drawNo).join(" ~ "),
    compareRounds,
    verdict,
    maxHit: bestSingleOverall,
    totalCost: 0,
    estimatedReturn: 0,
    profit: 0,
    results: aggregatedResults
  };
}

async function compareOnePrediction(supabase, prediction) {
  const sourceDrawNo = Number(prediction.source_draw_no || 0);
  const targetPeriods = Number(prediction.target_periods || 0);

  if (!sourceDrawNo || !targetPeriods) {
    return {
      ok: false,
      predictionId: prediction.id,
      error: "source_draw_no / target_periods invalid"
    };
  }

  const startDrawNo = sourceDrawNo + 1;
  const endDrawNo = sourceDrawNo + targetPeriods;

  const { data: drawRows, error: drawError } = await supabase
    .from("bingo_draws")
    .select("draw_no, draw_time, numbers")
    .gte("draw_no", startDrawNo)
    .lte("draw_no", endDrawNo)
    .order("draw_no", { ascending: true });

  if (drawError) {
    return {
      ok: false,
      predictionId: prediction.id,
      error: drawError.message || "讀取 bingo_draws 失敗"
    };
  }

  if (!Array.isArray(drawRows) || drawRows.length < targetPeriods) {
    return {
      ok: false,
      waiting: true,
      predictionId: prediction.id,
      error: `尚未收齊第 ${startDrawNo} 期到第 ${endDrawNo} 期開獎資料`
    };
  }

  const result = buildCompareResult(prediction, drawRows);

  const { error: updateError } = await supabase
    .from("bingo_predictions")
    .update({
      status: "compared",
      verdict: result.verdict,
      compare_result: result
    })
    .eq("id", prediction.id);

  if (updateError) {
    return {
      ok: false,
      predictionId: prediction.id,
      error: updateError.message || "更新 bingo_predictions 失敗"
    };
  }

  return {
    ok: true,
    predictionId: prediction.id,
    verdict: result.verdict,
    result
  };
}

function buildGroupsFromRecent20(recent20) {
  const rows = recent20.map((r) => ({
    draw_no: r.draw_no,
    draw_time: r.draw_time,
    numbers: r.numbers
  }));

  const built = buildBingoV1Strategies(rows);
  const strategies = Array.isArray(built?.strategies) ? built.strategies : [];

  return strategies.map((s) => ({
    label: `第${s.groupNo}組｜${s.label}`,
    nums: s.nums,
    reason: s.reason,
    key: s.key,
    meta: s.meta || {}
  }));
}

async function createNextTestPrediction(supabase, latestRows) {
  const latestRow = latestRows[0];
  const latestDrawNo = Number(latestRow?.draw_no || 0);

  if (!latestDrawNo) {
    return { created: false, reason: "latestDrawNo invalid" };
  }

  // 避免重複建立同一期的 created prediction
  const { data: existingCreated, error: existingError } = await supabase
    .from("bingo_predictions")
    .select("id, source_draw_no, target_periods, status")
    .eq("status", "created")
    .eq("mode", "test")
    .eq("source_draw_no", latestDrawNo);

  if (existingError) {
    return {
      created: false,
      reason: existingError.message || "查詢既有 created prediction 失敗"
    };
  }

  if (Array.isArray(existingCreated) && existingCreated.length > 0) {
    return {
      created: false,
      reason: `第 ${latestDrawNo} 期的 test prediction 已存在`
    };
  }

  const groups = buildGroupsFromRecent20(latestRows);

  if (!groups.length) {
    return {
      created: false,
      reason: "buildBingoV1Strategies 未產生 groups"
    };
  }

  const payload = {
    id: Date.now(),
    mode: "test",
    status: "created",
    source_draw_no: latestDrawNo,
    target_periods: 2,
    groups_json: groups,
    latest_draw_no: latestDrawNo
  };

  const { data, error } = await supabase
    .from("bingo_predictions")
    .insert(payload)
    .select("id, source_draw_no, target_periods, status")
    .single();

  if (error) {
    return {
      created: false,
      reason: error.message || "建立下一筆 prediction 失敗"
    };
  }

  return {
    created: true,
    prediction: data
  };
}

export default async function handler(req, res) {
  try {
    const supabase = getSupabase();

    const { data: latestRows, error: latestError } = await supabase
      .from("bingo_draws")
      .select("draw_no, draw_time, numbers")
      .order("draw_no", { ascending: false })
      .limit(20);

    if (latestError || !Array.isArray(latestRows) || latestRows.length === 0) {
      return res.status(400).json({
        ok: false,
        error: latestError?.message || "讀取最新 bingo_draws 失敗"
      });
    }

    const latestDrawNo = Number(latestRows[0].draw_no || 0);
    const latestDrawTime = latestRows[0].draw_time || null;

    const { data: pendingPredictions, error: pendingError } = await supabase
      .from("bingo_predictions")
      .select("*")
      .eq("status", "created")
      .order("created_at", { ascending: true });

    if (pendingError) {
      return res.status(400).json({
        ok: false,
        error: pendingError.message || "讀取待比對 prediction 失敗"
      });
    }

    const list = Array.isArray(pendingPredictions) ? pendingPredictions : [];

    const matured = list.filter((p) => {
      const sourceDrawNo = Number(p.source_draw_no || 0);
      const targetPeriods = Number(p.target_periods || 0);
      return sourceDrawNo > 0 && targetPeriods > 0 && sourceDrawNo + targetPeriods <= latestDrawNo;
    });

    const compareResults = [];
    let maturedCompared = 0;

    for (const prediction of matured) {
      const compared = await compareOnePrediction(supabase, prediction);
      if (compared.ok) maturedCompared += 1;
      compareResults.push(compared);
    }

    const nextPrediction = await createNextTestPrediction(supabase, latestRows);

    return res.status(200).json({
      ok: true,
      strategyMode: "v3_auto_loop_test_2period",
      latestDrawNo,
      latestDrawTime,
      catchupInserted: 0,
      created: nextPrediction.created ? 1 : 0,
      maturedCompared,
      compareResults,
      nextPrediction,
      groups: []
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "auto-train failed"
    });
  }
}
