import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { buildBingoV1Strategies } from '../lib/buildBingoV1Strategies.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';
import { buildRecentMarketSignalSnapshot, buildStrategyDecisionFromSnapshot } from '../lib/marketSignalEngine.js';

const API_VERSION = 'auto-train-v15-stale-skip';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const TEST_MODE = 'test';
const FORMAL_MODE = 'formal';
const FORMAL_CANDIDATE_MODE = 'formal_candidate';
const COMPARE_MODES = ['formal_3star']; // 4star disabled

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 1;
const COMPARE_BATCH_LIMIT = 50;
const MARKET_LOOKBACK_LIMIT = 160;
const COST_PER_GROUP_PER_PERIOD = 25;

const MAX_CREATED_PREDICTIONS = 20;
const ALLOW_CREATE_WHEN_EXISTING = true;

// ✅ 三星化：降低 avgHit 門檻（三星理論值0.75，不是1.2）
const DECISION_CONFIG = {
  hardRejectRoi: -0.85,
  hardRejectScore: -400,
  softRejectRoi: -0.65,       // 三星本來就虧，門檻放寬
  minAvgHitPreferred: 0.6,    // 三星理論avg_hit=0.75，0.6以上才算合格
  minRoundsForTrust: 10,      // 需要更多期數才信任
  strongScoreFloor: 80,
  usableScoreFloor: 10
};

const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';
const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';

const PROTECTED_STATUS = new Set(['protected']);
const TERMINAL_STATUS = new Set(['disabled', 'retired']);

const MIN_ACTIVE_STRATEGY = 30;
const TARGET_ACTIVE_STRATEGY = 60;
const MAX_ACTIVE_STRATEGY = 80;
const MAX_SPAWN_PER_RUN = 12;

const SOFT_SHRINK_TRIGGER = MAX_ACTIVE_STRATEGY + 1;
const HARD_SHRINK_TRIGGER = 120;
const EXTREME_SHRINK_TRIGGER = 160;

// ✅ 三星加碼減碼設定 v2（含跳過機制）
const STAR3_SKIP_GROUPS = 0;   // 跳過這期，不压
const STAR3_MIN_GROUPS = 3;    // 低潮期最少压幾組（原本5，降低成本）
const STAR3_DEFAULT_GROUPS = 6; // 預設組數（原本8，改為中等）
const STAR3_MAX_GROUPS = 8;    // 發燙期最大組數
const STAR3_REDUCE_AFTER_NO_HIT2 = 3;  // 連續幾期沒中2就縮組
const STAR3_SKIP_AFTER_NO_HIT2 = 6;    // 連續幾期沒中2就跳過（深度低潮）

const KNOWN_GENES = [
  'hot',
  'cold',
  'warm',
  'zone',
  'tail',
  'mix',
  'repeat',
  'guard',
  'balanced',
  'balance',
  'chase',
  'jump',
  'pattern',
  'structure',
  'split',
  'cluster',
  'gap',
  'spread',
  'rotation',
  'odd',
  'even',
  'reverse',
  'skip'
];

let supabase = null;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE env');
  }

  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });
  }

  return supabase;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function safeArray(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function uniqueSorted(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))]
    .filter((n) => n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseNums(value) {
  if (Array.isArray(value)) {
    return uniqueSorted(value);
  }

  if (typeof value === 'string') {
    return uniqueSorted(
      value
        .replace(/[{}[\]]/g, ' ')
        .split(/[,\s|/]+/)
        .map(Number)
    );
  }

  if (value && typeof value === 'object') {
    return parseNums(
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

function normalizeGroups(groups = []) {
  return (Array.isArray(groups) ? groups : [])
    .map((group, idx) => {
      if (!group || typeof group !== 'object') return null;

      const numsSource = Array.isArray(group.nums)
        ? group.nums
        : Array.isArray(group.numbers)
          ? group.numbers
          : Array.isArray(group.values)
            ? group.values
            : [];

      // ✅ 三星每組3個號碼，四星4個，這裡保留4個是因為 normalizeGroups
      // 也用在四星的 formal/test mode，所以用 slice(0,4) 但允許3個
      // 三星的 groups_json 在存入前已確保只有3個號碼
      const nums = uniqueSorted(numsSource).slice(0, 4);
      if (nums.length < 3) return null;  // ✅ 三星只需要3個，不再要求一定要4個

      const meta = group.meta && typeof group.meta === 'object' ? group.meta : {};

      return {
        key: String(group.key || meta.strategy_key || `group_${idx + 1}`),
        label: String(group.label || meta.strategy_name || `第${idx + 1}組`),
        nums,
        meta: {
          ...meta,
          strategy_key: String(meta.strategy_key || group.key || `group_${idx + 1}`),
          strategy_name: String(meta.strategy_name || group.label || `第${idx + 1}組`)
        }
      };
    })
    .filter(Boolean);
}

function buildGroupPriorityTuple(group = {}) {
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};

  return [
    Math.max(
      toNum(meta.recent_50_hit_rate, 0),
      toNum(meta.hit2_rate, 0)
    ),
    Math.max(
      toNum(meta.recent_50_roi, -999),
      toNum(meta.roi, -999)
    ),
    Math.max(
      toNum(meta.recent_50_hit3_rate, 0),
      toNum(meta.hit3_rate, 0)
    ),
    toNum(meta.score, 0),
    toNum(meta.decision_score, 0),
    toNum(meta.market_boost, 1) - 1,
    -toNum(meta.selection_rank, 999)
  ];
}

function compareGroupPriorityDesc(a, b) {
  const aTuple = buildGroupPriorityTuple(a);
  const bTuple = buildGroupPriorityTuple(b);
  const size = Math.max(aTuple.length, bTuple.length);

  for (let i = 0; i < size; i += 1) {
    const diff = toNum(bTuple[i], 0) - toNum(aTuple[i], 0);
    if (diff !== 0) return diff;
  }

  return String(a?.key || a?.meta?.strategy_key || '').localeCompare(
    String(b?.key || b?.meta?.strategy_key || '')
  );
}

function sortGroupsForInstantCandidate(groups = []) {
  return normalizeGroups(groups).sort(compareGroupPriorityDesc);
}

function getPhaseRoleTargets(marketPhase = '') {
  const phase = String(marketPhase || '').toLowerCase();

  if (phase === 'continuation') return ['attack', 'attack', 'extend', 'guard'];
  if (phase === 'bias') return ['attack', 'attack', 'guard', 'extend'];
  if (phase === 'hot_bias') return ['attack', 'attack', 'attack', 'extend'];  // ✅ 熱區偏移：三攻一延伸
  if (phase === 'hot_streak') return ['attack', 'attack', 'attack', 'guard'];  // ✅ 熱號爆發：三攻一守
  if (phase === 'chaos') return ['guard', 'guard', 'extend', 'recent'];
  return ['guard', 'extend', 'extend', 'attack'];
}

function buildMarketPhase(snapshot = {}) {
  const streak2 = uniqueSorted(snapshot?.streak2 || snapshot?.streaks?.streak2 || []);
  const streak3 = uniqueSorted(snapshot?.streak3 || snapshot?.streaks?.streak3 || []);
  const streak4 = uniqueSorted(snapshot?.streak4 || snapshot?.streaks?.streak4 || []);
  const hot5 = uniqueSorted(snapshot?.hot_windows?.hot_5?.numbers || snapshot?.hot_5_numbers || []);
  const latest = uniqueSorted(snapshot?.latest_numbers || snapshot?.latest || []);
  const gap = uniqueSorted(snapshot?.gap_numbers || snapshot?.gap || []);
  const cold = uniqueSorted(snapshot?.cold_numbers || snapshot?.cold || []);

  const latestOverlapHot5 = latest.filter((n) => hot5.includes(n)).length;
  const zoneFreq = snapshot?.zone_freq || snapshot?.zoneFreq || {};
  const tailFreq = snapshot?.tail_freq || snapshot?.tailFreq || {};
  const zoneValues = Object.values(zoneFreq).map((v) => toNum(v, 0)).filter((v) => v > 0);
  const tailValues = Object.values(tailFreq).map((v) => toNum(v, 0)).filter((v) => v > 0);
  const avgZone = zoneValues.length ? zoneValues.reduce((a, b) => a + b, 0) / zoneValues.length : 1;
  const avgTail = tailValues.length ? tailValues.reduce((a, b) => a + b, 0) / tailValues.length : 1;
  const maxZone = zoneValues.length ? Math.max(...zoneValues) : 1;
  const maxTail = tailValues.length ? Math.max(...tailValues) : 1;
  const zoneBias = avgZone > 0 ? maxZone / avgZone : 1;
  const tailBias = avgTail > 0 ? maxTail / avgTail : 1;
  const recentRepeatRatio = toNum(snapshot?.recent_repeat_ratio, 0);

  let continuationScore =
    streak3.length * 2 +
    streak4.length * 4 +
    latestOverlapHot5 * 1.2 +
    recentRepeatRatio * 6;

  let rotationScore =
    gap.length * 1.2 +
    cold.length * 0.8 +
    streak2.length * 0.2 -
    streak3.length * 1.5 -
    latestOverlapHot5 * 1.0;

  const biasScore =
    zoneBias * 6 +
    tailBias * 5 +
    Math.max(0, latestOverlapHot5 - 1) * 0.35;

  const chaosScore =
    10 -
    streak3.length * 1.4 -
    streak4.length * 2.2 -
    latestOverlapHot5 * 0.8 -
    Math.max(0, zoneBias - 1) * 1.5;

  if (gap.length > 12) {
    continuationScore *= 0.6;
  }

  const marketPhaseScore = {
    continuation: round4(continuationScore),
    rotation: round4(rotationScore),
    bias: round4(biasScore),
    chaos: round4(chaosScore)
  };

  const sorted = Object.entries(marketPhaseScore).sort((a, b) => toNum(b[1], 0) - toNum(a[1], 0));
  const marketPhase = sorted[0]?.[0] || 'rotation';
  const topScore = toNum(sorted[0]?.[1], 0);
  const secondScore = toNum(sorted[1]?.[1], 0);
  const marketPhaseConfidence = round4((topScore - secondScore) / (Math.abs(topScore) + 0.001));

  return {
    market_phase: marketPhase,
    market_phase_score: marketPhaseScore,
    market_phase_confidence: marketPhaseConfidence,
    market_phase_features: {
      streak2_count: streak2.length,
      streak3_count: streak3.length,
      streak4_count: streak4.length,
      latest_overlap_hot5: latestOverlapHot5,
      zone_bias: round4(zoneBias),
      tail_bias: round4(tailBias),
      gap_count: gap.length,
      cold_count: cold.length,
      recent_repeat_ratio: round4(recentRepeatRatio)
    }
  };
}

function enrichMarketSnapshotWithPhase(marketSnapshot = {}, market = {}) {
  // ✅ 從 recent20 計算 streak（連續出現號碼）
  const recent20Rows = market?.recent20 || [];
  const streakMap = new Map();
  for (let n = 1; n <= 80; n++) streakMap.set(n, 0);
  for (let i = 0; i < recent20Rows.length; i++) {
    const nums = recent20Rows[i]?.numbers || [];
    for (const n of nums) {
      if (streakMap.get(n) === i) streakMap.set(n, i + 1);
    }
  }
  const streak2 = [], streak3 = [], streak4 = [];
  for (const [n, s] of streakMap.entries()) {
    if (s >= 4) { streak4.push(n); streak3.push(n); streak2.push(n); }
    else if (s >= 3) { streak3.push(n); streak2.push(n); }
    else if (s >= 2) { streak2.push(n); }
  }

  // ✅ 計算 recent_repeat_ratio（最新一期與前5期的號碼重複率）
  const latest = market?.latest || [];
  const prev5Nums = new Set((recent20Rows.slice(1, 6) || []).flatMap(r => r?.numbers || []));
  const recentRepeatRatio = latest.length > 0
    ? latest.filter(n => prev5Nums.has(n)).length / latest.length
    : 0;

  const snapshot = {
    ...(marketSnapshot || {}),
    latest_numbers: uniqueSorted(market?.latest || marketSnapshot?.latest_numbers || []),
    hot_5_numbers: uniqueSorted(
      marketSnapshot?.hot_windows?.hot_5?.numbers || marketSnapshot?.hot_5_numbers || (market?.hot || []).slice(0, 5)
    ),
    hot_10_numbers: uniqueSorted(
      marketSnapshot?.hot_windows?.hot_10?.numbers || marketSnapshot?.hot_10_numbers || (market?.hot || []).slice(0, 10)
    ),
    hot_20_numbers: uniqueSorted(
      marketSnapshot?.hot_windows?.hot_20?.numbers || marketSnapshot?.hot_20_numbers || (market?.hot || []).slice(0, 20)
    ),
    gap_numbers: uniqueSorted((market?.gap || marketSnapshot?.gap_numbers || []).slice(0, 15)),
    cold_numbers: uniqueSorted((market?.cold || marketSnapshot?.cold_numbers || []).slice(0, 15)),
    zone_freq: Object.fromEntries(Array.from((market?.zoneFreq20 || marketSnapshot?.zone_freq || new Map()).entries?.() || [])),
    tail_freq: Object.fromEntries(Array.from((market?.tailFreq20 || marketSnapshot?.tail_freq || new Map()).entries?.() || [])),
    // ✅ 加入 streak 和 repeat_ratio
    streak2: uniqueSorted(streak2),
    streak3: uniqueSorted(streak3),
    streak4: uniqueSorted(streak4),
    recent_repeat_ratio: recentRepeatRatio
  };

  const phaseInfo = buildMarketPhase(snapshot);
  // ✅ 關鍵修復：如果 marketSnapshot 已有 buildRecentMarketSignalSnapshot 算好的 market_phase，優先保留它
  // buildMarketPhase 的 rotationScore 永遠偏高（gap/cold 問題），不如 marketSignalEngine 的判斷準確
  // ✅ fix：marketSignalEngine 的結果永遠優先
  // 原邏輯：rotation 就 fallback 到 buildMarketPhase，導致步驟六完全沒用
  // 新邏輯：只要 marketSignalEngine 有算出來就用，buildMarketPhase 只在完全沒資料時才用
  const finalMarketPhase = marketSnapshot?.market_phase || phaseInfo.market_phase;
  console.log('[enrichMarketSnapshot] marketSignalPhase:', marketSnapshot?.market_phase, '→ final:', finalMarketPhase, 'streak3:', streak3.length);
  return {
    ...snapshot,
    ...phaseInfo,
    market_phase: finalMarketPhase  // ✅ 確保不被覆蓋
  };
}

// ============================================================
// ✅ 新增：fetch3starBettingState
// 讀取近期三星比對結果，決定本期出幾組（5~8）
// 規則：
//   - 連續3期沒中2（best_hit < 2）→ 縮到 STAR3_MIN_GROUPS（5組）
//   - 連續有中2（best_hit >= 2）→ 維持/加到 STAR3_MAX_GROUPS（8組）
//   - 中3後 → 維持 STAR3_MAX_GROUPS（8組）
//   - 資料不足 → 預設 STAR3_DEFAULT_GROUPS（8組）
// ============================================================
async function fetch3starBettingState(db) {
  try {
    // 取最近 10 筆已比對完成的三星預測
    const { data: recentCompared } = await db
      .from(PREDICTIONS_TABLE)
      .select('hit_count, compare_result_json, verdict, compared_at')
      .eq('mode', 'formal_3star')
      .eq('compare_status', 'done')
      .order('compared_at', { ascending: false })
      .limit(10);

    if (!Array.isArray(recentCompared) || recentCompared.length === 0) {
      return {
        groupCount: STAR3_DEFAULT_GROUPS,
        reason: 'no_history',
        consecutiveNoHit2: 0,
        lastHit3: false
      };
    }

    // ✅ 跨天保護：若最新一筆比對記錄是昨天（或更早）的，重置計數器
    // 避免前一天收盤前的低潮卡住今天開盤
    const latestComparedAt = recentCompared[0]?.compared_at;
    if (latestComparedAt) {
      const now = new Date();
      const latestDate = new Date(latestComparedAt);
      const nowTaipei = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const latestTaipei = new Date(latestDate.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const isYesterday = nowTaipei.toDateString() !== latestTaipei.toDateString();
      if (isYesterday) {
        console.log(`[3star BettingState] 跨天保護觸發：最新記錄來自 ${latestTaipei.toDateString()}，今天重置計數器`);
        return {
          groupCount: STAR3_DEFAULT_GROUPS,
          reason: 'cross_day_reset',
          consecutiveNoHit2: 0,
          consecutiveHit2: 0,
          lastHit3: false
        };
      }
    }

    // 從每筆記錄中取出 best_hit（每期所有組裡最高中幾個）
    const recentBestHits = recentCompared.map(row => {
      // compare_result_json 可能是 string（Supabase text欄位）或已解析的 object
      const raw = row.compare_result_json;
      const result = raw && typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
      // 優先用 best_hit，沒有就 fallback 到 hit_count（整筆最高）
      const bestHit = toNum(result?.best_hit ?? row.hit_count, 0);
      return bestHit;
    });

    // 計算連續沒中2的期數（從最近往前算）
    let consecutiveNoHit2 = 0;
    for (const hit of recentBestHits) {
      if (hit < 2) {
        consecutiveNoHit2 += 1;
      } else {
        break; // 只要有一期中2就停止
      }
    }

    // 最近一期有沒有中3
    const lastHit3 = recentBestHits[0] >= 3;

    // 最近連續中2的期數（從最近往前算）
    let consecutiveHit2 = 0;
    for (const hit of recentBestHits) {
      if (hit >= 2) {
        consecutiveHit2 += 1;
      } else {
        break;
      }
    }

    let groupCount;
    let reason;

    if (consecutiveNoHit2 >= STAR3_SKIP_AFTER_NO_HIT2) {
      // 連續6期以上沒中2 → 深度低潮，跳過這期，節省成本
      groupCount = STAR3_SKIP_GROUPS;
      reason = `skip_deep_slump_${consecutiveNoHit2}_periods`;
    } else if (lastHit3) {
      // 中3後維持最大組數繼續追
      groupCount = STAR3_MAX_GROUPS;
      reason = 'hit3_maintain_max';
    } else if (consecutiveHit2 >= 2 && consecutiveHit2 <= 4) {
      // 連續2~4期中2 → 加碼追中3
      groupCount = STAR3_MAX_GROUPS;
      reason = `consecutive_hit2_${consecutiveHit2}_boost_to_${STAR3_MAX_GROUPS}`;
    } else if (consecutiveHit2 > 4) {
      // 連續中2超過4期卻沒中3 → 原地踏，維持預設組數即可
      groupCount = STAR3_DEFAULT_GROUPS;
      reason = `hit2_plateau_${consecutiveHit2}_maintain_default`;
    } else if (consecutiveHit2 >= 1) {
      // 剛中一次2 → 維持正常組數
      groupCount = STAR3_DEFAULT_GROUPS;
      reason = 'hit2_maintain';
    } else if (consecutiveNoHit2 >= STAR3_REDUCE_AFTER_NO_HIT2) {
      // 連續3~5期沒中2 → 縮組省成本
      groupCount = STAR3_MIN_GROUPS;
      reason = `consecutive_no_hit2_${consecutiveNoHit2}_reduce_to_${STAR3_MIN_GROUPS}`;
    } else {
      // 其他情況（1~2期沒中2）→ 維持預設
      groupCount = STAR3_DEFAULT_GROUPS;
      reason = 'default';
    }

    console.log(
      `[3star BettingState] groupCount=${groupCount} reason=${reason}`,
      `consecutiveNoHit2=${consecutiveNoHit2} consecutiveHit2=${consecutiveHit2} lastHit3=${lastHit3}`
    );

    return {
      groupCount,
      reason,
      consecutiveNoHit2,
      consecutiveHit2,
      lastHit3,
      recentBestHits: recentBestHits.slice(0, 5) // 只回傳最近5筆供 log 參考
    };
  } catch (err) {
    console.warn('[fetch3starBettingState] failed:', err.message);
    // 出錯時保守回預設
    return {
      groupCount: STAR3_DEFAULT_GROUPS,
      reason: 'error_fallback',
      consecutiveNoHit2: 0,
      lastHit3: false
    };
  }
}

function buildInstantFormalCandidateGroups(groups = [], marketSnapshot = {}) {
  const normalized = sortGroupsForInstantCandidate(groups).slice(0, 60);
  if (normalized.length < 4) return [];

  const byStrategy = [];
  const seenStrategy = new Set();

  for (const group of normalized) {
    const strategyKey = String(group?.meta?.strategy_key || group?.key || '').trim();
    if (!strategyKey) continue;
    if (seenStrategy.has(strategyKey)) continue;
    seenStrategy.add(strategyKey);
    byStrategy.push(group);
  }

  if (byStrategy.length < 4) return [];

  const getHit2 = (group) =>
    Math.max(
      toNum(group?.meta?.recent_50_hit_rate, 0),
      toNum(group?.meta?.hit2_rate, 0)
    );

  const getHit3 = (group) =>
    Math.max(
      toNum(group?.meta?.recent_50_hit3_rate, 0),
      toNum(group?.meta?.hit3_rate, 0)
    );

  const getRoi = (group) =>
    Math.max(
      toNum(group?.meta?.recent_50_roi, Number.NEGATIVE_INFINITY),
      toNum(group?.meta?.roi, Number.NEGATIVE_INFINITY)
    );

  const getScore = (group) =>
    Math.max(
      toNum(group?.meta?.decision_score, Number.NEGATIVE_INFINITY),
      toNum(group?.meta?.score, Number.NEGATIVE_INFINITY)
    );

  const classifyRole = (group) => {
    const hit2 = getHit2(group);
    const hit3 = getHit3(group);
    const roi = getRoi(group);

    if (hit2 >= 0.28 && roi >= -0.4) return 'guard';
    if (hit2 >= 0.24 && roi >= -0.55) return 'extend';
    if (hit3 >= 0.05 && hit2 >= 0.22) return 'attack';

    return 'reject';
  };

  const scoreGuard = (group) => {
    const hit2 = getHit2(group);
    const hit3 = getHit3(group);
    const roi = getRoi(group);
    const score = getScore(group);
    return hit2 * 1000 + roi * 120 - hit3 * 120 + score * 0.001;
  };

  const scoreExtend = (group) => {
    const hit2 = getHit2(group);
    const hit3 = getHit3(group);
    const roi = getRoi(group);
    const score = getScore(group);
    return hit2 * 1200 + roi * 120 + hit3 * 30 + score * 0.001;
  };

  const scoreAttack = (group) => {
    const hit2 = getHit2(group);
    const hit3 = getHit3(group);
    const roi = getRoi(group);
    const score = getScore(group);
    return hit3 * 1200 + hit2 * 250 + roi * 80 + score * 0.001;
  };

  const guardPool = [];
  const extendPool = [];
  const attackPool = [];

  for (const group of byStrategy) {
    const role = classifyRole(group);
    if (role === 'guard') {
      guardPool.push(group);
      extendPool.push(group);
      continue;
    }
    if (role === 'extend') {
      extendPool.push(group);
      continue;
    }
    if (role === 'attack') {
      attackPool.push(group);
    }
  }

  guardPool.sort((a, b) => scoreGuard(b) - scoreGuard(a));
  extendPool.sort((a, b) => scoreExtend(b) - scoreExtend(a));
  attackPool.sort((a, b) => scoreAttack(b) - scoreAttack(a));

  const used = new Set();

  const pickUnique = (pool) => {
    for (const group of pool) {
      const strategyKey = String(group?.meta?.strategy_key || group?.key || '').trim();
      if (!strategyKey) continue;
      if (used.has(strategyKey)) continue;
      used.add(strategyKey);
      return group;
    }
    return null;
  };

  const phaseRoles = getPhaseRoleTargets(marketSnapshot?.market_phase);
  const rolePickers = {
    attack: () => pickUnique(attackPool) || pickUnique(extendPool) || pickUnique(guardPool),
    extend: () => pickUnique(extendPool) || pickUnique(guardPool) || pickUnique(attackPool),
    guard: () => pickUnique(guardPool) || pickUnique(extendPool) || pickUnique(attackPool),
    recent: () => pickUnique(extendPool) || pickUnique(attackPool) || pickUnique(guardPool)
  };

  const result = [];
  for (const role of phaseRoles) {
    if (result.length >= 4) break;
    const picker = rolePickers[role] || rolePickers.extend;
    const group = picker();
    if (group) result.push(group);
  }

  while (result.length < 4) {
    const remaining = byStrategy.find(
      (g) => !used.has(String(g?.meta?.strategy_key || g?.key || '').trim())
    );
    if (!remaining) break;
    const strategyKey = String(remaining?.meta?.strategy_key || remaining?.key || '').trim();
    used.add(strategyKey);
    result.push(remaining);
  }

  return result;
}

async function upsertFormalCandidateFromTest(db, predictionRow) {
  if (!predictionRow?.id || !predictionRow?.groups_json) return null;

  const mode = String(predictionRow?.mode || '').trim().toLowerCase();
  // v4: accept 'direct' mode for 3star when 4star is disabled
  if (mode !== TEST_MODE && mode !== 'direct') return null;

  const sourceDrawNo = toNum(predictionRow?.source_draw_no, 0);
  if (!sourceDrawNo) return null;

  const groups = safeArray(predictionRow?.groups_json);
  if (!groups.length) return null;

  const marketSnapshot = predictionRow?.market_snapshot_json || {};

  const finalGroupsRaw = buildInstantFormalCandidateGroups(groups, marketSnapshot);

  let finalGroups = [];
  let fallbackMode = '';

  if (finalGroupsRaw.length >= 4) {
    finalGroups = finalGroupsRaw.slice(0, 4).map((g, idx) => ({
      ...g,
      meta: {
        ...(g.meta || {}),
        slot_no: idx + 1,
        preferred_role: idx === 0 ? 'guard' : idx === 1 ? 'extend' : idx === 2 ? 'attack' : 'recent',
        focus_mode: 'phase_role'
      }
    }));
  } else {
    const normalized = normalizeGroups(groups);

    let base;
    if (normalized.length >= 4) {
      base = normalized;
      fallbackMode = 'fallback_normalized';
    } else {
      base = normalized;
      fallbackMode = 'fallback_raw';
    }

    const deduped = [];
    const seenKeys = new Set();

    for (const g of base) {
      const key = String(g?.meta?.strategy_key || g?.key || '').trim();
      if (key && seenKeys.has(key)) continue;
      if (key) seenKeys.add(key);
      deduped.push(g);
      if (deduped.length >= 4) break;
    }

    const fallback = deduped.slice(0, 4);

    if (fallback.length === 4) {
      finalGroups = fallback.map((g, idx) => ({
        ...g,
        meta: {
          ...(g.meta || {}),
          slot_no: idx + 1,
          preferred_role: idx === 0 ? 'guard' : (idx < 3 ? 'extend' : 'attack_blocked'),
          focus_mode: fallbackMode
        }
      }));
    } else {
      return null;
    }
  }

  const nowIso = new Date().toISOString();

  const candidatePayload = {
    mode: FORMAL_CANDIDATE_MODE,
    status: 'ready',
    source_draw_no: sourceDrawNo,
    target_periods: TARGET_PERIODS,
    groups_json: finalGroups,
    compare_status: 'candidate',
    compare_result: null,
    compare_result_json: null,
    hit_count: 0,
    verdict: null,
    latest_draw_numbers: predictionRow.latest_draw_numbers || null,
    market_snapshot_json: predictionRow.market_snapshot_json || null,
    created_at: nowIso
  };

  const { data: existingCandidate, error: existingCandidateError } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', FORMAL_CANDIDATE_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingCandidateError) throw existingCandidateError;

  let candidateRow = null;

  if (existingCandidate?.id) {
    const { data: updatedCandidate, error: updateCandidateError } = await db
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'ready',
        groups_json: finalGroups,
        compare_status: 'candidate',
        compare_result: null,
        compare_result_json: null,
        hit_count: 0,
        verdict: null,
        latest_draw_numbers: predictionRow.latest_draw_numbers || null,
        market_snapshot_json: predictionRow.market_snapshot_json || null
      })
      .eq('id', existingCandidate.id)
      .select('*')
      .maybeSingle();

    if (updateCandidateError) throw updateCandidateError;
    candidateRow = updatedCandidate || existingCandidate;
  } else {
    const { data: insertedCandidate, error: insertCandidateError } = await db
      .from(PREDICTIONS_TABLE)
      .insert(candidatePayload)
      .select('*')
      .maybeSingle();

    if (insertCandidateError) throw insertCandidateError;
    candidateRow = insertedCandidate || null;
  }

  const formalPayload = {
    mode: FORMAL_MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: TARGET_PERIODS,
    groups_json: finalGroups,
    compare_status: 'pending',
    compare_result: null,
    compare_result_json: null,
    hit_count: 0,
    verdict: null,
    latest_draw_numbers: predictionRow.latest_draw_numbers || null,
    market_snapshot_json: predictionRow.market_snapshot_json || null,
    created_at: nowIso
  };

  const { data: existingFormal, error: existingFormalError } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', FORMAL_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingFormalError) throw existingFormalError;

  if (existingFormal?.id) {
    const { error: updateFormalError } = await db
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'created',
        groups_json: finalGroups,
        compare_status: 'pending',
        compare_result: null,
        compare_result_json: null,
        hit_count: 0,
        verdict: null,
        latest_draw_numbers: predictionRow.latest_draw_numbers || null,
        market_snapshot_json: predictionRow.market_snapshot_json || null
      })
      .eq('id', existingFormal.id);

    if (updateFormalError) throw updateFormalError;
  } else {
    const { error: insertFormalError } = await db
      .from(PREDICTIONS_TABLE)
      .insert(formalPayload);

    if (insertFormalError) throw insertFormalError;
  }

  // v4: call independent 3star function
  await create3StarPrediction(db, sourceDrawNo, marketSnapshot);

  return candidateRow;
}


