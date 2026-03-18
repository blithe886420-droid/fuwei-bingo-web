import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
  const { data: stats } = await supabase
    .from('strategy_stats')
    .select('*');

  if (!stats?.length) return;

  const good = stats.filter(s => s.total_rounds >= 2 && s.avg_hit >= 1);
  const bad  = stats.filter(s => s.total_rounds >= 2 && s.avg_hit < 0.5);

  if (bad.length) {
    await supabase
      .from('strategy_pool')
      .update({ status: 'inactive' })
      .in('strategy_key', bad.map(b => b.strategy_key));
  }

  const source = good.length ? good : stats;

  const newStrategies = [];

  for (let i = 0; i < 8; i++) {
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
