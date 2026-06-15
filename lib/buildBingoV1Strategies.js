/**
 * buildBingoV1Strategies.js - V0615-3
 *
 * ★ V0615-1 重大修正：徹底清除舊版V0612-3殘留邏輯
 * - 移除 bad_board/forced_switch/觀察期跳過/isBadBoard 等舊版干擾
 * - 移除舊版 signals/trueSignalCount/top5/spiderMode 等舊版變數
 * - 現在函數直接進入V0614-12的訊號計數器架構
 * - 0個訊號=skip；1-2=standard；3=strong；4+=ultra
 *
 * 蜘蛛感知系統 + 六層觸發條件選號策略
 *
 * V0614-6 重大更新（2026/06/14）：
 * 1. 六層觸發條件：換手5+醞釀(+186)/換手1+TQ22+(+23)/蜘蛛感知(+390)/
 *    同尾5+後換手1(+96)/單期高號7+(+4.84)/標準G策略
 * 2. 每個觸發條件各自有專屬最佳8組位置組合(SQL窮舉驗證)
 * 3. 高號區改為「精確版」：只在「單期首次出現」觸發，連續2期反而-121
 * 4. 新增上期最強尾數、上上期高號顆數的感知計算
 * 5. hot_pool取7顆，pool覆蓋面更廣
 *
 * V0612-3 根據反向歸納SQL分析優化：
 * 1. bad_board模式：SQL驗證52組樣本hit3=0%，直接不出手
 * 2. forced_switch模式：SQL驗證140組樣本hit3=0%，直接不出手
 * 3. 補上sig_slow_turnover欄位輸出（原為死代碼，App.jsx讀取但後端未輸出）
 */

function parseNums(numbers) {
  if (Array.isArray(numbers)) return numbers.map(Number).filter(n => n >= 1 && n <= 80);
  return String(numbers || '').trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 80);
}

