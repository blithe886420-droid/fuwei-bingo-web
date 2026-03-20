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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_STATS_TABLE = 'strategy_stats';

const FORMAL_MODE = 'formal';
const FORMAL_TARGET_PERIODS = 4;
const GROUP_COUNT = 4;

function generatePredictionId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function normalizeGroup(group, idx = 0) {
  if (!group || typeof group !== 'object') return null;

  const numsSource = Array.isArray(group.nums)
    ? group.nums
    : Array.isArray(group.numbers)
      ? group.numbers
      : [];

  const nums = uniqueAsc(numsSource).slice(0, 4);
  if (nums.length !== 4) return null;

  const meta = group.meta && typeof group.meta === 'object' ? group.meta : {};

  return {
    key: String(group.key || meta.strategy_key || `group_${idx + 1}`),
    label: String(group.label || meta.strategy_name || `第${idx + 1}組`),
    nums,
    reason: String(group.reason || meta.strategy_name || '正式下注同步 AI 訓練'),
    meta: {
      ...meta,
      strategy_key: String(meta.strategy_key || group.key || `group_${idx + 1}`),
      strategy_name: String(meta.strategy_name || group.label || `第${idx + 1}組`)
    }
  };
}

function normalizeGroups(rawGroups = []) {
  if (!Array.isArray(rawGroups)) return [];

  return rawGroups
    .map((group, idx) => normalizeGroup(group, idx))
    .filter(Boolean)
    .slice(0, GROUP_COUNT);
}

async function getLatestDraw() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.draw_no) throw new Error('latest draw not found');

  return data;
}

async function getLatestTrainingPrediction() {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', 'test')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getTopStrategies(limit = GROUP_COUNT) {
  const { data, error } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .order('roi', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function buildFallbackGroupsFromStats(statsRows = []) {
  const rows = Array.isArray(statsRows) ? statsRows.slice(0, GROUP_COUNT) : [];

  const groups = rows.map((row, idx) => {
    const seed = [...String(row.strategy_key || `fallback_${idx + 1}`)].reduce(
      (sum, ch) => sum + ch.charCodeAt(0),
      0
    );

    const nums = uniqueAsc([
      (seed % 80) + 1,
      ((seed + 11) % 80) + 1,
      ((seed + 23) % 80) + 1,
      ((seed + 37) % 80) + 1
    ]).slice(0, 4);

    while (nums.length < 4) {
      nums.push(((seed + nums.length * 13) % 80) + 1);
    }

    return {
      key: String(row.strategy_key || `fallback_${idx + 1}`),
      label: String(row.strategy_key || `Fallback ${idx + 1}`),
      nums: uniqueAsc(nums).slice(0, 4),
      reason: '正式下注 fallback',
      meta: {
        strategy_key: String(row.strategy_key || `fallback_${idx + 1}`),
        strategy_name: String(row.strategy_key || `Fallback ${idx + 1}`)
      }
    };
  });

  return normalizeGroups(groups);
}

async function buildFormalGroups() {
  const latestTraining = await getLatestTrainingPrediction();
  const trainingGroups = normalizeGroups(latestTraining?.groups_json || []);

  if (trainingGroups.length === GROUP_COUNT) {
    return trainingGroups.map((group) => ({
      ...group,
      reason: '正式下注同步最近一輪 AI 訓練'
    }));
  }

  const topStrategies = await getTopStrategies(GROUP_COUNT);
  const fallbackGroups = buildFallbackGroupsFromStats(topStrategies);

  if (fallbackGroups.length === GROUP_COUNT) {
    return fallbackGroups;
  }

  return [
    {
      key: 'fallback_1',
      label: 'Fallback 1',
      nums: [1, 7, 13, 19],
      reason: '正式下注 fallback',
      meta: { strategy_key: 'fallback_1', strategy_name: 'Fallback 1' }
    },
    {
      key: 'fallback_2',
      label: 'Fallback 2',
      nums: [22, 28, 34, 40],
      reason: '正式下注 fallback',
      meta: { strategy_key: 'fallback_2', strategy_name: 'Fallback 2' }
    },
    {
      key: 'fallback_3',
      label: 'Fallback 3',
      nums: [43, 49, 55, 61],
      reason: '正式下注 fallback',
      meta: { strategy_key: 'fallback_3', strategy_name: 'Fallback 3' }
    },
    {
      key: 'fallback_4',
      label: 'Fallback 4',
      nums: [64, 70, 76, 80],
      reason: '正式下注 fallback',
      meta: { strategy_key: 'fallback_4', strategy_name: 'Fallback 4' }
    }
  ];
}

async function getExistingFormalPrediction(drawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', FORMAL_MODE)
    .eq('source_draw_no', String(drawNo))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function markOlderFormalRowsReplaced(keepId) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id')
    .eq('mode', FORMAL_MODE)
    .neq('id', keepId);

  if (error) throw error;

  const ids = (data || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) return;

  const { error: updateError } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({ status: 'replaced' })
    .in('id', ids);

  if (updateError) throw updateError;
}

async function saveFormalPrediction(drawNo, groups) {
  const nowIso = new Date().toISOString();
  const existing = await getExistingFormalPrediction(drawNo);

  if (existing?.id) {
    const { data, error } = await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        mode: FORMAL_MODE,
        status: 'created',
        source_draw_no: String(drawNo),
        target_periods: FORMAL_TARGET_PERIODS,
        groups_json: groups,
        compare_result: null,
        compare_status: null,
        verdict: null,
        hit_count: null,
        compared_at: null,
        created_at: nowIso
      })
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert({
      id: generatePredictionId(),
      mode: FORMAL_MODE,
      status: 'created',
      source_draw_no: String(drawNo),
      target_periods: FORMAL_TARGET_PERIODS,
      groups_json: groups,
      created_at: nowIso
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const latestDraw = await getLatestDraw();
    const groups = await buildFormalGroups();

    if (groups.length !== GROUP_COUNT) {
      return res.status(500).json({
        ok: false,
        error: 'failed to build formal groups'
      });
    }

    const saved = await saveFormalPrediction(latestDraw.draw_no, groups);
    await markOlderFormalRowsReplaced(saved.id);

    return res.status(200).json({
      ok: true,
      row: saved,
      groups
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'prediction save failed'
    });
  }
}
