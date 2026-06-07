/**
 * buildBingoV1Strategies.js - v35 固定10組版
 *
 * 核心邏輯：
 * 1. 依週期條件判斷狀態（爆發/醞釀/觀察）
 * 2. 不管哪個狀態，一律取 w1 出現次數最多的前5顆
 * 3. 5顆全排列 = C(5,3) = 固定10組
 *
 * 狀態判斷（決定顯示標示，不影響出號邏輯）：
 * 🔥 爆發期：w1>=3次 + w2/w3/w4各>=1次
 * ⚡ 醞釀期：w1>=2次 + w2/w3各>=1次
 * 👀 觀察期：w1>=2次 + w2>=1次
 * ⏸️ 冷場：以上都不符合 → 跳過
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

  // 計算每顆號碼的 w1 出現次數和週期分類
  const numStats = [];
  for (let n = 1; n <= 80; n++) {
    const w1cnt = countIn(w1draws, n);
    const inW2 = countIn(w2draws, n) >= 1;
    const inW3 = countIn(w3draws, n) >= 1;
    const inW4 = countIn(w4draws, n) >= 1;

    let period = 0; // 0=不符合, 2=兩週期, 3=三週期, 4=四週期
    if (w1cnt >= 3 && inW2 && inW3 && inW4) period = 4;
    else if (w1cnt >= 2 && inW2 && inW3) period = 3;
    else if (w1cnt >= 2 && inW2) period = 2;

    if (period > 0) {
      numStats.push({ n, w1cnt, period });
    }
  }

  // 判斷本期狀態（取最高週期）
  const maxPeriod = numStats.length > 0 ? Math.max(...numStats.map(s => s.period)) : 0;

  let position = '冷場期';
  let action = '跳過';

  if (maxPeriod === 4) { position = '爆發期'; action = '爆發出號'; }
  else if (maxPeriod === 3) { position = '醞釀期'; action = '預備出號'; }
  else if (maxPeriod === 2) { position = '觀察期'; action = '參考出號'; }

  if (action === '跳過' || numStats.length < 3) {
    console.log(`[buildBingoGroups] 冷場期，無符合號碼`);
    return [];
  }

  // ★ 不管哪個狀態，一律取 w1 出現次數最多的前5顆
  const top5 = numStats
    .sort((a, b) => b.w1cnt - a.w1cnt || b.period - a.period)
    .slice(0, 5)
    .map(s => s.n)
    .sort((a, b) => a - b);

  console.log(`[buildBingoGroups] 位置=${position} 策略=${action} top5=${top5.join(',')} 符合號碼=${numStats.length}顆`);

  const combos = makeCombos(top5); // 固定10組
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
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
