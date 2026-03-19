import { createClient } from '@supabase/supabase-js';

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
  'gap'
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

function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

function normalizeStrategyKey(raw = '') {
  return String(raw || '').trim().toLowerCase();
}

function safeSourceType(value = 'seed') {
  const allowed = new Set(['seed', 'crossover', 'exploration', 'manual_save', 'evolved']);
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : 'seed';
}

function safeStatus(value = 'active') {
  const allowed = new Set(['active', 'disabled', 'paused', 'retired', 'inactive']);
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : 'active';
}

function inferGenes(strategyKey = '') {
  const tokens = String(strategyKey)
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token));

  const genes = tokens.filter((token) => KNOWN_GENES.has(token));

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

export async function ensureStrategyPoolStrategies({
  strategyKeys = [],
  sourceType = 'seed',
  status = 'active'
} = {}) {
  const supabase = getSupabase();
  const finalSourceType = safeSourceType(sourceType);
  const finalStatus = safeStatus(status);

  const finalKeys = unique(strategyKeys.map(normalizeStrategyKey)).filter(Boolean);

  if (!finalKeys.length) {
    return {
      ok: true,
      checked_count: 0,
      inserted_count: 0,
      inserted: [],
      updated_count: 0,
      updated: []
    };
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('strategy_pool')
    .select('*')
    .in('strategy_key', finalKeys);

  if (existingError) throw existingError;

  const existingMap = new Map((existingRows || []).map((row) => [row.strategy_key, row]));
  const nowIso = new Date().toISOString();

  const rowsToInsert = [];
  const rowsToUpdate = [];

  for (const strategyKey of finalKeys) {
    const existing = existingMap.get(strategyKey);
    const genes = inferGenes(strategyKey);

    if (!existing) {
      rowsToInsert.push({
        strategy_key: strategyKey,
        strategy_name: buildStrategyName(strategyKey),
        gene_a: genes.gene_a,
        gene_b: genes.gene_b,
        status: finalStatus,
        protected_rank: false,
        generation: 1,
        source_type: finalSourceType,
        parameters: {},
        parent_keys: [],
        incubation_until_draw: 0,
        created_draw_no: 0,
        created_at: nowIso,
        updated_at: nowIso
      });
      continue;
    }

    const patch = {};
    let changed = false;

    if (!existing.strategy_name) {
      patch.strategy_name = buildStrategyName(strategyKey);
      changed = true;
    }

    if (!existing.gene_a) {
      patch.gene_a = genes.gene_a;
      changed = true;
    }

    if (!existing.gene_b) {
      patch.gene_b = genes.gene_b;
      changed = true;
    }

    if (!existing.source_type) {
      patch.source_type = finalSourceType;
      changed = true;
    }

    if (!existing.status || String(existing.status).trim() === '') {
      patch.status = finalStatus;
      changed = true;
    }

    if (changed) {
      patch.updated_at = nowIso;
      rowsToUpdate.push({
        strategy_key: strategyKey,
        patch
      });
    }
  }

  if (rowsToInsert.length) {
    const { error: insertError } = await supabase
      .from('strategy_pool')
      .insert(rowsToInsert);

    if (insertError) throw insertError;
  }

  for (const row of rowsToUpdate) {
    const { error: updateError } = await supabase
      .from('strategy_pool')
      .update(row.patch)
      .eq('strategy_key', row.strategy_key);

    if (updateError) throw updateError;
  }

  return {
    ok: true,
    checked_count: finalKeys.length,
    inserted_count: rowsToInsert.length,
    inserted: rowsToInsert.map((row) => row.strategy_key),
    updated_count: rowsToUpdate.length,
    updated: rowsToUpdate.map((row) => row.strategy_key)
  };
}
