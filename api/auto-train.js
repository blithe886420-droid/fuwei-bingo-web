import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { buildComparePayload } from '../lib/buildComparePayload.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function pickRandom(strategies, count = 4) {
  const shuffled = [...strategies].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

export default async function handler(req, res) {
  try {
    // ===== 1. 抓策略 =====
    const { data: pool, error: poolError } = await supabase
      .from('strategy_pool')
      .select('*')
      .eq('status', 'active');

    if (poolError) throw poolError;
    if (!pool || pool.length === 0) {
      return res.json({ ok: true, message: 'no strategies' });
    }

    // ===== 2. 隨機選 =====
    const picked = pickRandom(pool, 4);

    const groups = picked.map((s, i) => ({
      key: `group_${i + 1}`,
      label: s.strategy_key,
      nums: Array.isArray(s.numbers) ? s.numbers : [],
      meta: {
        strategy_key: s.strategy_key
      }
    }));

    // ===== 3. 建 prediction =====
    const { data: prediction, error: insertError } = await supabase
      .from('bingo_predictions')
      .insert({
        groups_json: groups,
        created_at: new Date().toISOString(),
        status: 'created'
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // ===== 4. 抓開獎 =====
    const { data: drawRows, error: drawError } = await supabase
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(2);

    if (drawError) throw drawError;

    // ===== 5. 比對 =====
    const payload = buildComparePayload({
      prediction,
      groups,
      drawRows
    });

    // ===== 6. 存結果 =====
    await supabase
      .from('bingo_predictions')
      .update({
        compare_result_json: payload.compareResult,
        status: 'compared',
        compared_at: new Date().toISOString()
      })
      .eq('id', prediction.id);

    // ===== 7. 記錄 stats =====
    await recordStrategyCompareResult(payload.compareResult);

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'auto-train failed'
    });
  }
}
