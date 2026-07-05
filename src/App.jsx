/**
 * App.jsx - V0705-5
 *
 * ★ V0705-5(7/5)：實戰保命版 UI
 * - 今日各級戰績看板（中2率決定能不能真下）
 * - 新增 practice_grade_cold 徽章（出手時段但手感未達標）
 * - 配合 prediction-latest-v0705-5 / auto-train-v0705-6
 *
 * ★ V0704-5(7/4晚)：每期都顯示選號(練習賽) + 時段徽章
 * - 本期預測卡 / 投注建議卡 都蓋章：🔴真實推薦(可下注) / 📚練習研判(觀察用) / ⚠️今日子彈打完(參考)
 * - 配合 auto-train-v0704-6：每一期都選號+比對，讓你隨時盯各等級手感、決定重壓哪一級
 * - 徽章來源：每期預測 meta.session_type（prediction-latest-v0704-5 保留此欄位）
 *
 * ★ V0704-4(7/4晚)：作息窗口 + 練習賽儀表板
 * - 標題下方新增全域卡片：現在是「出手時段」還是「練習賽(累積實力)」
 * - 出手時段：顯示今日子彈進度(已下/剩餘組數、金額)，燒完顯示今日收工
 * - 練習時段：顯示下次出手倒數 + 系統照常對獎練功
 * - 三態都顯示修煉戰績：今日已研判期數、近期中3/中2手感
 * - 資料來自 prediction-latest-v0704-4 的 window_status / practice_stats
 *
 * ★ V0704-3(7/4)：中2保本校準（各級桌子上限下修，讓中2就能接近保本）
 *
 * ★ V0704-2(7/4)：攻擊面—膽拖聚焦（強級把最會開的核心號放進最多組，攻中2）
 *
 * ★ V0704-1(7/4)：總教練手感調度（建議原因會顯示大盤冷熱/減碼）
 *
 * ★ V0703-7(7/3)：中二保本統計
 * - 近20期 TOP3 同時顯示中3率 + 中2率
 * - 近30期實盤條顯示中3/中2
 * - 投注建議卡顯示中2保本說明
 *
 * ★ V0703-6-fix(7/3)：修复白屏
 * - betting_summary.grade_live.vs_random 可能为空 → 安全读取
 * - LiveGradeStatsBar rate 安全显示
 * - 投注建议卡加大：行动标签/原因列表/实盘等级统计/减组说明
 * - 读取 betting_summary + live_grade_stats_all
 *
 * ★ V0703-5更新(7/3)：配合 buildBingoV1Strategies V0703-5
 * - 停用无效自主学習（board_combo_weights）与 Z惯性加组
 * - 保留 V0703-4 盘面雷达 / Live过滤 UI
 * - 標題列版本號同步改為 V0703-5
 *
 * ★ V0703-4：盤面狀態 / Live同盤面
 * - 第一頁新增 BettingAdviceCard：投注建議/成本/回本條件/連虧警告
 * - TOP3改為近20期「中3率」排行（取代損益OK，避免低級別誤導）
 * - 統計頁「等級對比」對齊新六級定義（移除舊7顆=第1級）
 * - 統計頁新增「系統 vs 隨機」對比卡
 * - 第4級標籤改色（不再用綠色，避免誤以為最高級）
 * - 補位標籤新增 lv2_with_tier2
 * - 標題列版本號同步改為 V0703-2
 *
 * ★ V0703-1更新(7/3)：第一頁近20期等級TOP3顯示
 *
 * ★ V0702-4更新(7/2)：六層數字分級UI（lv1~lv6）
 * 配合 buildBingoV1Strategies V0702-7
 * 錨點品質標籤改為第1級~第6級，含次強錨點組合說明
 *
 * ★ V0702-2更新(7/2)：退回V0630-2穩定版，分級改數字
 *
 * ★ V0701-1更新(7/1)：四層選號維度 + 六層分級UI
 * 配合buildBingoV1Strategies V0701-1
 * 新增顯示：和值殘差(S_low/mid/high)、AB象限(同向/反向)、最大號分級、六層級別
 *
 * ★ V0630-2更新(6/30)：五級分級UI重新設計
 * 舊分級(golden_plus/golden/silver/bronze/weak)全部替換為新五級(gold/silver/bronze/iron/tin)
 * 新分級依據6/29-6/30共164期實戰數據：7顆=35.3%/6顆=11.1%/5顆=8.3%/4顆=2.7%
 *
 * ★ V0630-1更新(6/30)：三層補位標記顯示
 * 配合buildBingoV1Strategies V0630-1（三層補位系統解決空窗期）
 * 新增fill_mode標記：真錨點(none)/次強錨點補位(second_tier)/盤面補位(board_fill)
 * MetaTags、近期頁、錨點頁都新增補位模式顯示，不影響原有黃金/銀級/銅級邏輯
 *
 * ★ V0629-4：全新系統UI（六分頁架構保留，內容換新）
 * 配合buildBingoV1Strategies V0629-4（Z+M盤面 + 錨點黃金條件）
 * 六個分頁：快速/近期/統計/開獎/熱號/錨點
 * 廢棄：舊盤面標籤（A_golden等）、訊號系統、TQ/four_count
 * 新增：Z+M盤面卡、錨點品質標籤、黃金條件顯示
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

const RAILWAY_URL = 'https://fuwei-bingo-backend-production.up.railway.app';
const REFRESH_INTERVAL_MS = 30000;
const STATS_START_DATE = '2026-06-29T00:00:00.000Z';
const GRADE_HIT3_LOOKBACK = 20;
const COST_PER_GROUP = 25;

const GRADE_DEFINITIONS = [
  { q: 'lv1', label: '第1級', rule: '真錨點=7顆', bench: 51.6 },
  { q: 'lv2', label: '第2級', rule: '真>=4+次強>=5 或 8+降級', bench: 50.8 },
  { q: 'lv3', label: '第3級', rule: '真6+ / 真5+次強3+ 等', bench: 36.0 },
  { q: 'lv4', label: '第4級', rule: '真4+次強>=3', bench: 27.7 },
  { q: 'lv5', label: '第5級', rule: '真5次強少 / 補位', bench: 19.5 },
  { q: 'lv6', label: '第6級', rule: '真4次強少', bench: 14.2 },
];

function toNum(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function toArray(v) { return Array.isArray(v) ? v : []; }
function fmt(v, fallback = '-') { const n = Number(v); return Number.isFinite(n) ? String(n) : fallback; }
function fmtPercent(rate) { if (rate == null || !Number.isFinite(rate)) return '--%'; return (rate * 100).toFixed(1) + '%'; }
function padNum(n) { return String(n).padStart(2, '0'); }
function parseNums(v) {
  if (Array.isArray(v)) return v.map(Number).filter(n => n >= 1 && n <= 80);
  return String(v || '').trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 80);
}
function isNight() { const h = (new Date().getUTCHours() + 8) % 24; return h >= 0 && h < 7; }

function parseCompareResult(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
  return null;
}

function extractRowMeta(row) {
  const groups = toArray(row?.groups_json);
  const g = groups.find(x => x?.key !== 'skip_meta') || groups[0];
  return g?.meta || {};
}

function calcPeriodReward(row) {
  const compareResult = parseCompareResult(row?.compare_result_json);
  const detail = toArray(compareResult?.detail);
  let reward = 0;
  for (const d of detail) {
    const h = toNum(d?.hit ?? d?.hit_count, 0);
    if (h >= 3) reward += 500;
    else if (h >= 2) reward += 50;
  }
  if (reward === 0 && detail.length === 0) {
    const bestHit = toNum(row?.hit_count, 0);
    if (bestHit >= 3) reward = 500;
    else if (bestHit >= 2) reward = 50;
  }
  return reward;
}

function calcBreakEvenNote(groupCount) {
  const cost = groupCount * COST_PER_GROUP;
  const hit2Needed = Math.ceil(cost / 50);
  const hit3Needed = Math.ceil(cost / 500);
  return `成本${cost}元｜中2需${hit2Needed}組(各50元)可回本｜${hit3Needed <= 1 ? '或中3一次(500元)可回本' : `或中3需${hit3Needed}次`}`;
}

function calcGradeHit3Stats(historyRows, limit = GRADE_HIT3_LOOKBACK) {
  const stats = {};
  const rows = toArray(historyRows)
    .filter(r => r?.compare_status === 'done' && r?.status !== 'skipped')
    .slice(0, limit);
  for (const row of rows) {
    const quality = extractRowMeta(row)?.anchor_quality;
    if (!quality || quality === 'none') continue;
    if (!stats[quality]) stats[quality] = { total: 0, hit3: 0, hit2: 0 };
    stats[quality].total++;
    const h = toNum(row?.hit_count);
    if (h >= 3) stats[quality].hit3++;
    if (h >= 2) stats[quality].hit2++;
  }
  return Object.entries(stats)
    .map(([q, s]) => ({
      q, hit3: s.hit3, hit2: s.hit2, total: s.total,
      rate: s.total > 0 ? s.hit3 / s.total : 0,
      rate2: s.total > 0 ? s.hit2 / s.total : 0,
    }))
    .sort((a, b) => b.rate - a.rate || b.hit3 - a.hit3)
    .slice(0, 3);
}

function resolveBettingAdvice(meta, isSkipped, groupCount) {
  const summary = meta?.betting_summary || null;
  if (isSkipped) {
    return {
      advice: 'skip', label: summary?.label || meta?.betting_label || '⏸️ 本期空窗｜建議不投',
      color: '#6B7280', bg: '#F3F4F6', cost: 0,
      breakEven: '—', groups: 0, actionText: '本期不投', reasons: summary?.reasons || [],
      gradeLive: summary?.grade_live || null, reducedFrom: null,
    };
  }
  const advice = summary?.action || meta?.betting_advice || 'normal';
  const label = summary?.label || meta?.betting_label || '🟡 請參考等級出手';
  const cost = summary?.cost ?? meta?.total_cost ?? groupCount * COST_PER_GROUP;
  const breakEven = summary?.break_even_note || meta?.break_even_note || calcBreakEvenNote(groupCount);
  const hit2Backup = summary?.hit2_backup_note || null;
  const palette = {
    full: { color: '#15803D', bg: '#DCFCE7' },
    normal: { color: '#D97706', bg: '#FFFBEB' },
    reduce: { color: '#DC2626', bg: '#FEE2E2' },
    skip: { color: '#6B7280', bg: '#F3F4F6' },
  };
  const p = palette[advice] || palette.normal;
  return {
    advice, label, ...p, cost, breakEven, hit2Backup, groups: groupCount,
    actionText: summary?.action_text || (advice === 'full' ? '正常出手' : advice === 'reduce' ? '减组观望' : '可以出手'),
    reasons: summary?.reasons || [],
    gradeLive: summary?.grade_live || null,
    reducedFrom: summary?.reduced_from_grade || meta?.grade_max_groups || null,
  };
}

// ===== 顏色系統 =====
const C = {
  gold: '#B45309', green: '#15803D', orange: '#D97706',
  red: '#DC2626', blue: '#0369A1', purple: '#7C3AED',
  text: '#1F2937', textSub: '#6B7280', border: '#E5E7EB',
  bg: '#FFFFFF', card: '#FFFFFF', grayLight: '#F9FAFB',
  shadow: '0 1px 4px rgba(0,0,0,0.08)',
  headerBg: 'linear-gradient(135deg, #1E3A5F 0%, #2D5986 100%)',
};

// ===== Z+M盤面標籤 =====
const ZM_LABEL = {
  'Z_front_M1': { text: 'Z前M1', desc: '前段強+極小號', color: '#0369A1', bg: '#DBEAFE' },
  'Z_front_M2': { text: 'Z前M2', desc: '前段強+小號',   color: '#0369A1', bg: '#EFF6FF' },
  'Z_front_M3': { text: 'Z前M3', desc: '前段強+中號',   color: '#0284C7', bg: '#F0F9FF' },
  'Z_front_M4': { text: 'Z前M4', desc: '前段強+大號',   color: '#0284C7', bg: '#F0F9FF' },
  'Z_back_M1':  { text: 'Z後M1', desc: '後段強+極小號', color: '#7C3AED', bg: '#EDE9FE' },
  'Z_back_M2':  { text: 'Z後M2', desc: '後段強+小號',   color: '#7C3AED', bg: '#F5F3FF' },
  'Z_back_M3':  { text: 'Z後M3', desc: '後段強+中號',   color: '#9333EA', bg: '#FAF5FF' },
  'Z_back_M4':  { text: 'Z後M4', desc: '後段強+大號',   color: '#DC2626', bg: '#FEE2E2' },
};
function zmLabel(key) { return ZM_LABEL[key] || { text: key || '未知', desc: '', color: C.textSub, bg: C.grayLight }; }

// ===== 錨點品質標籤 =====
// ★ V0702-4：六層數字分級（真錨點+次強錨點組合，SQL 21636期驗證）
const QUALITY_LABEL = {
  lv1:  { text: '第1級', color: '#B45309', bg: '#FEF3C7', desc: '真>=7 51.6%中3' },
  lv2:  { text: '第2級', color: '#7C3AED', bg: '#EDE9FE', desc: '真>=4+次強>=5 50.8%' },
  lv3:  { text: '第3級', color: '#1D4ED8', bg: '#DBEAFE', desc: '真6+或次強爆發 35-37%' },
  lv4:  { text: '第4級', color: '#CA8A04', bg: '#FEF9C3', desc: '真4+次強>=3 27.7%' },
  lv5:  { text: '第5級', color: '#0891B2', bg: '#CFFAFE', desc: '真5次強少或補位強 17-22%' },
  lv6:  { text: '第6級', color: '#6B7280', bg: '#F3F4F6', desc: '真4次強少 14.2%' },
  none: { text: '❌ 空窗', color: '#DC2626', bg: '#FEE2E2', desc: '7.7%' },
};
function qualityLabel(q) { return QUALITY_LABEL[q] || QUALITY_LABEL['none']; }

// ===== ★ V0630-1新增：補位模式標籤 =====
const FILL_MODE_LABEL = {
  none:             null,
  second_tier:      { text: '🔄 次強錨點補位', color: '#0891B2', bg: '#CFFAFE' },
  lv2_with_tier2:   { text: '⚡ 第2級次強組合', color: '#7C3AED', bg: '#EDE9FE' },
  board_fill:       { text: '🧩 盤面補位', color: '#9333EA', bg: '#F3E8FF' },
};
function fillModeLabel(mode) { return FILL_MODE_LABEL[mode] || null; }

// ===== 和值殘差/AB象限標籤（V0702-2退回簡單版，暫不顯示）=====
function sumClassLabel(c) { return null; }
function abPatternLabel(p) { return null; }

// ===== 樣式 =====
const S = {
  app: { fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', background: '#F3F4F6', minHeight: '100vh' },
  header: { background: C.headerBg, color: '#fff', padding: '14px 16px 10px' },
  headerTitle: { fontSize: 16, fontWeight: 900, letterSpacing: 0.5 },
  headerSub: { fontSize: 11, opacity: 0.75, marginTop: 2 },
  tabs: { display: 'flex', background: '#fff', borderBottom: `1px solid ${C.border}`, overflowX: 'auto' },
  tab: (active) => ({
    flex: 1, minWidth: 52, padding: '8px 4px 6px', border: 'none',
    borderBottom: active ? `3px solid ${C.gold}` : '3px solid transparent',
    background: 'transparent', color: active ? C.gold : C.textSub,
    fontWeight: active ? 800 : 500, fontSize: 11, cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
  }),
  page: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 500, margin: '0 auto' },
  card: { background: C.card, borderRadius: 14, padding: '14px 16px', boxShadow: C.shadow, border: `1px solid ${C.border}` },
  statRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${C.border}` },
  divider: { height: 1, background: C.border, margin: '8px 0' },
  bigNum: { fontSize: 32, fontWeight: 900, letterSpacing: -1 },
  empty: { textAlign: 'center', color: C.textSub, fontSize: 12, padding: '20px 0' },
  badge: (color, bg) => ({ fontSize: 10, fontWeight: 700, color, background: bg, borderRadius: 6, padding: '2px 6px' }),
  numBadge: (hit) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12,
    fontSize: 11, fontWeight: 700,
    background: hit >= 3 ? '#FEF3C7' : hit >= 2 ? '#DCFCE7' : '#F3F4F6',
    color: hit >= 3 ? C.gold : hit >= 2 ? C.green : C.textSub,
    border: `1px solid ${hit >= 3 ? C.gold : hit >= 2 ? C.green : C.border}`,
  }),
  recentBall: () => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, borderRadius: '50%', fontSize: 11, fontWeight: 700,
    background: '#F3F4F6', color: C.text, border: `1px solid ${C.border}`,
  }),
  subTab: (active) => ({
    padding: '6px 10px', border: 'none', borderRadius: 8,
    background: active ? '#1F2937' : 'transparent',
    color: active ? '#fff' : C.textSub,
    fontWeight: active ? 700 : 500, fontSize: 11, cursor: 'pointer',
  }),
};

function Card({ title, children, icon }) {
  return (
    <div style={S.card}>
      {title && <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginBottom: 10 }}>{icon} {title}</div>}
      {children}
    </div>
  );
}
function StatRow({ label, value, valueColor }) {
  return (
    <div style={S.statRow}>
      <span style={{ fontSize: 12, color: C.textSub }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: valueColor || C.text }}>{value}</span>
    </div>
  );
}
function Spinner() {
  return <div style={{ textAlign: 'center', padding: 24, color: C.textSub, fontSize: 13 }}>⏳ 載入中...</div>;
}

// ===== 作息窗口 / 練習賽儀表板（V0704-4）=====
function useCountdown(targetISO) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!targetISO) return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [targetISO]);
  if (!targetISO) return null;
  const diff = new Date(targetISO).getTime() - now;
  if (diff <= 0) return '即將開盤';
  const totalMin = Math.floor(diff / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) { const d = Math.floor(h / 24); return `約 ${d} 天 ${h % 24} 小時後`; }
  if (h >= 1) return `約 ${h} 小時 ${m} 分後`;
  return `約 ${m} 分後`;
}
function ProgressBar({ used, total }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div style={{ height: 8, background: 'rgba(255,255,255,0.25)', borderRadius: 999, marginTop: 6, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: 'rgba(255,255,255,0.92)', borderRadius: 999, transition: 'width .4s' }} />
    </div>
  );
}
function MiniStat({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 10, opacity: 0.85 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 900 }}>{value}</span>
    </div>
  );
}
function TodayGradeStatsBar({ todayGradeStats, gradeRealReady, latestGrade }) {
  const stats = todayGradeStats && typeof todayGradeStats === 'object' ? todayGradeStats : {};
  const rows = ['lv1', 'lv2', 'lv3', 'lv4', 'lv5', 'lv6']
    .map(q => ({ q, ...(stats[q] || {}) }))
    .filter(r => r.total > 0);
  if (!rows.length) return null;
  return (
    <div style={{ padding: '10px 14px 0', maxWidth: 500, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '12px 14px', border: '2px solid #E5E7EB', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div style={{ fontSize: 13, fontWeight: 900, color: C.text, marginBottom: 8 }}>📅 今日各級手感（決定能不能真下）</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {rows.map(r => {
            const ready = r.real_ready;
            const isCurrent = r.q === latestGrade;
            return (
              <span key={r.q} style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 999,
                background: ready ? '#DCFCE7' : '#FEE2E2',
                border: isCurrent ? '2px solid #6366F1' : '1px solid #E5E7EB',
                fontWeight: isCurrent ? 900 : 700,
              }}>
                {qualityLabel(r.q).text} {r.total}期 中2 {Number.isFinite(r.hit2_rate) ? (r.hit2_rate * 100).toFixed(0) : '--'}% {ready ? '✅可真下' : '❄️觀望'}
              </span>
            );
          })}
        </div>
        {latestGrade && (
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: gradeRealReady ? '#15803D' : '#DC2626' }}>
            本期{qualityLabel(latestGrade).text}：{gradeRealReady ? '✅ 達標，可考慮真下' : '🧊 未達標，建議只看不下'}
          </div>
        )}
      </div>
    </div>
  );
}

function WindowStatusCard({ windowStatus, practiceStats }) {
  const ws = windowStatus || {};
  const ps = practiceStats || {};
  const countdown = useCountdown(ws.next_open_at);
  if (!windowStatus) return null;
  const phase = ws.phase || 'practice';
  const theme = phase === 'betting'
    ? { bg: 'linear-gradient(135deg,#065F46,#10B981)', tag: '🟢 出手時段開放中' }
    : phase === 'used_up'
      ? { bg: 'linear-gradient(135deg,#92400E,#D97706)', tag: '✅ 今日已收工' }
      : { bg: 'linear-gradient(135deg,#3730A3,#6366F1)', tag: '📚 練習賽 · 累積實力中' };
  const hit3 = ps.hit3_rate != null && Number.isFinite(ps.hit3_rate) ? (ps.hit3_rate * 100).toFixed(0) : '--';
  const hit2 = ps.hit2_rate != null && Number.isFinite(ps.hit2_rate) ? (ps.hit2_rate * 100).toFixed(0) : '--';
  return (
    <div style={{ padding: '10px 14px 0', maxWidth: 500, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <div style={{ background: theme.bg, borderRadius: 14, padding: '12px 14px', color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 900 }}>{theme.tag}</span>
          {ws.label && <span style={{ fontSize: 11, opacity: 0.9 }}>{ws.label}</span>}
        </div>

        {phase === 'betting' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>
              今日預算 {ws.budget_money}元（{ws.budget_groups}組）｜還能出手 <span style={{ fontSize: 18, fontWeight: 900 }}>{ws.remaining_groups}</span> 組（約{ws.remaining_money}元）
            </div>
            <ProgressBar used={ws.used_groups} total={ws.budget_groups} />
            <div style={{ fontSize: 11, opacity: 0.9, marginTop: 4 }}>已下 {ws.used_groups}／{ws.budget_groups} 組，系統挑好盤才出手，燒完自動收工</div>
          </div>
        )}

        {phase === 'used_up' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>{ws.label} 預算 {ws.budget_money}元（{ws.budget_groups}組）已用完</div>
            <ProgressBar used={ws.used_groups} total={ws.budget_groups} />
            <div style={{ fontSize: 11, opacity: 0.9, marginTop: 4 }}>今天已下 {ws.used_groups} 組，收手休息{countdown ? `，下次出手 ${countdown}` : ''}</div>
          </div>
        )}

        {phase === 'practice' && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>現在不下注，系統照常對獎練功、磨手感</div>
            <div style={{ fontSize: 13, fontWeight: 900, marginTop: 4 }}>
              ⏰ 下次出手：{ws.next_open_label || '—'}{countdown ? `（${countdown}）` : ''}
            </div>
            {ws.reason && <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{ws.reason}</div>}
          </div>
        )}

        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.25)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <MiniStat label="今日已研判" value={`${ps.today_compared ?? 0} 期`} />
          <MiniStat label={`近${ps.lookback ?? 0}期手感·中3`} value={`${hit3}%`} />
          <MiniStat label="中2率" value={`${hit2}%`} />
        </div>
      </div>
    </div>
  );
}

// ===== 時段徽章：真實推薦 / 練習（V0704-5）=====
function sessionBadge(sessionType) {
  const map = {
    real: { text: '🔴 真實推薦 · 現在可下注', bg: '#DC2626' },
    practice: { text: '📚 練習研判 · 觀察用別真下', bg: '#6366F1' },
    practice_grade_cold: { text: '🧊 出手時段·手感未達標 · 別真下', bg: '#0E7490' },
    practice_over_budget: { text: '⚠️ 今日子彈打完 · 僅供參考', bg: '#D97706' },
  };
  return map[sessionType] || null;
}

// ===== MetaTags（新系統版）=====
function MetaTags({ meta, isSkipped }) {
  if (!meta || isSkipped) return null;
  const zm = zmLabel(meta.zm_key);
  const quality = qualityLabel(meta.anchor_quality);
  const fillMode = fillModeLabel(meta.fill_mode); // ★ V0630-1
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {meta.zm_key && <span style={{ ...S.badge(zm.color, zm.bg) }}>{zm.text}</span>}
      {meta.anchor_quality && <span style={{ ...S.badge(quality.color, quality.bg) }}>{quality.text}</span>}
      {fillMode && <span style={S.badge(fillMode.color, fillMode.bg)}>{fillMode.text}</span>}
      {meta.anchor_count != null && <span style={S.badge(C.textSub, C.grayLight)}>真錨點{meta.anchor_count}顆</span>}
      {meta.fill_mode === 'lv2_with_tier2' && meta.second_tier_count > 0 && <span style={S.badge(C.textSub, C.grayLight)}>次強{meta.second_tier_count}顆</span>}
      {meta.fill_mode === 'second_tier' && meta.second_tier_count > 0 && <span style={S.badge(C.textSub, C.grayLight)}>+次強{meta.second_tier_count}顆</span>}
      {meta.fill_mode === 'board_fill' && meta.board_fill_count > 0 && <span style={S.badge(C.textSub, C.grayLight)}>+補位{meta.board_fill_count}顆</span>}
      {meta.anchor_span != null && <span style={S.badge(C.textSub, C.grayLight)}>跨度{meta.anchor_span}</span>}
      {meta.board_regime && meta.board_regime !== 'unknown' && (
        <span style={S.badge(boardRegimeStyle(meta.board_regime).color, boardRegimeStyle(meta.board_regime).bg)}>
          {meta.board_regime_label || meta.board_regime}
        </span>
      )}
      {meta.z_momentum === 'same' && <span style={S.badge(C.green, '#DCFCE7')}>↻ Z慣性</span>}
      {/* ★ V0701-1新增：四層維度標籤 */}
      {(() => { const sl = sumClassLabel(meta.sum_class); return sl && sl.text !== 'S中等' && <span style={S.badge(sl.color, sl.bg)}>{sl.text}</span>; })()}
      {(() => { const al = abPatternLabel(meta.ab_pattern); return al && meta.ab_pattern !== 'AB_balanced' && <span style={S.badge(al.color, al.bg)}>{al.text}</span>; })()}
      {meta.max_num_class === 'X1_low' && <span style={S.badge(C.blue, '#DBEAFE')}>最大≤70</span>}
      {meta.max_num_class === 'X3_high' && <span style={S.badge(C.red, '#FEE2E2')}>最大76+</span>}
      {meta.has_both_ends && <span style={S.badge(C.green, '#DCFCE7')}>首尾都有</span>}
      {meta.max_combos != null && meta.max_combos < 8 && <span style={S.badge(C.purple, '#F5F3FF')}>📉 縮手{meta.max_combos}組</span>}
    </div>
  );
}

