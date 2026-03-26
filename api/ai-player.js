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

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function isoHourAgo(hours = 1) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function scoreActiveStrategy(row) {
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

  const explosionScore = hit2 * 2 + hit3 * 8 + hit4 * 20;
  const qualityScore =
    avgHit * 55 +
    recent50Roi * 45 +
    roi * 10 +
    hitRate * 18 +
    recent50HitRate * 12;
  const matureBonus = totalRounds >= 30 ? 25 : totalRounds >= 15 ? 10 : 0;

  return protectedBonus + explosionScore + qualityScore + matureBonus;
}

function detectDecisionPhase({
  comparedLastHour,
  createdLastHour,
  activeCount,
  topStrategyAvgHit,
  topStrategyRoi,
  topStrategyRecent50Roi
}) {
  const hasRecentWork = comparedLastHour > 0 || createdLastHour > 0;
  const strongShortTerm =
    topStrategyAvgHit >= 1.8 && topStrategyRecent50Roi >= 0;
  const usableShortTerm =
    topStrategyAvgHit >= 1.5 && topStrategyRecent50Roi >= -0.2;
  const poorShortTerm =
    topStrategyAvgHit < 1.2 || topStrategyRecent50Roi < -0.5 || topStrategyRoi < -0.7;

  if (activeCount <= 0) {
    return {
      phase: 'no_data',
      statusArrow: '↓',
      statusLabel: '資料不足',
      statusText: '目前沒有可用的策略資料，先不要進場。',
      statusColor: '#ff8d8d',
      adviceLevel: 'stop',
      readyForFormal: false
    };
  }

  if (!hasRecentWork) {
    return {
      phase: 'waiting_update',
      statusArrow: '→',
      statusLabel: '待更新',
      statusText: '系統目前沒有新的模擬或比對紀錄，先同步資料再判斷。',
      statusColor: '#ffd36c',
      adviceLevel: 'wait',
      readyForFormal: false
    };
  }

  if (strongShortTerm && activeCount >= 8) {
    return {
      phase: 'ready_small_bet',
      statusArrow: '↑',
      statusLabel: '可小試',
      statusText: '目前前段策略表現偏穩，可做小額、單期觀察。',
      statusColor: '#7ef0a5',
      adviceLevel: 'go_small',
      readyForFormal: true
    };
  }

  if (usableShortTerm && activeCount >= 5) {
    return {
      phase: 'watch_only',
      statusArrow: '→',
      statusLabel: '可觀察',
      statusText: '目前有可參考策略，但仍建議先看排行與近期表現。',
      statusColor: '#79b8ff',
      adviceLevel: 'watch',
      readyForFormal: false
    };
  }

  if (poorShortTerm) {
    return {
      phase: 'avoid_entry',
      statusArrow: '↓',
      statusLabel: '暫不建議',
      statusText: '目前前段策略表現偏弱，不建議急著正式下注。',
      statusColor: '#ff8d8d',
      adviceLevel: 'avoid',
      readyForFormal: false
    };
  }

  return {
    phase: 'neutral',
    statusArrow: '→',
    statusLabel: '觀察中',
    statusText: '目前資料可參考，但尚未達到較佳進場條件。',
    statusColor: '#79b8ff',
    adviceLevel: 'watch',
    readyForFormal: false
  };
}

