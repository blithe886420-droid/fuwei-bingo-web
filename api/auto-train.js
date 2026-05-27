import express from 'express';
import cron from 'node-cron';

// ── API handlers ──────────────────────────────────────────
import syncHandler from './api/sync.js';
import saveHandler from './api/save.js';
import recent20Handler from './api/recent20.js';
import catchupHandler from './api/catchup.js';
import autoTrainHandler from './api/auto-train.js';
import predictionSaveHandler from './api/prediction-save.js';
import predictionLatestHandler from './api/prediction-latest.js';
import predictionCompareHandler from './api/prediction-compare.js';
import strategyGenerateHandler from './api/strategy-generate.js';
import aiPlayerHandler from './api/ai-player.js';
import systemConfigHandler from './api/system-config.js';
import cronSyncHandler from './api/cron-sync.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ CORS：允許 Vercel 前端跨域呼叫 Railway API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-internal-cron');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// 健康檢查
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'fuwei-bingo-backend', time: new Date().toISOString() });
});

// ── API 路由 ──────────────────────────────────────────────
app.all('/api/sync', syncHandler);
app.all('/api/save', saveHandler);
app.all('/api/recent20', recent20Handler);
app.all('/api/catchup', catchupHandler);
app.all('/api/auto-train', autoTrainHandler);
app.all('/api/prediction-save', predictionSaveHandler);
app.all('/api/prediction-latest', predictionLatestHandler);
app.all('/api/prediction-compare', predictionCompareHandler);
app.all('/api/strategy-generate', strategyGenerateHandler);
app.all('/api/ai-player', aiPlayerHandler);
app.all('/api/system-config', systemConfigHandler);
app.all('/api/cron-sync', cronSyncHandler);

// ── Cron 排程（取代 Vercel Cron）─────────────────────────
// 賓果開獎網站在每個尾數3和8分公布結果（:03, :08, :13...）
// 我們在尾數4和9分觸發（開獎後約1分鐘），確保資料已更新
cron.schedule('3,8,13,18,23,28,33,38,43,48,53,58 * * * *', async () => {
  const startedAt = Date.now();
  console.log(`[cron] ${new Date().toISOString()} 開始執行排程`);

  try {
    const baseUrl = `http://localhost:${PORT}`;

    // Step 1: sync
    const syncRes = await fetch(`${baseUrl}/api/sync`);
    const syncData = await syncRes.json();
    console.log(`[cron] sync: ok=${syncData.ok} draw_no=${syncData.draw_no || '-'}`);

    if (!syncData.ok) {
      console.warn('[cron] sync 失敗，跳過本輪');
      return;
    }

    // Step 2: recent20
    await fetch(`${baseUrl}/api/recent20`);

    // Step 3: catchup
    const catchupRes = await fetch(`${baseUrl}/api/catchup`);
    const catchupData = await catchupRes.json();
    console.log(`[cron] catchup: inserted=${catchupData.inserted || 0}`);

    // Step 4: auto-train（核心）
    const autoTrainRes = await fetch(`${baseUrl}/api/auto-train`, { method: 'POST' });
    const autoTrainData = await autoTrainRes.json();
    console.log(`[cron] auto-train: ok=${autoTrainData.ok} duration=${Date.now() - startedAt}ms`);

  } catch (err) {
    console.error('[cron] 排程執行失敗:', err.message);
  }
}, {
  timezone: 'Asia/Taipei'
});

console.log('[cron] 排程已啟動，每5分鐘執行一次');

// ── 啟動伺服器 ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] fuwei-bingo-backend 啟動於 port ${PORT}`);
  console.log(`[server] 環境: ${process.env.NODE_ENV || 'production'}`);
});

export default app;
