function parseNumbers(input) {
  return String(input || "")
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => String(x).padStart(2, "0"))
    .slice(0, 20);
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

    // 取最近 20 筆開獎快照
    const drawRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_draws?select=id,draw_no,draw_time,numbers,created_at&order=created_at.desc&limit=20`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (!drawRes.ok) {
      const detail = await drawRes.text();
      return res.status(500).json({
        ok: false,
        error: "Fetch draws failed",
        detail
      });
    }

    const draws = await drawRes.json();

    // 找尚未完成的 predictions
    const predRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?select=*&status=in.(created,tracking)&order=created_at.asc`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (!predRes.ok) {
      const detail = await predRes.text();
      return res.status(500).json({
        ok: false,
        error: "Fetch predictions failed",
        detail
      });
    }

    const predictions = await predRes.json();
    let updatedCount = 0;

    for (const prediction of predictions) {
      const groups = Array.isArray(prediction.groups_json) ? prediction.groups_json : [];
      const history = Array.isArray(prediction.compare_history_json)
        ? prediction.compare_history_json
        : [];
      const comparedDrawIds = new Set(history.map(x => x.drawId));
      const targetPeriods = Number(prediction.target_periods || 2);
      const comparedCount = Number(prediction.compared_draw_count || 0);
      const remaining = targetPeriods - comparedCount;

      if (remaining <= 0) {
        continue;
      }

      const createdAt = new Date(prediction.created_at).getTime();

      const eligibleDraws = draws
        .filter(d => {
          const drawCreatedAt = new Date(d.created_at).getTime();
          return drawCreatedAt > createdAt && !comparedDrawIds.has(d.id);
        })
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .slice(0, remaining);

      if (eligibleDraws.length === 0) {
        continue;
      }

      const newHistory = [...history];

      for (const draw of eligibleDraws) {
        const drawNums = parseNumbers(draw.numbers);
        const resultPerGroup = groups.map(g => {
          const nums = Array.isArray(g.nums) ? g.nums : [];
          const hits = calcHit(nums, drawNums);
          return {
            label: g.label,
            nums,
            hits,
            hitCount: hits.length
          };
        });

        newHistory.push({
          drawId: draw.id,
          drawNo: draw.draw_no,
          drawTime: draw.draw_time,
          drawNumbers: drawNums,
          resultPerGroup
        });
      }

      const allGroupResults = newHistory.flatMap(h => h.resultPerGroup);
      const effectiveGroups = allGroupResults.filter(r => r.hitCount >= 2).length;
      const totalCost = targetPeriods * groups.length * 25;
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

      const finalComparedCount = newHistory.length;
      const finalStatus = finalComparedCount >= targetPeriods ? "compared" : "tracking";

      const compareResult = {
        rounds: newHistory,
        totalCost,
        estimatedReturn,
        profit,
        verdict
      };

      const updateRes = await fetch(
        `${SUPABASE_URL}/rest/v1/bingo_predictions?id=eq.${prediction.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            status: finalStatus,
            latest_draw_numbers: newHistory[newHistory.length - 1]?.drawNumbers?.join(" ") || null,
            compare_result_json: compareResult,
            compare_history_json: newHistory,
            compared_draw_count: finalComparedCount,
            verdict,
            compared_at: new Date().toISOString()
          })
        }
      );

      if (updateRes.ok) {
        updatedCount += 1;
      }
    }

    return res.status(200).json({
      ok: true,
      updatedCount
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "auto compare failed"
    });
  }
}