async function create3StarPrediction(db, sourceDrawNo, marketSnapshot) {
  if (!sourceDrawNo) return;
  // ===== ✅ 真三星預測（市場感知版 + 動態加碼/減碼）=====
  try {
    const nowIso = new Date().toISOString();
    const check3star = await db
      .from(PREDICTIONS_TABLE)
      .select('id')
      .eq('mode', 'formal_3star')
      .eq('source_draw_no', sourceDrawNo)
      .maybeSingle();

    if (!check3star?.data?.id) {
      const marketRows = await db
        .from(DRAWS_TABLE)
        .select('*')
        .order('draw_no', { ascending: false })
        .limit(MARKET_LOOKBACK_LIMIT);

      // ✅ 動態加碼/減碼：讀取近期三星命中狀態，決定本期出幾組
      const bettingState = await fetch3starBettingState(db);
      const dynamicGroupCount = bettingState.groupCount;

      // ✅ v2 跳過機制：深度低潮時 groupCount=0，不建立三星預測，但繼續其他流程
      if (dynamicGroupCount === STAR3_SKIP_GROUPS) {
        console.log(`[3star] 跳過本期：${bettingState.reason}，深度低潮 consecutiveNoHit2=${bettingState.consecutiveNoHit2}，不建立預測`);
      } else {

      // ✅ 從 strategy_pool 取所有 active 策略（和四星一樣動態競爭）
      const poolRows3star = await db
        .from(STRATEGY_POOL_TABLE)
        .select('strategy_key, strategy_name, status, protected_rank')
        .eq('status', 'active')
        .order('updated_at', { ascending: false });

      const activeKeys3star = (poolRows3star?.data || [])
        .map(r => r.strategy_key)
        .filter(Boolean);

      // ✅ v10：從 strategy_stats 改用 strategy_name 為主鍵查詢
      // HOT|mix_gap 和 COLD|mix_gap 各自有獨立統計，梯隊真正按含前綴名稱競爭
      const statsRows3star = await db
        .from(STRATEGY_STATS_TABLE)
        .select('strategy_name, strategy_key, recent_hits, hit3, hit2, total_rounds, avg_coverage_hit, recent_coverage_hits, recent_coverage_hit_rate');

      // v4: active strategy_key 相關記錄 + 沒有stats的空記錄也加入競爭
      const activeKeySet3star = new Set(activeKeys3star);
      const statsKeySet = new Set((statsRows3star?.data || []).map(r => r.strategy_key).filter(Boolean));
      // 有stats的保留
      const filteredStats3star = (statsRows3star?.data || []).filter(r =>
        activeKeySet3star.has(r.strategy_key) && r.strategy_name
      );
      // 沒有stats的active策略，補一筆預設空記錄，讓它們也能參與競爭
      for (const key of activeKeys3star) {
        if (!statsKeySet.has(key)) {
          filteredStats3star.push({
            strategy_key: key,
            strategy_name: key,
            recent_hits: [],
            hit3: 0,
            hit2: 0,
            total_rounds: 0,
            avg_coverage_hit: 0,
            recent_coverage_hits: [],
            recent_coverage_hit_rate: 0
          });
        }
      }

      // ✅ 計算每個策略的綜合分數
      // 【方向一】縮短評分窗口到近30期：不讓1000期歷史稀釋近期表現
      // 【方向二】動態冷熱切換：近期熱策略優先，冷策略暫時降權
      const statsMap3star = new Map();
      filteredStats3star.forEach(row => {
        const recentHits = Array.isArray(row.recent_hits) ? row.recent_hits : [];
        const totalRounds = toNum(row.total_rounds, 0);
        const hit3 = toNum(row.hit3, 0);
        const hit2 = toNum(row.hit2, 0);

        // 【方向一】只看最近30期，不看全期累積
        const last30Hits = recentHits.slice(-30);
        // ✅ v11：近期窗口從10期改為5期，快速反應梯隊切換
        const last5Hits = recentHits.slice(-5);

        const last30Hit3Count = last30Hits.filter(h => toNum(h, 0) >= 3).length;
        const last30Hit2Count = last30Hits.filter(h => toNum(h, 0) >= 2).length;
        const last5Hit3Count = last5Hits.filter(h => toNum(h, 0) >= 3).length;
        const last5Hit2Count = last5Hits.filter(h => toNum(h, 0) >= 2).length;

        const last30Hit3Rate = last30Hits.length > 0 ? last30Hit3Count / last30Hits.length : 0;
        const last30Hit2Rate = last30Hits.length > 0 ? last30Hit2Count / last30Hits.length : 0;
        const last5Hit3Rate = last5Hits.length > 0 ? last5Hit3Count / last5Hits.length : 0;
        const last5Hit2Rate = last5Hits.length > 0 ? last5Hit2Count / last5Hits.length : 0;

        // 全期數據只作保底參考（權重很低）
        const allHit3Rate = totalRounds > 0 ? hit3 / totalRounds : 0;
        const allHit2Rate = totalRounds > 0 ? hit2 / totalRounds : 0;

        // ✅ v11：近30期60% + 全期20% + 近5期20%
        const isHot = last5Hit3Rate >= 0.02 || last5Hit2Rate >= 0.25;
        const isTrulyBad = allHit3Rate < 0.005 && last30Hit3Rate <= 0 && last30Hit2Rate < 0.05;
        const hotBoost = isHot ? 1.5 : isTrulyBad ? 0.3 : 1.0;

        const recentCoverageHits = Array.isArray(row.recent_coverage_hits) ? row.recent_coverage_hits : [];
        const last5CoverageHits = recentCoverageHits.slice(-5);
        const avgRecentCoverage = last5CoverageHits.length > 0
          ? last5CoverageHits.reduce((a, b) => a + toNum(b, 0), 0) / last5CoverageHits.length
          : toNum(row.avg_coverage_hit, 3);

        const coverageScore = avgRecentCoverage > 6 ? (avgRecentCoverage - 6) * 8 : 0;

        const effectiveHit3Rate = last30Hits.length >= 5
          ? last30Hit3Rate * 0.6 + allHit3Rate * 0.2 + last5Hit3Rate * 0.2
          : allHit3Rate;
        const effectiveHit2Rate = last30Hits.length >= 5
          ? last30Hit2Rate * 0.6 + allHit2Rate * 0.2 + last5Hit2Rate * 0.2
          : allHit2Rate;

        const hit3Score = effectiveHit3Rate * 60;
        const hit2Score = effectiveHit2Rate * 40;

        // ✅ v10：用 strategy_name（含前綴）為 Map key
        statsMap3star.set(row.strategy_name, {
          strategy_key: row.strategy_key,
          score: (hit3Score + hit2Score + coverageScore) * hotBoost,
          hit3Rate: effectiveHit3Rate,
          hit2Rate: effectiveHit2Rate,
          avgCoverageHit: avgRecentCoverage,
          totalRounds,
          isHot,
          isCold: isTrulyBad
        });
      });

      // 【方向三】號碼頻率直接選號：計算最近20期每個號碼的出現頻率
      // 高頻號碼組成「熱區號碼池」，選號時優先從這個池子裡選
      const recentDrawsForFreq = (marketRows.data || []).slice(0, 20);
      const numFreqMap = new Map();
      for (let n = 1; n <= 80; n++) numFreqMap.set(n, 0);
      recentDrawsForFreq.forEach(row => {
        const nums = parseNums(row?.numbers || row?.draw_numbers || []);
        nums.forEach(n => numFreqMap.set(n, (numFreqMap.get(n) || 0) + 1));
      });
      // 出現頻率高於平均值(20*20/80=5次)的號碼列為熱區
      const hotFreqNums = [...numFreqMap.entries()]
        .filter(([, freq]) => freq >= 6)
        .sort((a, b) => b[1] - a[1])
        .map(([n]) => n);
      // 出現頻率低於2次的列為冷號（可能即將補出）
      const coldFreqNums = [...numFreqMap.entries()]
        .filter(([, freq]) => freq <= 2)
        .sort((a, b) => a[1] - b[1])
        .map(([n]) => n);

      console.log('[3star] 熱區號碼(近20期高頻):', hotFreqNums.slice(0, 10).join(','));
      console.log('[3star] 冷號(近20期低頻):', coldFreqNums.slice(0, 10).join(','));

      // ✅ v13：三層篩選機制
      const allStrategyData = filteredStats3star.map(row => {
        const recentHits = Array.isArray(row?.recent_hits) ? row.recent_hits : [];
        const totalRounds = toNum(row?.total_rounds, 0);
        const hit3 = toNum(row?.hit3, 0);
        const allHit3Rate = totalRounds > 0 ? hit3 / totalRounds : 0;

        const last5Hits = recentHits.slice(-5);
        const last5Hit3Count = last5Hits.filter(h => toNum(h, 0) >= 3).length;
        const last5Hit3Rate = last5Hits.length > 0 ? last5Hit3Count / last5Hits.length : 0;

        const last30Hits = recentHits.slice(-30);
        const last30Hit3Count = last30Hits.filter(h => toNum(h, 0) >= 3).length;
        const last30Hit3Rate = last30Hits.length > 0 ? last30Hit3Count / last30Hits.length : 0;

        const hasRecentHit3 = last5Hit3Count > 0;

        // ✅ v13：退役（累積≥100期且全期中3=0）→ 完全不出場
        const isRetired = totalRounds >= 100 && hit3 === 0;

        // ✅ v13：冷板凳（累積≥50期且全期中3=0）→ 排名最後
        const isBench = !isRetired && totalRounds >= 50 && hit3 === 0;

        // ✅ v13：熱身加速（近5期中3≥2次）→ 強制第一梯隊
        const isOnFire = last5Hit3Count >= 2;

        return {
          key: row.strategy_name,
          strategy_key: row.strategy_key,
          allHit3Rate,
          last10Hit3Rate: last5Hit3Rate,
          last10Hit3Count: last5Hit3Count,
          last30Hit3Rate,
          totalRounds,
          hasRecentHit3,
          isRetired,
          isBench,
          isOnFire
        };
      })
      // ✅ v13：退役策略完全過濾掉
      .filter(s => !s.isRetired);

      // ✅ v13：期數加權排名，冷板凳策略分數強制最低
      function calcRankScore(s) {
        // 冷板凳策略排名最後
        if (s.isBench) return -999;
        const rounds = s.totalRounds;
        if (rounds < 30) {
          return s.allHit3Rate * 0.9 + s.last10Hit3Rate * 0.1;
        } else if (rounds < 100) {
          return s.allHit3Rate * 0.7 + s.last10Hit3Rate * 0.3;
        } else {
          return s.allHit3Rate * 0.4 + s.last30Hit3Rate * 0.3 + s.last10Hit3Rate * 0.3;
        }
      }

      // Step 2：按加權分數排序
      const sortedByAll = [...allStrategyData]
        .sort((a, b) => calcRankScore(b) - calcRankScore(a));

      // ✅ v13：熱身加速策略（近5期中3≥2次）強制進第一梯隊
      const onFireStrategies = allStrategyData.filter(s => s.isOnFire && !s.isBench);

      // Step 3：第一梯隊候選
      const tier1 = [...onFireStrategies]; // 先放入熱身加速策略
      const tier2 = [];
      const tier3 = [];  // 排名10名以外的策略

      for (const s of sortedByAll) {
        // ✅ v13：熱身加速策略已在tier1，跳過
        if (onFireStrategies.some(f => f.key === s.key)) continue;
        if (tier1.length + tier2.length < 10) {
          if (s.hasRecentHit3) {
            tier1.push(s);
          } else {
            tier2.push(s);
          }
        } else {
          tier3.push(s);
        }
      }

      // Step 4：從tier3補足第一梯隊
      const tier3WithHit3 = tier3.filter(s => s.hasRecentHit3 && !s.isBench)
        .sort((a, b) => b.last10Hit3Rate - a.last10Hit3Rate);

      const finalTier1 = [...tier1];

      for (const s of tier3WithHit3) {
        if (finalTier1.length >= dynamicGroupCount) break;
        finalTier1.push(s);
      }

      // Step 5：全員低潮時，冷板凳策略最後才補
      if (finalTier1.length < dynamicGroupCount) {
        for (const s of [...tier2, ...tier3.filter(s => !s.isBench), ...tier3.filter(s => s.isBench)]) {
          if (finalTier1.length >= dynamicGroupCount) break;
          if (!finalTier1.some(f => f.key === s.key)) {
            finalTier1.push(s);
          }
        }
      }

      // ✅ v14：sorted3starKeys 去重，避免同一 strategy_key 出現兩次
      const seenStarKeys = new Set();
      const sorted3starKeys = [];
      for (const d of finalTier1.slice(0, dynamicGroupCount)) {
        const sk = d.strategy_key || d.key;
        if (!seenStarKeys.has(sk)) {
          seenStarKeys.add(sk);
          sorted3starKeys.push(sk);
        }
      }

      console.log(
        '[3star] v13梯隊競爭（前4）:',
        finalTier1.slice(0, 4).map(d => {
          const tag = d.isOnFire ? '🔥' : d.isBench ? '🧊' : d.hasRecentHit3 ? '✅' : '❌';
          return `${d.key}(全期:${((d?.allHit3Rate||0)*100).toFixed(1)}% 近5hit3:${d?.last10Hit3Count||0}次 ${tag})`;
        }).join(', ')
      );
      console.log('[3star] 熱身加速:', onFireStrategies.map(s => s.key).join(', ') || '無');
      console.log('[3star] 冷板凳:', allStrategyData.filter(s => s.isBench).map(s => s.key).join(', ') || '無');
      console.log('[3star] 退役:', filteredStats3star.filter(r => toNum(r.total_rounds,0) >= 100 && toNum(r.hit3,0) === 0).map(r => r.strategy_name).join(', ') || '無');

      // ✅ v10：recent10Stats 用 strategy_key 為 key（傳給 buildBingoV1Strategies）
      const recent10Stats = {};
      finalTier1.slice(0, dynamicGroupCount).forEach(d => {
        const statKey = d.strategy_key || d.key;
        const data = statsMap3star.get(d.key);
        recent10Stats[statKey] = data
          ? {
              score: data.score,
              hit3Rate: data.hit3Rate,
              hit2Rate: data.hit2Rate,
              avgCoverageHit: data.avgCoverageHit,
              totalRounds: data.totalRounds,
              isHot: data.isHot || false,
              hotFreqNums: hotFreqNums.slice(0, 20),
              coldFreqNums: coldFreqNums.slice(0, 10)
            }
          : { score: -10, hit3Rate: 0, hit2Rate: 0, avgCoverageHit: 3, totalRounds: 0, isHot: false, hotFreqNums: hotFreqNums.slice(0, 20), coldFreqNums: coldFreqNums.slice(0, 10) };
      });

      // ✅ 傳入即時計算的 marketSnapshot
      // 【方向三】同時把熱區號碼頻率數據注入 snapshot，讓選號優先用高頻號碼
      const liveMarketSnapshot = buildRecentMarketSignalSnapshot(marketRows.data || [], 'numbers');
      // 把近20期頻率數據直接掛到 snapshot 上
      liveMarketSnapshot.freq20_hot_nums = hotFreqNums.slice(0, 24);
      liveMarketSnapshot.freq20_cold_nums = coldFreqNums.slice(0, 16);
      liveMarketSnapshot.num_freq_map = Object.fromEntries(
        [...numFreqMap.entries()].map(([n, f]) => [String(n), f])
      );
      // ✅ fix：用與 comparePendingPredictions 完全相同的模式呼叫 enrichMarketSnapshotWithPhase
      // buildMarketState 提供正確的 market 結構（recent20/latest/hot/cold/gap/zoneFreq/tailFreq）
      // enrichMarketSnapshotWithPhase 回傳新物件，接回來覆蓋 market_phase 和 streak 資料
      const liveMarketState = buildMarketState(marketRows.data || []);
      const enrichedSnapshot = enrichMarketSnapshotWithPhase(liveMarketSnapshot, liveMarketState);
      liveMarketSnapshot.market_phase = enrichedSnapshot.market_phase;
      liveMarketSnapshot.streak2 = enrichedSnapshot.streak2;
      liveMarketSnapshot.streak3 = enrichedSnapshot.streak3;
      liveMarketSnapshot.streak4 = enrichedSnapshot.streak4;

      // ✅ 步驟七 v5：真正串聯步驟五六七
      // 步驟五的數據 → 告訴步驟七哪個角色在當前盤面最有效
      // 步驟七直接輸出「角色分配數量」，不只是排序
      // 發燙的角色多出場，低潮的角色少出場，完全動態
      const livePhase = liveMarketSnapshot.market_phase || 'rotation';
      let dynamicRoleAllocation = null; // 步驟七直接輸出的角色分配

      // ✅ v3：基於 5/17~5/25 歷史資料(13072筆)的初始權重
      // 各策略在各盤相的實測 hit3_rate，直接作為起點，不再從 1.0 盲目開始
      // bias(30.7%) / continuation(41.5%) / rotation(27.8%)
      // ✅ v3：根據 5/28~5/30 實測數據全面重新校準初始權重
      // 實測各策略整體命中率（全盤相合計）：
      // dynamic_recent_6(2.82%) > rebound(2.12%) > dynamic_hot_6(1.73%) = dynamic_gap_zone_5(1.73%)
      // zone_rotation_hot_2(1.57%) > dynamic_hot_5(1.52%) > hot_zone_cover_1(1.22%) > mix_gap(1.19%)
      // dynamic_zone_fill_6(1.11%) > mix_zone_3(1.05%) > cold_zone_cover(0.70%)
      // dynamic_cold_4(0%) = dynamic_recent_5(0%) ← 直接封殺
      const historicalBaseWeights = {
        bias: {
          dynamic_recent_6:    2.2,  // 實測最強(2.82%)，大幅加權
          rebound:             2.0,  // 實測強(2.12%)
          dynamic_hot_6:       1.8,  // 實測強(1.73%)
          dynamic_gap_zone_5:  1.8,  // 實測強(1.73%)
          zone_rotation_hot_2: 1.6,  // 實測中上(1.57%)
          dynamic_hot_5:       1.5,  // 實測中上(1.52%)
          hot_zone_cover_1:    1.2,  // 實測中等(1.22%)
          mix_gap:             1.0,  // 實測中等(1.19%)
          dynamic_zone_fill_6: 1.0,  // 實測中等(1.11%)
          mix_zone_3:          0.8,  // 實測偏弱(1.05%)
          cold_zone_cover:     0.4,  // 實測最差(0.70%)
          dynamic_recent_5:    0.1,  // 實測0%，封殺
          dynamic_cold_4:      0.1,  // 實測0%，封殺
          dynamic_cold_6:      0.1,  // 廢物，封殺
        },
        continuation: {
          dynamic_recent_6:    2.2,
          rebound:             2.0,
          dynamic_hot_6:       1.8,
          dynamic_gap_zone_5:  1.8,
          zone_rotation_hot_2: 1.6,
          dynamic_hot_5:       1.5,
          hot_zone_cover_1:    1.2,
          mix_gap:             1.0,
          dynamic_zone_fill_6: 1.0,
          mix_zone_3:          0.8,
          cold_zone_cover:     0.4,
          dynamic_recent_5:    0.1,
          dynamic_cold_4:      0.1,
          dynamic_cold_6:      0.1,
        },
        rotation: {
          dynamic_recent_6:    2.2,
          rebound:             2.0,
          dynamic_hot_6:       1.8,
          dynamic_gap_zone_5:  1.8,
          zone_rotation_hot_2: 1.6,
          dynamic_hot_5:       1.5,
          hot_zone_cover_1:    1.2,
          mix_gap:             1.0,
          dynamic_zone_fill_6: 1.0,
          mix_zone_3:          0.8,
          cold_zone_cover:     0.4,
          dynamic_recent_5:    0.1,
          dynamic_cold_4:      0.1,
          dynamic_cold_6:      0.1,
        },
        hot_bias: {
          dynamic_recent_6:    2.2,
          rebound:             2.0,
          dynamic_hot_6:       2.0,  // 熱區偏移盤加強熱號策略
          zone_rotation_hot_2: 1.8,
          dynamic_gap_zone_5:  1.6,
          dynamic_hot_5:       1.6,
          hot_zone_cover_1:    1.4,
          dynamic_zone_fill_6: 1.2,
          mix_gap:             0.8,
          mix_zone_3:          0.6,
          cold_zone_cover:     0.3,
          dynamic_recent_5:    0.1,
          dynamic_cold_4:      0.1,
          dynamic_cold_6:      0.1,
        },
        hot_streak: {
          // ✅ v4：根據 5/31 實測數據再次校準
          // 有效：hot_zone_cover_1(3.64%) rebound(3.64%) zone_rotation_hot_2(3.64%) cold_zone_cover(1.82%)
          // 無效：dynamic_recent_6(0%) mix_gap(0%) dynamic_cold_5(0%) mix_zone_3(0%)
          hot_zone_cover_1:    2.2,  // 實測 3.64%，大幅加權（原0.5）
          rebound:             2.2,  // 實測 3.64%，大幅加權（原1.5）
          zone_rotation_hot_2: 2.2,  // 實測持續有效，加權
          cold_zone_cover:     1.5,  // 實測 1.82%，維持
          dynamic_zone_fill_6: 1.2,  // 歷史實測有效，維持
          dynamic_gap_zone_5:  1.2,  // 歷史實測有效，維持
          dynamic_hot_6:       1.0,  // 今天 8.33%（樣本少），給中等
          dynamic_recent_6:    0.3,  // 實測連續兩天 0%，封殺
          mix_gap:             0.4,  // 實測 0%，降權
          dynamic_cold_5:      0.4,  // 實測 0%，降權
          mix_zone_3:          0.4,  // 實測 0%，降權
          dynamic_hot_5:       0.4,
          dynamic_recent_5:    0.1,
          dynamic_cold_4:      0.1,
          dynamic_cold_6:      0.1,
        },
        // ✅ chaos 盤：完全分散，冷號和散佈策略為主
        chaos: {
          dynamic_recent_6:    1.5,
          rebound:             1.3,
          dynamic_gap_zone_5:  1.3,
          mix_zone_3:          1.2,
          dynamic_zone_fill_6: 1.2,
          zone_rotation_hot_2: 1.0,
          mix_gap:             1.0,
          cold_zone_cover:     1.0,
          hot_zone_cover_1:    0.8,
          dynamic_hot_5:       0.8,
          dynamic_hot_6:       0.8,
          dynamic_recent_5:    0.1,
          dynamic_cold_4:      0.1,
          dynamic_cold_6:      0.1,
        }
      };

      // 套用初始權重（根據當前盤相）
      const phaseBaseWeights = historicalBaseWeights[livePhase] || historicalBaseWeights.rotation;
      let roleWeights = {};
      for (const k of sorted3starKeys) {
        // 用歷史資料初始值，沒有對應的給 1.0
        roleWeights[k] = phaseBaseWeights[k] ?? 1.0;
      }
      console.log(`[step7 v3] 套用歷史初始權重 phase=${livePhase}，策略數=${Object.keys(roleWeights).length}`);
      try {
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        // ✅ fix：三層資料查詢全部加入 market_phase 篩選
        // 原本沒有篩選，所有盤相混在一起，步驟七學到的是混淆資料
        // 現在只查當前盤相的資料，讓步驟七真正按盤相學習
        const [longTermRes, midRes, shortRes] = await Promise.all([
          // 長期400期：背景調查（只看當前盤相）
          db.from('strategy_factor_stats')
            .select('strategy_key, hit3, hit2')  // ✅ 加入 hit2
            .eq('market_phase', livePhase)
            .order('recorded_at', { ascending: false })
            .limit(400),
          // 最近1小時：今天場次表現（只看當前盤相）
          db.from('strategy_factor_stats')
            .select('strategy_key, hit3, hit2, recorded_at')  // ✅ 加入 hit2
            .eq('market_phase', livePhase)
            .gte('recorded_at', oneHourAgo)
            .order('recorded_at', { ascending: false })
            .limit(120),
          // 最近30分鐘：即時狀態（只看當前盤相）
          db.from('strategy_factor_stats')
            .select('strategy_key, hit3, hit2, recorded_at')  // ✅ 加入 hit2
            .eq('market_phase', livePhase)
            .gte('recorded_at', thirtyMinAgo)
            .order('recorded_at', { ascending: false })
            .limit(60)
        ]);

        const longTermRows = (!longTermRes.error && longTermRes.data) ? longTermRes.data : [];
        const midRows = (!midRes.error && midRes.data) ? midRes.data : [];
        const shortRows = (!shortRes.error && shortRes.data) ? shortRes.data : [];

        if (longTermRows.length > 0) {
          // 層一：長期戰績（背景調查）× 1
          const longStats = {};
          for (const row of longTermRows) {
            const k = row.strategy_key;
            if (!longStats[k]) longStats[k] = { hit3: 0, total: 0 };
            longStats[k].hit3 += (row.hit3 || 0);
            longStats[k].total += 1;
          }
          const longRates = {};
          for (const [k, s] of Object.entries(longStats)) {
            longRates[k] = s.total >= 5 ? s.hit3 / s.total : 0.005;  // ✅ v3：門檻從10降到5，讓早期資料也有參考價值
          }
          const maxLongRate = Math.max(...Object.values(longRates), 0.01);

          // 層二：最近1小時（今天場次）× 2
          const midStats = {};
          for (const row of midRows) {
            const k = row.strategy_key;
            if (!midStats[k]) midStats[k] = { hit3: 0, hit2: 0, total: 0 };  // ✅ 加入 hit2
            midStats[k].hit3 += (row.hit3 || 0);
            midStats[k].hit2 += (row.hit2 || 0);  // ✅ 累計 hit2
            midStats[k].total += 1;
          }

          // 層三：最近30分鐘（即時狀態）× 4
          const shortStats = {};
          for (const row of shortRows) {
            const k = row.strategy_key;
            if (!shortStats[k]) shortStats[k] = { hit3: 0, hit2: 0, total: 0 };  // ✅ 加入 hit2
            shortStats[k].hit3 += (row.hit3 || 0);
            shortStats[k].hit2 += (row.hit2 || 0);  // ✅ 累計 hit2
            shortStats[k].total += 1;
          }

          // 綜合評分：長期×1 + 1小時×2 + 30分鐘×4
          const allKeys = new Set([
            ...Object.keys(longRates),
            ...Object.keys(midStats),
            ...Object.keys(shortStats)
          ]);

          // ✅ v4：調整加權比例
          // 長期 × 4（穩定基礎，不容易被短期波動左右）
          // 中期 × 2（今天表現）
          // 短期 × 1（即時微調，不主導）
          // 原本短期 × 4 讓幾筆資料就能主導權重，造成震盪
          const finalScores = {};
          for (const k of allKeys) {
            const longRate = longRates[k] || 0.005;
            const midRate = midStats[k]?.total >= 3 ? midStats[k].hit3 / midStats[k].total : null;
            const shortRate = shortStats[k]?.total >= 2 ? shortStats[k].hit3 / shortStats[k].total : null;

            let score = longRate * 4;  // 長期權重提高，穩定基礎
            if (midRate !== null) score += midRate * 2;
            if (shortRate !== null) score += shortRate * 1;  // 短期降低，避免震盪
            const denom = 4 + (midRate !== null ? 2 : 0) + (shortRate !== null ? 1 : 0);
            finalScores[k] = score / denom;
          }

          const maxScore = Math.max(...Object.values(finalScores), 0.01);

          for (const [k, score] of Object.entries(finalScores)) {
            const longRate = longRates[k] || 0;
            const shortS = shortStats[k];
            const midS = midStats[k];
            const longGood = longRate >= maxLongRate * 0.6;

            // ✅ v3：即時狀態判斷，加入 hit2 作為輔助訊號
            // 賓果命中3顆需要運氣，但命中2顆方向對的話 hit2 能反映選號品質
            // ✅ v4：調整門檻，要求更多樣本才能判定熱/冷
            const shortZero = shortS && shortS.total >= 4 && shortS.hit3 === 0 && (shortS.hit2||0) === 0;
            const midZero = midS && midS.total >= 8 && midS.hit3 === 0 && (midS.hit2||0) === 0;
            const shortHot = shortS && shortS.total >= 3 && (shortS.hit3 > 0 || (shortS.hit2||0) >= 2);
            const midHot = midS && midS.total >= 5 && (midS.hit3 > 0 || (midS.hit2||0) >= 3);

            if (shortHot && midHot && longGood) {
              roleWeights[k] = 2.0; // 長期好+最近熱：大膽用
            } else if (shortHot && midHot) {
              roleWeights[k] = 1.5; // 最近熱但長期一般：謹慎加碼
            } else if (shortHot) {
              roleWeights[k] = 1.3; // 只有30分鐘熱：小幅加碼
            } else if (shortZero && midZero && longGood) {
              roleWeights[k] = 0.5; // 長期好球員雙重低潮：保護但減量
            } else if (shortZero && midZero) {
              roleWeights[k] = 0.3; // 雙重低潮且長期一般：深度冷板凳
            } else if (shortZero && longGood) {
              roleWeights[k] = 0.6; // 30分鐘低潮但長期好：觀察
            } else if (shortZero) {
              roleWeights[k] = 0.4; // 30分鐘低潮：減少出場
            } else if (score >= maxScore * 0.6) {
              roleWeights[k] = 1.2; // 整體不錯：小幅加碼
            } else {
              roleWeights[k] = 0.9; // 正常：接近預設值
            }
          }

          // 冷板凳保護：超過30期沒出現，給一次回場機會
          const recentKeySet = new Set([...midRows, ...shortRows].slice(0, 30).map(r => r.strategy_key));
          for (const k of sorted3starKeys) {
            if (!recentKeySet.has(k) && !roleWeights[k]) {
              roleWeights[k] = 1.2;
              console.log(`[step7] ${k} 久未上場，強制回場`);
            }
          }

          // 異常保護：冷板凳超過一半時重置
          // ✅ v3：門檻從 0.3 放寬到 0.1，避免資料少時誤觸發
          const coldKeys = Object.entries(roleWeights).filter(([,w]) => w <= 0.1).map(([k]) => k);
          const hotKeys = Object.entries(roleWeights).filter(([,w]) => w >= 2.0).map(([k]) => k);
          const totalKeys = Object.keys(roleWeights).length;

          if (totalKeys > 0 && coldKeys.length > totalKeys * 0.5) {
            console.log(`[step7] 異常保護：冷板凳比例過高(${coldKeys.length}/${totalKeys})，回歸歷史初始權重 phase=${livePhase}`);
            // ✅ v3：重置回歷史初始權重，不是全部 1.0
            for (const k of Object.keys(roleWeights)) {
              roleWeights[k] = phaseBaseWeights[k] ?? 1.0;
            }
          }

          console.log(`[step7] phase=${livePhase} hot=[${hotKeys.join(',')}] cold=[${coldKeys.join(',')}]`);

          // ✅ 步驟七核心：直接計算角色分配數量
          // 根據 strategy_key 的命中表現，對應到角色名稱，決定每個角色出幾組
          // 這樣步驟五六七才真正串聯：數據→盤面→角色數量
          const roleHitMap = {
            hot: 0, cold: 0, recent: 0, streak: 0,
            zone_fill: 0, scatter: 0, tail_hot: 0, tail_cold: 0,
            repeat: 0, anti_hot: 0, gap_zone: 0, chain: 0,
            dominant: 0, sleeper: 0, mid_zone: 0, edge_zone: 0,
            odd_bias: 0, sum_low: 0, sum_high: 0, balance: 0
          };
          const roleCountMap = { ...roleHitMap };

          // 把 strategy_key 的表現對應到角色
          for (const [k, w] of Object.entries(roleWeights)) {
            const key = k.toLowerCase();
            const addToRole = (role) => {
              roleHitMap[role] = (roleHitMap[role] || 0) + w;
              roleCountMap[role] = (roleCountMap[role] || 0) + 1;
            };
            if (key.includes('hot') && !key.includes('cold')) addToRole('hot');
            if (key.includes('cold') || key.includes('rebound')) addToRole('cold');
            if (key.includes('recent')) addToRole('recent');
            if (key.includes('streak') || key.includes('chain')) addToRole('streak');
            if (key.includes('zone') && !key.includes('hot') && !key.includes('cold')) addToRole('zone_fill');
            if (key.includes('scatter')) addToRole('scatter');
            if (key.includes('balanced') || key.includes('balance')) addToRole('balance');
          }

          // 計算每個角色的平均權重
          const roleAvgWeight = {};
          for (const role of Object.keys(roleHitMap)) {
            roleAvgWeight[role] = roleCountMap[role] > 0
              ? roleHitMap[role] / roleCountMap[role]
              : 1.0;
          }

          // 根據當前 market_phase 決定基礎陣容，再用步驟七的權重調整數量
          // 基礎8組，根據角色權重動態分配
          const baseRoles = {
            continuation: { streak: 2, cold: 1, recent: 2, hot: 2, zone_fill: 1 },    // ✅ 連號延續：追熱+連號
            bias: { zone_fill: 2, cold: 2, gap_zone: 1, hot: 1, recent: 1, scatter: 1 },
            hot_bias: { hot: 3, zone_fill: 2, recent: 1, gap_zone: 1, scatter: 1 },    // ✅ 熱區偏移：大量追熱
            hot_streak: { hot: 2, zone_fill: 2, cold: 2, recent: 2 },                  // ✅ v4：hot_zone_cover_1實測3.64%，hot給2個名額
            chaos: { scatter: 2, cold: 2, recent: 1, balance: 1, zone_fill: 1, gap_zone: 1 }, // ✅ 混沌：分散選號
            rotation: { cold: 2, recent: 2, hot: 1, zone_fill: 1, scatter: 1, balance: 1 }
          };

          const base = baseRoles[livePhase] || baseRoles.rotation;

          // 根據步驟七的權重調整分配：權重高的角色可以多1組，權重低的減1組
          const adjusted = { ...base };
          let totalGroups8 = Object.values(adjusted).reduce((a, b) => a + b, 0);

          // 找最高權重角色加1組，最低權重角色減1組
          const sortedByWeight = Object.keys(roleAvgWeight)
            .filter(r => adjusted[r] !== undefined)
            .sort((a, b) => roleAvgWeight[b] - roleAvgWeight[a]);

          if (sortedByWeight.length >= 2) {
            const hotRole = sortedByWeight[0];
            const coldRole = sortedByWeight[sortedByWeight.length - 1];
            if (roleAvgWeight[hotRole] >= 1.5 && adjusted[coldRole] > 1) {
              adjusted[hotRole] = (adjusted[hotRole] || 0) + 1;
              adjusted[coldRole] = adjusted[coldRole] - 1;
              console.log(`[step7] 加碼 ${hotRole}(w=${roleAvgWeight[hotRole].toFixed(2)}) 減量 ${coldRole}(w=${roleAvgWeight[coldRole].toFixed(2)})`);
            }
          }

          // 展開成角色陣列
          dynamicRoleAllocation = [];
          for (const [role, count] of Object.entries(adjusted)) {
            for (let i = 0; i < count; i++) {
              dynamicRoleAllocation.push(role);
            }
          }
          // 確保恰好8組
          while (dynamicRoleAllocation.length < 8) dynamicRoleAllocation.push('scatter');
          dynamicRoleAllocation = dynamicRoleAllocation.slice(0, 8);

          console.log(`[step7 v5] 動態角色分配: ${dynamicRoleAllocation.join(',')}`);
        } else {
          // ✅ fix：strategy_factor_stats 完全無資料時，直接套用歷史初始權重
          console.log(`[step7] 無即時資料，全部套用歷史初始權重 phase=${livePhase}`);
          for (const k of sorted3starKeys) {
            roleWeights[k] = phaseBaseWeights[k] ?? 1.0;
          }
        }
      } catch (factorQueryErr) {
        console.warn('[step7] roleWeights query failed:', factorQueryErr.message);
      }

      // 把 roleWeights 和動態角色分配注入 liveMarketSnapshot
      liveMarketSnapshot.role_weights = roleWeights;
      if (dynamicRoleAllocation) {
        liveMarketSnapshot.dynamic_role_allocation = dynamicRoleAllocation;
      }

      const result3star = buildBingoV1Strategies(
        marketRows.data || [],
        {},
        3,
        liveMarketSnapshot,
        recent10Stats,
        sorted3starKeys,
        dynamicGroupCount
      );

      const threeStarGroups = (result3star.strategies || []).map((s, idx) => ({
        key: s.key,
        label: s.label,
        nums: (Array.isArray(s.nums) ? s.nums : []).slice(0, 3),
        reason: s.reason || '市場感知三星選號',
        meta: {
          ...(s.meta || {}),
          star_mode: 3,
          derived_from: 'buildBingoV1Strategies_market_driven',
          market_phase: result3star.marketPhase || 'rotation',
          group_allocation: result3star.groupAllocation || {},
          slot_no: idx + 1,
          // ✅ 記錄加碼/減碼狀態
          betting_state: {
            group_count: dynamicGroupCount,
            reason: bettingState.reason,
            consecutive_no_hit2: bettingState.consecutiveNoHit2,
            consecutive_hit2: bettingState.consecutiveHit2 ?? 0,
            last_hit3: bettingState.lastHit3,
            recent_best_hits: bettingState.recentBestHits ?? []
          }
        }
      })).filter(g => g.nums.length === 3);

      if (threeStarGroups.length > 0) {
        // ✅ 建立新預測前，查上一期比對結果的 hit2 組數，決定本期是否建議下注
        let recommendThisPeriod = false;
        try {
          const { data: lastCompared } = await db
            .from(PREDICTIONS_TABLE)
            .select('compare_result_json')
            .eq('mode', 'formal_3star')
            .eq('compare_status', 'done')
            .order('compared_at', { ascending: false })
            .limit(1)
            .single();

          if (lastCompared?.compare_result_json) {
            const raw = lastCompared.compare_result_json;
            const result = raw && typeof raw === 'string'
              ? (() => { try { return JSON.parse(raw); } catch { return null; } })()
              : raw;
            // 計算上一期有幾組中二（hit >= 2）
            const detail = Array.isArray(result?.detail) ? result.detail : [];
            const hit2GroupCount = detail.filter(d => toNum(d?.hit, 0) >= 2).length;
            recommendThisPeriod = hit2GroupCount >= 2;
            console.log(`[3star] 上一期中二組數: ${hit2GroupCount}，本期recommend: ${recommendThisPeriod}`);
          }
        } catch (recErr) {
          console.warn('[3star] 查上一期比對結果失敗:', recErr.message);
        }

        const payload3star = {
          mode: 'formal_3star',
          status: 'created',
          source_draw_no: sourceDrawNo,
          target_periods: TARGET_PERIODS,
          groups_json: threeStarGroups,
          compare_status: 'pending',
          compare_result: null,
          compare_result_json: null,
          hit_count: 0,
          verdict: null,
          latest_draw_numbers: parseNums(marketRows?.data?.[0]?.numbers || []),
          market_snapshot_json: marketSnapshot || null,
          market_phase: String(result3star.marketPhase || liveMarketSnapshot?.market_phase || 'rotation').toLowerCase(),
          market_signal: result3star.marketPhase || null,
          confidence_score: null,
          weight_profile: null,
          source_draw_time: marketRows?.data?.[0]?.draw_time || null,
          compared_history_json: [],
          compared_draw_count: 0,
          compared_at: null,
          created_at: nowIso,
          recommend: recommendThisPeriod  // ✅ 上一期≥2組中二才建議下注
        };
        const { error: insertErr3star } = await db.from(PREDICTIONS_TABLE).insert(payload3star);
        if (insertErr3star) {
          console.error(`[3star] INSERT 失敗, draw: ${sourceDrawNo}`, insertErr3star.message, insertErr3star.code);
        } else {
          console.log(
            `[3star] 市場感知三星選號成功, draw: ${sourceDrawNo}`,
            `組數: ${threeStarGroups.length}（${bettingState.reason}）`,
            `盤相: ${result3star.marketPhase}`
          );
        }
      }
      } // end else (dynamicGroupCount !== 0)
    }
  } catch (err3) {
    console.warn('[3star] 真三星產生失敗:', err3.message);
  }
}
function normalizeHitRate(raw) {
  const value = toNum(raw, 0);
  if (value <= 0) return 0;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return 1;
}

