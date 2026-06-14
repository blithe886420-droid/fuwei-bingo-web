-- ============================================================
-- 深挖換手數量訊號：
-- A: 換手0顆vs1顆vs5顆的詳細比較
-- B: 換手1顆 + 其他條件組合(TQ/位置/時段)
-- C: 換手5顆 + G策略8組的整體淨利
-- ============================================================

WITH pnl_base AS (
  SELECT
    source_draw_no,
    created_at,
    (groups_json->0->'meta'->>'changed_nums')::int AS changed_nums,
    (groups_json->0->'meta'->>'total_qualified')::int AS total_qualified,
    (groups_json->0->'meta'->>'position') AS position,
    (groups_json->0->'meta'->>'sig_slow_turnover')::boolean AS slow_turnover,
    (
      SELECT SUM(CASE WHEN (e->>'hit')::int=3 THEN 500 WHEN (e->>'hit')::int=2 THEN 50 ELSE 0 END)
      FROM jsonb_array_elements(compare_result_json->'detail') AS e
    ) - 200 AS pnl
  FROM bingo_predictions
  WHERE mode='formal_3star' AND status='compared' AND compare_status='done'
    AND groups_json IS NOT NULL
    AND (groups_json->0->'meta'->>'changed_nums') IS NOT NULL
),
with_hour AS (
  SELECT *,
    EXTRACT(HOUR FROM (created_at AT TIME ZONE 'Asia/Taipei')) AS tw_hour
  FROM pnl_base
)

-- A: 換手0/1/5顆，依位置交叉
SELECT 'A_changed_x_position' AS check_group,
  changed_nums::text || '_' || COALESCE(position,'?') AS check_item,
  COUNT(*) AS sample,
  ROUND(AVG(pnl),2) AS avg_pnl,
  ROUND(100.0*SUM(CASE WHEN pnl>=0 THEN 1 ELSE 0 END)/COUNT(*),2) AS breakeven_pct
FROM with_hour
WHERE changed_nums IN (0,1,5)
GROUP BY changed_nums, position

UNION ALL

-- B: 換手1顆 + TQ分層
SELECT 'B_changed1_x_tq',
  CASE
    WHEN total_qualified >= 22 THEN 'TQ22+'
    WHEN total_qualified >= 15 THEN 'TQ15-21'
    ELSE 'TQ<15'
  END,
  COUNT(*), ROUND(AVG(pnl),2),
  ROUND(100.0*SUM(CASE WHEN pnl>=0 THEN 1 ELSE 0 END)/COUNT(*),2)
FROM with_hour
WHERE changed_nums = 1
GROUP BY 1,2

UNION ALL

-- C: 換手5顆 + 時段
SELECT 'C_changed5_x_hour',
  CASE
    WHEN tw_hour BETWEEN 7 AND 11 THEN '07-11點'
    WHEN tw_hour BETWEEN 16 AND 20 THEN '16-20點'
    WHEN tw_hour BETWEEN 12 AND 15 THEN '12-15點死亡'
    ELSE '其他時段'
  END,
  COUNT(*), ROUND(AVG(pnl),2),
  ROUND(100.0*SUM(CASE WHEN pnl>=0 THEN 1 ELSE 0 END)/COUNT(*),2)
FROM with_hour
WHERE changed_nums = 5
GROUP BY 1,2

UNION ALL

-- D: 換手1顆 + TQ22+ 的複合(跟蜘蛛感知對照)
SELECT 'D_changed1_tq22plus',
  '換手1顆+TQ22+',
  COUNT(*), ROUND(AVG(pnl),2),
  ROUND(100.0*SUM(CASE WHEN pnl>=0 THEN 1 ELSE 0 END)/COUNT(*),2)
FROM with_hour
WHERE changed_nums = 1 AND total_qualified >= 22

ORDER BY 1,2;
