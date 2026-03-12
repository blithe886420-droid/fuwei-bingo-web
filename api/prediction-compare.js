import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';

const DRAW_NO_COL = 'draw_no';
const DRAW_TIME_COL = 'draw_time';
const DRAW_NUMBERS_COL = 'numbers';

const COST_PER_GROUP_PER_PERIOD = 25;

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueAsc(nums) {
  return [...new Set(nums.map((n) => Number(n)).filter(Number.isFinite))].sort((a, b) => a - b);
}

function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function getHitNumbers(predicted, drawNumbers) {
  const drawSet = new Set(drawNumbers.map(Number));
  return predicted.map(Number).filter((n) => drawSet.has(n)).sort((a, b) => a - b);
}

function calcRewardByHitCount(hitCount) {
  if (hitCount >= 4) return 1000;
  if (hitCount === 3) return 100;
  if (hitCount === 2) return 25;
  return 0;
}

function parseGroupsFromPrediction(prediction) {
  const raw = prediction?.groups_json ?? null;
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((group, idx) => {
        if (Array.isArray(group)) {
          return {
            key: `group_${idx + 1}`,
            label: `第${idx + 1}組`,
            nums: uniqueAsc(group),
            reason: '舊版資料',
            meta: { legacy: true }
          };
        }

        if (group && typeof group === 'object') {
          return {
            key: group.key || `group_${idx + 1}`,
            label: group.label || `第${idx + 1}組`,
            nums: uniqueAsc(Array.isArray(group.nums) ? group.nums : []),
            reason: group.reason || '',
            meta: group.meta || {}
          };
        }

        return null;
      })
      .filter((g) => g && g.nums.length > 0);
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parseGroupsFromPrediction({ groups_json: parsed });
    } catch {
      return [];
    }
  }

  return [];
}

