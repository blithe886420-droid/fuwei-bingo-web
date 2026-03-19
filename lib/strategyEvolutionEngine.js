import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE env in strategyEvolutionEngine');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const GENE_POOL = [
  'hot',
  'cold',
  'warm',
  'zone',
  'tail',
  'mix',
  'repeat',
  'chase',
  'jump',
  'guard',
  'balanced',
  'pattern',
  'structure',
  'gap',
  'cluster'
];

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeKey(key = '') {
  return String(key || '').trim().toLowerCase();
}

function randomPick(arr = []) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function splitGenes(key = '') {
  const parts = normalizeKey(key).split('_').filter(Boolean);

  return {
    gene_a: parts[0] || randomPick(GENE_POOL) || 'mix',
    gene_b: parts[1] || randomPick(GENE_POOL) || 'balanced'
  };
}

function buildStrategyName(strategyKey = '') {
  return String(strategyKey || '')
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function mutateGene(key = '') {
  const parts = normalizeKey(key).split('_').filter(Boolean);
  let geneA = parts[0] || 'mix';
  let geneB = parts[1] || 'balanced';

  if (Math.random() < 0.5) geneA = randomPick(GENE_POOL) || geneA;
  else geneB = randomPick(GENE_POOL) || geneB;

  if (geneA === geneB) {
    geneB = randomPick(GENE_POOL.filter((g) => g !== geneA)) || geneB;
  }

  return normalizeKey(`${geneA}_${geneB}`);
}

function buildRowsToInsert(existingKeys = new Set(), count = 4) {
  const rows = [];
  const used = new Set();
  const nowIso = new Date().toISOString();

  while (rows.length < count) {
    let key = mutateGene('mix_balanced');

    if (existingKeys.has(key) || used.has(key)) {
      key = mutateGene(key);
    }

    if (existingKeys.has(key) || used.has(key)) {
      continue;
    }

    const genes = splitGenes(key);

    rows.push({
      strategy_key: key,
      strategy_name: buildStrategyName(key),
      gene_a: genes.gene_a,
      gene_b: genes.gene_b,
      parameters: { mode: 'safe_evolution' },
      generation: 1,
      source_type: 'evolved',
      parent_keys: [],
      status: 'active',
      protected_rank: false,
      incubation_until_draw: 0,
      created_draw_no: 0,
      created_at: nowIso,
      updated_at: nowIso
    });

    used.add(key);
  }

  return rows;
}

export async function evolveStrategies() {
  try {
    const { data: poolRows, error: poolError } = await supabase
      .from('strategy_pool')
      .select('*');

    if (poolError) {
      return { ok: false, error: poolError.message };
    }

    const existing = Array.isArray(poolRows) ? poolRows : [];
    const keySet = new Set(existing.map((row) => normalizeKey(row.strategy_key)));

    let insertedCount = 0;
    let updatedCount = 0;

    if (existing.length < 8) {
      const rowsToInsert = buildRowsToInsert(keySet, 4);
      const { data: insertedRows, error: insertError } = await supabase
        .from('strategy_pool')
        .insert(rowsToInsert)
        .select('strategy_key');

      if (insertError) {
        return { ok: false, error: insertError.message };
      }

      insertedCount = Array.isArray(insertedRows) ? insertedRows.length : rowsToInsert.length;
    }

    const activeTargets = existing.slice(0, 6);

    for (const row of activeTargets) {
      const { error: updateError } = await supabase
        .from('strategy_pool')
        .update({
          status: 'active',
          updated_at: new Date().toISOString()
        })
        .eq('strategy_key', row.strategy_key);

      if (!updateError) {
        updatedCount += 1;
      }
    }

    return {
      ok: true,
      inserted_count: insertedCount,
      updated_count: updatedCount
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'evolve failed'
    };
  }
}