function isDuplicateDrawModeError(error) {
  const msg = String(error?.message || '');
  const details = String(error?.details || '');
  const code = String(error?.code || '');

  return (
    code === '23505' ||
    msg.includes('unique_draw_mode') ||
    details.includes('unique_draw_mode') ||
    msg.includes('duplicate key value violates unique constraint')
  );
}

function tokenizeStrategyKey(strategyKey = '') {
  return String(strategyKey || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token));
}

function strategyLabel(strategyKey = '') {
  return String(strategyKey || '')
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function normalizeStrategyKey(raw = '') {
  return String(raw || '').trim().toLowerCase();
}

function getDecisionRank(decision = '') {
  const d = String(decision || '').toLowerCase();
  if (d === 'reject') return 0;
  if (d === 'weak') return 1;
  if (d === 'candidate') return 2;
  if (d === 'usable') return 3;
  if (d === 'strong') return 4;
  return 5;
}

function inferGenesFromStrategyKey(strategyKey = '') {
  const tokens = tokenizeStrategyKey(strategyKey);
  const genes = tokens.filter((t) => KNOWN_GENES.includes(t));

  return {
    gene_a: genes[0] || 'mix',
    gene_b: genes[1] || 'balanced'
  };
}

function uniqueTokens(tokens = []) {
  return [...new Set((Array.isArray(tokens) ? tokens : []).filter(Boolean))];
}

function buildStrategyKeyFromTokens(tokens = []) {
  return normalizeStrategyKey(uniqueTokens(tokens).slice(0, 3).join('_'));
}

function buildChildStrategyKey(parentAKey = '', parentBKey = '', mode = 'crossover', seq = 0) {
  const tokensA = tokenizeStrategyKey(parentAKey);
  const tokensB = tokenizeStrategyKey(parentBKey);

  if (mode === 'exploration') {
    const a = KNOWN_GENES[seq % KNOWN_GENES.length];
    const b = KNOWN_GENES[(seq + 7) % KNOWN_GENES.length];
    const c = KNOWN_GENES[(seq + 13) % KNOWN_GENES.length];
    return buildStrategyKeyFromTokens([a, b, c]);
  }

  if (mode === 'mutation') {
    const base = tokensA.length ? [...tokensA] : ['mix', 'balanced'];
    const extra = KNOWN_GENES[(seq + base.length) % KNOWN_GENES.length];
    return buildStrategyKeyFromTokens([...base, extra]);
  }

  const a1 = tokensA[0] || 'mix';
  const a2 = tokensA[1] || '';
  const b1 = tokensB[0] || 'balanced';
  const b2 = tokensB[1] || '';

  return buildStrategyKeyFromTokens([a1, b1, a2 || b2].filter(Boolean));
}

function chooseSpawnSourceType(index = 0, activeCount = 0) {
  if (activeCount < 36) {
    return index % 3 === 0 ? 'exploration' : 'evolved';
  }

  if (index % 4 === 0) return 'exploration';
  if (index % 2 === 0) return 'crossover';
  return 'evolved';
}

function normalizePredictionStatus(status = '') {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'compared') return 'compared';
  if (s === 'created') return 'created';
  return s || 'created';
}

