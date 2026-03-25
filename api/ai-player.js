import { createClient } from '@supabase/supabase-js';

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';
const STRATEGY_POOL_TABLE = 'strategy_pool';
const STRATEGY_STATS_TABLE = 'strategy_stats';

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE env');
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(1));
}

function isoHourAgo(hours = 1) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function scoreActiveStrategy(row) {
  const protectedBonus = row?.protected_rank ? 9999 : 0;
  const avgHit = toNum(row?.avg_hit, 0);
  const roi = toNum(row?.roi, 0);
  const recent50Roi = toNum(row?.recent_50_roi, 0);
  const hit2 = toNum(row?.hit2, 0);
  const hit3 = toNum(row?.hit3, 0);
  const hit4 = toNum(row?.hit4, 0);
  const totalRounds = toNum(row?.total_rounds, 0);

  const explosionScore = hit2 * 3 + hit3 * 8 + hit4 * 20;
  const stabilityScore = avgHit * 60 + recent50Roi * 45 + roi * 10;
  const matureBonus = totalRounds >= 30 ? 25 : totalRounds >= 15 ? 10 : 0;

  return protectedBonus + explosionScore + stabilityScore + matureBonus;
}

function decideEvolutionStatus({
  comparedLastHour,
  createdLastHour,
  retiredLastHour,
  activeCount,
  topStrategyAvgHit,
  topStrategyRecent50Roi
}) {
  if (comparedLastHour <= 0 && createdLastHour <= 0 && retiredLastHour <= 0) {
    return {
      statusArrow: '↓',
      statusLabel: '停滯',
      statusText: 'AI最近沒有明顯進步。',
      statusColor: '#ff8d8d'
    };
  }

  if (
    retiredLastHour >= 1 ||
    activeCount <= 45 ||
    topStrategyAvgHit >= 1.9 ||
    topStrategyRecent50Roi >= 0
  ) {
    return {
      statusArrow: '↑',
      statusLabel: '進化中',
      statusText: 'AI正在淘汰弱策略並強化強策略。',
      statusColor: '#7ef0a5'
    };
  }

  return {
    statusArrow: '→',
    statusLabel: '探索中',
    statusText: 'AI正在測試新策略。',
    statusColor: '#79b8ff'
  };
}

function calculateTrainingStrength({
  comparedLastHour,
  createdLastHour,
  retiredLastHour,
  activeCount,
  topStrategyAvgHit,
  topStrategyRoi,
  topStrategyRecent50Roi
}) {
  const compareScore = Math.min(35, comparedLastHour * 2);
  const createScore = Math.min(20, createdLastHour * 2);
  const retireScore = Math.min(15, retiredLastHour * 5);

  let convergeScore = 0;
  if (activeCount <= 36) convergeScore = 15;
  else if (activeCount <= 45) convergeScore = 10;
  else if (activeCount <= 50) convergeScore = 6;
  else convergeScore = 2;

  let qualityScore = 0;

  if (topStrategyAvgHit >= 2.2) qualityScore += 8;
  else if (topStrategyAvgHit >= 1.9) qualityScore += 6;
  else if (topStrategyAvgHit >= 1.6) qualityScore += 4;
  else if (topStrategyAvgHit >= 1.3) qualityScore += 2;

  if (topStrategyRecent50Roi >= 10) qualityScore += 7;
  else if (topStrategyRecent50Roi >= 0) qualityScore += 5;
  else if (topStrategyRecent50Roi >= -20) qualityScore += 3;
  else if (topStrategyRecent50Roi >= -40) qualityScore += 1;

  if (topStrategyRoi >= 0) qualityScore += 8;
  else if (topStrategyRoi >= -20) qualityScore += 5;
  else if (topStrategyRoi >= -40) qualityScore += 3;
  else if (topStrategyRoi >= -60) qualityScore += 1;

  const total =
    compareScore +
    createScore +
    retireScore +
    convergeScore +
    qualityScore;

  return Math.max(0, Math.min(100, Math.round(total)));
}

