export async function evolveStrategies() {
  const { data: stats } = await supabase
    .from('strategy_stats')
    .select('*');

  if (!stats?.length) return;

  // =========================
  // 🧠 STEP 1：計算價值指標
  // =========================
  const enriched = stats.map(s => {
    const rounds = Number(s.total_rounds || 0);
    const profit = Number(s.total_profit || 0);

    return {
      ...s,
      profit_per_round: rounds > 0 ? profit / rounds : -999
    };
  });

  // =========================
  // ❌ STEP 2：淘汰垃圾策略
  // =========================
  const toKill = enriched.filter(s =>
    s.total_rounds >= 50 &&
    s.total_profit < 0
  );

  if (toKill.length) {
    await supabase
      .from('strategy_pool')
      .update({ status: 'inactive' })
      .in('strategy_key', toKill.map(s => s.strategy_key));
  }

  // =========================
  // ✅ STEP 3：選出強者（只用會賺錢的）
  // =========================
  const winners = enriched
    .filter(s =>
      s.total_rounds >= 20 &&
      s.profit_per_round > 0
    )
    .sort((a, b) => b.profit_per_round - a.profit_per_round);

  // fallback（避免沒有策略）
  const fallback = enriched
    .filter(s => s.total_rounds >= 5)
    .sort((a, b) => b.avg_hit - a.avg_hit);

  const geneSource = winners.length >= 2 ? winners : fallback;

  if (!geneSource.length) return;

  // =========================
  // 🧬 STEP 4：基因權重（重點🔥）
  // =========================
  const preferredGenes = ['mix', 'zone'];     // 💰 目前實證有效
  const avoidGenes = ['hot', 'balanced'];     // ❌ 會虧錢

  function biasGene(gene) {
    if (preferredGenes.includes(gene)) return gene;

    if (avoidGenes.includes(gene) && Math.random() < 0.7) {
      return randomPick(preferredGenes);
    }

    return gene;
  }

  function smartMix(a, b) {
    const aParts = String(a).split('_');
    const bParts = String(b).split('_');

    const g1 = biasGene(randomPick(aParts));
    const g2 = biasGene(randomPick(bParts));

    return `${g1}_${g2}`;
  }

  function smartMutate(key) {
    const pool = [
      'mix','zone','tail','guard','jump',
      'repeat','chase','structure','pattern','split'
    ];

    const parts = String(key).split('_');

    if (Math.random() < 0.5) {
      parts[0] = randomPick(pool);
    } else {
      parts[1] = randomPick(pool);
    }

    return parts.join('_');
  }

  // =========================
  // 🚀 STEP 5：產生新策略
  // =========================
  const newStrategies = [];

  for (let i = 0; i < 6; i++) {
    let key;

    if (geneSource.length >= 2) {
      const a = randomPick(geneSource).strategy_key;
      const b = randomPick(geneSource).strategy_key;
      key = smartMix(a, b);
    } else {
      key = smartMutate(randomPick(geneSource).strategy_key);
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

  // =========================
  // 💾 STEP 6：寫入策略池
  // =========================
  await supabase
    .from('strategy_pool')
    .upsert(newStrategies, { onConflict: 'strategy_key' });
}
