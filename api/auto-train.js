import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const MODE = 'v3_auto_loop_test_2period';
const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 2;

// 這裡先用固定成本規則，之後你若有正式投注金額規則，再改這裡就好
const COST_PER_GROUP_PER_PERIOD = 25;

// 只處理少量 prediction，避免 timeout
const MAX_COMPARE_PER_RUN = 2;

// 只建立 1 筆下一期 prediction，避免暴衝
const MAX_CREATE_PER_RUN = 1;

// 逾時保護，避免 function 卡死
const SOFT_TIMEOUT_MS = 8500;

function nowTs() {
  return Date.now();
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sortAsc(nums) {
  return [...nums].map(Number).sort((a, b) => a - b);
}

function uniqueAsc(nums) {
  return [...new Set(nums.map(Number))].sort((a, b) => a - b);
}

function getHitNumbers(predicted, drawNumbers) {
  const drawSet = new Set(drawNumbers.map(Number));
  return predicted.map(Number).filter((n) => drawSet.has(n)).sort((a, b) => a - b);
}

/**
 * 先用可調整的測試版獎金表
 * 之後若你有正式賓果四星玩法的固定對應獎金，再只改這裡
 */
function calcRewardByHitCount(hitCount) {
  if (hitCount >= 4) return 200;
  if (hitCount === 3) return 100;
  if (hitCount === 2) return 20;
  return 0;
}

function parsePredictionGroups(prediction) {
  const raw =
    prediction.prediction_numbers ||
    prediction.prediction ||
    prediction.groups ||
    prediction.number_groups ||
    null;

  if (!raw) return [];

  if (Array.isArray(raw)) {
    // 可能是 [[...], [...]]
    if (Array.isArray(raw[0])) {
      return raw.map((group) => uniqueAsc(group));
    }

    // 可能是單一平面陣列，切成 4 組
    if (typeof raw[0] === 'number') {
      const chunkSize = Math.floor(raw.length / BET_GROUP_COUNT);
      const groups = [];
      for (let i = 0; i < BET_GROUP_COUNT; i++) {
        groups.push(uniqueAsc(raw.slice(i * chunkSize, (i + 1) * chunkSize)));
      }
      return groups.filter((g) => g.length > 0);
    }
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        if (Array.isArray(parsed[0])) {
          return parsed.map((group) => uniqueAsc(group));
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return [];
}

function buildCompareResult({
  sourceDrawNo,
  groups,
  drawRows,
}) {
  const periodResults = [];
  const groupResults = [];

  let totalReward = 0;

  for (let g = 0; g < groups.length; g++) {
    const groupNumbers = uniqueAsc(groups[g]);

    const periodHits = [];
    let hit2 = 0;
    let hit3 = 0;
    let hit4 = 0;
    let groupReward = 0;

    for (const drawRow of drawRows) {
      const period = toInt(drawRow.draw_no);
      const drawNumbers = Array.isArray(drawRow.draw_numbers)
        ? drawRow.draw_numbers.map(Number)
        : [];

      const hitNumbers = getHitNumbers(groupNumbers, drawNumbers);
      const hitCount = hitNumbers.length;
      const reward = calcRewardByHitCount(hitCount);

      if (hitCount === 2) hit2 += 1;
      if (hitCount === 3) hit3 += 1;
      if (hitCount >= 4) hit4 += 1;

      groupReward += reward;

      periodHits.push({
        period,
        hit_numbers: hitNumbers,
        hit_count: hitCount,
        reward,
      });
    }

    totalReward += groupReward;

    groupResults.push({
      group_index: g + 1,
      numbers: groupNumbers,
      period_hits: periodHits,
      stats: {
        hit2,
        hit3,
        hit4,
      },
      group_reward: groupReward,
    });
  }

  for (const drawRow of drawRows) {
    const period = toInt(drawRow.draw_no);

    let reward = 0;
    for (const g of groupResults) {
      const row = g.period_hits.find((p) => p.period === period);
      reward += row ? toInt(row.reward) : 0;
    }

    periodResults.push({
      period,
      reward,
    });
  }

  const totalCost =
    groups.length * drawRows.length * COST_PER_GROUP_PER_PERIOD;

  const profit = totalReward - totalCost;

  const bestSingleHit = Math.max(
    0,
    ...groupResults.flatMap((g) => g.period_hits.map((p) => toInt(p.hit_count)))
  );

  const totalHitCount = groupResults.reduce((sum, g) => {
    return (
      sum +
      g.period_hits.reduce((s, p) => s + toInt(p.hit_count), 0)
    );
  }, 0);

  return {
    mode: '4star_4group_2period',
    source_draw_no: sourceDrawNo,
    total_cost: totalCost,
    period_results: periodResults,
    total_reward: totalReward,
    profit,
    groups: groupResults,
    summary: {
      total_groups: groups.length,
      total_periods: drawRows.length,
      total_hit_count: totalHitCount,
      best_single_hit: bestSingleHit,
    },
  };
}

async function getLatestDrawNo() {
  const { data, error } = await supabase
    .from('draw_history')
    .select('draw_no')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? toInt(data.draw_no) : 0;
}

async function getMaturedPredictions(limitCount) {
  const { data, error } = await supabase
    .from('bingo_predictions')
    .select('*')
    .eq('status', 'created')
    .eq('prediction_type', 'test')
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
    .from('draw_history')
    .select('draw_no, draw_numbers')
    .gte('draw_no', start)
    .lte('draw_no', end)
    .order('draw_no', { ascending: true });

  if (error) throw error;

  const rows = (data || []).filter(
    (r) =>
      Array.isArray(r.draw_numbers) &&
      r.draw_numbers.length > 0
  );

  return rows;
}

async function comparePrediction(prediction) {
  const predictionId = prediction.id;
  const sourceDrawNo = toInt(prediction.source_draw_no);
  const groups = parsePredictionGroups(prediction);

  if (!groups.length) {
    return {
      predictionId,
      ok: false,
      message: 'prediction_numbers 解析失敗',
    };
  }

  const drawRows = await getDrawRowsForPrediction(prediction);

  if (drawRows.length < TARGET_PERIODS) {
    return {
      predictionId,
      ok: false,
      pending: true,
      message: `尚未收齊第 ${sourceDrawNo + 1} 期到第 ${sourceDrawNo + TARGET_PERIODS} 期開獎資料`,
    };
  }

  const compareResult = buildCompareResult({
    sourceDrawNo,
    groups,
    drawRows,
  });

  const hitCount = toInt(compareResult.summary?.total_hit_count || 0);
  const bestSingleHit = toInt(compareResult.summary?.best_single_hit || 0);

  const { error } = await supabase
    .from('bingo_predictions')
    .update({
      status: 'compared',
      compare_status: 'done',
      compared_at: new Date().toISOString(),
      compare_result: compareResult,
      hit_count: hitCount,
      best_single_hit: bestSingleHit,
      updated_at: new Date().toISOString(),
    })
    .eq('id', predictionId);

  if (error) throw error;

  return {
    predictionId,
    ok: true,
    compareResult,
  };
}

function generateTestGroupsFromRecent20(recent20) {
  const numbers = recent20
    .flatMap((row) => (Array.isArray(row.draw_numbers) ? row.draw_numbers : []))
    .map(Number);

  const freq = new Map();
  for (const n of numbers) {
    freq.set(n, (freq.get(n) || 0) + 1);
  }

  const ranked = [...freq.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] - b[0];
    })
    .map(([n]) => n);

  const fallback = [];
  for (let i = 1; i <= 80; i++) fallback.push(i);

  const pool = uniqueAsc([...ranked, ...fallback]);

  // 每組 4 顆，四組
  const groups = [];
  let cursor = 0;
  for (let i = 0; i < BET_GROUP_COUNT; i++) {
    const group = [];
    while (group.length < 4 && cursor < pool.length) {
      const num = pool[cursor++];
      if (!group.includes(num)) group.push(num);
    }
    groups.push(sortAsc(group));
  }

  return groups;
}

async function getRecent20() {
  const { data, error } = await supabase
    .from('draw_history')
    .select('draw_no, draw_numbers')
    .order('draw_no', { ascending: false })
    .limit(20);

  if (error) throw error;
  return data || [];
}

async function findExistingCreatedBySourceDrawNo(sourceDrawNo) {
  const { data, error } = await supabase
    .from('bingo_predictions')
    .select('id')
    .eq('prediction_type', 'test')
    .eq('target_periods', TARGET_PERIODS)
    .eq('source_draw_no', sourceDrawNo)
    .in('status', ['created', 'compared'])
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createNextTestPrediction() {
  const latestDrawNo = await getLatestDrawNo();
  if (!latestDrawNo) {
    return {
      ok: false,
      message: 'draw_history 尚無資料',
    };
  }

  // 新 prediction 的來源期數，就是目前最新期數
  const sourceDrawNo = latestDrawNo;

  const existing = await findExistingCreatedBySourceDrawNo(sourceDrawNo);
  if (existing) {
    return {
      ok: false,
      skipped: true,
      message: `source_draw_no ${sourceDrawNo} 已存在 prediction`,
    };
  }

  const recent20 = await getRecent20();
  if (!recent20.length) {
    return {
      ok: false,
      message: '無 recent20 可建立測試 prediction',
    };
  }

  const groups = generateTestGroupsFromRecent20(recent20);

  const payload = {
    mode: MODE,
    prediction_type: 'test',
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: TARGET_PERIODS,
    prediction_numbers: groups,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('bingo_predictions')
    .insert(payload)
    .select('*')
    .single();

  if (error) throw error;

  return {
    ok: true,
    created: data,
    message: `已建立新測試 prediction，來源第 ${sourceDrawNo} 期`,
  };
}

export default async function handler(req, res) {
  const startedAt = nowTs();

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const latestDrawNo = await getLatestDrawNo();

    const maturedCandidates = await getMaturedPredictions(MAX_COMPARE_PER_RUN);

    let comparedCount = 0;
    let comparedDetails = [];
    let pendingDetails = [];
    let comparedBestHit = 0;

    for (const prediction of maturedCandidates) {
      if (nowTs() - startedAt > SOFT_TIMEOUT_MS) {
        break;
      }

      const result = await comparePrediction(prediction);

      if (result.ok) {
        comparedCount += 1;
        const bestHit = toInt(result.compareResult?.summary?.best_single_hit || 0);
        comparedBestHit = Math.max(comparedBestHit, bestHit);

        comparedDetails.push({
          prediction_id: prediction.id,
          source_draw_no: prediction.source_draw_no,
          total_cost: result.compareResult?.total_cost || 0,
          total_reward: result.compareResult?.total_reward || 0,
          profit: result.compareResult?.profit || 0,
          best_single_hit: bestHit,
        });
      } else if (result.pending) {
        pendingDetails.push({
          prediction_id: prediction.id,
          source_draw_no: prediction.source_draw_no,
          message: result.message,
        });
      }
    }

    let createdCount = 0;
    let createdDetails = [];

    for (let i = 0; i < MAX_CREATE_PER_RUN; i++) {
      if (nowTs() - startedAt > SOFT_TIMEOUT_MS) {
        break;
      }

      const created = await createNextTestPrediction();
      if (created.ok) {
        createdCount += 1;
        createdDetails.push({
          source_draw_no: created.created.source_draw_no,
          prediction_id: created.created.id,
        });
      } else {
        // 已存在就跳過，不當成錯誤
        if (!created.skipped) {
          createdDetails.push({
            skipped: true,
            message: created.message,
          });
        }
        break;
      }
    }

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
      message: `auto-train 完成：到期比對 ${comparedCount} 筆，新建訓練 ${createdCount} 筆`,
    });
  } catch (error) {
    console.error('auto-train error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Unknown auto-train error',
    });
  }
}
