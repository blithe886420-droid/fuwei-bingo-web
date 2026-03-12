import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function shuffle(arr, seed) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = (seed + i * 13) % (i + 1)
    const tmp = a[i]
    a[i] = a[j]
    a[j] = tmp
  }
  return a
}

function hash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0
  }
  return h
}

function unique(arr) {
  return [...new Set(arr)]
}

function pick(nums, count) {
  return unique(nums).slice(0, count)
}

function buildRecentAnalysis(draws) {
  const freq = {}
  for (let i = 1; i <= 80; i++) freq[i] = 0

  for (const d of draws) {
    for (const n of d.numbers) {
      freq[n]++
    }
  }

  const sorted = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .map(v => Number(v[0]))

  return {
    hot: sorted.slice(0, 20),
    warm: sorted.slice(20, 40),
    cold: sorted.slice(40)
  }
}

function generateNumbers(strategy, analysis) {
  const seed = hash(strategy.strategy_key)

  let pool = []

  const a = strategy.gene_a || ''
  const b = strategy.gene_b || ''

  if (a === 'hot' || b === 'hot') {
    pool = pool.concat(analysis.hot)
  }

  if (a === 'warm' || b === 'warm') {
    pool = pool.concat(analysis.warm)
  }

  if (a === 'cold' || b === 'cold') {
    pool = pool.concat(analysis.cold)
  }

  if (a === 'balanced' || b === 'balanced') {
    pool = pool.concat(
      analysis.hot.slice(0, 5),
      analysis.warm.slice(0, 5),
      analysis.cold.slice(0, 5)
    )
  }

  if (a === 'mix' || b === 'mix') {
    pool = pool.concat(
      analysis.hot.slice(0, 6),
      analysis.warm.slice(0, 6),
      analysis.cold.slice(0, 6)
    )
  }

  if (a === 'zone' || b === 'zone') {
    pool = pool.concat(
      analysis.hot.filter(n => n <= 20),
      analysis.hot.filter(n => n > 20 && n <= 40),
      analysis.hot.filter(n => n > 40 && n <= 60),
      analysis.hot.filter(n => n > 60)
    )
  }

  if (a === 'bounce' || b === 'bounce') {
    pool = pool.concat(analysis.cold)
  }

  if (pool.length === 0) {
    pool = analysis.hot.concat(analysis.warm)
  }

  const shuffled = shuffle(pool, seed)

  return pick(shuffled, 4).sort((a, b) => a - b)
}

export default async function handler(req, res) {

  const { data: draws } = await supabase
    .from('bingo_draws')
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(20)

  const analysis = buildRecentAnalysis(draws)

  const { data: strategies } = await supabase
    .from('strategy_pool')
    .select('*')
    .eq('active', true)

  const groups = []

  for (const s of strategies.slice(0,4)) {

    const nums = generateNumbers(s, analysis)

    groups.push({
      key: s.strategy_key,
      label: s.strategy_name,
      nums
    })
  }

  const prediction = {
    draw_no: draws[0].draw_no,
    groups
  }

  await supabase
    .from('predictions')
    .insert(prediction)

  res.json({
    ok: true,
    groups
  })
}
