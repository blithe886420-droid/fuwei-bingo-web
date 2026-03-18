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
  'balance',
  'pattern',
  'structure',
  'split'
];

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function randomPick(arr = []) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function unique(arr = []) {
  return [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean))];
}

function normalizeKey(key = '') {
  return String(key || '')
    .trim()
    .toLowerCase();
}

function splitGenes(key = '') {
  const parts = normalizeKey(key)
    .split('_')
    .filter(Boolean);

  const geneA = parts[0] || randomPick(GENE_POOL) || 'mix';
  const geneB = parts[1] || randomPick(GENE_POOL) || 'zone';

  return {
    gene_a: geneA,
    gene_b: geneB
  };
}

function buildStrategyName(strategyKey = '') {
  return String(strategyKey || '')
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function mixGenes(a = '', b = '') {
  const aParts = normalizeKey(a).split('_').filter(Boolean);
  const bParts = normalizeKey(b).split('_').filter(Boolean);

  const geneA = randomPick(aParts.length ? aParts : GENE_POOL) || 'mix';
  const geneB = randomPick(bParts.length ? bParts : GENE_POOL) || 'zone';

  return normalizeKey(`${geneA}_${geneB}`);
}

function mutateGene(key = '') {
  const parts = normalizeKey(key).split('_').filter(Boolean);
  const geneA = parts[0] || 'mix';
  const geneB = parts[1] || 'zone';

  const next = [geneA, geneB];

  if (Math.random() < 0.5) {
    next[0] = randomPick(GENE_POOL) || geneA;
  } else {
    next[1] = randomPick(GENE_POOL) || geneB;
  }

  if (next[0] === next[1]) {
    next[1] = randomPick(GENE_POOL.filter((g) => g !== next[0])) || next[1];
  }

  return normalizeKey(next.join('_'));
}

function buildEvolvedRows(sourceStats = [], existingKeys = new Set(), count = 6) {
  const rows = [];
  const createdKeys = new Set();

  const safeSource = Array.isArray(sourceStats) && sourceStats.length ? sourceStats : [];

  for (let i = 0; i < count; i += 1) {
    let strategyKey = '';

    if (safeSource.length >= 2) {
      const a = randomPick(safeSource)?.strategy_key || '';
      const b = randomPick(safeSource)?.strategy_key || '';
      strategyKey = mixGenes(a, b);

      if (!strategyKey || existingKeys.has(strategyKey) || createdKeys.has(strategyKey)) {
        strategyKey = mutateGene(a || b || 'mix_zone');
      }
    } else if (safeSource.length === 1) {
      strategyKey = mutateGene(safeSource[0]?.strategy_key || 'mix_zone');
    } else {
      strategyKey = mutateGene('mix_zone');
    }

    strategyKey = normalizeKey(strategyKey);

    if (!strategyKey) continue;
    if (existingKeys.has(strategyKey)) continue;
    if (createdKeys.has(strategyKey)) continue;

    const genes = splitGenes(strategyKey);
    const nowIso = new Date().toISOString();

    rows.push({
      strategy_key: strategyKey,
      strategy_name: buildStrategyName(strategyKey),
      gene_a: genes.gene_a,
      gene_b: genes.gene_b,
      parameters: {
        mode: 'evolution_v2',
        createdBy: 'strategyEvolutionEngine'
      },
      generation: 2,
      source_type: 'evolved',
      parent_keys: safeSource.length >= 2
        ? unique([
            randomPick(safeSource)?.strategy_key || '',
            randomPick(safeSource)?.strategy_key || ''
          ])
        : unique([safeSource[0]?.strategy_key || '']),
      status: 'active',
      protected_rank: false,
      incubation_until_draw: 0,
      created_draw_no: 0,
      created_at: nowIso,
      updated_at: nowIso
    });

    createdKeys.add(strategyKey);
  }

  return rows;
}

export async function evolveStrategies() {
  const { data: stats, error: statsError } = await supabase
    .from('strategy_stats')
    .select('*');

  if (statsError) {
    throw statsError;
  }

  if (!Array.isArray(stats) || stats.length === 0) {
    return {
      ok: true,
      disabled_count: 0,
      inserted_count: 0,
      updated_count: 0
    };
  }

  const enriched = stats.map((row) => {
    const totalRounds = toNum(row.total_rounds, 0);
    const totalProfit = toNum(row.total_profit, 0);
    const avgHit = toNum(row.avg_hit, 0);
    const hitRate = toNum(row.hit_rate, 0);
    const profitPerRound = totalRounds > 0 ? totalProfit / totalRounds : -999999;

    return {
      ...row,
      total_rounds: totalRounds,
      total_profit: totalProfit,
      avg_hit: avgHit,
      hit_rate: hitRate,
      profit_per_round: profitPerRound
    };
  });

  const toDisable = enriched.filter(
    (s) =>
      s.total_rounds >= 10 &&
      (s.total_profit < 0 || s.profit_per_round <= -10)
  );

  const winners = enriched
    .filter(
      (s) =>
        s.total_rounds >= 3 &&
        s.avg_hit >= 2 &&
        s.profit_per_round > -20
    )
    .sort((a, b) => {
      if (b.profit_per_round !== a.profit_per_round) {
        return b.profit_per_round - a.profit_per_round;
      }
      if (b.avg_hit !== a.avg_hit) {
        return b.avg_hit - a.avg_hit;
      }
      return b.total_rounds - a.total_rounds;
    });

  const fallback = enriched
    .filter((s) => s.total_rounds >= 1)
    .sort((a, b) => {
      if (b.avg_hit !== a.avg_hit) {
        return b.avg_hit - a.avg_hit;
      }
      return b.total_rounds - a.total_rounds;
    });

  const sourceStats = winners.length > 0 ? winners : fallback;

  const { data: poolRows, error: poolError } = await supabase
    .from('strategy_pool')
    .select('*');

  if (poolError) {
    throw poolError;
  }

  const existingPool = Array.isArray(poolRows) ? poolRows : [];
  const existingKeySet = new Set(
    existingPool.map((row) => normalizeKey(row.strategy_key))
  );

  let disabledCount = 0;
  const nowIso = new Date().toISOString();

  if (toDisable.length > 0) {
    const disableKeys = toDisable
      .map((s) => normalizeKey(s.strategy_key))
      .filter(Boolean);

    if (disableKeys.length > 0) {
      const { data: disabledRows, error: disableError } = await supabase
        .from('strategy_pool')
        .update({
          status: 'disabled',
          updated_at: nowIso
        })
        .in('strategy_key', disableKeys)
        .neq('status', 'disabled')
        .select('strategy_key');

      if (disableError) {
        throw disableError;
      }

      disabledCount = Array.isArray(disabledRows) ? disabledRows.length : 0;
    }
  }

  const rowsToInsert = buildEvolvedRows(sourceStats, existingKeySet, 6);

  let insertedCount = 0;

  if (rowsToInsert.length > 0) {
    const { data: insertedRows, error: insertError } = await supabase
      .from('strategy_pool')
      .insert(rowsToInsert)
      .select('strategy_key');

    if (insertError) {
      throw insertError;
    }

    insertedCount = Array.isArray(insertedRows) ? insertedRows.length : 0;
  }

  const updateTargets = existingPool
    .filter((row) => {
      const key = normalizeKey(row.strategy_key);
      return sourceStats.some((s) => normalizeKey(s.strategy_key) === key);
    })
    .slice(0, 12);

  let updatedCount = 0;

  for (const row of updateTargets) {
    const patch = {
      updated_at: new Date().toISOString()
    };

    if (row.status !== 'active') {
      patch.status = 'active';
    }

    if (!row.source_type) {
      patch.source_type = 'seed';
    }

    const { error: updateError } = await supabase
      .from('strategy_pool')
      .update(patch)
      .eq('strategy_key', row.strategy_key);

    if (updateError) {
      throw updateError;
    }

    updatedCount += 1;
  }

  return {
    ok: true,
    source_count: sourceStats.length,
    disabled_count: disabledCount,
    inserted_count: insertedCount,
    updated_count: updatedCount
  };
}
