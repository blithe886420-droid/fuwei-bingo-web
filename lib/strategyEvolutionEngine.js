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
  // 🔒 防止沒資料直接跑
  const { data: stats } = await supabase
    .from('strategy_stats')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(200);

  if (!stats?.length) return;

  // ⭐ 修正門檻（你卡死的關鍵）
  const good = stats.filter(s => s.total_runs >= 2 && s.avg_roi >= -10);
  const bad  = stats.filter(s => s.total_runs >= 2 && s.avg_roi < -80);

  // ❌ 淘汰（你原本沒生效）
  if (bad.length) {
    await supabase
      .from('strategy_pool')
      .update({ status: 'inactive' })
      .in('strategy_key', bad.map(b => b.strategy_key));
  }

  // 🔥 強制至少有種子
  const basePool = good.length ? good : stats;

  const newStrategies = [];

  for (let i = 0; i < 8; i++) {
    let key;

    if (basePool.length >= 2) {
      const a = randomPick(basePool).strategy_key;
      const b = randomPick(basePool).strategy_key;
      key = mixGenes(a, b);
    } else {
      key = mutateGene(randomPick(basePool).strategy_key);
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

  // ✅ 批次寫入（重點修正）
  await supabase
    .from('strategy_pool')
    .upsert(newStrategies, { onConflict: 'strategy_key' });

}