async function getPoolWithStats(supabase) {
  const { data: poolRows, error: poolError } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*');

  if (poolError) throw poolError;

  const strategyKeys = (poolRows || [])
    .map((row) => row.strategy_key)
    .filter(Boolean);

  const statsMap = new Map();

  if (strategyKeys.length) {
    const { data: statsRows, error: statsError } = await supabase
      .from(STRATEGY_STATS_TABLE)
      .select('*')
      .in('strategy_key', strategyKeys);

    if (statsError) throw statsError;

    for (const row of statsRows || []) {
      statsMap.set(row.strategy_key, row);
    }
  }

  return (poolRows || []).map((row) => ({
    ...row,
    ...(statsMap.get(row.strategy_key) || {})
  }));
}

async function getLatestDrawInfo(supabase) {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select('draw_no, draw_time, numbers')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export default async function handler(req, res) {
  try {
    const supabase = getSupabase();
    const sinceIso = isoHourAgo(1);

    const [
      poolWithStats,
      comparedRes,
      createdRes,
      disabledRes,
      latestDraw
    ] = await Promise.all([
      getPoolWithStats(supabase),

      supabase
        .from(PREDICTIONS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('status', 'compared')
        .gte('compared_at', sinceIso),

      supabase
        .from(PREDICTIONS_TABLE)
        .select('id', { count: 'exact', head: true })
        .gte('created_at', sinceIso),

      supabase
        .from(STRATEGY_POOL_TABLE)
        .select('strategy_key', { count: 'exact', head: true })
        .eq('status', 'disabled')
        .gte('updated_at', sinceIso),

      getLatestDrawInfo(supabase)
    ]);

    if (comparedRes.error) throw comparedRes.error;
    if (createdRes.error) throw createdRes.error;
    if (disabledRes.error) throw disabledRes.error;

    const activeRows = poolWithStats.filter(
      (row) => String(row?.status || '').toLowerCase() === 'active'
    );

    const disabledRows = poolWithStats.filter(
      (row) => String(row?.status || '').toLowerCase() === 'disabled'
    );

    const retiredRows = poolWithStats.filter(
      (row) => String(row?.status || '').toLowerCase() === 'retired'
    );

    const leaderboard = activeRows
      .map((row) => ({
        ...row,
        strategy_score: scoreActiveStrategy(row)
      }))
      .sort((a, b) => {
        if (Boolean(a.protected_rank) !== Boolean(b.protected_rank)) {
          return (
            Number(Boolean(b.protected_rank)) -
            Number(Boolean(a.protected_rank))
          );
        }
        return toNum(b.strategy_score, 0) - toNum(a.strategy_score, 0);
      });

    const top = leaderboard[0] || null;

    const comparedLastHour = Number(comparedRes.count || 0);
    const createdLastHour = Number(createdRes.count || 0);

    // 內部語意修正：這裡實際抓的是 disabled，不是 retired
    const disabledLastHour = Number(disabledRes.count || 0);

    const activeCount = activeRows.length;

    const topStrategyKey = top?.strategy_key || '-';
    const topStrategyScore = round1(top?.strategy_score || 0);
    const topStrategyAvgHit = round1(top?.avg_hit || 0);
    const topStrategyRoi = round1(top?.roi || 0);
    const topStrategyRecent50Roi = round1(top?.recent_50_roi || 0);

    const status = decideEvolutionStatus({
      comparedLastHour,
      createdLastHour,
      retiredLastHour: disabledLastHour,
      activeCount,
      topStrategyAvgHit,
      topStrategyRecent50Roi
    });

    const trainingStrength = calculateTrainingStrength({
      comparedLastHour,
      createdLastHour,
      retiredLastHour: disabledLastHour,
      activeCount,
      topStrategyAvgHit,
      topStrategyRoi,
      topStrategyRecent50Roi
    });

    return res.status(200).json({
      ok: true,
      sinceText: '最近 1 小時',
      comparedLastHour,
      createdLastHour,

      // 保留舊欄位名稱，避免前端或其他地方還在吃 retiredLastHour 時直接壞掉
      retiredLastHour: disabledLastHour,

      // 新增正確語意欄位，讓後續前端可以逐步改成 disabledLastHour
      disabledLastHour,

      activeCount,
      disabledCount: disabledRows.length,
      retiredCount: retiredRows.length,
      totalPoolCount: poolWithStats.length,
      topStrategyKey,
      topStrategyScore,
      topStrategyAvgHit,
      topStrategyRoi,
      topStrategyRecent50Roi,
      trainingStrength,
      latestDrawNo: latestDraw?.draw_no || null,
      latestDrawTime: latestDraw?.draw_time || null,
      ...status
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'ai-player failed'
    });
  }
}
