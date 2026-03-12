import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const MODE = "v4_explosion_engine"
const MAX_COMPARE_PER_RUN = 1
const MAX_CREATE_PER_RUN = 1

async function getConfig(key, def) {
  const { data } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", key)
    .single()

  if (!data) return def
  return parseInt(data.value)
}

async function buildLeaderboard(limit = 100) {
  const { data } = await supabase
    .from("strategy_stats")
    .select("*")
    .order("total_rounds", { ascending: false })

  if (!data) return []

  const leaderboard = []

  for (const stat of data) {
    const hit1 = stat.hit1_count || 0
    const hit2 = stat.hit2_count || 0
    const hit3 = stat.hit3_count || 0
    const hit4 = stat.hit4_count || 0

    const explosionScore =
      hit2 * 3 +
      hit3 * 8 +
      hit4 * 20

    const stabilityScore =
      (stat.avg_hit || 0) * 50 +
      (stat.avg_reward || 0) * 5

    const score = explosionScore + stabilityScore

    leaderboard.push({
      key: stat.strategy_key,
      label: stat.strategy_name,
      total_rounds: stat.total_rounds,

      avg_hit: stat.avg_hit,
      avg_reward: stat.avg_reward,
      avg_profit: stat.avg_profit,
      payout_rate: stat.payout_rate,
      profit_win_rate: stat.profit_win_rate,
      roi: stat.roi,

      hit1,
      hit2,
      hit3,
      hit4,

      best_hit: stat.best_hit,
      score
    })
  }

  leaderboard.sort((a, b) => b.score - a.score)

  return leaderboard.slice(0, limit)
}

async function maybeRunStrategyEvolution() {
  const evolutionEvery = await getConfig("strategy_evolution_every", 20)
  const poolTarget = await getConfig("strategy_pool_target_size", 8)

  const { data: latestDraw } = await supabase
    .from("bingo_draws")
    .select("draw_no")
    .order("draw_no", { ascending: false })
    .limit(1)
    .single()

  if (!latestDraw) {
    return { skipped: true }
  }

  const currentDrawNo = latestDraw.draw_no

  const { data: lastEvolution } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", "strategy_last_evolution_draw")
    .single()

  const lastEvolutionDraw = lastEvolution ? parseInt(lastEvolution.value) : 0

  if (currentDrawNo - lastEvolutionDraw < evolutionEvery) {
    return {
      ok: true,
      skipped: true,
      reason: "not_due_yet",
      currentDrawNo,
      lastEvolutionDraw,
      evolutionEvery
    }
  }

  const leaderboard = await buildLeaderboard(20)

  if (leaderboard.length === 0) {
    return { skipped: true }
  }

  const protect = leaderboard.slice(0, 2).map(s => s.key)

  const { data: pool } = await supabase
    .from("strategy_pool")
    .select("*")
    .eq("status", "active")

  const disableTargets = pool
    .filter(p => !protect.includes(p.strategy_key))
    .slice(-2)

  const disabled = []

  for (const d of disableTargets) {
    await supabase
      .from("strategy_pool")
      .update({ status: "disabled" })
      .eq("strategy_id", d.strategy_id)

    disabled.push(d.strategy_key)
  }

  const parentA = leaderboard[0]
  const parentB = leaderboard[1]

  const created = []

  for (let i = 0; i < 2; i++) {
    const newKey = "gen_" + Date.now() + "_" + i

    const newStrategy = {
      strategy_key: newKey,
      strategy_name: "AI Generated",
      source_type: "crossover",
      parent_keys: [parentA.key, parentB.key],
      parameters: {
        mode: "explosion_mix"
      },
      generation: 3,
      status: "active"
    }

    await supabase
      .from("strategy_pool")
      .insert(newStrategy)

    created.push(newKey)
  }

  await supabase
    .from("system_config")
    .upsert({
      key: "strategy_last_evolution_draw",
      value: currentDrawNo
    })

  return {
    ok: true,
    skipped: false,
    protected: protect,
    disabled,
    created
  }
}

export default async function handler(req, res) {

  const { data: latestDraw } = await supabase
    .from("bingo_draws")
    .select("draw_no")
    .order("draw_no", { ascending: false })
    .limit(1)
    .single()

  const latestDrawNo = latestDraw ? latestDraw.draw_no : 0

  const leaderboard = await buildLeaderboard(160)

  let evolutionResult = null

  try {
    evolutionResult = await maybeRunStrategyEvolution()
    console.log("strategy evolution result:", evolutionResult)
  } catch (err) {
    console.error("maybeRunStrategyEvolution error:", err.message)
  }

  return res.status(200).json({
    ok: true,
    mode: MODE,
    latest_draw_no: latestDrawNo,
    compare_limit: MAX_COMPARE_PER_RUN,
    create_limit: MAX_CREATE_PER_RUN,
    leaderboard,
    evolution_result: evolutionResult
  })
}