// ===== 近20期中3率 TOP3 =====
function GradeHit3StatsBar({ gradeHit3Stats = [] }) {
  if (!gradeHit3Stats.length) {
    return (
      <div style={{
        flex: 1, minWidth: 140, maxWidth: 220, marginLeft: 8,
        background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8,
        padding: '6px 8px', fontSize: 10, color: '#9CA3AF', lineHeight: 1.5,
      }}>
        近{GRADE_HIT3_LOOKBACK}期中3率：資料累積中
      </div>
    );
  }
  return (
    <div style={{
      flex: 1, minWidth: 140, maxWidth: 240, marginLeft: 8,
      background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8,
      padding: '6px 8px',
    }}>
      <div style={{ fontSize: 9, color: '#1D4ED8', fontWeight: 700, marginBottom: 4 }}>
        近{GRADE_HIT3_LOOKBACK}期中3率 TOP3（含中2）
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {gradeHit3Stats.map(({ q, hit3, hit2, total, rate, rate2 }) => {
          const ql = QUALITY_LABEL[q] || { text: q, color: C.text };
          return (
            <div key={q} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10 }}>
              <span style={{ fontWeight: 700, color: ql.color }}>{ql.text}</span>
              <span style={{ fontWeight: 800, color: '#1F2937' }}>
                中3 {fmtPercent(rate)} ({hit3}/{total})｜中2 {fmtPercent(rate2)} ({hit2}/{total})
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function boardRegimeStyle(regime) {
  const map = {
    stable: { color: C.green, bg: '#DCFCE7' },
    transition: { color: '#D97706', bg: '#FFFBEB' },
    volatile: { color: '#DC2626', bg: '#FEE2E2' },
    unknown: { color: C.textSub, bg: C.grayLight },
  };
  return map[regime] || map.unknown;
}

function liveZmStatusLabel(status) {
  const map = {
    ok: { text: '同盤面達標', color: C.green },
    underperform: { text: '同盤面偏低', color: C.orange },
    live_skip: { text: '同盤面空窗', color: '#DC2626' },
    insufficient: { text: '同盤面樣本不足', color: C.textSub },
  };
  return map[status] || { text: status || '-', color: C.textSub };
}

function liveGradeStatusLabel(status) {
  const map = {
    ok: { text: '實戰達標', color: C.green },
    underperform: { text: '低於隨機', color: C.orange },
    live_skip: { text: '已觸發空窗', color: '#DC2626' },
    insufficient: { text: '樣本不足', color: C.textSub },
  };
  return map[status] || { text: status || '-', color: C.textSub };
}

// ===== 投注建議卡 =====
function LiveGradeStatsBar({ liveGradeStats }) {
  const stats = liveGradeStats && typeof liveGradeStats === 'object' ? liveGradeStats : {};
  const rows = ['lv1', 'lv2', 'lv3', 'lv4', 'lv5', 'lv6']
    .map(q => ({ q, ...(stats[q] || {}) }))
    .filter(r => r.total > 0);
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 10, padding: '8px 10px', background: '#fff9', borderRadius: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: C.textSub, marginBottom: 6 }}>📊 近30期實盤（中3｜中2）</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {rows.map(r => (
          <span key={r.q} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 999, background: '#fff', border: '1px solid #E5E7EB' }}>
            {qualityLabel(r.q).text} 中3 {Number.isFinite(r.rate) ? (r.rate * 100).toFixed(0) : '--'}%｜中2 {Number.isFinite(r.hit2_rate) ? (r.hit2_rate * 100).toFixed(0) : '--'}%
          </span>
        ))}
      </div>
    </div>
  );
}

