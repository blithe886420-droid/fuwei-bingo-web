import { createClient } from "@supabase/supabase-js";

const EXPLORATION_RATIO = 0.3;
const DEFAULT_EVOLUTION_EVERY = 50;
const DEFAULT_POOL_TARGET_SIZE = 8;
const DEFAULT_INCUBATION_DRAWS = 30;
const BASE_GENE_POOL = [
  "hot",
  "rebound",
  "zone",
  "pattern",
  "tail",
  "warm",
  "repeat",
  "cold",
  "balance",
  "mix",
  "guard",
  "jump",
  "follow",
  "structure",
  "split",
  "chase"
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
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Missing Supabase env for strategyEvolutionEngine");
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

function slugifyKey(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function makeDisplayNameFromKey(key = "") {
  return key
    .split("_")
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
  const genes = unique([
    strategy?.gene_a,
    strategy?.gene_b,
    ...(Array.isArray(strategy?.parent_keys) ? strategy.parent_keys : [])
  ]);

  if (genes.length) return genes;

  return unique(String(strategy?.strategy_key || "").split("_"));
}

function calculateEvolutionScore(row) {
  const recent50Roi = toNum(row.recent_50_roi, 0);
  const roi = toNum(row.roi, 0);
  const avgHit = toNum(row.avg_hit, 0);
  const recent50HitRate = toNum(row.recent_50_hit_rate, 0);
  const totalRounds = toNum(row.total_rounds, 0);

  const stabilityBonus = totalRounds >= 20 ? 0.08 : 0;
  const score =
    recent50Roi * 0.5 +
    roi * 0.2 +
    avgHit * 0.2 +
    recent50HitRate * 0.1 +
    stabilityBonus;

  return Number(score.toFixed(6));
}

function isMaturedStrategy(row, currentDrawNo) {
  return currentDrawNo >= toNum(row.incubation_until_draw, 0);
}

function shouldUseExploration() {
  return Math.random() < EXPLORATION_RATIO;
}

function buildCrossoverStrategy({ ranked, existingKeys, currentDrawNo }) {
  const topParents = ranked.slice(0, Math.min(4, ranked.length));
  const parentA = randomPick(topParents);
  const parentB = randomPick(topParents.filter(p => p.strategy_key !== parentA?.strategy_key)) || parentA;

  const parentGenes = unique([
    ...getStrategyGenes(parentA),
    ...getStrategyGenes(parentB)
  ]);

  const pickedGenes = unique([
    randomPick(parentGenes),
    randomPick(parentGenes.filter(g => g !== parentGenes[0])) || randomPick(BASE_GENE_POOL)
  ]).slice(0, 2);

  while (pickedGenes.length < 2) {
    const nextGene = randomPick(BASE_GENE_POOL);
    if (!pickedGenes.includes(nextGene)) pickedGenes.push(nextGene);
  }

  const baseKey = `${pickedGenes[0]}_${pickedGenes[1]}`;
  const strategyKey = makeUniqueStrategyKey(baseKey, existingKeys);

  const parentGeneration = Math.max(
    toNum(parentA?.generation, 1),
    toNum(parentB?.generation, 1)
  );

  return {
    strategy_key: strategyKey,
    strategy_name: makeDisplayNameFromKey(strategyKey),
    gene_a: pickedGenes[0],
    gene_b: pickedGenes[1],
    parameters: {
      mode: "crossover_70_30",
      createdBy: "strategyEvolutionEngine"
    },
    generation: parentGeneration + 1,
    source_type: "crossover",
    parent_keys: [parentA?.strategy_key, parentB?.strategy_key].filter(Boolean),
    status: "active",
    protected_rank: false,
    incubation_until_draw: currentDrawNo + DEFAULT_INCUBATION_DRAWS,
    created_draw_no: currentDrawNo
  };
}

function buildExplorationStrategy({ existingKeys, currentDrawNo, ranked }) {
  const geneA = randomPick(BASE_GENE_POOL);
  let geneB = randomPick(BASE_GENE_POOL.filter(g => g !== geneA));

  if (!geneB) geneB = "mix";

  const baseKey = `${geneA}_${geneB}`;
  const strategyKey = makeUniqueStrategyKey(baseKey, existingKeys);
  const maxGeneration = Math.max(...ranked.map(r => toNum(r.generation, 1)), 1);

  return {
    strategy_key: strategyKey,
    strategy_name: makeDisplayNameFromKey(strategyKey),
    gene_a: geneA,
    gene_b: geneB,
    parameters: {
      mode: "exploration_70_30",
      createdBy: "strategyEvolutionEngine"
    },
    generation: maxGeneration + 1,
    source_type: "exploration",
    parent_keys: [],
    status: "active",
    protected_rank: false,
    incubation_until_draw: currentDrawNo + DEFAULT_INCUBATION_DRAWS,
    created_draw_no: currentDrawNo
  };
}

async function getConfigMap(supabase) {
  const { data, error } = await supabase
    .from("system_config")
    .select("key, value")
    .in("key", [
      "strategy_last_evolution_draw",
      "strategy_pool_target_size",
      "strategy_evolution_every",
      "strategy_incubation_draws"
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
    .from("strategy_stats")
    .select("last_result_draw_no")
    .order("last_result_draw_no", { ascending: false })
    .limit(1);

  if (error) throw error;

  return toNum(data?.[0]?.last_result_draw_no, 0);
}

export async function maybeRunStrategyEvolution() {
  const supabase = getSupabase();
  const configMap = await getConfigMap(supabase);

  const currentDrawNo = await getLatestObservedDrawNo(supabase);
  if (!currentDrawNo) {
    return { ok: true, skipped: true, reason: "no_observed_draw" };
  }

  const lastEvolutionDraw = toNum(configMap.strategy_last_evolution_draw, 0);
  const evolutionEvery = toNum(configMap.strategy_evolution_every, DEFAULT_EVOLUTION_EVERY);
  const targetSize = toNum(configMap.strategy_pool_target_size, DEFAULT_POOL_TARGET_SIZE);
  const incubationDraws = toNum(configMap.strategy_incubation_draws, DEFAULT_INCUBATION_DRAWS);

  if (currentDrawNo - lastEvolutionDraw < evolutionEvery) {
    return {
      ok: true,
      skipped: true,
      reason: "not_due_yet",
      currentDrawNo,
      lastEvolutionDraw,
      evolutionEvery
    };
  }

  const { data: activePool, error: poolError } = await supabase
    .from("strategy_pool")
    .select("*")
    .eq("status", "active");

  if (poolError) throw poolError;

  const activeKeys = (activePool || []).map(row => row.strategy_key);

  const { data: statsRows, error: statsError } = await supabase
    .from("strategy_stats")
    .select("*")
    .in("strategy_key", activeKeys);

  if (statsError) throw statsError;

  const statsMap = new Map((statsRows || []).map(row => [row.strategy_key, row]));

  const ranked = (activePool || [])
    .map(poolRow => {
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

  if (!ranked.length) {
    return { ok: true, skipped: true, reason: "no_active_strategies" };
  }

  const champion = ranked[0];

  await supabase
    .from("strategy_pool")
    .update({ protected_rank: false, updated_at: new Date().toISOString() })
    .eq("status", "active");

  await supabase
    .from("strategy_pool")
    .update({ protected_rank: true, updated_at: new Date().toISOString() })
    .eq("strategy_key", champion.strategy_key);

  const matureCandidates = ranked.filter(
    row =>
      row.strategy_key !== champion.strategy_key &&
      isMaturedStrategy(row, currentDrawNo)
  );

  const eliminationCount = Math.min(2, matureCandidates.length);
  const worstTwo = matureCandidates.slice(-eliminationCount);

  if (!worstTwo.length) {
    await supabase.from("system_config").upsert(
      {
        key: "strategy_last_evolution_draw",
        value: String(currentDrawNo)
      },
      { onConflict: "key" }
    );

    return {
      ok: true,
      skipped: true,
      reason: "no_mature_candidates",
      currentDrawNo
    };
  }

  const disableKeys = worstTwo.map(row => row.strategy_key);

  const { error: disableError } = await supabase
    .from("strategy_pool")
    .update({
      status: "disabled",
      protected_rank: false,
      updated_at: new Date().toISOString()
    })
    .in("strategy_key", disableKeys);

  if (disableError) throw disableError;

  const historyRows = worstTwo.map(row => ({
    strategy_key: row.strategy_key,
    event_type: "disabled",
    note: "auto disabled by strategy evolution",
    payload: {
      currentDrawNo,
      evolution_score: row.evolution_score,
      recent_50_roi: toNum(row.recent_50_roi, 0),
      recent_50_hit_rate: toNum(row.recent_50_hit_rate, 0),
      total_rounds: toNum(row.total_rounds, 0)
    }
  }));

  const aliveCount = ranked.length - worstTwo.length;
  const needCreate = Math.max(0, targetSize - aliveCount);

  const existingKeys = new Set([
    ...ranked.map(r => r.strategy_key),
    ...disableKeys
  ]);

  const createdStrategies = [];

  for (let i = 0; i < needCreate; i += 1) {
    const next = shouldUseExploration()
      ? buildExplorationStrategy({ existingKeys, currentDrawNo, ranked })
      : buildCrossoverStrategy({ ranked, existingKeys, currentDrawNo });

    next.incubation_until_draw = currentDrawNo + incubationDraws;
    createdStrategies.push(next);
  }

  if (createdStrategies.length) {
    const insertRows = createdStrategies.map(row => ({
      ...row,
      parameters: row.parameters || {},
      parent_keys: row.parent_keys || [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));

    const { error: insertPoolError } = await supabase
      .from("strategy_pool")
      .insert(insertRows);

    if (insertPoolError) throw insertPoolError;

    const { error: insertStatsError } = await supabase
      .from("strategy_stats")
      .insert(
        createdStrategies.map(row => ({
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
      ...createdStrategies.map(row => ({
        strategy_key: row.strategy_key,
        event_type: "created",
        note: "auto created by strategy evolution",
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
      .from("strategy_history")
      .insert(historyRows);

    if (historyError) throw historyError;
  }

  const { error: configUpdateError } = await supabase
    .from("system_config")
    .upsert(
      {
        key: "strategy_last_evolution_draw",
        value: String(currentDrawNo)
      },
      { onConflict: "key" }
    );

  if (configUpdateError) throw configUpdateError;

  return {
    ok: true,
    skipped: false,
    currentDrawNo,
    champion: champion.strategy_key,
    disabled: disableKeys,
    created: createdStrategies.map(s => s.strategy_key)
  };
}
