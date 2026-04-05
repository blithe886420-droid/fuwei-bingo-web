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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseNumbers(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((n) => Number(n.trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function parseGroups(groupsJson) {
  if (!groupsJson) return [];

  if (Array.isArray(groupsJson)) return groupsJson;

  if (typeof groupsJson === 'string') {
    try {
      return JSON.parse(groupsJson);
    } catch {
      return [];
    }
  }

  return [];
}

function countHit(a = [], b = []) {
  const set = new Set(b);
  return a.filter((n) => set.has(n)).length;
}

function calcReward(hit) {
  if (hit >= 4) return 1000;
  if (hit === 3) return 100;
  if (hit === 2) return 25;
  return 0;
}

async function upsertStrategyStat(strategyKey, hit, cost, reward) {
  const { data: existing } = await supabase
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .eq('strategy_key', strategyKey)
    .maybeSingle();

  const prevRounds = toNum(existing?.total_rounds, 0);
  const prevHits = toNum(existing?.total_hits, 0);
  const prevCost = toNum(existing?.total_cost, 0);
  const prevReward = toNum(existing?.total_reward, 0);

  const newRounds = prevRounds + 1;
  const newHits = prevHits + hit;
  const newCost = prevCost + cost;
  const newReward = prevReward + reward;

  const avgHit = newHits / newRounds;
  const roi = newCost > 0 ? (newReward - newCost) / newCost : 0;

  await supabase.from(STRATEGY_STATS_TABLE).upsert({
    strategy_key: strategyKey,
    total_rounds: newRounds,
    total_hits: newHits,
    total_cost: newCost,
    total_reward: newReward,
    avg_hit: avgHit,
    roi: roi,
    updated_at: new Date().toISOString()
  });
}

async function processPrediction(prediction, draw) {
  const groups = parseGroups(prediction.groups_json);
  const drawNums = parseNumbers(draw.numbers);

  let totalHit = 0;
  let totalCost = 0;
  let totalReward = 0;

  const detail = [];

  for (const g of groups) {
    const nums = parseNumbers(g.nums || g.numbers || []);
    const hit = countHit(nums, drawNums);
    const cost = 25;
    const reward = calcReward(hit);

    totalHit += hit;
    totalCost += cost;
    totalReward += reward;

    const strategyKey = g.meta?.strategy_key || g.key || 'unknown';

    await upsertStrategyStat(strategyKey, hit, cost, reward);

    detail.push({
      nums,
      hit,
      cost,
      reward,
      strategy_key: strategyKey
    });
  }

  const profit = totalReward - totalCost;
  const roi = totalCost > 0 ? profit / totalCost : 0;

  return {
    total_hit: totalHit,
    total_cost: totalCost,
    total_reward: totalReward,
    total_profit: profit,
    roi,
    detail
  };
}

export default async function handler(req, res) {
  try {
    // 1️⃣ 找尚未 compare 的 prediction
    const { data: predictions } = await supabase
      .from(PREDICTIONS_TABLE)
      .select('*')
      .eq('status', 'created')
      .order('created_at', { ascending: true })
      .limit(5);

    if (!predictions || predictions.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'no pending predictions'
      });
    }

    let processed = 0;

    for (const p of predictions) {
      const targetDrawNo =
        toNum(p.source_draw_no) + toNum(p.target_periods);

      // 2️⃣ 找開獎
      const { data: draw } = await supabase
        .from(DRAWS_TABLE)
        .select('*')
        .eq('draw_no', targetDrawNo)
        .maybeSingle();

      if (!draw) continue;

      // 3️⃣ 計算 compare
      const result = await processPrediction(p, draw);

      // 4️⃣ 寫回 prediction
      await supabase
        .from(PREDICTIONS_TABLE)
        .update({
          status: 'compared',
          compare_status: 'done',
          compared_at: new Date().toISOString(),
          compare_result: result,
          hit_count: result.total_hit,
          verdict: result.total_profit >= 0 ? 'good' : 'bad'
        })
        .eq('id', p.id);

      processed++;
    }

    return res.status(200).json({
      ok: true,
      processed
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}

// 短期命中分數
function calcShortTermScore(history=[]){const recent=history.slice(-20); let h=0,c=0,r=0; for(const x of recent){h+=x.hit;c+=x.cost;r+=x.reward;} const avg=h/(recent.length||1); const roi=c>0?(r-c)/c:0; return avg*50+Math.max(roi,-1)*30;}