function BettingAdviceCard({ meta, isSkipped, groupCount, lossWarning, liveGradeStatsAll }) {
  const bet = resolveBettingAdvice(meta, isSkipped, groupCount);
  const liveStatus = liveGradeStatusLabel(meta?.live_grade_status);
  const liveRate = meta?.live_grade_hit3_rate;
  const liveSamples = meta?.live_grade_samples;
  const zmStatus = liveZmStatusLabel(meta?.live_zm_status);
  const zmRate = meta?.live_zm_hit3_rate;
  const zmSamples = meta?.live_zm_samples;
  const statsAll = liveGradeStatsAll || meta?.live_grade_stats_all || {};
  return (
    <div style={{
      ...S.card,
      background: bet.bg,
      border: `2px solid ${bet.color}55`,
    }}>
      {(() => { const sb = sessionBadge(meta?.session_type); return sb ? (
        <div style={{ fontSize: 12, fontWeight: 900, color: '#fff', background: sb.bg, borderRadius: 8, padding: '5px 10px', marginBottom: 8, textAlign: 'center' }}>{sb.text}</div>
      ) : null; })()}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: bet.color }}>💰 實戰投注建議</div>
        <div style={{
          fontSize: 13, fontWeight: 900, color: '#fff', background: bet.color,
          padding: '4px 12px', borderRadius: 999,
        }}>{bet.actionText}</div>
      </div>
      <div style={{ fontSize: 16, fontWeight: 900, color: bet.color, marginBottom: 8, lineHeight: 1.4 }}>
        {bet.label}
      </div>
      {!isSkipped && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 13, color: C.text }}>
            本期 <strong>{bet.groups}</strong> 组 × {COST_PER_GROUP}元 = <strong style={{ fontSize: 18, color: bet.color }}>{bet.cost}</strong> 元
          </div>
          {bet.reducedFrom && bet.reducedFrom > bet.groups && (
            <div style={{ fontSize: 11, color: '#DC2626', fontWeight: 700 }}>
              ↓ 等级上限{bet.reducedFrom}组，经Live/盘面调整为{bet.groups}组
            </div>
          )}
          <div style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>{bet.breakEven}</div>
          {bet.hit2Backup && <div style={{ fontSize: 11, color: C.textSub }}>{bet.hit2Backup}</div>}
        </div>
      )}
      {bet.gradeLive && (
        <div style={{ marginTop: 8, padding: '6px 8px', background: '#fff8', borderRadius: 8, fontSize: 11 }}>
          <span style={{ color: C.textSub }}>本級實盤：</span>
          <span style={{ fontWeight: 700, color: String(bet.gradeLive?.vs_random || '').includes('優') ? '#15803D' : '#DC2626' }}>
            近{bet.gradeLive.samples}期 中3 {bet.gradeLive.hit3_pct}｜中2 {bet.gradeLive.hit2_pct || '--'}
          </span>
        </div>
      )}
      {bet.reasons?.length > 0 && (
        <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff9', borderRadius: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.textSub, marginBottom: 4 }}>📌 建议原因</div>
          {bet.reasons.map((r, i) => (
            <div key={i} style={{ fontSize: 11, color: C.text, lineHeight: 1.5 }}>• {r}</div>
          ))}
        </div>
      )}
      {(liveSamples > 0 || meta?.live_grade_status) && (
        <div style={{ marginTop: 8, padding: '6px 8px', background: '#fff8', borderRadius: 8, fontSize: 11 }}>
          <span style={{ color: C.textSub }}>Live等級：</span>
          <span style={{ fontWeight: 700, color: liveStatus.color }}>{liveStatus.text}</span>
          {liveRate != null && liveSamples > 0 && (
            <span style={{ color: C.textSub }}>｜近{liveSamples}期 {(liveRate * 100).toFixed(1)}%</span>
          )}
        </div>
      )}
      {(zmSamples > 0 || meta?.live_zm_status) && (
        <div style={{ marginTop: 6, padding: '6px 8px', background: '#fff8', borderRadius: 8, fontSize: 11 }}>
          <span style={{ color: C.textSub }}>Live同盤面：</span>
          <span style={{ fontWeight: 700, color: zmStatus.color }}>{zmStatus.text}</span>
          {zmRate != null && zmSamples > 0 && (
            <span style={{ color: C.textSub }}>｜{meta?.zm_key} 近{zmSamples}期 {(zmRate * 100).toFixed(1)}%</span>
          )}
        </div>
      )}
      <LiveGradeStatsBar liveGradeStats={statsAll} />
      {lossWarning && (
        <div style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: '#DC2626' }}>{lossWarning}</div>
      )}
    </div>
  );
}

