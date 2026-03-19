import { createClient } from '@supabase/supabase-js';

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 4;

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueAsc(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function normalizeMode(rawMode = '') {
  const mode = String(rawMode || '').trim();

  if (mode === 'formal_synced_from_server_prediction') return 'formal';
  if (mode) return mode;
  return 'formal';
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

  return {
    key: String(group.key || `group_${idx + 1}`),
    label: String(group.label || group.name || `第${idx + 1}組`),
    nums,
    reason: String(group.reason || ''),
    meta: group.meta && typeof group.meta === 'object' ? group.meta : {}
  };
}

function normalizeGroups(rawGroups = []) {
  if (!Array.isArray(rawGroups)) return [];

  return rawGroups
    .map((group, idx) => normalizeGroup(group, idx))
    .filter(Boolean)
    .slice(0, BET_GROUP_COUNT);
}

async function getLatestDraw(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .single();

  if (error) throw error;
  if (!data) throw new Error('latest draw not found');

  return data;
}

async function getLatestTestPrediction(supabase) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, mode, status, source_draw_no, target_periods, groups_json, created_at')
    .eq('mode', 'test')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getExistingPredictionBySourceDrawNo(supabase, sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('source_draw_no', String(sourceDrawNo))
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function markOlderFormalRowsReplaced(supabase, keepId) {
  const { data: rows, error: readError } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id')
    .eq('mode', 'formal')
    .neq('id', keepId);

  if (readError) throw readError;

  const ids = (rows || []).map((row) => row.id).filter(Boolean);
  if (!ids.length) return;

  const { error: updateError } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'replaced'
    })
    .in('id', ids);

  if (updateError) throw updateError;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'Method not allowed'
      });
    }

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
      return res.status(500).json({
        ok: false,
        error: 'Missing SUPABASE env'
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });

    const body = req.body || {};
    const mode = normalizeMode(body.mode);
    const targetPeriods = toInt(body.targetPeriods, TARGET_PERIODS);

    const latestDraw = await getLatestDraw(supabase);
    const latestDrawNo = String(latestDraw.draw_no || '');

    if (!latestDrawNo) {
      return res.status(500).json({
        ok: false,
        error: 'latest draw not found'
      });
    }

    let groups = [];

    const incomingGroups = normalizeGroups(body.groups || body.generatedGroups || body.predictionGroups || []);
    if (incomingGroups.length === BET_GROUP_COUNT) {
      groups = incomingGroups;
    } else {
      const latestTestPrediction = await getLatestTestPrediction(supabase);
      const syncedGroups = normalizeGroups(latestTestPrediction?.groups_json || []);

      if (syncedGroups.length !== BET_GROUP_COUNT) {
        return res.status(400).json({
          ok: false,
          error: 'groups 不足'
        });
      }

      groups = syncedGroups;
    }

    const nowIso = new Date().toISOString();

    const payload = {
      mode,
      status: 'created',
      source_draw_no: latestDrawNo,
      target_periods: targetPeriods,
      groups_json: groups,
      created_at: nowIso
    };

    const existing = await getExistingPredictionBySourceDrawNo(supabase, latestDrawNo);

    let savedRow = null;

    if (existing) {
      const { data, error } = await supabase
        .from(PREDICTIONS_TABLE)
        .update({
          mode,
          status: 'created',
          target_periods: targetPeriods,
          groups_json: groups,
          created_at: nowIso
        })
        .eq('id', existing.id)
        .select('*')
        .single();

      if (error) {
        return res.status(500).json({
          ok: false,
          error: error.message
        });
      }

      savedRow = data;
    } else {
      const insertPayload = {
        id: Date.now(),
        ...payload
      };

      const { data, error } = await supabase
        .from(PREDICTIONS_TABLE)
        .insert(insertPayload)
        .select('*')
        .single();

      if (error) {
        return res.status(500).json({
          ok: false,
          error: error.message
        });
      }

      savedRow = data;
    }

    if (mode === 'formal' && savedRow?.id) {
      await markOlderFormalRowsReplaced(supabase, savedRow.id);
    }

    return res.status(200).json({
      ok: true,
      id: savedRow.id,
      row: savedRow,
      source_draw_no: savedRow.source_draw_no,
      target_periods: savedRow.target_periods,
      groups: savedRow.groups_json
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'prediction save failed'
    });
  }
}
