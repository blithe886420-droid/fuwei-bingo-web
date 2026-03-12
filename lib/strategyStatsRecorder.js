import { createClient } from '@supabase/supabase-js';

const MAX_RECENT = 50;

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase env for strategyStatsRecorder');
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

const LABEL_TO_KEY = {
  hot_chase: 'hot_chase',
  rebound: 'rebound',
  zone_balanced: 'zone_balanced',
  pattern_structure: 'pattern_structure',
  tail_mix: 'tail_mix',
  warm_follow: 'warm_follow',
  repeat_guard: 'repeat_guard',
  cold_jump: 'cold_jump',
  hot_balanced: 'hot_balanced',
  balanced_zone: 'balanced_zone',
  repeat_chase: 'repeat_chase',
  pattern_structure_zone: 'pattern_structure_zone',
  '熱門追擊型': 'hot_chase',
  '回補反彈型': 'rebound',
  '區段平衡型': 'zone_balanced',
  '盤型結構型': 'pattern_structure',
  '尾數混合型': 'tail_mix',
  '溫熱跟隨型': 'warm_follow',
  '重號防守型': 'repeat_guard',
  '冷跳突擊型': 'cold_jump',
  '熱門追擊': 'hot_chase',
  '熱號均衡': 'hot_balanced',
  '尾數混合': 'tail_mix',
  '分區拆解': 'zone_balanced'
};

function deriveStrategyKeyFromLabel(label = '', fallbackKey = '') {
  const text = String(label || '').trim();

  if (fallbackKey) return String(fallbackKey).trim();
  if (LABEL_TO_KEY[text]) return LABEL_TO_KEY[text];

  if (text.includes('熱門追擊')) return 'hot_chase';
  if (text.includes('回補反彈')) return 'rebound';
  if (text.includes('區段平衡')) return 'zone_balanced';
  if (text.includes('盤型結構')) return 'pattern_structure';
  if (text.includes('尾數混合')) return 'tail_mix';
  if (text.includes('溫熱跟隨')) return 'warm_follow';
  if (text.includes('重號防守')) return 'repeat_guard';
  if (text.includes('冷跳突擊')) return 'cold_jump';
  if (text.includes('熱號均衡')) return 'hot_balanced';
  if (text.includes('Balanced Zone')) return 'balanced_zone';
  if (text.includes('Repeat Chase')) return 'repeat_chase';
  if (text.includes('Pattern Structure Zone')) return 'pattern_structure_zone';

  return null;
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function avg(arr = []) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  return arr.reduce((sum, n) => sum + toFiniteNumber(n, 0), 0) / arr.length;
}

function normalizeRecent(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => toFiniteNumber(v, 0)).slice(-MAX_RECENT);
}

function buildFallbackProfit(hitCount) {
  const map = {
    0: -1,
    1: -0.6,
    2: -0.2,
    3: 0.5,
    4: 1.5
  };

  return map[toFiniteNumber(hitCount, 0)] ?? 0;
}

function getRowProfit(row = {}) {
  const candidates = [
    row.profit,
    row.totalProfit,
    row.netProfit,
    row.roi,
    row.roiScore,
    row.returnValue
  ];

  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num)) return num;
  }

  return buildFallbackProfit(toFiniteNumber(row.hitCount, 0));
}

function calcHitRate(totalHits, totalRounds) {
  if (!totalRounds) return 0;
  return Number((totalHits / (totalRounds * 4)).toFixed(6));
}

function calcRecent50HitRate(recentHits = []) {
  if (!recentHits.length) return 0;
  const total = recentHits.reduce((sum, n) => sum + toFiniteNumber(n, 0), 0);
  return Number((total / (recentHits.length * 4)).toFixed(6));
}

export async function recordStrategyCompareResult({ drawNo, compareResult }) {
  const currentDrawNo = toFiniteNumber(drawNo, 0);
  if (!currentDrawNo) {
    return { ok: false, reason: 'missing_draw_no' };
  }

  const rows = Array.isArray(compareResult?.results) ? compareResult.results : [];
  if (!rows.length) {
    return { ok: true, reason: 'no_compare_rows' };
  }

  const normalizedRows = rows
    .map((row) => {
      const strategyKey = deriveStrategyKeyFromLabel(
        row?.label || row?.strategy || row?.strategyKey || '',
        row?.strategyKey || row?.strategy || row?.key || ''
      );

      if (!strategyKey) return null;

      return {
        strategy_key: strategyKey,
        hitCount: toFiniteNumber(row?.hitCount, 0),
        profit: getRowProfit(row)
      };
    })
    .filter(Boolean);

  if (!normalizedRows.length) {
    return { ok: true, reason: 'no_mapped_strategies' };
  }

  const supabase = getSupabase();
  const strategyKeys = [...new Set(normalizedRows.map((r) => r.strategy_key))];

  const { data: existingRows, error: existingError } = await supabase
    .from('strategy_stats')
    .select('*')
    .in('strategy_key', strategyKeys);

  if (existingError) throw existingError;

  const existingMap = new Map((existingRows || []).map((row) => [row.strategy_key, row]));

  const updates = normalizedRows.map((row) => {
    const prev = existingMap.get(row.strategy_key) || {
      strategy_key: row.strategy_key,
      total_rounds: 0,
      total_hits: 0,
      hit0: 0,
      hit1: 0,
      hit2: 0,
      hit3: 0,
      hit4: 0,
      avg_hit: 0,
      hit_rate: 0,
      total_profit: 0,
      roi: 0,
      recent_hits: [],
      recent_profit: [],
      recent_50_hit_rate: 0,
      recent_50_roi: 0,
      last_result_draw_no: 0
    };

    const totalRounds = toFiniteNumber(prev.total_rounds, 0) + 1;
    const totalHits = toFiniteNumber(prev.total_hits, 0) + row.hitCount;
    const totalProfit = toFiniteNumber(prev.total_profit, 0) + row.profit;

    const recentHits = normalizeRecent([...(prev.recent_hits || []), row.hitCount]);
    const recentProfit = normalizeRecent([...(prev.recent_profit || []), row.profit]);

    return {
      strategy_key: row.strategy_key,
      total_rounds: totalRounds,
      total_hits: totalHits,
      hit0: toFiniteNumber(prev.hit0, 0) + (row.hitCount === 0 ? 1 : 0),
      hit1: toFiniteNumber(prev.hit1, 0) + (row.hitCount === 1 ? 1 : 0),
      hit2: toFiniteNumber(prev.hit2, 0) + (row.hitCount === 2 ? 1 : 0),
      hit3: toFiniteNumber(prev.hit3, 0) + (row.hitCount === 3 ? 1 : 0),
      hit4: toFiniteNumber(prev.hit4, 0) + (row.hitCount >= 4 ? 1 : 0),
      avg_hit: Number((totalHits / totalRounds).toFixed(6)),
      hit_rate: calcHitRate(totalHits, totalRounds),
      total_profit: Number(totalProfit.toFixed(6)),
      roi: Number((totalProfit / totalRounds).toFixed(6)),
      recent_hits: recentHits,
      recent_profit: recentProfit,
      recent_50_hit_rate: calcRecent50HitRate(recentHits),
      recent_50_roi: Number(avg(recentProfit).toFixed(6)),
      last_result_draw_no: currentDrawNo,
      last_updated: new Date().toISOString()
    };
  });

  const { error: upsertError } = await supabase
    .from('strategy_stats')
    .upsert(updates, { onConflict: 'strategy_key' });

  if (upsertError) throw upsertError;

  return {
    ok: true,
    updated: updates.length,
    drawNo: currentDrawNo
  };
}