function calculateDecisionStrength({
  comparedLastHour,
  createdLastHour,
  activeCount,
  topStrategyAvgHit,
  topStrategyRoi,
  topStrategyRecent50Roi
}) {
  const compareScore = Math.min(25, comparedLastHour * 2);
  const createScore = Math.min(10, createdLastHour * 2);

  let activeScore = 0;
  if (activeCount >= 20) activeScore = 15;
  else if (activeCount >= 10) activeScore = 12;
  else if (activeCount >= 5) activeScore = 8;
  else if (activeCount >= 1) activeScore = 4;

  let avgHitScore = 0;
  if (topStrategyAvgHit >= 2.2) avgHitScore = 25;
  else if (topStrategyAvgHit >= 1.8) avgHitScore = 20;
  else if (topStrategyAvgHit >= 1.5) avgHitScore = 14;
  else if (topStrategyAvgHit >= 1.2) avgHitScore = 8;
  else avgHitScore = 2;

  let recentRoiScore = 0;
  if (topStrategyRecent50Roi >= 0.2) recentRoiScore = 20;
  else if (topStrategyRecent50Roi >= 0) recentRoiScore = 16;
  else if (topStrategyRecent50Roi >= -0.2) recentRoiScore = 10;
  else if (topStrategyRecent50Roi >= -0.4) recentRoiScore = 5;
  else recentRoiScore = 1;

  let roiScore = 0;
  if (topStrategyRoi >= 0.2) roiScore = 5;
  else if (topStrategyRoi >= 0) roiScore = 4;
  else if (topStrategyRoi >= -0.2) roiScore = 3;
  else if (topStrategyRoi >= -0.5) roiScore = 2;
  else roiScore = 0;

  const total =
    compareScore +
    createScore +
    activeScore +
    avgHitScore +
    recentRoiScore +
    roiScore;

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

async function getLatestFormalPrediction(supabase) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, mode, status, created_at, source_draw_no, target_periods, groups_json')
    .eq('mode', 'formal')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function countGroups(groupsJson) {
  if (Array.isArray(groupsJson)) return groupsJson.length;

  if (typeof groupsJson === 'string') {
    try {
      const parsed = JSON.parse(groupsJson);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }

  return 0;
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
      latestDraw,
      latestFormalPrediction
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

      getLatestDrawInfo(supabase),
      getLatestFormalPrediction(supabase)
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
          return Number(Boolean(b.protected_rank)) - Number(Boolean(a.protected_rank));
        }
        return toNum(b.strategy_score, 0) - toNum(a.strategy_score, 0);
      });

    const top = leaderboard[0] || null;
    const topFour = leaderboard.slice(0, 4);

    const comparedLastHour = Number(comparedRes.count || 0);
    const createdLastHour = Number(createdRes.count || 0);
    const disabledLastHour = Number(disabledRes.count || 0);
    const activeCount = activeRows.length;

    const topStrategyKey = top?.strategy_key || '-';
    const topStrategyScore = round1(top?.strategy_score || 0);
    const topStrategyAvgHit = round1(top?.avg_hit || 0);
    const topStrategyRoi = round1(top?.roi || 0);
    const topStrategyRecent50Roi = round1(top?.recent_50_roi || 0);

    const status = detectDecisionPhase({
      comparedLastHour,
      createdLastHour,
      activeCount,
      topStrategyAvgHit,
      topStrategyRoi,
      topStrategyRecent50Roi
    });

    const trainingStrength = calculateDecisionStrength({
      comparedLastHour,
      createdLastHour,
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

      // 舊欄位保留，避免前端直接壞掉
      retiredLastHour: disabledLastHour,

      // 新欄位
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

      // 舊欄位名稱保留，但語意改為「決策準備度」
      trainingStrength,

      latestDrawNo: latestDraw?.draw_no || null,
      latestDrawTime: latestDraw?.draw_time || null,

      latestFormalPrediction: latestFormalPrediction
        ? {
            id: latestFormalPrediction.id,
            status: latestFormalPrediction.status || 'created',
            created_at: latestFormalPrediction.created_at || null,
            source_draw_no: toNum(latestFormalPrediction.source_draw_no, 0),
            target_periods: toNum(latestFormalPrediction.target_periods, 0),
            group_count: countGroups(latestFormalPrediction.groups_json)
          }
        : null,

      // 新語意欄位
      assistantMode: 'decision_support',
      readyForFormal: status.readyForFormal,
      adviceLevel: status.adviceLevel,
      decisionPhase: status.phase,
      currentTopStrategies: topFour.map((row, idx) => ({
        rank: idx + 1,
        strategy_key: row.strategy_key || '',
        avg_hit: round4(row.avg_hit || 0),
        roi: round4(row.roi || 0),
        recent_50_roi: round4(row.recent_50_roi || 0),
        hit_rate: round4(row.hit_rate || 0),
        total_rounds: toNum(row.total_rounds, 0),
        strategy_score: round4(row.strategy_score || 0)
      })),

      statusArrow: status.statusArrow,
      statusLabel: status.statusLabel,
      statusText: status.statusText,
      statusColor: status.statusColor
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'ai-player failed'
    });
  }
}