function normalizePredictionMode(mode = '') {
  const m = String(mode || '').trim().toLowerCase();
  if (m === FORMAL_MODE) return FORMAL_MODE;
  if (m === 'formal_3star') return 'formal_3star';
  return TEST_MODE;
}

function countOverlap(a = [], b = []) {
  const setB = new Set(uniqueSorted(b));
  return uniqueSorted(a).filter((n) => setB.has(n)).length;
}

function pickFromPool(pool = [], selectedSet = new Set(), seed = 0) {
  const candidates = uniqueSorted(pool).filter((n) => !selectedSet.has(n));
  if (!candidates.length) return null;
  const index = Math.abs(toNum(seed, 0)) % candidates.length;
  return candidates[index];
}

function fillToFour(base = [], fallbackPools = [], seed = 0) {
  const result = uniqueSorted(base).slice(0, 4);
  const selected = new Set(result);
  let cursor = 0;

  for (const pool of fallbackPools) {
    while (result.length < 4 && cursor < 220) {
      const value = pickFromPool(pool, selected, seed + cursor);
      cursor += 1;
      if (value == null) break;
      selected.add(value);
      result.push(value);
    }

    if (result.length >= 4) break;
  }

  if (result.length < 4) {
    const allNums = Array.from({ length: 80 }, (_, i) => i + 1);
    while (result.length < 4 && cursor < 500) {
      const value = pickFromPool(allNums, selected, seed + cursor);
      cursor += 1;
      if (value == null) break;
      selected.add(value);
      result.push(value);
    }
  }

  return uniqueSorted(result).slice(0, 4);
}

