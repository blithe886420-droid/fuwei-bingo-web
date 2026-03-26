import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';

const TEST_MODE = 'test';
const FORMAL_MODE = 'formal';
const COST_PER_GROUP = 25;
const FORMAL_BATCH_LIMIT = 3;
const GROUP_COUNT = 4;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round4(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function parseGroupsJson(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  if (value && typeof value === 'object') {
    return Array.isArray(value) ? value : [];
  }

  return [];
}

function normalizeGroup(group, idx = 0, latestDraw = null) {
  if (!group || typeof group !== 'object') return null;

  const nums = uniqueAsc(
    Array.isArray(group.nums)
      ? group.nums
      : Array.isArray(group.numbers)
        ? group.numbers
        : []
  ).slice(0, 4);

  if (nums.length !== 4) return null;

  const sourceMeta = group.meta && typeof group.meta === 'object' ? group.meta : {};
  const strategyKey = String(
    sourceMeta.strategy_key || group.key || `group_${idx + 1}`
  ).trim();
  const strategyName = String(
    sourceMeta.strategy_name || group.label || group.key || `策略 ${idx + 1}`
  ).trim();

  return {
    key: strategyKey,
    label: strategyName,
    nums,
    reason:
      group.reason ||
      `正式下注採用最新 test 模擬前 ${idx + 1} 名策略（單期 / 每組 ${COST_PER_GROUP} 元）`,
    meta: {
      ...sourceMeta,
      strategy_key: strategyKey,
      strategy_name: strategyName,
      selection_rank: idx + 1,
      source_draw_no: toNum(latestDraw?.draw_no, 0),
      source_draw_time: latestDraw?.draw_time || null,
      bet_amount: COST_PER_GROUP,
      decision: 'from_latest_test_prediction'
    }
  };
}

async function getLatestDraw() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.draw_no) {
    throw new Error('找不到最新期數');
  }

  return data;
}

async function getFormalBatchInfo(sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, created_at, mode, source_draw_no')
    .eq('mode', FORMAL_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  return {
    existingRows: rows,
    existingCount: rows.length,
    nextBatchNo: rows.length + 1
  };
}

async function getLatestTestPredictionBySourceDraw(sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', TEST_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getLatestAnyTestPrediction() {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', TEST_MODE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function buildFormalGroupsFromLatestTest(latestDraw) {
  const sourceDrawNo = toNum(latestDraw?.draw_no, 0);

  let testPrediction = await getLatestTestPredictionBySourceDraw(sourceDrawNo);

  if (!testPrediction) {
    testPrediction = await getLatestAnyTestPrediction();
  }

  if (!testPrediction) {
    throw new Error('找不到可用的 test prediction，請先建立 test prediction');
  }

  const rawGroups = parseGroupsJson(testPrediction.groups_json);

  if (!rawGroups.length) {
    throw new Error('最新 test prediction 沒有可用 groups_json');
  }

  const groups = rawGroups
    .map((group, idx) => normalizeGroup(group, idx, latestDraw))
    .filter(Boolean)
    .slice(0, GROUP_COUNT);

  if (groups.length !== GROUP_COUNT) {
    throw new Error(`最新 test prediction 可用組數不足，目前僅有 ${groups.length} 組`);
  }

  return {
    groups,
    testPrediction
  };
}

async function createFormalPrediction(latestDraw) {
  const sourceDrawNo = toNum(latestDraw?.draw_no, 0);
  if (!sourceDrawNo) {
    throw new Error('無法判斷正式下注來源期數');
  }

  const batchInfo = await getFormalBatchInfo(sourceDrawNo);

  if (batchInfo.existingCount >= FORMAL_BATCH_LIMIT) {
    return {
      ok: true,
      skipped: true,
      reason: `本期正式下注已達上限 ${FORMAL_BATCH_LIMIT} 次`,
      source_draw_no: sourceDrawNo,
      formal_batch_no: batchInfo.existingCount,
      formal_batch_limit: FORMAL_BATCH_LIMIT,
      existing_count: batchInfo.existingCount,
      prediction: null
    };
  }

  const { groups, testPrediction } = await buildFormalGroupsFromLatestTest(latestDraw);

  const formalBatchNo = batchInfo.nextBatchNo;

  const payload = {
    mode: FORMAL_MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: 1,
    groups_json: groups,
    compare_status: 'pending',
    compare_result: null,
    hit_count: 0,
    verdict: null,
    created_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert(payload)
    .select('*')
    .maybeSingle();

  if (error) {
    const msg = String(error.message || '');

    if (
      msg.toLowerCase().includes('duplicate key') ||
      msg.toLowerCase().includes('unique')
    ) {
      throw new Error(
        '資料表目前可能仍有限制同一期 formal 只能建立 1 筆，請先確認 bingo_predictions 的唯一鍵設定'
      );
    }

    throw error;
  }

  return {
    ok: true,
    skipped: false,
    reason: '',
    source_draw_no: sourceDrawNo,
    formal_batch_no: formalBatchNo,
    formal_batch_limit: FORMAL_BATCH_LIMIT,
    existing_count: batchInfo.existingCount,
    source_test_prediction_id: testPrediction?.id || null,
    source_test_draw_no: toNum(testPrediction?.source_draw_no, 0),
    prediction: {
      id: data?.id || null,
      mode: FORMAL_MODE,
      status: data?.status || 'created',
      source_draw_no: sourceDrawNo,
      target_periods: 1,
      group_count: groups.length,
      groups
    }
  };
}

async function createTestPrediction(latestDraw) {
  const sourceDrawNo = toNum(latestDraw?.draw_no, 0);
  if (!sourceDrawNo) {
    throw new Error('無法判斷測試來源期數');
  }

  const { data: existing, error: existingError } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, created_at, groups_json, source_draw_no, target_periods, status')
    .eq('mode', TEST_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;

  if (existing?.id) {
    return {
      ok: true,
      skipped: true,
      reason: '本期 test prediction 已存在',
      source_draw_no: sourceDrawNo,
      prediction: {
        id: existing.id,
        mode: TEST_MODE,
        status: existing.status || 'created',
        source_draw_no: sourceDrawNo,
        target_periods: toNum(existing.target_periods, 1),
        group_count: parseGroupsJson(existing.groups_json).length,
        groups: parseGroupsJson(existing.groups_json)
      }
    };
  }

  throw new Error('目前這一版不負責自動建立 test prediction，請先由 auto-train 或既有流程建立 test prediction');
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const mode =
      String(req.body?.mode || req.query?.mode || FORMAL_MODE).toLowerCase() === TEST_MODE
        ? TEST_MODE
        : FORMAL_MODE;

    const latestDraw = await getLatestDraw();

    const result =
      mode === TEST_MODE
        ? await createTestPrediction(latestDraw)
        : await createFormalPrediction(latestDraw);

    return res.status(200).json({
      ok: true,
      mode,
      latest_draw_no: toNum(latestDraw?.draw_no, 0),
      latest_draw_time: latestDraw?.draw_time || null,
      target_periods: 1,
      bet_type: mode === FORMAL_MODE ? 'single_period_top4_from_latest_test' : 'test_existing_only',
      cost_per_group: COST_PER_GROUP,
      group_count: GROUP_COUNT,
      formal_batch_limit: FORMAL_BATCH_LIMIT,
      ...result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'prediction-save failed'
    });
  }
}
