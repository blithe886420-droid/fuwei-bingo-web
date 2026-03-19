import { createClient } from '@supabase/supabase-js';

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 4;
const COST_PER_GROUP_PER_PERIOD = 25;
const DEFAULT_MODE = 'v4_manual_4group_4period';

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';

function uniqueAsc(nums) {
  return [...new Set(nums)].sort((a, b) => a - b);
}

function randomNums(count = 4) {
  const nums = [];
  while (nums.length < count) {
    const n = Math.floor(Math.random() * 80) + 1;
    if (!nums.includes(n)) nums.push(n);
  }
  return uniqueAsc(nums);
}

function ensure4Groups(groups = []) {
  const result = Array.isArray(groups) ? groups : [];

  while (result.length < BET_GROUP_COUNT) {
    result.push({
      key: `auto_${result.length + 1}`,
      label: `自動補組 ${result.length + 1}`,
      nums: randomNums()
    });
  }

  return result.slice(0, BET_GROUP_COUNT);
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
        error: 'Missing supabase env'
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

    // ⭐ 關鍵：直接容錯 groups
    let groups = body.groups || body.generatedGroups || [];
    groups = ensure4Groups(groups);

    // 取得最新期數
    const { data: latest } = await supabase
      .from(DRAWS_TABLE)
      .select('draw_no')
      .order('draw_no', { ascending: false })
      .limit(1)
      .single();

    if (!latest) {
      return res.status(500).json({
        ok: false,
        error: 'no draw found'
      });
    }

    const source_draw_no = latest.draw_no;

    const id = Date.now();

    const payload = {
      id,
      mode,
      status: 'created',
      source_draw_no,
      target_periods: targetPeriods,
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from(PREDICTIONS_TABLE)
      .insert(payload);

    if (error) {
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    return res.json({
      ok: true,
      groups,
      id
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