function mutateOne(nums = [], pools = [], seed = 0) {
  const current = uniqueSorted(nums).slice(0, 4);
  if (current.length !== 4) return current;

  const selected = new Set(current);
  const removeIndex = Math.abs(seed) % current.length;
  selected.delete(current[removeIndex]);

  for (let i = 0; i < pools.length; i += 1) {
    const value = pickFromPool(pools[i], selected, seed + i * 17 + 3);
    if (value != null) {
      selected.add(value);
      return uniqueSorted([...selected]).slice(0, 4);
    }
  }

  return uniqueSorted([...selected]).slice(0, 4);
}

function forceGroupDifference(nums = [], existingGroups = [], pools = {}, seed = 0) {
  let result = uniqueSorted(nums).slice(0, 4);
  const poolOrder = [pools.attack, pools.extend, pools.guard, pools.recent, pools.hot, pools.all];

  for (let round = 0; round < 10; round += 1) {
    let changed = false;

    for (const group of existingGroups) {
      const overlap = countOverlap(result, group?.nums || []);
      if (overlap >= 3) {
        result = mutateOne(result, poolOrder, seed + round * 23 + overlap);
        changed = true;
        break;
      }
    }

    if (!changed) break;
  }

  return uniqueSorted(result).slice(0, 4);
}

function getZoneIndex(n) {
  if (n >= 1 && n <= 20) return 1;
  if (n <= 40) return 2;
  if (n <= 60) return 3;
  return 4;
}

function buildMarketState(drawRows = []) {
  const rows = (Array.isArray(drawRows) ? drawRows : []).map((row) => ({
    draw_no: toNum(row?.draw_no, 0),
    numbers: parseNums(
      row?.numbers ??
        row?.draw_numbers ??
        row?.result_numbers ??
        row?.open_numbers ??
        row?.nums
    )
  }));

  const latest = rows[0]?.numbers || [];
  const recent20 = rows.slice(0, 20);
  const recent50 = rows.slice(0, 50);
  const recent80 = rows.slice(0, 80);

  const freq20 = new Map();
  const freq50 = new Map();
  const freq80 = new Map();
  const lastSeen = new Map();
  const tailFreq20 = new Map();
  const zoneFreq20 = new Map();

  for (let n = 1; n <= 80; n += 1) {
    freq20.set(n, 0);
    freq50.set(n, 0);
    freq80.set(n, 0);
  }

  for (let t = 0; t <= 9; t += 1) {
    tailFreq20.set(t, 0);
  }

  for (let z = 1; z <= 4; z += 1) {
    zoneFreq20.set(z, 0);
  }

  recent20.forEach((row, idx) => {
    for (const n of row.numbers) {
      freq20.set(n, toNum(freq20.get(n), 0) + 1);
      lastSeen.set(n, idx);
      tailFreq20.set(n % 10, toNum(tailFreq20.get(n % 10), 0) + 1);
      zoneFreq20.set(getZoneIndex(n), toNum(zoneFreq20.get(getZoneIndex(n)), 0) + 1);
    }
  });

  recent50.forEach((row) => {
    for (const n of row.numbers) {
      freq50.set(n, toNum(freq50.get(n), 0) + 1);
    }
  });

  recent80.forEach((row) => {
    for (const n of row.numbers) {
      freq80.set(n, toNum(freq80.get(n), 0) + 1);
    }
  });

  const allNums = Array.from({ length: 80 }, (_, i) => i + 1);

  const hot = allNums
    .slice()
    .sort((a, b) => {
      const d20 = toNum(freq20.get(b), 0) - toNum(freq20.get(a), 0);
      if (d20 !== 0) return d20;

      const d50 = toNum(freq50.get(b), 0) - toNum(freq50.get(a), 0);
      if (d50 !== 0) return d50;

      return a - b;
    });

  const cold = allNums
    .slice()
    .sort((a, b) => {
      const d20 = toNum(freq20.get(a), 0) - toNum(freq20.get(b), 0);
      if (d20 !== 0) return d20;

      const gapA = lastSeen.has(a) ? toNum(lastSeen.get(a), 999) : 999;
      const gapB = lastSeen.has(b) ? toNum(lastSeen.get(b), 999) : 999;
      if (gapB !== gapA) return gapB - gapA;

      return a - b;
    });

  const gap = allNums
    .slice()
    .sort((a, b) => {
      const gapA = lastSeen.has(a) ? toNum(lastSeen.get(a), 999) : 999;
      const gapB = lastSeen.has(b) ? toNum(lastSeen.get(b), 999) : 999;
      return gapB - gapA || a - b;
    });

  const warm = [...hot.slice(10), ...hot.slice(0, 10)];

  return {
    latest,
    recent20,
    recent50,
    recent80,
    hot,
    cold,
    gap,
    warm,
    all: allNums,
    freq20,
    freq50,
    freq80,
    tailFreq20,
    zoneFreq20
  };
}

function buildDecisionPools(market = {}, marketSnapshot = {}) {
  const hot5 = uniqueSorted(marketSnapshot?.hot_windows?.hot_5?.numbers || marketSnapshot?.hot_5_numbers || []);
  const hot10 = uniqueSorted(marketSnapshot?.hot_windows?.hot_10?.numbers || marketSnapshot?.hot_10_numbers || []);
  const hot20 = uniqueSorted(marketSnapshot?.hot_windows?.hot_20?.numbers || marketSnapshot?.hot_20_numbers || []);
  const streak2 = uniqueSorted(marketSnapshot?.streak2 || marketSnapshot?.streaks?.streak2 || []);
  const streak3 = uniqueSorted(marketSnapshot?.streak3 || marketSnapshot?.streaks?.streak3 || []);
  const streak4 = uniqueSorted(marketSnapshot?.streak4 || marketSnapshot?.streaks?.streak4 || []);
  const decisionBasis = marketSnapshot?.decision_basis || {};
  const phase = String(marketSnapshot?.market_phase || 'rotation').toLowerCase();

  let attackHotTake = 10;
  let attackStreak2Take = 0;
  let extendHot10Take = 14;
  let extendHot20Take = 8;
  let guardHot20Take = 20;
  let recentHot5Take = 12;

  if (phase === 'continuation') {
    attackHotTake = 12;
    attackStreak2Take = 4;
    extendHot10Take = 12;
    guardHot20Take = 16;
  } else if (phase === 'bias') {
    attackHotTake = 10;
    attackStreak2Take = 3;
    extendHot10Take = 10;
    extendHot20Take = 6;
    guardHot20Take = 16;
    recentHot5Take = 8;
  } else if (phase === 'hot_bias') {
    // ✅ 熱區偏移：比 bias 更激進追熱
    attackHotTake = 14;
    attackStreak2Take = 3;
    extendHot10Take = 12;
    extendHot20Take = 4;
    guardHot20Take = 14;
    recentHot5Take = 10;
  } else if (phase === 'hot_streak') {
    // ✅ 熱號爆發：全力追熱
    attackHotTake = 16;
    attackStreak2Take = 2;
    extendHot10Take = 14;
    extendHot20Take = 2;
    guardHot20Take = 12;
    recentHot5Take = 12;
  } else if (phase === 'chaos') {
    attackHotTake = 6;
    attackStreak2Take = 1;
    extendHot10Take = 10;
    extendHot20Take = 10;
    guardHot20Take = 24;
    recentHot5Take = 6;
  }

  const attack = uniqueSorted([
    ...(decisionBasis.attack_core_numbers || []),
    ...streak4,
    ...streak3,
    ...streak2.slice(0, attackStreak2Take),
    ...hot5.slice(0, attackHotTake),
    ...hot10.slice(0, 6)
  ]);

  const extend = uniqueSorted([
    ...(decisionBasis.extend_numbers || []),
    ...streak2,
    ...hot10.slice(0, extendHot10Take),
    ...hot20.slice(0, extendHot20Take)
  ]);

  const guard = uniqueSorted([
    ...(decisionBasis.guard_numbers || []),
    ...hot20.slice(0, guardHot20Take),
    ...((market.warm || []).slice(0, guardHot20Take))
  ]);

  const recent = uniqueSorted([
    ...(decisionBasis.recent_focus_numbers || []),
    ...(market.latest || []),
    ...hot5.slice(0, recentHot5Take)
  ]);

  const hot = uniqueSorted([...hot5, ...hot10, ...hot20, ...((market.hot || []).slice(0, 30))]);
  const cold = uniqueSorted([...((market.cold || []).slice(0, 24)), ...((market.gap || []).slice(0, 24))]);
  const gap = uniqueSorted([...((market.gap || []).slice(0, 24))]);
  const warm = uniqueSorted([...((market.warm || []).slice(0, 24))]);

  return {
    attack,
    extend,
    guard,
    recent,
    hot,
    cold,
    gap,
    warm,
    all: uniqueSorted(market.all || [])
  };
}

function scorePoolHits(nums = [], pool = [], weight = 1) {
  const setPool = new Set(uniqueSorted(pool));
  let score = 0;
  for (const n of uniqueSorted(nums)) {
    if (setPool.has(n)) score += weight;
  }
  return score;
}

