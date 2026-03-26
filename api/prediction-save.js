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
const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';

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

function parseNums(value) {
  if (Array.isArray(value)) return uniqueAsc(value);

  if (typeof value === 'string') {
    return uniqueAsc(
      value
        .split(',')
        .map((v) => Number(String(v).trim()))
        .filter(Number.isFinite)
    );
  }

  return [];
}

function scoreStrategy(row) {
  const protectedBonus = row?.protected_rank ? 9999 : 0;
  const avgHit = toNum(row?.avg_hit, 0);
  const roi = toNum(row?.roi, 0);
  const recent50Roi = toNum(row?.recent_50_roi, 0);
  const hitRate = toNum(row?.hit_rate, 0);
  const recent50HitRate = toNum(row?.recent_50_hit_rate, 0);
  const hit2 = toNum(row?.hit2, 0);
  const hit3 = toNum(row?.hit3, 0);
  const hit4 = toNum(row?.hit4, 0);
  const totalRounds = toNum(row?.total_rounds, 0);
  const matureBonus = totalRounds >= 30 ? 25 : totalRounds >= 15 ? 10 : 0;

  return (
    protectedBonus +
    avgHit * 55 +
    recent50Roi * 45 +
    roi * 10 +
    hitRate * 18 +
    recent50HitRate * 12 +
    hit2 * 2 +
    hit3 * 8 +
    hit4 * 20 +
    matureBonus
  );
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

async function getMergedStrategyRows() {
  const [{ data: statsRows, error: statsError }, { data: poolRows, error: poolError }] =
    await Promise.all([
      supabase.from(STRATEGY_STATS_TABLE).select('*'),
      supabase.from(STRATEGY_POOL_TABLE).select('*')
    ]);

  if (statsError) throw statsError;
  if (poolError) throw poolError;

  const poolMap = new Map();
  for (const row of Array.isArray(poolRows) ? poolRows : []) {
    const key = String(row?.strategy_key || '').trim().toLowerCase();
    if (key) {
      poolMap.set(key, row);
    }
  }

  return (Array.isArray(statsRows) ? statsRows : [])
    .map((stat) => {
      const key = String(stat?.strategy_key || '').trim().toLowerCase();
      const pool = poolMap.get(key) || null;

      return {
        ...(pool || {}),
        ...(stat || {}),
        strategy_key: stat?.strategy_key || pool?.strategy_key || '',
        strategy_name:
          stat?.strategy_name ||
          stat?.strategy_label ||
          pool?.strategy_name ||
          pool?.strategy_label ||
          stat?.strategy_key ||
          pool?.strategy_key ||
          '',
        pool_status: String(pool?.status || 'active').toLowerCase(),
        strategy_score: scoreStrategy({
          ...(pool || {}),
          ...(stat || {})
        })
      };
    })
    .filter((row) => String(row?.strategy_key || '').trim())
    .filter((row) => row.pool_status !== 'disabled' && row.pool_status !== 'retired')
    .sort((a, b) => {
      const pa = Boolean(a.protected_rank);
      const pb = Boolean(b.protected_rank);
      if (pa !== pb) return Number(pb) - Number(pa);
      return toNum(b.strategy_score, 0) - toNum(a.strategy_score, 0);
    });
}

function buildGroupFromStrategy(row, rank, latestDraw) {
  const rawNums =
    row?.candidate_nums ||
    row?.recommended_nums ||
    row?.nums ||
    row?.numbers ||
    row?.pick_nums ||
    row?.pick_numbers ||
    [];

  const nums = parseNums(rawNums).slice(0, 4);

  if (nums.length !== 4) {
    return null;
  }

  return {
    key: String(row.strategy_key || `strategy_${rank}`),
    label: String(row.strategy_name || row.strategy_key || `策略 ${rank}`),
    nums,
    reason: `正式下注採用當前排行第 ${rank} 名策略（單期 / 每組 ${COST_PER_GROUP} 元）`,
    meta: {
      strategy_key: String(row.strategy_key || ''),
      strategy_name: String(row.strategy_name || row.strategy_key || ''),
      selection_rank: rank,
      source_draw_no: toNum(latestDraw?.draw_no, 0),
      source_draw_time: latestDraw?.draw_time || null,
      avg_hit: round4(row.avg_hit),
      roi: round4(row.roi),
      recent_50_roi: round4(row.recent_50_roi),
      hit_rate: round4(row.hit_rate),
      recent_50_hit_rate: round4(row.recent_50_hit_rate),
      total_rounds: toNum(row.total_rounds, 0),
      score: round4(row.strategy_score),
      bet_amount: COST_PER_GROUP,
      decision: 'top_ranked'
    }
  };
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

  const strategies = await getMergedStrategyRows();
  const topRows = strategies.slice(0, GROUP_COUNT);

  if (topRows.length < GROUP_COUNT) {
    throw new Error(`可用策略不足，目前僅有 ${topRows.length} 組，無法建立正式下注`);
  }

  const groups = topRows
    .map((row, idx) => buildGroupFromStrategy(row, idx + 1, latestDraw))
    .filter(Boolean);

  if (groups.length !== GROUP_COUNT) {
    throw new Error('前四名策略中，至少有一組缺少可用號碼（需為 4 碼）');
  }

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
    .select('id, created_at')
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
        status: 'created',
        source_draw_no: sourceDrawNo,
        target_periods: 1
      }
    };
  }

  const strategies = await getMergedStrategyRows();
  const topRows = strategies.slice(0, GROUP_COUNT);

  if (topRows.length < GROUP_COUNT) {
    throw new Error(`可用策略不足，目前僅有 ${topRows.length} 組，無法建立 test prediction`);
  }

  const groups = topRows
    .map((row, idx) => buildGroupFromStrategy(row, idx + 1, latestDraw))
    .filter(Boolean);

  if (groups.length !== GROUP_COUNT) {
    throw new Error('前四名策略中，至少有一組缺少可用號碼（需為 4 碼）');
  }

  const payload = {
    mode: TEST_MODE,
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
      return {
        ok: true,
        skipped: true,
        reason: '本期 test prediction 已存在（唯一鍵擋下重複建立）',
        source_draw_no: sourceDrawNo,
        prediction: null
      };
    }

    throw error;
  }

  return {
    ok: true,
    skipped: false,
    reason: '',
    source_draw_no: sourceDrawNo,
    prediction: {
      id: data?.id || null,
      mode: TEST_MODE,
      status: data?.status || 'created',
      source_draw_no: sourceDrawNo,
      target_periods: 1,
      group_count: groups.length,
      groups
    }
  };
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
      bet_type: mode === FORMAL_MODE ? 'single_period_top4' : 'test_top4',
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
