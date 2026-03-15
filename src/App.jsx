import { createClient } from '@supabase/supabase-js';
import syncHandler from './sync.js';
import autoTrainHandler from './auto-train.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

const CRON_SECRET = process.env.CRON_SECRET || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return fallback;
}

async function runApiHandler(handler, { method = 'GET', body = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      body,
      query,
      headers: {}
    };

    const res = {
      statusCode: 200,
      headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(key, value) {
        this.headers[key] = value;
      },
      json(payload) {
        resolve({
          status: this.statusCode || 200,
          payload
        });
      },
      end(payload) {
        resolve({
          status: this.statusCode || 200,
          payload
        });
      }
    };

    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function getAutoTrainEnabled() {
  const { data, error } = await supabase
    .from('system_config')
    .select('key, value, updated_at')
    .eq('key', 'auto_train_enabled')
    .maybeSingle();

  if (error) throw error;

  return {
    enabled: toBool(data?.value, false),
    updated_at: data?.updated_at || null
  };
}

function isAuthorized(req) {
  if (!CRON_SECRET) return true;

  const auth = req.headers?.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const querySecret = req.query?.secret || '';
  const bodySecret = req.body?.secret || '';

  return bearer === CRON_SECRET || querySecret === CRON_SECRET || bodySecret === CRON_SECRET;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    if (!isAuthorized(req)) {
      return res.status(403).json({
        ok: false,
        error: 'forbidden'
      });
    }

    // 先同步最新開獎資料
    let syncResult = null;
    try {
      syncResult = await runApiHandler(syncHandler, { method: 'POST' });
      if (syncResult.status === 405) {
        syncResult = await runApiHandler(syncHandler, { method: 'GET' });
      }
    } catch (err) {
      syncResult = {
        status: 500,
        payload: {
          ok: false,
          error: err.message || 'sync failed'
        }
      };
    }

    // 再讀是否啟用持續自動訓練
    const cfg = await getAutoTrainEnabled();

    if (!cfg.enabled) {
      return res.status(200).json({
        ok: true,
        auto_train_enabled: false,
        message: '自動訓練未啟用，本次排程只同步資料，不執行 auto-train。',
        system_config_updated_at: cfg.updated_at,
        sync_result: syncResult
      });
    }

    // 只有啟用時才持續執行 auto-train
    let autoTrainResult = null;
    try {
      autoTrainResult = await runApiHandler(autoTrainHandler, { method: 'POST' });
    } catch (err) {
      autoTrainResult = {
        status: 500,
        payload: {
          ok: false,
          error: err.message || 'auto-train failed'
        }
      };
    }

    return res.status(200).json({
      ok: true,
      auto_train_enabled: true,
      message: '自動訓練已啟用，本次排程已執行 sync + auto-train。',
      system_config_updated_at: cfg.updated_at,
      sync_result: syncResult,
      auto_train_result: autoTrainResult
    });
  } catch (error) {
    console.error('cron-sync error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'cron-sync failed'
    });
  }
}