function buildStrategyNums(strategyKey = '', market = {}, marketSnapshot = {}, seed = 0, role = 'mix') {
  const pools = buildDecisionPools(market, marketSnapshot);
  const tokens = tokenizeStrategyKey(strategyKey);
  const selected = new Set();
  const base = [];

  const rolePoolMap = {
    attack: [pools.attack, pools.hot, pools.extend, pools.all],
    extend: [pools.extend, pools.attack, pools.guard, pools.all],
    guard: [pools.guard, pools.extend, pools.hot, pools.all],
    recent: [pools.recent, pools.attack, pools.hot, pools.all],
    mix: [pools.hot, pools.extend, pools.guard, pools.all]
  };

  const pushFromPool = (pool, count = 1, salt = 0) => {
    let cursor = 0;
    while (base.length < 4 && cursor < count * 20) {
      const value = pickFromPool(pool, selected, seed + salt + cursor * 13);
      cursor += 1;
      if (value == null) break;
      if (selected.has(value)) continue;
      selected.add(value);
      base.push(value);
      if (count <= 1) break;
      if (base.length >= 4) break;
    }
  };

  if (rolePoolMap[role]) {
    const list = rolePoolMap[role];
    if (role === 'attack') {
      pushFromPool(list[0], 2, 11);
      pushFromPool(list[1], 1, 17);
      pushFromPool(list[2], 1, 23);
    } else if (role === 'extend') {
      pushFromPool(list[0], 2, 29);
      pushFromPool(list[1], 1, 31);
      pushFromPool(list[2], 1, 37);
    } else if (role === 'guard') {
      pushFromPool(list[0], 2, 41);
      pushFromPool(list[1], 1, 43);
      pushFromPool(list[2], 1, 47);
    } else if (role === 'recent') {
      pushFromPool(list[0], 2, 53);
      pushFromPool(list[1], 1, 59);
      pushFromPool(list[2], 1, 61);
    } else {
      pushFromPool(list[0], 1, 67);
      pushFromPool(list[1], 1, 71);
      pushFromPool(list[2], 1, 73);
    }
  }

  for (const token of tokens) {
    if (base.length >= 4) break;

    if (token === 'hot' || token === 'repeat') {
      pushFromPool(pools.attack.length ? pools.attack : pools.hot, 1, 101);
      continue;
    }

    if (token === 'cold' || token === 'reverse' || token === 'skip') {
      pushFromPool(pools.cold.length ? pools.cold : pools.gap, 1, 103);
      continue;
    }

    if (token === 'warm' || token === 'balanced' || token === 'balance' || token === 'mix') {
      pushFromPool(pools.guard.length ? pools.guard : pools.warm, 1, 107);
      continue;
    }

    if (token === 'gap' || token === 'jump' || token === 'chase') {
      pushFromPool(pools.extend.length ? pools.extend : pools.gap, 1, 109);
      continue;
    }

    if (token === 'zone' || token === 'pattern' || token === 'structure' || token === 'cluster') {
      pushFromPool(pools.attack.length ? pools.attack : pools.hot, 1, 113);
      continue;
    }

    if (token === 'tail' || token === 'split' || token === 'rotation' || token === 'spread') {
      pushFromPool(pools.recent.length ? pools.recent : pools.guard, 1, 127);
      continue;
    }

    if (token === 'odd' || token === 'even' || token === 'guard') {
      pushFromPool(pools.guard.length ? pools.guard : pools.hot, 1, 131);
      continue;
    }
  }

  const fallbackPools = rolePoolMap[role] || [pools.hot, pools.extend, pools.guard, pools.all];
  return fillToFour(base, fallbackPools, seed + 199);
}

function calcMarketBoost(strategyKey = '', marketSnapshot = {}, market = {}) {
  const tokens = tokenizeStrategyKey(strategyKey);
  const hot5 = uniqueSorted(marketSnapshot?.hot_windows?.hot_5?.numbers || marketSnapshot?.hot_5_numbers || []);
  const hot10 = uniqueSorted(marketSnapshot?.hot_windows?.hot_10?.numbers || marketSnapshot?.hot_10_numbers || []);
  const hot20 = uniqueSorted(marketSnapshot?.hot_windows?.hot_20?.numbers || marketSnapshot?.hot_20_numbers || []);
  const streak2 = uniqueSorted(marketSnapshot?.streak2 || marketSnapshot?.streaks?.streak2 || []);
  const streak3 = uniqueSorted(marketSnapshot?.streak3 || marketSnapshot?.streaks?.streak3 || []);
  const attack = uniqueSorted(marketSnapshot?.decision_basis?.attack_core_numbers || []);
  const extend = uniqueSorted(marketSnapshot?.decision_basis?.extend_numbers || []);
  const guard = uniqueSorted(marketSnapshot?.decision_basis?.guard_numbers || []);
  const recent = uniqueSorted(marketSnapshot?.decision_basis?.recent_focus_numbers || []);
  const nums = buildStrategyNums(strategyKey, market, marketSnapshot, 17, 'mix');

  let boost = 1;
  const reasons = [];

  const attackHits = scorePoolHits(nums, attack, 0.09);
  const extendHits = scorePoolHits(nums, extend, 0.05);
  const guardHits = scorePoolHits(nums, guard, 0.03);
  const recentHits = scorePoolHits(nums, recent, 0.03);
  const streak3Hits = scorePoolHits(nums, streak3, 0.15);
  const streak2Hits = scorePoolHits(nums, streak2, 0.08);
  const hot5Hits = scorePoolHits(nums, hot5, 0.08);
  const hot10Hits = scorePoolHits(nums, hot10, 0.05);
  const hot20Hits = scorePoolHits(nums, hot20, 0.03);

  boost += attackHits + extendHits + guardHits + recentHits + streak3Hits + streak2Hits + hot5Hits + hot10Hits + hot20Hits;

  if (streak3Hits > 0) reasons.push('streak3_core');
  if (streak2Hits > 0) reasons.push('streak2_support');
  if (attackHits > 0) reasons.push('attack_core');
  if (extendHits > 0) reasons.push('extend_support');
  if (guardHits > 0) reasons.push('guard_support');
  if (hot5Hits > 0) reasons.push('hot5');
  if (hot10Hits > 0) reasons.push('hot10');
  if (hot20Hits > 0) reasons.push('hot20');
  if (recentHits > 0) reasons.push('recent_focus');

  if (tokens.includes('hot') || tokens.includes('repeat')) {
    boost += streak3.length ? 0.08 : 0;
    boost += hot5.length ? 0.06 : 0;
  }

  if (tokens.includes('cold') || tokens.includes('reverse') || tokens.includes('skip')) {
    const coldPool = uniqueSorted([...(market.cold || []).slice(0, 20), ...(market.gap || []).slice(0, 20)]);
    const coldHits = scorePoolHits(nums, coldPool, 0.05);
    boost += coldHits;
    if (coldHits > 0) reasons.push('cold_gap');
  }

  if (tokens.includes('gap') || tokens.includes('jump') || tokens.includes('chase')) {
    const gapPool = uniqueSorted([...(market.gap || []).slice(0, 20)]);
    const gapHits = scorePoolHits(nums, gapPool, 0.04);
    boost += gapHits;
    if (gapHits > 0) reasons.push('gap_jump');
  }

  boost = clamp(boost, 0.6, 2.2);

  return {
    market_boost: round4(boost),
    market_reason: reasons.slice(0, 4).join(',')
  };
}

function chooseDecision(row = {}) {
  const totalRounds = toNum(row.total_rounds, 0);
  const roi = toNum(row.roi, -1);
  const score = toNum(row.score, 0);
  const avgHit = toNum(row.avg_hit, 0);
  const marketBoost = toNum(row.market_boost, 1);
  const hit3Rate = normalizeHitRate(row.hit3_rate);
  const recent50Hit3Rate = normalizeHitRate(row.recent_50_hit3_rate);
  const recent50Roi = toNum(row.recent_50_roi, -1);

  const decisionScore = calcDecisionScore(row);

  if (
    toNum(row.roi, -1) <= DECISION_CONFIG.hardRejectRoi &&
    totalRounds >= DECISION_CONFIG.minRoundsForTrust &&
    recent50Roi <= DECISION_CONFIG.hardRejectRoi
  ) {
    row.decision_score = round4(decisionScore);
    return 'reject';
  }

  if (score <= DECISION_CONFIG.hardRejectScore && totalRounds >= DECISION_CONFIG.minRoundsForTrust) {
    row.decision_score = round4(decisionScore);
    return 'reject';
  }

  row.decision_score = round4(decisionScore);

  // ✅ 三星化：avgHit 門檻從 1.15/1.2 降到 0.7/0.75（三星理論值0.75）
  if (
    decisionScore >= DECISION_CONFIG.strongScoreFloor * 2.8 ||
    (recent50Hit3Rate >= 0.03 && avgHit >= 0.65) ||  // 三星hit3理論1%，3%以上算優秀
    (hit3Rate >= 0.04 && marketBoost >= 1.1 && recent50Hit3Rate >= 0.02)
  ) {
    return 'strong';
  }

  if (
    decisionScore >= DECISION_CONFIG.strongScoreFloor ||
    (avgHit >= 0.7 && roi >= -0.5) ||   // 三星理論avg_hit=0.75
    recent50Hit3Rate >= 0.02
  ) {
    return 'usable';
  }

  if (
    decisionScore >= DECISION_CONFIG.usableScoreFloor ||
    score >= 0 ||
    roi >= DECISION_CONFIG.softRejectRoi
  ) {
    return 'candidate';
  }

  return 'weak';
}

function calcRecentRates(row = {}) {
  const totalRounds = toNum(row.total_rounds, 0);
  const hit2 = toNum(row.hit2, 0);
  const hit3 = toNum(row.hit3, 0);
  const hit4 = toNum(row.hit4, 0);

  const recentHits = safeArray(row.recent_hits);
  const recentProfit = safeArray(row.recent_profit);
  const recentCost = safeArray(row.recent_cost);

  const recent50Hits = recentHits.slice(-50).map((x) => toNum(x, 0));
  const recent50Profit = recentProfit.slice(-50).map((x) => toNum(x, 0));
  const recent50Cost = recentCost.slice(-50).map((x) => toNum(x, 0));

  const recent50HitRate = recent50Hits.length
    ? recent50Hits.filter((x) => x >= 2).length / recent50Hits.length
    : 0;

  const recent50Hit3Rate = recent50Hits.length
    ? recent50Hits.filter((x) => x >= 3).length / recent50Hits.length
    : 0;

  const recent50Hit4Rate = recent50Hits.length
    ? recent50Hits.filter((x) => x >= 4).length / recent50Hits.length
    : 0;

  const sumRecentCost = recent50Cost.reduce((acc, n) => acc + n, 0);
  const sumRecentProfit = recent50Profit.reduce((acc, n) => acc + n, 0);
  const recent50Roi = sumRecentCost > 0 ? sumRecentProfit / sumRecentCost : 0;

  return {
    total_rounds: totalRounds,
    hit2,
    hit3,
    hit4,
    hit2_rate: totalRounds > 0 ? hit2 / totalRounds : 0,
    hit3_rate: totalRounds > 0 ? hit3 / totalRounds : 0,
    hit4_rate: totalRounds > 0 ? hit4 / totalRounds : 0,
    recent_50_hit_rate: recent50HitRate,
    recent_50_hit3_rate: recent50Hit3Rate,
    recent_50_hit4_rate: recent50Hit4Rate,
    recent_50_roi: recent50Roi
  };
}

function mergePoolWithStats(poolRows = [], statsRows = [], marketSnapshot = {}, market = {}) {
  const statsMap = new Map(
    (Array.isArray(statsRows) ? statsRows : []).map((row) => [
      normalizeStrategyKey(row?.strategy_key),
      row
    ])
  );

  return (Array.isArray(poolRows) ? poolRows : []).map((poolRow, idx) => {
    const strategyKey = normalizeStrategyKey(poolRow?.strategy_key);
    const stats = statsMap.get(strategyKey) || {};
    const genes = inferGenesFromStrategyKey(strategyKey);

    const totalRounds = toNum(stats?.total_rounds, 0);
    const totalCost = toNum(stats?.total_cost, 0);
    const totalReward = toNum(stats?.total_reward, 0);
    const totalProfit = totalReward - totalCost;
    const avgHit =
      totalRounds > 0 ? toNum(stats?.total_hits, 0) / totalRounds : 0;
    const roi = totalCost > 0 ? totalProfit / totalCost : 0;
    const recentRoi50 = toNum(stats?.recent_50_roi, 0);
    const scorePenalty = recentRoi50 < -0.5 ? 0.3 : recentRoi50 < -0.3 ? 0.6 : recentRoi50 < 0 ? 0.85 : 1.0;
    // ✅ 三星評分：移除 hit4*160，加入 hit2 和覆蓋命中率
    const avgCoverageHit = toNum(stats?.avg_coverage_hit, 0);
    const coverageBonus = avgCoverageHit > 6 ? (avgCoverageHit - 6) * 30 : 0;
    const score = round4(
      (totalProfit +
        avgHit * 60 +              // 三星理論avg_hit=0.75，降低權重
        toNum(stats?.hit2, 0) * 8 + // 三星hit2是主要回血，加入計算
        toNum(stats?.hit3, 0) * 90 + // hit3最重要
        coverageBonus) * scorePenalty
    );

    const recent = calcRecentRates(stats);
    const marketFit = calcMarketBoost(strategyKey, marketSnapshot, market);
    const row = {
      ...poolRow,
      ...stats,
      strategy_key: strategyKey,
      strategy_name: poolRow?.strategy_name || strategyLabel(strategyKey),
      gene_a: poolRow?.gene_a || genes.gene_a,
      gene_b: poolRow?.gene_b || genes.gene_b,
      status: String(poolRow?.status || 'active').toLowerCase(),
      total_rounds: totalRounds,
      avg_hit: round4(avgHit),
      roi: round4(roi),
      score,
      market_boost: marketFit.market_boost,
      market_reason: marketFit.market_reason,
      ...recent,
      selection_rank: idx + 1
    };

    row.decision = chooseDecision(row);
    if (!Number.isFinite(row.decision_score)) {
      // ✅ 三星 decision_score：移除 hit4_rate，加入 hit2_rate 和覆蓋命中率
      row.decision_score = round4(
        score * marketFit.market_boost +
          row.hit2_rate * 120 +          // 三星hit2重要
          row.hit3_rate * 280 +          // hit3最重要
          row.recent_50_hit3_rate * 360 +
          toNum(row.avg_coverage_hit, 0) * 15  // 覆蓋命中率加分
      );
    }

    return row;
  });
}

function byPowerDesc(a, b) {
  const decisionDiff = getDecisionRank(b?.decision) - getDecisionRank(a?.decision);
  if (decisionDiff !== 0) return decisionDiff;

  const scoreDiff = toNum(b?.decision_score, 0) - toNum(a?.decision_score, 0);
  if (scoreDiff !== 0) return scoreDiff;

  const hit3Diff =
    toNum(b?.recent_50_hit3_rate, toNum(b?.hit3_rate, 0)) -
    toNum(a?.recent_50_hit3_rate, toNum(a?.hit3_rate, 0));
  if (hit3Diff !== 0) return hit3Diff;

  const roiDiff = toNum(b?.recent_50_roi, toNum(b?.roi, 0)) - toNum(a?.recent_50_roi, toNum(a?.roi, 0));
  if (roiDiff !== 0) return roiDiff;

  return String(a?.strategy_key || '').localeCompare(String(b?.strategy_key || ''));
}

function sortByFormalSelection(a, b) {
  const roleA = String(a?.preferred_role || '');
  const roleB = String(b?.preferred_role || '');
  const roleScore = { attack: 4, extend: 3, guard: 2, recent: 1, mix: 0 };

  const rd = toNum(roleScore[roleB], 0) - toNum(roleScore[roleA], 0);
  if (rd !== 0) return rd;

  return byPowerDesc(a, b);
}

function assignPreferredRole(row = {}, marketSnapshot = {}) {
  const marketReason = String(row?.market_reason || '');
  const key = String(row?.strategy_key || '');

  if (marketReason.includes('streak3') || marketReason.includes('attack_core') || key.includes('hot') || key.includes('repeat')) {
    return 'attack';
  }

  if (marketReason.includes('extend') || key.includes('gap') || key.includes('chase') || key.includes('jump')) {
    return 'extend';
  }

  if (marketReason.includes('guard') || key.includes('guard') || key.includes('balanced') || key.includes('mix')) {
    return 'guard';
  }

  if (marketReason.includes('recent') || key.includes('tail') || key.includes('rotation') || key.includes('split')) {
    return 'recent';
  }

  if ((marketSnapshot?.streak3 || []).length > 0) return 'attack';
  return 'mix';
}

async function fetchStrategyCandidates(db, marketSnapshot = {}, market = {}) {
  await ensureStrategyPoolStrategies();

  const { data: poolRows, error: poolError } = await db
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  if (poolError) throw poolError;

  const strategyKeys = (poolRows || [])
    .map((row) => String(row?.strategy_key || '').trim().toLowerCase())
    .filter(Boolean);

  if (!strategyKeys.length) {
    return [];
  }

  const { data: statsRows, error: statsError } = await db
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .in('strategy_key', strategyKeys);

  if (statsError) throw statsError;

  const merged = mergePoolWithStats(poolRows || [], statsRows || [], marketSnapshot, market);

  return merged
    .filter((row) => !TERMINAL_STATUS.has(String(row?.status || '').toLowerCase()))
    .map((row) => ({
      ...row,
      preferred_role: assignPreferredRole(row, marketSnapshot)
    }))
    .sort(byPowerDesc);
}

