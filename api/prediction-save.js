import { createClient } from '@supabase/supabase-js';

const API_VERSION = 'prediction-save-batch-v3-manual-lock';

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

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === '1') return true;
    if (v === '0') return false;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return fallback;
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

function normalizeGroup(group, idx = 0, sourceDraw = null) {
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
      source_draw_no: toNum(sourceDraw?.draw_no, 0),
      source_draw_time: sourceDraw?.draw_time || null,
      bet_amount: COST_PER_GROUP,
      decision: 'from_latest_test_prediction'
    }
  };
}

function getMode(req) {
  return String(req.body?.mode || req.query?.mode || FORMAL_MODE).toLowerCase() === TEST_MODE
    ? TEST_MODE
    : FORMAL_MODE;
}

function isManualFormalRequest(req) {
  const bodyManual = toBool(req.body?.manual, false);
  const queryManual = toBool(req.query?.manual, false);
  const headerManual = toBool(req.headers['x-manual-formal-save'], false);

  return bodyManual || queryManual || headerManual;
}

function getTriggerSource(req) {
  return String(
    req.body?.trigger_source ||
      req.query?.trigger_source ||
      req.headers['x-trigger-source'] ||
      'unknown'
  ).trim();
}

async function getLatestDraw() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.draw_no) throw new Error('找不到最新期數');
  return data;
}

async function getFormalRowsBySourceDrawNo(sourceDrawNo) {
  if (!sourceDrawNo) return [];

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, created_at, source_draw_no, mode, status')
    .eq('mode', FORMAL_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function getLatestFormalRow() {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, created_at, source_draw_no, mode, status')
    .eq('mode', FORMAL_MODE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function resolveFormalSourceDraw(latestDraw) {
  const latestFormal = await getLatestFormalRow();

  if (!latestFormal?.source_draw_no) {
    return {
      sourceDrawNo: toNum(latestDraw?.draw_no, 0),
      batchCount: 0,
      nextBatchNo: 1,
      usingExistingBatch: false
    };
  }

  const existingRows = await getFormalRowsBySourceDrawNo(toNum(latestFormal.source_draw_no, 0));
  const existingCount = existingRows.length;

  if (existingCount > 0 && existingCount < FORMAL_BATCH_LIMIT) {
    return {
      sourceDrawNo: toNum(latestFormal.source_draw_no, 0),
      batchCount: existingCount,
      nextBatchNo: existingCount + 1,
      usingExistingBatch: true
    };
  }

  return {
    sourceDrawNo: toNum(latestDraw?.draw_no, 0),
    batchCount: 0,
    nextBatchNo: 1,
    usingExistingBatch: false
  };
}

async function getLatestTestPredictionUpToSourceDraw(sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', TEST_MODE)
    .lte('source_draw_no', sourceDrawNo)
    .order('source_draw_no', { ascending: false })
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

async function buildFormalGroups(sourceDraw) {
  const sourceDrawNo = toNum(sourceDraw?.draw_no, 0);

  let testPrediction = await getLatestTestPredictionUpToSourceDraw(sourceDrawNo);
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
    .map((group, idx) => normalizeGroup(group, idx, sourceDraw))
    .filter(Boolean)
    .slice(0, GROUP_COUNT);

  if (groups.length !== GROUP_COUNT) {
    throw new Error(`最新 test prediction 可用組數不足，目前僅有 ${groups.length} 組`);
  }

  return {
    groups,
    sourceTestPredictionId: testPrediction.id || null,
    sourceTestDrawNo: toNum(testPrediction.source_draw_no, 0)
  };
}

async function createFormalPrediction() {
  const latestDraw = await getLatestDraw();

  const batchInfo = await resolveFormalSourceDraw(latestDraw);
  const sourceDrawNo = batchInfo.sourceDrawNo;

  if (!sourceDrawNo) {
    throw new Error('無法判斷正式下注來源期數');
  }

  const sourceDraw = {
    draw_no: sourceDrawNo,
    draw_time:
      sourceDrawNo === toNum(latestDraw?.draw_no, 0)
        ? latestDraw?.draw_time || null
        : null
  };

  const existingRows = await getFormalRowsBySourceDrawNo(sourceDrawNo);
  if (existingRows.length >= FORMAL_BATCH_LIMIT) {
    return {
      ok: true,
      skipped: true,
      reason: `本期正式下注已達上限 ${FORMAL_BATCH_LIMIT} 次`,
      source_draw_no: sourceDrawNo,
      formal_batch_no: existingRows.length,
      formal_batch_limit: FORMAL_BATCH_LIMIT,
      existing_count: existingRows.length,
      prediction: null
    };
  }

  const nextBatchNo = existingRows.length + 1;

  const { groups, sourceTestPredictionId, sourceTestDrawNo } = await buildFormalGroups(sourceDraw);

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

  if (error) throw error;

  return {
    ok: true,
    skipped: false,
    reason: '',
    latest_draw_no: toNum(latestDraw?.draw_no, 0),
    latest_draw_time: latestDraw?.draw_time || null,
    source_draw_no: sourceDrawNo,
    formal_batch_no: nextBatchNo,
    formal_batch_limit: FORMAL_BATCH_LIMIT,
    existing_count: existingRows.length,
    source_test_prediction_id: sourceTestPredictionId,
    source_test_draw_no: sourceTestDrawNo,
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

async function getExistingTestResponse(latestDraw) {
  const sourceDrawNo = toNum(latestDraw?.draw_no, 0);

  const { data: existing, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, created_at, groups_json, source_draw_no, target_periods, status')
    .eq('mode', TEST_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

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
      api_version: API_VERSION,
      error: 'Method not allowed'
    });
  }

  try {
    const mode = getMode(req);
    const triggerSource = getTriggerSource(req);

    if (mode === TEST_MODE) {
      const latestDraw = await getLatestDraw();
      const result = await getExistingTestResponse(latestDraw);

      return res.status(200).json({
        ok: true,
        api_version: API_VERSION,
        mode,
        trigger_source: triggerSource,
        latest_draw_no: toNum(latestDraw?.draw_no, 0),
        latest_draw_time: latestDraw?.draw_time || null,
        target_periods: 1,
        bet_type: 'test_existing_only',
        cost_per_group: COST_PER_GROUP,
        group_count: GROUP_COUNT,
        formal_batch_limit: FORMAL_BATCH_LIMIT,
        ...result
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        api_version: API_VERSION,
        mode: FORMAL_MODE,
        trigger_source: triggerSource,
        error: '正式下注只允許 POST'
      });
    }

    if (!isManualFormalRequest(req)) {
      return res.status(403).json({
        ok: false,
        api_version: API_VERSION,
        mode: FORMAL_MODE,
        trigger_source: triggerSource,
        error: '正式下注已鎖定為手動觸發，請由前端按鈕使用 manual=true 呼叫'
      });
    }

    const result = await createFormalPrediction();

    return res.status(200).json({
      ok: true,
      api_version: API_VERSION,
      mode: FORMAL_MODE,
      trigger_source: triggerSource,
      manual_locked: true,
      target_periods: 1,
      bet_type: 'single_period_top4_batch_locked_manual_only',
      cost_per_group: COST_PER_GROUP,
      group_count: GROUP_COUNT,
      formal_batch_limit: FORMAL_BATCH_LIMIT,
      ...result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      api_version: API_VERSION,
      error: error?.message || 'prediction-save failed'
    });
  }
}
