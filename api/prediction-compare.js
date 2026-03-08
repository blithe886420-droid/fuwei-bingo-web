function parseNumbers(input) {
  return Array.isArray(input)
    ? input.map(x => String(x).padStart(2, "0")).slice(0, 20)
    : [];
}

function calcHit(groupNums, drawNums) {
  const set = new Set(drawNums);
  return groupNums.filter(n => set.has(n));
}

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

    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

    const body = req.body || {};
    const predictionId = body.predictionId;
    const drawNumbers = parseNumbers(body.drawNumbers);

    if (!predictionId) {
      return res.status(400).json({
        ok: false,
        error: "predictionId is required"
      });
    }

    if (drawNumbers.length !== 20) {
      return res.status(400).json({
        ok: false,
        error: "drawNumbers must be 20 numbers"
      });
    }

    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?id=eq.${predictionId}&select=*`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (!getRes.ok) {
      const detail = await getRes.text();
      return res.status(500).json({
        ok: false,
        error: "Fetch prediction failed",
        detail
      });
    }

    const rows = await getRes.json();
    const prediction = Array.isArray(rows) ? rows[0] : null;

    if (!prediction) {
      return res.status(404).json({
        ok: false,
        error: "Prediction not found"
      });
    }

    const groups = Array.isArray(prediction.groups_json) ? prediction.groups_json : [];
    const targetPeriods = Number(prediction.target_periods || 2);

    const results = groups.map(g => {
      const nums = Array.isArray(g.nums) ? g.nums : [];
      const hits = calcHit(nums, drawNumbers);
      return {
        label: g.label,
        nums,
        hits,
        hitCount: hits.length
      };
    });

    const periodCost = groups.length * 25;
    const totalCost = targetPeriods * periodCost;
    const effectiveGroups = results.filter(r => r.hitCount >= 2).length;
    const estimatedReturn = effectiveGroups * 100;
    const profit = estimatedReturn - totalCost;

    const verdict =
      profit > 0
        ? "小贏以上"
        : profit === 0
        ? "打平"
        : profit >= -50
        ? "接近成本"
        : "被咬";

    const compareResult = {
      drawNumbers,
      results,
      totalCost,
      estimatedReturn,
      profit,
      verdict
    };

    const now = new Date().toISOString();

    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?id=eq.${predictionId}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          status: "compared",
          latest_draw_numbers: drawNumbers.join(" "),
          compare_result_json: compareResult,
          verdict,
          compared_at: now
        })
      }
    );

    if (!updateRes.ok) {
      const detail = await updateRes.text();
      return res.status(500).json({
        ok: false,
        error: "Update compare result failed",
        detail
      });
    }

    const updated = await updateRes.json();

    return res.status(200).json({
      ok: true,
      result: compareResult,
      row: updated
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "prediction compare failed"
    });
  }
}
