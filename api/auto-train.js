import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MODE = 'v3_auto_loop_test_2period';
const TARGET_PERIODS = 2;
const BET_GROUP_COUNT = 4;
const COST_PER_GROUP_PER_PERIOD = 25;

const MAX_COMPARE_PER_RUN = 1;
const MAX_CREATE_PER_RUN = 1;
const SOFT_TIMEOUT_MS = 8000;

const DRAWS_TABLE = 'bingo_draws';
const PREDICTIONS_TABLE = 'bingo_predictions';

const DRAW_NO_COL = 'draw_no';
const DRAW_TIME_COL = 'draw_time';
const DRAW_NUMBERS_COL = 'numbers';

function nowTs() {
  return Date.now();
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
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

function parsePredictionGroups(prediction) {
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
          const nums = Array.isArray(group.nums) ? group.nums : [];
          return {
            key: group.key || `group_${idx + 1}`,
            label: group.label || `第${idx + 1}組`,
            nums: uniqueAsc(nums),
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
      return parsePredictionGroups({ groups_json: parsed });
    } catch {
      return [];
    }
  }

  return [];
}

async function getLatestDrawNo() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select(DRAW_NO_COL)
    .order(DRAW_NO_COL, { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? toInt(data[DRAW_NO_COL]) : 0;
}

async function getRecent20() {
  const { data, error } = await supabase
    .from(DRAWS_TABLE)
    .select(`${DRAW_NO_COL}, ${DRAW_TIME_COL}, ${DRAW_NUMBERS_COL}`)
    .order(DRAW_NO_COL, { ascending: false })
    .limit(20);

  if (error) throw error;
  return data || [];
}

async function getMaturedPredictions(limitCount) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('status', 'created')
    .eq('mode', MODE)
    .eq('target_periods', TARGET_PERIODS)
    .order('created_at', { ascending: true })
    .limit(limitCount);

  if (error) throw error;
  return data || [];
}

