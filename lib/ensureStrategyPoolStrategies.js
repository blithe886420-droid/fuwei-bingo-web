import { createClient } from '@supabase/supabase-js';

const STRATEGY_POOL_TABLE = 'strategy_pool';

const KNOWN_GENES = new Set([
  'hot',
  'cold',
  'warm',
  'zone',
  'tail',
  'mix',
  'repeat',
  'guard',
  'balanced',
  'balance',
  'chase',
  'jump',
  'pattern',
  'structure',
  'split',
  'cluster',
  'gap',
  'spread',
  'rotation',
  'odd',
  'even',
  'reverse',
  'skip'
]);

const TERMINAL_STATUSES = new Set(['disabled', 'retired']);

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

function normalizeStrategyKey(raw = '') {
  return String(raw || '').trim().toLowerCase();
}

function inferGenes(strategyKey = '') {
  const tokens = String(strategyKey || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .filter((t) => !/^\d+$/.test(t));

  const genes = tokens.filter((t) => KNOWN_GENES.has(t));

  return {
    gene_a: genes[0] || 'mix',
    gene_b: genes[1] || 'balanced'
  };
}

function buildStrategyName(strategyKey = '') {
  return String(strategyKey || '')
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
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
    { strategy_key: 'spread_guard' },
    { strategy_key: 'hot_balanced' },
    { strategy_key: 'zone_rotation_hot' },
    { strategy_key: 'gap_chase_balanced' },
    { strategy_key: 'balanced_even' },
    { strategy_key: 'balanced_skip_odd' },
    { strategy_key: 'zone_repeat_hot' },
    { strategy_key: 'hot_zone_repeat' }
  ];
}

/**
 * 主流程：確保策略池存在，但不復活已淘汰策略
 */
export async function ensureStrategyPoolStrategies() {
  const supabase = getSupabase();

  const { data: existingRows, error: fetchError } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*');

  if (fetchError) throw fetchError;

  const existingMap = new Map();
  for (const row of existingRows || []) {
    const key = normalizeStrategyKey(row?.strategy_key);
    if (key) {
      existingMap.set(key, row);
    }
  }

  const defaults = buildDefaultStrategies();
  const nowIso = new Date().toISOString();
  const insertList = [];

  for (const def of defaults) {
    const strategyKey = normalizeStrategyKey(def?.strategy_key);
    if (!strategyKey) continue;

    const existing = existingMap.get(strategyKey);

    if (!existing) {
      const genes = inferGenes(strategyKey);

      insertList.push({
        strategy_key: strategyKey,
        strategy_name: buildStrategyName(strategyKey),
        gene_a: genes.gene_a,
        gene_b: genes.gene_b,
        parameters: {},
        generation: 1,
        source_type: 'seed',
        parent_keys: [],
        status: 'active',
        protected_rank: false,
        incubation_until_draw: 0,
        created_draw_no: 0,
        created_at: nowIso,
        updated_at: nowIso
      });

      continue;
    }

    const existingStatus = String(existing?.status || '')
      .trim()
      .toLowerCase();

    // ✅ 已存在就略過
    // ✅ disabled / retired 絕不復活
    if (TERMINAL_STATUSES.has(existingStatus)) {
      continue;
    }

    // 其他 existing 狀況也不 update，避免覆蓋狀態
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
