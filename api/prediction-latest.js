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

function normalizePredictionRow(row) {
  if (!row) return null;

  const mode = String(row.mode || '').toLowerCase();
  const sourceDrawNo = toInt(row.source_draw_no, 0);
  const targetPeriods = toInt(row.target_periods, mode === 'test' ? 2 : 4);

  let groups = [];
  if (Array.isArray(row.groups_json)) {
    groups = normalizeGroups(row.groups_json);
  } else if (typeof row.groups_json === 'string') {
    try {
      groups = normalizeGroups(JSON.parse(row.groups_json));
    } catch {
      groups = [];
    }
  }

  return {
    id: row.id,
    mode,
    status: row.status || 'created',
    created_at: row.created_at || null,
    sourceDrawNo,
    targetPeriods,
    targetDrawNo: sourceDrawNo ? sourceDrawNo + targetPeriods : 0,
    groups,
    compare_result: row.compare_result || null,
    compare_result_json: row.compare_result_json || null,
    compare_status: row.compare_status || null,
    compared_at: row.compared_at || null
  };
}

async function getLatestPredictionByMode(mode) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', mode)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return normalizePredictionRow(data);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const [testPrediction, formalPrediction] = await Promise.all([
      getLatestPredictionByMode('test'),
      getLatestPredictionByMode('formal')
    ]);

    return res.status(200).json({
      ok: true,
      test: testPrediction,
      formal: formalPrediction
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'prediction-latest failed'
    });
  }
}
