import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY;

  if (!url) {
    throw new Error("SUPABASE_URL is required");
  }

  if (!key) {
    throw new Error("supabaseKey is required");
  }

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

  if (bestSingleOverall >= 4) {
    verdict = `${periodsText}累計最佳 ${bestTotalOverall} 碼 / 單期最佳中4`;
  } else if (bestSingleOverall === 3) {
    verdict = `${periodsText}累計最佳 ${bestTotalOverall} 碼 / 單期最佳中3`;
  } else if (bestSingleOverall === 2) {
    verdict = `${periodsText}累計最佳 ${bestTotalOverall} 碼 / 單期最佳中2`;
  } else if (bestSingleOverall === 1) {
    verdict = `${periodsText}累計最佳 ${bestTotalOverall} 碼 / 單期最佳中1`;
  }

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const supabase = getSupabase();
    const { predictionId } = req.body || {};

    if (!predictionId) {
      return res.status(400).json({
        ok: false,
        error: "predictionId is required"
      });
    }

    const { data: prediction, error: predictionError } = await supabase
      .from("bingo_predictions")
      .select("*")
      .eq("id", predictionId)
      .single();

    if (predictionError || !prediction) {
      return res.status(404).json({
        ok: false,
        error: "prediction not found"
      });
    }

    const sourceDrawNo = Number(prediction.source_draw_no || 0);
    const targetPeriods = Number(prediction.target_periods || 0);

    if (!sourceDrawNo || !targetPeriods) {
      return res.status(400).json({
        ok: false,
        error: "prediction source_draw_no / target_periods invalid"
      });
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
      return res.status(400).json({
        ok: false,
        error: drawError.message || "讀取 bingo_draws 失敗"
      });
    }

    if (!Array.isArray(drawRows) || drawRows.length < targetPeriods) {
      return res.status(400).json({
        ok: false,
        waiting: true,
        error: `尚未到完整比對期數，需收齊第 ${startDrawNo} 期到第 ${endDrawNo} 期開獎資料`
      });
    }

    const result = buildCompareResult(prediction, drawRows);

    const updatePayload = {
      status: "compared",
      verdict: result.verdict,
      compare_result: result
    };

    const { error: updateError } = await supabase
      .from("bingo_predictions")
      .update(updatePayload)
      .eq("id", predictionId);

    if (updateError) {
      return res.status(200).json({
        ok: true,
        result,
        warning: `compare 成功，但 DB 更新失敗：${updateError.message}`
      });
    }

    return res.status(200).json({
      ok: true,
      result
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "prediction-compare failed"
    });
  }
}
