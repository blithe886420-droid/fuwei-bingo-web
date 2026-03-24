export function selectTopStrategies(statsRows, limit = 20, market = null) {
  if (!Array.isArray(statsRows)) return [];

  function getMarketBoost(strategyKey = '', market) {
    if (!market || !market.latest || !market.latest.summary) return 1;

    const summary = market.latest.summary;
    const key = String(strategyKey || '').toLowerCase();

    let boost = 1;

    // 🔥 奇偶偏向
    if (summary.odd_even_bias === 'odd' && key.includes('odd')) boost += 0.15;
    if (summary.odd_even_bias === 'even' && key.includes('even')) boost += 0.15;

    // 🔥 大小偏向
    if (summary.big_small_bias === 'big' && key.includes('hot')) boost += 0.1;
    if (summary.big_small_bias === 'small' && key.includes('cold')) boost += 0.1;

    // 🔥 區段偏熱
    if (summary.hot_zone === 1 && key.includes('zone')) boost += 0.1;
    if (summary.hot_zone === 4 && key.includes('zone')) boost += 0.1;

    // 🔥 緊密盤 → pattern / structure
    if (summary.compactness === 'tight' && key.includes('pattern')) boost += 0.15;

    // 🔥 寬盤 → gap / chase
    if (summary.compactness === 'wide' && (key.includes('gap') || key.includes('chase'))) {
      boost += 0.15;
    }

    return boost;
  }

  return statsRows
    .map((s) => {
      const rounds = Number(s.total_rounds || 0);
      const profit = Number(s.total_profit || 0);
      const roi = Number(s.roi || 0);

      // 原本核心評分
      const baseScore =
        roi * 0.6 +
        profit * 0.3 +
        Math.log1p(rounds) * 10;

      // 🔥 新增市場權重
      const marketBoost = getMarketBoost(s.strategy_key, market);

      return {
        ...s,
        score: baseScore * marketBoost,
        baseScore,
        marketBoost
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
