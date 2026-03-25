import { createClient } from '@supabase/supabase-js';

const KNOWN_GENES = new Set([
  'hot', 'cold', 'warm', 'zone', 'tail', 'mix', 'repeat', 'guard',
  'balanced', 'balance', 'chase', 'jump', 'pattern', 'structure',
  'split', 'cluster', 'gap'
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
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

export async function ensureStrategyPoolStrategies({
  strategyKeys = [],
  sourceType = 'seed'
} = {}) {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  const keys = [...new Set((Array.isArray(strategyKeys) ? strategyKeys : []).map(normalizeStrategyKey).filter(Boolean))];

  if (!keys.length) {
    return { ok: true, inserted: 0, preserved: 0 };
  }

  const { data: existingRows, error } = await supabase
    .from('strategy_pool')
    .select('*')
    .in('strategy_key', keys);

  if (error) throw error;

  const existingMap = new Map((existingRows || []).map((r) => [normalizeStrategyKey(r.strategy_key), r]));
  const inserts = [];
  let preserved = 0;

  for (const key of keys) {
    const exist = existingMap.get(key);
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
    } else {
      preserved += 1;
    }
  }

  if (inserts.length) {
    const { error: insertError } = await supabase
      .from('strategy_pool')
      .insert(inserts);

    if (insertError) throw insertError;
  }

  return {
    ok: true,
    inserted: inserts.length,
    preserved
  };
}