async function getPredictionById(predictionId) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('id', predictionId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getDrawRowsForPrediction(prediction) {
  const sourceDrawNo = toInt(prediction.source_draw_no);
  const targetPeriods = toInt(prediction.target_periods || 2);

  const start = sourceDrawNo + 1;
  const end = sourceDrawNo + targetPeriods;

  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select(`${DRAW_NO_COL}, ${DRAW_TIME_COL}, ${DRAW_NUMBERS_COL}`)
    .gte(DRAW_NO_COL, start)
    .lte(DRAW_NO_COL, end)
    .order(DRAW_NO_COL, { ascending: true });

  if (error) throw error;

  return (data || []).filter((row) => parseDrawNumbers(row[DRAW_NUMBERS_COL]).length > 0);
}

function buildCompareResult(prediction, groups, drawRows) {
  const sourceDrawNo = String(prediction.source_draw_no || '');
  const targetPeriods = toInt(prediction.target_periods || 2);

  const compareRounds = [];
  const groupResults = [];

  let totalReward = 0;
  let totalHitCount = 0;
  let bestSingleHit = 0;

  for (const drawRow of drawRows) {
    const drawNo = toInt(drawRow[DRAW_NO_COL]);
    const drawTime = drawRow[DRAW_TIME_COL] || '';
    const drawNumbers = parseDrawNumbers(drawRow[DRAW_NUMBERS_COL]);

    compareRounds.push({
      drawNo,
      drawTime,
      drawNumbers
    });

    for (const group of groups) {
      const hitNumbers = getHitNumbers(group.nums, drawNumbers);
      const hitCount = hitNumbers.length;
      const reward = calcRewardByHitCount(hitCount);

      let current = groupResults.find((g) => g.key === group.key);
      if (!current) {
        current = {
          key: group.key,
          label: group.label,
          nums: group.nums,
          reason: group.reason || '',
          meta: group.meta || {},
          hitCount: 0,
          bestSingleHit: 0,
          totalReward: 0,
          hit2Count: 0,
          hit3Count: 0,
          hit4Count: 0,
          periodHits: []
        };
        groupResults.push(current);
      }

      current.hitCount += hitCount;
      current.bestSingleHit = Math.max(current.bestSingleHit, hitCount);
      current.totalReward += reward;

      if (hitCount === 2) current.hit2Count += 1;
      if (hitCount === 3) current.hit3Count += 1;
      if (hitCount >= 4) current.hit4Count += 1;

      current.periodHits.push({
        drawNo,
        drawTime,
        hitNumbers,
        hitCount,
        reward
      });

      totalReward += reward;
      totalHitCount += hitCount;
      bestSingleHit = Math.max(bestSingleHit, hitCount);
    }
  }

  const totalCost = groups.length * targetPeriods * COST_PER_GROUP_PER_PERIOD;
  const profit = totalReward - totalCost;
  const compareDrawNo = drawRows.length ? toInt(drawRows[drawRows.length - 1][DRAW_NO_COL]) : null;
  const compareDrawRange =
    drawRows.length > 0
      ? `${drawRows[0][DRAW_NO_COL]} ~ ${drawRows[drawRows.length - 1][DRAW_NO_COL]}`
      : '';

  const maxHit = Math.max(0, ...groupResults.map((g) => g.hitCount));
  const verdict = `${targetPeriods}期累計最佳 ${maxHit} 碼 / 單期最佳中${bestSingleHit}`;

  const compareResult = {
    mode: `4star_4group_${targetPeriods}period`,
    source_draw_no: sourceDrawNo,
    target_periods: targetPeriods,
    total_cost: totalCost,
    total_reward: totalReward,
    profit,
    total_hit_count: totalHitCount,
    best_single_hit: bestSingleHit,
    compare_draw_range: compareDrawRange,
    groups: groupResults.map((g) => ({
      key: g.key,
      label: g.label,
      nums: g.nums,
      reason: g.reason,
      meta: g.meta,
      total_hit_count: g.hitCount,
      best_single_hit: g.bestSingleHit,
      total_reward: g.totalReward,
      hit2_count: g.hit2Count,
      hit3_count: g.hit3Count,
      hit4_count: g.hit4Count,
      periods: g.periodHits.map((p) => ({
        draw_no: p.drawNo,
        draw_time: p.drawTime,
        hit_numbers: p.hitNumbers,
        hit_count: p.hitCount,
        reward: p.reward
      }))
    })),
    period_results: drawRows.map((drawRow) => {
      const drawNo = toInt(drawRow[DRAW_NO_COL]);
      let reward = 0;
      for (const group of groupResults) {
        const hit = group.periodHits.find((p) => p.drawNo === drawNo);
        if (hit) reward += hit.reward;
      }
      return {
        draw_no: drawNo,
        draw_time: drawRow[DRAW_TIME_COL] || '',
        reward
      };
    }),
    summary: {
      total_groups: groups.length,
      total_periods: targetPeriods,
      total_hit_count: totalHitCount,
      best_single_hit: bestSingleHit
    }
  };

  const resultForApp = {
    verdict,
    sourceDrawNo,
    targetDrawNo: toInt(sourceDrawNo) + targetPeriods,
    compareDrawNo,
    compareDrawRange,
    totalCost,
    estimatedReturn: totalReward,
    profit,
    compareRounds,
    results: groupResults.map((g) => ({
      key: g.key,
      strategyKey: g.key,
      strategy: g.key,
      label: g.label,
      nums: g.nums,
      hitCount: g.hitCount,
      bestSingleHit: g.bestSingleHit,
      totalReward: g.totalReward,
      hit2Count: g.hit2Count,
      hit3Count: g.hit3Count,
      hit4Count: g.hit4Count,
      periodHits: g.periodHits.map((p) => ({
        drawNo: p.drawNo,
        drawTime: p.drawTime,
        hitNumbers: p.hitNumbers,
        hitCount: p.hitCount,
        reward: p.reward
      }))
    }))
  };

  return {
    verdict,
    compareResult,
    resultForApp,
    totalHitCount,
    bestSingleHit,
    comparedDrawCount: drawRows.length,
    compareDrawNo
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const predictionId = req.body?.predictionId;
    if (!predictionId) {
      return res.status(400).json({
        ok: false,
        error: 'predictionId is required'
      });
    }

    const prediction = await getPredictionById(predictionId);
    if (!prediction) {
      return res.status(404).json({
        ok: false,
        error: 'Prediction not found'
      });
    }

    const groups = parseGroupsFromPrediction(prediction);
    if (!groups.length) {
      return res.status(400).json({
        ok: false,
        error: 'groups_json 解析失敗'
      });
    }

    const drawRows = await getDrawRowsForPrediction(prediction);
    const targetPeriods = toInt(prediction.target_periods || 2);

    if (drawRows.length < targetPeriods) {
      const sourceDrawNo = toInt(prediction.source_draw_no);
      return res.status(200).json({
        ok: false,
        waiting: true,
        error: `尚未收齊第 ${sourceDrawNo + 1} 期到第 ${sourceDrawNo + targetPeriods} 期開獎資料`
      });
    }

    const built = buildCompareResult(prediction, groups, drawRows);

    const { error } = await supabase
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'compared',
        compare_status: 'done',
        compared_at: new Date().toISOString(),
        compared_draw_count: built.comparedDrawCount,
        compare_result: built.compareResult,
        compare_result_json: built.compareResult,
        compare_history_json: [],
        verdict: built.verdict,
        hit_count: built.totalHitCount,
        best_single_hit: built.bestSingleHit
      })
      .eq('id', predictionId);

    if (error) throw error;

    let strategyStatsResult = null;

    try {
      strategyStatsResult = await recordStrategyCompareResult({
        drawNo: built.compareDrawNo,
        compareResult: built.resultForApp
      });
      console.log('recordStrategyCompareResult result:', strategyStatsResult);
    } catch (err) {
      console.error('recordStrategyCompareResult error:', err.message);
    }

    return res.status(200).json({
      ok: true,
      result: built.resultForApp,
      strategyStatsResult
    });
  } catch (error) {
    console.error('prediction-compare error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'prediction compare failed'
    });
  }
}
