import { createClient } from '@supabase/supabase-js';

const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';

/**
 * 命中品質導向淘汰版（第四刀：直接開殺）
 * 目標：
 * 1. 讓不會中3的策略更快出局
 * 2. 讓只會保2、但拉不起中3的策略提早被清掉
 * 3. 保留真正有 hit4 / 近期 hit3 爆發能力的策略
 *
 * D版補強：
 * 4. 增加盤型記憶層（phase_stats_json）
 * 5. 每次 compare 後，同步記錄該策略在 continuation / rotation / bias / chaos 下的表現
 * 6. v2：phase 無法辨識時，不丟棄，改歸 continuation 避免統計斷流
 */
// ✅ 完全改寫為三星賓果的淘汰標準
// 三星理論值：avg_hit≈0.75, hit2_rate≈14%, hit3_rate≈1.06%, ROI≈-0.508
// 四星的 avgHitFloor=0.8~1.0 對三星完全不適用（三星理論值才0.75）
// 以覆蓋命中率和 hit2_rate 為主要依據，hit3_rate 為加分項
const DISABLE_RULES = {
  // A: 整體 ROI 太低（三星本來就虧，門檻要更寬鬆）
  minRoundsA: 30,
  roiFloorA: -0.85,
  // B: 近期 ROI 差且 hit2 極低（三星 hit2 理論14%，低於5%才算差）
  minRoundsB: 20,
  recent50RoiFloorB: -0.75,
  avgHitFloorB: 0.4,  // 三星理論avg_hit=0.75，0.4以下才淘汰
  // C: 近期 ROI 差且 hit2 率低（三星 hit2 理論14%，低於5%才算差）
  minRoundsC: 25,
  recent50RoiFloorC: -0.75,
  hitRateFloorC: 0.05,  // 三星hit2率理論14%，5%以下才淘汰
  // D: ROI 差且平均命中極低
  minRoundsD: 25,
  roiFloorD: -0.75,
  avgHitFloorD: 0.35,  // 三星理論0.75，0.35以下才淘汰
  // E: 早期快速淘汰（給新策略更多時間）
  minRoundsE: 30,
  roiFloorE: -0.88,
  // F: 早期命中太低
  minRoundsF: 30,
  avgHitFloorF: 0.3,  // 三星理論0.75，0.3以下才淘汰
  recent50RoiFloorF: -0.80,
  // G: hit3 率低且 ROI 差（三星hit3理論1.06%，0%才算完全沒有）
  minRoundsG: 40,
  hit3RateFloorG: 0.0,  // 三星hit3率1.06%，完全0才淘汰
  recent50RoiFloorG: -0.70,
  avgHitFloorG: 0.5,  // 三星理論0.75，0.5以下才淘汰
  // H: 完全沒有 hit3（三星沒有hit4，所以只看hit3）
  minRoundsH: 50,
  hit3CountFloorH: 0,
  hit4CountFloorH: 0,  // 三星不可能hit4，這條永遠不會觸發
  roiFloorH: -0.70,
  // I: 近期 hit2 極低（三星沒有hit4，改用hit2指標）
  minRoundsI: 25,
  recent50Hit3RateFloorI: 0.0,
  recent50RoiFloorI: -0.75,
  recent50HitRateFloorI: 0.05,  // 三星hit2率理論14%，5%以下才淘汰
  // J: hit2 有但 hit3 完全沒有（放寬，三星hit3本來就少）
  minRoundsJ: 60,
  hit2RateCeilJ: 0.10,  // 三星hit2理論14%，10%以上才算有中2
  hit3RateFloorJ: 0.0,
  recent50RoiFloorJ: -0.70,
  // K: 近期命中率不足
  minRoundsK: 30,
  recent50HitRateFloorK: 0.05,  // 三星hit2率理論14%，5%以下才淘汰
  recent50Hit3RateFloorK: 0.0,
  roiFloorK: -0.75,
  // L: hit3 仍是 0（三星需要更多期才能判斷）
  minRoundsL: 50,
  hit3CountFloorL: 0,
  recent50RoiFloorL: -0.75,
  // M: 近期無 hit3 且命中低（三星沒有hit4）
  minRoundsM: 40,
  recent50Hit3RateFloorM: 0,
  hit4CountFloorM: 0,
  avgHitFloorM: 0.4  // 三星理論0.75，0.4以下才淘汰
};

const PROTECTED_STATUS = new Set(['protected']);
const TERMINAL_STATUS = new Set(['disabled', 'retired']);
const VALID_PHASES = ['continuation', 'rotation', 'bias', 'chaos'];
const PHASE_RECENT_WINDOW = 20;

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

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function tail(arr = [], size = 50) {
  return (Array.isArray(arr) ? arr : []).slice(-size);
}

