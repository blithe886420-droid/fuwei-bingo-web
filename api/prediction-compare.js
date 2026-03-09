import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const { predictionId } = req.body || {};

    if (!predictionId) {
      return res.status(400).json({
        ok: false,
        error: "predictionId is required"
      });
    }

    // 1. 先抓 prediction
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
    const targetDrawNo = sourceDrawNo + targetPeriods;

    if (!sourceDrawNo || !targetPeriods || !targetDrawNo) {
      return res.status(400).json({
        ok: false,
        error: "prediction source_draw_no / target_periods invalid"
      });
    }

    // 2. 抓目標期數的開獎資料
    const { data: drawRow, error: drawError } = await supabase
      .from("bingo_draws")
      .select("draw_no, draw_time, numbers")
      .eq("draw_no", targetDrawNo)
      .single();

    if (drawError || !drawRow) {
      return res.status(400).json({
        ok: false,
        waiting: true,
        error: `尚未到比對期數，或第 ${targetDrawNo} 期開獎資料尚未入庫`
      });
    }

    const drawNumbers = parseNumbers(drawRow.numbers);

    if (drawNumbers.length !== 20) {
      return res.status(400).json({
        ok: false,
        error: "drawNumbers must be 20 numbers"
      });
    }

    // 3. 解析 groups_json
    const groupsRaw = safeJsonParse(prediction.groups_json, []);
    const groups = Array.isArray(groupsRaw) ? groupsRaw : [];

    if (!groups.length) {
      return res.status(400).json({
        ok: false,
        error: "groups_json is empty"
      });
    }

    // 4. 逐組比對
    const results = groups.map((g, idx) => {
      const nums = parseNumbers(g.nums);
      const hits = nums.filter((n) => drawNumbers.includes(n));

      return {
        index: idx + 1,
        key: g.key || `group_${idx + 1}`,
        label: g.label || `第${idx + 1}組`,
        nums,
        hitCount: hits.length,
        hitNumbers: hits
      };
    });

    const maxHit = results.reduce((m, r) => Math.max(m, r.hitCount), 0);

    let verdict = "未中";
    if (maxHit >= 4) verdict = "中4";
    else if (maxHit === 3) verdict = "中3";
    else if (maxHit === 2) verdict = "中2";
    else if (maxHit === 1) verdict = "中1";

    // 這裡先用保守值，之後要再精算成本/獎金可以再補
    const totalCost = 0;
    const estimatedReturn = 0;
    const profit = estimatedReturn - totalCost;

    const result = {
      sourceDrawNo,
      targetDrawNo,
      compareDrawNo: Number(drawRow.draw_no),
      compareDrawTime: drawRow.draw_time,
      drawNumbers,
      verdict,
      maxHit,
      totalCost,
      estimatedReturn,
      profit,
      results
    };

    // 5. 更新 prediction 狀態
    const updatePayload = {
      status: "compared",
      verdict,
      compare_result: result
    };

    const { error: updateError } = await supabase
      .from("bingo_predictions")
      .update(updatePayload)
      .eq("id", predictionId);

    if (updateError) {
      // 就算 DB 更新失敗，也先把比對結果回給前端
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
