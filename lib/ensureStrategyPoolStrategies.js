import { createClient } from '@supabase/supabase-js';

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
  return String(raw || '').trim();
}

function safeSourceType(value = 'seed') {
  const allowed = new Set(['seed', 'crossover', 'exploration']);
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : 'seed';
}

function safeStatus(value = 'disabled') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'disabled';
}

function inferGenes(strategyKey = '') {
  const parts = String(strategyKey).split('_').filter(Boolean);

  const geneA = parts[0] || 'mix';
  const geneB = parts[1] || 'mix';

  return {
    gene_a: geneA,
    gene_b: geneB
  };
}

function extractStrategyKeysFromGroups(groups = []) {
  if (!Array.isArray(groups)) return [];

  return unique(
    groups.map((group) =>
      normalizeStrategyKey(
        group?.meta?.strategy_key ||
        group?.strategyKey ||
        group?.key ||
        ''
      )
    )
  );
}

export async function ensureStrategyPoolStrategies({
  strategyKeys = [],
  groups = [],
  sourceType = 'seed',
  status = 'disabled'
} = {}) {
  const supabase = getSupabase();

  const finalKeys = unique([
    ...strategyKeys.map(normalizeStrategyKey),
    ...extractStrategyKeysFromGroups(groups)
  ]).filter(Boolean);

  if (!finalKeys.length) {
    return {
      ok: true,
      checked_count: 0,
      inserted_count: 0,
      inserted: []
    };
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('strategy_pool')
    .select('strategy_key')
    .in('strategy_key', finalKeys);

  if (existingError) throw existingError;

  const existingSet = new Set((existingRows || []).map((row) => row.strategy_key));
  const missingKeys = finalKeys.filter((key) => !existingSet.has(key));

  if (!missingKeys.length) {
    return {
      ok: true,
      checked_count: finalKeys.length,
      inserted_count: 0,
      inserted: []
    };
  }

  const nowIso = new Date().toISOString();
  const finalSourceType = safeSourceType(sourceType);
  const finalStatus = safeStatus(status);

  const rows = missingKeys.map((strategyKey) => {
    const genes = inferGenes(strategyKey);

    return {
      strategy_key: strategyKey,
      strategy_name: strategyKey,
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
    };
  });

  const { error: insertError } = await supabase
    .from('strategy_pool')
    .insert(rows);

  if (insertError) throw insertError;

  return {
    ok: true,
    checked_count: finalKeys.length,
    inserted_count: rows.length,
    inserted: rows.map((row) => row.strategy_key)
  };
}
