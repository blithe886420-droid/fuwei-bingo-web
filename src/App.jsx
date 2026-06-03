import React, { useCallback, useEffect, useRef, useState } from 'react';

// ── 常數 ─────────────────────────────────────────
const RAILWAY_URL = 'https://fuwei-bingo-backend-production.up.railway.app';

const REFRESH_INTERVAL_MS = 30000;
const NIGHT_STOP_START = 0;
const NIGHT_STOP_END = 7 * 60;

// ── 工具函數 ──────────────────────────────────────
function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

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

function getNowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function isNight() {
  const m = getNowMinutes();
  return m >= NIGHT_STOP_START && m < NIGHT_STOP_END;
}

function padNum(n) {
  return String(Number(n)).padStart(2, '0');
}

function zoneLabel(key) {
  const map = { zone_1:'1-10', zone_2:'11-20', zone_3:'21-30', zone_4:'31-40', zone_5:'41-50', zone_6:'51-60', zone_7:'61-70', zone_8:'71-80' };
  return map[key] || key;
}

// ── API ───────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(`${RAILWAY_URL}${path}`, { cache: 'no-store', ...options });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ── 色彩系統 ──────────────────────────────────────
const C = {
  bg: '#FFF8F0',
  card: '#FFFFFF',
  gold: '#C8860A',
  goldLight: '#F5D78B',
  goldBg: '#FFF9EC',
  orange: '#E8722A',
  orangeLight: '#FDE8D8',
  red: '#DC2626',
  redBg: '#FEF2F2',
  green: '#16A34A',
  greenBg: '#F0FDF4',
  teal: '#0F766E',
  blue: '#1D4ED8',
  gray: '#6B7280',
  grayLight: '#F3F4F6',
  border: '#E5DDD0',
  text: '#2C1810',
  textSub: '#7B6E5C',
  shadow: '0 2px 12px rgba(200,134,10,0.10)',
  shadowHover: '0 4px 20px rgba(200,134,10,0.18)',
};

// ── 樣式 ──────────────────────────────────────────
const S = {
  app: {
    minHeight: '100vh',
    background: C.bg,
    fontFamily: '"Segoe UI", "PingFang TC", "Noto Sans TC", sans-serif',
    color: C.text,
    paddingBottom: 80,
  },
  header: {
    background: `linear-gradient(135deg, ${C.gold} 0%, ${C.orange} 100%)`,
    padding: '18px 20px 14px',
    boxShadow: '0 2px 16px rgba(200,134,10,0.25)',
  },
  headerTitle: {
    fontSize: 22, fontWeight: 900, color: '#FFF', letterSpacing: 2, margin: 0,
    textShadow: '0 1px 4px rgba(0,0,0,0.2)',
  },
  headerSub: {
    fontSize: 12, color: 'rgba(255,255,255,0.85)', marginTop: 3,
  },
  tabs: {
    display: 'flex', background: C.card, borderBottom: `2px solid ${C.border}`,
    position: 'sticky', top: 0, zIndex: 100, boxShadow: '0 2px 8px rgba(200,134,10,0.08)',
  },
  tab: (active) => ({
    flex: 1, padding: '10px 2px 8px', border: 'none', background: 'transparent',
    cursor: 'pointer', fontSize: 11, fontWeight: active ? 700 : 400,
    color: active ? C.gold : C.gray,
    borderBottom: active ? `3px solid ${C.gold}` : '3px solid transparent',
    transition: 'all 0.2s',
  }),
  page: { padding: '16px 14px', maxWidth: 600, margin: '0 auto' },
  card: {
    background: C.card, borderRadius: 16, padding: '16px 16px 14px',
    marginBottom: 14, boxShadow: C.shadow, border: `1px solid ${C.border}`,
  },
  cardTitle: {
    fontSize: 14, fontWeight: 700, color: C.gold, marginBottom: 10, display: 'flex',
    alignItems: 'center', gap: 6,
  },
  badge: (color, bg) => ({
    display: 'inline-block', fontSize: 11, padding: '2px 8px', borderRadius: 99,
    fontWeight: 600, color: color, background: bg,
  }),
  ball: (hit) => ({
    width: 44, height: 44, borderRadius: '50%', display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 15, fontWeight: 800,
    background: hit === true ? C.gold : hit === false ? C.grayLight : C.goldBg,
    color: hit === true ? '#FFF' : hit === false ? C.gray : C.gold,
    border: `2px solid ${hit === true ? C.gold : hit === false ? C.border : C.goldLight}`,
    boxShadow: hit === true ? `0 2px 8px ${C.goldLight}` : 'none',
    transition: 'all 0.2s',
  }),
  groupCard: (hit3) => ({
    background: hit3 ? C.goldBg : C.grayLight,
    border: `2px solid ${hit3 ? C.goldLight : C.border}`,
    borderRadius: 12, padding: '12px 14px', marginBottom: 10,
  }),
  statusBar: (color) => ({
    background: color + '22', border: `1.5px solid ${color}44`,
    borderRadius: 10, padding: '10px 14px', marginBottom: 10,
    display: 'flex', alignItems: 'center', gap: 10,
  }),
  dot: (color) => ({
    width: 10, height: 10, borderRadius: '50%', background: color,
    boxShadow: `0 0 6px ${color}`, flexShrink: 0,
  }),
  statRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 0', borderBottom: `1px solid ${C.border}`,
  },
  statLabel: { fontSize: 13, color: C.textSub },
  statValue: { fontSize: 14, fontWeight: 700, color: C.text },
  bigNum: { fontSize: 32, fontWeight: 900, color: C.gold },
  btn: (disabled) => ({
    background: disabled ? C.grayLight : `linear-gradient(135deg, ${C.gold}, ${C.orange})`,
    color: disabled ? C.gray : '#FFF',
    border: 'none', borderRadius: 10, padding: '11px 20px',
    fontSize: 14, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
    boxShadow: disabled ? 'none' : C.shadow, transition: 'all 0.2s',
    width: '100%', marginTop: 8,
  }),
  divider: { height: 1, background: C.border, margin: '10px 0' },
  empty: { color: C.textSub, fontSize: 13, padding: '12px 0', textAlign: 'center' },
  recentBall: (isHot) => ({
    width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 12, fontWeight: 700,
    background: isHot ? C.orange : C.grayLight,
    color: isHot ? '#FFF' : C.textSub,
  }),
};

