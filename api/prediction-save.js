import { createClient } from '@supabase/supabase-js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 4;
const COST_PER_GROUP_PER_PERIOD = 25;
const DEFAULT_MODE = 'v4_manual_4group_4period';

const DRAWS_TABLE = 'bingo_draws';
const STRATEGY_POOL_TABLE = 'strategy_pool';
const STRATEGY_STATS_TABLE = 'strategy_stats';
const PREDICTIONS_TABLE = 'bingo_predictions';
const PREDICTION_STRATEGY_MAP_TABLE = 'prediction_strategy_map';

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueAsc(nums) {
  return [...new Set(nums.map((n) => Number(n)).filter(Number.isFinite))].sort((a, b) => a - b);
}

function uniqueKeepOrder(nums) {
  const seen = new Set();
  const result = [];

  for (const n of nums.map((x) => Number(x)).filter(Number.isFinite)) {
    if (seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }

  return result;
}

function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function stableHash(text = '') {
  let h = 0;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function rotateList(source, offset = 0) {
  if (!Array.isArray(source) || source.length === 0) return [];
  const len = source.length;
  const safeOffset = ((offset % len) + len) % len;
  return [...source.slice(safeOffset), ...source.slice(0, safeOffset)];
}

function normalizeIncomingGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return [];

  return rawGroups
    .map((group, idx) => {
      if (Array.isArray(group)) {
        const nums = uniqueAsc(group).slice(0, 4);
        if (nums.length !== 4) return null;

        return {
          key: `group_${idx + 1}`,
          label: `第${idx + 1}組`,
          nums,
          reason: '前端傳入',
          meta: { source: 'frontend_array' }
        };
      }

      if (!group || typeof group !== 'object') return null;

      const nums = uniqueAsc(group.nums || []).slice(0, 4);
      if (nums.length !== 4) return null;

      return {
        key: group.key || `group_${idx + 1}`,
        label: group.label || `第${idx + 1}組`,
        nums,
        reason: '前端傳入',
        meta: group.meta || {}
      };
    })
    .filter(Boolean)
    .slice(0, BET_GROUP_COUNT);
}

async function getRecent20(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, numbers')
    .order('draw_no', { ascending: false })
    .limit(20);

  if (error) throw error;
  return data || [];
}

async function getLatestDrawNo(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? Number(data.draw_no) : 0;
}

async function archivePreviousFormalPredictions(supabase, mode) {
  if (!String(mode).includes('formal')) {
    return;
  }

  const { data } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id')
    .like('mode', '%formal%')
    .eq('status', 'created');

  if (!data?.length) return;

  const ids = data.map((r) => r.id);

  await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'replaced',
      compare_status: 'replaced'
    })
    .in('id', ids);
}

/**
 * 🔥 核心修正：解決 unique_draw 衝突
 */
async function resolveUniqueDrawConflict(supabase, sourceDrawNo) {
  const { data } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, status')
    .eq('source_draw_no', sourceDrawNo)
    .limit(1);

  if (!data?.length) return;

  const row = data[0];

  // 🔥 如果存在，就把舊的改掉（讓新的可以插入）
  await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      source_draw_no: `${sourceDrawNo}_old_${Date.now()}`
    })
    .eq('id', row.id);
}

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Missing SUPABASE env'
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'Method not allowed'
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
    const body = req.body || {};

    const mode = String(body.mode || DEFAULT_MODE);
    const targetPeriods = Number(body.targetPeriods || TARGET_PERIODS);

    let groups = normalizeIncomingGroups(body.groups || []);

    if (groups.length < BET_GROUP_COUNT) {
      return res.status(400).json({
        ok: false,
        error: 'groups 不足'
      });
    }

    const latestDrawNo = await getLatestDrawNo(supabase);

    const sourceDrawNo = String(body.sourceDrawNo || latestDrawNo);

    /**
     * 🔥 這行就是救命關鍵（避免 duplicate key）
     */
    await resolveUniqueDrawConflict(supabase, sourceDrawNo);

    await archivePreviousFormalPredictions(supabase, mode);

    const id = Date.now();

    const payload = {
      id,
      mode,
      status: 'created',
      source_draw_no: sourceDrawNo,
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
        error: 'Prediction save failed',
        detail: error.message
      });
    }

    return res.status(200).json({
      ok: true,
      id,
      row: data,
      groups
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || 'prediction save failed'
    });
  }
}
