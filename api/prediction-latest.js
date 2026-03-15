import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

const PREDICTIONS_TABLE = 'bingo_predictions';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueAsc(nums) {
  return [...new Set((Array.isArray(nums) ? nums : []).map((n) => Number(n)).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return [];

  return groups
    .map((g, idx) => {
      if (Array.isArray(g)) {
        const nums = uniqueAsc(g).slice(0, 4);
        if (nums.length !== 4) return null;

        return {
          key: `group_${idx + 1}`,
          label: `第${idx + 1}組`,
          nums,
          reason: '',
          meta: {}
        };
      }

      if (!g || typeof g !== 'object') return null;

      const nums = uniqueAsc(Array.isArray(g.nums) ? g.nums : []).slice(0, 4);
      if (nums.length !== 4) return null;

      return {
        key: g.key || `group_${idx + 1}`,
        label: g.label || `第${idx + 1}組`,
        nums,
        reason: g.reason || '',
        meta: g.meta || {}
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function parseGroupsJson(value) {
  if (Array.isArray(value)) return normalizeGroups(value);

  if (typeof value === 'string') {
    try {
      return normalizeGroups(JSON.parse(value));
    } catch {
      return [];
    }
  }

  if (value && typeof value === 'object') {
    return normalizeGroups(value);
  }

  return [];
}

function normalizePredictionRow(row) {
  if (!row) return null;

  const mode = String(row.mode || '').toLowerCase();
  const sourceDrawNo = toInt(row.source_draw_no, 0);
  const targetPeriods = toInt(
    row.target_periods,
    mode === 'formal' ? 4 : 2
  );

  const groups = parseGroupsJson(row.groups_json);

  return {
    id: row.id,
    mode,
    status: row.status || 'created',
    created_at: row.created_at || null,

    // 前端舊新寫法都兼容
    source_draw_no: sourceDrawNo,
    target_periods: targetPeriods,
    sourceDrawNo,
    targetPeriods,
    targetDrawNo: sourceDrawNo ? sourceDrawNo + targetPeriods : 0,

    groups_json: groups,
    groups,
    prediction_groups: groups,

    compare_result: row.compare_result || null,
    compare_result_json: row.compare_result_json || null,
    compare_status: row.compare_status || null,
    compared_at: row.compared_at || null
  };
}

async function getLatestCreatedByMode(mode) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', mode)
    .eq('status', 'created')
    .order('source_draw_no', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getLatestAnyByMode(mode) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', mode)
    .order('source_draw_no', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getLatestPredictionByMode(mode) {
  const createdRow = await getLatestCreatedByMode(mode);
  if (createdRow) return normalizePredictionRow(createdRow);

  const anyRow = await getLatestAnyByMode(mode);
  return normalizePredictionRow(anyRow);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    // 你的 auto-train.js 寫入的是 test，不是 ai_train
    const [trainingPrediction, formalPrediction] = await Promise.all([
      getLatestPredictionByMode('test'),
      getLatestPredictionByMode('formal')
    ]);

    const rows = [trainingPrediction, formalPrediction].filter(Boolean);

    return res.status(200).json({
      ok: true,

      // 給前端現在的 fallback 使用
      training: trainingPrediction,
      formal: formalPrediction,

      // 保留舊命名，相容其他地方
      ai_train: trainingPrediction,

      // 給 App.jsx 的 rows/filter 流程使用
      rows
    });
  } catch (error) {
    console.error('prediction-latest error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'prediction-latest failed'
    });
  }
}
