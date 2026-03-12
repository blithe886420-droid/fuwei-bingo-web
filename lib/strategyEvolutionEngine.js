import { createClient } from '@supabase/supabase-js';

const DEFAULT_EVOLUTION_EVERY = 30;
const DEFAULT_POOL_TARGET_SIZE = 8;
const DEFAULT_INCUBATION_DRAWS = 15;
const DEFAULT_ELIMINATION_COUNT = 2;
const DEFAULT_PROTECT_TOP_N = 2;
const EXPLORATION_RATIO = 0.3;

const BASE_GENE_POOL = [
  'hot',
  'rebound',
  'zone',
  'pattern',
  'tail',
  'warm',
  'repeat',
  'cold',
  'balance',
  'mix',
  'guard',
  'jump',
  'follow',
  'structure',
  'split',
  'chase'
];

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase env for strategyEvolutionEngine');
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function randomPick(arr = []) {
  if (!arr.length) return null;
  return arr[randomInt(arr.length)];
}

function unique(arr = []) {
  return [...new Set(arr.filter(Boolean))];
}

function slugifyKey(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function makeDisplayNameFromKey(key = '') {
  return key
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function makeUniqueStrategyKey(baseKey, existingKeys) {
  let nextKey = slugifyKey(baseKey);

  if (!existingKeys.has(nextKey)) {
    existingKeys.add(nextKey);
    return nextKey;
  }

  let i = 2;
  while (existingKeys.has(`${nextKey}_${i}`)) {
    i += 1;
  }

  const finalKey = `${nextKey}_${i}`;
  existingKeys.add(finalKey);
  return finalKey;
}

function getStrategyGenes(strategy) {
  return unique([
    strategy?.gene_a,
    strategy?.gene_b
  ]);
}

function shouldUseExploration() {
  return Math.random() < EXPLORATION_RATIO;
}

function calculateEvolutionScore(row) {
  const recent50Roi = toNum(row.recent_50_roi, 0);
  const roi = toNum(row.roi, 0);
  const avgHit = toNum(row.avg_hit, 0);
  const recent50HitRate = toNum(row.recent_50_hit_rate, 0);
  const totalRounds = toNum(row.total_rounds, 0);

  const stabilityBonus = totalRounds >= 30 ? 0.12 : totalRounds >= 15 ? 0.05 : 0;
  const score =
    recent50Roi * 0.55 +
    roi * 0.15 +
    avgHit * 0.20 +
    recent50HitRate * 0.10 +
    stabilityBonus;

  return Number(score.toFixed(6));
}

function isMaturedStrategy(row, currentDrawNo) {
  return currentDrawNo >= toNum(row.incubation_until_draw, 0);
}

function buildCrossoverStrategy({ ranked, existingKeys, currentDrawNo, incubationDraws }) {
  const parentPool = ranked.slice(0, Math.min(6, ranked.length));
  const parentA = randomPick(parentPool);
  const parentB =
    randomPick(parentPool.filter((p) => p.strategy_key !== parentA?.strategy_key)) || parentA;

  const parentGenes = unique([
    ...getStrategyGenes(parentA),
    ...getStrategyGenes(parentB)
  ]);

  const geneA = randomPick(parentGenes) || randomPick(BASE_GENE_POOL);
  const geneB =
    randomPick(parentGenes.filter((g) => g !== geneA)) ||
    randomPick(BASE_GENE_POOL.filter((g) => g !== geneA)) ||
    'mix';

  const strategyKey = makeUniqueStrategyKey(`${geneA}_${geneB}`, existingKeys);
  const parentGeneration = Math.max(
    toNum(parentA?.generation, 1),
    toNum(parentB?.generation, 1)
  );

  return {
    strategy_key: strategyKey,
    strategy_name: makeDisplayNameFromKey(strategyKey),
    gene_a: geneA,
    gene_b: geneB,
    parameters: {
      mode: 'crossover_fast_v2',
      createdBy: 'strategyEvolutionEngine'
    },
    generation: parentGeneration + 1,
    source_type: 'crossover',
    parent_keys: [parentA?.strategy_key, parentB?.strategy_key].filter(Boolean),
    status: 'active',
    protected_rank: false,
    incubation_until_draw: currentDrawNo + incubationDraws,
    created_draw_no: currentDrawNo
  };
}

function buildExplorationStrategy({ existingKeys, currentDrawNo, ranked, incubationDraws }) {
  const geneA = randomPick(BASE_GENE_POOL);
  const geneB =
    randomPick(BASE_GENE_POOL.filter((g) => g !== geneA)) || 'mix';

  const strategyKey = makeUniqueStrategyKey(`${geneA}_${geneB}`, existingKeys);
  const maxGeneration = Math.max(...ranked.map((r) => toNum(r.generation, 1)), 1);

  return {
    strategy_key: strategyKey,
    strategy_name: makeDisplayNameFromKey(strategyKey),
    gene_a: geneA,
    gene_b: geneB,
    parameters: {
      mode: 'exploration_fast_v2',
      createdBy: 'strategyEvolutionEngine'
    },
    generation: maxGeneration + 1,
    source_type: 'exploration',
    parent_keys: [],
    status: 'active',
    protected_rank: false,
    incubation_until_draw: currentDrawNo + incubationDraws,
    created_draw_no: currentDrawNo
  };
}

async function getConfigMap(supabase) {
  const { data, error } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', [
      'strategy_last_evolution_draw',
      'strategy_pool_target_size',
      'strategy_evolution_every',
      'strategy_incubation_draws',
      'strategy_elimination_count',
      'strategy_protect_top_n'
    ]);

  if (error) throw error;

  const map = {};
  for (const row of data || []) {
    map[row.key] = row.value;
  }

  return map;
}