function countIn(draws, num) {
  return draws.filter(d => parseNums(d.numbers).includes(num)).length;
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

  // ★ V0613-7：蜘蛛感知第一層：號碼池夠不夠。
  // 門檻由5提高為10，因8組現在依賴候選池前10名(hotPool10Ranked)，
  // 不足10顆時finalCombos會是空陣列，提前在此判斷可避免重複計算。
  if (totalQualified < 10) {
    console.log(`[buildBingoGroups] 號碼池不足(${totalQualified}顆，需>=10)，不出手`);
    return [];
  }

  // ★ 必要變數(新版訊號計數器需要)
  const prevHitCount = recentPredictions[0]?.hit_count || 0;
  const prevHotPool = recentPredictions[0]?.hot_pool || '';
  const prevPoolNums = prevHotPool.split(',').map(Number).filter(Boolean);
  const allCandidates = [...numStats].sort((a, b) => b.w1cnt - a.w1cnt || b.period - a.period);
  const changedNums = allCandidates.slice(0,5).map(s=>s.n).filter(n => !prevPoolNums.includes(n)).length;

  // 週期判斷
  const prev5 = recentPredictions.slice(0, 5);
  let consecutiveBurst = 0;
  for (const p of recentPredictions) {
    if (p.position === '爆發期' || p.action === '爆發出號') consecutiveBurst++;
    else break;
  }
  let consecutiveZero = 0;
  for (const p of recentPredictions) {
    if (p.hit_count === 0) consecutiveZero++;
    else break;
  }

  let position = '冷場期';
  let action = '跳過';
  if (fourCount >= 4) { position = '爆發期'; action = '爆發出號'; }
  else if (threeCount >= 3 || (fourCount + threeCount) >= 3) { position = '醞釀期'; action = '預備出號'; }
  else if (twoCount >= 3 || (fourCount + threeCount + twoCount) >= 3) { position = '觀察期'; action = '參考出號'; }

  let brewCount = 0;
  if (position === '醞釀期') {
    brewCount = 1;
    for (const p of recentPredictions) {
      if (p.position === '醞釀期') brewCount++;
      else break;
    }
  }

  const isFastBurst = changedNums >= 5;
  const isSlowTurnover1 = changedNums === 1;

  const prevPoolNums2 = (recentPredictions[1]?.hot_pool || '').split(',').map(Number).filter(Boolean);
  const prevChangedNums = prevPoolNums.length > 0 && prevPoolNums2.length > 0
    ? prevPoolNums.filter(n => !prevPoolNums2.includes(n)).length : null;
  const prevIsSlowTurnover = prevChangedNums !== null && prevChangedNums <= 1;

  // 上期和上上期開獎號碼
  const prevDrawNums = parseNums(recentDraws[0]?.numbers || '');
  const prevHighZoneCount = prevDrawNums.filter(n => n >= 61 && n <= 80).length;
  const prev2DrawNums = parseNums(recentDraws[1]?.numbers || '');
  const prev2HighZoneCount = prev2DrawNums.filter(n => n >= 61 && n <= 80).length;

  // 上期最強尾數顆數
  const prevMaxTail = Math.max(...Array.from({length:10}, (_,t) =>
    prevDrawNums.filter(n => n % 10 === t).length
  ));

  // 上期和值、上上期和值
  const prevSumVal = prevDrawNums.reduce((acc, n) => acc + n, 0);
  const prev2SumVal = prev2DrawNums.reduce((acc, n) => acc + n, 0);

  // 上期連號數(相鄰號碼差=1的組數)
  const prevDrawSorted = [...prevDrawNums].sort((a,b) => a-b);
  const prevConsecCount = prevDrawSorted.reduce((acc, n, i) =>
    i > 0 && n - prevDrawSorted[i-1] === 1 ? acc + 1 : acc, 0
  );

  // 上期和上上期奇偶尾分布
  const prevOddTail = prevDrawNums.filter(n => [1,3,5,7,9].includes(n % 10)).length;
  const prevEvenTail = prevDrawNums.filter(n => [0,2,4,6,8].includes(n % 10)).length;
  const prev2OddTail = prev2DrawNums.filter(n => [1,3,5,7,9].includes(n % 10)).length;
  const isBalanced = (t) => t >= 9 && t <= 11;  // 奇數尾9-11顆=均衡
  const prevIsBalanced = isBalanced(prevOddTail);
  const prev2IsBalanced = isBalanced(prev2OddTail);

  // 上上上期和值(奇奇X需要連續2期奇數)
  const prev3DrawNums = parseNums(recentDraws[2]?.numbers || '');
  const prev3SumVal = prev3DrawNums.reduce((acc, n) => acc + n, 0);

  // 上期是否完全槓龜(-200)：用prevHitCount===0近似
  const prevFullLoss = prevHitCount === 0;

  // ★ V0615-2：修正訊號計數器，加入skip條件
  // 關鍵發現(今日SQL驗證)：
  // - 換手5++醞釀期：+93.18(44筆) ← 正確，s1維持
  // - 換手5++爆發期：-84.04(47筆) ← 應該跳過！
  // - TQ25++換手5+：+207.69(26筆) ← 新強訊號
  // - TQ20-24+換手5+：-121.00(50筆) ← 最差，應跳過

  // ★ skip條件(最優先，直接不出手)
  // 只跳過「換手5++爆發期+TQ<25」這個確認最差的組合(-121,50筆)
  // 注意：換手5++醞釀期(s1,+93)和TQ25++換手5+(s12,+207)不能被跳過
  const skipFastBurstLowTQ = isFastBurst && position === '爆發期' && totalQualified < 25;

  // 11個訊號定義
  const s1 = isFastBurst && position === '醞釀期' ? 1 : 0;           // 換手5+醞釀：+93(44筆)
  const s2 = isSlowTurnover1 && totalQualified >= 22 ? 1 : 0;        // 換手1+TQ22+：+23(63筆)
  const s3 = totalQualified >= 22 && changedNums <= 1 && prevIsSlowTurnover ? 1 : 0;  // 蜘蛛感知
  const s4 = prevMaxTail >= 5 && isSlowTurnover1 ? 1 : 0;            // 同尾5+換手1：+96(16筆)
  const s5 = prevFullLoss && isFastBurst ? 1 : 0;                    // 槓龜換手5：+53(32筆)
  const s6 = prevHighZoneCount >= 7 && prev2HighZoneCount < 7 && prevSumVal >= 900 && prevSumVal < 950 ? 1 : 0;
  const s7 = prevHighZoneCount >= 7 && prev2HighZoneCount < 7 && prevSumVal < 900 ? 1 : 0;
  const s8 = prevConsecCount >= 8 ? 1 : 0;                           // 連號8+：+253(20筆)
  const s9 = prevIsBalanced && prev2IsBalanced ? 1 : 0;              // 連2期均衡：+23(230筆)
  const s10 = prevSumVal % 2 === 1 && prev2SumVal % 2 === 1 && prev3SumVal % 2 !== 1 ? 1 : 0;
  const s11 = prevHighZoneCount >= 7 && prev2HighZoneCount < 7 ? 1 : 0;
  // 新訊號s12：TQ25++換手5+：+207.69(26筆)
  const s12 = totalQualified >= 25 && isFastBurst ? 1 : 0;

  const totalSignals = s1+s2+s3+s4+s5+s6+s7+s8+s9+s10+s11+s12;

  // 候選池
  const hotPool10Ranked = allCandidates.slice(0, 10).map(s => s.n);
  const hotPool12Ranked = allCandidates.slice(0, 12).map(s => s.n);
  const hotPool7 = [...hotPool10Ranked.slice(0, 7)].sort((a, b) => a - b);
  const spiderSenseActive = s3 === 1;

  // 8組位置組合(依訊號強度分級)
  const combos_ultra = [    // 訊號>=4：+115歷史(25筆)
    [1,3,5],[1,3,10],[1,3,7],[1,5,6],[2,4,8],[2,8,9],[2,8,10],[2,5,10],
  ];
  const combos_strong = [   // 訊號=3：-31歷史(57筆)
    [6,7,9],[5,7,9],[4,8,9],[7,8,9],[4,6,7],[4,5,8],[5,6,9],[6,8,9],
  ];
  const combos_spider = [   // 蜘蛛感知(前12名)
    [4,11,12],[4,9,11],[1,5,10],[6,7,9],[1,5,8],[1,6,10],[4,5,12],[7,9,11],
  ];
  const combos_standard = [ // 訊號1-2：標準G策略
    [1,5,8],[1,5,10],[4,5,8],[1,4,5],[4,5,7],[3,5,10],[2,4,7],[2,4,10],
  ];

  // 選擇策略：訊號數決定出幾成力
  const activePool = spiderSenseActive && totalSignals < 3 ? hotPool12Ranked : hotPool10Ranked;
  const activeCombos = totalSignals >= 4 ? combos_ultra
    : totalSignals === 3 ? combos_strong
    : spiderSenseActive ? combos_spider
    : combos_standard;
  const requiredSize = spiderSenseActive && totalSignals < 3 ? 12 : 10;

  // 訊號=0 或 觸發skip條件 → 不出手
  const shouldSkip = totalSignals === 0 || skipFastBurstLowTQ;

  const finalCombos = shouldSkip ? []
    : activePool.length >= requiredSize
      ? activeCombos.map(([i,j,k]) =>
          [activePool[i-1], activePool[j-1], activePool[k-1]].sort((a,b) => a-b)
        )
      : [];

  const activeMode = shouldSkip ? 'skip'
    : totalSignals >= 4 ? 'ultra'
    : totalSignals === 3 ? 'strong'
    : spiderSenseActive ? 'spider'
    : totalSignals > 0 ? 'standard'
    : 'skip';
  console.log(`[buildBingoGroups] mode=${activeMode} signals=${totalSignals}(${s1}${s2}${s3}${s4}${s5}${s6}${s7}${s8}${s9}${s10}${s11}${s12}) skip=${shouldSkip}(fastBurstLowTQ=${skipFastBurstLowTQ}) TQ=${totalQualified} pos=${position} ch=${changedNums} 組數=${finalCombos.length}`);


  return finalCombos.map(combo => {
    const key = `h${combo[0]}_${combo[1]}_${combo[2]}`;
    return {
      key, label: key, nums: combo,
      meta: {
        strategy_key: key, strategy_name: key, type: 'hot',
        action, position,
        hot_pool: hotPool7.join(','),
        hot_pool_size: hotPool7.length,
        spider_sense_active: totalSignals >= 3 || spiderSenseActive,
        active_mode: activeMode,
        total_signals: totalSignals,
        prev_high_zone: prevHighZoneCount,
        prev_sum_val: prevSumVal,
        prev_consec_count: prevConsecCount,
        prev_odd_tail: prevOddTail,
        prev_even_tail: prevEvenTail,
        total_qualified: totalQualified,
        consecutive_burst: consecutiveBurst,
        brew_count: brewCount,
        consecutive_zero: consecutiveZero,
        prev_hit_count: prevHitCount,
        prev_hot_pool: prevHotPool,
        changed_nums: changedNums,
        is_high_hour: isHighHour,
        is_dead_hour: isDeadHour,
        burst_no: consecutiveBurst,
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
