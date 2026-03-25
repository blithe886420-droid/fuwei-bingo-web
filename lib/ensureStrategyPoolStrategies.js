import { createClient } from '@supabase/supabase-js';

const STRATEGY_POOL_TABLE = 'strategy_pool';

/**
 * 建立 Supabase
 */
function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE env');
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

/**
 * 預設策略池（只負責初始化）
 * ⚠️ 不可覆蓋既有策略狀態
 */
function buildDefaultStrategies() {
  return [
    { strategy_key: 'repeat_hot' },
    { strategy_key: '2_hot' },
    { strategy_key: '3_hot' },
    { strategy_key: 'balanced_mix' },
    { strategy_key: 'cold_rebound' },
    { strategy_key: 'tail_focus' },
    { strategy_key: 'spread_guard' }
  ];
}

/**
 * 主流程：確保策略池存在，但不復活已淘汰策略
 */
export async function ensureStrategyPoolStrategies() {
  const supabase = getSupabase();

  // 取得目前 pool
  const { data: existingRows, error: fetchError } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*');

  if (fetchError) throw fetchError;

  const existingMap = new Map();
  for (const row of existingRows || []) {
    if (row?.strategy_key) {
      existingMap.set(row.strategy_key, row);
    }
  }

  const defaults = buildDefaultStrategies();

  const insertList = [];

  for (const def of defaults) {
    const existing = existingMap.get(def.strategy_key);

    if (!existing) {
      // ✅ 只新增不存在的策略
      insertList.push({
        strategy_key: def.strategy_key,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    } else {
      // ❗❗❗關鍵：絕對不要動 existing.status
      // 不做任何 update
    }
  }

  if (insertList.length > 0) {
    const { error: insertError } = await supabase
      .from(STRATEGY_POOL_TABLE)
      .insert(insertList);

    if (insertError) throw insertError;
  }

  return {
    ok: true,
    inserted: insertList.length
  };
}
