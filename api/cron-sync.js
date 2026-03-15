import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SOFT_TIMEOUT_MS = 20000;

function nowTs() {
  return Date.now();
}

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

function buildBaseUrl(req) {
  const proto =
    req.headers['x-forwarded-proto'] ||
    (req.headers.host && req.headers.host.includes('localhost') ? 'http' : 'https');

  const host =
    req.headers['x-forwarded-host'] ||
    req.headers.host ||
    process.env.VERCEL_URL;

  if (!host) {
    throw new Error('Cannot resolve request host');
  }

  if (String(host).startsWith('http://') || String(host).startsWith('https://')) {
    return host;
  }

  return `${proto}://${host}`;
}

async function callInternalApi(baseUrl, path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-cron': '1'
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: controller.signal
    });

    const text = await res.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    return {
      ok: res.ok,
      status: res.status,
      path,
      data: json
    };
  } finally {
    clearTimeout(timer);
  }
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

async function runSyncFlow(baseUrl, startedAt) {
  const steps = [];

  if (nowTs() - startedAt > SOFT_TIMEOUT_MS) {
    return {
      ok: false,
      steps,
      error: 'soft timeout before sync'
    };
  }

  const syncResult = await callInternalApi(baseUrl, '/api/sync');
  steps.push(syncResult);

  if (nowTs() - startedAt > SOFT_TIMEOUT_MS) {
    return {
      ok: false,
      steps,
      error: 'soft timeout after sync'
    };
  }

  const saveAfterSync = await callInternalApi(baseUrl, '/api/save', {
    method: 'POST'
  });
  steps.push(saveAfterSync);

  if (nowTs() - startedAt > SOFT_TIMEOUT_MS) {
    return {
      ok: false,
      steps,
      error: 'soft timeout after save'
    };
  }

  const recent20Result = await callInternalApi(baseUrl, '/api/recent20');
  steps.push(recent20Result);

  if (nowTs() - startedAt > SOFT_TIMEOUT_MS) {
    return {
      ok: false,
      steps,
      error: 'soft timeout after recent20'
    };
  }

  const catchupResult = await callInternalApi(baseUrl, '/api/catchup');
  steps.push(catchupResult);

  if (nowTs() - startedAt > SOFT_TIMEOUT_MS) {
    return {
      ok: false,
      steps,
      error: 'soft timeout after catchup'
    };
  }

  const saveAfterCatchup = await callInternalApi(baseUrl, '/api/save', {
    method: 'POST'
  });
  steps.push(saveAfterCatchup);

  return {
    ok: steps.every((s) => s.ok),
    steps
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  const startedAt = nowTs();

  try {
    const baseUrl = buildBaseUrl(req);
    const action = String(req.query?.action || req.body?.action || 'run').trim();

    if (action === 'sync') {
      const result = await callInternalApi(baseUrl, '/api/sync');
      return res.status(200).json({
        ok: result.ok,
        mode: 'cron-sync',
        action,
        result
      });
    }

    if (action === 'save') {
      const result = await callInternalApi(baseUrl, '/api/save', {
        method: 'POST'
      });
      return res.status(200).json({
        ok: result.ok,
        mode: 'cron-sync',
        action,
        result
      });
    }

    if (action === 'recent20') {
      const result = await callInternalApi(baseUrl, '/api/recent20');
      return res.status(200).json({
        ok: result.ok,
        mode: 'cron-sync',
        action,
        result
      });
    }

    if (action === 'catchup') {
      const result = await callInternalApi(baseUrl, '/api/catchup');
      return res.status(200).json({
        ok: result.ok,
        mode: 'cron-sync',
        action,
        result
      });
    }

    if (action === 'auto-train') {
      const result = await callInternalApi(baseUrl, '/api/auto-train', {
        method: 'POST'
      });
      return res.status(200).json({
        ok: result.ok,
        mode: 'cron-sync',
        action,
        result
      });
    }

    const flow = await runSyncFlow(baseUrl, startedAt);

    if (!flow.ok) {
      return res.status(200).json({
        ok: false,
        mode: 'cron-sync',
        action: 'run',
        auto_train_enabled: false,
        step_count: flow.steps.length,
        steps: flow.steps,
        duration_ms: nowTs() - startedAt,
        error: flow.error || 'sync flow failed'
      });
    }

    const cfg = await getAutoTrainEnabled();

    if (!cfg.enabled) {
      return res.status(200).json({
        ok: true,
        mode: 'cron-sync',
        action: 'run',
        auto_train_enabled: false,
        message: '自動訓練未啟用，本次排程只執行同步流程。',
        system_config_updated_at: cfg.updated_at,
        step_count: flow.steps.length,
        steps: flow.steps,
        duration_ms: nowTs() - startedAt,
        auto_train_result: null,
        error: flow.error || null
      });
    }

    const autoTrainResult = await callInternalApi(baseUrl, '/api/auto-train', {
      method: 'POST'
    });

    return res.status(200).json({
      ok: flow.ok && autoTrainResult.ok,
      mode: 'cron-sync',
      action: 'run',
      auto_train_enabled: true,
      message: '自動訓練已啟用，本次排程已執行同步流程與 auto-train。',
      system_config_updated_at: cfg.updated_at,
      step_count: flow.steps.length + 1,
      steps: [...flow.steps, autoTrainResult],
      duration_ms: nowTs() - startedAt,
      auto_train_result: autoTrainResult,
      error: flow.error || null
    });
  } catch (error) {
    console.error('cron-sync error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'Unknown cron-sync error'
    });
  }
}