function safeArrayValue(value) {
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

function safeObjectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function calcRate(numerator, denominator) {
  if (toNum(denominator, 0) <= 0) return 0;
  return toNum(numerator, 0) / toNum(denominator, 0);
}

function calcRecentHitRate(recentHits = []) {
  const arr = Array.isArray(recentHits) ? recentHits : [];
  if (!arr.length) return 0;
  return arr.filter((x) => toNum(x) >= 2).length / arr.length;
}

function calcRecentHit3Rate(recentHits = []) {
  const arr = Array.isArray(recentHits) ? recentHits : [];
  if (!arr.length) return 0;
  return arr.filter((x) => toNum(x) >= 3).length / arr.length;
}

function calcRecentHit4Rate(recentHits = []) {
  const arr = Array.isArray(recentHits) ? recentHits : [];
  if (!arr.length) return 0;
  return arr.filter((x) => toNum(x) >= 4).length / arr.length;
}

function calcShortWindowStats(recentHits = [], windowSize = 10) {
  const arr = tail(Array.isArray(recentHits) ? recentHits : [], windowSize);
  if (!arr.length) {
    return {
      avg_hit: 0,
      hit2_rate: 0,
      hit3_rate: 0,
      hit4_rate: 0,
      zero_one_rate: 1,
      strong_round_rate: 0
    };
  }

  const total = arr.length;
  const sumHits = arr.reduce((acc, value) => acc + toNum(value, 0), 0);
  const hit2Rate = arr.filter((x) => toNum(x) >= 2).length / total;
  const hit3Rate = arr.filter((x) => toNum(x) >= 3).length / total;
  const hit4Rate = arr.filter((x) => toNum(x) >= 4).length / total;
  const zeroOneRate = arr.filter((x) => toNum(x) <= 1).length / total;
  const strongRoundRate = arr.filter((x) => toNum(x) >= 2).length / total;

  return {
    avg_hit: sumHits / total,
    hit2_rate: hit2Rate,
    hit3_rate: hit3Rate,
    hit4_rate: hit4Rate,
    zero_one_rate: zeroOneRate,
    strong_round_rate: strongRoundRate
  };
}

function normalizeMarketPhase(rawPhase = '') {
  const phase = String(rawPhase || '').trim().toLowerCase();
  return VALID_PHASES.includes(phase) ? phase : 'unknown';
}

function normalizePhaseBucket(value) {
  const source = safeObjectValue(value);
  const recentHits = tail(safeArrayValue(source.recent_hits), PHASE_RECENT_WINDOW);
  const recentProfit = tail(safeArrayValue(source.recent_profit), PHASE_RECENT_WINDOW);
  const recentCost = tail(safeArrayValue(source.recent_cost), PHASE_RECENT_WINDOW);

  const rounds = toNum(source.rounds, 0);
  const totalHits = toNum(source.total_hits, 0);
  const totalCost = toNum(source.total_cost, 0);
  const totalReward = toNum(source.total_reward, 0);
  const totalProfit = toNum(source.total_profit, totalReward - totalCost);

  const hit0 = toNum(source.hit0, 0);
  const hit1 = toNum(source.hit1, 0);
  const hit2 = toNum(source.hit2, 0);
  const hit3 = toNum(source.hit3, 0);
  const hit4 = toNum(source.hit4, 0);

  const sumRecentProfit = recentProfit.reduce((a, b) => a + toNum(b, 0), 0);
  const sumRecentCost = recentCost.reduce((a, b) => a + toNum(b, 0), 0);

  return {
    rounds,
    total_hits: totalHits,
    total_cost: totalCost,
    total_reward: totalReward,
    total_profit: totalProfit,
    hit0,
    hit1,
    hit2,
    hit3,
    hit4,
    avg_hit: round4(rounds > 0 ? totalHits / rounds : 0),
    roi: round4(totalCost > 0 ? totalProfit / totalCost : 0),
    hit2_rate: round4(calcRate(hit2, rounds)),
    hit3_rate: round4(calcRate(hit3, rounds)),
    hit4_rate: round4(calcRate(hit4, rounds)),
    recent_hits: recentHits,
    recent_profit: recentProfit,
    recent_cost: recentCost,
    recent_20_hit_rate: round4(calcRecentHitRate(recentHits)),
    recent_20_hit3_rate: round4(calcRecentHit3Rate(recentHits)),
    recent_20_hit4_rate: round4(calcRecentHit4Rate(recentHits)),
    recent_20_roi: round4(sumRecentCost > 0 ? sumRecentProfit / sumRecentCost : 0)
  };
}

function normalizePhaseStatsJson(value) {
  const source = safeObjectValue(value);
  const result = {};
  for (const phase of VALID_PHASES) {
    result[phase] = normalizePhaseBucket(source[phase]);
  }
  return result;
}

function updatePhaseStatsJson(oldValue, marketPhase, hit, cost, reward, profit) {
  const phase = normalizeMarketPhase(marketPhase);
  const phaseStats = normalizePhaseStatsJson(oldValue);

  let finalPhase = phase;
  if (!VALID_PHASES.includes(finalPhase)) {
    // unknown phase 直接跳過，不污染任何 bucket 的統計資料
    return normalizePhaseStatsJson(oldValue);
  }

  const bucket = normalizePhaseBucket(phaseStats[finalPhase] || {});
  bucket.rounds += 1;
  bucket.total_hits += toNum(hit, 0);
  bucket.total_cost += toNum(cost, 0);
  bucket.total_reward += toNum(reward, 0);
  bucket.total_profit = bucket.total_reward - bucket.total_cost;

  const safeHit = toNum(hit, 0);
  if (safeHit <= 0) bucket.hit0 += 1;
  if (safeHit === 1) bucket.hit1 += 1;
  if (safeHit >= 2) bucket.hit2 += 1;
  if (safeHit >= 3) bucket.hit3 += 1;
  if (safeHit >= 4) bucket.hit4 += 1;

  bucket.recent_hits = tail([...(bucket.recent_hits || []), safeHit], PHASE_RECENT_WINDOW);
  bucket.recent_profit = tail([...(bucket.recent_profit || []), toNum(profit, 0)], PHASE_RECENT_WINDOW);
  bucket.recent_cost = tail([...(bucket.recent_cost || []), toNum(cost, 0)], PHASE_RECENT_WINDOW);

  phaseStats[finalPhase] = normalizePhaseBucket(bucket);
  return phaseStats;
}

function calcPhaseBestJson(phaseStatsJson = {}) {
  const phaseStats = normalizePhaseStatsJson(phaseStatsJson);
  const phaseScores = {};

  for (const phase of VALID_PHASES) {
    const bucket = phaseStats[phase];
    const rounds = toNum(bucket.rounds, 0);
    const score =
      bucket.avg_hit * 120 +
      bucket.hit2_rate * 220 +
      bucket.hit3_rate * 420 +
      bucket.hit4_rate * 700 +
      bucket.recent_20_hit_rate * 180 +
      bucket.recent_20_hit3_rate * 320 +
      bucket.recent_20_hit4_rate * 520 +
      bucket.recent_20_roi * 80 +
      Math.min(rounds, 20) * 3;

    phaseScores[phase] = round4(score);
  }

  const bestEntry = Object.entries(phaseScores).sort((a, b) => toNum(b[1], 0) - toNum(a[1], 0))[0] || ['unknown', 0];

  return {
    best_phase: bestEntry[0],
    best_score: round4(bestEntry[1]),
    phase_scores: phaseScores
  };
}

function getMarketPhaseFromCompareResult(compareResult = {}) {
  const phaseFromContext = String(compareResult?.phase_context?.market_phase || '').trim().toLowerCase();
  if (VALID_PHASES.includes(phaseFromContext)) return phaseFromContext;

  const directPhase = String(compareResult?.market_phase || '').trim().toLowerCase();
  if (VALID_PHASES.includes(directPhase)) return directPhase;

  return 'unknown';
}

// ✅ 完全改寫為三星賓果評分邏輯
// 三星沒有 hit4，avg_hit 理論值 0.75，hit2_rate 理論 14%，hit3_rate 理論 1.06%
// 覆蓋命中率（avg_coverage_hit）是最重要的指標：選號跟開獎熱區重疊度
// 移除所有 hit4 相關權重，把 avgHitDelta 基準從1改為0.75
function calcStableScore({
  roi,
  avg_hit,
  recent_50_roi,
  recent_50_hit_rate,
  total_rounds,
  hit2,
  hit3,
  hit4,
  hit2_rate,
  hit3_rate,
  hit4_rate,
  recent_50_hit3_rate,
  recent_50_hit4_rate,
  recent_hits = [],
  // ✅ 新增：覆蓋命中率參數（修正之前用 row?.avg_coverage_hit 的 bug）
  avg_coverage_hit = 0,
  recent_coverage_hit_rate = 0
}) {
  const roiClamped = clamp(roi, -1.2, 1.2);
  const recentRoiClamped = clamp(recent_50_roi, -1.2, 1.2);
  // ✅ 三星 avg_hit 理論值 0.75，基準從1改為0.75
  const avgHitDelta = clamp(avg_hit - 0.75, -0.75, 2.0);
  const hitRateClamped = clamp(recent_50_hit_rate, 0, 1);
  const hit2RateClamped = clamp(hit2_rate, 0, 1);
  const hit3RateClamped = clamp(hit3_rate, 0, 1);
  const recentHit3RateClamped = clamp(recent_50_hit3_rate, 0, 1);
  const roundsClamped = Math.min(40, Math.max(0, total_rounds));

  const recent10 = calcShortWindowStats(recent_hits, 10);
  const recent20 = calcShortWindowStats(recent_hits, 20);

  const recent10Avg = clamp(recent10.avg_hit, 0, 3);
  const recent20Avg = clamp(recent20.avg_hit, 0, 3);
  const recent10Hit2 = clamp(recent10.hit2_rate, 0, 1);
  const recent20Hit2 = clamp(recent20.hit2_rate, 0, 1);
  const recent10Hit3 = clamp(recent10.hit3_rate, 0, 1);
  const recent20Hit3 = clamp(recent20.hit3_rate, 0, 1);
  const recent10ZeroOne = clamp(recent10.zero_one_rate, 0, 1);
  const recent20ZeroOne = clamp(recent20.zero_one_rate, 0, 1);

  const roiPart = roiClamped * 10;
  const recentRoiPart = recentRoiClamped * 8;
  const avgHitPart = avgHitDelta * 70;
  const roundsBonus = roundsClamped * 0.8;

  // ✅ 三星品質分：移除 hit4，加重 hit2_rate（三星hit2是主要回血來源）
  const lifetimeQualityPart =
    hit2RateClamped * 80 +    // 三星hit2重要性大幅提升（從25→80）
    hit3RateClamped * 200 +   // hit3最重要
    recentHit3RateClamped * 160 +
    hitRateClamped * 40;      // 整體hit率（從20→40）
  // ✅ hit4 完全移除，三星不可能hit4

  // ✅ 三星近期真實表現：移除 hit4，加重 hit2
  const recentTruthPart =
    recent10Avg * 120 +
    recent20Avg * 90 +
    recent10Hit2 * 320 +   // 三星hit2加重（從260→320）
    recent20Hit2 * 220 +   // 三星hit2加重（從180→220）
    recent10Hit3 * 600 +   // hit3最重要
    recent20Hit3 * 450;
  // ✅ hit4 完全移除

  const countPart = toNum(hit2, 0) * 2.0 + toNum(hit3, 0) * 12;
  // ✅ hit4 完全移除，hit2權重從0.8→2.0，hit3從9→12

  // ✅ 覆蓋命中率（修正 bug：現在從參數傳入，不再用 row?.avg_coverage_hit）
  // 三星8組覆蓋24個號碼，開獎20個，理論覆蓋命中 = 24×20/80 = 6
  // 高於6代表選號跟開獎熱區重疊多，是真正有效的策略
  const coveragePart = avg_coverage_hit > 6 ? (avg_coverage_hit - 6) * 50 :
                       avg_coverage_hit > 0 && avg_coverage_hit < 5 ? (avg_coverage_hit - 5) * 35 : 0;
  const recentCoveragePart = recent_coverage_hit_rate > 6 ? (recent_coverage_hit_rate - 6) * 40 :
                              recent_coverage_hit_rate > 0 && recent_coverage_hit_rate < 5 ? (recent_coverage_hit_rate - 5) * 25 : 0;

  // ✅ 三星誠實調整：移除 hit4 相關，加重 hit2 指標
  let honestyAdjustment = 0;
  if (recent10Hit2 >= 0.20) honestyAdjustment += 80;   // 三星hit2理論14%，20%以上算優秀
  if (recent10Hit2 >= 0.35) honestyAdjustment += 60;
  if (recent20Hit2 >= 0.20) honestyAdjustment += 50;
  if (recent10Hit3 >= 0.03) honestyAdjustment += 130;  // 三星hit3理論1%，3%以上算優秀
  if (recent10Hit3 >= 0.06) honestyAdjustment += 100;
  if (recent20Hit3 >= 0.03) honestyAdjustment += 90;
  // 懲罰：hit2 太低
  if (recent10ZeroOne >= 0.85) honestyAdjustment -= 200;  // 10期全都0或1，扣分
  if (recent20ZeroOne >= 0.80) honestyAdjustment -= 160;
  if (recent10Hit2 <= 0.05) honestyAdjustment -= 140;    // hit2率低於5%扣分（三星理論14%）
  if (recent20Hit2 <= 0.08) honestyAdjustment -= 100;
  if (recent10Hit3 <= 0.0) honestyAdjustment -= 60;      // 近10期完全沒中3扣分
  if (recentRoiClamped < -0.7 && recent20Hit2 < 0.10 && recent10Hit3 <= 0.0) {
    honestyAdjustment -= 150;
  }

  return round4(
    roiPart +
      recentRoiPart +
      avgHitPart +
      roundsBonus +
      lifetimeQualityPart +
      recentTruthPart +
      countPart +
      coveragePart +
      recentCoveragePart +
      honestyAdjustment
  );
}

function shouldDisableStrategy(row = {}) {
  const roi = toNum(row?.roi);
  const avgHit = toNum(row?.avg_hit);
  const recent50Roi = toNum(row?.recent_50_roi);
  const recent50HitRate = toNum(row?.recent_50_hit_rate);
  const recent50Hit3Rate = toNum(row?.recent_50_hit3_rate);
  const totalRounds = toNum(row?.total_rounds);
  const hit2 = toNum(row?.hit2);
  const hit3 = toNum(row?.hit3);
  const hit4 = toNum(row?.hit4);
  const hit2Rate = toNum(row?.hit2_rate);
  const hit3Rate = toNum(row?.hit3_rate);
  const hit4Rate = toNum(row?.hit4_rate);
  const recentHits = safeArrayValue(row?.recent_hits);
  const recent10 = calcShortWindowStats(recentHits, 10);
  const recent20 = calcShortWindowStats(recentHits, 20);

  // ✅ 修正二：覆蓋命中率作為淘汰保護和加速淘汰的依據
  // 覆蓋命中率理論值是 6（24覆蓋 × 20/80）
  // 高於 6.5 → 選號跟開獎熱區高度重疊，強制保留
  // 低於 4.5 → 選號完全偏離開獎熱區，加速淘汰
  const avgCoverageHit = toNum(row?.avg_coverage_hit, 0);
  const recentCoverageHitRate = toNum(row?.recent_coverage_hit_rate, 0);
  const effectiveCoverage = recentCoverageHitRate > 0 ? recentCoverageHitRate : avgCoverageHit;

  if (effectiveCoverage >= 6.5) {
    return { shouldDisable: false, reason: '' }; // 覆蓋率優秀，強制保留
  }
  if (effectiveCoverage > 0 && effectiveCoverage < 4.5 && totalRounds >= 30) {
    return { shouldDisable: true, reason: 'low_coverage_hit_below_4.5_after_30_rounds' }; // 覆蓋率太低加速淘汰
  }

  // ✅ 三星保護條件：移除 hit4Rate（三星不可能hit4），降低 avgHit 門檻（三星理論0.75）
  // hit2_rate 高的策略保留（三星hit2是主要回血來源）
  if (recent50Hit3Rate >= 0.03 || hit3Rate >= 0.03 || avgHit >= 1.0 ||
      recent10.hit3_rate >= 0.03 || recent20.hit3_rate >= 0.03 ||
      hit2Rate >= 0.20 || recent10.hit2_rate >= 0.20) {
    return { shouldDisable: false, reason: '' };
  }
  if (totalRounds >= 8 && recent10.hit2_rate <= 0.1 && recent20.hit2_rate <= 0.15 && recent20.hit3_rate <= 0.01) {
    return { shouldDisable: true, reason: 'recent_low_hit2_and_no_hit3' };
  }
  if (totalRounds >= DISABLE_RULES.minRoundsA && roi < DISABLE_RULES.roiFloorA) return { shouldDisable: true, reason: `roi_below_${DISABLE_RULES.roiFloorA}_after_${DISABLE_RULES.minRoundsA}` };
  if (totalRounds >= DISABLE_RULES.minRoundsB && recent50Roi < DISABLE_RULES.recent50RoiFloorB && avgHit < DISABLE_RULES.avgHitFloorB) return { shouldDisable: true, reason: `recent50_roi_below_${DISABLE_RULES.recent50RoiFloorB}_and_avg_hit_below_${DISABLE_RULES.avgHitFloorB}` };
  if (totalRounds >= DISABLE_RULES.minRoundsC && recent50Roi < DISABLE_RULES.recent50RoiFloorC && recent50HitRate < DISABLE_RULES.hitRateFloorC) return { shouldDisable: true, reason: `recent50_roi_below_${DISABLE_RULES.recent50RoiFloorC}_and_hit_rate_below_${DISABLE_RULES.hitRateFloorC}` };
  if (totalRounds >= DISABLE_RULES.minRoundsD && roi < DISABLE_RULES.roiFloorD && avgHit < DISABLE_RULES.avgHitFloorD) return { shouldDisable: true, reason: `roi_below_${DISABLE_RULES.roiFloorD}_and_avg_hit_below_${DISABLE_RULES.avgHitFloorD}` };
  if (totalRounds >= DISABLE_RULES.minRoundsE && roi < DISABLE_RULES.roiFloorE) return { shouldDisable: true, reason: `early_fail_roi_below_${DISABLE_RULES.roiFloorE}_after_${DISABLE_RULES.minRoundsE}` };
  if (totalRounds >= DISABLE_RULES.minRoundsF && avgHit < DISABLE_RULES.avgHitFloorF && recent50Roi < DISABLE_RULES.recent50RoiFloorF) return { shouldDisable: true, reason: `early_fail_avg_hit_below_${DISABLE_RULES.avgHitFloorF}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorF}` };
  if (totalRounds >= DISABLE_RULES.minRoundsG && hit3Rate < DISABLE_RULES.hit3RateFloorG && recent50Roi < DISABLE_RULES.recent50RoiFloorG && avgHit < DISABLE_RULES.avgHitFloorG) return { shouldDisable: true, reason: `low_hit3_rate_below_${DISABLE_RULES.hit3RateFloorG}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorG}` };
  if (totalRounds >= DISABLE_RULES.minRoundsH && hit3 <= DISABLE_RULES.hit3CountFloorH && hit4 <= DISABLE_RULES.hit4CountFloorH && roi < DISABLE_RULES.roiFloorH) return { shouldDisable: true, reason: `no_hit3_hit4_after_${DISABLE_RULES.minRoundsH}_and_roi_below_${DISABLE_RULES.roiFloorH}` };
  if (totalRounds >= DISABLE_RULES.minRoundsI && recent50Hit3Rate < DISABLE_RULES.recent50Hit3RateFloorI && recent50Roi < DISABLE_RULES.recent50RoiFloorI && recent50HitRate < DISABLE_RULES.recent50HitRateFloorI) return { shouldDisable: true, reason: `recent50_hit3_rate_below_${DISABLE_RULES.recent50Hit3RateFloorI}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorI}` };
  if (totalRounds >= DISABLE_RULES.minRoundsJ && hit2Rate >= DISABLE_RULES.hit2RateCeilJ && hit3Rate < DISABLE_RULES.hit3RateFloorJ && recent50Roi < DISABLE_RULES.recent50RoiFloorJ) return { shouldDisable: true, reason: `high_hit2_rate_but_low_hit3_rate_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorJ}` };
  if (totalRounds >= DISABLE_RULES.minRoundsK && recent50HitRate >= DISABLE_RULES.recent50HitRateFloorK && recent50Hit3Rate < DISABLE_RULES.recent50Hit3RateFloorK && roi < DISABLE_RULES.roiFloorK) return { shouldDisable: true, reason: `recent50_hit_rate_ok_but_recent50_hit3_rate_too_low_and_roi_below_${DISABLE_RULES.roiFloorK}` };
  if (totalRounds >= DISABLE_RULES.minRoundsL && hit3 <= DISABLE_RULES.hit3CountFloorL && recent50Roi < DISABLE_RULES.recent50RoiFloorL) return { shouldDisable: true, reason: `hit3_still_zero_after_${DISABLE_RULES.minRoundsL}_and_recent50_roi_below_${DISABLE_RULES.recent50RoiFloorL}` };
  if (totalRounds >= DISABLE_RULES.minRoundsM && recent50Hit3Rate <= DISABLE_RULES.recent50Hit3RateFloorM && hit4 <= DISABLE_RULES.hit4CountFloorM && avgHit < DISABLE_RULES.avgHitFloorM) return { shouldDisable: true, reason: `no_recent_hit3_no_hit4_and_avg_hit_below_${DISABLE_RULES.avgHitFloorM}` };
  return { shouldDisable: false, reason: '' };
}

async function getPoolStatusMap(supabase, strategyKeys = []) {
  const safeKeys = [...new Set((Array.isArray(strategyKeys) ? strategyKeys : []).filter(Boolean))];
  if (!safeKeys.length) return new Map();

  const { data, error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('strategy_key, status, protected_rank')
    .in('strategy_key', safeKeys);

  if (error) {
    throw new Error(`strategy_pool select failed: ${error.message || error}`);
  }

  return new Map(
    (data || []).map((row) => [
      String(row?.strategy_key || '').trim(),
      {
        status: String(row?.status || '').trim().toLowerCase(),
        protected_rank: Boolean(row?.protected_rank)
      }
    ])
  );
}

async function disableStrategies(supabase, strategyKeys = [], reasonMap = {}) {
  const finalKeys = [...new Set((Array.isArray(strategyKeys) ? strategyKeys : []).filter(Boolean))];
  if (!finalKeys.length) {
    return { updated: 0, disabled_keys: [] };
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .update({ status: 'disabled', updated_at: nowIso })
    .in('strategy_key', finalKeys);

  if (error) {
    throw new Error(`strategy_pool disable update failed: ${error.message || error}`);
  }

  return {
    updated: finalKeys.length,
    disabled_keys: finalKeys,
    disabled_reason_map: reasonMap
  };
}

export async function recordStrategyCompareResult(compareResult) {
  if (!compareResult || typeof compareResult !== 'object') {
    throw new Error('compareResult missing or invalid');
  }

  const supabase = getSupabase();
  const detail = Array.isArray(compareResult.detail) ? compareResult.detail : [];
  if (detail.length === 0) {
    throw new Error('compareResult.detail missing or empty');
  }

  const marketPhase = getMarketPhaseFromCompareResult(compareResult);
  const uniqueKeys = [...new Set(detail.map((row) => String(row?.strategy_key || '').trim()).filter(Boolean))];
  const poolStatusMap = await getPoolStatusMap(supabase, uniqueKeys);

  const updatedKeys = [];
  const disabledKeys = [];
  const disabledReasonMap = {};

  for (const row of detail) {
    const key = String(row?.strategy_key || '').trim();
    if (!key) {
      console.warn('[strategyStatsRecorder] strategy_key missing, skipping row:', JSON.stringify(row));
      continue;  // ✅ 修正：單筆沒有 key 跳過，不中斷整個 loop
    }

    // ✅ 修正：strategy_pool 找不到的 key 也要繼續處理（不能因為 pool 沒有就跳過）
    const poolInfo = poolStatusMap.get(key) || { status: 'active', protected_rank: false };
    const currentStatus = String(poolInfo.status || 'active').trim().toLowerCase();
    if (TERMINAL_STATUS.has(currentStatus)) continue;

    const hit = toNum(row?.hit);
    const cost = toNum(row?.cost);
    const reward = toNum(row?.reward);
    const profit = reward - cost;
    const hit2Add = hit >= 2 ? 1 : 0;
    const hit3Add = hit >= 3 ? 1 : 0;
    const hit4Add = hit >= 4 ? 1 : 0;

    const { data: old, error: oldError } = await supabase
      .from(STRATEGY_STATS_TABLE)
      .select('*')
      .eq('strategy_key', key)
      .maybeSingle();

    if (oldError) {
      console.warn(`[strategyStatsRecorder] strategy_stats select failed for ${key}, skipping:`, oldError.message);
      continue;  // ✅ 單筆查詢失敗跳過，不中斷
    }

    const oldRecentHits = safeArrayValue(old?.recent_hits);
    const oldRecentProfit = safeArrayValue(old?.recent_profit);
    const oldRecentCost = safeArrayValue(old?.recent_cost);

    const total_rounds = toNum(old?.total_rounds) + 1;
    const total_hits = toNum(old?.total_hits) + hit;
    const total_cost = toNum(old?.total_cost) + cost;
    const total_reward = toNum(old?.total_reward) + reward;
    const total_profit = total_reward - total_cost;
    const hit2 = toNum(old?.hit2) + hit2Add;
    const hit3 = toNum(old?.hit3) + hit3Add;
    const hit4 = toNum(old?.hit4) + hit4Add;
    const avg_hit = total_rounds > 0 ? total_hits / total_rounds : 0;
    const roi = total_cost > 0 ? total_profit / total_cost : 0;

    const recent_hits = tail([...oldRecentHits, hit]);
    const recent_profit = tail([...oldRecentProfit, profit]);
    const recent_cost = tail([...oldRecentCost, cost]);
    const sumRecentProfit = recent_profit.reduce((a, b) => a + toNum(b), 0);
    const sumRecentCost = recent_cost.reduce((a, b) => a + toNum(b), 0);

    const recent_50_roi = sumRecentCost > 0 ? sumRecentProfit / sumRecentCost : 0;
    const recent_50_hit_rate = calcRecentHitRate(recent_hits);
    const recent_50_hit3_rate = calcRecentHit3Rate(recent_hits);
    const recent_50_hit4_rate = calcRecentHit4Rate(recent_hits);
    const hit2_rate = calcRate(hit2, total_rounds);
    const hit3_rate = calcRate(hit3, total_rounds);
    const hit4_rate = calcRate(hit4, total_rounds);

    // ✅ 先計算覆蓋率（必須在 calcStableScore 之前）
    const coverageHit = toNum(row?.coverage_hit, 0);
    const oldRecentCoverageHits = safeArrayValue(old?.recent_coverage_hits);
    const recent_coverage_hits = tail([...oldRecentCoverageHits, coverageHit]);
    const total_coverage_hits = toNum(old?.total_coverage_hits, 0) + coverageHit;
    const avg_coverage_hit = total_rounds > 0 ? round4(total_coverage_hits / total_rounds) : 0;
    const recent_coverage_hit_rate = recent_coverage_hits.length > 0
      ? round4(recent_coverage_hits.slice(-50).reduce((a, b) => a + toNum(b, 0), 0) / recent_coverage_hits.slice(-50).length)
      : 0;

    // ✅ 現在才呼叫 calcStableScore，avg_coverage_hit 已經初始化
    const score = calcStableScore({
      roi,
      avg_hit,
      recent_50_roi,
      recent_50_hit_rate,
      total_rounds,
      hit2,
      hit3,
      hit4,
      hit2_rate,
      hit3_rate,
      hit4_rate,
      recent_50_hit3_rate,
      recent_50_hit4_rate,
      recent_hits,
      avg_coverage_hit,
      recent_coverage_hit_rate
    });

    const phase_stats_json = updatePhaseStatsJson(old?.phase_stats_json, marketPhase, hit, cost, reward, profit);
    const phase_best_json = calcPhaseBestJson(phase_stats_json);

    const hit0 = toNum(old?.hit0) + (hit <= 0 ? 1 : 0);
    const hit1 = toNum(old?.hit1) + (hit === 1 ? 1 : 0);

    const lastResultDrawNo = toNum(
      row?.draw_no ||
      compareResult?.draw_no ||
      compareResult?.compare_draw_no ||
      old?.last_result_draw_no,
      0
    );

    const nowIso = new Date().toISOString();

    const payload = {
      strategy_key: key,
      total_rounds,
      total_hits,
      total_cost,
      total_reward,
      total_profit,
      avg_hit: round4(avg_hit),
      roi: round4(roi),
      recent_hits,
      recent_profit,
      recent_cost,
      recent_50_roi: round4(recent_50_roi),
      recent_50_hit_rate: round4(recent_50_hit_rate),
      recent_50_hit3_rate: round4(recent_50_hit3_rate),
      recent_50_hit4_rate: round4(recent_50_hit4_rate),
      hit0,
      hit1,
      hit2,
      hit3,
      hit4,
      hit2_rate: round4(hit2_rate),
      hit3_rate: round4(hit3_rate),
      hit4_rate: round4(hit4_rate),
      phase_stats_json,
      phase_best_json,
      score,
      last_result_draw_no: lastResultDrawNo,
      last_updated: nowIso,
      updated_at: nowIso,
      // ✅ 新增覆蓋率欄位
      total_coverage_hits,
      avg_coverage_hit,
      recent_coverage_hits,
      recent_coverage_hit_rate
    };

    const { error: upsertError } = await supabase
      .from(STRATEGY_STATS_TABLE)
      .upsert(payload, { onConflict: 'strategy_key' });

    if (upsertError) {
      console.warn(`[strategyStatsRecorder] strategy_stats upsert failed for ${key}, skipping:`, upsertError.message);
      continue;  // ✅ 單筆寫入失敗跳過，不中斷
    }

    updatedKeys.push(key);

    if (poolInfo.protected_rank || PROTECTED_STATUS.has(currentStatus)) {
      continue;
    }

    // ✅ 三星模式保護：
    // 判斷方式：優先用 compareResult.star_mode（由 auto-train 明確帶入）
    // fallback：從 detail 中任一筆 reward=50 或 500 判斷（三星獎金結構）
    // 關鍵修正：中0/中1時 reward=0，不能只靠當前 row.reward 判斷
    const starModeFromResult = toNum(compareResult?.star_mode, 0);
    const is3starMode = starModeFromResult === 3 ||
      (starModeFromResult === 0 &&
        detail.some(d => toNum(d?.reward, 0) === 50 || toNum(d?.reward, 0) === 500));

    if (is3starMode) {
      // 三星用更合理的淘汰標準：
      // 30期後 hit2+hit3 都是 0 → 淘汰（三星中2率約14%，30期沒中2概率極低）
      const threeStar_shouldDisable = payload.total_rounds >= 30 &&
        payload.hit2 === 0 && payload.hit3 === 0;
      if (threeStar_shouldDisable) {
        disabledKeys.push(key);
        disabledReasonMap[key] = 'three_star_no_hit2_after_30';
      }
      continue;
    }

    const disableCheck = shouldDisableStrategy(payload);
    if (disableCheck.shouldDisable) {
      disabledKeys.push(key);
      disabledReasonMap[key] = disableCheck.reason;
    }
  }

  const finalDisabledKeys = [...new Set(disabledKeys)];
  let disableResult = { updated: 0, disabled_keys: [], disabled_reason_map: {} };
  if (finalDisabledKeys.length > 0) {
    disableResult = await disableStrategies(supabase, finalDisabledKeys, disabledReasonMap);
  }

  return {
    ok: true,
    market_phase: marketPhase,
    updated_keys: [...new Set(updatedKeys)],
    disabled_keys: disableResult.disabled_keys || [],
    disabled_reason_map: disableResult.disabled_reason_map || {},
    disabled_count: toNum(disableResult.updated, 0)
  };
}