function decorateGroupMeta(row = {}, idx = 0, role = 'mix') {
  return {
    strategy_key: String(row.strategy_key),
    strategy_name: String(row.strategy_name || strategyLabel(row.strategy_key)),
    strategy_tier: row.strategy_tier || 'core',
    decision: row.decision,
    selection_rank: idx + 1,
    decision_score: round4(row.decision_score),
    market_boost: round4(row.market_boost),
    market_reason: row.market_reason || '',
    preferred_role: role,
    hit2: toNum(row.hit2, 0),
    hit3: toNum(row.hit3, 0),
    hit4: toNum(row.hit4, 0),
    hit2_rate: round4(row.hit2_rate),
    hit3_rate: round4(row.hit3_rate),
    hit4_rate: round4(row.hit4_rate),
    recent_50_hit_rate: round4(row.recent_50_hit_rate),
    recent_50_hit3_rate: round4(row.recent_50_hit3_rate),
    recent_50_hit4_rate: round4(row.recent_50_hit4_rate),
    recent_50_roi: round4(row.recent_50_roi),
    avg_hit: round4(row.avg_hit),
    total_rounds: toNum(row.total_rounds, 0),
    roi: round4(row.roi),
    score: round4(row.score)
  };
}

function buildPredictionGroups(strategyCandidates = [], market = {}, marketSnapshot = {}, seedBase = 0) {
  const selected = [];
  const usedKeys = new Set();

  const ranked = (Array.isArray(strategyCandidates) ? strategyCandidates : [])
    .map((row) => ({
      ...row,
      preferred_role: row.preferred_role || assignPreferredRole(row, marketSnapshot)
    }))
    .sort(sortByFormalSelection);

  const roleTargets = getPhaseRoleTargets(marketSnapshot?.market_phase);

  for (const role of roleTargets) {
    const candidatesForRole = ranked.filter((row) => row.preferred_role === role);
    const fallback = ranked.filter((row) => row.preferred_role !== role);
    const queue = [...candidatesForRole, ...fallback];

    for (const row of queue) {
      if (selected.length >= BET_GROUP_COUNT) break;

      const key = String(row?.strategy_key || '').trim();
      if (!key || usedKeys.has(key)) continue;

      const rawNums = buildStrategyNums(key, market, marketSnapshot, seedBase + selected.length * 19 + 11, role);
      const pools = buildDecisionPools(market, marketSnapshot);
      const finalNums = forceGroupDifference(rawNums, selected, pools, seedBase + selected.length * 23 + 3);

      if (finalNums.length !== 4) continue;

      const tooClose = selected.some((prev) => countOverlap(prev?.nums || [], finalNums) >= 3);
      if (tooClose) continue;

      usedKeys.add(key);
      selected.push({
        key,
        label: `${role.toUpperCase()}｜${row.strategy_name || strategyLabel(key)}`,
        nums: finalNums,
        meta: decorateGroupMeta(row, selected.length, role)
      });
      break;
    }
  }

  if (selected.length < BET_GROUP_COUNT) {
    for (const row of ranked) {
      if (selected.length >= BET_GROUP_COUNT) break;

      const key = String(row?.strategy_key || '').trim();
      if (!key || usedKeys.has(key)) continue;

      const role = row.preferred_role || 'mix';
      const rawNums = buildStrategyNums(key, market, marketSnapshot, seedBase + selected.length * 29 + 17, role);
      const pools = buildDecisionPools(market, marketSnapshot);
      const finalNums = forceGroupDifference(rawNums, selected, pools, seedBase + selected.length * 31 + 5);

      if (finalNums.length !== 4) continue;

      usedKeys.add(key);
      selected.push({
        key,
        label: `${role.toUpperCase()}｜${row.strategy_name || strategyLabel(key)}`,
        nums: finalNums,
        meta: decorateGroupMeta(row, selected.length, role)
      });
    }
  }

  return normalizeGroups(selected)
    .sort(compareGroupPriorityDesc)
    .slice(0, BET_GROUP_COUNT)
    .map((group, idx) => ({
      ...group,
      meta: {
        ...(group.meta || {}),
        selection_rank: idx + 1
      }
    }));
}

async function fetchMarketRows(db) {
  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(MARKET_LOOKBACK_LIMIT);

  if (error) {
    throw new Error(`fetchMarketRows failed: ${error.message || error}`);
  }

  return Array.isArray(data) ? data : [];
}

async function fetchLatestDraw(db) {
  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`fetchLatestDraw failed: ${error.message || error}`);
  }

  return data || null;
}

async function fetchNextDrawRows(db, sourceDrawNo, targetPeriods = 1) {
  const safeSource = toNum(sourceDrawNo, 0);
  const safeTarget = Math.max(1, toNum(targetPeriods, 1));

  if (!safeSource) return [];

  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('*')
    .gt('draw_no', safeSource)
    .order('draw_no', { ascending: true })
    .limit(safeTarget);

  if (error) {
    throw new Error(`fetchNextDrawRows failed: ${error.message || error}`);
  }

  return Array.isArray(data) ? data : [];
}

async function countCreatedPredictions(db) {
  const { count, error } = await db
    .from(PREDICTIONS_TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('status', 'created');

  if (error) {
    throw new Error(`countCreatedPredictions failed: ${error.message || error}`);
  }

  return toNum(count, 0);
}

function buildCompareHistoryEntry(payload = {}, drawRows = [], latestDrawNumbers = []) {
  return {
    compared_at: new Date().toISOString(),
    hit_count: toNum(payload.hitCount, 0),
    verdict: payload.verdict || 'bad',
    compared_draw_count: Array.isArray(drawRows) ? drawRows.length : 0,
    latest_draw_numbers: uniqueSorted(latestDrawNumbers),
    total_hit: toNum(payload?.compareResult?.total_hit, 0),
    total_cost: toNum(payload?.compareResult?.total_cost, 0),
    total_reward: toNum(payload?.compareResult?.total_reward, 0),
    total_profit: toNum(payload?.compareResult?.total_profit, 0),
    roi: round4(payload?.compareResult?.roi)
  };
}

// ✅ v15：自動 skip 超時的 formal_3star pending 記錄
// 條件：compare_status=pending 且 source_draw_no 落後當前超過 PENDING_TIMEOUT_PERIODS 期
const PENDING_TIMEOUT_PERIODS = 3;

async function autoSkipStalePendingPredictions(db) {
  try {
    const { data: latestDraw } = await db
      .from(DRAWS_TABLE)
      .select('draw_no')
      .order('draw_no', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestDraw?.draw_no) return;
    const latestDrawNo = Number(latestDraw.draw_no);

    // 抓所有 compare_status=pending 且 source_draw_no 落後超過 PENDING_TIMEOUT_PERIODS 期的記錄
    const { data: stale } = await db
      .from(PREDICTIONS_TABLE)
      .select('id, mode, source_draw_no, compare_status')
      .in('mode', COMPARE_MODES)
      .eq('compare_status', 'pending')
      .limit(100);

    if (!Array.isArray(stale) || !stale.length) return;

    const toSkip = stale.filter(row => {
      const source = Number(row.source_draw_no || 0);
      return source > 0 && (latestDrawNo - source) > PENDING_TIMEOUT_PERIODS;
    });

    if (!toSkip.length) return;

    const ids = toSkip.map(r => r.id);
    await db
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'compared',
        compare_status: 'done',
        verdict: 'skip_timeout',
        compared_at: new Date().toISOString()
      })
      .in('id', ids);

    console.log(`[autoSkipStale] skipped ${ids.length} stale pending predictions:`, toSkip.map(r => `${r.mode}#${r.source_draw_no}`).join(', '));
  } catch (err) {
    console.warn('[autoSkipStale] failed:', err.message);
  }
}

async function comparePendingPredictions(db) {
  // ✅ v15：先清理超時的 pending 記錄，避免卡住整條流程
  await autoSkipStalePendingPredictions(db);

  const { data: predictions, error } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .in('mode', COMPARE_MODES)
    .eq('status', 'created')
    .order('created_at', { ascending: true })
    .limit(COMPARE_BATCH_LIMIT);

  if (error) {
    throw new Error(`compare pending prediction fetch failed: ${error.message || error}`);
  }

  const processedByMode = {
    [TEST_MODE]: 0,
    [FORMAL_MODE]: 0,
    'formal_3star': 0
  };

  const waitingByMode = {
    [TEST_MODE]: 0,
    [FORMAL_MODE]: 0,
    'formal_3star': 0
  };

  let processed = 0;
  let waiting = 0;
  const disabledKeysAll = [];

  // ✅ 修復第六階段：用跟 runCreate3StarFormalPrediction 完全相同的方式計算 market_phase
  let liveMarketPhase = 'rotation';
  try {
    const liveMarketRows = await fetchMarketRows(db);
    if (liveMarketRows.length >= 5) {
      const baseSnapshot = buildRecentMarketSignalSnapshot(liveMarketRows, 'numbers');
      const liveMarket = buildMarketState(liveMarketRows);
      const liveSnapshot = enrichMarketSnapshotWithPhase(baseSnapshot, liveMarket);
      liveMarketPhase = liveSnapshot?.market_phase || 'rotation';
      console.log('[comparePending] liveMarketPhase:', liveMarketPhase, 'streak3:', liveSnapshot?.streak3?.length || 0);
    }
  } catch (marketErr) {
    console.warn('[comparePending] liveMarketPhase calc failed:', marketErr.message);
  }

  for (const prediction of predictions || []) {
    const mode = normalizePredictionMode(prediction?.mode);
    const targetPeriods = Math.max(1, toNum(prediction?.target_periods, TARGET_PERIODS));
    const sourceDrawNo = toNum(prediction?.source_draw_no, 0);

    if (!sourceDrawNo) {
      waiting += 1;
      waitingByMode[mode] += 1;
      continue;
    }

    const drawRows = await fetchNextDrawRows(db, sourceDrawNo, targetPeriods);

    if (drawRows.length < targetPeriods) {
      waiting += 1;
      waitingByMode[mode] += 1;
      continue;
    }

    const latestDrawNumbers = parseNums(drawRows[drawRows.length - 1]?.numbers || drawRows[drawRows.length - 1]?.draw_numbers);
    const payload = buildComparePayload({
      groups: prediction?.groups_json || [],
      drawRows,
      costPerGroupPerPeriod: COST_PER_GROUP_PER_PERIOD,
      starMode: prediction?.mode === 'formal_3star' ? 3 : 4
    });

    const comparedAt = new Date().toISOString();
    const existingHistory = safeArray(prediction?.compare_history_json);
    const historyEntry = buildCompareHistoryEntry(payload, drawRows, latestDrawNumbers);
    const compareHistoryJson = [...existingHistory, historyEntry].slice(-20);

    const updatePayload = {
      status: 'compared',
      compare_status: 'done',
      hit_count: toNum(payload.hitCount, 0),
      compare_result: payload.compareResult,
      compare_result_json: payload.compareResult,
      verdict: payload.verdict || 'bad',
      compared_at: comparedAt,
      compared_draw_count: drawRows.length,
      latest_draw_numbers: latestDrawNumbers,
      compare_history_json: compareHistoryJson
    };

    const { error: updateError } = await db
      .from(PREDICTIONS_TABLE)
      .update(updatePayload)
      .eq('id', prediction.id);

    if (updateError) {
      throw new Error(`prediction compare update failed: ${updateError.message || updateError}`);
    }

    const coverageHitMap = new Map(
      (payload.compareResult?.coverage_hit_per_draw || []).map(c => [c.draw_no, c.coverage_hit])
    );
    const detailWithCoverage = (payload.compareResult?.detail || []).map(d => ({
      ...d,
      coverage_hit: coverageHitMap.get(d.draw_no) ?? 0
    }));

    const statsResult = await recordStrategyCompareResult({
      ...payload.compareResult,
      detail: detailWithCoverage,
      star_mode: prediction?.mode === 'formal_3star' ? 3 : 4,  // ✅ 明確帶入星制，讓 recorder 正確判斷保護邏輯
      market_phase: liveMarketPhase,  // ✅ 修復第六階段：用即時計算的 market_phase
      phase_context: {
        market_phase: liveMarketPhase
      }
    });

    if (Array.isArray(statsResult?.disabled_keys) && statsResult.disabled_keys.length) {
      disabledKeysAll.push(...statsResult.disabled_keys);
    }

    processed += 1;
    processedByMode[mode] += 1;
  }

  return {
    ok: true,
    processed,
    waiting,
    processed_by_mode: processedByMode,
    waiting_by_mode: waitingByMode,
    total_candidates: (predictions || []).length,
    compare_modes: [...COMPARE_MODES],
    disabled_keys: [...new Set(disabledKeysAll)]
  };
}

async function spawnStrategiesIfNeeded(db, latestDrawNo = 0) {
  const { data: activeRows, error: activeError } = await db
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  if (activeError) {
    throw new Error(`strategy_pool active fetch failed: ${activeError.message || activeError}`);
  }

  const active = Array.isArray(activeRows) ? activeRows : [];
  const activeCount = active.length;

  if (activeCount >= TARGET_ACTIVE_STRATEGY) {
    return {
      ok: true,
      active_count: activeCount,
      target_active_strategy: TARGET_ACTIVE_STRATEGY,
      max_active_strategy: MAX_ACTIVE_STRATEGY,
      spawned_count: 0,
      spawned_keys: [],
      skipped: true,
      reason: 'target_active_strategy_reached'
    };
  }

  const sorted = active
    .slice()
    .sort((a, b) => String(a?.strategy_key || '').localeCompare(String(b?.strategy_key || '')));

  const existingSet = new Set(
    sorted.map((row) => normalizeStrategyKey(row?.strategy_key)).filter(Boolean)
  );

  const needCount = Math.min(MAX_SPAWN_PER_RUN, TARGET_ACTIVE_STRATEGY - activeCount);
  const spawnedKeys = [];
  const skippedDuplicateKeys = [];

  const nowIso = new Date().toISOString();

  if (!sorted.length) {
    return {
      ok: true,
      active_count: activeCount,
      target_active_strategy: TARGET_ACTIVE_STRATEGY,
      max_active_strategy: MAX_ACTIVE_STRATEGY,
      spawned_count: 0,
      spawned_keys: [],
      skipped_duplicate_keys: [],
      skipped: true,
      reason: 'no_active_strategy_source'
    };
  }

  let attemptCursor = 0;
  let createdCount = 0;
  const maxAttempts = Math.max(needCount * 12, 24);

  while (createdCount < needCount && attemptCursor < maxAttempts) {
    const sourceType = chooseSpawnSourceType(attemptCursor, activeCount);
    const parentA =
      sorted[attemptCursor % Math.max(sorted.length, 1)] || {
        strategy_key: 'mix_balanced',
        generation: 1
      };
    const parentB =
      sorted[(attemptCursor + 7) % Math.max(sorted.length, 1)] || {
        strategy_key: 'hot_repeat',
        generation: 1
      };

    const strategyKey = buildChildStrategyKey(
      parentA?.strategy_key || '',
      parentB?.strategy_key || '',
      sourceType === 'evolved' ? 'mutation' : sourceType,
      attemptCursor + activeCount + 1
    );

    attemptCursor += 1;

    if (!strategyKey) {
      continue;
    }

    if (existingSet.has(strategyKey)) {
      skippedDuplicateKeys.push(strategyKey);
      continue;
    }

    existingSet.add(strategyKey);

    const genes = inferGenesFromStrategyKey(strategyKey);
    const parentGeneration = Math.max(
      toInt(parentA?.generation, 1),
      toInt(parentB?.generation, 1)
    );

    const newRow = {
      strategy_key: strategyKey,
      strategy_name: strategyLabel(strategyKey),
      gene_a: genes.gene_a,
      gene_b: genes.gene_b,
      status: 'active',
      generation: parentGeneration + 1,
      parent_a_key: parentA?.strategy_key || null,
      parent_b_key: sourceType !== 'mutation' ? (parentB?.strategy_key || null) : null,
      spawn_source: sourceType,
      spawn_draw_no: latestDrawNo || null,
      protected_rank: null,
      created_at: nowIso,
      updated_at: nowIso
    };

    const { error: insertError } = await db
      .from(STRATEGY_POOL_TABLE)
      .insert(newRow);

    if (insertError) {
      if (
        String(insertError?.code || '') === '23505' ||
        String(insertError?.message || '').includes('duplicate')
      ) {
        skippedDuplicateKeys.push(strategyKey);
        continue;
      }
      throw new Error(`strategy spawn insert failed: ${insertError.message || insertError}`);
    }

    spawnedKeys.push(strategyKey);
    createdCount += 1;
  }

  return {
    ok: true,
    active_count: activeCount,
    target_active_strategy: TARGET_ACTIVE_STRATEGY,
    max_active_strategy: MAX_ACTIVE_STRATEGY,
    spawned_count: spawnedKeys.length,
    spawned_keys: spawnedKeys,
    skipped_duplicate_keys: skippedDuplicateKeys,
    skipped: spawnedKeys.length === 0,
    reason: spawnedKeys.length === 0 ? 'all_attempts_duplicate' : ''
  };
}

