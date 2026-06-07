import React, { useCallback, useEffect, useRef, useState } from 'react';

const RAILWAY_URL = 'https://fuwei-bingo-backend-production.up.railway.app';
const REFRESH_INTERVAL_MS = 30000;
const NIGHT_STOP_START = 0;
const NIGHT_STOP_END = 7 * 60;

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
  return m >= NIGHT_STOP_START && m < NIGHT_STOP_END;
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

// 根據 action 決定顯示樣式
function getActionStyle(action) {
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
  const groups = allGroups.slice(0, 20);
  const isDone = row?.compare_status === 'done';
  const bestHit = toNum(row?.hit_count, 0);
  const latestDraw = toArray(recent20)[0];
  const isSkipped = !row || row?.status === 'skipped' || allGroups.length === 0;
  const action = groups[0]?.meta?.action || '出號';
  const actionStyle = getActionStyle(action);
  const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.green : C.textSub;

  // 球高亮：優先用比對期開獎號碼
  const comparedDrawNumsArr = toArray(compareResult?.draw_nums);
  const drawNums = new Set(
    comparedDrawNumsArr.length > 0 ? comparedDrawNumsArr : parseNums(latestDraw?.numbers)
  );

  // 預警：多組中2
  const hit2Groups = detail.filter(d => toNum(d?.hit, 0) === 2).length;
  const isWarning = hit2Groups >= 3;

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

      {/* 預警 */}
      {isWarning && (
        <div style={{ background: '#FEF3C7', border: '2px solid #F59E0B', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#D97706' }}>⚡ 預警：準備爆發！</div>
          <div style={{ fontSize: 12, color: '#92400E', marginTop: 4 }}>本期有 {hit2Groups} 組中2，下期爆發機率高</div>
        </div>
      )}

      {/* 本期預測 or 隨機參考 */}
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
          {/* 狀態標示 */}
          <div style={{ background: actionStyle.bg, border: `1.5px solid ${actionStyle.border}`, borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: actionStyle.color }}>
              {actionStyle.icon} {actionStyle.label}
            </div>
            <div style={{ fontSize: 11, color: actionStyle.color, opacity: 0.8, marginTop: 2 }}>
              {action === '爆發出號' && '四週期穩定熱號，最強信號'}
              {action === '預備出號' && '三週期持續出現，即將爆發'}
              {action === '參考出號' && '兩週期觀察號碼，謹慎參考'}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={S.badge(C.textSub, C.grayLight)}>
              {isDone && detail.length > 0 ? `比對期號 ${fmt(detail[0]?.draw_no)}` : `預測期號 ${fmt(toNum(row?.source_draw_no, 0) + 1)}`}
            </span>
            <span style={S.badge(C.teal, C.greenBg)}>
              {allGroups.length <= 20 ? `${allGroups.length} 組` : `顯示 ${groups.length}/${allGroups.length} 組`}
            </span>
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
          const groups = allGroups.slice(0, 20);
          const bestHit = toNum(row?.hit_count, 0);
          const isDone = row?.compare_status === 'done';
          const isSkipped = row?.status === 'skipped' || allGroups.length === 0;
          const action = allGroups[0]?.meta?.action || '';
          const actionStyle = getActionStyle(action);
          const comparedDraw = toArray(compareResult?.detail)[0]?.draw_no;
          const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.green : C.gray;

          return (
            <div key={row?.id || idx} style={{ ...S.card, marginBottom: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.textSub }}>
                  {actionStyle.icon} 預測 {fmt(row?.source_draw_no)} → 比對 {fmt(comparedDraw || '')}
                </span>
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

function StatsPage({ strategyStats }) {
  const stats = toArray(strategyStats);
  const totalRounds = stats.reduce((a, s) => a + toNum(s.total_rounds), 0);
  const totalHit3 = stats.reduce((a, s) => a + toNum(s.hit3), 0);
  const overallRate = totalRounds > 0 ? totalHit3 / totalRounds : 0;
  return (
    <div style={S.page}>
      <Card title="整體命中率" icon="📊">
        <div style={{ textAlign: 'center', padding: '10px 0' }}>
          <div style={S.bigNum}>{fmtPercent(overallRate)}</div>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>共 {totalRounds} 組｜中3：{totalHit3} 次</div>
        </div>
        <div style={S.divider} />
        <StatRow label="理論值（隨機）" value="3.75%" valueColor={C.textSub} />
        <StatRow label="目前命中率" value={fmtPercent(overallRate)} valueColor={overallRate > 0.0375 ? C.green : C.orange} />
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
  const rows = toArray(recent20);
  function calcHot(periodRows) {
    const countMap = new Map();
    for (const row of periodRows) {
      for (const n of parseNums(row?.numbers)) {
        countMap.set(n, (countMap.get(n) || 0) + 1);
      }
    }
    return [...countMap.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10).map(([num, count]) => ({ num, count }));
  }
  const periods = [
    { label: '5期（短期爆發）', data: calcHot(rows.slice(0, 5)) },
    { label: '10期（趨勢延續）', data: calcHot(rows.slice(0, 10)) },
    { label: '15期（中期觀察）', data: calcHot(rows.slice(0, 15)) },
    { label: '20期（穩定底盤）', data: calcHot(rows.slice(0, 20)) },
  ];
  return (
    <div style={S.page}>
      <Card title="熱門號分析" icon="🔥">
        {!rows.length ? <div style={S.empty}>載入中...</div> : periods.map(p => (
          <div key={p.label} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: C.textSub, fontWeight: 600, marginBottom: 8 }}>{p.label}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {p.data.map(({ num, count }) => (
                <div key={num} style={{ textAlign: 'center' }}>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: C.goldBg, border: `2px solid ${C.goldLight}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800, color: C.gold }}>
                    {padNum(num)}
                  </div>
                  <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>{count}</div>
                </div>
              ))}
            </div>
            <div style={S.divider} />
          </div>
        ))}
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
  const [strategyStats, setStrategyStats] = useState([]);
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
    apiFetch('/api/strategy-stats').then(res => {
      if (res?.ok && Array.isArray(res.data)) setStrategyStats(res.data);
    }).catch(() => {});
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
  ];

  return (
    <div style={S.app}>
      <div style={S.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={S.headerTitle}>🏆 富緯賓果 AI</div>
            <div style={S.headerSub}>{loopStatus}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', marginTop: 2 }}>
              {new Date().toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </div>
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
      {tab === 'stats' && <StatsPage strategyStats={strategyStats} />}
      {tab === 'market' && <MarketPage recent20={recent20} />}
      {tab === 'hot' && <HotPage recent20={recent20} />}
    </div>
  );
}
