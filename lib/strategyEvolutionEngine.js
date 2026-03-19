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
  'hot','cold','warm','zone','tail','mix','repeat','chase',
  'jump','guard','balance','pattern','structure','split'
];

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function randomPick(arr = []) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeKey(key = '') {
  return String(key || '').trim().toLowerCase();
}

function splitGenes(key = '') {
  const parts = normalizeKey(key).split('_').filter(Boolean);
  return {
    gene_a: parts[0] || randomPick(GENE_POOL) || 'mix',
    gene_b: parts[1] || randomPick(GENE_POOL) || 'zone'
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
  let a = parts[0] || 'mix';
  let b = parts[1] || 'zone';

  if (Math.random() < 0.5) {
    a = randomPick(GENE_POOL) || a;
  } else {
    b = randomPick(GENE_POOL) || b;
  }

  if (a === b) {
    b = randomPick(GENE_POOL.filter((g) => g !== a)) || b;
  }

  return normalizeKey(`${a}_${b}`);
}

function buildSafeRows(existingKeys = new Set(), count = 4) {
  const rows = [];
  const used = new Set();

  for (let i = 0; i < count; i++) {
    let key = mutateGene('mix_zone');

    if (existingKeys.has(key) || used.has(key)) {
      key = mutateGene(key);
    }

    const genes = splitGenes(key);
    const now = new Date().toISOString();

    rows.push({
      strategy_key: key,
      strategy_name: buildStrategyName(key),
      gene_a: genes.gene_a,
      gene_b: genes.gene_b,
      parameters: {
        mode: 'safe_evolution'
      },
      generation: 1,
      source_type: 'evolved',
      parent_keys: [],
      status: 'active',
      protected_rank: false,
      incubation_until_draw: 0,
      created_draw_no: 0,
      created_at: now,
      updated_at: now
    });

    used.add(key);
  }

  return rows;
}

export async function evolveStrategies() {
  try {
    // 只讀 pool，完全不依賴 strategy_stats（避免 crash）
    const { data: poolRows, error: poolError } = await supabase
      .from('strategy_pool')
      .select('*');

    if (poolError) {
      return { ok: false, error: poolError.message };
    }

    const existing = Array.isArray(poolRows) ? poolRows : [];
    const keySet = new Set(
      existing.map((r) => normalizeKey(r.strategy_key))
    );

    // 👉 保底：如果 pool 太少，就補策略
    if (existing.length < 4) {
      const rows = buildSafeRows(keySet, 4);

      const { error: insertError } = await supabase
        .from('strategy_pool')
        .insert(rows);

      return {
        ok: !insertError,
        inserted: rows.length,
        error: insertError ? insertError.message : null
      };
    }

    // 👉 輕量更新（只更新時間，不做複雜邏輯）
    const targets = existing.slice(0, 6);

    for (const row of targets) {
      await supabase
        .from('strategy_pool')
        .update({
          updated_at: new Date().toISOString(),
          status: 'active'
        })
        .eq('strategy_key', row.strategy_key);
    }

    return {
      ok: true,
      updated: targets.length
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || 'evolve failed'
    };
  }
}
