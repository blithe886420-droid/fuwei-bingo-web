import React, { useCallback, useEffect, useRef, useState } from 'react';

const RAILWAY_URL = 'https://fuwei-bingo-backend-production.up.railway.app';
const REFRESH_INTERVAL_MS = 30000;
const STATS_START_DATE = '2026-06-08T00:00:00.000Z';

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

function buildRandomGroups4() {
  const pool = Array.from({ length: 80 }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const selected = pool.slice(0, 12);
  const groups = [];
  for (let g = 0; g < 4; g++) {
    const nums = selected.slice(g * 3, g * 3 + 3).sort((a, b) => a - b);
    groups.push({ key: `rand_${g + 1}`, nums });
  }
  return groups;
}

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
  app: { minHeight: '100vh', background: C.bg, fontFamily: '"Segoe UI", "PingFang TC", "Noto Sans TC", sans-serif', color: C.text, paddingBottom: 80 },
  header: { background: `linear-gradient(135deg, ${C.gold} 0%, ${C.orange} 100%)`, padding: '18px 20px 14px', boxShadow: '0 2px 16px rgba(200,134,10,0.25)' },
  headerTitle: { fontSize: 22, fontWeight: 900, color: '#FFF', letterSpacing: 2, margin: 0 },
  headerSub: { fontSize: 12, color: 'rgba(255,255,255,0.85)', marginTop: 3 },
  tabs: { display: 'flex', background: C.card, borderBottom: `2px solid ${C.border}`, position: 'sticky', top: 0, zIndex: 100, boxShadow: '0 2px 8px rgba(200,134,10,0.08)' },
  tab: (active) => ({ flex: 1, padding: '10px 2px 8px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: active ? 700 : 400, color: active ? C.gold : C.gray, borderBottom: active ? `3px solid ${C.gold}` : '3px solid transparent', transition: 'all 0.2s' }),
  subTab: (active) => ({ flex: 1, padding: '8px 4px', border: 'none', background: active ? C.goldBg : 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: active ? 700 : 400, color: active ? C.gold : C.gray, borderRadius: 8, transition: 'all 0.2s' }),
  page: { padding: '16px 14px', maxWidth: 600, margin: '0 auto' },
  card: { background: C.card, borderRadius: 16, padding: '16px 16px 14px', marginBottom: 14, boxShadow: C.shadow, border: `1px solid ${C.border}` },
  cardTitle: { fontSize: 14, fontWeight: 700, color: C.gold, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 },
  badge: (color, bg) => ({ display: 'inline-block', fontSize: 11, padding: '2px 8px', borderRadius: 99, fontWeight: 600, color, background: bg }),
  ball: (hit) => ({ width: 44, height: 44, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 800, background: hit === true ? C.gold : hit === false ? C.grayLight : C.goldBg, color: hit === true ? '#FFF' : hit === false ? C.gray : C.gold, border: `2px solid ${hit === true ? C.gold : hit === false ? C.border : C.goldLight}`, boxShadow: hit === true ? `0 2px 8px ${C.goldLight}` : 'none' }),
  randomBall: () => ({ width: 44, height: 44, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 800, background: C.purpleBg, color: C.purple, border: `2px solid ${C.purpleLight}` }),
  statRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.border}` },
  statLabel: { fontSize: 13, color: C.textSub },
  statValue: { fontSize: 14, fontWeight: 700, color: C.text },
  bigNum: { fontSize: 32, fontWeight: 900, color: C.gold },
  btn: (disabled) => ({ background: disabled ? C.grayLight : `linear-gradient(135deg, ${C.gold}, ${C.orange})`, color: disabled ? C.gray : '#FFF', border: 'none', borderRadius: 10, padding: '11px 20px', fontSize: 14, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', boxShadow: disabled ? 'none' : C.shadow, width: '100%', marginTop: 8 }),
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
function RandomBall({ n }) { return <div style={S.randomBall()}>{padNum(n)}</div>; }
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

function RandomGroupsCard({ drawNo }) {
  const [randomGroups] = useState(() => buildRandomGroups4());
  return (
    <Card title="本期參考" icon="🎲" right={<span style={S.badge(C.purple, C.purpleBg)}>純隨機參考</span>}>
      <div style={{ background: C.purpleBg, border: `1.5px solid ${C.purpleLight}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>⏸️ 冷場期，AI暫停出號</div>
        <div style={{ fontSize: 11, color: C.purple, opacity: 0.8, marginTop: 3 }}>當期號碼不足，以下為純隨機號碼供參考，不納入AI命中統計</div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={S.badge(C.textSub, C.grayLight)}>期號 {fmt(drawNo)}</span>
        <span style={S.badge(C.purple, C.purpleBg)}>4 組</span>
      </div>
      {randomGroups.map((g, idx) => (
        <div key={g.key} style={{ background: C.purpleBg, border: `2px solid ${C.purpleLight}`, borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.purple, marginBottom: 8 }}>第{idx + 1}組｜🎲 隨機</div>
          <div style={{ display: 'flex', gap: 8 }}>{g.nums.map(n => <RandomBall key={n} n={n} />)}</div>
        </div>
      ))}
      <div style={{ fontSize: 11, color: C.textSub, textAlign: 'center', marginTop: 4 }}>⚠️ 隨機號碼僅供娛樂參考，不代表AI推薦</div>
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
  const forcedSwitch = groups[0]?.meta?.forced_switch === true;
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

  // ★ 連續未中計算（SQL28：連續2-3期未中命中率20%+）
  let consecutiveZero = 0;
  for (const r of recentRows) {
    if (toNum(r?.hit_count, -1) === 0) consecutiveZero++;
    else break;
  }

  // ★ 號碼區間分布（SQL27：61-80和21-40命中率17-20%）
  const hotPool = (groups[0]?.meta?.hot_pool || '').split(',').map(Number).filter(Boolean);
  const zone1 = hotPool.filter(n => n >= 1 && n <= 20).length;
  const zone2 = hotPool.filter(n => n >= 21 && n <= 40).length;
  const zone3 = hotPool.filter(n => n >= 41 && n <= 60).length;
  const zone4 = hotPool.filter(n => n >= 61 && n <= 80).length;
  const maxZone = Math.max(zone1, zone2, zone3, zone4);
  let zoneLabel = '';
  let zoneRate = '';
  if (maxZone >= 3) {
    if (zone4 === maxZone) { zoneLabel = '高號區(61-80)'; zoneRate = '20%'; }
    else if (zone2 === maxZone) { zoneLabel = '中高號區(21-40)'; zoneRate = '17%'; }
    else if (zone3 === maxZone) { zoneLabel = '中低號區(41-60)'; zoneRate = '11%'; }
    else if (zone1 === maxZone) { zoneLabel = '低號區(1-20)'; zoneRate = '6%'; }
  }
  const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.green : C.textSub;

  const comparedDrawNumsArr = toArray(compareResult?.draw_nums);
  const drawNums = new Set(
    comparedDrawNumsArr.length > 0
      ? comparedDrawNumsArr.map(Number)
      : parseNums(latestDraw?.numbers)
  );

  const hit2Groups = detail.filter(d => toNum(d?.hit, 0) === 2).length;
  const isWarning = hit2Groups >= 3;
  // ★ 中3後下一期是強烈進場信號（SQL8：命中率23.53%）
  const isPrevHit3 = toNum(row?.hit_count, 0) === 3 ||
    toArray(prediction?.recent_3star_compared_rows)?.[1]?.hit_count >= 3;

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
  const spiderMode = groups[0]?.meta?.spider_mode || 'normal';
  const trueSignalCount = toNum(groups[0]?.meta?.true_signal_count, 0);
  const sigHighHour = groups[0]?.meta?.sig_high_hour === true;
  const sigSlowTurnover = groups[0]?.meta?.sig_slow_turnover === true;
  const sigHighZone = groups[0]?.meta?.sig_high_zone === true;
  const sigBrew4Hour = groups[0]?.meta?.sig_brew4_hour === true;
  const sigPrevHit = groups[0]?.meta?.sig_prev_hit === true;
  const totalQualified = toNum(groups[0]?.meta?.total_qualified, 0);

  // ★ 蜘蛛感知信心指數 V0611-3
  const sigConcentrated = groups[0]?.meta?.sig_concentrated === true;
  const isBrewLowPoint = groups[0]?.meta?.is_brew_low_point === true;
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
  // 有高號區號碼（命中率+）
  if (sigHighZone) {
    confidenceScore += 15;
    confidenceReasons.push(`高號區61-80(+15)`);
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
  // ★ 醞釀期第5期低谷（命中率0%）
  if (isBrewLowPoint) {
    confidenceScore -= 40;
    confidenceReasons.push(`醞釀第5期低谷(-40)`);
  }

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

      {/* ★ 預警系統 */}
      {/* ★ 綜合信心指數 */}
      {!isSkipped && !isDone && (
        <div style={{ background: confidenceLevel.bg, border: `2px solid ${confidenceLevel.border}`, borderRadius: 14, padding: '12px 16px', marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: confidenceLevel.color }}>
              {confidenceLevel.label}
            </div>
            <div style={{ fontSize: 24, fontWeight: 900, color: confidenceLevel.color }}>
              {confidenceScore}分
            </div>
          </div>
          {confidenceReasons.length > 0 && (
            <div style={{ fontSize: 11, color: confidenceLevel.color, marginTop: 6, opacity: 0.85 }}>
              {confidenceReasons.join(' · ')}
            </div>
          )}
        </div>
      )}

      {/* ★ 12-15點死亡時段警告 */}
      {isDeadHour && (
        <div style={{ background: '#FEE2E2', border: '2px solid #EF4444', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#DC2626' }}>🚫 死亡時段（12-15點）</div>
          <div style={{ fontSize: 11, color: '#DC2626', marginTop: 3 }}>命中率1.92%，系統已切換保守策略，強烈不建議下注</div>
        </div>
      )}

      {/* ★ 爆發第1期：強力進場信號 */}
      {burstNo === 1 && !isDone && !lowConfidence && (
        <div style={{ background: '#FFF9EC', border: '2px solid #F59E0B', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: '#C8860A' }}>🔥 爆發第1期！歷史命中率 15%</div>
          <div style={{ fontSize: 12, color: '#92400E', marginTop: 4 }}>四週期熱號剛進入爆發，最佳進場時機，建議下注</div>
        </div>
      )}

      {/* ★ 爆發第2期：注意 */}
      {burstNo === 2 && !isDone && !lowConfidence && (
        <div style={{ background: '#FFF7ED', border: '2px solid #FB923C', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#EA580C' }}>🔥 爆發第2期，歷史命中率 6%</div>
          <div style={{ fontSize: 12, color: '#C2410C', marginTop: 4 }}>命中率開始下滑，可小試，第3期將自動切換</div>
        </div>
      )}

      {/* ★ 醞釀期第4期以上：強力進場 */}
      {brewCount >= 7 && !isDone && !lowConfidence && (
        <div style={{ background: '#DCFCE7', border: '2px solid #16A34A', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: '#15803D' }}>🎯 醞釀連續第{brewCount}期！命中率25%+</div>
          <div style={{ fontSize: 12, color: '#166534', marginTop: 4 }}>長期醞釀，最佳進場時機，強烈建議下注</div>
        </div>
      )}
      {brewCount >= 4 && brewCount < 7 && !isDone && !lowConfidence && (
        <div style={{ background: '#F0FDF4', border: '2px solid #4ADE80', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#16A34A' }}>⚡ 醞釀連續第{brewCount}期！命中率20%</div>
          <div style={{ fontSize: 12, color: '#166534', marginTop: 4 }}>進入高命中區間，建議進場</div>
        </div>
      )}

      {/* ★ 前1期中3信號 */}
      {isPrevHit3 && !isDone && !lowConfidence && burstNo === 0 && brewCount < 4 && (
        <div style={{ background: '#FFF9EC', border: '2px solid #C8860A', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#C8860A' }}>🏆 前一期中3，本期命中率12%</div>
          <div style={{ fontSize: 12, color: '#92400E', marginTop: 4 }}>中3後繼續押，命中率高於平均</div>
        </div>
      )}

      {/* ★ 連續未中反彈信號（SQL28：連續2-3期未中命中率20%+）*/}
      {consecutiveZero >= 2 && !isDone && !lowConfidence && (
        <div style={{ background: '#EFF6FF', border: '2px solid #3B82F6', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#1D4ED8' }}>🎯 連續{consecutiveZero}期未中，命中率20%+</div>
          <div style={{ fontSize: 12, color: '#1E40AF', marginTop: 4 }}>SQL驗證連續未中後反彈，建議進場</div>
        </div>
      )}

      {/* ★ 號碼區間提示（SQL27：高號區和中高號區命中率更高）*/}
      {zoneLabel && !isDone && !lowConfidence && (
        <div style={{ background: '#F5F3FF', border: '1.5px solid #A78BFA', borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#7C3AED' }}>
            📊 本期熱號集中{zoneLabel}，歷史命中率{zoneRate}
          </div>
        </div>
      )}

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
      {isSkipped ? (
        <RandomGroupsCard drawNo={row?.source_draw_no || latestDraw?.draw_no} />
      ) : (
        <Card
          title="本期預測"
          icon={actionStyle.icon}
          right={
            isDone ? (
              <span style={S.badge(hitColor, hitColor + '18')}>
                {bestHit >= 3 ? `🏆 中${bestHit}！` : bestHit >= 2 ? `✅ 中${bestHit}` : `❌ 中${bestHit}`}
              </span>
            ) : row ? (
              <span style={S.badge(C.orange, C.orangeLight)}>等待開獎</span>
            ) : null
          }
        >
          <div style={{ background: actionStyle.bg, border: `1.5px solid ${actionStyle.border}`, borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: actionStyle.color }}>
              {actionStyle.icon} {actionStyle.label}
            </div>
            <div style={{ fontSize: 11, color: actionStyle.color, opacity: 0.8, marginTop: 2 }}>
              {lowConfidence && '12-15點低信心時段，號碼僅供參考'}
              {!lowConfidence && action === '爆發出號' && !forcedSwitch && `四週期熱號，爆發第${burstNo}期`}
              {!lowConfidence && action === '預備出號' && !forcedSwitch && `三週期持續醞釀，連續第${brewCount}期`}
              {!lowConfidence && action === '參考出號' && !forcedSwitch && '兩週期觀察號碼，謹慎參考'}
              {!lowConfidence && forcedSwitch && '爆發已過峰值，切換三週期號碼'}
            </div>
          </div>

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
                    <span style={{ fontSize: 16, fontWeight: 900, color: is3 ? C.gold : is2 ? C.green : C.gray }}>
                      {is3 ? `🏆 中${hit}` : `中${hit}`}
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

          {isDone && (
            <div style={{ background: bestHit >= 2 ? C.goldBg : C.grayLight, borderRadius: 10, padding: '12px 14px', textAlign: 'center', marginTop: 4 }}>
              <div style={{ ...S.bigNum, color: hitColor }}>
                {bestHit >= 3 ? '🏆 恭喜中3！' : bestHit >= 2 ? '✅ 中2' : '❌ 未中'}
              </div>
              <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>
                獎金：{bestHit >= 3 ? '+500元' : bestHit >= 2 ? '+50元' : '0元'} ｜ 成本：{groups.length * 25}元
              </div>
            </div>
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
          const action = allGroups[0]?.meta?.action || '';
          const position = allGroups[0]?.meta?.position || '';
          const forcedSwitch = allGroups[0]?.meta?.forced_switch === true;
          const lowConfidence = allGroups[0]?.meta?.low_confidence_hour === true;
          const actionStyle = getActionStyle(action, forcedSwitch, lowConfidence);
          const comparedDraw = toArray(compareResult?.detail)[0]?.draw_no;
          const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.green : C.gray;

          // ★ 信心分數：改用 confidenceScore 已驗證公式（與快速頁一致）
          // 直接讀取後端輸出的 sig_* 欄位，而非重新用 meta 推算
          const metaHour = row?.created_at ? (new Date(row.created_at).getUTCHours() + 8) % 24 : 0;
          const meta0 = allGroups[0]?.meta || {};
          const sigConcentrated = meta0?.sig_concentrated === true;
          const sigSlowTurnover = meta0?.sig_slow_turnover === true;
          const sigHighZone = meta0?.sig_high_zone === true;
          const sigBrew4Hour = meta0?.sig_brew4_hour === true;
          const sigPrevHit = meta0?.sig_prev_hit === true;
          const totalQualified = toNum(meta0?.total_qualified, 0);
          const isBrewLowPoint = meta0?.is_brew_low_point === true;
          const isDeadHourHist = metaHour >= 12 && metaHour <= 15;

          let histScore = 0;
          // sig_high_hour：SQL驗證方向相反，已中立化為0分（與快速頁一致，不計分）
          if (sigConcentrated) histScore += 20;       // 號碼集中(+20)
          if (sigSlowTurnover) histScore += 20;        // 換手穩定(+20)
          if (sigHighZone) histScore += 15;            // 高號區61-80(+15)
          if (sigBrew4Hour) histScore += 15;           // 醞釀期+時段(+15)
          if (sigPrevHit) histScore += 10;             // 前1期有中(+10)
          if (totalQualified < 8) histScore -= 30;     // 號碼池稀少(-30)
          if (isDeadHourHist) histScore -= 50;         // 12-15點死亡時段(-50)
          if (position === '觀察期') histScore -= 20;  // 觀察期弱信號(-20)
          if (isBrewLowPoint) histScore -= 40;         // 醞釀第5期低谷(-40)

          // ★ 等級門檻對齊快速頁（80/60/30）
          const histLevel = histScore >= 80 ? { label: '🕷️真獵物', color: '#DC2626' } :
            histScore >= 60 ? { label: '🎯建議進場', color: '#15803D' } :
            histScore >= 30 ? { label: '👀觀察等待', color: '#6B7280' } :
            { label: '⏸️不要衝', color: '#9CA3AF' };

          return (
            <div key={row?.id || idx} style={{ ...S.card, marginBottom: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.textSub }}>
                    預測 {fmt(row?.source_draw_no)} → 比對 {fmt(comparedDraw || '')}
                  </span>
                  {!isSkipped && position && (
                    <div style={{ marginTop: 3, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: actionStyle.color, background: actionStyle.bg, border: `1px solid ${actionStyle.border}`, borderRadius: 6, padding: '2px 8px', display: 'inline-block' }}>
                        {actionStyle.icon} {actionStyle.label}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 800, color: histLevel.color, background: histLevel.color + '18', borderRadius: 6, padding: '2px 8px', display: 'inline-block' }}>
                        {histLevel.label} {histScore}分
                      </span>
                    </div>
                  )}
                </div>
                {isSkipped ? (
                  <span style={{ fontSize: 12, color: C.purple }}>⏸️ 隨機參考期</span>
                ) : isDone ? (
                  <span style={{ fontSize: 15, fontWeight: 900, color: hitColor }}>
                    {bestHit >= 3 ? `🏆 中${bestHit}` : bestHit >= 2 ? `✅ 中${bestHit}` : `❌ 未中`}
                  </span>
                ) : <span style={{ fontSize: 12, color: C.orange }}>等待比對</span>}
              </div>
              {isSkipped ? (
                <div style={{ fontSize: 11, color: C.purple, background: C.purpleBg, borderRadius: 6, padding: '4px 8px', display: 'inline-block' }}>
                  🎲 該期AI暫停，無命中統計
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {groups.map((g, gIdx) => {
                    const key = String(g?.key || g?.meta?.strategy_key || gIdx);
                    const nums = parseNums(g?.nums);
                    const matchDetail = detail.find(d => String(d?.strategy_key) === key);
                    const hit = matchDetail ? toNum(matchDetail.hit, 0) : 0;
                    return (
                      <div key={key} style={{ background: hit >= 3 ? C.goldBg : hit >= 2 ? C.greenBg : C.grayLight, borderRadius: 8, padding: '4px 8px', fontSize: 12, border: `1px solid ${hit >= 3 ? C.goldLight : hit >= 2 ? '#86EFAC' : C.border}` }}>
                        {nums.map(n => padNum(n)).join(' ')}
                        {isDone && <span style={{ marginLeft: 4, fontWeight: 700, color: hit >= 2 ? C.gold : C.gray }}>中{hit}</span>}
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
  const [subTab, setSubTab] = useState('all');

  const allRows = toArray(historyRows).filter(row =>
    row?.created_at >= STATS_START_DATE && row?.status === 'compared' && toArray(row?.groups_json).length > 0
  );

  const filterByPosition = (pos) => {
    if (pos === 'all') return allRows;
    return allRows.filter(row => {
      const p = toArray(row?.groups_json)[0]?.meta?.position || '';
      return p === pos;
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

  const subTabs = [
    { key: 'all', label: '全部', icon: '📊' },
    { key: '爆發期', label: '爆發期', icon: '🔥' },
    { key: '醞釀期', label: '醞釀期', icon: '⚡' },
    { key: '觀察期', label: '觀察期', icon: '👀' },
  ];

  const currentRows = filterByPosition(subTab);
  const stats = calcStats(currentRows);
  const rateColor = stats.rate > 0.0375 ? C.green : C.orange;

  return (
    <div style={S.page}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, background: C.card, borderRadius: 12, padding: 8, boxShadow: C.shadow }}>
        {subTabs.map(t => (
          <button key={t.key} style={S.subTab(subTab === t.key)} onClick={() => setSubTab(t.key)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <Card title={`${subTabs.find(t => t.key === subTab)?.icon} ${subTabs.find(t => t.key === subTab)?.label} 命中率`} icon="">
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
      <div style={{ fontSize: 11, color: C.textSub, textAlign: 'center', padding: '4px 0' }}>
        ※ 統計數據從 6/8 起算（v35新版）
      </div>
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
                      width: 40, height: 40, borderRadius: '50%',
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
  const spiderMode = meta0?.spider_mode || '';
  const forcedSwitch = meta0?.forced_switch === true;
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
                  width: 44, height: 44, borderRadius: '50%',
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
              共 {hotPool.length} 顆；AI會優先從這個池子裡組合出3星預測。
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
            <div style={S.headerTitle}>🏆 富緯賓果 AI V0612-3</div>
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
