import { createClient } from '@supabase/supabase-js';

const KNOWN_GENES = new Set([
  'hot',
  'chase',
  'balanced',
  'balance',
  'zone',
  'tail',
  'mix',
  'rebound',
  'bounce',
  'warm',
  'repeat',
  'guard',
  'cold',
  'jump',
  'follow',
  'pattern',
  'structure',
  'split'
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
  return String(raw || '').trim();
}

function safeSourceType(value = 'seed') {
  const allowed = new Set(['seed', 'crossover', 'exploration', 'manual_save']);
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : 'seed';
}

function safeStatus(value = 'disabled') {
  const allowed = new Set(['active', 'disabled', 'paused', 'retired']);
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : 'disabled';
}

function inferGenes(strategyKey = '') {
  const rawTokens = String(strategyKey)
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token));

  const geneTokens = rawTokens.filter((token) => KNOWN_GENES.has(token));

  const geneA = geneTokens[0] || 'mix';
  const geneB = geneTokens[1] || (geneTokens[0] ? 'balanced' : 'mix');

  return {
    gene_a: geneA,
    gene_b: geneB
  };
}

function extractStrategyRowsFromGroups(groups = [], defaultSourceType = 'seed', defaultStatus = 'disabled') {
  if (!Array.isArray(groups)) return [];

  return groups
    .map((group) => {
      const strategyKey = normalizeStrategyKey(
        group?.meta?.strategy_key ||
          group?.strategyKey ||
          group?.key ||
          ''
      );

      if (!strategyKey) return null;

      const geneA =
        String(group?.meta?.gene_a || '').trim().toLowerCase() ||
        inferGenes(strategyKey).gene_a;

      const geneB =
        String(group?.meta?.gene_b || '').trim().toLowerCase() ||
        inferGenes(strategyKey).gene_b;

      return {
        strategy_key: strategyKey,
        strategy_name:
          String(group?.meta?.strategy_name || '').trim() ||
          String(group?.label || '').trim() ||
          strategyKey,
        gene_a: KNOWN_GENES.has(geneA) ? geneA : inferGenes(strategyKey).gene_a,
        gene_b: KNOWN_GENES.has(geneB) ? geneB : inferGenes(strategyKey).gene_b,
        source_type: safeSourceType(group?.meta?.source_type || defaultSourceType),
        status: safeStatus(group?.meta?.status || defaultStatus)
      };
    })
    .filter(Boolean);
}

export async function ensureStrategyPoolStrategies({
  strategyKeys = [],
  groups = [],
  sourceType = 'seed',
  status = 'disabled'
} = {}) {
  const supabase = getSupabase();
  const finalSourceType = safeSourceType(sourceType);
  const finalStatus = safeStatus(status);

  const groupRows = extractStrategyRowsFromGroups(groups, finalSourceType, finalStatus);

  const explicitRows = unique(strategyKeys.map(normalizeStrategyKey))
    .filter(Boolean)
    .map((strategyKey) => {
      const genes = inferGenes(strategyKey);
      return {
        strategy_key: strategyKey,
        strategy_name: strategyKey,
        gene_a: genes.gene_a,
        gene_b: genes.gene_b,
        source_type: finalSourceType,
        status: finalStatus
      };
    });

  const mergedMap = new Map();

  for (const row of [...explicitRows, ...groupRows]) {
    if (!row?.strategy_key) continue;
    if (!mergedMap.has(row.strategy_key)) {
      mergedMap.set(row.strategy_key, row);
    }
  }

  const finalRows = [...mergedMap.values()];
  const finalKeys = finalRows.map((row) => row.strategy_key);

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

  for (const row of finalRows) {
    const existing = existingMap.get(row.strategy_key);

    if (!existing) {
      rowsToInsert.push({
        strategy_key: row.strategy_key,
        strategy_name: row.strategy_name || row.strategy_key,
        gene_a: row.gene_a || 'mix',
        gene_b: row.gene_b || 'balanced',
        status: row.status || finalStatus,
        protected_rank: false,
        generation: 1,
        source_type: row.source_type || finalSourceType,
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

    if (!existing.strategy_name && row.strategy_name) {
      patch.strategy_name = row.strategy_name;
      changed = true;
    }

    if ((!existing.gene_a || !KNOWN_GENES.has(String(existing.gene_a).toLowerCase())) && row.gene_a) {
      patch.gene_a = row.gene_a;
      changed = true;
    }

    if ((!existing.gene_b || !KNOWN_GENES.has(String(existing.gene_b).toLowerCase())) && row.gene_b) {
      patch.gene_b = row.gene_b;
      changed = true;
    }

    if (!existing.source_type && row.source_type) {
      patch.source_type = row.source_type;
      changed = true;
    }

    if (!existing.status && row.status) {
      patch.status = row.status;
      changed = true;
    }

    if (changed) {
      patch.updated_at = nowIso;
      rowsToUpdate.push({
        strategy_key: row.strategy_key,
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