// ── 元件 ──────────────────────────────────────────
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

function Ball({ n, hit }) {
  return <div style={S.ball(hit)}>{padNum(n)}</div>;
}

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
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        border: `3px solid ${C.goldLight}`, borderTopColor: C.gold,
        animation: 'spin 0.8s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── 頁面：快速 ────────────────────────────────────
function QuickPage({ prediction, aiPlayer, recent20, onRefresh, loading }) {
  const row = prediction?.latest_3star_row;
  const compareResult = safeJson(row?.compare_result_json) || safeJson(row?.compare_result);
  const detail = toArray(compareResult?.detail);
  const groups = toArray(row?.groups_json);
  const isDone = row?.compare_status === 'done';
  const bestHit = toNum(row?.hit_count, 0);
  const latestDraw = toArray(recent20)[0];
  const drawNums = new Set(parseNums(latestDraw?.numbers));

  const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.green : C.textSub;

  return (
    <div style={S.page}>
      {/* 最新一期 */}
      <Card title="最新開獎" icon="🎱">
        {latestDraw ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={S.statLabel}>期號 {fmt(latestDraw?.draw_no)}</span>
              <span style={S.statLabel}>{fmt(latestDraw?.draw_time)}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {parseNums(latestDraw?.numbers).sort((a,b)=>a-b).map(n => (
                <div key={n} style={S.recentBall(false)}>{padNum(n)}</div>
              ))}
            </div>
          </>
        ) : <div style={S.empty}>載入中...</div>}
      </Card>

      {/* 本期預測 */}
      <Card
        title="本期預測"
        icon="⭐"
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
        {!row ? (
          <div style={S.empty}>尚無預測資料，等待自動產生中...</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={S.badge(C.textSub, C.grayLight)}>期號 {fmt(row?.source_draw_no)}</span>
              <span style={S.badge(C.teal, C.greenBg)}>{groups.length} 組</span>
              {isDone && (
                <span style={S.badge(bestHit >= 2 ? C.green : C.gray, bestHit >= 2 ? C.greenBg : C.grayLight)}>
                  已比對
                </span>
              )}
            </div>

            {groups.map((g, idx) => {
              const nums = parseNums(g?.nums);
              const key = String(g?.key || g?.meta?.strategy_key || idx);
              const matchDetail = detail.find(d => String(d?.strategy_key) === key);
              const hit = matchDetail ? toNum(matchDetail.hit, -1) : -1;
              const is3 = hit >= 3;
              const is2 = hit === 2;

              return (
                <div key={key} style={S.groupCard(is3)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.textSub }}>
                      第{idx+1}組｜區段 {zoneLabel(key)}
                    </div>
                    {isDone && hit >= 0 && (
                      <span style={{ fontSize: 16, fontWeight: 900, color: is3 ? C.gold : is2 ? C.green : C.gray }}>
                        {is3 ? `🏆 中${hit}` : `中${hit}`}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {nums.map(n => {
                      const isHit = isDone && matchDetail && drawNums.has(n);
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
          </>
        )}
      </Card>

      {/* 刷新按鈕 */}
      <button style={S.btn(loading)} onClick={onRefresh} disabled={loading}>
        {loading ? '更新中...' : '🔄 刷新資料'}
      </button>
    </div>
  );
}

// ── 頁面：近期回顧 ────────────────────────────────
function HistoryPage({ historyRows }) {
  const rows = toArray(historyRows).slice(0, 20);

  return (
    <div style={S.page}>
      <Card title="近期命中紀錄" icon="📋">
        {!rows.length ? (
          <div style={S.empty}>尚無比對紀錄</div>
        ) : rows.map((row, idx) => {
          const compareResult = safeJson(row?.compare_result_json) || safeJson(row?.compare_result);
          const detail = toArray(compareResult?.detail);
          const groups = toArray(row?.groups_json);
          const bestHit = toNum(row?.hit_count, 0);
          const isDone = row?.compare_status === 'done';
          const hitColor = bestHit >= 3 ? C.gold : bestHit >= 2 ? C.green : C.gray;

          return (
            <div key={row?.id || idx} style={{ ...S.card, marginBottom: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.textSub }}>
                  期號 {fmt(row?.source_draw_no)}
                </span>
                {isDone && (
                  <span style={{ fontSize: 15, fontWeight: 900, color: hitColor }}>
                    {bestHit >= 3 ? `🏆 中${bestHit}` : bestHit >= 2 ? `✅ 中${bestHit}` : `❌ 未中`}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {groups.map((g, gIdx) => {
                  const key = String(g?.key || g?.meta?.strategy_key || gIdx);
                  const nums = parseNums(g?.nums);
                  const matchDetail = detail.find(d => String(d?.strategy_key) === key);
                  const hit = matchDetail ? toNum(matchDetail.hit, 0) : 0;
                  return (
                    <div key={key} style={{
                      background: hit >= 3 ? C.goldBg : hit >= 2 ? C.greenBg : C.grayLight,
                      borderRadius: 8, padding: '4px 8px', fontSize: 12,
                      border: `1px solid ${hit >= 3 ? C.goldLight : hit >= 2 ? '#86EFAC' : C.border}`,
                    }}>
                      <span style={{ color: C.textSub, marginRight: 4 }}>{zoneLabel(key)}</span>
                      {nums.map(n => padNum(n)).join(' ')}
                      {isDone && <span style={{ marginLeft: 4, fontWeight: 700, color: hit >= 2 ? C.gold : C.gray }}>中{hit}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ── 頁面：統計 ────────────────────────────────────
function StatsPage({ strategyStats, prediction }) {
  const stats = toArray(strategyStats);
  const totalRounds = stats.reduce((a, s) => a + toNum(s.total_rounds), 0);
  const totalHit3 = stats.reduce((a, s) => a + toNum(s.hit3), 0);
  const overallRate = totalRounds > 0 ? totalHit3 / totalRounds : 0;

  return (
    <div style={S.page}>
      {/* 整體命中率 */}
      <Card title="整體命中率" icon="📊">
        <div style={{ textAlign: 'center', padding: '10px 0' }}>
          <div style={S.bigNum}>{fmtPercent(overallRate)}</div>
          <div style={{ fontSize: 12, color: C.textSub, marginTop: 4 }}>
            共 {totalRounds} 組｜中3：{totalHit3} 次
          </div>
        </div>
        <div style={S.divider} />
        <StatRow label="理論值（隨機）" value="3.75%" valueColor={C.textSub} />
        <StatRow label="目前命中率" value={fmtPercent(overallRate)} valueColor={overallRate > 0.0375 ? C.green : C.orange} />
      </Card>

      {/* 各區段統計 */}
      <Card title="各區段統計" icon="🗂️">
        {!stats.length ? (
          <div style={S.empty}>累積數據中，請稍候...</div>
        ) : stats.sort((a,b) => toNum(b.hit3) - toNum(a.hit3)).map(s => {
          const rounds = toNum(s.total_rounds);
          const hit3 = toNum(s.hit3);
          const rate = rounds > 0 ? hit3 / rounds : 0;
          return (
            <div key={s.strategy_key} style={S.statRow}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{s.strategy_key}</div>
                <div style={{ fontSize: 11, color: C.textSub }}>{rounds} 組｜中3：{hit3} 次</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: rate > 0.0375 ? C.green : C.textSub }}>
                  {fmtPercent(rate)}
                </div>
                <div style={{ fontSize: 11, color: C.textSub }}>ROI: {fmtPercent(toNum(s.roi))}</div>
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ── 頁面：開獎回顧 ────────────────────────────────
function MarketPage({ recent20 }) {
  const rows = toArray(recent20).slice(0, 20);

  return (
    <div style={S.page}>
      <Card title="最近20期開獎" icon="🎯">
        {!rows.length ? (
          <div style={S.empty}>載入中...</div>
        ) : rows.map((row, idx) => {
          const nums = parseNums(row?.numbers).sort((a,b)=>a-b);
          return (
            <div key={row?.draw_no || idx} style={{ ...S.statRow, alignItems: 'flex-start', paddingTop: 10, paddingBottom: 10 }}>
              <div style={{ minWidth: 80 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>#{fmt(row?.draw_no)}</div>
                <div style={{ fontSize: 11, color: C.textSub }}>{fmt(row?.draw_time)?.slice(11,16)}</div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 }}>
                {nums.map(n => (
                  <div key={n} style={{ ...S.recentBall(false), width: 28, height: 28, fontSize: 11 }}>{padNum(n)}</div>
                ))}
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}


// ── 頁面：熱號分析 ────────────────────────────────
function HotPage({ recent20 }) {
  const rows = toArray(recent20);

  function calcHot(periodRows) {
    const countMap = new Map();
    for (const row of periodRows) {
      const nums = parseNums(row?.numbers);
      for (const n of nums) {
        countMap.set(n, (countMap.get(n) || 0) + 1);
      }
    }
    return [...countMap.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 10)
      .map(([num, count]) => ({ num, count }));
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
        {!rows.length ? (
          <div style={S.empty}>載入中...</div>
        ) : periods.map(p => (
          <div key={p.label} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: C.textSub, fontWeight: 600, marginBottom: 8 }}>
              {p.label}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {p.data.map(({ num, count }) => (
                <div key={num} style={{ textAlign: 'center' }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: '50%',
                    background: C.goldBg, border: `2px solid ${C.goldLight}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, fontWeight: 800, color: C.gold,
                  }}>
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

// ── 主 APP ────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState('quick');
  const [loading, setLoading] = useState(false);
  const [prediction, setPrediction] = useState(null);
  const [aiPlayer, setAiPlayer] = useState(null);
  const [recent20, setRecent20] = useState([]);
  const [historyRows, setHistoryRows] = useState([]);
  const [strategyStats, setStrategyStats] = useState([]);
  const [loopStatus, setLoopStatus] = useState('初始化中...');
  const timerRef = useRef(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [predRes, aiRes, recentRes] = await Promise.all([
        apiFetch('/api/prediction-latest').catch(() => ({})),
        apiFetch('/api/ai-player').catch(() => ({})),
        apiFetch('/api/recent20').catch(() => ({})),
      ]);

      setPrediction(predRes);
      setAiPlayer(aiRes);

      const rows = predRes?.recent_3star_compared_rows || predRes?.recent_compared_rows || [];
      setHistoryRows(rows);

      const recentRows = recentRes?.recent20 || recentRes?.data || [];
      setRecent20(recentRows);

      setLoopStatus(isNight() ? '夜間停止（00:00-07:00）' : `已更新 ${new Date().toLocaleTimeString('zh-TW', {hour12:false})}`);
    } catch (e) {
      setLoopStatus('載入失敗，稍後重試');
    } finally {
      setLoading(false);
    }
  }, []);

  // 載入策略統計
  useEffect(() => {
    const loadStats = async () => {
      try {
        const res = await apiFetch('/api/strategy-stats');
        if (res?.ok && Array.isArray(res.data) && res.data.length) {
          setStrategyStats(res.data);
        }
      } catch {}
    };
    loadStats();
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
      {/* Header */}
      <div style={S.header}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={S.headerTitle}>🏆 富緯賓果 AI</div>
            <div style={S.headerSub}>{loopStatus}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            {aiPlayer?.latestDrawNo && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', fontWeight: 600 }}>
                最新期 {fmt(aiPlayer.latestDrawNo)}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', marginTop: 2 }}>
              {new Date().toLocaleString('zh-TW', { hour12: false, month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {TABS.map(t => (
          <button key={t.key} style={S.tab(tab === t.key)} onClick={() => setTab(t.key)}>
            <div>{t.icon}</div>
            <div>{t.label}</div>
          </button>
        ))}
      </div>

      {/* Content */}
      {loading && tab === 'quick' && <Spinner />}

      {tab === 'quick' && (
        <QuickPage
          prediction={prediction}
          aiPlayer={aiPlayer}
          recent20={recent20}
          onRefresh={loadData}
          loading={loading}
        />
      )}
      {tab === 'history' && <HistoryPage historyRows={historyRows} />}
      {tab === 'stats' && <StatsPage strategyStats={strategyStats} prediction={prediction} />}
      {tab === 'market' && <MarketPage recent20={recent20} />}
      {tab === 'hot' && <HotPage recent20={recent20} />}
    </div>
  );
}