function BoardCard({ meta, gradeHit3Stats = [] }) {
  if (!meta || !meta.zm_key) return null;
  const zm = zmLabel(meta.zm_key);
  const quality = qualityLabel(meta.anchor_quality);
  const anchors = toArray(meta.anchor_nums);
  const regimeStyle = boardRegimeStyle(meta.board_regime);

  return (
    <div style={S.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.text, whiteSpace: 'nowrap' }}>🗺️ 當期盤面分析</div>
        <GradeHit3StatsBar gradeHit3Stats={gradeHit3Stats} />
      </div>
      {meta.board_regime && meta.board_regime !== 'unknown' && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          marginBottom: 10, padding: '8px 10px', borderRadius: 10,
          background: regimeStyle.bg, border: `1px solid ${regimeStyle.color}44`,
        }}>
          <div>
            <div style={{ fontSize: 11, color: regimeStyle.color, fontWeight: 700 }}>盤面狀態</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: regimeStyle.color }}>
              {meta.board_regime_label || meta.board_regime}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: regimeStyle.color }}>穩定度</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: regimeStyle.color }}>{meta.board_stability_score ?? '-'}分</div>
            {meta.regime_shift && <div style={{ fontSize: 9, color: regimeStyle.color }}>Z主軸剛換邊</div>}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, background: zm.bg, borderRadius: 10, padding: '10px 12px', border: `1px solid ${zm.color}33` }}>
          <div style={{ fontSize: 11, color: zm.color, fontWeight: 700 }}>Z+M盤面</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: zm.color }}>{zm.text}</div>
          <div style={{ fontSize: 10, color: zm.color, opacity: 0.8 }}>{zm.desc}</div>
        </div>
        <div style={{ flex: 1, background: quality.bg, borderRadius: 10, padding: '10px 12px', border: `1px solid ${quality.color}33` }}>
          <div style={{ fontSize: 11, color: quality.color, fontWeight: 700 }}>錨點品質</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: quality.color }}>{quality.text}</div>
          <div style={{ fontSize: 10, color: quality.color, opacity: 0.8 }}>錨點{meta.anchor_count}顆 跨度{meta.anchor_span}</div>
        </div>
      </div>
      {/* 四區間 */}
      <div style={{ background: C.grayLight, borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: C.textSub, marginBottom: 4 }}>上期四區間分布</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[['1-20', meta.prev_z1, C.blue], ['21-40', meta.prev_z2, C.green], ['41-60', meta.prev_z3, C.orange], ['61-80', meta.prev_z4, C.purple]].map(([label, count, color]) => (
            <div key={label} style={{ flex: 1, textAlign: 'center', background: '#fff', borderRadius: 6, padding: '4px 0', border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 16, fontWeight: 900, color }}>{count ?? '-'}</div>
              <div style={{ fontSize: 9, color: C.textSub }}>{label}</div>
            </div>
          ))}
        </div>
      </div>
      {/* 錨點號碼 */}
      {anchors.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: C.textSub, marginBottom: 4 }}>錨點號碼（連續2期出現）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {anchors.map(n => (
              <span key={n} style={{
                fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                background: n >= 61 ? '#EDE9FE' : n <= 20 ? '#DBEAFE' : '#F3F4F6',
                color: n >= 61 ? C.purple : n <= 20 ? C.blue : C.text,
                border: `1px solid ${n >= 61 ? '#C4B5FD' : n <= 20 ? '#93C5FD' : C.border}`,
              }}>{padNum(n)}</span>
            ))}
          </div>
        </div>
      )}
      {meta.combo_pick_mode && (
        <div style={{ fontSize: 10, color: C.textSub, marginTop: 8 }}>
          組合挑選：{meta.combo_pick_mode === 'v0703_5_scored' ? '評分優化V5' : meta.combo_pick_mode === 'v0703_4_scored' ? '評分優化V4' : meta.combo_pick_mode === 'v0703_3_scored' ? '評分優化' : meta.combo_pick_mode}
          {meta.score_weight_regime && meta.score_weight_regime !== 'stable' ? `｜權重:${meta.score_weight_regime}` : ''}
        </div>
      )}
    </div>
  );
}

