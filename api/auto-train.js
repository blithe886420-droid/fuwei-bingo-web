import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';

const MODE = 'test';
const GROUP_COUNT = 4;
const TARGET_PERIODS = 2;
const COST = 25;

function unique(nums = []) {
  return [...new Set(nums)].slice(0, 4);
}

function randomGroup(seed) {
  const base = (seed * 37) % 80;
  return unique([
    (base % 80) + 1,
    ((base + 11) % 80) + 1,
    ((base + 23) % 80) + 1,
    ((base + 41) % 80) + 1
  ]);
}

function buildGroups() {
  return Array.from({ length: GROUP_COUNT }, (_, i) => ({
    key: `g_${i + 1}`,
    label: `Group ${i + 1}`,
    nums: randomGroup(Date.now() + i),
    meta: {
      strategy_key: `g_${i + 1}`
    }
  }));
}

async function getLatestDraws(limit = 3) {
  const { data } = await supabase
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(limit);

  return data || [];
}

async function insertPrediction(sourceDrawNo, groups) {
  const { data } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert({
      id: Date.now(),
      mode: MODE,
      status: 'created',
      source_draw_no: String(sourceDrawNo),
      target_periods: TARGET_PERIODS,
      groups_json: groups,
      created_at: new Date().toISOString()
    })
    .select('*')
    .single();

  return data;
}

async function updateCompared(id, payload) {
  await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'compared',
      compare_status: 'done',
      hit_count: payload.hitCount,
      compare_result: payload.compareResult,
      verdict: payload.verdict,
      compared_at: new Date().toISOString()
    })
    .eq('id', id);
}

export default async function handler(req, res) {
  try {
    const draws = await getLatestDraws(3);

    if (draws.length < 2) {
      return res.json({ ok: true, message: 'not enough draws' });
    }

    const current = draws[0];
    const next = draws[1]; // ⭐ 關鍵：用下一期

    const groups = buildGroups();

    const prediction = await insertPrediction(current.draw_no, groups);

    const payload = buildComparePayload({
      groups,
      drawRows: [next], // ⭐ 正確 compare
      costPerGroupPerPeriod: COST
    });

    await updateCompared(prediction.id, payload);
    await recordStrategyCompareResult(payload.compareResult);

    return res.json({
      ok: true,
      prediction_id: prediction.id,
      groups
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
