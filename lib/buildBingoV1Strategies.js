/**
 * buildBingoV1Strategies.js - v36 SQL驗證優化版
 *
 * 根據 SQL 回測結論調整：
 *
 * 1. 爆發期連續>=3期 → 強制切換醞釀期邏輯（命中率從第3期開始掉到0%）
 * 2. 12-15點降級為觀察期（SQL驗證命中率接近0%）
 * 3. 選號以第3名熱號為核心（SQL21：第3名貢獻度最高70.6%）
 * 4. 換手<=1顆時維持上期號碼優先（SQL14：換手越少命中率越高）
 *
 * 狀態判斷：
 * 🔥 爆發期：四週期號碼>=4顆（連續<3期）
 * ⚡ 醞釀期：三週期號碼>=3顆，或爆發期連續>=3期強制切換
 * 👀 觀察期：兩週期號碼>=3顆，或12-15點降級
 * ⏸️ 冷場：以上都不符合
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
  // 12-15點降級（SQL驗證命中率接近0%）
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

  // ★ 計算連續爆發期次數（從最近3期預測判斷）
  const prev3 = recentPredictions.slice(0, 3);
  const consecutiveBurst = prev3.filter(p =>
    p.position === '爆發期' || p.action === '爆發出號'
  ).length;

  // ★ 判斷本期狀態
  let position = '冷場期';
  let action = '跳過';
  let forcedSwitch = false;

  if (isLowConfidenceHour) {
    // 12-15點：降級處理
    if (fourCount >= 4 || threeCount >= 3 || (fourCount + threeCount) >= 3) {
      position = '觀察期';
      action = '參考出號';
      forcedSwitch = true;
    } else if (twoCount >= 3 || (fourCount + threeCount + twoCount) >= 3) {
      position = '觀察期';
      action = '參考出號';
    }
  } else if (fourCount >= 4 && consecutiveBurst < 2) {
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

  console.log(`[buildBingoGroups] ${position} action=${action} 四=${fourCount} 三=${threeCount} 二=${twoCount} 連續爆發=${consecutiveBurst} 低信心時段=${isLowConfidenceHour}`);

  if (action === '跳過' || numStats.length < 3) {
    console.log(`[buildBingoGroups] 冷場期，無符合號碼`);
    return [];
  }

  // ★ 選號邏輯：以第3名熱號為核心（SQL21驗證貢獻度最高70.6%）
  // 排序：w1次數降序，週期降序
  const sortedNums = [...numStats].sort((a, b) => b.w1cnt - a.w1cnt || b.period - a.period);

  let top5;
  if (sortedNums.length >= 5) {
    // 取排名1、2、3、4、5，以第3名為核心確保涵蓋
    top5 = sortedNums.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
  } else {
    top5 = sortedNums.map(s => s.n).sort((a, b) => a - b);
  }

  // 如果是強制切換（爆發→醞釀），優先用三週期號碼
  if (forcedSwitch && threeNums.length >= 3) {
    const threeTop = [...threeNums]
      .sort((a, b) => b.w1cnt - a.w1cnt)
      .slice(0, 5)
      .map(s => s.n)
      .sort((a, b) => a - b);
    if (threeTop.length >= 3) top5 = threeTop;
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
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