async function shrinkStrategiesIfNeeded(db) {
  const { data: activeRows, error: activeError } = await db
    .from(STRATEGY_POOL_TABLE)
    .select('strategy_key, status, protected_rank, updated_at')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  if (activeError) {
    throw new Error(`strategy_pool shrink fetch failed: ${activeError.message || activeError}`);
  }

  const active = Array.isArray(activeRows) ? activeRows : [];
  const activeCount = active.length;

  if (activeCount <= SOFT_SHRINK_TRIGGER - 1) {
    return {
      ok: true,
      active_count: activeCount,
      soft_shrink_trigger: SOFT_SHRINK_TRIGGER,
      hard_shrink_trigger: HARD_SHRINK_TRIGGER,
      disabled_count: 0,
      disabled_keys: [],
      skipped: true,
      reason: 'below_soft_trigger'
    };
  }

  const { data: statsRows, error: statsError } = await db
    .from(STRATEGY_STATS_TABLE)
    .select('strategy_key, total_rounds, roi, recent_50_roi, hit3, hit4, score')
    .in(
      'strategy_key',
      active.map((r) => r.strategy_key).filter(Boolean)
    );

  if (statsError) {
    throw new Error(`strategy shrink stats fetch failed: ${statsError.message || statsError}`);
  }

  const statsMap = new Map(
    (statsRows || []).map((row) => [normalizeStrategyKey(row?.strategy_key), row])
  );

  const protectedKeys = new Set(
    active
      .filter((r) => PROTECTED_STATUS.has(String(r?.status || '').toLowerCase()) || r?.protected_rank != null)
      .map((r) => normalizeStrategyKey(r?.strategy_key))
  );

  let shrinkTarget;
  let shrinkMode;

  if (activeCount >= EXTREME_SHRINK_TRIGGER) {
    shrinkTarget = Math.ceil((activeCount - TARGET_ACTIVE_STRATEGY) * 0.6);
    shrinkMode = 'extreme';
  } else if (activeCount >= HARD_SHRINK_TRIGGER) {
    shrinkTarget = Math.ceil((activeCount - TARGET_ACTIVE_STRATEGY) * 0.4);
    shrinkMode = 'hard';
  } else {
    shrinkTarget = Math.ceil((activeCount - MAX_ACTIVE_STRATEGY) * 0.3) + 1;
    shrinkMode = 'soft';
  }

  shrinkTarget = Math.max(1, Math.min(shrinkTarget, activeCount - MIN_ACTIVE_STRATEGY));

  const candidates = active
    .filter((r) => !protectedKeys.has(normalizeStrategyKey(r?.strategy_key)))
    .map((r) => {
      const key = normalizeStrategyKey(r?.strategy_key);
      const stats = statsMap.get(key) || {};
      const totalRounds = toNum(stats?.total_rounds, 0);
      const roi = toNum(stats?.roi, -1);
      const recent50Roi = toNum(stats?.recent_50_roi, -1);
      const hit3 = toNum(stats?.hit3, 0);
      const hit4 = toNum(stats?.hit4, 0);
      const score = toNum(stats?.score, 0);

      // ✅ 三星淘汰分數：移除 hit4*20，加入 hit2 和覆蓋命中率
      const avgCovHit = toNum(stats?.avg_coverage_hit, 0);
      const elimScore =
        totalRounds === 0
          ? -500
          : roi * 30 + recent50Roi * 50 +
            toNum(stats?.hit2, 0) * 3 +    // 三星hit2是主要回血
            hit3 * 15 +                     // hit3最重要
            (avgCovHit > 6 ? (avgCovHit - 6) * 10 : 0) + // 覆蓋命中率高的策略保留
            score * 0.01;

      return { key, elimScore };
    })
    .sort((a, b) => toNum(a.elimScore, 0) - toNum(b.elimScore, 0));

  const toDisable = candidates.slice(0, shrinkTarget).map((c) => c.key);

  if (!toDisable.length) {
    return {
      ok: true,
      active_count: activeCount,
      disabled_count: 0,
      disabled_keys: [],
      skipped: true,
      reason: 'no_candidates_to_disable'
    };
  }

  const nowIso = new Date().toISOString();

  const { error: disableError } = await db
    .from(STRATEGY_POOL_TABLE)
    .update({ status: 'disabled', updated_at: nowIso })
    .in('strategy_key', toDisable);

  if (disableError) {
    throw new Error(`strategy shrink disable failed: ${disableError.message || disableError}`);
  }

  return {
    ok: true,
    active_count: activeCount,
    soft_shrink_trigger: SOFT_SHRINK_TRIGGER,
    hard_shrink_trigger: HARD_SHRINK_TRIGGER,
    shrink_mode: shrinkMode,
    shrink_target: shrinkTarget,
    disabled_count: toDisable.length,
    disabled_keys: toDisable
  };
}

async function createLatestTestPrediction(db, latestDrawNo = 0, marketSnapshot = {}) {
  const existingCreatedCount = await countCreatedPredictions(db);

  if (!ALLOW_CREATE_WHEN_EXISTING && existingCreatedCount > 0) {
    return {
      created_count: 0,
      active_created_prediction: null,
      skipped: true,
      reason: 'existing_pending'
    };
  }

  if (existingCreatedCount >= MAX_CREATED_PREDICTIONS) {
    return {
      created_count: 0,
      active_created_prediction: null,
      skipped: true,
      reason: 'max_created_predictions_reached'
    };
  }

  const sourceDrawNo = latestDrawNo;

  const { data: existingPrediction, error: existingError } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', TEST_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;

  const marketRows = await fetchMarketRows(db);
  const market = buildMarketState(marketRows);

  const strategyCandidates = await fetchStrategyCandidates(db, marketSnapshot, market);

  const seedBase = sourceDrawNo + Date.now() % 10000;
  const groups = buildPredictionGroups(strategyCandidates, market, marketSnapshot, seedBase);

  if (!groups.length) {
    return {
      created_count: 0,
      active_created_prediction: null,
      skipped: true,
      reason: 'no_groups_built'
    };
  }

  const latestDrawNumbers = parseNums(marketRows[0]?.numbers || []);

  const payload = {
    mode: TEST_MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: TARGET_PERIODS,
    groups_json: groups,
    compare_status: 'pending',
    compare_result: null,
    compare_result_json: null,
    hit_count: 0,
    verdict: null,
    latest_draw_numbers: latestDrawNumbers,
    market_snapshot_json: marketSnapshot,
    market_phase: String(marketSnapshot?.market_phase || 'rotation').toLowerCase(),
    market_signal: marketSnapshot?.signal || marketSnapshot?.market_signal || null,
    confidence_score: marketSnapshot?.confidence_score != null ? toNum(marketSnapshot.confidence_score, null) : null,
    weight_profile: marketSnapshot?.weight_profile || null,
    created_at: new Date().toISOString()
  };

  let inserted = null;

  if (existingPrediction?.id) {
    const { data: updated, error: updateError } = await db
      .from(PREDICTIONS_TABLE)
      .update(payload)
      .eq('id', existingPrediction.id)
      .select('*')
      .maybeSingle();

    if (updateError) throw updateError;
    inserted = updated || existingPrediction;
  } else {
    const { data: insertedRow, error: insertError } = await db
      .from(PREDICTIONS_TABLE)
      .insert(payload)
      .select('*')
      .maybeSingle();

    if (insertError) {
      if (isDuplicateDrawModeError(insertError)) {
        return {
          created_count: 0,
          active_created_prediction: null,
          skipped: true,
          reason: 'duplicate_draw_mode'
        };
      }

      throw insertError;
    }

    inserted = insertedRow || null;
  }

  await upsertFormalCandidateFromTest(db, inserted);

  return {
    created_count: inserted?.id ? 1 : 0,
    active_created_prediction: inserted || null,
    skipped: !inserted?.id,
    reason: inserted?.id ? '' : 'insert_failed',
    groups,
    source_draw_no: sourceDrawNo,
    latest_draw_numbers: latestDrawNumbers,
    candidate_count: strategyCandidates.length
  };
}

function buildTopStrategiesSummary(strategyCandidates = []) {
  return (Array.isArray(strategyCandidates) ? strategyCandidates : [])
    .slice(0, 8)
    .map((row, idx) => ({
      rank: idx + 1,
      strategy_key: String(row?.strategy_key || ''),
      strategy_name: String(row?.strategy_name || strategyLabel(row?.strategy_key || '')),
      decision: row?.decision || '',
      decision_score: round4(row?.decision_score),
      market_boost: round4(row?.market_boost),
      market_reason: row?.market_reason || '',
      avg_hit: round4(row?.avg_hit),
      roi: round4(row?.roi),
      hit3_rate: round4(row?.hit3_rate),
      recent_50_hit3_rate: round4(row?.recent_50_hit3_rate)
    }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      api_version: API_VERSION,
      error: 'Method not allowed'
    });
  }

  // ✅ 賓果營業時間：台灣時間 07:00~23:55
  // 00:00~07:00 停止訓練，避免無效資料汙染步驟七的判斷
  const taipeiHour = (new Date().getUTCHours() + 8) % 24;
  if (taipeiHour >= 0 && taipeiHour < 7) {
    console.log(`[cron] 非營業時間 ${taipeiHour}:xx，跳過訓練`);
    return res.status(200).json({
      ok: true,
      api_version: API_VERSION,
      skipped: true,
      reason: '非營業時間 00:00~07:00'
    });
  }

  try {
    const db = getSupabase();

    const compareBeforeCreate = await comparePendingPredictions(db);
    const latestDraw = await fetchLatestDraw(db);
    const latestDrawNo = toNum(latestDraw?.draw_no, 0);

    const marketRows = await fetchMarketRows(db);
    const baseMarketSnapshot = buildRecentMarketSignalSnapshot(marketRows, 'numbers');
    const marketDecision = buildStrategyDecisionFromSnapshot(baseMarketSnapshot);
    let marketSnapshot = {
      ...baseMarketSnapshot,
      ...marketDecision
    };
    const market = buildMarketState(marketRows);
    marketSnapshot = enrichMarketSnapshotWithPhase(marketSnapshot, market);

    // 4star disabled - spawn/shrink/createTestPrediction all stopped
    const spawn = { skipped: true, reason: '4star_disabled' };
    const shrink = { skipped: true, reason: '4star_disabled' };
    const create = { created_count: 0, active_created_prediction: null, skipped: true, reason: '4star_disabled' };

    // ✅ v4: 四星停用後，三星流程直接在 handler 裡呼叫
    // 不再依賴 upsertFormalCandidateFromTest（那個函數需要 test mode predictionRow）
    await create3StarPrediction(db, latestDrawNo, marketSnapshot);

    // ✅ v15：移除 runAutoCompareForLatest（條件 source+1===target 太嚴格，易卡 pending）
    // 統一改由 comparePendingPredictions 處理，內含 autoSkipStalePendingPredictions 保護
    const compareAfterCreate = await comparePendingPredictions(db);

    const strategyCandidates = await fetchStrategyCandidates(db, marketSnapshot, market);
    const activeCreatedPrediction = create?.active_created_prediction || null;
    const displayGroups = normalizeGroups(activeCreatedPrediction?.groups_json || create?.groups || []);

    return res.status(200).json({
      ok: true,
      api_version: API_VERSION,
      compare_modes: [...COMPARE_MODES],
      latest_draw_no: latestDrawNo,
      latest_draw_time: latestDraw?.draw_time || null,
      created_count: toNum(create?.created_count, 0),
      compared_count:
        toNum(compareBeforeCreate?.processed, 0) + toNum(compareAfterCreate?.processed, 0),
      market_snapshot: marketSnapshot,
      market_decision: buildStrategyDecisionFromSnapshot(marketSnapshot),
      top_strategies: buildTopStrategiesSummary(strategyCandidates),
      active_created_prediction: activeCreatedPrediction
        ? {
            id: activeCreatedPrediction?.id || null,
            mode: activeCreatedPrediction?.mode || TEST_MODE,
            status: normalizePredictionStatus(activeCreatedPrediction?.status),
            source_draw_no: activeCreatedPrediction?.source_draw_no || null,
            target_periods: toNum(activeCreatedPrediction?.target_periods, TARGET_PERIODS),
            group_count: displayGroups.length,
            groups: displayGroups
          }
        : null,
      pipeline: {
        compare_before_create: compareBeforeCreate,
        spawn,
        shrink,
        create,
        compare_after_create: compareAfterCreate
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      api_version: API_VERSION,
      error: error?.message || 'Unknown error'
    });
  }
}

// ✅ 三星化 decision score：加重 hit2_rate（三星hit2是主要回血來源）、加入 avg_coverage_hit
function calcDecisionScore(meta={}){
  const h3=Number(meta.recent_50_hit3_rate||0);
  const h2=Number(meta.hit2_rate||0);
  const roi=Number(meta.recent_50_roi||0);
  const coverage=Number(meta.avg_coverage_hit||0);
  const coverageBonus = coverage > 6 ? (coverage - 6) * 5 : 0;
  return h3*80 + h2*40 + Math.max(roi,-1)*10 + coverageBonus;
}



/* =========================
   🔧 DEPRECATED: runAutoCompareForLatest
   v15起已不在主流程呼叫。
   改由 comparePendingPredictions（含 autoSkipStalePendingPredictions）統一處理。
   保留此函數僅供萬一需要手動觸發時使用，內含 timeout skip 保護。
   ========================= */

async function runAutoCompareForLatest(db) {
  // ✅ fix：此函數已 deprecated，liveMarketPhase 在此作用域內無法動態計算
  const liveMarketPhase = 'rotation';
  try {
    const { data: latestDraw } = await db
      .from('bingo_draws')
      .select('draw_no, numbers')
      .order('draw_no', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestDraw?.draw_no) return;

    const targetDrawNo = Number(latestDraw.draw_no);

    // ✅ 加入 formal_3star
    const { data: pending } = await db
      .from('bingo_predictions')
      .select('*')
      .in('mode', ['test', 'formal', 'formal_3star'])
      .eq('compare_status', 'pending')
      .limit(50);

    if (!Array.isArray(pending) || !pending.length) return;

    for (const row of pending) {
      const source = Number(row.source_draw_no || 0);

      // ✅ v15：超過 PENDING_TIMEOUT_PERIODS 期自動 skip，不再永久卡住
      const agePeriods = targetDrawNo - source;
      if (agePeriods > PENDING_TIMEOUT_PERIODS) {
        await db
          .from('bingo_predictions')
          .update({
            status: 'compared',
            compare_status: 'done',
            verdict: 'skip_timeout',
            compared_at: new Date().toISOString()
          })
          .eq('id', row.id);
        console.log(`[runAutoCompare] skip_timeout id=${row.id} mode=${row.mode} source=${source} age=${agePeriods}`);
        continue;
      }

      if (source + 1 !== targetDrawNo) continue;

      // ✅ 根據 mode 決定 starMode
      const starMode = row.mode === 'formal_3star' ? 3 : 4;

      // ✅ 正確傳入 groups + drawRows + starMode
      const payload = buildComparePayload({
        groups: row.groups_json || [],
        drawRows: [latestDraw],
        costPerGroupPerPeriod: COST_PER_GROUP_PER_PERIOD,
        starMode
      });

      const result = payload?.compareResult || null;

      await db
        .from('bingo_predictions')
        .update({
          status: 'compared',
          compare_status: 'done',
          compare_result: result,
          compare_result_json: result,
          hit_count: payload?.hitCount || 0,
          verdict: payload?.verdict || 'bad',
          compared_at: new Date().toISOString(),
          latest_draw_numbers: row.latest_draw_numbers || null
        })
        .eq('id', row.id);

      // ✅ 只有 detail 非空才寫入 strategy_stats
      if (result?.detail?.length) {
        try {
          const coverageHitMap2 = new Map(
            (result?.coverage_hit_per_draw || []).map(c => [c.draw_no, c.coverage_hit])
          );
          const detailWithCoverage2 = (result?.detail || []).map(d => ({
            ...d,
            coverage_hit: coverageHitMap2.get(d.draw_no) ?? 0
          }));

          await recordStrategyCompareResult({
            ...result,
            detail: detailWithCoverage2,
            star_mode: row.mode === 'formal_3star' ? 3 : 4,  // ✅ 明確帶入星制
            market_phase:
              row.market_snapshot_json?.market_phase ||
              row.market_snapshot_json?.phase_context?.market_phase ||
              liveMarketPhase || 'rotation',  // ✅ fallback 到即時計算
            phase_context: {
              market_phase:
                row.market_snapshot_json?.market_phase ||
                row.market_snapshot_json?.phase_context?.market_phase ||
                liveMarketPhase || 'rotation'
            }
          });
        } catch (statsErr) {
          console.warn('[runAutoCompareForLatest] recordStrategyCompareResult failed:', statsErr.message);
        }
      }
    }
  } catch (e) {
    console.error('AUTO COMPARE ERROR', e);
  }
}

/* 👉 v15：已改由 comparePendingPredictions 內的 autoSkipStalePendingPredictions 統一處理 */
// await runAutoCompareForLatest(getSupabase()); // DEPRECATED
