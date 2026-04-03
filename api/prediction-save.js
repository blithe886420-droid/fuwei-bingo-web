from pathlib import Path

src = Path('/mnt/data/prediction-save-final-selfchecked-mature-pool-v3.txt')
text = src.read_text(encoding='utf-8')

# 1) relax second pass in pickRoleOrderedGroups for strategy_pool rows
old = """      const rankedRow = ranked[j];
      const strategyKey = getStrategyKey(rankedRow.group);
      const usedCount = toInt(strategyUseCount.get(strategyKey), 0);
      if (strategyKey && usedCount >= MAX_GROUPS_PER_STRATEGY) continue;
      if (slotNo <= 2 && strategyKey && usedCount >= 1) continue;
      if (!meetsMinTier(rankedRow.tier, requiredTier)) continue;
"""
new = """      const rankedRow = ranked[j];
      const strategyKey = getStrategyKey(rankedRow.group);
      const usedCount = toInt(strategyUseCount.get(strategyKey), 0);
      const isPool = isStrategyPoolGroup(rankedRow.group);
      if (slotNo <= 3 && isFallbackStrategyKey(strategyKey)) continue;
      if (strategyKey && usedCount >= MAX_GROUPS_PER_STRATEGY) continue;
      if (slotNo <= 2 && strategyKey && usedCount >= 1) continue;
      if (!isPool && !meetsMinTier(rankedRow.tier, requiredTier)) continue;
"""
text = text.replace(old, new, 1)

# 2) soften staged gate thresholds to avoid all-kill
old2 = """    // 階段式 gate：先 rounds，再 roi，最後 hit3
    if (isPool) {
      if (nextSlotNo === 1 && totalRounds < 10) return false;
      if (nextSlotNo === 2 && totalRounds < 5) return false;
      if (nextSlotNo === 3 && totalRounds < 3) return false;
    }

    if (totalRounds >= 10) {
      if (nextSlotNo === 1 && roi < -0.45) return false;
      if (nextSlotNo === 2 && roi < -0.55) return false;
      if (nextSlotNo === 3 && roi < -0.65) return false;
    }

    if (nextSlotNo <= 3 && totalRounds >= 10 && hit3 <= 0) {
      return false;
    }
"""
new2 = """    // 階段式 gate：先 rounds，再 roi，最後 hit3
    if (isPool) {
      if (nextSlotNo === 1 && totalRounds < 5) return false;
      if (nextSlotNo === 2 && totalRounds < 3) return false;
      if (nextSlotNo === 3 && totalRounds < 1) return false;
    }

    if (totalRounds >= 5) {
      if (nextSlotNo === 1 && roi < -0.55) return false;
      if (nextSlotNo === 2 && roi < -0.65) return false;
      if (nextSlotNo === 3 && roi < -0.75) return false;
    }

    if (nextSlotNo <= 2 && totalRounds >= 10 && hit3 <= 0) {
      return false;
    }
"""
if old2 not in text:
    raise ValueError("Gate block not found")
text = text.replace(old2, new2, 1)