async function getLatestObservedDrawNo(supabase) {
  const { data, error } = await supabase
    .from('strategy_stats')
    .select('last_result_draw_no')
    .order('last_result_draw_no', { ascending: false })
    .limit(1);

  if (error) throw error;

  return toNum(data?.[0]?.last_result_draw_no, 0);
}

async function clearActiveProtectionFlags(supabase) {
  const { error } = await supabase
    .from('strategy_pool')
    .update({
      protected_rank: false,
      updated_at: new Date().toISOString()
    })
    .eq('status', 'active');

  if (error) throw error;
}

async function setProtectedStrategies(supabase, strategyKeys = []) {
  if (!strategyKeys.length) return;

  const { error } = await supabase
    .from('strategy_pool')
    .update({
      protected_rank: true,
      updated_at: new Date().toISOString()
    })
    .in('strategy_key', strategyKeys);

  if (error) throw error;
}

export async function maybeRunStrategyEvolution() {
  const supabase = getSupabase();
  const configMap = await getConfigMap(supabase);

  const currentDrawNo = await getLatestObservedDrawNo(supabase);
  if (!currentDrawNo) {
    return { ok: true, skipped: true, reason: 'no_observed_draw' };
  }

  const lastEvolutionDraw = toNum(configMap.strategy_last_evolution_draw, 0);
  const evolutionEvery = toNum(
    configMap.strategy_evolution_every,
    DEFAULT_EVOLUTION_EVERY
  );
  const targetSize = toNum(
    configMap.strategy_pool_target_size,
    DEFAULT_POOL_TARGET_SIZE
  );
  const incubationDraws = toNum(
    configMap.strategy_incubation_draws,
    DEFAULT_INCUBATION_DRAWS
  );
  const eliminationCount = toNum(
    configMap.strategy_elimination_count,
    DEFAULT_ELIMINATION_COUNT
  );
  const protectTopN = toNum(
    configMap.strategy_protect_top_n,
    DEFAULT_PROTECT_TOP_N
  );

  if (currentDrawNo - lastEvolutionDraw < evolutionEvery) {
    return {
      ok: true,
      skipped: true,
      reason: 'not_due_yet',
      currentDrawNo,
      lastEvolutionDraw,
      evolutionEvery
    };
  }

  const { data: activePool, error: poolError } = await supabase
    .from('strategy_pool')
    .select('*')
    .eq('status', 'active');

  if (poolError) throw poolError;

  const activeStrategies = activePool || [];
  if (!activeStrategies.length) {
    return { ok: true, skipped: true, reason: 'no_active_strategies' };
  }

  const activeKeys = activeStrategies.map((row) => row.strategy_key);

  const { data: statsRows, error: statsError } = await supabase
    .from('strategy_stats')
    .select('*')
    .in('strategy_key', activeKeys);

  if (statsError) throw statsError;

  const statsMap = new Map((statsRows || []).map((row) => [row.strategy_key, row]));

  const ranked = activeStrategies
    .map((poolRow) => {
      const stat = statsMap.get(poolRow.strategy_key) || {};
      return {
        ...poolRow,
        ...stat,
        evolution_score: calculateEvolutionScore({
          ...poolRow,
          ...stat
        })
      };
    })
    .sort((a, b) => b.evolution_score - a.evolution_score);

  const protectedStrategies = ranked.slice(0, Math.min(protectTopN, ranked.length));
  const protectedKeys = protectedStrategies.map((row) => row.strategy_key);

  await clearActiveProtectionFlags(supabase);
  await setProtectedStrategies(supabase, protectedKeys);

  const maturedCandidates = ranked.filter(
    (row) =>
      !protectedKeys.includes(row.strategy_key) &&
      isMaturedStrategy(row, currentDrawNo)
  );

  const actualEliminationCount = Math.min(eliminationCount, maturedCandidates.length);
  const worstStrategies = maturedCandidates.slice(-actualEliminationCount);

  const historyRows = [];

  if (worstStrategies.length) {
    const disableKeys = worstStrategies.map((row) => row.strategy_key);

    const { error: disableError } = await supabase
      .from('strategy_pool')
      .update({
        status: 'disabled',
        protected_rank: false,
        updated_at: new Date().toISOString()
      })
      .in('strategy_key', disableKeys);

    if (disableError) throw disableError;

    historyRows.push(
      ...worstStrategies.map((row) => ({
        strategy_key: row.strategy_key,
        event_type: 'disabled',
        note: 'auto disabled by fast evolution engine',
        payload: {
          currentDrawNo,
          evolution_score: row.evolution_score,
          recent_50_roi: toNum(row.recent_50_roi, 0),
          recent_50_hit_rate: toNum(row.recent_50_hit_rate, 0),
          total_rounds: toNum(row.total_rounds, 0)
        }
      }))
    );
  }

  const { data: alivePoolAfterDisable, error: aliveError } = await supabase
    .from('strategy_pool')
    .select('*')
    .eq('status', 'active');

  if (aliveError) throw aliveError;

  const aliveCount = (alivePoolAfterDisable || []).length;
  const needCreate = Math.max(0, targetSize - aliveCount);

  const existingKeys = new Set([
    ...ranked.map((r) => r.strategy_key),
    ...(alivePoolAfterDisable || []).map((r) => r.strategy_key)
  ]);

  const createdStrategies = [];

  for (let i = 0; i < needCreate; i += 1) {
    const next = shouldUseExploration()
      ? buildExplorationStrategy({
          existingKeys,
          currentDrawNo,
          ranked,
          incubationDraws
        })
      : buildCrossoverStrategy({
          ranked,
          existingKeys,
          currentDrawNo,
          incubationDraws
        });

    createdStrategies.push(next);
  }

  if (createdStrategies.length) {
    const { error: insertPoolError } = await supabase
      .from('strategy_pool')
      .insert(
        createdStrategies.map((row) => ({
          ...row,
          parameters: row.parameters || {},
          parent_keys: row.parent_keys || [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }))
      );

    if (insertPoolError) throw insertPoolError;

    const { error: insertStatsError } = await supabase
      .from('strategy_stats')
      .insert(
        createdStrategies.map((row) => ({
          strategy_key: row.strategy_key,
          total_rounds: 0,
          total_hits: 0,
          hit0: 0,
          hit1: 0,
          hit2: 0,
          hit3: 0,
          hit4: 0,
          avg_hit: 0,
          hit_rate: 0,
          total_profit: 0,
          roi: 0,
          recent_hits: [],
          recent_profit: [],
          recent_50_hit_rate: 0,
          recent_50_roi: 0,
          last_result_draw_no: currentDrawNo,
          last_updated: new Date().toISOString()
        }))
      );

    if (insertStatsError) throw insertStatsError;

    historyRows.push(
      ...createdStrategies.map((row) => ({
        strategy_key: row.strategy_key,
        event_type: 'created',
        note: 'auto created by fast evolution engine',
        payload: {
          currentDrawNo,
          source_type: row.source_type,
          generation: row.generation,
          parent_keys: row.parent_keys,
          gene_a: row.gene_a,
          gene_b: row.gene_b,
          incubation_until_draw: row.incubation_until_draw
        }
      }))
    );
  }

  if (historyRows.length) {
    const { error: historyError } = await supabase
      .from('strategy_history')
      .insert(historyRows);

    if (historyError) throw historyError;
  }

  const { error: configUpdateError } = await supabase
    .from('system_config')
    .upsert(
      {
        key: 'strategy_last_evolution_draw',
        value: String(currentDrawNo)
      },
      { onConflict: 'key' }
    );

  if (configUpdateError) throw configUpdateError;

  const { data: finalActivePool, error: finalPoolError } = await supabase
    .from('strategy_pool')
    .select('strategy_key, status, generation, source_type, protected_rank')
    .eq('status', 'active');

  if (finalPoolError) throw finalPoolError;

  return {
    ok: true,
    skipped: false,
    currentDrawNo,
    protected: protectedKeys,
    disabled: worstStrategies.map((row) => row.strategy_key),
    created: createdStrategies.map((row) => row.strategy_key),
    active_count: (finalActivePool || []).length
  };
}
