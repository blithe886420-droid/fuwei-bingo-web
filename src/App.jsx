import React, { useCallback, useEffect, useRef, useState } from 'react';

const RAILWAY_URL = 'https://fuwei-bingo-backend-production.up.railway.app';
const REFRESH_INTERVAL_MS = 30000;
const STATS_START_DATE = '2026-06-08T00:00:00.000Z';

// V0623-2：四種active_mode中文對照
const MODE_LABEL = {
  standard: '標準', strong: '強訊號', ultra: '超強訊號', spider: '蜘蛛感知',
};
function modeLabel(m) { return MODE_LABEL[m] || m || '-'; }

// V0620-3：五種盤面狀態中文對照
const BOARD_STATE_LABEL = {
  A_golden:        { text: '黃金共振', color: '#B45309', bg: '#FEF3C7' },
  B_spider_calm:   { text: '蜘蛛靜默', color: '#15803D', bg: '#DCFCE7' },
  D_burst_danger:  { text: '爆發危險區', color: '#DC2626', bg: '#FEE2E2' },
  E_false_momentum:{ text: '假動能',   color: '#9333EA', bg: '#F3E8FF' },
  F_quiet:         { text: '平淡期',   color: '#6B7280', bg: '#F3F4F6' },
};
function boardStateInfo(s) { return BOARD_STATE_LABEL[s] || null; }

// V0623-2：選號策略中文對照，V0625-2加入wide_spread和gradient
const SELECTION_STRATEGY_LABEL = {
  core_outer:  { text: '🎯 核心外圍', color: '#B45309', bg: '#FEF3C7' },
  spider_mid:  { text: '🔬 次熱號優先', color: '#0E7490', bg: '#CFFAFE' },
  wide_spread: { text: '🌐 寬幅分散', color: '#7C3AED', bg: '#F5F3FF' },
  gradient:    { text: '📐 梯度遞減', color: '#059669', bg: '#ECFDF5' },
};
function selectionStrategyInfo(s) { return SELECTION_STRATEGY_LABEL[s] || null; }

// V0623-2：回饋迴路信心等級
const FEEDBACK_LABEL = {
  hot:        { text: '回饋:發燙🔥', color: '#15803D', bg: '#DCFCE7' },
  normal:     { text: '回饋:正常',   color: '#6B7280', bg: '#F3F4F6' },
  cold:       { text: '回饋:冷場觀察', color: '#DC2626', bg: '#FEE2E2' },
  regression: { text: '回饋:均值回歸↓4組', color: '#D97706', bg: '#FEF9C3' },
};
function feedbackInfo(f) { return FEEDBACK_LABEL[f] || null; }

// V0620-4：謹慎旗標
function getCautionLabels(meta) {
  if (!meta) return [];
  const labels = [];
  if (meta.sum_surge) labels.push('總和暴漲');
  if (meta.odd_imbalance) labels.push('奇偶失衡');
  if (meta.tq_plunge) labels.push('TQ急跌');
  return labels;
}

// V0619-2：s1/s5/s9/s12訊號判斷
const SIGNAL_LABEL = { s1: 's1換手醞釀', s5: 's5槓龜換手', s9: 's9連2期均衡', s12: 's12高TQ換手' };
function isBalancedTail(t) { return t >= 9 && t <= 11; }
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

// V0621-5：four_count門檻出手判斷
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
function getComparedDrawNo(row, compareResult) {
  const detail = toArray(compareResult?.detail);
  const firstDetail = detail.find((d) => d?.draw_no || d?.target_draw_no) || detail[0] || null;
  const fromDetail = toNum(firstDetail?.draw_no || firstDetail?.target_draw_no, 0);
  if (fromDetail > 0) return fromDetail;

  const fromCompare = toNum(compareResult?.draw_no || compareResult?.target_draw_no, 0);
  if (fromCompare > 0) return fromCompare;

  const fromRow = toNum(row?.target_draw_no || row?.draw_no, 0);
  if (fromRow > 0) return fromRow;

  const source = toNum(row?.source_draw_no, 0);
  const periods = Math.max(1, toNum(row?.target_periods, 1));
  return source > 0 ? source + periods : 0;
}

function formatRowTime(row) {
  const ts = row?.compared_at || row?.created_at;
  if (!ts) return '--';
  const d = new Date(ts);
  const date = d.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });
  const time = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' });
  return `${date} ${time}`;
}

function countGroupHits(detail) {
  const d = toArray(detail);
  let hit3 = 0;
  let hit2 = 0;
  for (const x of d) {
    const h = toNum(x?.hit, 0);
    if (h >= 3) hit3++;
    else if (h === 2) hit2++;
  }
  return { hit3, hit2 };
}

