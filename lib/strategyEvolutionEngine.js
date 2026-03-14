import { createClient } from '@supabase/supabase-js';

const DEFAULT_EVOLUTION_EVERY = 30;
const DEFAULT_POOL_TARGET_SIZE = 20;
const DEFAULT_INCUBATION_DRAWS = 15;
const DEFAULT_ELIMINATION_COUNT = 2;
const DEFAULT_PROTECT_TOP_N = 2;
const EXPLORATION_RATIO = 0.3;

const BASE_GENE_POOL = [
  'hot','cold','warm','rebound','repeat','follow','chase','jump','skip',
  'tail','tail_shift',
  'zone','zone_balance','zone_rotation',
  'pattern','structure','split','mirror',
  'balance','mix','spread','cluster',
  'odd_even','big_small',
  'gap','sum',
  'guard','bounce','reverse'
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

function makeDisplayNameFromGenes(geneA = '', geneB = '') {

  const normalize = (text) =>
    String(text)
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');

  return `${normalize(geneA)} ${normalize(geneB)}`.trim();
}

function makeUniqueStrategyKey(baseKey, existingKeys) {

  const base = slugifyKey(baseKey);

  if (!existingKeys.has(base)) {
    existingKeys.add(base);
    return base;
  }

  let i = 2;
  let newKey = `${base}_${i}`;

  while (existingKeys.has(newKey)) {
    i += 1;
    newKey = `${base}_${i}`;
  }

  existingKeys.add(newKey);

  return newKey;
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

  const avgHit = toNum(row.avg_hit, 0);
  const roi = toNum(row.roi, 0);
  const recent50Roi = toNum(row.recent_50_roi, 0);
  const hit2 = toNum(row.hit2, 0);
  const hit3 = toNum(row.hit3, 0);
  const hit4 = toNum(row.hit4, 0);
  const totalRounds = toNum(row.total_rounds, 0);

  const explosionScore =
    hit2 * 5 +
    hit3 * 12 +
    hit4 * 25;

  const stabilityScore =
    avgHit * 60 +
    recent50Roi * 25 +
    roi * 5;

  const maturityBonus =
    totalRounds >= 30 ? 30 :
    totalRounds >= 15 ? 15 : 0;

  return Number(
    (explosionScore + stabilityScore + maturityBonus).toFixed(6)
  );
}

function isMaturedStrategy(row, currentDrawNo) {
  return currentDrawNo >= toNum(row.incubation_until_draw, 0);
}

function pickTwoDifferentGenes(pool = BASE_GENE_POOL) {

  const geneA = randomPick(pool) || 'hot';

  const secondPool = pool.filter((g) => g !== geneA);

  const geneB = randomPick(secondPool) || 'mix';

  return [geneA, geneB];
}

function buildCrossoverStrategy({ ranked, existingKeys, currentDrawNo, incubationDraws }) {

  const parentPool = ranked.slice(0, Math.min(6, ranked.length));

  const parentA = randomPick(parentPool) || ranked[0];

  const parentB =
    randomPick(parentPool.filter((p) => p.strategy_key !== parentA?.strategy_key)) ||
    parentPool[0] ||
    parentA;

  const parentGenes = unique([
    ...getStrategyGenes(parentA),
    ...getStrategyGenes(parentB)
  ]).filter(Boolean);

  let geneA =
    randomPick(parentGenes) ||
    randomPick(BASE_GENE_POOL) ||
    'hot';

  let geneB =
    randomPick(parentGenes.filter((g) => g !== geneA)) ||
    randomPick(BASE_GENE_POOL.filter((g) => g !== geneA)) ||
    'mix';

  if (!geneA || !geneB || geneA === geneB) {
    [geneA, geneB] = pickTwoDifferentGenes(BASE_GENE_POOL);
  }

  const strategyKey = makeUniqueStrategyKey(`${geneA}_${geneB}`, existingKeys);

  const parentGeneration = Math.max(
    toNum(parentA?.generation, 1),
    toNum(parentB?.generation, 1)
  );

  return {

    strategy_key: strategyKey,

    strategy_name: makeDisplayNameFromGenes(geneA, geneB),

    gene_a: geneA,
    gene_b: geneB,

    parameters: {
      mode: 'crossover_v5',
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

  let [geneA, geneB] = pickTwoDifferentGenes(BASE_GENE_POOL);

  const strategyKey = makeUniqueStrategyKey(`${geneA}_${geneB}`, existingKeys);

  const maxGeneration = Math.max(...ranked.map((r) => toNum(r.generation, 1)), 1);

  return {

    strategy_key: strategyKey,

    strategy_name: makeDisplayNameFromGenes(geneA, geneB),

    gene_a: geneA,
    gene_b: geneB,

    parameters: {
      mode: 'exploration_v5',
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
