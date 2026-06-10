/**
 * buildBingoV1Strategies.js - v37 換手感知+選號優化版
 *
 * SQL驗證結論：
 * 1. 爆發期連續>=2期 → 強制切換醞釀期（第3期後命中率0%）
 * 2. 換手快(>=4顆)+爆發期 → 命中率12.82%（比醞釀期6.25%更高）
 * 3. 換手慢(<=1顆) → 命中率13-25%，最強信號
 * 4. 號碼集中61-80 → 命中率17-21%，優先選高號區
 * 5. 第1名熱號貢獻度74%，必須出現在所有組合
 *
 * 選號邏輯：
 * - 換手慢：正常取top5全排列
 * - 換手快+爆發期：優先選61-80區間號碼
 * - 強制切換：用三週期號碼
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

  // 台灣時間（UTC+8）
  const taipeiHour = (new Date().getUTCHours() + 8) % 24;
  // 12-15點只做UI提示，不改變選號邏輯（數據樣本不足，不強制降級）
  const isLowConfidenceHour = taipeiHour >= 12 && taipeiHour <= 15;

  // 計算每顆號碼的週期分類和 w1 次數
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

    if (period > 0) {
      numStats.push({ n, w1cnt, period });
    }
  }

  const fourNums = numStats.filter(s => s.period === 4);
  const threeNums = numStats.filter(s => s.period === 3);
  const twoNums = numStats.filter(s => s.period === 2);
  const fourCount = fourNums.length;
  const threeCount = threeNums.length;
  const twoCount = twoNums.length;

  // ★ 計算連續爆發期次數
  const prev3 = recentPredictions.slice(0, 3);
  const consecutiveBurst = prev3.filter(p =>
    p.position === '爆發期' || p.action === '爆發出號'
  ).length;

  // ★ 計算連續醞釀期次數
  let brewCount = 0;

  // ★ 計算連續未中次數
  let consecutiveZero = 0;
  for (const p of recentPredictions) {
    if (p.hit_count === 0) consecutiveZero++;
    else break;
  }

  // ★ 前一期命中數和熱號池（用於換手率計算）
  const prevHitCount = recentPredictions[0]?.hit_count || 0;
  const prevHotPool = recentPredictions[0]?.hot_pool || '';

  // ★ 判斷本期狀態
  let position = '冷場期';
  let action = '跳過';
  let forcedSwitch = false;

  if (fourCount >= 4 && consecutiveBurst < 2) {
    // 爆發期：連續<2期才正常出號（第1-2期）
    position = '爆發期';
    action = '爆發出號';
  } else if (fourCount >= 4 && consecutiveBurst >= 2) {
    // ★ 爆發期連續>=2期：強制切換醞釀期邏輯
    position = '醞釀期';
    action = '預備出號';
    forcedSwitch = true;
    console.log(`[buildBingoGroups] 爆發期連續${consecutiveBurst+1}期，強制切換醞釀期`);
  } else if (threeCount >= 3 || (fourCount + threeCount) >= 3) {
    position = '醞釀期';
    action = '預備出號';
  } else if (twoCount >= 3 || (fourCount + threeCount + twoCount) >= 3) {
    position = '觀察期';
    action = '參考出號';
  }

  // ★ 計算連續醞釀期次數（只有醞釀期才有意義）
  if (position === '醞釀期') {
    brewCount = 1;
    for (const p of recentPredictions) {
      if (p.position === '醞釀期') brewCount++;
      else break;
    }
  }

  console.log(`[buildBingoGroups] ${position} action=${action} 四=${fourCount} 三=${threeCount} 二=${twoCount} 連續爆發=${consecutiveBurst} 醞釀=${brewCount} 連續未中=${consecutiveZero} 低信心時段=${isLowConfidenceHour}`);

  if (action === '跳過' || numStats.length < 3) {
    console.log(`[buildBingoGroups] 冷場期，無符合號碼`);
    return [];
  }

  // ★ 換手率計算（SQL22：換手率影響選號策略）
  const prevPoolNums = prevHotPool.split(',').map(Number).filter(Boolean);
  const allCandidates = [...numStats].sort((a, b) => b.w1cnt - a.w1cnt || b.period - a.period);
  const currentTopNums = allCandidates.slice(0, 5).map(s => s.n);
  const changedNums = currentTopNums.filter(n => !prevPoolNums.includes(n)).length;
  const isFastTurnover = prevPoolNums.length > 0 && changedNums >= 4;
  const isSlowTurnover = prevPoolNums.length > 0 && changedNums <= 1;

  console.log(`[buildBingoGroups] 換手=${changedNums}顆 快換=${isFastTurnover} 慢換=${isSlowTurnover}`);

  // ★ 高命中時段判斷（SQL驗證：9-11點和16-18點命中率15%+）
  const isHighHour = (taipeiHour >= 9 && taipeiHour <= 11) || (taipeiHour >= 16 && taipeiHour <= 18);

  // ★ 選號邏輯（根據時段、換手率和狀態調整）
  let top5;

  if (forcedSwitch && threeNums.length >= 3) {
    // 強制切換：用三週期號碼
    const threeTop = [...threeNums]
      .sort((a, b) => b.w1cnt - a.w1cnt)
      .slice(0, 5)
      .map(s => s.n)
      .sort((a, b) => a - b);
    top5 = threeTop.length >= 3 ? threeTop : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);

  } else if (isHighHour) {
    // ★ 高命中時段（SQL：時段+61-80區間命中率28%）
    // 優先選61-80區間的號碼，不足再補其他區間
    const highZoneNums = allCandidates.filter(s => s.n >= 61 && s.n <= 80);
    const otherNums = allCandidates.filter(s => s.n < 61 || s.n > 80);
    const combined = [...highZoneNums, ...otherNums].slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    top5 = combined.length >= 3 ? combined : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    console.log(`[buildBingoGroups] 高命中時段選號 高號區=${highZoneNums.length}顆 top5=${top5.join(',')}`);

  } else if (isFastTurnover && position === '爆發期') {
    // 換手快+爆發期：也優先選61-80區間
    const highZoneNums = allCandidates.filter(s => s.n >= 61 && s.n <= 80);
    const otherNums = allCandidates.filter(s => s.n < 61 || s.n > 80);
    const combined = [...highZoneNums, ...otherNums].slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    top5 = combined.length >= 3 ? combined : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);

  } else {
    // 正常選號：取w1次數最多的前5顆
    top5 = allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
  }

  if (top5.length < 3) {
    console.log(`[buildBingoGroups] 號碼不足3顆，跳過`);
    return [];
  }

  console.log(`[buildBingoGroups] top5=${top5.join(',')} 符合=${numStats.length}顆`);

  const combos = makeCombos(top5);
  return combos.map(combo => {
    const key = `h${combo[0]}_${combo[1]}_${combo[2]}`;
    return {
      key,
      label: key,
      nums: combo,
      meta: {
        strategy_key: key,
        strategy_name: key,
        type: 'hot',
        action,
        position,
        hot_pool: top5.join(','),
        hot_pool_size: top5.length,
        total_qualified: numStats.length,
        consecutive_burst: consecutiveBurst,
        forced_switch: forcedSwitch,
        low_confidence_hour: isLowConfidenceHour,
        brew_count: brewCount,
        consecutive_zero: consecutiveZero,
        prev_hit_count: prevHitCount,
        prev_hot_pool: prevHotPool,
        changed_nums: changedNums,
        is_fast_turnover: isFastTurnover,
        is_slow_turnover: isSlowTurnover,
        is_high_hour: isHighHour,
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
