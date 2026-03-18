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

  const geneA = randomPick(aParts);
  const geneB = randomPick(bParts);

  return `${geneA}_${geneB}`;
}

function mutateGene(key) {
  const pool = [
    'hot', 'cold', 'warm',
    'zone', 'tail', 'mix',
    'repeat', 'chase',
    'jump', 'guard',
    'balance', 'pattern',
    'structure', 'split'
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
  // 1️⃣ 抓所有 stats
  const { data: stats } = await supabase
    .from('strategy_stats')
    .select('*');

  if (!stats?.length) {
    console.log('⚠️ no stats');
    return;
  }

  // 2️⃣ 分類
  const good = stats.filter(s => s.total_runs >= 3 && s.avg_roi > 0);
  const bad = stats.filter(s => s.total_runs >= 3 && s.avg_roi < -50);

  console.log('🧠 good:', good.length, 'bad:', bad.length);

  // 3️⃣ 淘汰壞策略
  if (bad.length) {
    await supabase
      .from('strategy_pool')
      .update({ status: 'inactive' })
      .in('strategy_key', bad.map(b => b.strategy_key));
  }

  // 4️⃣ 產生新策略
  const newStrategies = [];

  for (let i = 0; i < 6; i++) {
    let key;

    if (good.length >= 2) {
      const a = randomPick(good).strategy_key;
      const b = randomPick(good).strategy_key;
      key = mixGenes(a, b);
    } else {
      key = mutateGene(randomPick(stats).strategy_key);
    }

    newStrategies.push({
      strategy_key: key,
      strategy_name: key,
      status: 'active',
      source_type: 'evolved',
      created_at: new Date().toISOString()
    });
  }

  // 5️⃣ 寫入（避免重複）
  for (const s of newStrategies) {
    await supabase
      .from('strategy_pool')
      .upsert(s, { onConflict: 'strategy_key' });
  }

  console.log('🚀 evolution done:', newStrategies.length);
}
