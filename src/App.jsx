/**
 * buildBingoV1Strategies.js - V0620-1
 *
 * ★ V0620-1更新(6/20)：試驗訊號擴充為兩組平行門檻。原本只測「醞釀期+TQ>=25」，
 * 但觀察6/19晚間9小時資料發現，這個試驗池本身發生頻率很低(約2小時1次)，TQ達標
 * 的更少，樣本累積太慢。既然反正都標成trial、不影響真錢，同時加開「醞釀期+
 * TQ20-24」這組相鄰門檻平行測試，用trial_tier欄位('high'/'mid')區分兩組，
 * 之後可直接用SQL比較兩個門檻哪個更值得扶正成正式條件。
 *
 * ★ V0619-6更新(6/19)：新增skip_detail欄位，精確拆分跳過原因為四種：
 * no_signal(真正零訊號)、burst_override_had_signal(有訊號但被爆發期+換手5+規則覆蓋)、
 * burst_override_no_signal(沒訊號且同時踩到爆發期規則)、bad_even_tail_override(永久停用保留)。
 * 根因：原本auto-train.js寫入的skip_reason只有no_signal/soul_blocked二元判斷，
 * no_signal標籤混雜了「真正零訊號」跟「其實有訊號(如s9)但被覆蓋」這兩種不同情況，
 * 事後SQL分析"真正零訊號"期數時會被污染。不更動原有skip_reason欄位語意(App.jsx前端已依賴)，
 * 純粹新增skip_detail供日後SQL精確篩選。
 *
 * ★ V0619-5更新(6/19)：新增試驗性訊號trial。富緯確認接下來兩天(端午連假剩餘時間)
 * 不會實際下注，無真錢風險，趁機正式開放一個全新、完全未經回溯驗證的假設：
 * 「醞釀期 + TQ>=25」單獨成立即可出手，不再要求isFastBurst(換手5+)這個前提
 * (原本s12需要兩者同時成立)。目的是測試TQ這個已驗證的關鍵正向變數，拿掉換手
 * 前提後是否依然有效，藉此探索能否安全提高出手率。用獨立的'trial'標籤跟其他
 * 已驗證模式分開記錄，兩天後可直接用SQL評估這個假設成不成立，再決定要不要扶正、
 * 調整門檻，或直接捨棄。
 *
 * ★ V0619-4更新(6/19)：移除skipFastBurstLowTQ裡的TQ<25守門條件。SQL驗證發現
 * 爆發期+換手5+的組合，TQ達25-29時仍是0/15中3、平均-186.7元/期，TQ在此組合
 * 完全沒有保護作用，原邏輯反而會在TQ>=25時放行這個已驗證的災難組合。改為
 * 爆發期+換手5+一律跳過，不再限定低TQ。此修改會略為降低出手率，但直接服務
 * 命中率，跟稍早「爆發期+白天29期掛零」的發現互相印證。
 *
 * ★ V0619-3更新(6/19)：active_mode分級邏輯改用s12觸發與否為核心依據，取代純訊號數計數。
 * 根據6/18 12:30起126期乾淨樣本SQL驗證：s1+s5+s12全觸發(16期)中3率25.0%/+103.1元/期，
 * 但s1或s5觸發、缺s12(37+15期)中3率僅5.4%/0%、平均-106.8/-186.7元/期，比完全無訊號的
 * 基準(60期,-70.8)還差。新增s12Anchored/fastBurstNoS12變數，取代totalSignals門檻判斷
 * top5集中度與active_mode分級；shouldSkip(出手與否)邏輯不變，出手率不受影響。
 *
 * ★ V0619-1更新(6/19)：meta物件補上prev2_odd_tail欄位。原本只寫了
 * prev2_sum_val、prev2_high_zone，漏了prev2_odd_tail，導致s9(連2期均衡，
 * 樣本最大230筆)無法從資料庫事後反推還原。這次補上後s9也能被完整追蹤分析。
 *
 * ★ V0617-2 重大重構：恢復V0612-3動態組合生成邏輯
 * 背景：6/13~6/17現實命中率持續下滑(9.8%→3.1%)，SQL分段驗證證實斷層發生在
 * V0615-1清除舊版邏輯之後。進一步比對spider_mode發現，舊版'normal'模式
 * (141期樣本)中3率11.35%，是目前驗證過所有版本/分類裡表現最好的單一邏輯。
 * 根因鎖定：V0615之後用的固定位置combos(如[1,5,8])假設每期候選池排序結構
 * 相似，但實際上每期分布不同，固定位置時對時不對。改回動態算top5+動態
 * C(7,3)篩選「含top5號碼最多」的組合，每期重新適應候選池實際結構。
 * - 保留：11個訊號計數器(s1-s12)決定要不要出手、出手力度
 * - 取代：8組生成方式，從固定位置索引改為動態C(7,3)篩選
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

export function buildBingoGroups(recentDraws = [], latestDrawNo = 0, recentPredictions = [], signalEnabled = {}) {
  if (recentDraws.length < 20) return [];

  const w1draws = recentDraws.slice(0, 5);
  const w2draws = recentDraws.slice(5, 10);
  const w3draws = recentDraws.slice(10, 15);
  const w4draws = recentDraws.slice(15, 20);

  // ★ 時段感知
  const taipeiHour = (new Date().getUTCHours() + 8) % 24;
  const isHighHour = (taipeiHour >= 9 && taipeiHour <= 11) || (taipeiHour >= 16 && taipeiHour <= 18);
  const isDeadHour = taipeiHour >= 12 && taipeiHour <= 15;
  // ★ V0617-6新增：6/17徹查全部24小時實際命中率，取前4名(17/20/23/11點)重新定義最佳時段
  // 取代舊版isHighHour的簡化二分假設(9-11/16-18)，17點(13.53%)和23點(10.40%)原本完全不在範圍內
  const isGreatHour = [17, 20, 23, 11].includes(taipeiHour);

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
  // ★ V0619-4修正：移除TQ<25這個無效守門條件。6/19 SQL驗證(6/18 12:30起)發現，
  // 爆發期+換手5+的組合，即使TQ達到25-29(高於原本的25門檻)，15期裡仍是0次中3、
  // 平均-186.7元/期，是目前驗證過最差的組合之一，證實TQ在這個組合裡完全沒有保護作用。
  // 原邏輯只在TQ<25時跳過，TQ>=25反而照常出手，等於放行了一個已驗證的災難組合。
  // 改為「爆發期+換手5+」一律跳過，不再用TQ當守門條件。變數名稱保留(歷史延續性)，
  // 但語意已更新為「爆發期快速換手一律跳過」，不再限定低TQ。
  const skipFastBurstLowTQ = isFastBurst && position === '爆發期';

  // 11個訊號定義(原始觸發值，不管是否被signal_weights停用)
  // ★ V0616-4：每個訊號乘上對應的啟用開關，停用的訊號就不計入totalSignals
  // signalEnabled格式：{ s1: true, s2: false, ... }，預設全部true(向下相容，未傳入時等同舊行為)
  const enabled = (key) => signalEnabled[key] !== false; // 只有明確傳false才停用

  // ★★★ V0618-4：訊號系統大整頓 ★★★
  // 背景：逐字重讀6/14~6/18完整對話記錄，發現多個訊號當初的驗證樣本極小
  // (s3=10筆/s4=16筆/s8=16-20筆/s11=9筆)，且assistant當時自己都承認"樣本不足以做決策"，
  // 卻仍被放進正式系統。今天(6/18)用短期(1天)/中期(7天)/長期(全部)三段累積窗口
  // 重新驗證，結果證實s8/s11三段一致持續變差(很可能從一開始就是小樣本噪音，
  // 不是後來才drift)，s14/s15三段都明顯為負(早上的驗證方向錯誤或樣本不足)，
  // ultra模式(4+訊號)的理論基礎本身也只有19+5筆樣本。
  //
  // 保留(有相對紮實證據)：s1(三段方向大致一致)、s9(樣本最大230筆)、
  //   s12(三段一致正向，目前唯一三段都站得住的訊號)、s5(中度可信，降權觀察)
  // 砍除(樣本過小或三段驗證持續轉差)：s2(已被signal_weights停用)、
  //   s3(10筆)、s4(16筆)、s6/s7(複合條件樣本更小)、s8(三段持續變差)、
  //   s10(樣本小邏輯複雜)、s11(三段持續變差)、s13(9筆樣本)、
  //   s14(三段皆負)、s15(三段皆明顯負)
  const rawS1 = isFastBurst && position === '醞釀期' ? 1 : 0;           // 換手5+醞釀：三段方向大致一致，保留
  const rawS5 = prevFullLoss && isFastBurst ? 1 : 0;                    // 槓龜換手5：中度可信，降權觀察
  const rawS9 = prevIsBalanced && prev2IsBalanced ? 1 : 0;              // 連2期均衡：樣本最大(230筆)，保留觀察
  const rawS12 = totalQualified >= 25 && isFastBurst ? 1 : 0;           // TQ25++換手5+：三段一致正向，目前最可信

  const s1 = enabled('s1') ? rawS1 : 0;
  const s5 = enabled('s5') ? rawS5 : 0;
  const s9 = enabled('s9') ? rawS9 : 0;
  const s12 = enabled('s12') ? rawS12 : 0;
  // s2/s3/s4/s6/s7/s8/s10/s11/s13/s14/s15：全部移除，不再計入totalSignals
  const s2 = 0, s3 = 0, s4 = 0, s6 = 0, s7 = 0, s8 = 0, s10 = 0, s11 = 0, s13 = 0, s14 = 0, s15 = 0;

  const totalSignals = s1+s2+s3+s4+s5+s6+s7+s8+s9+s10+s11+s12+s13+s14+s15;

  const skipBadEvenTail = false; // 保留變數供console.log/meta相容，已確認永久停用(V0617-8)

  // 候選池
  const hotPool10Ranked = allCandidates.slice(0, 10).map(s => s.n);
  const hotPool12Ranked = allCandidates.slice(0, 12).map(s => s.n);
  const hotPool7 = [...hotPool10Ranked.slice(0, 7)].sort((a, b) => a - b);
  // ★ V0618-4：spiderSenseActive(舊版，依賴已砍除的s3)已移除，改用下方spiderSenseActiveV2

  // ★ V0617-2重大重構：恢復V0612-3的「動態top5 + 動態C(7,3)篩選」邏輯，
  // 取代V0615之後的固定位置combos系統(combos_standard/strong/ultra等)。
  //
  // 根因(6/17 SQL驗證)：固定位置索引(如[1,5,8])假設每期候選池排序結構相似，
  // 但實際上每期numStats分布都不同，固定位置可能對到熱號也可能完全錯位。
  // 舊版V0612-3用「動態算出C(7,3)=35種組合、優先選含top5號碼最多」的方式，
  // 每期都重新檢視候選池實際結構，spider_mode='normal'驗證141期中3率達11.35%，
  // 是目前驗證過所有版本/分類裡表現最好的單一邏輯。
  //
  // 保留：11個訊號計數器(totalSignals)決定要不要出手、出手力度(用哪個top5定義)
  // 取代：8組生成方式，改為動態C(7,3)篩選，不用固定位置編號

  function makeCombos(nums) {
    const combos = [];
    for (let i = 0; i < nums.length; i++)
      for (let j = i + 1; j < nums.length; j++)
        for (let k = j + 1; k < nums.length; k++)
          combos.push([nums[i], nums[j], nums[k]]);
    return combos;
  }

  // ★ V0618-4：重新校準分級門檻，配合訊號數從15個精簡到4個(s1/s5/s9/s12)的新現實
  // 原本"4+訊號=ultra"在15個訊號的世界裡代表"多種強訊號共鳴"，但現在只剩4個候選訊號，
  // "4個全部觸發"變成"唯一還能達到的最高值"，跟以前的設計意義不同，但保留同樣的相對分級邏輯：
  // 4個全觸發=ultra(最強)，2-3個=strong，1個=standard，0個=skip
  // top5定義：訊號越強，越敢用更集中/更前面的號碼
  //
  // ★ V0619-3修正：6/19用6/18 12:30起126期乾淨樣本SQL驗證，發現「訊號數量」本身
  // 不能準確反映訊號品質，s12是否觸發才是核心關鍵變數：
  //   s1+s5+s12全觸發(16期)：中3率25.0%，平均+103.1元/期 ← 目前驗證過最佳組合
  //   s1+s5觸發但無s12(37期)：中3率5.4%，平均-106.8元/期 ← 比完全無訊號的基準(60期,-70.8)還差
  //   s5+s12觸發但無s1(15期)：中3率0.0%，平均-186.7元/期 ← 目前驗證過最差組合
  // 結論：isFastBurst觸發(s1或s5=1)若缺少s12，過去被計為"strong"等同高信心，
  // 但實測表現劣於基準，不該被當成強訊號；s12在場時(無論搭配與否)才是真正的強訊號訊號。
  // 改用s12Anchored/fastBurstNoS12取代純totalSignals計數，作為top5集中度與active_mode分級依據。
  // 此修改不影響shouldSkip(出手與否的判斷)，只改變「信心分級」與「選號集中度」，不會降低出手率。
  const s12Anchored = s12 === 1;
  const fastBurstNoS12 = (s1 === 1 || s5 === 1) && s12 === 0;

  // ★ V0619-5新增、V0620-1擴充：試驗性訊號(trial)。6/19查證發現「totalSignals=0」這個跳過空窗裡，
  // 91期裡全部是爆發期(已知黑洞，不該動)，其餘position在這個空窗完全沒有歷史資料可比對，
  // 是真正未測試過的領域。趁富緯這幾天不會實際下注(無真錢風險)，開放全新假設：
  // 拿掉s12原本要求的isFastBurst(換手5+)前提，單獨測試「醞釀期+TQ高」這個條件本身夠不夠力，
  // 不管換手快不快。完全沒有回溯資料驗證，純粹是觀察期的試驗，用獨立的'trial'標籤跟其他
  // 已驗證模式分開，方便日後直接用SQL拉出來看這個全新假設成不成立。
  // ★ V0620-1：原本只測TQ>=25一組門檻，但6/19晚間觀察發現「醞釀期+完全無訊號」這個
  // 試驗池本身就很罕見(約2小時才1次)，TQ>=25達標的更是少之又少，樣本累積太慢。
  // 既然反正都標成trial、不影響真錢，乾脆同時平行測試TQ20-24這組相鄰門檻，
  // 用trial_tier欄位('high'=TQ25+／'mid'=TQ20-24)區分，兩組各自獨立累積樣本，
  // 之後可以直接用SQL比較兩個門檻哪個更值得扶正成正式門檻。
  const trialTQHigh = totalSignals === 0 && position === '醞釀期' && totalQualified >= 25;
  const trialTQMid = totalSignals === 0 && position === '醞釀期' && totalQualified >= 20 && totalQualified < 25;
  const trialSignal = trialTQHigh || trialTQMid;
  const trialTier = trialTQHigh ? 'high' : trialTQMid ? 'mid' : null;

  let top5;
  if (s12Anchored && (s1 === 1 || s5 === 1)) {
    // 已驗證最佳組合：s12+至少一個(s1/s5)同時觸發，用最集中的top5
    top5 = [allCandidates[0]?.n, ...allCandidates.slice(1, 4).map(s => s.n)].filter(Boolean).sort((a, b) => a - b);
  } else if (s12Anchored) {
    // s12單獨觸發(尚無足夠樣本驗證，先給予次集中信心)
    top5 = [allCandidates[0]?.n, ...allCandidates.slice(2, 6).map(s => s.n)].filter(Boolean).sort((a, b) => a - b);
  } else if (fastBurstNoS12) {
    // ★ 已驗證的劣質組合：不集中下注，用最寬鬆的top5，降低押錯方向時的損失
    top5 = allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
  } else if (trialSignal) {
    // ★ V0619-5/V0620-1試驗訊號：完全未驗證，用最寬鬆的top5，不集中冒險
    top5 = allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
  } else if (totalSignals >= 2) {
    top5 = [allCandidates[0]?.n, ...allCandidates.slice(2, 6).map(s => s.n)].filter(Boolean).sort((a, b) => a - b);
  } else {
    top5 = allCandidates.slice(0, 5).map(s => s.n).sort((a, b) => a - b);
  }

  // ★ V0618-4：spiderSenseActive依賴的s3已被移除，蜘蛛模式邏輯失去輸入來源，
  // 改用totalQualified>=22(原s3定義裡的TQ門檻部分)獨立判斷，不再依賴已砍除的s3
  const spiderSenseActiveV2 = totalQualified >= 22 && changedNums <= 1;

  // 動態C(7,3)篩選：蜘蛛模式用12顆池取前7名，否則用10顆池取前7名
  const activePool = spiderSenseActiveV2 && totalSignals < 2 ? hotPool12Ranked : hotPool10Ranked;
  const comboPool7 = [...activePool.slice(0, 7)].sort((a, b) => a - b);
  const requiredSize = spiderSenseActiveV2 && totalSignals < 2 ? 12 : 10;

  // 訊號=0 或 觸發skip條件 → 不出手（★ V0619-5：trialSignal成立時例外放行，不算在totalSignals===0的跳過範圍內）
  const shouldSkip = (totalSignals === 0 && !trialSignal) || skipFastBurstLowTQ || skipBadEvenTail;

  const allCombos = makeCombos(comboPool7);
  const top5Set = new Set(top5);
  const priorityCombos = allCombos.filter(c => c.filter(n => top5Set.has(n)).length >= 2);
  const otherCombos = allCombos.filter(c => c.filter(n => top5Set.has(n)).length < 2);
  const finalCombos = shouldSkip ? []
    : activePool.length >= requiredSize
      ? [...priorityCombos, ...otherCombos].slice(0, 8)
      : [];

  // ★ V0619-3：active_mode改用s12Anchored/fastBurstNoS12為主要分級依據，
  // totalSignals>=4/>=2分支保留作為其他組合(如s9+s12等未單獨驗證的情況)的備援，理論上多數情況
  // 會被前兩個分支(s12Anchored/fastBurstNoS12)先攔截，因為totalSignals>=2必然包含s1/s5/s12其中之一。
  // ★ V0619-5：trial分支獨立標記，不跟standard混在一起，方便事後單獨用SQL評估這個新假設。
  const activeMode = shouldSkip ? 'skip'
    : (s12Anchored && (s1 === 1 || s5 === 1)) ? 'ultra'
    : s12Anchored ? 'strong'
    : fastBurstNoS12 ? 'standard'
    : trialSignal ? 'trial'
    : totalSignals >= 4 ? 'ultra'
    : totalSignals >= 2 ? 'strong'
    : spiderSenseActiveV2 ? 'spider'
    : totalSignals > 0 ? 'standard'
    : 'skip';
  console.log(`[buildBingoGroups] mode=${activeMode} signals=${totalSignals}(s1=${s1},s5=${s5},s9=${s9},s12=${s12}) s12Anchored=${s12Anchored} fastBurstNoS12=${fastBurstNoS12} trialSignal=${trialSignal} skip=${shouldSkip}(fastBurstLowTQ=${skipFastBurstLowTQ}) TQ=${totalQualified} pos=${position} ch=${changedNums} top5=${top5.join(',')} 組數=${finalCombos.length}`);

  const resultGroups = finalCombos.map(combo => {
    const key = `h${combo[0]}_${combo[1]}_${combo[2]}`;
    return {
      key, label: key, nums: combo,
      meta: {
        strategy_key: key, strategy_name: key, type: 'hot',
        action, position,
        hot_pool: hotPool7.join(','),
        hot_pool_size: hotPool7.length,
        spider_sense_active: totalSignals >= 2 || spiderSenseActiveV2,
        active_mode: activeMode,
        total_signals: totalSignals,
        s12_anchored: s12Anchored, // ★ V0619-3新增：s12是否觸發，新分級邏輯核心依據，方便日後SQL直接驗證
        fast_burst_no_s12: fastBurstNoS12, // ★ V0619-3新增：已驗證劣質組合(isFastBurst觸發但缺s12)標記
        trial_signal: trialSignal, // ★ V0619-5新增：試驗訊號(醞釀期+TQ高，不要求換手5+)，完全未驗證，方便事後SQL單獨評估
        trial_tier: trialTier, // ★ V0620-1新增：'high'=TQ25+ / 'mid'=TQ20-24，區分兩組平行測試的門檻
        top5_snapshot: top5.join(','),
        signal_enabled_snapshot: signalEnabled,
        prev_high_zone: prevHighZoneCount,
        prev_sum_val: prevSumVal,
        prev2_sum_val: prev2SumVal,
        prev3_sum_val: prev3SumVal,
        prev2_high_zone: prev2HighZoneCount,
        prev_max_tail: prevMaxTail,
        is_slow_turnover1: isSlowTurnover1,
        prev_is_slow_turnover: prevIsSlowTurnover,
        prev_consec_count: prevConsecCount,
        prev_odd_tail: prevOddTail,
        prev2_odd_tail: prev2OddTail, // ★ V0619-1新增：原本缺這個欄位，s9(連2期均衡)無法被完整反推追蹤，6/19補上
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
        is_great_hour: isGreatHour,
        taipei_hour: taipeiHour,
        burst_no: consecutiveBurst,
      }
    };
  });

  // ★ V0617-7修正：即使shouldSkip導致finalCombos為空，也要把完整診斷資訊掛在陣列上，
  // 讓auto-train.js寫入skip記錄時能存下changed_nums/position/prev_even_tail等完整盤面狀態，
  // 不再只能記錄active_mode/total_signals/skip_reason這4個欄位。
  // 用非enumerable屬性掛載，不影響.length和.map()等陣列正常行為。
  //
  // ★ V0619-6新增：skip_detail欄位。原本auto-train.js寫入的skip_reason只有
  // 'no_signal'/'soul_blocked'二元判斷，'no_signal'這個標籤其實混雜了兩種完全不同的情況：
  // 真正零訊號(totalSignals=0)，跟「其實有訊號(如s9)、但被爆發期+換手5+規則覆蓋」這種情況，
  // 後者過去會被誤標成no_signal，事後用SQL分析「真正零訊號」期數時會混進這些有訊號但被覆蓋的期，
  // 造成判斷失準。這裡新增skip_detail精確拆分四種原因，不更動原有skip_reason(App.jsx前端
  // 已依賴這個欄位的'soul_blocked'/其他二元判斷，不能更動其既有兩種值的語意)。
  let skipDetail;
  if (skipFastBurstLowTQ) {
    skipDetail = totalSignals > 0 ? 'burst_override_had_signal' : 'burst_override_no_signal';
  } else if (skipBadEvenTail) {
    skipDetail = 'bad_even_tail_override'; // 目前永久停用(V0617-8)，保留以防未來重新啟用
  } else if (totalSignals === 0) {
    skipDetail = 'no_signal'; // 真正零訊號，且試驗訊號條件也沒達標
  } else {
    skipDetail = 'other'; // 防呆：理論上不該到達此分支
  }

  if (shouldSkip) {
    Object.defineProperty(resultGroups, '__skipDiagnostics', {
      value: {
        active_mode: activeMode,
        total_signals: totalSignals,
        s12_anchored: s12Anchored,
        fast_burst_no_s12: fastBurstNoS12,
        trial_signal: trialSignal,
        trial_tier: trialTier,
        skip_detail: skipDetail,
        position, changed_nums: changedNums,
        total_qualified: totalQualified,
        prev_even_tail: prevEvenTail,
        prev_consec_count: prevConsecCount,
        prev_odd_tail: prevOddTail,
        prev_hit_count: prevHitCount,
        is_great_hour: isGreatHour,
        taipei_hour: taipeiHour,
        skip_fast_burst_low_tq: skipFastBurstLowTQ,
        skip_bad_even_tail: skipBadEvenTail,
      },
      enumerable: false,
      configurable: true,
    });
  }

  return resultGroups;
}

export function getZoneStrategyKeys() { return []; }
