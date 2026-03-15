import { createClient } from '@supabase/supabase-js';
import { rebuildStrategyStats } from '../lib/rebuildStrategyStats.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CONFIG_KEY = 'auto_train_enabled';
const ADMIN_REBUILD_TOKEN =
  process.env.ADMIN_REBUILD_TOKEN || 'fw_rebuild_20260314';

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

export default async function handler(req, res) {
  try {
    const action = req.query?.action || req.body?.action || '';
    const token = req.query?.token || req.body?.token || '';

    if (action === 'rebuild_strategy_stats') {
      if (token !== ADMIN_REBUILD_TOKEN) {
        return res.status(403).json({
          ok: false,
          error: 'forbidden'
        });
      }

      try {
        const result = await rebuildStrategyStats();

        return res.status(200).json({
          ok: true,
          action: 'rebuild_strategy_stats',
          result
        });
      } catch (error) {
        console.error('rebuild_strategy_stats error:', error);

        return res.status(500).json({
          ok: false,
          action: 'rebuild_strategy_stats',
          error: error.message || 'rebuild failed'
        });
      }
    }

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('system_config')
        .select('key, value, updated_at')
        .eq('key', CONFIG_KEY)
        .maybeSingle();

      if (error) throw error;

      const enabled = toBool(data?.value, false);

      // 同時回單筆格式 + rows 陣列格式，前端舊新版本都能吃
      return res.status(200).json({
        ok: true,
        key: CONFIG_KEY,
        value: enabled,
        updated_at: data?.updated_at || null,
        rows: [
          {
            key: CONFIG_KEY,
            value: enabled,
            updated_at: data?.updated_at || null
          }
        ]
      });
    }

    if (req.method === 'POST') {
      // 兼容兩種前端送法：
      // 1. { enabled: true/false }
      // 2. { key: 'auto_train_enabled', value: 'true'/'false' }
      const rawEnabled =
        req.body?.enabled ??
        req.body?.value ??
        req.query?.enabled ??
        req.query?.value;

      const enabled = toBool(rawEnabled, false);
      const value = enabled ? 'true' : 'false';
      const updatedAt = new Date().toISOString();

      const { data, error } = await supabase
        .from('system_config')
        .upsert(
          {
            key: CONFIG_KEY,
            value,
            updated_at: updatedAt
          },
          { onConflict: 'key' }
        )
        .select('key, value, updated_at')
        .single();

      if (error) throw error;

      const enabledValue = toBool(data?.value, false);

      return res.status(200).json({
        ok: true,
        key: data.key,
        value: enabledValue,
        updated_at: data.updated_at,
        rows: [
          {
            key: data.key,
            value: enabledValue,
            updated_at: data.updated_at
          }
        ]
      });
    }

    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  } catch (error) {
    console.error('system-config error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || 'system-config failed'
    });
  }
}