# 3) add rescue non-fallback pass before final hard fallback
old3 = """  while (groups.length < GROUP_COUNT) {
    const fallbackRole = getRiskOrder(selection.riskMode, phaseContext)[groups.length] || 'mix';
    groups.push(
      buildFallbackGroup(
        fallbackRole,
        groups.length + 1,
        pools,
        selection,
        phaseContext,
        groups
      )
    );
  }
"""
new3 = """  // 第二救援層：若嚴格 gate 全部擋掉，先用「非 fallback 真策略」補位
  if (groups.length < GROUP_COUNT) {
    const rescueRoles = getRiskOrder(selection.riskMode, phaseContext);
    const rescueMatrix = [];

    for (const sourceGroup of sourceGroups) {
      const strategyKey = getStrategyKey(sourceGroup);
      if (isFallbackStrategyKey(strategyKey)) continue;

      const currentStrategyCount = toInt(strategyUseCount.get(strategyKey), 0);
      const totalRounds = toNum(sourceGroup?.meta?.total_rounds, 0);
      const roi = getBlendedRoi(sourceGroup);

      for (const role of rescueRoles) {
        const baseScore = scoreGroupForMode(
          sourceGroup,
          role,
          selection.strategyMode,
          selection.riskMode,
          pools,
          phaseContext
        );

        rescueMatrix.push({
          sourceGroup,
          role,
          baseScore,
          strategyKey,
          currentStrategyCount,
          totalRounds,
          roi
        });
      }
    }

    rescueMatrix
      .sort((a, b) => {
        const penaltyA = a.currentStrategyCount * 1500 - a.totalRounds * 2 - a.roi * 120;
        const penaltyB = b.currentStrategyCount * 1500 - b.totalRounds * 2 - b.roi * 120;
        return (b.baseScore - penaltyB) - (a.baseScore - penaltyA);
      })
      .forEach((row) => {
        if (groups.length >= GROUP_COUNT) return;

        const strategyKey = getStrategyKey(row.sourceGroup);
        const currentStrategyCount = toInt(strategyUseCount.get(strategyKey), 0);
        const nextSlotNo = groups.length + 1;
        const slotRole = row.role;

        const variant = buildVariantFromSourceGroup(
          row.sourceGroup,
          slotRole,
          nextSlotNo,
          pools,
          groups,
          selection,
          phaseContext
        );

        if (!variant || !variant.nums || variant.nums.length !== 4) return;

        const nums = variant.nums;
        const safeKey = `${row.sourceGroup.key}_${slotRole}_${nums.join('_')}`;
        const overlapTooHigh = groups.some((g) => countOverlap(nums, g?.nums || []) > MAX_GROUP_OVERLAP);
        const violatesTopSpread = nextSlotNo <= 2 && strategyKey && currentStrategyCount >= 1;

        if (usedKeys.has(safeKey)) return;
        if (overlapTooHigh) return;
        if (strategyKey && currentStrategyCount >= MAX_GROUPS_PER_STRATEGY) return;
        if (violatesTopSpread) return;

        groups.push({
          key: `${row.sourceGroup.key}_${slotRole}_${nextSlotNo}`,
          label: buildFormalLabel(slotRole, nextSlotNo, row.sourceGroup),
          nums,
          reason: `正式下注分工：${slotRole.toUpperCase()} / ${strategyModeLabel(selection.strategyMode)} / ${roleLabelOf(selection.riskMode)} / ${phaseContext.marketPhase} / ${phaseContext.lastHitLevel}`,
          meta: {
            ...buildFormalMeta(row.sourceGroup, slotRole, nextSlotNo, sourcePrediction, selection, phaseContext),
            decision_score: round4(variant.score),
            decision_gate: getDecisionScoreFloor(slotRole, selection, phaseContext),
            roi_gate: getRecentRoiFloor(slotRole, selection, phaseContext),
            hit3_gate: getHit3RateFloor(slotRole, selection, phaseContext),
            blended_roi: getBlendedRoi(row.sourceGroup),
            blended_hit3_rate: getBlendedHit3Rate(row.sourceGroup),
            tier: getCandidateTier(row.sourceGroup, variant.score, slotRole, selection, phaseContext)
          }
        });

        usedKeys.add(safeKey);
        if (strategyKey) {
          strategyUseCount.set(strategyKey, currentStrategyCount + 1);
        }
      });
  }

  while (groups.length < GROUP_COUNT) {
    const fallbackRole = getRiskOrder(selection.riskMode, phaseContext)[groups.length] || 'mix';
    groups.push(
      buildFallbackGroup(
        fallbackRole,
        groups.length + 1,
        pools,
        selection,
        phaseContext,
        groups
      )
    );
  }
"""
if old3 not in text:
    raise ValueError("Final fallback block not found")
text = text.replace(old3, new3, 1)

out = Path('/mnt/data/prediction-save-final-selfchecked-mature-pool-v4.txt')
out.write_text(text, encoding='utf-8')
print(out.as_posix())
