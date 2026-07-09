/**
 * App.jsx - V0709-Aonly-hotfix41
 *
 * ★ hotfix41：關閉 B 軌 UI，只顯示 A 軌 formal_3star
 * - 移除 structure_anchor API 與 B 卡片
 * - 快速頁：主系統 / 空窗 兩態
 * - 近期 / 統計：只顯示 A 軌資料
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

const RAILWAY_URL = 'https://fuwei-bingo-backend-production.up.railway.app';
const REFRESH_INTERVAL_MS = 30000;
const STATS_START_DATE = '2026-06-08T00:00:00.000Z';

// ★ V0619-1：四種active_mode的中文對照，統一在「快速」「近期」「統計」三頁套用，
// 避免英文模式字串(ultra/strong/standard/spider)直接顯示給用戶看
const MODE_LABEL = {
  standard: '標準',
  strong: '強訊號',
  ultra: '超強訊號',
  spider: '蜘蛛感知',
};
function modeLabel(m) {
  return MODE_LABEL[m] || m || '-';
}

// ★ V0619-2：根據meta物件反推s1/s5/s9/s12個別是否觸發，邏輯對齊buildBingoV1Strategies.js的rawS1/rawS5/rawS9/rawS12
// s1：換手5+且醞釀期 | s5：上期槓龜(prev_hit_count=0)且換手5+ | s9：上一期&上兩期奇數尾都均衡(9-11顆) | s12：TQ25+且換手5+
const SIGNAL_LABEL = { s1: 's1換手醞釀', s5: 's5槓龜換手', s9: 's9連2期均衡', s12: 's12高TQ換手' };

// ★ V0620-3新增：5種互斥盤面狀態的中文對照與顏色，對應後端board_state欄位
// B(蜘蛛靜默)已驗證穩定獲利→綠色；D(爆發危險區)已驗證穩定虧損→紅色；其餘中性灰
const BOARD_STATE_LABEL = {
  A_golden: { text: '黃金共振', color: '#B45309', bg: '#FEF3C7' },
  B_spider_calm: { text: '蜘蛛靜默', color: '#15803D', bg: '#DCFCE7' },
  D_burst_danger: { text: '爆發危險區', color: '#DC2626', bg: '#FEE2E2' },
  E_false_momentum: { text: '假動能', color: '#9333EA', bg: '#F3E8FF' },
  F_quiet: { text: '平淡期', color: '#6B7280', bg: '#F3F4F6' },
};
function boardStateInfo(s) {
  return BOARD_STATE_LABEL[s] || null;
}

// ★ V0621-3新增：超級組合標籤(蜘蛛靜默/黃金共振疊加奇數微升)，樣本量還小(10-12期)，
// 用「觀察中」字眼明確標示未驗證，避免被誤認成已驗證的高信心訊號
const SUPER_COMBO_LABEL = {
  spider_odd_up: { text: '蜘蛛靜默+奇數微升(觀察中)', color: '#0E7490', bg: '#CFFAFE' },
  golden_odd_up: { text: '黃金共振+奇數微升(觀察中)', color: '#0E7490', bg: '#CFFAFE' },
};
function superComboInfo(s) {
  return SUPER_COMBO_LABEL[s] || null;
}

// ★ V0620-4新增：謹慎旗標標籤，sum_surge(總和暴漲)與odd_imbalance(奇偶失衡)任一觸發時顯示
function getCautionLabels(meta) {
  if (!meta) return [];
  const labels = [];
  if (meta.sum_surge) labels.push('總和暴漲');
  if (meta.odd_imbalance) labels.push('奇偶失衡');
  if (meta.tq_plunge) labels.push('TQ急跌'); // ★ V0621-2新增
  return labels;
}
function isBalancedTail(t) {
  return t >= 9 && t <= 11;
}
function getFiredSignals(meta) {
  if (!meta) return [];
  const changedNums = toNum(meta.changed_nums, -1);
  const position = meta.position || '';
  const prevHitCount = toNum(meta.prev_hit_count, -1);
  const totalQualified = toNum(meta.total_qualified, -1);
  const prevOddTail = meta.prev_odd_tail != null ? toNum(meta.prev_odd_tail, -1) : null;
  const prev2OddTail = meta.prev2_odd_tail != null ? toNum(meta.prev2_odd_tail, -1) : null;
  const isFastBurst = changedNums >= 5;

  const fired = [];
  if (isFastBurst && position === '醞釀期') fired.push('s1');
  if (prevHitCount === 0 && isFastBurst) fired.push('s5');
  if (prevOddTail != null && prev2OddTail != null && isBalancedTail(prevOddTail) && isBalancedTail(prev2OddTail)) fired.push('s9');
  if (totalQualified >= 25 && isFastBurst) fired.push('s12');
  return fired;
}

// ★ V0621-5新增：出手門檻已改用four_count(取代s1/s5/s9/s12)，這種情況下firedSignals會是空陣列，
// 但期數確實有出手，需要明確標示「這是靠新門檻出手，不是靠已驗證訊號」，避免看起來像沒原因卻出號碼
function isFiredByFourCountOnly(meta) {
  if (!meta) return false;
  return meta.four_burst_fire === true && toNum(meta.total_signals, -1) === 0;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toArray(v) { return Array.isArray(v) ? v : []; }
function fmt(v, fallback = '--') {
  if (v === null || v === undefined || v === '') return fallback;
  return String(v);
}
function fmtPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${(n * 100).toFixed(1)}%`;
}
function parseNums(input) {
  if (Array.isArray(input)) return input.map(Number).filter(Number.isFinite);
  if (typeof input === 'string') {
    return input.replace(/[{}[\]]/g, ' ').split(/[,\s|/]+/).map(n => Number(n.trim())).filter(Number.isFinite);
  }
  return [];
}
function safeJson(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
function isNight() {
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= 0 && m < 7 * 60;
}
function padNum(n) { return String(Number(n)).padStart(2, '0'); }

// ★ V0617-4：buildRandomGroups4已不再使用(RandomGroupsCard改為不顯示任何號碼)，移除避免誤用

async function apiFetch(path, options = {}) {
  const res = await fetch(`${RAILWAY_URL}${path}`, { cache: 'no-store', ...options });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function getActionStyle(action, forcedSwitch, lowConfidence) {
  if (lowConfidence) return { icon: '👀', label: '觀察期（低信心時段）', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' };
  if (forcedSwitch) return { icon: '⚡', label: '醞釀期（爆發切換）', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' };
  switch (action) {
    case '爆發出號': return { icon: '🔥', label: '爆發期', color: '#C8860A', bg: '#FFF9EC', border: '#F5D78B' };
    case '預備出號': return { icon: '⚡', label: '醞釀期', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' };
    case '參考出號': return { icon: '👀', label: '觀察期', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' };
    default: return { icon: '🔥', label: '出號', color: '#C8860A', bg: '#FFF9EC', border: '#F5D78B' };
  }
}

const C = {
  bg: '#FFF8F0', card: '#FFFFFF', gold: '#C8860A', goldLight: '#F5D78B',
  goldBg: '#FFF9EC', orange: '#E8722A', orangeLight: '#FDE8D8',
  green: '#16A34A', greenBg: '#F0FDF4', teal: '#0F766E',
  gray: '#6B7280', grayLight: '#F3F4F6', border: '#E5DDD0',
  text: '#2C1810', textSub: '#7B6E5C',
  purple: '#7C3AED', purpleBg: '#F5F3FF', purpleLight: '#DDD6FE',
  shadow: '0 2px 12px rgba(200,134,10,0.10)',
};

const S = {
  app: { minHeight: '100vh', background: C.bg, fontFamily: '"Segoe UI", "PingFang TC", "Noto Sans TC", sans-serif', color: C.text, paddingBottom: 70 },
  header: { background: `linear-gradient(135deg, ${C.gold} 0%, ${C.orange} 100%)`, padding: '12px 14px 10px', boxShadow: '0 2px 16px rgba(200,134,10,0.25)' },
  headerTitle: { fontSize: 17, fontWeight: 900, color: '#FFF', letterSpacing: 1, margin: 0 },
  headerSub: { fontSize: 11, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  tabs: { display: 'flex', background: C.card, borderBottom: `2px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 100, boxShadow: '0 2px 8px rgba(200,134,10,0.08)' },
  tab: (active) => ({ flex: 1, padding: '8px 2px 6px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10, fontWeight: active ? 700 : 400, color: active ? C.gold : C.gray, borderBottom: active ? `3px solid ${C.gold}` : '3px solid transparent', transition: 'all 0.2s' }),
  subTab: (active) => ({ flex: 1, padding: '6px 4px', border: 'none', background: active ? C.goldBg : 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: active ? 700 : 400, color: active ? C.gold : C.gray, borderRadius: 8, transition: 'all 0.2s' }),
  page: { padding: '10px 10px', maxWidth: 600, margin: '0 auto' },
  card: { background: C.card, borderRadius: 12, padding: '12px 12px 10px', marginBottom: 10, boxShadow: C.shadow, border: `1px solid ${C.border}` },
  cardTitle: { fontSize: 13, fontWeight: 700, color: C.gold, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 },
  badge: (color, bg) => ({ display: 'inline-block', fontSize: 10, padding: '2px 6px', borderRadius: 99, fontWeight: 600, color, background: bg }),
  ball: (hit) => ({ width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, background: hit === true ? C.gold : hit === false ? C.grayLight : C.goldBg, color: hit === true ? '#FFF' : hit === false ? C.gray : C.gold, border: `2px solid ${hit === true ? C.gold : hit === false ? C.border : C.goldLight}`, boxShadow: hit === true ? `0 2px 8px ${C.goldLight}` : 'none' }),
  randomBall: () => ({ width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, background: C.purpleBg, color: C.purple, border: `2px solid ${C.purpleLight}` }),
  statRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${C.border}` },
  statLabel: { fontSize: 12, color: C.textSub },
  statValue: { fontSize: 13, fontWeight: 700, color: C.text },
  bigNum: { fontSize: 26, fontWeight: 900, color: C.gold },
  btn: (disabled) => ({ background: disabled ? C.grayLight : `linear-gradient(135deg, ${C.gold}, ${C.orange})`, color: disabled ? C.gray : '#FFF', border: 'none', borderRadius: 10, padding: '9px 16px', fontSize: 13, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: disabled ? 'none' : C.shadow, width: '100%', marginTop: 6 }),
  divider: { height: 1, background: C.border, margin: '10px 0' },
  empty: { color: C.textSub, fontSize: 13, padding: '12px 0', textAlign: 'center' },
  recentBall: () => ({ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, background: C.grayLight, color: C.textSub }),
};

function Card({ title, icon, children, right }) {
  return (
    <div style={S.card}>
      {title && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={S.cardTitle}>{icon && <span>{icon}</span>}{title}</div>
          {right && <div>{right}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

function Ball({ n, hit }) { return <div style={S.ball(hit)}>{padNum(n)}</div>; }
// ★ V0617-4：RandomBall已不再使用，移除避免誤用
function StatRow({ label, value, valueColor }) {
  return (
    <div style={S.statRow}>
      <span style={S.statLabel}>{label}</span>
      <span style={{ ...S.statValue, color: valueColor || C.text }}>{value}</span>
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}>
      <div style={{ width: 32, height: 32, borderRadius: '50%', border: `3px solid #F5D78B`, borderTopColor: C.gold, animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function RandomGroupsCard({ drawNo, skipMeta }) {
  // ★ V0617-4：徹底移除隨機號碼產生，skip時只顯示期數和文字，現實使用上不該有任何號碼出現
  return (
    <Card title="本期預測" icon="⏸️">
      <div style={{ textAlign: 'center', padding: '32px 12px' }}>
        <div style={{ fontSize: 13, color: C.textSub, marginBottom: 8 }}>
          預測期號 {fmt(drawNo)}
        </div>
        <div style={{ fontSize: 20, fontWeight: 900, color: '#DC2626' }}>
          🔴 本期空窗（不出號）
        </div>
        <div style={{ fontSize: 12, color: C.textSub, marginTop: 8 }}>
          主系統本期暫停出手
        </div>
      </div>
    </Card>
  );
}

function QuickPage({ prediction, recent20, onRefresh, loading }) {
  const row = prediction?.latest_3star_row;
  const compareResult = safeJson(row?.compare_result_json) || safeJson(row?.compare_result);
  const detail = toArray(compareResult?.detail);
  const allGroups = toArray(row?.groups_json);
  const groups = allGroups.slice(0, 8);
  const isDone = row?.compare_status === 'done';
  const bestHit = toNum(row?.hit_count, 0);
  const latestDraw = toArray(recent20)[0];
  const isSkipped = !row || row?.status === 'skipped' || allGroups.length === 0;
  const action = groups[0]?.meta?.action || '出號';
  const forcedSwitch = false;  // V0615-1後端已移除此欄位
  // ★ 修正：用當前時間判斷低信心時段
  const nowHour = new Date().getHours();
  const lowConfidence = nowHour >= 12 && nowHour <= 15;
  const consecutiveBurst = toNum(groups[0]?.meta?.consecutive_burst, 0);
  const actionStyle = getActionStyle(action, forcedSwitch, lowConfidence);

  // ★ 連續期數計算（用於醒目提示）
  const burstNo = action === '爆發出號' && !forcedSwitch ? consecutiveBurst + 1 : 0;
  const recentRows = toArray(prediction?.recent_3star_compared_rows) || [];
  let brewCount = 0;
  if (action === '預備出號') {
    brewCount = 1;
    for (const r of recentRows) {
      const rPos = toArray(r?.groups_json)[0]?.meta?.position || '';
      if (rPos === '醞釀期') brewCount++;
      else break;
    }
  }

  const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.orange : C.textSub;

  const comparedDrawNumsArr = toArray(compareResult?.draw_nums);
  const drawNums = new Set(
    comparedDrawNumsArr.length > 0
      ? comparedDrawNumsArr.map(Number)
      : parseNums(latestDraw?.numbers)
  );

  const hit2Groups = detail.filter(d => toNum(d?.hit, 0) === 2).length;
  const isWarning = hit2Groups >= 3;
  const activeTrackLabel = isSkipped ? '主系統空窗' : '主系統（formal_3star）';
  const activeTrackColor = isSkipped ? C.gray : C.green;

  // ★ 換手率計算
  const prevPool = (recentRows[0]?.groups_json?.[0]?.meta?.hot_pool || '').split(',').filter(Boolean);
  const curPool = (groups[0]?.meta?.hot_pool || '').split(',').filter(Boolean);
  const changedCount = curPool.filter(n => !prevPool.includes(n)).length;
  const isFastTurnover = prevPool.length > 0 && changedCount >= 4;
  const isSlowTurnover = prevPool.length > 0 && changedCount <= 1;

  // ★ 蜘蛛感知系統：從meta讀取後端計算的真信號
  const isHighHour = (nowHour >= 9 && nowHour <= 11) || (nowHour >= 16 && nowHour <= 18);
  const isDeadHour = nowHour >= 12 && nowHour <= 15;
  const position = groups[0]?.meta?.position || '';
  // ★ V0617-1：isAvoidNow提升到元件最外層，讓「行動建議框」和「本期預測」卡片用同一套判斷標準
  // 避免「不要衝」卻還顯示完整號碼列表的矛盾
  const _prevDetailForAvoid = toArray(recentRows[0]?.compare_result_json?.detail);
  const _prevHit3CountForAvoid = _prevDetailForAvoid.filter(d => toNum(d?.hit, 0) === 3).length;
  // ★ V0617-3：改用「是否skip」當唯一標準，不疊加isDeadHour/prevHit3Count等規則
  // 避免「有出手卻被判定不要衝」這種曖昧狀態，現實使用上只要二元判斷：有出手=可進場，skip=不推薦
  const _activeModeNow = groups[0]?.meta?.active_mode || 'standard';
  const isAvoidNow = isSkipped || _activeModeNow === 'skip';
  const spiderMode = '';  // V0615-1後端已移除此欄位
  const trueSignalCount = toNum(groups[0]?.meta?.total_signals, 0);  // 改讀新版total_signals
  const sigHighHour = groups[0]?.meta?.sig_high_hour === true;
  const sigSlowTurnover = groups[0]?.meta?.sig_slow_turnover === true;
  const sigHighZone = groups[0]?.meta?.sig_high_zone === true;
  const sigBrew4Hour = groups[0]?.meta?.sig_brew4_hour === true;
  const sigPrevHit = groups[0]?.meta?.sig_prev_hit === true;
  const totalQualified = toNum(groups[0]?.meta?.total_qualified, 0);

  // ★ 蜘蛛感知信心指數 V0611-3
  const sigConcentrated = groups[0]?.meta?.sig_concentrated === true;
  const isConcentrated = groups[0]?.meta?.is_concentrated === true;

  let confidenceScore = 0;
  let confidenceReasons = [];

  // ★ V0612-3：sig_high_hour 反向歸納SQL驗證 true(1.04%) < false(1.59%)
  // 方向與系統假設相反，原+50分暫時中立化為0分，待累積更多資料後再決定方向
  if (sigHighHour) {
    confidenceScore += 0;
    confidenceReasons.push(`${nowHour}點高命中時段(中立化，待驗證)`);
  }
  // 號碼集中（SQL E：集中17.95% vs 分散12.11%）
  if (sigConcentrated) {
    confidenceScore += 20;
    confidenceReasons.push(`號碼集中(+20)`);
  }
  // 換手穩定（命中率13-25%）
  // ★ V0612-3：B.txt已補上sig_slow_turnover欄位輸出，此項目原為死代碼，現恢復生效
  if (sigSlowTurnover) {
    confidenceScore += 20;
    confidenceReasons.push(`換手穩定(+20)`);
  }
  // ★ V0613-2：sig_high_zone(合格池61-80號碼數>=2)驗證後發現
  // 在total_qualified>=15時幾乎恆為true(315筆裡313筆為true)，
  // 門檻相對池子大小過低、幾乎無區分力，原+15分中立化為0分
  if (sigHighZone) {
    confidenceScore += 0;
    confidenceReasons.push(`高號區61-80(中立化，待驗證)`);
  }
  // 醞釀4期+時段（命中率15.38%）
  if (sigBrew4Hour) {
    confidenceScore += 15;
    confidenceReasons.push(`醞釀${brewCount}期+時段(+15)`);
  }
  // 前1期中2後（命中率12.78%）
  if (sigPrevHit) {
    confidenceScore += 10;
    confidenceReasons.push(`前1期有中(+10)`);
  }
  // 號碼池太少
  if (totalQualified < 8) {
    confidenceScore -= 30;
    confidenceReasons.push(`號碼池稀少(-30)`);
  }
  // 12-15點死亡時段
  if (isDeadHour) {
    confidenceScore -= 50;
    confidenceReasons.push(`12-15點死亡時段(-50)`);
  }
  // 觀察期
  if (position === '觀察期') {
    confidenceScore -= 20;
    confidenceReasons.push(`觀察期弱信號(-20)`);
  }
  // ★ V0613-3：爆發期+normal組合驗證後hit3率14.29%(56筆)，
  // 是目前驗證樣本裡最高的單一組合，新增加分項
  if (position === '爆發期') {
    confidenceScore += 10;
    confidenceReasons.push(`爆發期(+10)`);
  }
  // ★ V0613-3：is_brew_low_point 全歷史245筆樣本裡從未出現true，
  // 確認為死代碼（此規則從未被觸發），原-40分規則已移除

  // ★ V0612-3：信心等級門檻 50/20 → 60/30，對齊系統摘要文件規範
  const confidenceLevel =
    confidenceScore >= 80 ? { label: '🕷️ 真獵物！閃電出手', color: '#DC2626', bg: '#FEF2F2', border: '#FCA5A5' } :
    confidenceScore >= 60 ? { label: '🎯 建議進場', color: '#15803D', bg: '#DCFCE7', border: '#86EFAC' } :
    confidenceScore >= 30 ? { label: '👀 觀察等待', color: '#6B7280', bg: '#F3F4F6', border: '#E5E7EB' } :
    { label: '⏸️ 葉子，不要衝', color: '#9CA3AF', bg: '#F9FAFB', border: '#E5E7EB' };

  return (
    <div style={S.page}>
      {/* 最新開獎 */}
      <Card title="最新開獎" icon="🎱">
        {latestDraw ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={S.statLabel}>期號 {fmt(latestDraw?.draw_no)}</span>
              <span style={S.statLabel}>{fmt(latestDraw?.draw_time)}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {parseNums(latestDraw?.numbers).sort((a, b) => a - b).map(n => (
                <div key={n} style={S.recentBall()}>{padNum(n)}</div>
              ))}
            </div>
          </>
        ) : <div style={S.empty}>載入中...</div>}
      </Card>

      {/* ★ V0617-3：行動建議框改為二元判斷(可進場/不推薦)，不再有「觀望」這種曖昧狀態 */}
      {!isSkipped && !isDone && (() => {
        const activeMode = groups[0]?.meta?.active_mode || 'standard';
        const totalSignals = toNum(groups[0]?.meta?.total_signals, 0);
        const confidenceLevel = groups[0]?.meta?.confidence_level || '';

        const isGo = !isAvoidNow;

        const mainReason = activeMode === 'ultra' ? `${totalSignals}個訊號共鳴！歷史avg_pnl=+115元/期`
          : activeMode === 'strong' ? `${totalSignals}個訊號共鳴，歷史avg_pnl=-31元/期`
          : activeMode === 'spider' ? '蜘蛛感知(TQ22+連穩)，已擴展12顆候選池'
          : `${totalSignals}個訊號，標準模式`;

        const actionBg = isGo ? '#DCFCE7' : '#FEE2E2';
        const actionBorder = isGo ? '#16A34A' : '#DC2626';
        const actionColor = isGo ? '#15803D' : '#DC2626';
        const actionIcon = isGo ? '🟢' : '🔴';
        const actionText = isGo ? '本期可進場' : '本期不推薦號碼';

        const soulLabel = confidenceLevel === 'cautious' ? '🧠冷靜期'
          : confidenceLevel === 'conservative' ? '🧠保守期'
          : confidenceLevel === 'aggressive' ? '🧠積極期'
          : confidenceLevel === 'learning' ? '🧠學習中'
          : confidenceLevel === 'normal' ? '🧠正常' : '';

        const firedSignals = getFiredSignals(groups[0]?.meta);
        const bsInfo = boardStateInfo(groups[0]?.meta?.board_state); // ★ V0620-3：盤面狀態標籤

        return (
          <div style={{ marginBottom: 12 }}>
            <div style={{ background: actionBg, border: `2px solid ${actionBorder}`, borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: actionColor }}>
                  {actionIcon} {actionText}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {isGo && soulLabel && (
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#6D28D9', background: '#EDE9FE', borderRadius: 6, padding: '3px 8px' }}>
                      {soulLabel}
                    </div>
                  )}
                  {isGo && bsInfo && (
                    <div style={{ fontSize: 10, fontWeight: 700, color: bsInfo.color, background: bsInfo.bg, borderRadius: 6, padding: '3px 8px' }}>
                      {bsInfo.text}
                    </div>
                  )}
                  {isGo && (
                    <div style={{ fontSize: 10, fontWeight: 700, color: actionColor, background: actionBorder + '22', borderRadius: 6, padding: '3px 8px' }}>
                      {modeLabel(activeMode)}
                    </div>
                  )}
                </div>
              </div>
              {isGo && (
                <div style={{ fontSize: 11, color: actionColor, marginTop: 4, opacity: 0.9 }}>
                  {mainReason}
                </div>
              )}
              {/* ★ V0619-2：顯示本期實際觸發的訊號組合，方便對照s1+s12(或+s9)組合的實戰表現 */}
              {isGo && firedSignals.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {firedSignals.map(sig => (
                    <span key={sig} style={{ fontSize: 10, fontWeight: 700, color: actionColor, background: '#FFF', border: `1px solid ${actionBorder}55`, borderRadius: 6, padding: '2px 6px' }}>
                      {SIGNAL_LABEL[sig] || sig}
                    </span>
                  ))}
                </div>
              )}
              {/* ★ V0621-5新增：靠新的four_count門檻出手、沒有任何s1-s12訊號背書時，明確標示原因 */}
              {isGo && isFiredByFourCountOnly(groups[0]?.meta) && (
                <div style={{ marginTop: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#0F766E', background: '#CCFBF1', borderRadius: 6, padding: '2px 6px' }}>
                    📊 候選池門檻出手(four_count={fmt(groups[0]?.meta?.four_count)})
                  </span>
                </div>
              )}
              {/* ★ V0620-4：謹慎旗標標籤(總和暴漲/奇偶失衡)，用橘色警示，跟訊號標籤分開一行 */}
              {isGo && getCautionLabels(groups[0]?.meta).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {getCautionLabels(groups[0]?.meta).map(label => (
                    <span key={label} style={{ fontSize: 10, fontWeight: 700, color: '#C2410C', background: '#FFEDD5', borderRadius: 6, padding: '2px 6px' }}>
                      ⚠️ {label}
                    </span>
                  ))}
                </div>
              )}
              {/* ★ V0621-3：超級組合觀察標籤，樣本量小(10-12期)，明確標示「觀察中」避免誤判成已驗證 */}
              {isGo && superComboInfo(groups[0]?.meta?.super_combo) && (
                <div style={{ marginTop: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: superComboInfo(groups[0]?.meta?.super_combo).color, background: superComboInfo(groups[0]?.meta?.super_combo).bg, borderRadius: 6, padding: '2px 6px' }}>
                    🔬 {superComboInfo(groups[0]?.meta?.super_combo).text}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ★ 多組中2預警 */}
      {isWarning && (
        <div style={{ background: '#FEF3C7', border: '2px solid #F59E0B', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#D97706' }}>⚡ 多組中2，下期注意</div>
          <div style={{ fontSize: 12, color: '#92400E', marginTop: 4 }}>本期有 {hit2Groups} 組中2，下期前1期中2命中率11.94%</div>
        </div>
      )}

      {/* ★ 爆發切換提示 */}
      {forcedSwitch && !lowConfidence && (
        <div style={{ background: '#FFF7ED', border: '1.5px solid #FED7AA', borderRadius: 12, padding: '8px 12px', marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#C2410C' }}>🔄 爆發期已連續{consecutiveBurst + 1}期，自動切換醞釀期號碼</div>
        </div>
      )}

      {/* 本期預測 */}
      <div style={{ marginBottom: 8 }}>
        <span style={S.badge(activeTrackColor, C.grayLight)}>當前來源：{activeTrackLabel}</span>
      </div>
      {isSkipped ? (
        <RandomGroupsCard drawNo={row?.source_draw_no || latestDraw?.draw_no} skipMeta={allGroups[0]?.meta} />
      ) : (
        <Card
          title="本期預測"
          icon={actionStyle.icon}
          right={
            isDone ? (
              <span style={S.badge(hitColor, hitColor + '18')}>
                {bestHit >= 3 ? `🏆 中${bestHit}！` : bestHit >= 2 ? `🔸 中${bestHit}(仍虧)` : `❌ 未中`}
              </span>
            ) : row ? (
              <span style={S.badge(C.orange, C.orangeLight)}>等待開獎</span>
            ) : null
          }
        >
          {isDone ? (
            // ★ V0617-4：已比對完成的歷史結果不在第一頁重複顯示，第二頁(近期)已經有完整紀錄
            (() => {
              const totalCost = groups.length * 25;
              const reward = bestHit >= 3 ? 500 : bestHit >= 2 ? 50 : 0;
              const netPnl = reward - totalCost;
              const bg = bestHit >= 3 ? C.goldBg : netPnl >= 0 ? C.grayLight : '#FEF3F2';
              const label = bestHit >= 3 ? '🏆 恭喜中3！' : bestHit >= 2 ? '🔸 中2（仍虧本）' : '❌ 未中';
              const labelColor = bestHit >= 3 ? hitColor : netPnl < 0 ? '#B91C1C' : C.textSub;
              return (
                <div style={{ textAlign: 'center', padding: '20px 12px' }}>
                  <div style={{ fontSize: 13, color: C.textSub, marginBottom: 8 }}>
                    比對期號 {fmt(detail[0]?.draw_no)}
                  </div>
                  <div style={{ ...S.bigNum, color: labelColor }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 12, color: C.textSub, marginTop: 6 }}>
                    本期淨損益：<span style={{ fontWeight: 800, color: netPnl >= 0 ? '#15803D' : '#B91C1C' }}>{netPnl >= 0 ? '+' : ''}{netPnl}元</span>
                    　(獎金{reward}元－成本{totalCost}元)
                  </div>
                  <div style={{ fontSize: 11, color: C.textSub, marginTop: 10, opacity: 0.7 }}>
                    完整號碼明細請見「近期」頁
                  </div>
                </div>
              );
            })()
          ) : isAvoidNow ? (
            // ★ V0617-3：不推薦時完全不渲染號碼，只顯示期數和文字，現實使用上更斷然
            <div style={{ textAlign: 'center', padding: '32px 12px' }}>
              <div style={{ fontSize: 13, color: C.textSub, marginBottom: 8 }}>
                預測期號 {fmt(toNum(row?.source_draw_no, 0) + 1)}
              </div>
              <div style={{ fontSize: 20, fontWeight: 900, color: '#DC2626' }}>
                🔴 本期不推薦號碼
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                <span style={S.badge(C.textSub, C.grayLight)}>
                  {isDone && detail.length > 0 ? `比對期號 ${fmt(detail[0]?.draw_no)}` : `預測期號 ${fmt(toNum(row?.source_draw_no, 0) + 1)}`}
                </span>
                <span style={S.badge(C.teal, C.greenBg)}>{groups.length} 組</span>
              </div>

              {groups.map((g, idx) => {
                const nums = parseNums(g?.nums);
                const key = String(g?.key || g?.meta?.strategy_key || idx);
                const matchDetail = detail.find(d => String(d?.strategy_key) === key);
                const hit = matchDetail ? toNum(matchDetail.hit, -1) : -1;
                const is3 = hit >= 3;
                const is2 = hit === 2;
                return (
                  <div key={key} style={{ background: is3 ? C.goldBg : C.grayLight, border: `2px solid ${is3 ? C.goldLight : C.border}`, borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: C.textSub }}>第{idx + 1}組</div>
                      {isDone && hit >= 0 && (
                        <span style={{ fontSize: 16, fontWeight: 900, color: is3 ? C.gold : is2 ? C.orange : C.gray }}>
                          {is3 ? `🏆 中${hit}` : is2 ? `中${hit}(仍虧)` : `中${hit}`}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {nums.map(n => {
                        const isHit = isDone && drawNums.has(n);
                        return <Ball key={n} n={n} hit={isDone ? (isHit ? true : false) : undefined} />;
                      })}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </Card>
      )}

      <button style={S.btn(loading)} onClick={onRefresh} disabled={loading}>
        {loading ? '更新中...' : '🔄 刷新資料'}
      </button>
    </div>
  );
}

function HistoryPage({ historyRows }) {
  const rows = toArray(historyRows).slice(0, 20);
  return (
    <div style={S.page}>
      <Card title="近期命中紀錄" icon="📋">
        {!rows.length ? <div style={S.empty}>尚無比對紀錄</div> : rows.map((row, idx) => {
          const compareResult = safeJson(row?.compare_result_json) || safeJson(row?.compare_result);
          const detail = toArray(compareResult?.detail);
          const allGroups = toArray(row?.groups_json);
          const groups = allGroups.slice(0, 8);
          const bestHit = toNum(row?.hit_count, 0);
          const isDone = row?.compare_status === 'done';
          const isSkipped = row?.status === 'skipped' || allGroups.length === 0;
          // ★ V0618-6：histIsAvoid提升到此處，跟isSkipped同源，後面「行動建議標籤」與「是否渲染號碼」統一用這一個變數判斷，
          // 避免標籤顯示「🔴不推薦」但下方仍渲染完整號碼組合的矛盾(active_mode='skip'但status未必是'skipped'的情況)
          const histMode = allGroups[0]?.meta?.active_mode || '';
          const histIsAvoid = isSkipped || histMode === 'skip';
          const action = allGroups[0]?.meta?.action || '';
          const position = allGroups[0]?.meta?.position || '';
          const forcedSwitch = false;  // V0615-1已移除
          const lowConfidence = allGroups[0]?.meta?.low_confidence_hour === true;
          const actionStyle = getActionStyle(action, forcedSwitch, lowConfidence);
          const comparedDraw = toArray(compareResult?.detail)[0]?.draw_no;
          const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.orange : C.gray;

          // ★ 信心分數：改用 confidenceScore 已驗證公式（與快速頁一致）
          // 直接讀取後端輸出的 sig_* 欄位，而非重新用 meta 推算
          const metaHour = row?.created_at ? (new Date(row.created_at).getUTCHours() + 8) % 24 : 0;
          const meta0 = allGroups[0]?.meta || {};
          const sigConcentrated = meta0?.sig_concentrated === true;
          const sigSlowTurnover = meta0?.sig_slow_turnover === true;
          const sigBrew4Hour = meta0?.sig_brew4_hour === true;
          const sigPrevHit = meta0?.sig_prev_hit === true;
          const totalQualified = toNum(meta0?.total_qualified, 0);
          const isDeadHourHist = metaHour >= 12 && metaHour <= 15;
          // ★ V0613-8：histScore/histLevel已移除，改為直接顯示sig_*盤面狀態標籤

          return (
            <div key={row?.id || idx} style={{ ...S.card, marginBottom: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.textSub }}>
                      預測 {fmt(row?.source_draw_no)} → 比對 {fmt(comparedDraw || '')}
                    </span>
                  </div>
                  {!isSkipped && position && (
                    <div style={{ marginTop: 3, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {/* 週期標籤 */}
                      <span style={{ fontSize: 11, fontWeight: 700,
                        color: position === '爆發期' ? '#92400E' : position === '醞釀期' ? '#166534' : '#64748B',
                        background: position === '爆發期' ? '#FEF9C3' : position === '醞釀期' ? '#DCFCE7' : '#F1F5F9',
                        borderRadius: 6, padding: '2px 8px', display: 'inline-block' }}>
                        {position === '爆發期' ? '🔥' : position === '醞釀期' ? '🌱' : '👁️'} {position}
                      </span>
                      {/* 行動建議標籤(對應第一頁，二元判斷) */}
                      {(() => {
                        const label = histIsAvoid ? '🔴 不推薦' : '🟢 可進場';
                        const bg = histIsAvoid ? '#FEE2E2' : '#DCFCE7';
                        const color = histIsAvoid ? '#DC2626' : '#15803D';
                        return (
                          <span style={{ fontSize: 11, fontWeight: 700, color, background: bg, borderRadius: 6, padding: '2px 8px', display: 'inline-block' }}>
                            {label}
                          </span>
                        );
                      })()}
                    </div>
                  )}
                  {/* ★ V0620-3：盤面狀態標籤，獨立於isSkipped之外顯示(跳過的期數也能看出是不是D_burst_danger造成跳過) */}
                  {(() => {
                    const bsInfo = boardStateInfo(meta0?.board_state);
                    if (!bsInfo) return null;
                    return (
                      <div style={{ marginTop: 3 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: bsInfo.color, background: bsInfo.bg, borderRadius: 6, padding: '2px 8px', display: 'inline-block' }}>
                          {bsInfo.text}
                        </span>
                      </div>
                    );
                  })()}
                  {/* ★ V0619-2：顯示該期實際觸發的訊號組合，方便回頭對照s1+s12(或+s9)組合表現 */}
                  {!isSkipped && !histIsAvoid && (() => {
                    const firedSignals = getFiredSignals(meta0);
                    if (firedSignals.length === 0) return null;
                    return (
                      <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {firedSignals.map(sig => (
                          <span key={sig} style={{ fontSize: 10, fontWeight: 700, color: C.textSub, background: C.grayLight, borderRadius: 6, padding: '2px 6px' }}>
                            {SIGNAL_LABEL[sig] || sig}
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                  {/* ★ V0621-5新增：靠new four_count門檻出手、沒有任何s1-s12訊號背書時，明確標示原因 */}
                  {!isSkipped && !histIsAvoid && isFiredByFourCountOnly(meta0) && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: '#0F766E', background: '#CCFBF1', borderRadius: 6, padding: '2px 6px' }}>
                        📊 候選池門檻出手(four_count={fmt(meta0?.four_count)})
                      </span>
                    </div>
                  )}
                  {/* ★ V0620-4：謹慎旗標標籤，獨立顯示(跳過的期數也能看出是不是caution flag影響的) */}
                  {getCautionLabels(meta0).length > 0 && (
                    <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {getCautionLabels(meta0).map(label => (
                        <span key={label} style={{ fontSize: 10, fontWeight: 700, color: '#C2410C', background: '#FFEDD5', borderRadius: 6, padding: '2px 6px' }}>
                          ⚠️ {label}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* ★ V0621-3：超級組合觀察標籤 */}
                  {superComboInfo(meta0?.super_combo) && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: superComboInfo(meta0?.super_combo).color, background: superComboInfo(meta0?.super_combo).bg, borderRadius: 6, padding: '2px 6px' }}>
                        🔬 {superComboInfo(meta0?.super_combo).text}
                      </span>
                    </div>
                  )}
                </div>
                {isSkipped ? (
                  (() => {
                    const skipReason = allGroups[0]?.meta?.skip_reason || '';
                    return skipReason === 'soul_blocked'
                      ? <span style={{ fontSize: 12, color: '#92400E', whiteSpace: 'nowrap' }}>🧠 靈魂封鎖</span>
                      : <span style={{ fontSize: 12, color: C.purple, whiteSpace: 'nowrap' }}>⏸️ 隨機參考期</span>;
                  })()
                ) : isDone ? (
                  <span style={{ fontSize: 15, fontWeight: 900, color: hitColor, whiteSpace: 'nowrap' }}>
                    {bestHit >= 3 ? `🏆 中${bestHit}` : bestHit >= 2 ? `🔸 中${bestHit}(仍虧)` : `❌ 未中`}
                  </span>
                ) : <span style={{ fontSize: 12, color: C.orange, whiteSpace: 'nowrap' }}>等待比對</span>}
              </div>
              {histIsAvoid ? (() => {
                const skipMeta = allGroups[0]?.meta || {};
                const skipReason = skipMeta?.skip_reason || '';
                const skipConfidence = skipMeta?.confidence_level || '';
                if (skipReason === 'soul_blocked') {
                  return (
                    <div style={{ fontSize: 11, color: '#92400E', background: '#FEF9C3', borderRadius: 6, padding: '4px 8px', display: 'inline-block' }}>
                      🧠 靈魂封鎖（{skipConfidence === 'cautious' ? '冷靜期' : '保守期'}）：模式={modeLabel(skipMeta?.active_mode)} 暫不出手
                    </div>
                  );
                }
                return (
                  <div style={{ fontSize: 11, color: C.purple, background: C.purpleBg, borderRadius: 6, padding: '4px 8px', display: 'inline-block' }}>
                    🎲 該期訊號不足，無命中統計
                  </div>
                );
              })() : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {groups.map((g, gIdx) => {
                    const key = String(g?.key || g?.meta?.strategy_key || gIdx);
                    const nums = parseNums(g?.nums);
                    const matchDetail = detail.find(d => String(d?.strategy_key) === key);
                    const hit = matchDetail ? toNum(matchDetail.hit, 0) : 0;
                    return (
                      <div key={key} style={{ background: hit >= 3 ? C.goldBg : hit >= 2 ? C.orangeLight : C.grayLight, borderRadius: 8, padding: '4px 8px', fontSize: 12, border: `1px solid ${hit >= 3 ? C.goldLight : hit >= 2 ? C.orange : C.border}` }}>
                        {nums.map(n => padNum(n)).join(' ')}
                        {isDone && <span style={{ marginLeft: 4, fontWeight: 700, color: hit >= 3 ? C.gold : hit >= 2 ? C.orange : C.gray }}>中{hit}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function StatsPage({ historyRows }) {
  const aRows = toArray(historyRows).filter(r => r?.compare_status === 'done' && toArray(r?.groups_json).length > 0);

  const calcSimpleStats = (rows) => {
    const total = rows.length;
    const hit3 = rows.filter(r => toNum(r?.hit_count, 0) >= 3).length;
    const hit2p = rows.filter(r => toNum(r?.hit_count, 0) >= 2).length;
    const groupsArr = rows.map((r) => {
      const fromResult = toNum(r?.compare_result_json?.groups_count, 0);
      if (fromResult > 0) return fromResult;
      return toArray(r?.groups_json).filter(g => g?.key !== 'skip_meta').length;
    });
    const avgGroups = groupsArr.length ? groupsArr.reduce((a, b) => a + b, 0) / groupsArr.length : 0;
    const totalCost = groupsArr.reduce((sum, g) => sum + g * 25, 0);
    const totalReward = rows.reduce((sum, r) => sum + toNum(r?.compare_result_json?.total_reward, 0), 0);
    const pnl = totalReward - totalCost;
    return {
      total,
      hit3,
      hit2p,
      hit3Rate: total > 0 ? hit3 / total : 0,
      hit2pRate: total > 0 ? hit2p / total : 0,
      avgGroups,
      totalCost,
      totalReward,
      pnl,
      avgPnl: total > 0 ? pnl / total : 0,
    };
  };

  const a = calcSimpleStats(aRows);
  const recentA = aRows.slice(0, 20);

  return (
    <div style={S.page}>
      <Card title="主系統績效（formal_3star）" icon="📊">
        <StatRow label="已比對期數" value={`${a.total} 期`} />
        <StatRow label="中3命中率" value={fmtPercent(a.hit3Rate)} valueColor={a.hit3Rate >= 0.1 ? C.green : C.orange} />
        <StatRow label="中2以上命中率" value={fmtPercent(a.hit2pRate)} />
        <StatRow label="平均出手組數" value={a.avgGroups.toFixed(2)} />
        <StatRow label="總損益" value={`${a.pnl >= 0 ? '+' : ''}${a.pnl} 元`} valueColor={a.pnl >= 0 ? C.green : '#DC2626'} />
        <StatRow label="平均每期損益" value={`${a.avgPnl >= 0 ? '+' : ''}${a.avgPnl.toFixed(2)} 元`} valueColor={a.avgPnl >= 0 ? C.green : '#DC2626'} />
      </Card>

      <Card title="最近20筆" icon="📌">
        {recentA.length === 0 ? (
          <div style={S.empty}>尚無比對資料</div>
        ) : recentA.map((r, idx) => {
          const hit = toNum(r?.hit_count, 0);
          const groups = toNum(r?.compare_result_json?.groups_count, 0) || toArray(r?.groups_json).filter(g => g?.key !== 'skip_meta').length;
          const reward = toNum(r?.compare_result_json?.total_reward, 0);
          const pnl = reward - groups * 25;
          return (
            <div key={r?.id || idx} style={S.statRow}>
              <span style={{ fontSize: 12 }}>
                {fmt(r?.source_draw_no)}｜中{hit}｜{groups}組
              </span>
              <span style={{ fontSize: 12, fontWeight: 700, color: pnl >= 0 ? C.green : '#DC2626' }}>
                {pnl >= 0 ? '+' : ''}{pnl}
              </span>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function MarketPage({ recent20 }) {
  const rows = toArray(recent20).slice(0, 20);
  return (
    <div style={S.page}>
      <Card title="最近20期開獎" icon="🎯">
        {!rows.length ? <div style={S.empty}>載入中...</div> : rows.map((row, idx) => {
          const nums = parseNums(row?.numbers).sort((a, b) => a - b);
          return (
            <div key={row?.draw_no || idx} style={{ ...S.statRow, alignItems: 'flex-start', paddingTop: 10, paddingBottom: 10 }}>
              <div style={{ minWidth: 80 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>#{fmt(row?.draw_no)}</div>
                <div style={{ fontSize: 11, color: C.textSub }}>{fmt(row?.draw_time)?.slice(11, 16)}</div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 }}>
                {nums.map(n => (
                  <div key={n} style={{ ...S.recentBall(), width: 28, height: 28, fontSize: 11 }}>{padNum(n)}</div>
                ))}
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function HotPage({ recent20 }) {
  const rows = toArray(recent20).slice(0, 20);

  // ★ 連續開出期數：從最新一期(rows[0])往前算，這個號碼連續幾期都有開出
  // 一旦遇到某期沒開出該號碼就停止計算
  function consecutiveCount(num) {
    let c = 0;
    for (const row of rows) {
      if (parseNums(row?.numbers).includes(num)) c++;
      else break;
    }
    return c;
  }

  // 計算1-80每個號碼目前的連續開出期數
  const numStats = [];
  for (let n = 1; n <= 80; n++) {
    const consec = consecutiveCount(n);
    if (consec >= 1) numStats.push({ n, consec });
  }

  // 依連續期數分組：5/4/3/2/1
  const groups = [5, 4, 3, 2, 1].map(level => ({
    level,
    data: numStats.filter(s => s.consec === level).sort((a, b) => a.n - b.n)
  }));

  const levelInfo = {
    5: { label: '連續5期（最熱）', color: '#DC2626', bg: '#FEF2F2', border: '#FCA5A5' },
    4: { label: '連續4期', color: '#EA580C', bg: '#FFF7ED', border: '#FED7AA' },
    3: { label: '連續3期', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
    2: { label: '連續2期', color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
    1: { label: '連續1期（剛開出）', color: '#6B7280', bg: '#F3F4F6', border: '#E5E7EB' },
  };

  return (
    <div style={S.page}>
      <Card title="連續熱號看盤" icon="🔥">
        <div style={{ fontSize: 11, color: C.textSub, marginBottom: 12, lineHeight: 1.6 }}>
          純粹看盤用：依「最近20期」資料，從最新一期往前算，列出每個號碼目前連續開出幾期。
          此頁僅供參考，與AI選號邏輯（本期預測頁）無關、不互相影響。
          想看AI本期實際選中的號碼池，請至「熱號池」頁。
        </div>
        {!rows.length ? <div style={S.empty}>載入中...</div> : groups.map(g => {
          const info = levelInfo[g.level];
          return (
            <div key={g.level} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: info.color, background: info.bg, border: `1px solid ${info.border}`, borderRadius: 6, padding: '2px 8px' }}>
                  {info.label}
                </span>
                <span style={{ fontSize: 11, color: C.textSub }}>{g.data.length} 顆</span>
              </div>
              {g.data.length === 0 ? (
                <div style={{ fontSize: 12, color: C.textSub, padding: '4px 0' }}>目前無號碼符合此等級</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {g.data.map(({ n }) => (
                    <div key={n} style={{
                      width: 32, height: 32, borderRadius: '50%',
                      background: info.bg,
                      border: `2px solid ${info.border}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14, fontWeight: 800,
                      color: info.color,
                    }}>
                      {padNum(n)}
                    </div>
                  ))}
                </div>
              )}
              <div style={S.divider} />
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function HotPoolPage({ prediction }) {
  const row = prediction?.latest_3star_row;
  const groups = toArray(row?.groups_json);
  const meta0 = groups[0]?.meta || {};
  const hotPool = (meta0?.hot_pool || '').split(',').map(Number).filter(Boolean);
  const action = meta0?.action || '';
  const position = meta0?.position || '';
  const spiderMode = '';  // V0615-1已移除
  const forcedSwitch = false;  // V0615-1已移除
  const nowHour = new Date().getHours();
  const lowConfidence = nowHour >= 12 && nowHour <= 15;
  const actionStyle = getActionStyle(action, forcedSwitch, lowConfidence);
  const isSkipped = !row || row?.status === 'skipped' || groups.length === 0;

  return (
    <div style={S.page}>
      <Card title="本期AI熱號池" icon="🕷️">
        <div style={{ fontSize: 11, color: C.textSub, marginBottom: 12, lineHeight: 1.6 }}>
          這裡顯示的號碼池，與「本期預測」（快速頁）使用完全同一份資料，
          是 buildBingoGroups 本期實際選出、用來組成3星預測的熱號池（最多7顆）。
          V0613-4曾改為24顆不重疊分組，但實測63期淨利惡化(-40.43→-111.11/期，
          因為失去多組同時中2的機會)，已於V0613-5回滾為7顆池重疊組合，V0613-6固定取8種最佳位置組合(-75.88)，V0613-7改用候選池前10名+G策略8組，3000期驗證avg_pnl=-84.22(優於V0613-6的-90.52，約6元/期)。
        </div>
        {isSkipped ? (
          <div style={S.empty}>本期AI暫停出號（冷場期），無熱號池資料</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: actionStyle.color, background: actionStyle.bg, border: `1px solid ${actionStyle.border}`, borderRadius: 6, padding: '2px 8px' }}>
                {actionStyle.icon} {actionStyle.label}
              </span>
              {spiderMode && <span style={S.badge(C.textSub, C.grayLight)}>模式：{spiderMode}</span>}
              <span style={S.badge(C.textSub, C.grayLight)}>期號 {fmt(row?.source_draw_no)}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {hotPool.map(n => (
                <div key={n} style={{
                  width: 36, height: 36, borderRadius: '50%',
                  background: C.goldBg,
                  border: `2px solid ${C.goldLight}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 15, fontWeight: 800,
                  color: C.gold,
                }}>
                  {padNum(n)}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: C.textSub, marginTop: 12 }}>
              共 {hotPool.length} 顆；AI會優先從這個池子裡組合出8組(C(7,3)取前8組，含top5≥2顆優先)。
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('quick');
  const [loading, setLoading] = useState(false);
  const [prediction, setPrediction] = useState(null);
  const [recent20, setRecent20] = useState([]);
  const [historyRows, setHistoryRows] = useState([]);
  const [loopStatus, setLoopStatus] = useState('初始化中...');
  const timerRef = useRef(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [predRes, recentRes] = await Promise.all([
        apiFetch('/api/prediction-latest').catch(() => ({})),
        apiFetch('/api/recent20').catch(() => ({})),
      ]);
      setPrediction(predRes);
      setHistoryRows(predRes?.recent_3star_compared_rows || predRes?.recent_compared_rows || []);
      setRecent20(recentRes?.recent20 || recentRes?.data || []);
      setLoopStatus(isNight() ? '夜間停止（00:00-07:00）' : `已更新 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`);
    } catch {
      setLoopStatus('載入失敗，稍後重試');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    timerRef.current = setInterval(loadData, REFRESH_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [loadData]);

  const TABS = [
    { key: 'quick', label: '快速', icon: '⚡' },
    { key: 'history', label: '近期', icon: '📋' },
    { key: 'stats', label: '統計', icon: '📊' },
    { key: 'market', label: '開獎', icon: '🎱' },
    { key: 'hot', label: '熱號', icon: '🔥' },
    { key: 'hotpool', label: '熱號池', icon: '🕷️' },
  ];

  return (
    <div style={S.app}>
      <div style={S.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={S.headerTitle}>🏆 富緯賓果 AI V0709-Aonly-hotfix41</div>
            <div style={S.headerSub}>{loopStatus}</div>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', marginTop: 2 }}>
            {new Date().toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>
      <div style={S.tabs}>
        {TABS.map(t => (
          <button key={t.key} style={S.tab(tab === t.key)} onClick={() => setTab(t.key)}>
            <div>{t.icon}</div>
            <div>{t.label}</div>
          </button>
        ))}
      </div>
      {loading && tab === 'quick' && <Spinner />}
      {tab === 'quick' && <QuickPage prediction={prediction} recent20={recent20} onRefresh={loadData} loading={loading} />}
      {tab === 'history' && <HistoryPage historyRows={historyRows} />}
      {tab === 'stats' && <StatsPage historyRows={historyRows} />}
      {tab === 'market' && <MarketPage recent20={recent20} />}
      {tab === 'hot' && <HotPage recent20={recent20} />}
      {tab === 'hotpool' && <HotPoolPage prediction={prediction} />}
    </div>
  );
}



