import { createClient } from '@supabase/supabase-js';

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 4;

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

function generateGroups() {
  const groups = [];
  for (let i = 0; i < BET_GROUP_COUNT; i++) {
    groups.push({
      key: `auto_${i + 1}`,
      label: `系統產生 ${i + 1}`,
      nums: randomGroup()
    });
  }
  return groups;
}

async function getLatestDrawNo(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no')
    .order('draw_no', { ascending: false })
    .limit(1)
    .single();

  if (error) throw error;
  if (!data) throw new Error('no draw found');

  return Number(data.draw_no);
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
        : body.mode || 'default';

    const targetPeriods = Number(body.targetPeriods || TARGET_PERIODS);

    // ⭐ 完全不信任前端 → 全部自己產生
    const groups = generateGroups();

    const latestDrawNo = await getLatestDrawNo(supabase);

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

    const { error } = await supabase
      .from(PREDICTIONS_TABLE)
      .insert(payload);

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
