import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function toNum(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function round2(n) {
  return Number(Number(n || 0).toFixed(2));
}

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult || !Array.isArray(compareResult.groups)) return;

  for (const group of compareResult.groups) {
    const strategyKey =
      group?.meta?.strategy_key ||
      group?.meta?.strategy_name ||
      group.key ||
      'unknown';

    const strategyLabel = group.label || strategyKey;

    const totalProfit = toNum(group.total_profit, 0);
    const totalHit = toNum(group.total_hit_count, 0);
    const bestHit = toNum(group.best_single_hit, 0);

    const win = totalProfit > 0 ? 1 : 0;
    const loss = totalProfit < 0 ? 1 : 0;
    const draw = totalProfit === 0 ? 1 : 0;

    // 先抓舊資料
    const { data: existing, error: fetchError } = await supabase
      .from('strategy_stats')
      .select('*')
      .eq('strategy_key', strategyKey)
      .maybeSingle();

    if (fetchError) throw fetchError;

    const newTotalRuns = toNum(existing?.total_runs, 0) + 1;
    const newTotalProfit = toNum(existing?.total_profit, 0) + totalProfit;
    const newTotalHit = toNum(existing?.total_hit_count, 0) + totalHit;

    const newWin = toNum(existing?.win_count, 0) + win;
    const newLoss = toNum(existing?.loss_count, 0) + loss;
    const newDraw = toNum(existing?.draw_count, 0) + draw;

    const newBestHit = Math.max(toNum(existing?.best_single_hit, 0), bestHit);

    const avgRoi =
      newTotalRuns > 0
        ? round2((newTotalProfit / (newTotalRuns * 50)) * 100)
        : 0;

    const payload = {
      strategy_key: strategyKey,
      strategy_label: strategyLabel,
      total_runs: newTotalRuns,
      total_profit: newTotalProfit,
      total_hit_count: newTotalHit,
      win_count: newWin,
      loss_count: newLoss,
      draw_count: newDraw,
      best_single_hit: newBestHit,
      avg_roi: avgRoi,
      last_result: group,
      updated_at: new Date().toISOString()
    };

    if (existing) {
      const { error } = await supabase
        .from('strategy_stats')
        .update(payload)
        .eq('id', existing.id);

      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('strategy_stats')
        .insert({
          ...payload,
          created_at: new Date().toISOString()
        });

      if (error) throw error;
    }
  }
}
