import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { buildComparePayload } from '../lib/buildComparePayload.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

const CURRENT_MODE = 'test';
const PICK_COUNT = 4;
const DRAW_COMPARE_LIMIT = 2;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE service role key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

function pickRandom(strategies, count = 4) {
  const shuffled = [...strategies].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function normalizeNumbers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    // ===== 1. 抓策略池 =====
    const { data: pool, error: poolError } = await supabase
      .from('strategy_pool')
      .select('*')
      .eq('status', 'active');

    if (poolError) throw poolError;

    if (!Array.isArray(pool) || pool.length === 0) {
      return res.json({
        ok: true,
        message: 'no active strategies',
        mode: CURRENT_MODE
      });
    }

    // ===== 2. 隨機挑 4 個策略 =====
    const picked = pickRandom(pool, Math.min(PICK_COUNT, pool.length));

    const groups = picked.map((s, i) => ({
      key: `group_${i + 1}`,
      label: s.strategy_key || `strategy_${i + 1}`,
      nums: normalizeNumbers(s.numbers),
      meta: {
        strategy_key: s.strategy_key || null,
        strategy_id: s.id || null
      }
    }));

    // ===== 3. 建立 prediction =====
    const insertPayload = {
      mode: CURRENT_MODE,
      status: 'created',
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const { data: prediction, error: insertError } = await supabase
      .from('bingo_predictions')
      .insert(insertPayload)
      .select()
      .single();

    if (insertError) throw insertError;
    if (!prediction?.id) {
      throw new Error('Prediction created but no id returned');
    }

    // ===== 4. 抓最新開獎 =====
    const { data: drawRows, error: drawError } = await supabase
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(DRAW_COMPARE_LIMIT);

    if (drawError) throw drawError;

    // ===== 5. 建 compare payload =====
    const payload = buildComparePayload({
      prediction,
      groups,
      drawRows: Array.isArray(drawRows) ? drawRows : []
    });

    // ===== 6. 回寫 compare 結果 =====
    const updatePayload = {
      compare_result_json: payload?.compareResult ?? null,
      status: 'compared',
      compared_at: new Date().toISOString()
    };

    const { error: updateError } = await supabase
      .from('bingo_predictions')
      .update(updatePayload)
      .eq('id', prediction.id);

    if (updateError) throw updateError;

    // ===== 7. 記錄策略統計 =====
    if (payload?.compareResult) {
      await recordStrategyCompareResult(payload.compareResult);
    }

    return res.json({
      ok: true,
      prediction_id: prediction.id,
      mode: CURRENT_MODE,
      picked_count: groups.length
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'auto-train failed'
    });
  }
}