async function getDrawRowsForPrediction(prediction) {
  const sourceDrawNo = toInt(prediction.source_draw_no);
  const targetPeriods = toInt(prediction.target_periods || TARGET_PERIODS);

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

function buildComparePayload({ prediction, groups, drawRows }) {
  const sourceDrawNo = String(prediction.source_draw_no || '');
  const targetPeriods = toInt(prediction.target_periods || TARGET_PERIODS);

  const groupResults = [];
  const periodResults = [];

  let totalReward = 0;
  let totalHitCount = 0;
  let bestSingleHit = 0;

  for (const drawRow of drawRows) {
    const drawNo = toInt(drawRow[DRAW_NO_COL]);
    const drawTime = drawRow[DRAW_TIME_COL] || '';
    const drawNumbers = parseDrawNumbers(drawRow[DRAW_NUMBERS_COL]);

    let periodReward = 0;

    for (const group of groups) {
      const hitNumbers = getHitNumbers(group.nums, drawNumbers);
      const hitCount = hitNumbers.length;
      const reward = calcRewardByHitCount(hitCount);

      let targetGroup = groupResults.find((g) => g.key === group.key);
      if (!targetGroup) {
        targetGroup = {
          key: group.key,
          label: group.label,
          nums: group.nums,
          reason: group.reason || '',
          meta: group.meta || {},
          total_hit_count: 0,
          best_single_hit: 0,
          total_reward: 0,
          hit2_count: 0,
          hit3_count: 0,
          hit4_count: 0,
          payout_rounds: 0,
          profit_rounds: 0,
          total_cost: 0,
          total_profit: 0,
          periods: []
        };
        groupResults.push(targetGroup);
      }

      const cost = COST_PER_GROUP_PER_PERIOD;
      const profit = reward - cost;

      targetGroup.total_hit_count += hitCount;
      targetGroup.best_single_hit = Math.max(targetGroup.best_single_hit, hitCount);
      targetGroup.total_reward += reward;
      targetGroup.total_cost += cost;
      targetGroup.total_profit += profit;

      if (hitCount === 2) targetGroup.hit2_count += 1;
      if (hitCount === 3) targetGroup.hit3_count += 1;
      if (hitCount >= 4) targetGroup.hit4_count += 1;
      if (reward > 0) targetGroup.payout_rounds += 1;
      if (profit > 0) targetGroup.profit_rounds += 1;

      targetGroup.periods.push({
        draw_no: drawNo,
        draw_time: drawTime,
        hit_numbers: hitNumbers,
        hit_count: hitCount,
        reward,
        cost,
        profit
      });

      totalHitCount += hitCount;
      bestSingleHit = Math.max(bestSingleHit, hitCount);
      periodReward += reward;
      totalReward += reward;
    }

    periodResults.push({
      draw_no: drawNo,
      draw_time: drawTime,
      reward: periodReward
    });
  }

  for (const group of groupResults) {
    const totalRounds = group.periods.length || targetPeriods;
    group.avg_hit = round2(group.total_hit_count / totalRounds);
    group.avg_reward = round2(group.total_reward / totalRounds);
    group.avg_profit = round2(group.total_profit / totalRounds);
    group.payout_rate = round2((group.payout_rounds / totalRounds) * 100);
    group.profit_win_rate = round2((group.profit_rounds / totalRounds) * 100);
    group.roi = group.total_cost > 0
      ? round2((group.total_profit / group.total_cost) * 100)
      : 0;
  }

  const totalCost = groups.length * targetPeriods * COST_PER_GROUP_PER_PERIOD;
  const profit = totalReward - totalCost;
  const compareDrawRange =
    drawRows.length > 0
      ? `${drawRows[0][DRAW_NO_COL]} ~ ${drawRows[drawRows.length - 1][DRAW_NO_COL]}`
      : '';

  const maxTotalHit = Math.max(0, ...groupResults.map((g) => g.total_hit_count));
  const verdict = `${targetPeriods}期累計最佳 ${maxTotalHit} 碼 / 單期最佳中${bestSingleHit}`;

  const compareResult = {
    mode: '4star_4group_2period',
    source_draw_no: sourceDrawNo,
    total_cost: totalCost,
    total_reward: totalReward,
    profit,
    total_hit_count: totalHitCount,
    best_single_hit: bestSingleHit,
    compare_draw_range: compareDrawRange,
    groups: groupResults,
    period_results: periodResults,
    summary: {
      total_groups: groups.length,
      total_periods: drawRows.length,
      total_hit_count: totalHitCount,
      best_single_hit: bestSingleHit
    }
  };

  return {
    compareResult,
    compareResultJson: compareResult,
    verdict,
    hitCount: totalHitCount,
    bestSingleHit,
    comparedDrawCount: drawRows.length
  };
}

async function comparePrediction(prediction) {
  const groups = parsePredictionGroups(prediction);

  if (!groups.length) {
    return {
      ok: false,
      pending: false,
      predictionId: prediction.id,
      message: 'groups_json 解析失敗'
    };
  }

  const drawRows = await getDrawRowsForPrediction(prediction);

  if (drawRows.length < TARGET_PERIODS) {
    const startNo = toInt(prediction.source_draw_no) + 1;
    const endNo = toInt(prediction.source_draw_no) + TARGET_PERIODS;

    return {
      ok: false,
      pending: true,
      predictionId: prediction.id,
      message: `尚未收齊第 ${startNo} 期到第 ${endNo} 期開獎資料`
    };
  }

  const built = buildComparePayload({ prediction, groups, drawRows });

  const { error } = await supabase
    .from(PREDICTIONS_TABLE)
    .update({
      status: 'compared',
      compare_status: 'done',
      compared_at: new Date().toISOString(),
      compared_draw_count: built.comparedDrawCount,
      compare_result: built.compareResult,
      compare_result_json: built.compareResultJson,
      compare_history_json: [],
      verdict: built.verdict,
      hit_count: built.hitCount,
      best_single_hit: built.bestSingleHit
    })
    .eq('id', prediction.id);

  if (error) throw error;

  return {
    ok: true,
    predictionId: prediction.id,
    sourceDrawNo: prediction.source_draw_no,
    compareResult: built.compareResult,
    hitCount: built.hitCount,
    bestSingleHit: built.bestSingleHit
  };
}

function buildStrategyGroupsFromRecent20(recent20) {
  const allNums = recent20.flatMap((row) => parseDrawNumbers(row[DRAW_NUMBERS_COL]));
  const freq = new Map();
  const tailFreq = new Map();

  for (const n of allNums) {
    freq.set(n, (freq.get(n) || 0) + 1);
    const t = n % 10;
    tailFreq.set(t, (tailFreq.get(t) || 0) + 1);
  }

  const hottest = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  function topInRange(min, max, count) {
    return hottest.filter((n) => n >= min && n <= max).slice(0, count);
  }

  function pickByTail(tailNum, count) {
    return hottest.filter((n) => n % 10 === tailNum).slice(0, count);
  }

  const topTails = [...tailFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([t]) => t);

  const groups = [];

  groups.push({
    key: 'hot_chase',
    label: '熱號強追',
    nums: uniqueAsc(hottest.slice(0, 4)),
    reason: '最近20期最高頻4碼',
    meta: { model: 'v3.6', source: 'auto_train' }
  });

  groups.push({
    key: 'hot_balance',
    label: '熱號均衡',
    nums: uniqueAsc([...topInRange(1, 40, 2), ...topInRange(41, 80, 2)]).slice(0, 4),
    reason: '前後半區各取熱號，避免過度集中',
    meta: { model: 'v3.6', source: 'auto_train' }
  });

  const tailA = topTails[0] ?? 0;
  const tailB = topTails[1] ?? 1;
  groups.push({
    key: 'tail_mix',
    label: '尾數混合',
    nums: uniqueAsc([...pickByTail(tailA, 2), ...pickByTail(tailB, 2)]).slice(0, 4),
    reason: `優先使用近期最熱尾數 ${tailA} / ${tailB}`,
    meta: { model: 'v3.6', source: 'auto_train' }
  });

  groups.push({
    key: 'zone_split',
    label: '分區拆解',
    nums: uniqueAsc([
      ...topInRange(1, 20, 1),
      ...topInRange(21, 40, 1),
      ...topInRange(41, 60, 1),
      ...topInRange(61, 80, 1)
    ]).slice(0, 4),
    reason: '四區各取代表號，兼顧分散與熱度',
    meta: { model: 'v3.6', source: 'auto_train' }
  });

  const fallback = [];
  for (let i = 1; i <= 80; i++) fallback.push(i);

  return groups.map((g, idx) => {
    let nums = uniqueAsc(g.nums);
    if (nums.length < 4) {
      for (const n of fallback) {
        if (!nums.includes(n)) nums.push(n);
        if (nums.length >= 4) break;
      }
      nums = uniqueAsc(nums).slice(0, 4);
    }

    return {
      ...g,
      label: g.label || `策略${idx + 1}`,
      nums
    };
  }).slice(0, BET_GROUP_COUNT);
}

async function findExistingCreatedBySourceDrawNo(sourceDrawNo) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id')
    .eq('mode', MODE)
    .eq('target_periods', TARGET_PERIODS)
    .eq('source_draw_no', String(sourceDrawNo))
    .in('status', ['created', 'compared'])
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createNextTestPrediction() {
  const latestDrawNo = await getLatestDrawNo();

  if (!latestDrawNo) {
    return { ok: false, skipped: false, message: 'bingo_draws 尚無資料' };
  }

  const sourceDrawNo = String(latestDrawNo);
  const existing = await findExistingCreatedBySourceDrawNo(sourceDrawNo);

  if (existing) {
    return {
      ok: false,
      skipped: true,
      message: `source_draw_no ${sourceDrawNo} 已存在 prediction`
    };
  }

  const recent20 = await getRecent20();
  if (!recent20.length) {
    return { ok: false, skipped: false, message: '無 recent20 可建立測試 prediction' };
  }

  const groups = buildStrategyGroupsFromRecent20(recent20);
  const id = Date.now();

  const payload = {
    id,
    mode: MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: TARGET_PERIODS,
    groups_json: groups,
    created_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .insert(payload)
    .select('*')
    .single();

  if (error) throw error;

  return {
    ok: true,
    created: data,
    groups,
    message: `已建立新測試 prediction，來源第 ${sourceDrawNo} 期`
  };
}

async function buildLeaderboard(limitRows = 120) {
  const { data, error } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('id, mode, compare_result, compared_at')
    .eq('status', 'compared')
    .not('compare_result', 'is', null)
    .order('compared_at', { ascending: false })
    .limit(limitRows);

  if (error) throw error;

  const map = new Map();

  for (const row of data || []) {
    const groups = Array.isArray(row?.compare_result?.groups) ? row.compare_result.groups : [];
    for (const group of groups) {
      const key = group?.key || 'unknown';
      const label = group?.label || key;

      if (!map.has(key)) {
        map.set(key, {
          key,
          label,
          rounds: 0,
          totalHit: 0,
          totalReward: 0,
          totalCost: 0,
          totalProfit: 0,
          payoutRounds: 0,
          profitRounds: 0,
          bestHit: 0
        });
      }

      const entry = map.get(key);
      const totalRounds = Array.isArray(group?.periods) ? group.periods.length : TARGET_PERIODS;
      const totalHit = toInt(group?.total_hit_count, 0);
      const totalReward = toInt(group?.total_reward, 0);
      const payoutRounds = toInt(group?.payout_rounds, 0);
      const profitRounds = toInt(group?.profit_rounds, 0);
      const totalCost = toInt(group?.total_cost, totalRounds * COST_PER_GROUP_PER_PERIOD);
      const totalProfit = toInt(group?.total_profit, totalReward - totalCost);

      entry.rounds += totalRounds;
      entry.totalHit += totalHit;
      entry.totalReward += totalReward;
      entry.totalCost += totalCost;
      entry.totalProfit += totalProfit;
      entry.payoutRounds += payoutRounds;
      entry.profitRounds += profitRounds;
      entry.bestHit = Math.max(entry.bestHit, toInt(group?.best_single_hit, 0));
    }
  }

  const leaderboard = [...map.values()]
    .map((item) => {
      const avgHit = item.rounds ? item.totalHit / item.rounds : 0;
      const avgReward = item.rounds ? item.totalReward / item.rounds : 0;
      const avgProfit = item.rounds ? item.totalProfit / item.rounds : 0;
      const payoutRate = item.rounds ? (item.payoutRounds / item.rounds) * 100 : 0;
      const profitWinRate = item.rounds ? (item.profitRounds / item.rounds) * 100 : 0;
      const roi = item.totalCost > 0 ? (item.totalProfit / item.totalCost) * 100 : 0;

      const score =
        roi * 4 +
        avgProfit * 1.2 +
        profitWinRate * 2.2 +
        payoutRate * 1.1 +
        avgHit * 8 +
        item.bestHit * 6;

      return {
        key: item.key,
        label: item.label,
        total_rounds: item.rounds,
        avg_hit: round2(avgHit),
        avg_reward: round2(avgReward),
        avg_profit: round2(avgProfit),
        payout_rate: round2(payoutRate),
        profit_win_rate: round2(profitWinRate),
        roi: round2(roi),
        best_hit: item.bestHit,
        score: round2(score)
      };
    })
    .filter((item) => item.key !== 'unknown')
    .sort((a, b) => b.score - a.score);

  return leaderboard;
}

export default async function handler(req, res) {
  const startedAt = nowTs();

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const latestDrawNo = await getLatestDrawNo();
    const maturedCandidates = await getMaturedPredictions(MAX_COMPARE_PER_RUN);

    let comparedCount = 0;
    let createdCount = 0;
    let comparedBestHit = 0;

    const comparedDetails = [];
    const pendingDetails = [];
    const createdDetails = [];

    for (const prediction of maturedCandidates) {
      if (nowTs() - startedAt > SOFT_TIMEOUT_MS) break;

      const result = await comparePrediction(prediction);

      if (result.ok) {
        comparedCount += 1;
        comparedBestHit = Math.max(comparedBestHit, result.bestSingleHit);

        comparedDetails.push({
          prediction_id: result.predictionId,
          source_draw_no: result.sourceDrawNo,
          total_cost: result.compareResult?.total_cost || 0,
          total_reward: result.compareResult?.total_reward || 0,
          profit: result.compareResult?.profit || 0,
          total_hit_count: result.compareResult?.total_hit_count || 0,
          best_single_hit: result.bestSingleHit,
          strategies: Array.isArray(result.compareResult?.groups)
            ? result.compareResult.groups.map((g) => ({
                key: g.key,
                label: g.label,
                total_hit_count: g.total_hit_count,
                total_reward: g.total_reward,
                total_cost: g.total_cost,
                total_profit: g.total_profit,
                payout_rate: g.payout_rate,
                profit_win_rate: g.profit_win_rate,
                roi: g.roi,
                hit2_count: g.hit2_count,
                hit3_count: g.hit3_count,
                hit4_count: g.hit4_count
              }))
            : []
        });
      } else if (result.pending) {
        pendingDetails.push({
          prediction_id: result.predictionId,
          source_draw_no: prediction.source_draw_no,
          message: result.message
        });
      }
    }

    for (let i = 0; i < MAX_CREATE_PER_RUN; i++) {
      if (nowTs() - startedAt > SOFT_TIMEOUT_MS) break;

      const created = await createNextTestPrediction();

      if (created.ok) {
        createdCount += 1;
        createdDetails.push({
          prediction_id: created.created.id,
          source_draw_no: created.created.source_draw_no,
          strategies: created.groups.map((g) => ({
            key: g.key,
            label: g.label,
            nums: g.nums
          }))
        });
      } else {
        if (!created.skipped) {
          createdDetails.push({
            skipped: true,
            message: created.message
          });
        }
        break;
      }
    }

    const leaderboard = await buildLeaderboard(160);

    return res.status(200).json({
      ok: true,
      mode: MODE,
      latest_draw_no: latestDrawNo,
      compare_limit: MAX_COMPARE_PER_RUN,
      create_limit: MAX_CREATE_PER_RUN,
      compared_count: comparedCount,
      created_count: createdCount,
      best_single_hit: comparedBestHit,
      compared_details: comparedDetails,
      pending_details: pendingDetails,
      created_details: createdDetails,
      leaderboard,
      message: `auto-train 完成：到期比對 ${comparedCount} 筆，新建訓練 ${createdCount} 筆`
    });
  } catch (error) {
    console.error('auto-train error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Unknown auto-train error'
    });
  }
}
