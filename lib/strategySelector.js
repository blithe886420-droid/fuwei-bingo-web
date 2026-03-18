export function selectTopStrategies(statsRows, limit = 20) {
  if (!Array.isArray(statsRows)) return [];

  return statsRows
    .map((s) => {
      const rounds = Number(s.total_rounds || 0);
      const profit = Number(s.total_profit || 0);
      const roi = Number(s.roi || 0);

      // 🔥 核心評分（超重要）
      const score =
        roi * 0.6 +                  // ROI 最重要
        profit * 0.3 +               // 總獲利
        Math.log1p(rounds) * 10;     // 穩定性

      return {
        ...s,
        score
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
