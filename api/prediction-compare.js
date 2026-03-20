import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const COST = 25;

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseNumbers(str) {
  if (!str) return [];
  return String(str)
    .split(' ')
    .map(x => Number(x))
    .filter(n => Number.isFinite(n));
}

function calcHits(groups, drawNumbersList) {
  let totalHits = 0;

  for (const g of groups) {
    for (const draw of drawNumbersList) {
      const set = new Set(draw);
      for (const n of g) {
        if (set.has(n)) totalHits++;
      }
    }
  }

  return totalHits;
}

async function updateStrategy(strategyKey, hitCount) {
  const { data } = await supabase
    .from('strategy_stats')
    .select('*')
    .eq('strategy_key', strategyKey)
    .single();

  if (!data) return;

  const totalRounds = toNum(data.total_rounds) + 1;
  const totalHits = toNum(data.total_hits) + hitCount;
  const totalCost = totalRounds * COST;
  const totalReward = totalHits * 10;
  const totalProfit = totalReward - totalCost;
  const roi = totalCost === 0 ? 0 : totalProfit / totalCost;

  await supabase
    .from('strategy_stats')
    .update({
      total_rounds: totalRounds,
      total_hits: totalHits,
      total_cost: totalCost,
      total_reward: totalReward,
      total_profit: totalProfit,
      roi,
      updated_at: new Date().toISOString()
    })
    .eq('strategy_key', strategyKey);
}

export default async function handler(req, res) {
  try {
    const { data: predictions } = await supabase
      .from('bingo_predictions')
      .select('*')
      .eq('status', 'created')
      .order('created_at', { ascending: true })
      .limit(100);

    let processed = 0;

    for (const p of predictions || []) {
      const sourceDrawNo = toNum(p.source_draw_no);
      const targetPeriods = toNum(p.target_periods);

      if (!sourceDrawNo || !targetPeriods) continue;

      const { data: draws } = await supabase
        .from('bingo_draws')
        .select('*')
        .gt('draw_no', sourceDrawNo)
        .order('draw_no', { ascending: true })
        .limit(targetPeriods);

      if (!draws || draws.length < targetPeriods) continue;

      const groups = Array.isArray(p.groups_json)
        ? p.groups_json
        : [];

      const drawNumbersList = draws.map(d => parseNumbers(d.numbers));

      const hitCount = calcHits(groups, drawNumbersList);

      await supabase
        .from('bingo_predictions')
        .update({
          status: 'compared',
          compared_at: new Date().toISOString(),
          hit_count: hitCount
        })
        .eq('id', p.id);

      await updateStrategy(p.strategy_key, hitCount);

      processed++;
    }

    res.status(200).json({
      ok: true,
      processed
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
