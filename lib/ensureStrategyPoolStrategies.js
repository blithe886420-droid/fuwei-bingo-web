import { createClient } from '@supabase/supabase-js';

const KNOWN_GENES = new Set([
  'hot','cold','warm','zone','tail','mix','repeat','guard',
  'balanced','balance','chase','jump','pattern','structure',
  'split','cluster','gap'
]);

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase env for ensureStrategyPoolStrategies');
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

function normalizeStrategyKey(raw = '') {
  return String(raw || '').trim().toLowerCase();
}

function inferGenes(strategyKey = '') {
  const tokens = String(strategyKey)
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
  return String(strategyKey)
    .split('_')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

export async function ensureStrategyPoolStrategies({
  strategyKeys = [],
  sourceType = 'seed'
} = {}) {

  const supabase = getSupabase();
  const now = new Date().toISOString();

  const keys = [...new Set(strategyKeys.map(normalizeStrategyKey))];

  if (!keys.length) {
    return { ok: true };
  }

  const { data: existingRows, error } = await supabase
    .from('strategy_pool')
    .select('*')
    .in('strategy_key', keys);

  if (error) throw error;

  const map = new Map((existingRows || []).map(r => [r.strategy_key, r]));

  const inserts = [];
  const updates = [];

  for (const key of keys) {

    const exist = map.get(key);
    const genes = inferGenes(key);

    if (!exist) {
      inserts.push({
        strategy_key: key,
        strategy_name: buildStrategyName(key),
        gene_a: genes.gene_a,
        gene_b: genes.gene_b,
        status: 'active',
        protected_rank: false,
        generation: 1,
        source_type: sourceType,
        parameters: {},
        parent_keys: [],
        incubation_until_draw: 0,
        created_draw_no: 0,
        created_at: now,
        updated_at: now
      });
      continue;
    }

    // 🔥 強制修正 status
    updates.push({
      strategy_key: key,
      patch: {
        status: 'active',
        updated_at: now
      }
    });
  }

  if (inserts.length) {
    const { error } = await supabase
      .from('strategy_pool')
      .insert(inserts);
    if (error) throw error;
  }

  for (const u of updates) {
    const { error } = await supabase
      .from('strategy_pool')
      .update(u.patch)
      .eq('strategy_key', u.strategy_key);

    if (error) throw error;
  }

  return {
    ok: true,
    inserted: inserts.length,
    updated: updates.length
  };
}
