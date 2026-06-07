/**
 * buildBingoV1Strategies.js - v34 醞釀爆發版
 *
 * 核心邏輯：號碼在越多週期持續出現，代表越接近爆發
 * 優先順序（每期只顯示一種）：
 *
 * 🔥 爆發期：四週期都有（w1+w2+w3+w4），pool≥4 → 爆發出號
 * ⚡ 醞釀期：三週期都有（w1+w2+w3），pool≥3 → 預備出號
 * 👀 觀察期：兩週期都有（w1+w2），pool≥3 → 參考出號
 * ⏸️ 冷場：以上都不符合 → 跳過，顯示隨機參考
 *
 * w1/w2/w3/w4 條件：各週期出現>=1次即計算
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

  const fourPeriod = [];
  const threePeriod = [];
  const twoPeriod = [];

  for (let n = 1; n <= 80; n++) {
    const w1cnt = countIn(w1draws, n);
    const inW2 = countIn(w2draws, n) >= 1;
    const inW3 = countIn(w3draws, n) >= 1;
    const inW4 = countIn(w4draws, n) >= 1;

    if (w1cnt >= 3 && inW2 && inW3 && inW4) {
      // 🔥 爆發期：w1出現>=3次 + 三個窗口都有
      fourPeriod.push(n);
    } else if (w1cnt >= 2 && inW2 && inW3) {
      // ⚡ 醞釀期：w1出現>=2次 + w2/w3都有
      threePeriod.push(n);
    } else if (w1cnt >= 2 && inW2) {
      // 👀 觀察期：w1出現>=2次 + w2有
      twoPeriod.push(n);
    }
  }

  console.log(`[buildBingoGroups] 四週期=${fourPeriod.length} 三週期=${threePeriod.length} 兩週期=${twoPeriod.length}`);

  // 優先順序決定出號
  // ★ 限制組數：取最熱前N顆，避免全排列組數爆炸（曾造成資料庫崩潰）
  // 爆發期取前7顆 → 最多35組
  // 醞釀期取前6顆 → 最多20組
  // 觀察期取前5顆 → 最多10組
  let action = '跳過';
  let selectedNums = [];
  let position = '冷場期';

  if (fourPeriod.length >= 4) {
    action = '爆發出號';
    selectedNums = fourPeriod.slice(0, 7);  // 最多7顆→35組
    position = '爆發期';
  } else if (threePeriod.length >= 3 || (fourPeriod.length + threePeriod.length) >= 3) {
    action = '預備出號';
    const combined = [...new Set([...fourPeriod, ...threePeriod])];
    selectedNums = combined.slice(0, 6);    // 最多6顆→20組
    position = '醞釀期';
  } else if ((fourPeriod.length + threePeriod.length + twoPeriod.length) >= 3) {
    action = '參考出號';
    const combined = [...new Set([...fourPeriod, ...threePeriod, ...twoPeriod])];
    selectedNums = combined.slice(0, 5);    // 最多5顆→10組
    position = '觀察期';
  }

  console.log(`[buildBingoGroups] 策略=${action} 選號=${selectedNums.length}顆 位置=${position}`);

  if (action === '跳過' || selectedNums.length < 3) return [];

  const combos = makeCombos(selectedNums);
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
        four_period_nums: fourPeriod.join(','),
        three_period_nums: threePeriod.join(','),
        two_period_nums: twoPeriod.join(','),
        hot_pool: selectedNums.join(','),
        hot_pool_size: selectedNums.length,
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
