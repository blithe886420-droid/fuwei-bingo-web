import { supabase } from "../lib/supabaseClient";

export default async function handler(req, res) {
  try {

    // 1 取得最新期數
    const { data: latestRow } = await supabase
      .from("bingo_draws")
      .select("draw_no, draw_time")
      .order("draw_no", { ascending: false })
      .limit(1)
      .single();

    const latestDrawNo = latestRow?.draw_no || null;
    const latestDrawTime = latestRow?.draw_time || null;

    // 2 找到已到期但尚未比對的 prediction
    const { data: pending } = await supabase
      .from("bingo_predictions")
      .select("*")
      .eq("status", "created");

    let maturedCompared = 0;
    const compareResults = [];

    for (const p of pending || []) {

      const sourceDrawNo = Number(p.source_draw_no);
      const targetDrawNo = sourceDrawNo + Number(p.target_periods || 4);

      if (!latestDrawNo || latestDrawNo < targetDrawNo) {
        continue;
      }

      try {

        const { data: drawRow } = await supabase
          .from("bingo_draws")
          .select("*")
          .eq("draw_no", targetDrawNo)
          .single();

        if (!drawRow) {
          compareResults.push({
            sourceDrawNo,
            targetDrawNo,
            compareDrawNo: null,
            verdict: "compare_failed",
            error: "draw_not_found"
          });
          continue;
        }

        const drawNumbers = String(drawRow.numbers || "")
          .split(" ")
          .filter(Boolean);

        const groups = p.groups_json || [];

        const results = groups.map(g => {
          const hits = (g.nums || []).filter(n => drawNumbers.includes(n));
          return {
            label: g.label,
            nums: g.nums,
            hitCount: hits.length
          };
        });

        let verdict = "被咬";

        if (results.some(r => r.hitCount >= 2)) verdict = "小贏以上";
        else if (results.some(r => r.hitCount === 1)) verdict = "小贏";

        await supabase
          .from("bingo_predictions")
          .update({
            status: "compared",
            compare_result_json: {
              drawNumbers,
              results,
              verdict
            },
            verdict,
            compared_at: new Date().toISOString()
          })
          .eq("id", p.id);

        maturedCompared++;

        compareResults.push({
          sourceDrawNo,
          targetDrawNo,
          compareDrawNo: targetDrawNo,
          verdict
        });

      } catch (err) {

        compareResults.push({
          sourceDrawNo,
          targetDrawNo,
          compareDrawNo: null,
          verdict: "compare_failed",
          error: err.message
        });

      }

    }

    // 3 新建一筆訓練 prediction
    const { data: newPred } = await supabase
      .from("bingo_predictions")
      .insert({
        mode: "auto_train",
        status: "created",
        source_draw_no: latestDrawNo,
        target_periods: 4,
        groups_json: []
      })
      .select()
      .single();

    res.json({
      ok: true,
      mode: "auto_train_v4_readable_summary",
      latestDrawNo,
      latestDrawTime,
      catchupInserted: 0,
      created: newPred ? 1 : 0,
      maturedCompared,
      createdPrediction: newPred?.id || null,
      compareResults
    });

  } catch (err) {

    res.json({
      ok: false,
      error: err.message
    });

  }
}
