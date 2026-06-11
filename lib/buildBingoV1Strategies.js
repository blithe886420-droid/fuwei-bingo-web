/**
 * buildBingoV1Strategies.js - V0611-2
 *
 * 蜘蛛感知系統 + 太極四象框架
 *
 * 核心原則：
 * - 不是感知到震動就出手
 * - 而是確認是真獵物才閃電出手
 *
 * 真獵物條件（多維度同時滿足）：
 * 1. 時段對了（9-11點或16-18點，命中率15-22%）
 * 2. 號碼夠穩定（換手<=1顆，命中率13-25%）
 * 3. 號碼池夠豐富（候選號碼>=10顆）
 * 4. 有61-80區間號碼（高命中區間）
 *
 * 假信號條件（葉子掉下來，不要衝）：
 * - 候選號碼<5顆（網太破，不出手）
 * - 12-15點（命中率1.92%，用保守策略）
 * - 盤面不對勁（號碼擠同區間）
 * - 醞釀4期但不在高命中時段（命中率0%）
 */

function parseNums(numbers) {
  if (Array.isArray(numbers)) return numbers.map(Number).filter(n => n >= 1 && n <= 80);
  return String(numbers || '').trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 80);
}

function countIn(draws, num) {
  return draws.filter(d => parseNums(d.numbers).includes(num)).length;
}

