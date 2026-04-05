import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

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
      .replace(/[{}[\]]/g, ' ')
      .split(/[,\s|/]+/)
      .map((n) => Number(String(n).trim()))
      .filter(Number.isFinite);
  }

  if (value && typeof value === 'object') {
    return parseNumbers(
      value.numbers ||
      value.draw_numbers ||
      value.result_numbers ||
      value.open_numbers ||
      value.nums ||
      []
    );
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

async function processPrediction(prediction, draw) {
  const groups = parseGroups(prediction.groups_json || prediction.groups || []);
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
    const { data: predictions, error: predictionError } = await supabase
      .from(PREDICTIONS_TABLE)
      .select('*')
      .eq('status', 'created')
      .order('created_at', { ascending: true })
      .limit(5);

    if (predictionError) {
      throw predictionError;
    }

    if (!predictions || predictions.length === 0) {
      return res.status(200).json({
        ok: true,
        message: 'no pending predictions'
      });
    }

    let processed = 0;
    const statsUpdatedKeys = [];
    const statsDisabledKeys = [];

    for (const p of predictions) {
      const targetDrawNo = toNum(p.source_draw_no) + toNum(p.target_periods, 1);

      const { data: draw, error: drawError } = await supabase
        .from(DRAWS_TABLE)
        .select('*')
        .eq('draw_no', targetDrawNo)
        .maybeSingle();

      if (drawError) {
        throw drawError;
      }

      if (!draw) continue;

      const result = await processPrediction(p, draw);

      const statsResult = await recordStrategyCompareResult({
        detail: result.detail
      });

      await supabase
        .from(PREDICTIONS_TABLE)
        .update({
          status: 'compared',
          compare_status: 'done',
          compared_at: new Date().toISOString(),
          compare_result: result,
          compare_result_json: result,
          hit_count: result.total_hit,
          verdict: result.total_profit >= 0 ? 'good' : 'bad'
        })
        .eq('id', p.id);

      if (Array.isArray(statsResult?.updated_keys)) {
        statsUpdatedKeys.push(...statsResult.updated_keys);
      }
      if (Array.isArray(statsResult?.disabled_keys)) {
        statsDisabledKeys.push(...statsResult.disabled_keys);
      }

      processed += 1;
    }

    return res.status(200).json({
      ok: true,
      processed,
      updated_keys: [...new Set(statsUpdatedKeys)],
      disabled_keys: [...new Set(statsDisabledKeys)]
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
