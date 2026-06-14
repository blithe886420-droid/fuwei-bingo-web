/**
 * buildBingoV1Strategies.js - V0614-10
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

  // ★ 週期判斷（移除強制切換，讓系統自己判斷）
  const prev5 = recentPredictions.slice(0, 5);
  const consecutiveBurst = (() => {
    let count = 0;
    for (const p of recentPredictions) {
      if (p.position === '爆發期' || p.action === '爆發出號') count++;
      else break;
    }
    return count;
  })();

  let consecutiveZero = 0;
  for (const p of recentPredictions) {
    if (p.hit_count === 0) consecutiveZero++;
    else break;
  }

  const prevHitCount = recentPredictions[0]?.hit_count || 0;
  const prevHotPool = recentPredictions[0]?.hot_pool || '';

  let position = '冷場期';
  let action = '跳過';
  // ★ V0611-3：移除強制切換邏輯
  // 爆發期第3、4期命中率25%，比第1、2期更高，不應該強制切換
  const forcedSwitch = false;

  if (fourCount >= 4) {
    position = '爆發期'; action = '爆發出號';
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

  // ★ 醞釀期第5期是低谷（命中率0%），標記為低信心
  const isBrewLowPoint = position === '醞釀期' && brewCount === 5;

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

  // ★ V0612-1：高命中時段+換手快 = 切換後半段起熱號策略
  // SQL驗證：high_hour+換手快命中率0%，但後半段號碼在非高命中時段有效
  // 不直接放棄這期，而是換策略出手
  const isHighHourFastTurnover = isHighHour && isFastTurnover;

  // ★ 盤面感知
  const topZone = (() => {
    const z1 = allCandidates.slice(0,5).filter(s => s.n <= 20).length;
    const z2 = allCandidates.slice(0,5).filter(s => s.n >= 21 && s.n <= 40).length;
    const z3 = allCandidates.slice(0,5).filter(s => s.n >= 41 && s.n <= 60).length;
    const z4 = allCandidates.slice(0,5).filter(s => s.n >= 61).length;
    return Math.max(z1, z2, z3, z4);
  })();
  const isBadBoard = topZone >= 4;

  // ★ 號碼集中感知（SQL E：集中比分散命中率高12-18%）
  const isConcentrated = topZone >= 3;

  // ★ 61-80區間感知
  const zone61to80 = allCandidates.filter(s => s.n >= 61 && s.n <= 80);
  const zone1to20 = allCandidates.filter(s => s.n >= 1 && s.n <= 20);
  const hasHighZone = zone61to80.length >= 2;

  // ★ 爆發期連續期數感知（SQL1：第3-4期命中率25%最高）
  const burstHighPoint = position === '爆發期' && (consecutiveBurst === 3 || consecutiveBurst === 4);
  const burstLowPoint = position === '爆發期' && consecutiveBurst >= 5;

  // ★ 換手率修正（SQL5：換手快5顆命中率18.18%，換手慢反而0%）
  const isTrueFastTurnover = changedNums >= 4;
  const isTrueSlowTurnover = changedNums <= 1;

  // ★ 真獵物信號
  const signals = {
    isHighHour,
    isFastTurnover: isTrueFastTurnover,  // 修正：換手快反而是正信號
    hasHighZone,
    isConcentrated,
    brewCount4plus: brewCount >= 4 && isHighHour,
    burstHighPoint,
    prevHit: prevHitCount >= 2,
  };

  const trueSignalCount = Object.values(signals).filter(Boolean).length;

  console.log(`[buildBingoGroups] ${position} 時段=${isHighHour?'高':'普'} 換手=${changedNums} 集中=${isConcentrated} 高號區=${zone61to80.length} 醞釀=${brewCount} 低谷=${isBrewLowPoint} 真信號=${trueSignalCount}`);

  // ★ V0611-3：hot_pool改為取7顆
  // 中2差點中3：差的號碼100%在pool外，5顆覆蓋面不夠
  // 改為7顆，C(7,3)=35組，取前8組
  const top7 = allCandidates.slice(0, 7).map(s => s.n);

  // ★ V0612-3：bad_board / forced_switch 不出手
  // SQL驗證：forced_switch (140組樣本) hit3=0%，bad_board (52組樣本) hit3=0%
  // 兩者均為純負貢獻，直接跳過不產生組合
  if (isBadBoard) {
    console.log(`[buildBingoGroups] 盤面不對勁(bad_board)，SQL驗證hit3=0%，不出手`);
    return [];
  }
  if (forcedSwitch) {
    console.log(`[buildBingoGroups] 強制切換(forced_switch)，SQL驗證hit3=0%，不出手`);
    return [];
  }

  // ★ 選號邏輯
  let top5;
  let spiderMode = 'normal';

  if (isHighHourFastTurnover) {
    // ★ 高命中時段+換手快：切換後半段起熱號（第3-7名）
    // SQL：high_hour+換手快命中率0%，換策略不放棄
    const rank3to7 = allCandidates.slice(2, 7).map(s => s.n).sort((a, b) => a - b);
    top5 = rank3to7.length >= 3 ? rank3to7 : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    spiderMode = 'high_hour_fast';
    console.log(`[buildBingoGroups] 高命中時段+換手快 切換起熱號 top5=${top5.join(',')}`);

  } else if (isHighHour) {
    // 高命中時段+換手穩定：61-80最強2顆 + 第3、4、5名
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
    // 12-15點保守策略：取第3-7名起熱號
    const rank3to7 = allCandidates.slice(2, 7).map(s => s.n).sort((a, b) => a - b);
    top5 = rank3to7.length >= 3 ? rank3to7 : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    spiderMode = 'dead_hour';

  } else if (position === '觀察期') {
    // ★ V0612-2：觀察期只有高命中時段+61-80才出手（SQL驗證：17點50%）
    // 其他情況直接跳過不出手
    if (isHighHour && zone61to80.length >= 2) {
      const rank3to7 = allCandidates.slice(2, 7).map(s => s.n).sort((a, b) => a - b);
      top5 = rank3to7.length >= 3 ? rank3to7 : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
      spiderMode = 'observation_high';
      console.log(`[buildBingoGroups] 觀察期+高命中時段+61-80 出手 top5=${top5.join(',')}`);
    } else {
      console.log(`[buildBingoGroups] 觀察期非高命中時段 跳過`);
      return [];
    }

  } else if (isBrewLowPoint) {
    // 醞釀第5期低谷：取第3-7名起熱號
    const rank3to7 = allCandidates.slice(2, 7).map(s => s.n).sort((a, b) => a - b);
    top5 = rank3to7.length >= 3 ? rank3to7 : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    spiderMode = 'brew_low_point';

  } else if (isFastTurnover && position === '爆發期') {
    // 換手快+爆發期：優先61-80
    const combined = [...zone61to80, ...allCandidates.filter(s => s.n < 61)].slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    top5 = combined.length >= 3 ? combined : allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
    spiderMode = 'fast_burst';

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

  // ★ V0614-8：完整觸發條件選號策略(今日全量SQL驗證結果)
  // ── 迴避訊號(最優先，直接return []) ──
  // 上期2+組中3後：-164.71(17筆)→ 但hit_count只有最高值，無法從後端判斷中3組數
  // 改由App.jsx UI層提示，不在此處實作
  //
  // ── 正向觸發(優先級1最強) ──
  // 1. 換手5顆+醞釀期 → +186.21(29筆)
  // 2. 換手1顆+TQ22+ → +23.81(63筆)
  // 3. TQ22++連穩2期(蜘蛛感知) → +390(10筆)
  // 4. 同尾5+後+換手1顆 → +96.88(16筆)
  // 5. 槓龜後+換手5顆 → +53.13(32筆)  ★新
  // 6. 單期高號7+(精確版) + 和值900-949 → +25.83(60筆)  ★複合強化
  // 7. 單期高號7+(精確版，和值<900) → +4.84(186筆)
  // 8. 奇奇X(連2期奇數和值) → -25(166筆，相對最好)  ★新
  // 預設：標準G策略

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

  // 上上上期和值(奇奇X需要連續2期奇數)
  const prev3DrawNums = parseNums(recentDraws[2]?.numbers || '');
  const prev3SumVal = prev3DrawNums.reduce((acc, n) => acc + n, 0);

  // 上期是否完全槓龜(-200)：用prevHitCount===0近似
  const prevFullLoss = prevHitCount === 0;

  // ── 觸發條件判斷 ──
  const triggerBurstBrew = isFastBurst && position === '醞釀期';
  const triggerSlowRich = isSlowTurnover1 && totalQualified >= 22;
  const spiderSenseActive = totalQualified >= 22 && changedNums <= 1 && prevIsSlowTurnover;
  const triggerTailSlow = prevMaxTail >= 5 && isSlowTurnover1;
  const triggerLossFast = prevFullLoss && isFastBurst;
  const triggerHighZoneRich = prevHighZoneCount >= 7 && prev2HighZoneCount < 7 && prevSumVal >= 900 && prevSumVal < 950;
  const triggerHighZone = prevHighZoneCount >= 7 && prev2HighZoneCount < 7 && prevSumVal < 900;
  const triggerOddOdd = prevSumVal % 2 === 1 && prev2SumVal % 2 === 1 && prev3SumVal % 2 !== 1;
  const triggerConsec8 = prevConsecCount >= 8;  // 新：上期連號8+組 → +253.13(20筆,每日5次)

  // 候選池
  const hotPool10Ranked = allCandidates.slice(0, 10).map(s => s.n);
  const hotPool12Ranked = allCandidates.slice(0, 12).map(s => s.n);
  const hotPool7 = [...hotPool10Ranked.slice(0, 7)].sort((a, b) => a - b);

  // ── 8組位置組合 ──
  const combos_burstBrew = [
    [3,4,8],[4,7,8],[1,3,10],[6,9,10],[3,4,7],[2,4,8],[1,6,10],[1,7,10],
  ];
  const combos_slowRich = [
    [3,5,7],[1,3,5],[3,5,10],[1,3,10],[1,5,10],[2,6,8],[4,5,8],[1,4,5],
  ];
  const combos_spider = [
    [4,11,12],[4,9,11],[1,5,10],[6,7,9],[1,5,8],[1,6,10],[4,5,12],[7,9,11],
  ];
  const combos_tailSlow = [
    [2,7,9],[2,3,7],[2,8,9],[2,6,9],[6,8,9],[1,5,8],[3,5,10],[4,5,7],
  ];
  const combos_lossFast = [
    [3,4,8],[4,7,8],[1,3,10],[6,9,10],[3,4,7],[2,4,8],[1,6,10],[1,7,10],
  ];
  const combos_highZoneRich = [
    [5,6,8],[1,6,8],[1,5,6],[3,5,8],[6,8,10],[1,3,5],[6,7,8],[7,8,10],
  ];
  const combos_highZone = [
    [8,9,10],[1,3,10],[5,9,10],[5,8,9],[1,5,6],[1,6,8],[2,8,10],[7,8,9],
  ];
  const combos_oddOdd = [
    [6,7,9],[1,6,7],[1,7,9],[1,2,7],[1,5,8],[4,6,9],[2,4,6],[2,4,8],
  ];
  const combos_consec8 = [   // 上期連號8+：+253.13(20筆)，排名2/4/6/9為核心
    [1,2,4],[2,6,9],[2,4,9],[4,6,9],[2,4,6],[6,8,9],[1,2,3],[3,4,6],
  ];
  const combos_standard = [
    [1,5,8],[1,5,10],[4,5,8],[1,4,5],[4,5,7],[3,5,10],[2,4,7],[2,4,10],
  ];

  // ── 選擇策略(優先級順序) ──
  const activePool = spiderSenseActive && !triggerBurstBrew && !triggerSlowRich ? hotPool12Ranked : hotPool10Ranked;
  const activeCombos = triggerBurstBrew ? combos_burstBrew
    : triggerSlowRich ? combos_slowRich
    : spiderSenseActive ? combos_spider
    : triggerTailSlow ? combos_tailSlow
    : triggerLossFast ? combos_lossFast
    : triggerHighZoneRich ? combos_highZoneRich
    : triggerHighZone ? combos_highZone
    : triggerConsec8 ? combos_consec8
    : triggerOddOdd ? combos_oddOdd
    : combos_standard;
  const requiredSize = (spiderSenseActive && !triggerBurstBrew && !triggerSlowRich) ? 12 : 10;

  const finalCombos = activePool.length >= requiredSize
    ? activeCombos.map(([i,j,k]) =>
        [activePool[i-1], activePool[j-1], activePool[k-1]].sort((a,b) => a-b)
      )
    : [];

  const activeMode = triggerBurstBrew ? 'burst_brew'
    : triggerSlowRich ? 'slow_rich'
    : spiderSenseActive ? 'spider'
    : triggerTailSlow ? 'tail_slow'
    : triggerLossFast ? 'loss_fast'
    : triggerHighZoneRich ? 'high_zone_rich'
    : triggerHighZone ? 'high_zone'
    : triggerConsec8 ? 'consec8'
    : triggerOddOdd ? 'odd_odd'
    : 'standard';
  console.log(`[buildBingoGroups] mode=${activeMode} changed=${changedNums} TQ=${totalQualified} pos=${position} prevHighZone=${prevHighZoneCount} prevSum=${prevSumVal} prevConsec=${prevConsecCount} 組數=${finalCombos.length}`);


  return finalCombos.map(combo => {
    const key = `h${combo[0]}_${combo[1]}_${combo[2]}`;
    return {
      key, label: key, nums: combo,
      meta: {
        strategy_key: key, strategy_name: key, type: 'hot',
        action, position,
        hot_pool: hotPool7.join(','),
        hot_pool_size: hotPool7.length,
        spider_sense_active: spiderSenseActive || triggerBurstBrew || triggerSlowRich || triggerHighZone || triggerHighZoneRich || triggerTailSlow || triggerLossFast || triggerOddOdd || triggerConsec8,
        active_mode: activeMode,
        prev_high_zone: prevHighZoneCount,
        prev_max_tail: prevMaxTail,
        prev_sum_val: prevSumVal,
        prev_consec_count: prevConsecCount,
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
        is_concentrated: isConcentrated,
        is_brew_low_point: isBrewLowPoint,
        true_signal_count: trueSignalCount,
        spider_mode: spiderMode,
        sig_high_hour: signals.isHighHour,
        sig_fast_turnover: signals.isFastTurnover,
        sig_high_zone: signals.hasHighZone,
        sig_concentrated: signals.isConcentrated,
        sig_brew4_hour: signals.brewCount4plus,
        sig_burst_high: signals.burstHighPoint,
        sig_burst_low: burstLowPoint,
        sig_slow_turnover: isTrueSlowTurnover,
        sig_prev_hit: signals.prevHit,
        burst_no: consecutiveBurst,
      }
    };
  });
}

export function getZoneStrategyKeys() { return []; }