function makeCombos(nums) {
  const combos = [];
  for (let i = 0; i < nums.length; i++)
    for (let j = i + 1; j < nums.length; j++)
      for (let k = j + 1; k < nums.length; k++)
        combos.push([nums[i], nums[j], nums[k]]);
  return combos;
}

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0, recentPredictions = []) {
  if (recentDraws.length < 20) return [];

  const w1draws = recentDraws.slice(0, 5);
  const w2draws = recentDraws.slice(5, 10);
  const w3draws = recentDraws.slice(10, 15);
  const w4draws = recentDraws.slice(15, 20);

  // ★ 時段感知
  const taipeiHour = (new Date().getUTCHours() + 8) % 24;
  const isHighHour = (taipeiHour >= 9 && taipeiHour <= 11) || (taipeiHour >= 16 && taipeiHour <= 18);
  const isDeadHour = taipeiHour >= 12 && taipeiHour <= 15;

  // ★ 號碼週期分析
  const numStats = [];
  for (let n = 1; n <= 80; n++) {
    const w1cnt = countIn(w1draws, n);
    const inW2 = countIn(w2draws, n) >= 1;
    const inW3 = countIn(w3draws, n) >= 1;
    const inW4 = countIn(w4draws, n) >= 1;

    let period = 0;
    if (w1cnt >= 3 && inW2 && inW3 && inW4) period = 4;
    else if (w1cnt >= 2 && inW2 && inW3) period = 3;
    else if (w1cnt >= 2 && inW2) period = 2;

    if (period > 0) numStats.push({ n, w1cnt, period });
  }

  const fourNums = numStats.filter(s => s.period === 4);
  const threeNums = numStats.filter(s => s.period === 3);
  const twoNums = numStats.filter(s => s.period === 2);
  const fourCount = fourNums.length;
  const threeCount = threeNums.length;
  const twoCount = twoNums.length;
  const totalQualified = numStats.length;

  // ★ 蜘蛛感知第一層：號碼池夠不夠（網是否完整）
  // 候選號碼太少，網有破洞，不出手
  if (totalQualified < 5) {
    console.log(`[buildBingoGroups] 號碼池不足(${totalQualified}顆)，網破洞，不出手`);
    return [];
  }

  // ★ 週期判斷
  const prev3 = recentPredictions.slice(0, 3);
  const consecutiveBurst = prev3.filter(p =>
    p.position === '爆發期' || p.action === '爆發出號'
  ).length;

  let consecutiveZero = 0;
  for (const p of recentPredictions) {
    if (p.hit_count === 0) consecutiveZero++;
    else break;
  }

  const prevHitCount = recentPredictions[0]?.hit_count || 0;
  const prevHotPool = recentPredictions[0]?.hot_pool || '';

  let position = '冷場期';
  let action = '跳過';
  let forcedSwitch = false;

  if (fourCount >= 4 && consecutiveBurst < 2) {
    position = '爆發期'; action = '爆發出號';
  } else if (fourCount >= 4 && consecutiveBurst >= 2) {
    position = '醞釀期'; action = '預備出號';
    forcedSwitch = true;
  } else if (threeCount >= 3 || (fourCount + threeCount) >= 3) {
    position = '醞釀期'; action = '預備出號';
  } else if (twoCount >= 3 || (fourCount + threeCount + twoCount) >= 3) {
    position = '觀察期'; action = '參考出號';
  }

  let brewCount = 0;
  if (position === '醞釀期') {
    brewCount = 1;
    for (const p of recentPredictions) {
      if (p.position === '醞釀期') brewCount++;
      else break;
    }
  }

  if (action === '跳過') {
    console.log(`[buildBingoGroups] 冷場期，不出手`);
    return [];
  }

  // ★ 換手率感知
  const prevPoolNums = prevHotPool.split(',').map(Number).filter(Boolean);
  const allCandidates = [...numStats].sort((a, b) => b.w1cnt - a.w1cnt || b.period - a.period);
  const currentTopNums = allCandidates.slice(0, 5).map(s => s.n);
  const changedNums = currentTopNums.filter(n => !prevPoolNums.includes(n)).length;
  const isFastTurnover = prevPoolNums.length > 0 && changedNums >= 4;
  const isSlowTurnover = prevPoolNums.length > 0 && changedNums <= 1;

  // ★ 盤面感知：前5顆有4顆擠在同一區間
  const topZone = (() => {
    const z1 = allCandidates.slice(0,5).filter(s => s.n <= 20).length;
    const z2 = allCandidates.slice(0,5).filter(s => s.n >= 21 && s.n <= 40).length;
    const z3 = allCandidates.slice(0,5).filter(s => s.n >= 41 && s.n <= 60).length;
    const z4 = allCandidates.slice(0,5).filter(s => s.n >= 61).length;
    return Math.max(z1, z2, z3, z4);
  })();
  const isBadBoard = topZone >= 4;

  // ★ 61-80區間感知
  const zone61to80 = allCandidates.filter(s => s.n >= 61 && s.n <= 80);
  const zone1to20 = allCandidates.filter(s => s.n >= 1 && s.n <= 20);
  const hasHighZone = zone61to80.length >= 2;

  // ★ 蜘蛛感知第二層：真獵物判斷
  // 計算真實信號強度（不是加分，而是條件檢查）
  const signals = {
    isHighHour,           // 時段對了
    isSlowTurnover,       // 換手穩定
    hasHighZone,          // 有高號區號碼
    brewCount4plus: brewCount >= 4 && isHighHour,  // 醞釀4期+高命中時段
    prevHit: prevHitCount >= 2,  // 前1期有中
  };

  const trueSignalCount = Object.values(signals).filter(Boolean).length;

  console.log(`[buildBingoGroups] ${position} 時段=${isHighHour?'高':'普'} 換手=${changedNums} 高號區=${zone61to80.length} 醞釀=${brewCount} 真信號數=${trueSignalCount} 死亡時段=${isDeadHour}`);

  // ★ 選號邏輯（根據感知結果選號）
  let top5;
  let spiderMode = 'normal'; // 記錄用哪個模式選號

  if (forcedSwitch && threeNums.length >= 3) {
    // 強制切換：三週期號碼
    const threeTop = [...threeNums].sort((a, b) => b.w1cnt - a.w1cnt)
      .slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    top5 = threeTop.length >= 3 ? threeTop : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    spiderMode = 'forced_switch';

  } else if (isHighHour) {
    // ★ 高命中時段：61-80最強2顆 + 第3、4、5名（SQL驗證第4、5名貢獻33%）
    const normalTop5 = allCandidates.slice(0, 5);
    if (zone61to80.length >= 2) {
      const best61to80 = zone61to80.slice(0, 2).map(s => s.n);
      const rank345 = normalTop5.slice(2, 5).map(s => s.n);
      const combined = [...new Set([...best61to80, ...rank345])].slice(0, 5).sort((a, b) => a - b);
      top5 = combined.length >= 3 ? combined : normalTop5.map(s => s.n).sort((a, b) => a - b);
    } else if (zone61to80.length === 1) {
      const best61to80 = zone61to80.slice(0, 1).map(s => s.n);
      const rank2345 = normalTop5.slice(1, 5).map(s => s.n);
      const combined = [...new Set([...best61to80, ...rank2345])].slice(0, 5).sort((a, b) => a - b);
      top5 = combined.length >= 3 ? combined : normalTop5.map(s => s.n).sort((a, b) => a - b);
    } else {
      top5 = normalTop5.map(s => s.n).sort((a, b) => a - b);
    }
    spiderMode = 'high_hour';

  } else if (isDeadHour) {
    // ★ 12-15點：保守策略，取第3-7名起熱號
    const rank3to7 = allCandidates.slice(2, 7).map(s => s.n).sort((a, b) => a - b);
    top5 = rank3to7.length >= 3 ? rank3to7 : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    spiderMode = 'dead_hour';

  } else if (isFastTurnover && position === '爆發期') {
    // 換手快+爆發期：優先61-80
    const combined = [...zone61to80, ...allCandidates.filter(s => s.n < 61)].slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    top5 = combined.length >= 3 ? combined : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    spiderMode = 'fast_burst';

  } else if (isBadBoard || position === '觀察期') {
    // 盤面不對勁或觀察期：第3-7名起熱號
    const rank3to7 = allCandidates.slice(2, 7).map(s => s.n).sort((a, b) => a - b);
    top5 = rank3to7.length >= 3 ? rank3to7 : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    spiderMode = 'bad_board';

  } else {
    // 正常：第1名 + 第3-6名（跳過第2名）
    const rank1 = allCandidates.slice(0, 1).map(s => s.n);
    const rank3to6 = allCandidates.slice(2, 6).map(s => s.n);
    const combined = [...rank1, ...rank3to6].sort((a, b) => a - b);
    top5 = combined.length >= 3 ? combined : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    spiderMode = 'normal';
  }

  if (top5.length < 3) {
    console.log(`[buildBingoGroups] 號碼不足3顆，跳過`);
    return [];
  }

  console.log(`[buildBingoGroups] spiderMode=${spiderMode} top5=${top5.join(',')} 真信號=${trueSignalCount}`);

  const combos = makeCombos(top5);
  return combos.map(combo => {
    const key = `h${combo[0]}_${combo[1]}_${combo[2]}`;
    return {
      key, label: key, nums: combo,
      meta: {
        strategy_key: key, strategy_name: key, type: 'hot',
        action, position,
        hot_pool: top5.join(','),
        hot_pool_size: top5.length,
        total_qualified: totalQualified,
        consecutive_burst: consecutiveBurst,
        forced_switch: forcedSwitch,
        brew_count: brewCount,
        consecutive_zero: consecutiveZero,
        prev_hit_count: prevHitCount,
        prev_hot_pool: prevHotPool,
        changed_nums: changedNums,
        is_fast_turnover: isFastTurnover,
        is_slow_turnover: isSlowTurnover,
        is_high_hour: isHighHour,
        is_dead_hour: isDeadHour,
        is_bad_board: isBadBoard,
        true_signal_count: trueSignalCount,
        spider_mode: spiderMode,
        // ★ 蜘蛛感知信號詳情
        sig_high_hour: signals.isHighHour,
        sig_slow_turnover: signals.isSlowTurnover,
        sig_high_zone: signals.hasHighZone,
        sig_brew4_hour: signals.brewCount4plus,
        sig_prev_hit: signals.prevHit,
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
