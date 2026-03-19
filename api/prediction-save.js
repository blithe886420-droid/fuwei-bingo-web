import { createClient } from '@supabase/supabase-js';

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 4;
const DEFAULT_MODE = 'v4_manual_4group_4period';

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';

function uniqueAsc(arr) {
  return [...new Set(arr)].sort((a, b) => a - b);
}

function randomGroup() {
  const nums = [];
  while (nums.length < 4) {
    const n = Math.floor(Math.random() * 80) + 1;
    if (!nums.includes(n)) nums.push(n);
  }
  return uniqueAsc(nums);
}

function normalizeGroups(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((g, i) => {
      const nums = Array.isArray(g?.nums) ? g.nums : [];
      if (nums.length !== 4) return null;

      return {
        key: g.key || `group_${i + 1}`,
        label: g.label || `第${i + 1}組`,
        nums: uniqueAsc(nums)
      };
    })
    .filter(Boolean);
}

function ensureFourGroups(groups) {
  const result = [...groups];

  while (result.length < BET_GROUP_COUNT) {
    result.push({
      key: `auto_${result.length + 1}`,
      label: `自動補組 ${result.length + 1}`,
      nums: randomGroup()
    });
  }

  return result.slice(0, BET_GROUP_COUNT);
}

async function getLatestDrawNo(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no')
    .order('draw_no', { ascending: false })
    .limit(1)
    .single();

  if (error) throw error;
  return data?.draw_no || 0;
}

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Missing Supabase env'
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'Method not allowed'
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const body = req.body || {};

    const mode =
      body.mode === 'formal_synced_from_server_prediction'
        ? 'formal'
        : body.mode || DEFAULT_MODE;

    const targetPeriods = Number(body.targetPeriods || TARGET_PERIODS);

    // ⭐ 關鍵：處理 groups（就算前端沒給也會生）
    let groups =
      body.groups ||
      body.generatedGroups ||
      body.strategies ||
      [];

    groups = normalizeGroups(groups);
    groups = ensureFourGroups(groups);

    const latestDrawNo = await getLatestDrawNo(supabase);
    if (!latestDrawNo) {
      return res.status(500).json({
        ok: false,
        error: 'latest draw not found'
      });
    }

    const id = Date.now();

    const payload = {
      id,
      mode,
      status: 'created',
      source_draw_no: latestDrawNo,
      target_periods: targetPeriods,
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from(PREDICTIONS_TABLE)
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    return res.status(200).json({
      ok: true,
      id,
      groups
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