// ===== 第一頁：快速 =====
function QuickPage({ prediction, historyRows, recent20, onRefresh, loading, lossWarning, liveGradeStatsAll }) {
  const row = prediction?.latest_3star_row;
  const groups = toArray(row?.groups_json);
  const realGroups = groups.filter(g => g.key !== 'skip_meta');
  const meta0 = realGroups[0]?.meta || groups.find(g => g.key === 'skip_meta')?.meta || {};
  const isSkipped = !row || row?.status === 'skipped' || realGroups.length === 0;
  const compareResult = parseCompareResult(row?.compare_result_json);
  const detail = toArray(compareResult?.detail);
  const bestHit = toNum(row?.hit_count, 0);
  const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.green : C.textSub;
  const [expanded, setExpanded] = useState(true);

  // 連續期數顏色（跟熱號頁一樣）
  // 用useMemo確保recent20更新後重新計算，解決第一頁載入時recent20還是空的問題
  const streakMap = React.useMemo(() => {
    const rows20q = toArray(recent20).slice(0, 20);
    const map = {};
    for (let num = 1; num <= 80; num++) {
      let c = 0;
      for (const r of rows20q) {
        if (parseNums(r?.numbers).includes(num)) c++;
        else break;
      }
      map[num] = Math.min(c, 5);
    }
    return map;
  }, [recent20]);
  function consecQ(num) { return streakMap[num] || 0; }

  const gradeHit3Stats = React.useMemo(
    () => calcGradeHit3Stats(historyRows, GRADE_HIT3_LOOKBACK),
    [historyRows]
  );
  const streakStyleQ = {
    5: { color: '#DC2626', bg: '#FEF2F2', border: '#FCA5A5' },
    4: { color: '#EA580C', bg: '#FFF7ED', border: '#FED7AA' },
    3: { color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
    2: { color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4' },
    1: { color: '#6B7280', bg: '#F3F4F6', border: '#E5E7EB' },
    0: { color: '#9CA3AF', bg: '#F9FAFB', border: '#E5E7EB' },
  };

  return (
    <div style={S.page}>
      <BettingAdviceCard meta={meta0} isSkipped={isSkipped} groupCount={realGroups.length} lossWarning={lossWarning} liveGradeStatsAll={liveGradeStatsAll} />

      {/* 盤面分析 */}
      {meta0.zm_key && <BoardCard meta={meta0} gradeHit3Stats={gradeHit3Stats} />}

      {/* 預測組合 */}
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>🎯 預測 {row?.source_draw_no || '--'}</div>
          {!isSkipped && row?.compare_status === 'done' && (
            <span style={S.numBadge(bestHit)}>中{bestHit}</span>
          )}
        </div>

        {(() => { const sb = sessionBadge(meta0.session_type); return sb ? (
          <div style={{ display: 'inline-block', fontSize: 11, fontWeight: 900, color: '#fff', background: sb.bg, borderRadius: 8, padding: '3px 10px', marginBottom: 8 }}>{sb.text}</div>
        ) : null; })()}

        <MetaTags meta={meta0} isSkipped={isSkipped} />

        {isSkipped ? (
          <div style={{ marginTop: 10, fontSize: 12, color: C.textSub }}>
            ⏸️ 本期空窗 —— {meta0.skip_reason === 'no_anchor' ? '無錨點號碼'
              : meta0.anchor_count != null ? `錨點${meta0.anchor_count}顆（品質${meta0.anchor_quality || '弱'}）`
              : '條件不符合'}
          </div>
        ) : (
          <>
            <button onClick={() => setExpanded(v => !v)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', background: C.grayLight, borderRadius: 8, padding: '7px 10px', border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer', color: C.text, marginTop: 8 }}>
              <span>出手 {realGroups.length} 組</span>
              <span>{expanded ? '▲' : '▼'}</span>
            </button>
            {expanded && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {realGroups.map((g, idx) => {
                  const d = detail.find(x => x?.key === g.key);
                  const hit = d ? toNum(d?.hit ?? d?.hit_count, 0) : -1;
                  return (
                    <div key={g.key || idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', background: hit >= 3 ? '#FEF9C3' : hit >= 2 ? '#DCFCE7' : '#F9FAFB', borderRadius: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1 }}>
                        {toArray(g.nums).map((n, i) => {
                          const sq = streakStyleQ[consecQ(n)];
                          return (
                            <span key={n} style={{
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              width: 28, height: 28, borderRadius: '50%',
                              background: sq.bg, color: sq.color,
                              border: `2px solid ${sq.border}`,
                              fontSize: 11, fontWeight: 800,
                              marginRight: i < toArray(g.nums).length - 1 ? 4 : 0,
                            }}>
                              {padNum(n)}
                            </span>
                          );
                        })}
                      </span>
                      {hit >= 0 && <span style={S.numBadge(hit)}>中{hit}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* 刷新按鈕 */}
      <button onClick={onRefresh} style={{ padding: '10px', border: `1px solid ${C.border}`, borderRadius: 10, background: '#fff', fontSize: 12, fontWeight: 600, color: C.textSub, cursor: 'pointer' }}>
        {loading ? '⏳ 更新中...' : '🔄 手動更新'}
      </button>
    </div>
  );
}

// ===== 第二頁：近期 =====
function HistoryPage({ historyRows }) {
  const rows = toArray(historyRows).slice(0, 50);
  return (
    <div style={S.page}>
      <Card title="近期命中紀錄" icon="📋">
        {!rows.length ? <Spinner /> : rows.map((row, idx) => {
          const isSkipped = row?.status === 'skipped';
          const isDone = row?.compare_status === 'done' && !isSkipped;
          const groups = toArray(row?.groups_json);
          const meta = groups.find(g => g.key !== 'skip_meta')?.meta || groups[0]?.meta || {};
          const compareResult = parseCompareResult(row?.compare_result_json);
          const detail = toArray(compareResult?.detail);
          const bestHit = toNum(row?.hit_count, 0);
          const timeStr = row?.created_at
            ? new Date(row.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
            : '--';
          const zm = zmLabel(meta?.zm_key);
          const quality = qualityLabel(meta?.anchor_quality);

          return (
            <div key={row?.source_draw_no || idx} style={{ borderBottom: `1px solid ${C.border}`, paddingBottom: 10, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>預測 {row?.source_draw_no}</span>
                <span style={{ fontSize: 10, color: C.textSub }}>{timeStr}</span>
              </div>
              {/* MetaTags */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                {meta.zm_key && <span style={S.badge(zm.color, zm.bg)}>{zm.text}</span>}
                {meta.anchor_quality && <span style={S.badge(quality.color, quality.bg)}>{quality.text}</span>}
                {(() => { const fm = fillModeLabel(meta.fill_mode); return fm && <span style={S.badge(fm.color, fm.bg)}>{fm.text}</span>; })()}
                {meta.anchor_count != null && <span style={S.badge(C.textSub, C.grayLight)}>真錨點{meta.anchor_count}顆 跨度{meta.anchor_span}</span>}
                {meta.prev_z1 != null && <span style={S.badge(C.textSub, C.grayLight)}>上期區間 {meta.prev_z1}/{meta.prev_z2}/{meta.prev_z3}/{meta.prev_z4}</span>}
                {/* quality badge已顯示金/銀/銅/鐵/錫，此處不再重複 */}
                {meta.has_both_ends && <span style={S.badge(C.green, '#DCFCE7')}>首尾都有</span>}
                {meta.has_large_anchor && <span style={S.badge(C.purple, '#EDE9FE')}>含75-80</span>}
              </div>
              {/* 結果 */}
              {isSkipped ? (
                <div style={{ fontSize: 11, color: C.textSub }}>⏸️ 空窗</div>
              ) : !isDone ? (
                <div style={{ fontSize: 11, color: C.orange }}>等待比對...</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {detail.filter(d => toNum(d?.hit ?? d?.hit_count, 0) >= 2).map((d, i) => (
                    <span key={i} style={S.numBadge(toNum(d?.hit ?? d?.hit_count, 0))}>
                      {toArray(d?.nums).map(n => padNum(n)).join(' ')} 中{toNum(d?.hit ?? d?.hit_count, 0)}
                    </span>
                  ))}
                  <span style={{ ...S.numBadge(bestHit), fontWeight: 900 }}>最高中{bestHit}</span>
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ===== 第三頁：統計 =====
function StatsPage({ historyRows }) {
  const [subTab, setSubTab] = useState('all');
  const rows = toArray(historyRows)
    .filter(r => r?.created_at >= STATS_START_DATE)
    .filter(r => r?.compare_status === 'done' && r?.status !== 'skipped');

  function calcStats(filtered) {
    const total = filtered.length;
    const hit3 = filtered.filter(r => toNum(r?.hit_count) >= 3).length;
    const hit2 = filtered.filter(r => toNum(r?.hit_count) === 2).length;
    const hit1 = filtered.filter(r => toNum(r?.hit_count) === 1).length;
    const hit0 = filtered.filter(r => toNum(r?.hit_count) === 0).length;
    return { total, hit3, hit2, hit1, hit0, rate: total > 0 ? hit3 / total : 0 };
  }
  function filterByZM(zmKey) {
    return rows.filter(r => toArray(r?.groups_json).find(g => g.key !== 'skip_meta')?.meta?.zm_key === zmKey);
  }
  function filterByQuality(q) {
    return rows.filter(r => toArray(r?.groups_json).find(g => g.key !== 'skip_meta')?.meta?.anchor_quality === q);
  }
  function filterByFillMode(mode) {
    return rows.filter(r => toArray(r?.groups_json).find(g => g.key !== 'skip_meta')?.meta?.fill_mode === mode);
  }

  const allStats = calcStats(rows);
  const rateColor = allStats.rate >= 0.15 ? C.green : allStats.rate >= 0.08 ? C.orange : C.red;
  const subTabs = [
    { key: 'all', label: '全部', icon: '📊' },
    { key: 'zm', label: 'Z+M盤面', icon: '🗺️' },
    { key: 'quality', label: '錨點品質', icon: '⚓' },
    { key: 'golden', label: '六級對比', icon: '🏆' },
    { key: 'fillmode', label: '補位模式', icon: '🧩' },
  ];

  return (
    <div style={S.page}>
      <Card title="整體命中率" icon="📊">
        <div style={{ textAlign: 'center', padding: '10px 0' }}>
          <div style={{ ...S.bigNum, color: rateColor }}>{fmtPercent(allStats.rate)}</div>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>共 {allStats.total} 期｜中3：{allStats.hit3} 次</div>
        </div>
        <div style={S.divider} />
        <StatRow label="理論值（隨機）" value="8.3%" valueColor={C.textSub} />
        <StatRow label="第1級 SQL基準" value="51.6%" valueColor={C.gold} />
        <StatRow label="中3命中率" value={fmtPercent(allStats.rate)} valueColor={rateColor} />
        <StatRow label="中3次數" value={`${allStats.hit3} 次`} />
        <StatRow label="中2次數" value={`${allStats.hit2} 次`} />
        <StatRow label="中1次數" value={`${allStats.hit1} 次`} />
        <StatRow label="未中次數" value={`${allStats.hit0} 次`} />
      </Card>

      {subTab === 'all' && (() => {
        const systemStats = calcStats(rows);
        const randomRows = toArray(historyRows)
          .filter(r => r?.created_at >= STATS_START_DATE)
          .filter(r => r?.mode === 'random_test' && r?.compare_status === 'done');
        const randomStats = calcStats(randomRows);
        const sysRc = systemStats.rate >= 0.083 ? C.green : C.red;
        const rndRc = randomStats.rate >= 0.083 ? C.green : C.red;
        return (
          <Card title="系統 vs 隨機對照" icon="⚖️">
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, background: '#EFF6FF', borderRadius: 10, padding: '12px', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: C.blue, fontWeight: 700 }}>本系統</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: sysRc }}>{fmtPercent(systemStats.rate)}</div>
                <div style={{ fontSize: 10, color: C.textSub }}>{systemStats.hit3}/{systemStats.total}期</div>
              </div>
              <div style={{ flex: 1, background: C.grayLight, borderRadius: 10, padding: '12px', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: C.textSub, fontWeight: 700 }}>隨機對照</div>
                {randomStats.total === 0 ? (
                  <div style={{ fontSize: 11, color: C.textSub, marginTop: 8 }}>樣本累積中</div>
                ) : (
                  <>
                    <div style={{ fontSize: 22, fontWeight: 900, color: rndRc }}>{fmtPercent(randomStats.rate)}</div>
                    <div style={{ fontSize: 10, color: C.textSub }}>{randomStats.hit3}/{randomStats.total}期</div>
                  </>
                )}
              </div>
            </div>
            <div style={{ fontSize: 10, color: C.textSub, marginTop: 8, textAlign: 'center' }}>
              隨機理論值 8.3%｜系統需長期高於隨機才值得實戰加碼
            </div>
          </Card>
        );
      })()}

      <div style={{ display: 'flex', gap: 6, background: C.card, borderRadius: 12, padding: 8, boxShadow: C.shadow, flexWrap: 'wrap' }}>
        {subTabs.map(t => (
          <button key={t.key} style={S.subTab(subTab === t.key)} onClick={() => setSubTab(t.key)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {subTab === 'zm' && (
        <Card title="Z+M盤面命中率" icon="🗺️">
          {Object.keys(ZM_LABEL).map(zmKey => {
            const filtered = filterByZM(zmKey);
            const s = calcStats(filtered);
            const zm = zmLabel(zmKey);
            const rc = s.rate >= 0.15 ? C.green : s.rate >= 0.08 ? C.orange : C.red;
            return (
              <div key={zmKey} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: zm.bg, borderRadius: 8, padding: '7px 10px', marginBottom: 4, border: `1px solid ${zm.color}22` }}>
                <div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: zm.color }}>{zm.text}</span>
                  <span style={{ fontSize: 10, color: C.textSub, marginLeft: 6 }}>{zm.desc}</span>
                </div>
                {s.total === 0 ? <span style={{ fontSize: 10, color: C.textSub }}>無資料</span> : (
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: 13, fontWeight: 900, color: rc }}>{fmtPercent(s.rate)}</span>
                    <span style={{ fontSize: 10, color: C.textSub, marginLeft: 4 }}>{s.hit3}/{s.total}</span>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {subTab === 'quality' && (
        <Card title="錨點品質命中率" icon="⚓">
          {['lv1', 'lv2', 'lv3', 'lv4', 'lv5', 'lv6'].map(q => {
            const s = calcStats(filterByQuality(q));
            const ql = qualityLabel(q);
            const rc = s.rate >= 0.15 ? C.green : s.rate >= 0.08 ? C.orange : C.red;
            return (
              <div key={q} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: ql.bg, borderRadius: 8, padding: '7px 10px', marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: ql.color }}>{ql.text}</span>
                {s.total === 0 ? <span style={{ fontSize: 10, color: C.textSub }}>無資料</span> : (
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: 13, fontWeight: 900, color: rc }}>{fmtPercent(s.rate)}</span>
                    <span style={{ fontSize: 10, color: C.textSub, marginLeft: 4 }}>{s.hit3}/{s.total}</span>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {subTab === 'golden' && (
        <Card title="六級命中率對比" icon="🏆">
          <div style={{ fontSize: 11, color: C.textSub, marginBottom: 10, lineHeight: 1.6 }}>
            對齊 V0702-7 新分級（真錨點+次強錨點組合）。基準為 SQL 21636 期驗證。
          </div>
          {GRADE_DEFINITIONS.map(lv => {
            const filtered = filterByQuality(lv.q);
            const s = calcStats(filtered);
            const rc = s.rate >= 0.15 ? C.green : s.rate >= 0.08 ? C.orange : C.red;
            const ql = qualityLabel(lv.q);
            return (
              <div key={lv.q} style={{ background: ql.bg, borderRadius: 8, padding: '10px 12px', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: `1px solid ${ql.color}33` }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: ql.color }}>{lv.label}</div>
                  <div style={{ fontSize: 10, color: C.textSub }}>{lv.rule}</div>
                  <div style={{ fontSize: 10, color: C.textSub }}>SQL基準 {lv.bench}%</div>
                </div>
                {s.total === 0 ? <span style={{ fontSize: 10, color: C.textSub }}>無資料</span> : (
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 20, fontWeight: 900, color: rc }}>{fmtPercent(s.rate)}</div>
                    <div style={{ fontSize: 10, color: C.textSub }}>{s.hit3}/{s.total}期</div>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {/* ★ V0630-1新增：補位模式統計 */}
      {subTab === 'fillmode' && (
        <Card title="補位模式命中率" icon="🧩">
          <div style={{ fontSize: 11, color: C.textSub, marginBottom: 10, lineHeight: 1.6 }}>
            真錨點不夠時的補救機制效果驗證：次強錨點(隔期出現)、盤面補位(上期符合區間的號碼)。這兩個是全新指標，邊跑邊驗證。
          </div>
          {[
            { key: 'none', label: '✅ 真錨點（無需補位）', color: C.green, bg: '#DCFCE7' },
            { key: 'lv2_with_tier2', label: '⚡ 第2級次強組合', color: '#7C3AED', bg: '#EDE9FE' },
            { key: 'second_tier', label: '🔄 次強錨點補位', color: '#0891B2', bg: '#CFFAFE' },
            { key: 'board_fill', label: '🧩 盤面補位', color: '#9333EA', bg: '#F3E8FF' },
          ].map(fm => {
            const s = calcStats(filterByFillMode(fm.key));
            const rc = s.rate >= 0.15 ? C.green : s.rate >= 0.08 ? C.orange : C.red;
            return (
              <div key={fm.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: fm.bg, borderRadius: 8, padding: '10px 12px', marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: fm.color }}>{fm.label}</span>
                {s.total === 0 ? <span style={{ fontSize: 10, color: C.textSub }}>無資料</span> : (
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: 16, fontWeight: 900, color: rc }}>{fmtPercent(s.rate)}</span>
                    <span style={{ fontSize: 10, color: C.textSub, marginLeft: 4 }}>{s.hit3}/{s.total}期</span>
                  </div>
                )}
              </div>
            );
          })}
          <div style={S.divider} />
          <div style={{ fontSize: 11, color: C.textSub, textAlign: 'center' }}>補位模式樣本累積中，尚無SQL歷史基準可比對</div>
        </Card>
      )}

      <div style={{ fontSize: 11, color: C.textSub, textAlign: 'center' }}>※ 統計從 V0703-2 上線起算（含新六級定義 + Live過濾）</div>
    </div>
  );
}

// ===== 第四頁：開獎 =====
function MarketPage({ recent20 }) {
  const rows = toArray(recent20).slice(0, 20);
  return (
    <div style={S.page}>
      <Card title="最近20期開獎" icon="🎱">
        {!rows.length ? <Spinner /> : rows.map((row, idx) => {
          const nums = parseNums(row?.numbers).sort((a, b) => a - b);
          const timeStr = row?.draw_time ? String(row.draw_time).slice(11, 16) : '--';
          return (
            <div key={row?.draw_no || idx} style={{ ...S.statRow, alignItems: 'flex-start', paddingTop: 10, paddingBottom: 10 }}>
              <div style={{ minWidth: 80 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>#{fmt(row?.draw_no)}</div>
                <div style={{ fontSize: 11, color: C.textSub }}>{timeStr}</div>
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

// ===== 第五頁：熱號 =====
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
    level, data: numStats.filter(s => s.consec === level).sort((a, b) => a.n - b.n)
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
        </div>
        {!rows.length ? <Spinner /> : groups.map(g => {
          const info = levelInfo[g.level];
          return (
            <div key={g.level} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: info.color, background: info.bg, border: `1px solid ${info.border}`, borderRadius: 6, padding: '2px 8px' }}>{info.label}</span>
                <span style={{ fontSize: 11, color: C.textSub }}>{g.data.length} 顆</span>
              </div>
              {g.data.length === 0 ? (
                <div style={{ fontSize: 12, color: C.textSub }}>目前無號碼符合此等級</div>
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

// ===== 第六頁：錨點（原熱號池，換成錨點分析）=====
function AnchorPage({ prediction, recent20 }) {
  const row = prediction?.latest_3star_row;
  const groups = toArray(row?.groups_json);
  const meta = groups.find(g => g.key !== 'skip_meta')?.meta || groups[0]?.meta || {};
  const anchors = toArray(meta.anchor_nums);
  const isSkipped = !row || row?.status === 'skipped';
  const zm = zmLabel(meta.zm_key);
  const quality = qualityLabel(meta.anchor_quality);

  // 計算每顆錨點的連續期數（從recent20算，跟第五頁熱號一樣）
  const rows20 = toArray(recent20).slice(0, 20);
  function consecutiveCount(num) {
    let c = 0;
    for (const r of rows20) {
      if (parseNums(r?.numbers).includes(num)) c++;
      else break;
    }
    return c;
  }
  // 連續期數對應顏色（跟第五頁一樣）
  const streakStyle = {
    5: { bg: '#FEF2F2', border: '#FCA5A5', color: '#DC2626' },
    4: { bg: '#FFF7ED', border: '#FED7AA', color: '#EA580C' },
    3: { bg: '#FFFBEB', border: '#FDE68A', color: '#D97706' },
    2: { bg: '#F0FDFA', border: '#99F6E4', color: '#0F766E' },
    1: { bg: '#F3F4F6', border: '#E5E7EB', color: '#6B7280' },
  };
  function getStreakStyle(n) {
    const c = Math.min(consecutiveCount(n), 5);
    return streakStyle[c] || streakStyle[1];
  }

  return (
    <div style={S.page}>
      <Card title="本期錨點分析" icon="⚓">
        <div style={{ fontSize: 11, color: C.textSub, marginBottom: 12, lineHeight: 1.6 }}>
          ★ V0702-4新分級（SQL 21636期驗證）：真錨點+次強錨點組合決定等級。次強錨點=這期有但上期沒有、前兩期有的號碼。超金(真>=7)51.6% / 強補位(真>=4+次強>=5)50.8% / 金強35-37% / 銅強27.7% / 銀弱17-22% / 銅弱14.2%
        </div>

        {isSkipped ? (
          <div style={S.empty}>本期空窗，無錨點資料</div>
        ) : (<>
          {/* 盤面+品質 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 1, background: zm.bg, borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: zm.color, fontWeight: 700 }}>Z+M盤面</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: zm.color }}>{zm.text}</div>
              <div style={{ fontSize: 10, color: zm.color, opacity: 0.8 }}>{zm.desc}</div>
            </div>
            <div style={{ flex: 1, background: quality.bg, borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: quality.color, fontWeight: 700 }}>錨點品質</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: quality.color }}>{quality.text}</div>
              <div style={{ fontSize: 10, color: quality.color, opacity: 0.8 }}>
                真錨點{meta.anchor_count}顆 次強{meta.tier2_count || 0}顆
              </div>
            </div>
          </div>

          {/* ★ V0630-1：補位模式提示 */}
          {meta.fill_mode && meta.fill_mode !== 'none' && (() => {
            const fm = fillModeLabel(meta.fill_mode);
            return fm ? (
              <div style={{ background: fm.bg, borderRadius: 10, padding: '10px 12px', marginBottom: 12, border: `1px solid ${fm.color}44` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: fm.color, marginBottom: 4 }}>{fm.text}</div>
                <div style={{ fontSize: 11, color: fm.color, opacity: 0.85 }}>
                  真錨點{meta.anchor_count}顆
                  {meta.fill_mode === 'lv2_with_tier2' && ` + 次強錨點${meta.second_tier_count || 0}顆（第2級核心組合）`}
                  {meta.fill_mode === 'second_tier' && `，補充次強錨點${meta.second_tier_count}顆`}
                  {meta.fill_mode === 'board_fill' && `，補次強${meta.second_tier_count}顆 + 盤面${meta.board_fill_count}顆`}
                  {meta.working_anchor_count != null && `，共${meta.working_anchor_count}顆用於選號`}
                </div>
              </div>
            ) : null;
          })()}

          {/* ★ V0702-7：六級等級判定卡 */}
          <div style={{ background: quality.bg, borderRadius: 10, padding: '10px 12px', marginBottom: 12, border: `1px solid ${quality.color}44` }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: quality.color, marginBottom: 6 }}>
              {quality.text}（真錨點{meta.anchor_count}顆）
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
              {[
                { q: 'lv1', label: '第1級', bench: '51.6%' },
                { q: 'lv2', label: '第2級', bench: '50.8%' },
                { q: 'lv3', label: '第3級', bench: '35-37%' },
                { q: 'lv4', label: '第4級', bench: '27.7%' },
                { q: 'lv5', label: '第5級', bench: '17-22%' },
                { q: 'lv6', label: '第6級', bench: '14.2%' },
              ].map(lv => (
                <div key={lv.q} style={{
                  flex: 1, textAlign: 'center', borderRadius: 6, padding: '4px 2px',
                  background: meta.anchor_quality === lv.q ? quality.color : '#fff',
                  border: `1px solid ${meta.anchor_quality === lv.q ? quality.color : C.border}`,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: meta.anchor_quality === lv.q ? '#fff' : C.textSub }}>{lv.label}</div>
                  <div style={{ fontSize: 8, color: meta.anchor_quality === lv.q ? '#fff' : C.textSub }}>{lv.bench}</div>
                </div>
              ))}
            </div>
            <div style={S.divider} />
            {/* 輔助參考指標（不再是主判斷依據） */}
            {[
              { label: '跨度', value: meta.anchor_span },
              { label: '61-80區顆數', value: meta.anchor_z4 },
            ].map(item => (
              <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                <span style={{ color: C.textSub }}>{item.label}（參考）</span>
                <span style={{ fontWeight: 700, color: C.text }}>{item.value ?? '-'}</span>
              </div>
            ))}
            {[
              { label: '首尾都有（1-20≥2且61-80≥2）', pass: meta.has_both_ends },
              { label: '含75-80號碼', pass: meta.has_large_anchor },
            ].map(item => (
              <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                <span style={{ color: item.pass ? C.green : C.textSub }}>{item.pass ? '⭐' : '○'} {item.label}（參考）</span>
              </div>
            ))}
          </div>

          {/* 錨點號碼（顏色依連續期數，跟熱號頁一樣） */}
          {anchors.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: C.textSub, marginBottom: 6 }}>錨點號碼（{anchors.length}顆）</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {anchors.map(n => {
                  const ss = getStreakStyle(n);
                  const streak = Math.min(consecutiveCount(n), 5);
                  return (
                    <div key={n} style={{
                      width: 36, height: 36, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 800,
                      background: ss.bg, color: ss.color,
                      border: `2px solid ${ss.border}`,
                      position: 'relative',
                    }}>
                      {padNum(n)}
                      {streak >= 3 && (
                        <div style={{
                          position: 'absolute', top: -4, right: -4,
                          fontSize: 8, fontWeight: 900, color: '#fff',
                          background: ss.color, borderRadius: '50%',
                          width: 14, height: 14, display: 'flex',
                          alignItems: 'center', justifyContent: 'center',
                        }}>{streak}</div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                {[
                  { streak: 5, label: '連5期' },
                  { streak: 4, label: '連4期' },
                  { streak: 3, label: '連3期' },
                  { streak: 2, label: '連2期(錨點)' },
                ].map(({ streak, label }) => {
                  const ss = streakStyle[streak];
                  return (
                    <div key={streak} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: ss.bg, border: `1px solid ${ss.border}` }} />
                      <span style={{ fontSize: 9, color: ss.color }}>{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 母球池 */}
          {toArray(meta.pool7).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: C.textSub, marginBottom: 6 }}>母球池（7顆）→ C(7,3) 生成組合</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {toArray(meta.pool7).map(n => (
                  <div key={n} style={{ width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, background: C.gold, color: '#fff', border: `2px solid ${C.gold}` }}>
                    {padNum(n)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>)}
      </Card>
    </div>
  );
}

// ===== 錯誤邊界（防止白屏）=====
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 480, margin: '40px auto' }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: '#DC2626', marginBottom: 8 }}>⚠️ 頁面載入錯誤</div>
          <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, marginBottom: 16 }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button type="button" onClick={() => window.location.reload()} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#1E3A5F', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
            重新載入
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ===== 主應用 =====
function AppInner() {
  const [tab, setTab] = useState('quick');
  const [prediction, setPrediction] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [recent20, setRecent20] = useState([]);
  const [loopStatus, setLoopStatus] = useState('載入中...');
  const [lossWarning, setLossWarning] = useState(null);
  const [emergencyAlert, setEmergencyAlert] = useState(null);
  const [liveGradeStatsAll, setLiveGradeStatsAll] = useState({});
  const [windowStatus, setWindowStatus] = useState(null);
  const [practiceStats, setPracticeStats] = useState(null);
  const [todayGradeStats, setTodayGradeStats] = useState(null);
  const [gradeRealReady, setGradeRealReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  const apiFetch = (path) => fetch(`${RAILWAY_URL}${path}`).then(r => r.json());

  const loadData = useCallback(async () => {
    try {
      const [predRes, recentRes] = await Promise.all([
        apiFetch('/api/prediction-latest').catch(() => ({})),
        apiFetch('/api/recent20').catch(() => ({})),
      ]);
      setPrediction(predRes);
      setWindowStatus(predRes?.window_status || null);
      setPracticeStats(predRes?.practice_stats || null);
      setTodayGradeStats(predRes?.today_grade_stats || null);
      setGradeRealReady(!!predRes?.grade_real_ready);
      setHistoryRows(predRes?.recent_3star_compared_rows || predRes?.recent_compared_rows || []);
      setRecent20(recentRes?.recent20 || recentRes?.data || []);
      setLoopStatus(isNight() ? '夜間停止（00:00-07:00）' : `已更新 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`);
      setEmergencyAlert(predRes?.emergency_alert || null);
      setLossWarning(predRes?.loss_warning || null);
      const latestMeta = predRes?.latest_3star_row?.groups_json?.find(g => g?.key !== 'skip_meta')?.meta
        || predRes?.formal?.row?.groups_json?.find(g => g?.key !== 'skip_meta')?.meta
        || {};
      setLiveGradeStatsAll(predRes?.live_grade_stats_all || latestMeta?.live_grade_stats_all || {});
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
    { key: 'anchor',  label: '錨點', icon: '⚓' },
  ];

  return (
    <div style={S.app}>
      {lossWarning && !emergencyAlert && (
        <div style={{ background: '#FEF3C7', color: '#92400E', fontSize: 12, fontWeight: 700, textAlign: 'center', padding: '8px 16px', borderBottom: '1px solid #FDE68A' }}>
          {lossWarning}
        </div>
      )}
      {emergencyAlert && (
        <div style={{ background: '#DC2626', color: '#fff', fontSize: 13, fontWeight: 800, textAlign: 'center', padding: '8px 16px' }}>
          {emergencyAlert}
        </div>
      )}
      <div style={S.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={S.headerTitle}>🏆 富緯賓果 AI V0705-5</div>
            <div style={S.headerSub}>{loopStatus}</div>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', marginTop: 2 }}>
            {new Date().toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>
      <WindowStatusCard windowStatus={windowStatus} practiceStats={practiceStats} />
      <TodayGradeStatsBar
        todayGradeStats={todayGradeStats}
        gradeRealReady={gradeRealReady}
        latestGrade={prediction?.latest_grade || prediction?.latest_3star_row?.groups_json?.find(g => g?.key !== 'skip_meta')?.meta?.anchor_quality}
      />
      <div style={S.tabs}>
        {TABS.map(t => (
          <button key={t.key} style={S.tab(tab === t.key)} onClick={() => setTab(t.key)}>
            <div>{t.icon}</div>
            <div>{t.label}</div>
          </button>
        ))}
      </div>
      {loading && tab === 'quick' && <Spinner />}
      {tab === 'quick'   && <QuickPage   prediction={prediction} historyRows={historyRows} recent20={recent20} onRefresh={loadData} loading={loading} lossWarning={lossWarning} liveGradeStatsAll={liveGradeStatsAll} />}
      {tab === 'history' && <HistoryPage historyRows={historyRows} />}
      {tab === 'stats'   && <StatsPage   historyRows={historyRows} />}
      {tab === 'market'  && <MarketPage  recent20={recent20} />}
      {tab === 'hot'     && <HotPage     recent20={recent20} />}
      {tab === 'anchor'  && <AnchorPage  prediction={prediction} recent20={recent20} />}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
