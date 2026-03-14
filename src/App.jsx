import React, { useCallback, useEffect, useMemo, useState } from 'react';

const TABS = {
  DASHBOARD: 'dashboard',
  PREDICT: 'predict',
  MARKET: 'market'
};

const TAB_ITEMS = [
  { key: TABS.DASHBOARD, label: 'AI狀態', icon: '🏠' },
  { key: TABS.PREDICT, label: '預測下注', icon: '🎯' },
  { key: TABS.MARKET, label: '市場資料', icon: '📊' }
];

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmtPercent(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${n.toFixed(digits)}%`;
}

function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `NT$ ${n.toLocaleString()}`;
}

function fmtText(v, fallback = '--') {
  if (v === null || v === undefined || v === '') return fallback;
  return String(v);
}

function fmtDateTime(v) {
  if (!v) return '--';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('zh-TW', {
    hour12: false
  });
}

function parseNums(input) {
  if (Array.isArray(input)) {
    return input.map(Number).filter(Number.isFinite);
  }
  if (typeof input === 'string') {
    return input
      .split(/[,\s]+/)
      .map((x) => Number(x.trim()))
      .filter(Number.isFinite);
  }
  return [];
}

function getRecentRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.recent20)) return data.recent20;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function getPredictionGroups(row) {
  const groups =
    row?.groups_json ||
    row?.groups ||
    row?.strategies ||
    row?.prediction_groups ||
    [];
  return Array.isArray(groups) ? groups : [];
}

function groupTitle(group, idx) {
  return (
    group?.label ||
    group?.name ||
    group?.strategy_name ||
    group?.key ||
    `第${idx + 1}組`
  );
}

function groupReason(group) {
  return group?.reason || group?.meta?.strategy_name || group?.meta?.strategy_key || '--';
}

function safeFetchJson(url, options) {
  return fetch(url, options).then(async (res) => {
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      throw new Error(json?.error || json?.message || `${url} ${res.status}`);
    }

    return json;
  });
}

function calcSimpleAiStatus(trainingPrediction, leaderboard) {
  const lb = toArray(leaderboard);
  const active = lb.length;

  const roiValues = lb
    .map((x) => Number(x?.recent_50_roi ?? x?.roi))
    .filter(Number.isFinite);

  const avgHitValues = lb
    .map((x) => Number(x?.avg_hit))
    .filter(Number.isFinite);

  const topScore = Number(lb?.[0]?.score);
  const bestRoi = roiValues.length ? Math.max(...roiValues) : null;
  const avgRoi = roiValues.length
    ? roiValues.reduce((a, b) => a + b, 0) / roiValues.length
    : null;
  const avgHit = avgHitValues.length
    ? avgHitValues.reduce((a, b) => a + b, 0) / avgHitValues.length
    : null;

  let confidence = 50;

  if (Number.isFinite(avgRoi)) {
    if (avgRoi >= 10) confidence += 20;
    else if (avgRoi >= 0) confidence += 10;
    else if (avgRoi <= -20) confidence -= 15;
    else if (avgRoi < 0) confidence -= 8;
  }

  if (Number.isFinite(avgHit)) {
    if (avgHit >= 2) confidence += 18;
    else if (avgHit >= 1.5) confidence += 10;
    else if (avgHit < 1) confidence -= 10;
  }

  if (active >= 10) confidence += 5;
  if (Number.isFinite(topScore) && topScore > 0) confidence += 5;

  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  let advice = '觀望';
  let adviceColor = '#f59e0b';

  if (confidence >= 70) {
    advice = '可下注';
    adviceColor = '#16a34a';
  } else if (confidence <= 40) {
    advice = '先觀望';
    adviceColor = '#dc2626';
  }

  return {
    confidence,
    advice,
    adviceColor,
    activeStrategies: active,
    avgRoi,
    bestRoi,
    avgHit,
    latestTrainingMode: trainingPrediction?.mode || '--'
  };
}

function getPredictionLatestRow(data, preferMode) {
  const rows = [
    data?.row,
    ...(Array.isArray(data?.rows) ? data.rows : []),
    ...(Array.isArray(data?.predictions) ? data.predictions : []),
    ...(Array.isArray(data?.data) ? data.data : [])
  ].filter(Boolean);

  if (!rows.length) return null;

  if (preferMode) {
    const found = rows.find((r) => String(r?.mode || '').includes(preferMode));
    if (found) return found;
  }

  return rows[0];
}

function Card({ title, subtitle, right, children }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div>
          <div style={styles.cardTitle}>{title}</div>
          {subtitle ? <div style={styles.cardSubtitle}>{subtitle}</div> : null}
        </div>
        {right ? <div>{right}</div> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function StatBox({ label, value, hint, valueStyle }) {
  return (
    <div style={styles.statBox}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, ...valueStyle }}>{value}</div>
      {hint ? <div style={styles.statHint}>{hint}</div> : null}
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState(TABS.DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');

  const [recent20, setRecent20] = useState([]);
  const [trainingLatest, setTrainingLatest] = useState(null);
  const [formalLatest, setFormalLatest] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [autoTrainEnabled, setAutoTrainEnabled] = useState(false);
  const [autoTrainResult, setAutoTrainResult] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [recentRes, predictionRes, configRes] = await Promise.all([
        safeFetchJson('/api/recent20'),
        safeFetchJson('/api/prediction-latest').catch(() => ({})),
        safeFetchJson('/api/system-config').catch(() => ({}))
      ]);

      const recentRows = getRecentRows(recentRes);
      setRecent20(recentRows);

      const trainingRow =
        getPredictionLatestRow(
          {
            rows: toArray(predictionRes?.rows).filter((r) =>
              String(r?.mode || '').includes('ai_train') ||
              String(r?.mode || '').includes('test')
            )
          },
          'ai_train'
        ) ||
        getPredictionLatestRow(
          {
            rows: toArray(predictionRes?.rows).filter((r) =>
              String(r?.mode || '').includes('test')
            )
          },
          'test'
        );

      const formalRow =
        getPredictionLatestRow(
          {
            rows: toArray(predictionRes?.rows).filter((r) =>
              String(r?.mode || '').includes('formal')
            )
          },
          'formal'
        ) || null;

      setTrainingLatest(trainingRow || predictionRes?.training || null);
      setFormalLatest(formalRow || predictionRes?.formal || null);

      const cfgRows = toArray(configRes?.rows || configRes?.data || []);
      const autoCfg = cfgRows.find((r) => r?.key === 'auto_train_enabled');
      setAutoTrainEnabled(String(autoCfg?.value || 'false') === 'true');

      const lb =
        predictionRes?.leaderboard ||
        predictionRes?.auto_train_result?.leaderboard ||
        [];
      setLeaderboard(toArray(lb));

      if (predictionRes?.auto_train_result) {
        setAutoTrainResult(predictionRes.auto_train_result);
      }
    } catch (err) {
      setError(err.message || '讀取資料失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const runAction = useCallback(
    async (key, fn) => {
      try {
        setBusyKey(key);
        setError('');
        await fn();
        await loadAll();
      } catch (err) {
        setError(err.message || '操作失敗');
      } finally {
        setBusyKey('');
      }
    },
    [loadAll]
  );

  const handleToggleAutoTrain = async () => {
    await runAction('toggleAutoTrain', async () => {
      await safeFetchJson('/api/system-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'auto_train_enabled',
          value: autoTrainEnabled ? 'false' : 'true'
        })
      });
    });
  };

  const handleRunAutoTrain = async () => {
    await runAction('autoTrain', async () => {
      const data = await safeFetchJson('/api/auto-train', {
        method: 'POST'
      });
      setAutoTrainResult(data);
    });
  };

  const handleSync = async () => {
    await runAction('sync', async () => {
      await safeFetchJson('/api/sync', { method: 'POST' }).catch(async () => {
        await safeFetchJson('/api/sync');
      });
    });
  };

  const handleCatchup = async () => {
    await runAction('catchup', async () => {
      await safeFetchJson('/api/catchup', { method: 'POST' }).catch(async () => {
        await safeFetchJson('/api/catchup');
      });
    });
  };

  const handleFormalBet = async () => {
    await runAction('formalBet', async () => {
      await safeFetchJson('/api/prediction-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'formal_synced_from_server_prediction',
          targetPeriods: 4
        })
      });
    });
  };

  const aiStatus = useMemo(
    () => calcSimpleAiStatus(trainingLatest, leaderboard),
    [trainingLatest, leaderboard]
  );

  const latestDraw = recent20[0] || null;
  const latestDrawNo = latestDraw?.draw_no || latestDraw?.drawNo || '--';
  const latestDrawTime = latestDraw?.draw_time || latestDraw?.drawTime || '--';
  const latestNumbers = parseNums(latestDraw?.numbers || latestDraw?.nums || []);

  const trainingGroups = getPredictionGroups(trainingLatest);
  const formalGroups = getPredictionGroups(formalLatest);

  return (
    <div style={styles.page}>
      <div style={styles.app}>
        <header style={styles.header}>
          <div>
            <div style={styles.brand}>FUWEI BINGO AI</div>
            <div style={styles.headerSub}>把頁面整理乾淨，讓 AI 做 AI 的事。</div>
          </div>

          <div style={styles.headerActions}>
            <button
              style={styles.secondaryButton}
              onClick={loadAll}
              disabled={busyKey !== ''}
            >
              重新整理
            </button>
          </div>
        </header>

        <nav style={styles.tabBar}>
          {TAB_ITEMS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  ...styles.tabButton,
                  ...(active ? styles.tabButtonActive : {})
                }}
              >
                <span style={styles.tabIcon}>{tab.icon}</span>
                {tab.label}
              </button>
            );
          })}
        </nav>

        {error ? (
          <div style={styles.errorBanner}>
            {error}
          </div>
        ) : null}

        {loading ? (
          <div style={styles.loading}>讀取中...</div>
        ) : null}

        {!loading && activeTab === TABS.DASHBOARD && (
          <div style={styles.sectionStack}>
            <Card
              title="AI 狀態總覽"
              subtitle="先看 AI 狀態，再決定要不要正式下注。"
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="AI 信心指數"
                  value={`${aiStatus.confidence} / 100`}
                  hint={`模式：${aiStatus.latestTrainingMode}`}
                  valueStyle={{ color: aiStatus.adviceColor }}
                />
                <StatBox
                  label="平均 ROI"
                  value={fmtPercent(aiStatus.avgRoi)}
                  hint="來自目前策略池"
                />
                <StatBox
                  label="平均命中"
                  value={
                    Number.isFinite(aiStatus.avgHit)
                      ? aiStatus.avgHit.toFixed(2)
                      : '--'
                  }
                  hint="策略池平均"
                />
                <StatBox
                  label="建議狀態"
                  value={aiStatus.advice}
                  hint={`活躍策略：${aiStatus.activeStrategies}`}
                  valueStyle={{ color: aiStatus.adviceColor }}
                />
              </div>

              <div style={styles.actionRow}>
                <button
                  style={styles.primaryButton}
                  onClick={handleFormalBet}
                  disabled={busyKey !== ''}
                >
                  {busyKey === 'formalBet' ? '建立中...' : '建立正式下注'}
                </button>

                <button
                  style={styles.secondaryButton}
                  onClick={handleRunAutoTrain}
                  disabled={busyKey !== ''}
                >
                  {busyKey === 'autoTrain' ? '訓練中...' : '執行一次 AI 自動訓練'}
                </button>
              </div>
            </Card>

            <Card
              title="系統控制"
              subtitle="這裡只留你平常真的會用到的控制項。"
            >
              <div style={styles.controlGrid}>
                <div style={styles.controlItem}>
                  <div style={styles.controlTitle}>自動訓練開關</div>
                  <div style={styles.controlText}>
                    目前狀態：
                    <span
                      style={{
                        color: autoTrainEnabled ? '#16a34a' : '#dc2626',
                        fontWeight: 800,
                        marginLeft: 6
                      }}
                    >
                      {autoTrainEnabled ? '開啟中' : '已關閉'}
                    </span>
                  </div>
                  <button
                    style={autoTrainEnabled ? styles.warnButton : styles.primaryButton}
                    onClick={handleToggleAutoTrain}
                    disabled={busyKey !== ''}
                  >
                    {busyKey === 'toggleAutoTrain'
                      ? '切換中...'
                      : autoTrainEnabled
                        ? '關閉自動訓練'
                        : '開啟自動訓練'}
                  </button>
                </div>

                <div style={styles.controlItem}>
                  <div style={styles.controlTitle}>資料同步</div>
                  <div style={styles.controlText}>同步最新開獎與補抓遺漏期數。</div>
                  <div style={styles.inlineButtons}>
                    <button
                      style={styles.secondaryButton}
                      onClick={handleSync}
                      disabled={busyKey !== ''}
                    >
                      {busyKey === 'sync' ? '同步中...' : '同步最新期數'}
                    </button>
                    <button
                      style={styles.secondaryButton}
                      onClick={handleCatchup}
                      disabled={busyKey !== ''}
                    >
                      {busyKey === 'catchup' ? '補抓中...' : '補抓期數'}
                    </button>
                  </div>
                </div>
              </div>
            </Card>

            <Card
              title="訓練摘要"
              subtitle="這塊保留重點，不再把整個訓練牆塞在首頁。"
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="最新訓練期數"
                  value={fmtText(trainingLatest?.source_draw_no)}
                  hint={`目標：${fmtText(trainingLatest?.target_periods)} 期`}
                />
                <StatBox
                  label="最佳策略分數"
                  value={fmtText(leaderboard?.[0]?.score ? Number(leaderboard[0].score).toFixed(1) : '--')}
                  hint={leaderboard?.[0]?.label || '尚無資料'}
                />
                <StatBox
                  label="最佳策略 ROI"
                  value={fmtPercent(leaderboard?.[0]?.recent_50_roi ?? leaderboard?.[0]?.roi)}
                  hint="取排行榜第一名"
                />
                <StatBox
                  label="最新開獎期數"
                  value={fmtText(latestDrawNo)}
                  hint={fmtDateTime(latestDrawTime)}
                />
              </div>

              {autoTrainResult ? (
                <div style={styles.resultPanel}>
                  <div style={styles.resultTitle}>最近一次 auto-train 結果</div>
                  <div style={styles.resultText}>
                    到期比對：{toNum(autoTrainResult?.compared_count)} 筆，
                    新建訓練：{toNum(autoTrainResult?.created_count)} 筆，
                    最佳單組命中：{toNum(autoTrainResult?.best_single_hit)}。
                  </div>
                </div>
              ) : null}
            </Card>
          </div>
        )}

        {!loading && activeTab === TABS.PREDICT && (
          <div style={styles.sectionStack}>
            <Card
              title="正式下注"
              subtitle="這裡只處理你真正要拿去買的組合。"
              right={
                <div style={styles.tag}>
                  四星賓果 / 四組 / 四期
                </div>
              }
            >
              <div style={styles.summaryLine}>
                <span>模式：</span>
                <strong>{fmtText(formalLatest?.mode, 'formal')}</strong>
                <span style={{ marginLeft: 16 }}>來源期數：</span>
                <strong>{fmtText(formalLatest?.source_draw_no)}</strong>
                <span style={{ marginLeft: 16 }}>目標期數：</span>
                <strong>{fmtText(formalLatest?.target_periods)}</strong>
              </div>

              <div style={styles.infoBanner}>
                本次正式下注為固定追期模式：按一次正式下注後，4 組號碼固定追 4 期，
                中途不換號；除非你再次手動建立正式下注。
              </div>

              <div style={styles.groupGrid}>
                {formalGroups.length ? (
                  formalGroups.map((group, idx) => (
                    <div key={`${group?.key || idx}`} style={styles.groupCard}>
                      <div style={styles.groupHead}>
                        <div style={styles.groupTitle}>{groupTitle(group, idx)}</div>
                        <div style={styles.groupMeta}>
                          {fmtText(group?.meta?.strategy_key || group?.key)}
                        </div>
                      </div>
                      <div style={styles.ballRow}>
                        {parseNums(group?.nums).map((n) => (
                          <div key={n} style={styles.ballLarge}>
                            {String(n).padStart(2, '0')}
                          </div>
                        ))}
                      </div>
                      <div style={styles.groupReason}>{groupReason(group)}</div>
                    </div>
                  ))
                ) : (
                  <div style={styles.emptyBox}>目前還沒有正式下注資料。</div>
                )}
              </div>

              <div style={styles.actionRow}>
                <button
                  style={styles.primaryButton}
                  onClick={handleFormalBet}
                  disabled={busyKey !== ''}
                >
                  {busyKey === 'formalBet' ? '建立中...' : '重新建立正式下注'}
                </button>
              </div>
            </Card>

            <Card
              title="AI 自動訓練"
              subtitle="這塊是養 AI 用，不代表你一定要買。"
              right={<div style={styles.tag}>四星賓果 / 四組 / 二期</div>}
            >
              <div style={styles.summaryLine}>
                <span>模式：</span>
                <strong>{fmtText(trainingLatest?.mode, 'ai_train')}</strong>
                <span style={{ marginLeft: 16 }}>來源期數：</span>
                <strong>{fmtText(trainingLatest?.source_draw_no)}</strong>
                <span style={{ marginLeft: 16 }}>目標期數：</span>
                <strong>{fmtText(trainingLatest?.target_periods)}</strong>
              </div>

              <div style={styles.groupGrid}>
                {trainingGroups.length ? (
                  trainingGroups.map((group, idx) => (
                    <div key={`${group?.key || idx}`} style={styles.groupCard}>
                      <div style={styles.groupHead}>
                        <div style={styles.groupTitle}>{groupTitle(group, idx)}</div>
                        <div style={styles.groupMeta}>
                          {fmtText(group?.meta?.strategy_key || group?.key)}
                        </div>
                      </div>
                      <div style={styles.ballRow}>
                        {parseNums(group?.nums).map((n) => (
                          <div key={n} style={styles.ballLarge}>
                            {String(n).padStart(2, '0')}
                          </div>
                        ))}
                      </div>
                      <div style={styles.groupReason}>{groupReason(group)}</div>
                    </div>
                  ))
                ) : (
                  <div style={styles.emptyBox}>目前還沒有自動訓練資料。</div>
                )}
              </div>
            </Card>

            <Card
              title="策略排行榜（精簡版）"
              subtitle="你不用每次看 50 個，先看前 10 名就夠。"
            >
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>排名</th>
                      <th style={styles.th}>策略</th>
                      <th style={styles.th}>平均命中</th>
                      <th style={styles.th}>ROI</th>
                      <th style={styles.th}>回合</th>
                      <th style={styles.th}>分數</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.length ? (
                      leaderboard.slice(0, 10).map((row, idx) => (
                        <tr key={row?.key || idx}>
                          <td style={styles.td}>{idx + 1}</td>
                          <td style={styles.td}>{fmtText(row?.label || row?.key)}</td>
                          <td style={styles.td}>
                            {Number.isFinite(Number(row?.avg_hit))
                              ? Number(row.avg_hit).toFixed(2)
                              : '--'}
                          </td>
                          <td style={styles.td}>
                            {fmtPercent(row?.recent_50_roi ?? row?.roi)}
                          </td>
                          <td style={styles.td}>{fmtText(row?.total_rounds)}</td>
                          <td style={styles.td}>
                            {Number.isFinite(Number(row?.score))
                              ? Number(row.score).toFixed(1)
                              : '--'}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td style={styles.td} colSpan={6}>
                          目前尚無排行榜資料。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {!loading && activeTab === TABS.MARKET && (
          <div style={styles.sectionStack}>
            <Card
              title="最新開獎"
              subtitle="先把市場資料跟 AI 頁分開，畫面就會乾淨很多。"
            >
              <div style={styles.statsGrid4}>
                <StatBox
                  label="最新期數"
                  value={fmtText(latestDrawNo)}
                  hint={fmtDateTime(latestDrawTime)}
                />
                <StatBox
                  label="開出號碼數"
                  value={latestNumbers.length}
                  hint="BINGO 1~80"
                />
                <StatBox
                  label="奇數數量"
                  value={latestNumbers.filter((n) => n % 2 === 1).length}
                />
                <StatBox
                  label="偶數數量"
                  value={latestNumbers.filter((n) => n % 2 === 0).length}
                />
              </div>

              <div style={styles.marketBalls}>
                {latestNumbers.map((n) => (
                  <div key={n} style={styles.marketBall}>
                    {String(n).padStart(2, '0')}
                  </div>
                ))}
              </div>
            </Card>

            <Card
              title="最近 20 期"
              subtitle="市場資料頁只做資料，別再把策略和下注摻進來。"
            >
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>期數</th>
                      <th style={styles.th}>時間</th>
                      <th style={styles.th}>號碼</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent20.length ? (
                      recent20.map((row, idx) => {
                        const nums = parseNums(row?.numbers || row?.nums);
                        return (
                          <tr key={row?.draw_no || row?.drawNo || idx}>
                            <td style={styles.td}>
                              {fmtText(row?.draw_no || row?.drawNo)}
                            </td>
                            <td style={styles.td}>
                              {fmtDateTime(row?.draw_time || row?.drawTime)}
                            </td>
                            <td style={styles.td}>
                              <div style={styles.numsInline}>
                                {nums.map((n) => (
                                  <span key={n} style={styles.numChip}>
                                    {String(n).padStart(2, '0')}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td style={styles.td} colSpan={3}>
                          沒有 recent20 資料。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#0f172a',
    color: '#e5e7eb',
    padding: '20px 12px 90px'
  },
  app: {
    maxWidth: 1200,
    margin: '0 auto'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'center',
    marginBottom: 16,
    flexWrap: 'wrap'
  },
  brand: {
    fontSize: 28,
    fontWeight: 900,
    letterSpacing: 0.6
  },
  headerSub: {
    color: '#94a3b8',
    marginTop: 6,
    fontSize: 14
  },
  headerActions: {
    display: 'flex',
    gap: 10
  },
  tabBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 10,
    marginBottom: 16,
    position: 'sticky',
    top: 8,
    zIndex: 5,
    background: 'rgba(15,23,42,0.92)',
    padding: 8,
    borderRadius: 18,
    backdropFilter: 'blur(10px)'
  },
  tabButton: {
    border: '1px solid #334155',
    background: '#111827',
    color: '#cbd5e1',
    borderRadius: 14,
    padding: '14px 10px',
    fontSize: 15,
    fontWeight: 800,
    cursor: 'pointer'
  },
  tabButtonActive: {
    background: '#2563eb',
    color: '#fff',
    borderColor: '#2563eb',
    boxShadow: '0 8px 24px rgba(37,99,235,0.35)'
  },
  tabIcon: {
    marginRight: 6
  },
  errorBanner: {
    background: '#7f1d1d',
    border: '1px solid #ef4444',
    color: '#fee2e2',
    padding: 14,
    borderRadius: 14,
    marginBottom: 16,
    fontWeight: 700
  },
  loading: {
    padding: 30,
    textAlign: 'center',
    color: '#cbd5e1'
  },
  sectionStack: {
    display: 'grid',
    gap: 16
  },
  card: {
    background: '#111827',
    border: '1px solid #1f2937',
    borderRadius: 20,
    padding: 18,
    boxShadow: '0 12px 30px rgba(0,0,0,0.22)'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'flex-start',
    marginBottom: 16,
    flexWrap: 'wrap'
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: 900
  },
  cardSubtitle: {
    fontSize: 14,
    color: '#94a3b8',
    marginTop: 6
  },
  tag: {
    padding: '8px 12px',
    borderRadius: 999,
    background: '#1e293b',
    border: '1px solid #334155',
    fontSize: 13,
    color: '#cbd5e1',
    fontWeight: 800
  },
  statsGrid4: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 12
  },
  statBox: {
    background: '#0b1220',
    border: '1px solid #1f2937',
    borderRadius: 16,
    padding: 16
  },
  statLabel: {
    fontSize: 13,
    color: '#94a3b8',
    marginBottom: 8
  },
  statValue: {
    fontSize: 28,
    fontWeight: 900,
    lineHeight: 1.1
  },
  statHint: {
    marginTop: 8,
    fontSize: 12,
    color: '#64748b'
  },
  actionRow: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
    marginTop: 16
  },
  primaryButton: {
    border: 'none',
    borderRadius: 14,
    background: '#2563eb',
    color: '#fff',
    fontWeight: 900,
    padding: '12px 18px',
    cursor: 'pointer'
  },
  secondaryButton: {
    border: '1px solid #334155',
    borderRadius: 14,
    background: '#0f172a',
    color: '#e5e7eb',
    fontWeight: 800,
    padding: '12px 18px',
    cursor: 'pointer'
  },
  warnButton: {
    border: 'none',
    borderRadius: 14,
    background: '#b91c1c',
    color: '#fff',
    fontWeight: 900,
    padding: '12px 18px',
    cursor: 'pointer'
  },
  controlGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 14
  },
  controlItem: {
    background: '#0b1220',
    border: '1px solid #1f2937',
    borderRadius: 16,
    padding: 16
  },
  controlTitle: {
    fontSize: 17,
    fontWeight: 900,
    marginBottom: 8
  },
  controlText: {
    fontSize: 14,
    color: '#cbd5e1',
    marginBottom: 14
  },
  inlineButtons: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap'
  },
  resultPanel: {
    marginTop: 16,
    background: '#0b1220',
    border: '1px solid #1f2937',
    borderRadius: 16,
    padding: 16
  },
  resultTitle: {
    fontWeight: 900,
    marginBottom: 8
  },
  resultText: {
    color: '#cbd5e1',
    lineHeight: 1.6
  },
  summaryLine: {
    color: '#cbd5e1',
    marginBottom: 14,
    lineHeight: 1.8
  },
  infoBanner: {
    background: '#172554',
    border: '1px solid #1d4ed8',
    color: '#dbeafe',
    padding: 14,
    borderRadius: 14,
    marginBottom: 16,
    lineHeight: 1.7
  },
  groupGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: 14
  },
  groupCard: {
    background: '#0b1220',
    border: '1px solid #1f2937',
    borderRadius: 18,
    padding: 16
  },
  groupHead: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    alignItems: 'flex-start',
    marginBottom: 12
  },
  groupTitle: {
    fontSize: 16,
    fontWeight: 900
  },
  groupMeta: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'right'
  },
  ballRow: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
    marginBottom: 10
  },
  ballLarge: {
    width: 52,
    height: 52,
    borderRadius: 999,
    background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 900,
    fontSize: 18,
    color: '#fff',
    boxShadow: '0 8px 20px rgba(37,99,235,0.35)'
  },
  groupReason: {
    color: '#94a3b8',
    fontSize: 13,
    lineHeight: 1.6
  },
  emptyBox: {
    background: '#0b1220',
    border: '1px dashed #334155',
    borderRadius: 16,
    padding: 24,
    textAlign: 'center',
    color: '#94a3b8'
  },
  tableWrap: {
    overflowX: 'auto'
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse'
  },
  th: {
    textAlign: 'left',
    padding: '12px 10px',
    fontSize: 13,
    color: '#94a3b8',
    borderBottom: '1px solid #1f2937',
    whiteSpace: 'nowrap'
  },
  td: {
    padding: '12px 10px',
    borderBottom: '1px solid #1f2937',
    verticalAlign: 'top',
    color: '#e5e7eb'
  },
  marketBalls: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
    marginTop: 18
  },
  marketBall: {
    width: 46,
    height: 46,
    borderRadius: 999,
    background: '#1e293b',
    border: '1px solid #334155',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 900,
    color: '#f8fafc'
  },
  numsInline: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap'
  },
  numChip: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 34,
    height: 30,
    padding: '0 8px',
    borderRadius: 999,
    background: '#1e293b',
    border: '1px solid #334155',
    fontSize: 13,
    fontWeight: 800
  }
};
