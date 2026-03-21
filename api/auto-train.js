import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

let supabase = null;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE env');
  }

  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });
  }

  return supabase;
}

/* ------------------------ 工具 ------------------------ */

function genNums(seed) {
  const base = (seed * 131) % 80;

  return [
    (base % 80) + 1,
    ((base + 9) % 80) + 1,
    ((base + 21) % 80) + 1,
    ((base + 37) % 80) + 1
  ];
}

function isDuplicateDrawModeError(error) {
  const msg = String(error?.message || '');
  const details = String(error?.details || '');
  const code = String(error?.code || '');

  return (
    code === '23505' ||
    msg.includes('unique_draw_mode') ||
    details.includes('unique_draw_mode') ||
    msg.includes('duplicate key value violates unique constraint')
  );
}

/* ------------------------ 核心流程（改成 function） ------------------------ */

async function runSync(db) {
  // 👉 原本 /api/sync 的邏輯（先簡化為成功佔位）
  return { ok: true };
}

async function runCatchup(db) {
  // 👉 原本 /api/catchup 的邏輯（先簡化為成功佔位）
  return { ok: true };
}

async function runCompare(db) {
  const { data: predictions, error: predError } = await db
    .from('bingo_predictions')
    .select('*')
    .eq('status', 'created')
    .limit(10);

  if (predError) throw predError;

  if (!predictions || predictions.length === 0) {
    return { ok: true, processed: 0 };
  }

  const { data: draws, error: drawError } = await db
    .from('bingo_draws')
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(50);

  if (drawError) throw drawError;

  let processed = 0;

  for (const p of predictions) {
    const payload = buildComparePayload({
      prediction: p,
      draws
    });

    if (!payload) continue;

    const { hitCount, compareResult } = payload;

    await db
      .from('bingo_predictions')
      .update({
        status: 'compared',
        compare_status: 'done',
        hit_count: hitCount,
        compared_at: new Date().toISOString()
      })
      .eq('id', p.id);

    await recordStrategyCompareResult({
      prediction: p,
      result: compareResult
    });

    processed++;
  }

  return {
    ok: true,
    processed
  };
}

/* ------------------------ 主 handler ------------------------ */

export default async function handler(req, res) {
  try {
    const db = getSupabase();

    // 🚀 pipeline（完全不再 fetch）
    const pipeline = {
      catchup: await runCatchup(db),
      sync: await runSync(db),
      compare: await runCompare(db)
    };

    // 取得最新開獎
    const { data: latest, error: latestError } = await db
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(1);

    if (latestError) throw latestError;

    if (!latest || latest.length === 0) {
      return res.status(200).json({
        ok: true,
        pipeline,
        train: {
          ok: true,
          skipped: true,
          reason: 'No bingo_draws'
        }
      });
    }

    const draw = latest[0];
    const sourceDrawNo = String(draw.draw_no);

    // 查重
    const { data: existingPrediction } = await db
      .from('bingo_predictions')
      .select('*')
      .eq('mode', 'test')
      .eq('source_draw_no', sourceDrawNo)
      .limit(1)
      .maybeSingle();

    if (existingPrediction) {
      return res.status(200).json({
        ok: true,
        pipeline,
        train: {
          ok: true,
          skipped: true,
          reason: 'Prediction already exists',
          existing: existingPrediction
        }
      });
    }

    // 建立 prediction
    const now = Date.now();

    const groups = Array.from({ length: 4 }, (_, i) => ({
      key: `g_${i + 1}`,
      nums: genNums(now + i),
      meta: {
        strategy_key: `g_${i + 1}`
      }
    }));

    const payload = {
      id: now,
      mode: 'test',
      status: 'created',
      source_draw_no: sourceDrawNo,
      target_periods: 2,
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const { data: inserted, error: insertError } = await db
      .from('bingo_predictions')
      .insert(payload)
      .select()
      .single();

    if (insertError) {
      if (isDuplicateDrawModeError(insertError)) {
        return res.status(200).json({
          ok: true,
          pipeline,
          train: {
            ok: true,
            skipped: true,
            reason: 'Duplicate prevented'
          }
        });
      }

      throw insertError;
    }

    return res.status(200).json({
      ok: true,
      pipeline,
      train: {
        ok: true,
        inserted
      }
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || 'auto-train failed'
    });
  }
}
