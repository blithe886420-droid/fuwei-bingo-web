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

const CONFIG_KEY = 'auto_train_enabled';

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return fallback;
}

export default async function handler(req, res) {
  try {
    // 讀取開關
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('system_config')
        .select('key, value, updated_at')
        .eq('key', CONFIG_KEY)
        .maybeSingle();

      if (error) throw error;

      const enabled = toBool(data?.value, false);

      return res.status(200).json({
        ok: true,
        key: CONFIG_KEY,
        value: enabled,
        updated_at: data?.updated_at || null
      });
    }

    // 更新開關
    if (req.method === 'POST') {
      const enabled = toBool(req.body?.enabled, false);
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

      return res.status(200).json({
        ok: true,
        key: data.key,
        value: toBool(data.value, false),
        updated_at: data.updated_at
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