function HistoryRowMeta({ row, detail, isDone }) {
  const timeStr = formatRowTime(row);
  if (!isDone) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, marginLeft: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.textSub, whiteSpace: 'nowrap' }}>{timeStr}</span>
        <span style={{ fontSize: 11, color: C.orange, whiteSpace: 'nowrap' }}>等待比對</span>
      </div>
    );
  }
  const { hit3, hit2 } = countGroupHits(detail);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, marginLeft: 8, flexShrink: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: C.textSub, whiteSpace: 'nowrap' }}>{timeStr}</span>
      {hit3 > 0 && <span style={{ fontSize: 11, fontWeight: 800, color: C.gold, whiteSpace: 'nowrap' }}>中3 {hit3}組</span>}
      {hit2 > 0 && <span style={{ fontSize: 11, fontWeight: 800, color: C.orange, whiteSpace: 'nowrap' }}>中2 {hit2}組</span>}
      {hit3 === 0 && hit2 === 0 && <span style={{ fontSize: 11, color: C.gray, whiteSpace: 'nowrap' }}>未中</span>}
    </div>
  );
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

async function apiFetch(path, options = {}) {
  const res = await fetch(`${RAILWAY_URL}${path}`, { cache: 'no-store', ...options });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
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

// ★ 標籤列：盤面+訊號+謹慎旗標+回饋迴路+動態組數，統一元件供第一頁和第二頁使用
function QuickPage({ prediction, recent20, onRefresh, loading, streakRows }) {
  const row = prediction?.latest_3star_row;
  const compareResult = safeJson(row?.compare_result_json) || safeJson(row?.compare_result);
  const detail = toArray(compareResult?.detail);
  const allGroups = toArray(row?.groups_json);
  const groups = allGroups.slice(0, 8);
  const isDone = row?.compare_status === 'done';
  const bestHit = toNum(row?.hit_count, 0);
  const latestDraw = toArray(recent20)[0];
  const isSkipped = !row || row?.status === 'skipped' || allGroups.length === 0;
  const meta0 = groups[0]?.meta || {};
  const activeMode = meta0.active_mode || 'standard';
  const isAvoidNow = isSkipped || activeMode === 'skip';
  const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.orange : C.textSub;
  const hit2Groups = detail.filter(d => toNum(d?.hit, 0) === 2).length;
  const isWarning = hit2Groups >= 3;

  const comparedDrawNumsArr = toArray(compareResult?.draw_nums);
  const drawNums = new Set(
    comparedDrawNumsArr.length > 0
      ? comparedDrawNumsArr.map(Number)
      : parseNums(latestDraw?.numbers)
  );

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

      {/* 行動建議框（V0623-2清理版：移除confidenceScore/brewCount/forcedSwitch等舊邏輯） */}
      {!isSkipped && !isDone && (() => {
        const isGo = !isAvoidNow;
        const actionBg = isGo ? '#DCFCE7' : '#FEE2E2';
        const actionBorder = isGo ? '#16A34A' : '#DC2626';
        const actionColor = isGo ? '#15803D' : '#DC2626';
        const actionIcon = isGo ? '🟢' : '🔴';
        const actionText = isGo ? '本期可進場' : '本期不推薦號碼';
        const totalSignals = toNum(meta0.total_signals, 0);
        const mainReason = activeMode === 'ultra' ? `${totalSignals}個訊號共鳴`
          : activeMode === 'strong' ? `${totalSignals}個訊號共鳴`
          : activeMode === 'spider' ? '蜘蛛感知(TQ22+連穩)'
          : `標準模式`;
        return (
          <div style={{ marginBottom: 12 }}>
            <div style={{ background: actionBg, border: `2px solid ${actionBorder}`, borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: actionColor }}>{actionIcon} {actionText}</div>
                <span style={{ fontSize: 10, fontWeight: 700, color: actionColor, background: actionBorder + '22', borderRadius: 6, padding: '3px 8px' }}>{modeLabel(activeMode)}</span>
              </div>
              {isGo && <div style={{ fontSize: 11, color: actionColor, marginTop: 4, opacity: 0.9 }}>{mainReason}</div>}
              {isGo && <MetaTags meta={meta0} isSkipped={false} />}
            </div>
          </div>
        );
      })()}

      {/* 多組中2預警 */}
      {isWarning && (
        <div style={{ background: '#FEF3C7', border: '2px solid #F59E0B', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#D97706' }}>⚡ 多組中2，下期注意</div>
          <div style={{ fontSize: 12, color: '#92400E', marginTop: 4 }}>本期有 {hit2Groups} 組中2</div>
        </div>
      )}

      {/* 本期預測 */}
      {isSkipped ? (
        <Card title="本期預測" icon="⏸️">
          <div style={{ textAlign: 'center', padding: '20px 12px' }}>
            <div style={{ fontSize: 13, color: C.textSub, marginBottom: 8 }}>預測期號 {fmt(row?.source_draw_no || latestDraw?.draw_no)}</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: '#DC2626', marginBottom: 12 }}>🔴 主系統本期不推薦</div>
            {/* ★ V0628-1：顯示熱號錨點策略 */}
            {(() => {
              const srcNo = String(row?.source_draw_no || latestDraw?.draw_no || '');
              const streakRow = toArray(streakRows).find(s => String(s?.source_draw_no) === srcNo);
              const streakGroups = streakRow ? toArray(streakRow?.groups_json) : [];
              const anchorNums = streakGroups[0]?.meta?.anchor_nums || [];
              if (streakGroups.length === 0) return (
                <div style={{ fontSize: 12, color: C.textSub }}>熱號錨點策略計算中...</div>
              );
              return (
                <div>
                  <div style={{ fontSize: 12, color: '#D97706', fontWeight: 700, marginBottom: 8 }}>
                    🔥 熱號錨點策略出手｜錨點：{anchorNums.map(n => String(n).padStart(2,'0')).join(' ')}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {streakGroups.map((g, gi) => {
                      const nums = toArray(g?.nums);
                      return (
                        <div key={gi} style={{ background: C.orangeLight, borderRadius: 8, padding: '4px 10px', fontSize: 12, border: `1px solid ${C.orange}`, fontWeight: 600 }}>
                          {nums.map(n => String(n).padStart(2,'0')).join(' ')}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        </Card>
      ) : (
        <Card
          title="本期預測"
          icon="🔥"
          right={
            isDone ? (
              <span style={S.badge(hitColor, hitColor + '18')}>
                {bestHit >= 3 ? `🏆 中${bestHit}！` : bestHit >= 2 ? `🔸 中${bestHit}(仍虧)` : `❌ 未中`}
              </span>
            ) : row ? <span style={S.badge(C.orange, C.orangeLight)}>等待開獎</span> : null
          }
        >
          {isDone ? (
            (() => {
              const totalCost = groups.length * 25;
              const reward = bestHit >= 3 ? 500 : bestHit >= 2 ? 50 : 0;
              const netPnl = reward - totalCost;
              const labelColor = bestHit >= 3 ? hitColor : netPnl < 0 ? '#B91C1C' : C.textSub;
              const label = bestHit >= 3 ? '🏆 恭喜中3！' : bestHit >= 2 ? '🔸 中2（仍虧本）' : '❌ 未中';
              return (
                <>
                  <div style={{ textAlign: 'center', padding: '12px 0 10px' }}>
                    <div style={{ fontSize: 13, color: C.textSub, marginBottom: 6 }}>比對期號 {fmt(getComparedDrawNo(row, compareResult))}</div>
                    <div style={{ ...S.bigNum, color: labelColor }}>{label}</div>
                    <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>
                      本期淨損益：<span style={{ fontWeight: 800, color: netPnl >= 0 ? '#15803D' : '#B91C1C' }}>{netPnl >= 0 ? '+' : ''}{netPnl}元</span>（獎金{reward}元－成本{totalCost}元）
                    </div>
                  </div>
                  <div style={S.divider} />
                  {groups.map((g, idx) => {
                    const nums = parseNums(g?.nums);
                    const key = String(g?.key || g?.meta?.strategy_key || idx);
                    const matchDetail = detail.find(d => String(d?.strategy_key) === key);
                    const hit = matchDetail ? toNum(matchDetail.hit, -1) : -1;
                    const is3 = hit >= 3;
                    const is2 = hit === 2;
                    return (
                      <div key={key} style={{ background: is3 ? C.goldBg : C.grayLight, border: `2px solid ${is3 ? C.goldLight : C.border}`, borderRadius: 10, padding: '8px 12px', marginBottom: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: C.textSub }}>第{idx + 1}組</div>
                          {hit >= 0 && <span style={{ fontSize: 14, fontWeight: 900, color: is3 ? C.gold : is2 ? C.orange : C.gray }}>{is3 ? `🏆 中${hit}` : is2 ? `中${hit}(仍虧)` : `中${hit}`}</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {nums.map(n => {
                            const isHit = drawNums.has(n);
                            return <Ball key={n} n={n} hit={isHit ? true : false} />;
                          })}
                        </div>
                      </div>
                    );
                  })}
                </>
              );
            })()
          ) : isAvoidNow ? (
            <div style={{ textAlign: 'center', padding: '32px 12px' }}>
              <div style={{ fontSize: 13, color: C.textSub, marginBottom: 8 }}>預測期號 {fmt(toNum(row?.source_draw_no, 0) + 1)}</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: '#DC2626' }}>🔴 本期不推薦號碼</div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                <span style={S.badge(C.textSub, C.grayLight)}>
                  預測 {fmt(row?.source_draw_no)} → 比對 {fmt(getComparedDrawNo(row, compareResult))}
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

function HistoryPage({ historyRows, streakRows }) {
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
          const histMode = allGroups[0]?.meta?.active_mode || '';
          const histIsAvoid = isSkipped || histMode === 'skip';
          const meta0 = allGroups[0]?.meta || {};
          const comparedDraw = toNum(row?.target_draw_no, 0) || getComparedDrawNo(row, compareResult);
          const streakRow = isSkipped ? streakRows?.find(s => String(s?.source_draw_no) === String(row?.source_draw_no)) : null;
          const streakDetail = toArray(streakRow?.compare_result_json?.detail);
          const isDoneStreak = streakRow?.compare_status === 'done';
          const rightDetail = isSkipped && streakDetail.length ? streakDetail : detail;
          const rightIsDone = isSkipped ? isDoneStreak : isDone;
          return (
            <div key={row?.id || idx} style={{ ...S.card, marginBottom: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.textSub }}>
                    預測 {fmt(row?.source_draw_no)} → 比對 {fmt(comparedDraw > 0 ? comparedDraw : null)}
                  </span>
                  {/* 空窗期顯示熱號錨點 */}
                  {isSkipped ? (
                    (() => {
                      const streakGroups = streakRow ? toArray(streakRow?.groups_json) : [];
                      const streakBestHit = streakDetail.reduce((m, e) => Math.max(m, toNum(e?.hit, 0)), 0);
                      const anchorNums = streakGroups[0]?.meta?.anchor_nums || [];
                      return streakGroups.length > 0 ? (
                        <div style={{ marginTop: 3 }}>
                          <div style={{ fontSize: 10, color: '#D97706', marginBottom: 3 }}>
                            🔥 熱號錨點策略｜錨點：{anchorNums.map(n => String(n).padStart(2,'0')).join(' ')}
                          </div>
                          {isDoneStreak && (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {streakGroups.map((g, gi) => {
                                const nums = parseNums(g?.nums);
                                const sd = streakDetail[gi];
                                const hit = toNum(sd?.hit, 0);
                                return (
                                  <div key={gi} style={{ background: hit >= 3 ? C.goldBg : hit >= 2 ? C.orangeLight : C.grayLight, borderRadius: 6, padding: '2px 6px', fontSize: 10, border: `1px solid ${hit >= 3 ? C.goldLight : hit >= 2 ? C.orange : C.border}` }}>
                                    {nums.map(n => padNum(n)).join(' ')}
                                    <span style={{ marginLeft: 3, fontWeight: 700, color: hit >= 3 ? C.gold : hit >= 2 ? C.orange : C.gray }}>中{hit}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {!isDoneStreak && <div style={{ fontSize: 10, color: C.textSub }}>等待比對中...</div>}
                          {isDoneStreak && streakBestHit > 0 && (
                            <div style={{ fontSize: 11, fontWeight: 700, color: streakBestHit >= 3 ? C.gold : C.orange, marginTop: 2 }}>
                              🔥 錨點策略 {streakBestHit >= 3 ? `中${streakBestHit}` : `中${streakBestHit}`}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ fontSize: 10, color: C.purple, marginTop: 3 }}>⏸️ 本期訊號不足，無出手</div>
                      );
                    })()
                  ) : (
                    <div style={{ marginTop: 3, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: histIsAvoid ? '#DC2626' : '#15803D', background: histIsAvoid ? '#FEE2E2' : '#DCFCE7', borderRadius: 6, padding: '2px 8px' }}>
                        {histIsAvoid ? '🔴 不推薦' : '🟢 可進場'}
                      </span>
                    </div>
                  )}
                  {!isSkipped && <MetaTags meta={meta0} isSkipped={isSkipped} />}
                </div>
                <HistoryRowMeta row={row} detail={rightDetail} isDone={rightIsDone} />
              </div>
              {/* 空窗期不顯示號碼，有出手的才顯示 */}
              {!isSkipped && !histIsAvoid && isDone && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                  {groups.map((g, gIdx) => {
                    const key = String(g?.key || g?.meta?.strategy_key || gIdx);
                    const nums = parseNums(g?.nums);
                    const matchDetail = detail.find(d => String(d?.strategy_key) === key);
                    const hit = matchDetail ? toNum(matchDetail.hit, 0) : 0;
                    return (
                      <div key={key} style={{ background: hit >= 3 ? C.goldBg : hit >= 2 ? C.orangeLight : C.grayLight, borderRadius: 6, padding: '3px 7px', fontSize: 11, border: `1px solid ${hit >= 3 ? C.goldLight : hit >= 2 ? C.orange : C.border}` }}>
                        {nums.map(n => padNum(n)).join(' ')}
                        <span style={{ marginLeft: 4, fontWeight: 700, color: hit >= 3 ? C.gold : hit >= 2 ? C.orange : C.gray }}>中{hit}</span>
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

// ★ V0625-1精簡版：MetaTags只保留實戰最重要的三個資訊
// 盤面狀態、回饋模式、謹慎旗標——其他s1/s5/s9/s12訊號標籤對實戰無直接意義，移除
function MetaTags({ meta, isSkipped }) {
  if (!meta || isSkipped) return null;
  const bsInfo = boardStateInfo(meta.board_state);
  const fbInfo = feedbackInfo(meta.feedback_mode);
  const cautionLabels = getCautionLabels(meta);
  const isHitCooldown = meta.is_hit_cooldown;
  const dynamicMax = meta.dynamic_max_combos;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {/* 盤面狀態 — 最重要 */}
      {bsInfo && <span style={{ fontSize: 10, fontWeight: 700, color: bsInfo.color, background: bsInfo.bg, borderRadius: 6, padding: '2px 6px' }}>{bsInfo.text}</span>}
      {/* 回饋模式 */}
      {fbInfo && <span style={{ fontSize: 10, fontWeight: 700, color: fbInfo.color, background: fbInfo.bg, borderRadius: 6, padding: '2px 6px' }}>{fbInfo.text}</span>}
      {/* 冷靜期縮手（非自主學習） */}
      {dynamicMax != null && dynamicMax < 8 && (
        <span style={{ fontSize: 10, fontWeight: 700, color: '#7C3AED', background: '#F5F3FF', borderRadius: 6, padding: '2px 6px' }}>
          {dynamicMax === 0 ? '🚫 暫停' : `📉 縮手${dynamicMax}組`}
        </span>
      )}
      {/* 中3冷靜期 */}
      {isHitCooldown && <span style={{ fontSize: 10, fontWeight: 700, color: '#D97706', background: '#FEF9C3', borderRadius: 6, padding: '2px 6px' }}>❄️ 冷靜期</span>}
      {/* 謹慎旗標 — 警告最重要 */}
      {cautionLabels.map(label => (
        <span key={label} style={{ fontSize: 10, fontWeight: 700, color: '#C2410C', background: '#FFEDD5', borderRadius: 6, padding: '2px 6px' }}>⚠️ {label}</span>
      ))}
    </div>
  );
}
function ComboWeightsCard() {
  return (
    <div style={S.card}>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.gold, marginBottom: 8 }}>🤖 自主學習</div>
      <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.6 }}>
        V0713：pool 門檻修復 + E 純蜘蛛動態。保留熱號錨點、可進場二元。
        <br />ZM / H 軸盤面研究請用 SQL 工具，不影響 live 出手。
      </div>
    </div>
  );
}

function StatsPage({ historyRows, streakRows }) {
  const [subTab, setSubTab] = useState('all');
  const [soulStatus, setSoulStatus] = useState(null);
  const [soulLoading, setSoulLoading] = useState(true);
  const [healthStatus, setHealthStatus] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthExpanded, setHealthExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    apiFetch('/api/soul-status')
      .then(res => { if (active) setSoulStatus(res); })
      .catch(() => { if (active) setSoulStatus(null); })
      .finally(() => { if (active) setSoulLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch('/api/health-status')
      .then(res => { if (active) setHealthStatus(res); })
      .catch(() => { if (active) setHealthStatus(null); })
      .finally(() => { if (active) setHealthLoading(false); });
    return () => { active = false; };
  }, []);

  const allRows = toArray(historyRows).filter(row =>
    row?.created_at >= STATS_START_DATE && row?.status === 'compared' && toArray(row?.groups_json).length > 0
  );

  const cleanCount = toNum(soulStatus?.clean_periods, 0);
  // ★ V0626-3：封印相關變數(sealTarget/sealPct/isSealBroken/daysPassed)已移除
  const modeMap = soulStatus?.mode_stats || {};

  // V0623-2：依盤面狀態或選號策略篩選
  const filterByBoardState = (key) => {
    if (key === 'all') return allRows;
    if (key === 'core_outer' || key === 'spider_mid') {
      return allRows.filter(row => {
        const s = toArray(row?.groups_json)[0]?.meta?.selection_strategy || '';
        return s === key;
      });
    }
    return allRows.filter(row => {
      const bs = toArray(row?.groups_json)[0]?.meta?.board_state || '';
      return bs === key;
    });
  };

  const calcStats = (rows) => {
    const total = rows.length;
    const hit3 = rows.filter(r => toNum(r?.hit_count) >= 3).length;
    const hit2 = rows.filter(r => toNum(r?.hit_count) === 2).length;
    const hit1 = rows.filter(r => toNum(r?.hit_count) === 1).length;
    const hit0 = rows.filter(r => toNum(r?.hit_count) === 0).length;
    const rate = total > 0 ? hit3 / total : 0;
    return { total, hit3, hit2, hit1, hit0, rate };
  };

  // V0623-2：子頁籤（盤面+選號策略），V0625-2加入wide_spread和gradient
  const subTabs = [
    { key: 'all',               label: '全部',     icon: '📊' },
    { key: 'A_golden',          label: '黃金共振', icon: '✨' },
    { key: 'B_spider_calm',     label: '蜘蛛靜默', icon: '🕷️' },
    { key: 'E_false_momentum',  label: '假動能',   icon: '⚡' },
    { key: 'F_quiet',           label: '平淡期',   icon: '😶' },
    { key: 'wide_spread',       label: '寬幅分散', icon: '🌐' },
    { key: 'gradient',          label: '梯度遞減', icon: '📐' },
    { key: 'core_outer',        label: '核心外圍', icon: '🎯' },
    { key: 'spider_mid',        label: '次熱號',   icon: '🔬' },
  ];

  const currentRows = filterByBoardState(subTab);
  const stats = calcStats(currentRows);
  const rateColor = stats.rate > 0.0375 ? C.green : C.orange;

  return (
    <div style={S.page}>
      {/* 靈魂戰況板 */}
      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.gold, marginBottom: 8 }}>🧠 靈魂學習進度</div>
        {soulLoading ? (
          <div style={{ fontSize: 11, color: C.textSub }}>載入中...</div>
        ) : !soulStatus?.ok ? (
          <div style={{ fontSize: 11, color: C.textSub }}>暫無法取得靈魂狀態</div>
        ) : (
          <>
            <div style={{ borderBottom: `1px solid ${C.border}`, paddingBottom: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: C.textSub, marginBottom: 4 }}>V0627-1版本各模式表現：</div>
              {Object.entries(modeMap).sort((a, b) => b[1].count - a[1].count).map(([mode, stat]) => {
                const avg = toNum(stat?.avg_pnl, 0);
                const color = avg > 0 ? C.green : avg > -100 ? C.orange : '#DC2626';
                return (
                  <div key={mode} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0' }}>
                    <span style={{ color: C.text, fontWeight: 600 }}>{modeLabel(mode)}</span>
                    <span style={{ color: C.textSub }}>{stat.count}期</span>
                    <span style={{ color, fontWeight: 700 }}>{avg > 0 ? '+' : ''}{avg}元/期</span>
                  </div>
                );
              })}
              {Object.keys(modeMap).length === 0 && <div style={{ fontSize: 11, color: C.textSub }}>尚無資料</div>}
            </div>
            <div style={{ fontSize: 11, color: C.textSub }}>共 {cleanCount} 期乾淨資料</div>
          </>
        )}
      </div>

      {/* 三天健康檢查 */}
      <div style={S.card}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.gold, marginBottom: 8 }}>📋 三天健康檢查</div>
        {healthLoading ? (
          <div style={{ fontSize: 11, color: C.textSub }}>載入中...</div>
        ) : !healthStatus?.ok ? (
          <div style={{ fontSize: 11, color: C.textSub }}>暫無法取得健康檢查狀態</div>
        ) : (() => {
          const s = healthStatus.summary || {};
          const levelColor = s.level === 'good' ? C.green : s.level === 'normal' ? C.orange : '#DC2626';
          const levelBg = s.level === 'good' ? '#DCFCE7' : s.level === 'normal' ? '#FEF9C3' : '#FEE2E2';
          const periods = toArray(healthStatus.periods);
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: levelColor }}>{s.hit3_pct != null ? `${s.hit3_pct}%` : '--'}</span>
                <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 6, background: levelBg, color: levelColor, fontWeight: 700 }}>{s.level_label || '無資料'}</span>
              </div>
              <div style={{ fontSize: 11, color: C.textSub, marginBottom: 10 }}>
                {fmt(s.compared_periods)}期已比對 ・ 出手率{s.output_rate_pct != null ? `${s.output_rate_pct}%` : '--'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1, background: C.grayLight, borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 800 }}>{fmt(s.hit3_periods)}</div>
                  <div style={{ fontSize: 10, color: C.textSub }}>中3期數</div>
                </div>
                <div style={{ flex: 1, background: C.grayLight, borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 800 }}>{fmt(s.hit2plus_groups_total)}</div>
                  <div style={{ fontSize: 10, color: C.textSub }}>中2以上組數</div>
                </div>
              </div>
              {/* 精簡版：移除超級組合和選號策略的大塊，只保留逐期明細收合 */}
              <button
                onClick={() => setHealthExpanded(v => !v)}
                style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: C.grayLight, borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, color: C.text, cursor: 'pointer' }}
              >
                <span>逐期明細（{periods.length}期）</span>
                <span>{healthExpanded ? '▲' : '▼'}</span>
              </button>
              {healthExpanded && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
                  {periods.slice().reverse().map((p, idx) => {
                    const isSkipped = p.status === 'skipped';
                    const isDone = p.compare_status === 'done' && !isSkipped;
                    const timeStr = p.time ? new Date(p.time).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }) : '--';
                    const bsInfo = boardStateInfo(p.board_state);
                    const hitColor = toNum(p.best_hit) >= 3 ? C.gold : C.textSub;
                    return (
                      <div key={p.draw_no || idx} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: C.text }}>
                          {fmt(p.draw_no)} → {fmt(p.compare_draw_no || (toNum(p.draw_no, 0) > 0 ? toNum(p.draw_no, 0) + 1 : null))} ・ {timeStr} ・ {bsInfo ? bsInfo.text : '跳過'} ・ {isSkipped ? '空窗' : modeLabel(p.active_mode)}
                        </span>
                        {isSkipped ? (
                          <span style={{ fontSize: 10, color: C.textSub }}>⏸️</span>
                        ) : !isDone ? (
                          <span style={{ fontSize: 10, color: C.orange }}>等待</span>
                        ) : (
                          <span style={{ fontSize: 11, fontWeight: 800, color: hitColor }}>中{fmt(p.best_hit)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* 統計子頁籤 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, background: C.card, borderRadius: 12, padding: 8, boxShadow: C.shadow, flexWrap: 'wrap' }}>
        {subTabs.map(t => (
          <button key={t.key} style={S.subTab(subTab === t.key)} onClick={() => setSubTab(t.key)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <Card title="📊 全部 命中率" icon="">
        <div style={{ textAlign: 'center', padding: '10px 0' }}>
          <div style={{ ...S.bigNum, color: rateColor }}>{fmtPercent(stats.rate)}</div>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>共 {stats.total} 期｜中3：{stats.hit3} 次</div>
        </div>
        <div style={S.divider} />
        <StatRow label="理論值（隨機）" value="3.75%" valueColor={C.textSub} />
        <StatRow label="中3命中率" value={fmtPercent(stats.rate)} valueColor={rateColor} />
        <StatRow label="中3次數" value={`${stats.hit3} 次`} />
        <StatRow label="中2次數" value={`${stats.hit2} 次`} />
        <StatRow label="中1次數" value={`${stats.hit1} 次`} />
        <StatRow label="未中次數" value={`${stats.hit0} 次`} />
      </Card>

      {/* ★ V0628-1：熱號錨點策略獨立統計 */}
      {(() => {
        const sRows = toArray(streakRows).filter(r => r?.compare_status === 'done');
        if (sRows.length === 0) return (
          <Card title="🔥 熱號錨點策略統計" icon="">
            <div style={{ fontSize: 12, color: C.textSub, textAlign: 'center', padding: 8 }}>資料累積中，尚無比對記錄</div>
          </Card>
        );
        const sHit3 = sRows.filter(r => toNum(r?.hit_count, 0) >= 3).length;
        const sHit2 = sRows.filter(r => toNum(r?.hit_count, 0) >= 2).length;
        const sRate = sRows.length > 0 ? (sHit3 / sRows.length * 100).toFixed(1) : '0.0';
        const sRateColor = Number(sRate) >= 10 ? C.green : Number(sRate) >= 5 ? C.orange : '#DC2626';
        return (
          <Card title="🔥 熱號錨點策略統計" icon="">
            <div style={{ textAlign: 'center', padding: '10px 0' }}>
              <div style={{ ...S.bigNum, color: sRateColor }}>{sRate}%</div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>共 {sRows.length} 期｜中3：{sHit3} 次</div>
            </div>
            <div style={S.divider} />
            <StatRow label="中3命中率" value={`${sRate}%`} valueColor={sRateColor} />
            <StatRow label="中3次數" value={`${sHit3} 次`} />
            <StatRow label="中2以上次數" value={`${sHit2} 次`} />
            <StatRow label="出手期數" value={`${sRows.length} 期`} />
            <div style={{ fontSize: 10, color: C.textSub, marginTop: 6, textAlign: 'center' }}>
              ※ 此策略專用於主系統空窗期，與主策略統計完全分開
            </div>
          </Card>
        );
      })()}

      <ComboWeightsCard />

      <div style={{ fontSize: 11, color: C.textSub, textAlign: 'center', padding: '4px 0' }}>※ 統計數據從 6/8 起算</div>
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
  function consecutiveCount(num) {
    let c = 0;
    for (const row of rows) {
      if (parseNums(row?.numbers).includes(num)) c++;
      else break;
    }
    return c;
  }
  const numStats = [];
  for (let n = 1; n <= 80; n++) {
    const consec = consecutiveCount(n);
    if (consec >= 1) numStats.push({ n, consec });
  }
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
          純粹看盤用：依「最近20期」資料，從最新一期往前算，列出每個號碼目前連續開出幾期。此頁僅供參考，與AI選號邏輯無關。
        </div>
        {!rows.length ? <div style={S.empty}>載入中...</div> : groups.map(g => {
          const info = levelInfo[g.level];
          return (
            <div key={g.level} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: info.color, background: info.bg, border: `1px solid ${info.border}`, borderRadius: 6, padding: '2px 8px' }}>{info.label}</span>
                <span style={{ fontSize: 11, color: C.textSub }}>{g.data.length} 顆</span>
              </div>
              {g.data.length === 0 ? (
                <div style={{ fontSize: 12, color: C.textSub, padding: '4px 0' }}>目前無號碼符合此等級</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {g.data.map(({ n }) => (
                    <div key={n} style={{ width: 32, height: 32, borderRadius: '50%', background: info.bg, border: `2px solid ${info.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: info.color }}>
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
  const isSkipped = !row || row?.status === 'skipped' || groups.length === 0;
  const bsInfo = boardStateInfo(meta0?.board_state);
  const ssInfo = selectionStrategyInfo(meta0?.selection_strategy);
  return (
    <div style={S.page}>
      <Card title="本期AI熱號池" icon="🕷️">
        <div style={{ fontSize: 11, color: C.textSub, marginBottom: 12, lineHeight: 1.6 }}>
          這裡顯示的號碼池，與「本期預測」使用完全同一份資料，是本期實際選出、用來組成3星預測的熱號池。
        </div>
        {isSkipped ? (
          <div style={S.empty}>本期AI暫停出號，無熱號池資料</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {bsInfo && <span style={{ fontSize: 12, fontWeight: 700, color: bsInfo.color, background: bsInfo.bg, borderRadius: 6, padding: '2px 8px' }}>{bsInfo.text}</span>}
              {ssInfo && <span style={{ fontSize: 12, fontWeight: 700, color: ssInfo.color, background: ssInfo.bg, borderRadius: 6, padding: '2px 8px' }}>{ssInfo.text}</span>}
              <span style={S.badge(C.textSub, C.grayLight)}>期號 {fmt(row?.source_draw_no)}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {hotPool.map(n => (
                <div key={n} style={{ width: 36, height: 36, borderRadius: '50%', background: C.goldBg, border: `2px solid ${C.goldLight}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 800, color: C.gold }}>
                  {padNum(n)}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: C.textSub, marginTop: 12 }}>共 {hotPool.length} 顆</div>
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
  const [streakRows, setStreakRows] = useState([]); // ★ V0628-1：熱號錨點策略記錄
  const [loopStatus, setLoopStatus] = useState('初始化中...');
  const [emergencyAlert, setEmergencyAlert] = useState(null);
  const timerRef = useRef(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [predRes, recentRes, healthRes, streakRes] = await Promise.all([
        apiFetch('/api/prediction-latest').catch(() => ({})),
        apiFetch('/api/recent20').catch(() => ({})),
        apiFetch('/api/health-status').catch(() => ({})),
        apiFetch('/api/streak-anchor-latest').catch(() => ({})), // ★ V0628-1：熱號錨點最新記錄
      ]);
      setPrediction(predRes);
      setHistoryRows(predRes?.recent_3star_compared_rows || predRes?.recent_compared_rows || []);
      setStreakRows(streakRes?.rows || []);
      setRecent20(recentRes?.recent20 || recentRes?.data || []);
      setLoopStatus(isNight() ? '夜間停止（00:00-07:00）' : `已更新 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`);
      const consecutiveLoss = toNum(healthRes?.summary?.consecutive_loss, 0);
      setEmergencyAlert(consecutiveLoss >= 18
        ? `⚠️ 緊急警告：已連續虧損${consecutiveLoss}期，請人工檢查系統狀態`
        : null);
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
    { key: 'quick',   label: '快速', icon: '⚡' },
    { key: 'history', label: '近期', icon: '📋' },
    { key: 'stats',   label: '統計', icon: '📊' },
    { key: 'market',  label: '開獎', icon: '🎱' },
    { key: 'hot',     label: '熱號', icon: '🔥' },
    { key: 'hotpool', label: '熱號池', icon: '🕷️' },
  ];

  return (
    <div style={S.app}>
      {/* ★ V0626-3：緊急警告橫幅，連續虧損18期以上才顯示 */}
      {emergencyAlert && (
        <div style={{ background: '#DC2626', color: '#fff', fontSize: 13, fontWeight: 800, textAlign: 'center', padding: '8px 16px', letterSpacing: 0.5 }}>
          {emergencyAlert}
        </div>
      )}
      <div style={S.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={S.headerTitle}>🏆 富緯賓果 AI V0713</div>
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
      {tab === 'quick'   && <QuickPage   prediction={prediction} recent20={recent20} onRefresh={loadData} loading={loading} streakRows={streakRows} />}
      {tab === 'history' && <HistoryPage historyRows={historyRows} streakRows={streakRows} />}
      {tab === 'stats'   && <StatsPage   historyRows={historyRows} streakRows={streakRows} />}
      {tab === 'market'  && <MarketPage  recent20={recent20} />}
      {tab === 'hot'     && <HotPage     recent20={recent20} />}
      {tab === 'hotpool' && <HotPoolPage prediction={prediction} />}
    </div>
  );
}
