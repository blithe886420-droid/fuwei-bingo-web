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

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function mixGenes(a, b) {
  const aParts = String(a).split('_');
  const bParts = String(b).split('_');

  return `${randomPick(aParts)}_${randomPick(bParts)}`;
}

function mutateGene(key) {
  const pool = [
    'hot','cold','warm',
    'zone','tail','mix',
    'repeat','chase',
    'jump','guard',
    'balance','pattern',
    'structure','split'
  ];

  const parts = String(key).split('_');

  if (Math.random() < 0.5) {
    parts[0] = randomPick(pool);
  } else {
    parts[1] = randomPick(pool);
  }

  return parts.join('_');
}

export async function evolveStrategies() {
  const { data: stats, error } = await supabase
    .from('strategy_stats')
    .select('*');

  if (error || !stats?.length) return;

  // 👉 用「賺錢能力」判斷（核心升級🔥）
  const withScore = stats.map(s => {
    const rounds = Number(s.total_rounds || 0);
    const profit = Number(s.total_profit || 0);
    const profitPerRound = rounds > 0 ? profit / rounds : -999;

    return {
      ...s,
      profitPerRound
    };
  });

  const good = withScore.filter(s => s.total_rounds >= 2 && s.profitPerRound > 0);
  const bad  = withScore.filter(s => s.total_rounds >= 2 && s.profitPerRound < -5);

  // ❌ 淘汰爛策略
  if (bad.length) {
    await supabase
      .from('strategy_pool')
      .update({ status: 'inactive' })
      .in('strategy_key', bad.map(b => b.strategy_key));
  }

  const source = good.length ? good : withScore;

  const newStrategies = [];

  for (let i = 0; i < 6; i++) {
    let key;

    if (source.length >= 2) {
      const a = randomPick(source).strategy_key;
      const b = randomPick(source).strategy_key;
      key = mixGenes(a, b);
    } else {
      key = mutateGene(randomPick(source).strategy_key);
    }

    newStrategies.push({
      strategy_key: key,
      strategy_name: key,
      status: 'active',
      source_type: 'evolved',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  await supabase
    .from('strategy_pool')
    .upsert(newStrategies, { onConflict: 'strategy_key' });
}
