import { createClient } from '@supabase/supabase-js';
import { buildComparePayload } from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';
import { buildRecentMarketSignalSnapshot, buildStrategyDecisionFromSnapshot } from '../lib/marketSignalEngine.js';

const API_VERSION = 'auto-train-stable-hit2-v3-data-classifier-stable-hit2-v6-fallback-semi-filter';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const TEST_MODE = 'test';
const FORMAL_MODE = 'formal';
const FORMAL_CANDIDATE_MODE = 'formal_candidate';
const COMPARE_MODES = [TEST_MODE, FORMAL_MODE];

const BET_GROUP_COUNT = 4;
const TARGET_PERIODS = 1;
const COMPARE_BATCH_LIMIT = 50;
const MARKET_LOOKBACK_LIMIT = 160;
const COST_PER_GROUP_PER_PERIOD = 25;

const MAX_CREATED_PREDICTIONS = 20;
const ALLOW_CREATE_WHEN_EXISTING = true;

const DECISION_CONFIG = {
  hardRejectRoi: -0.85,
  hardRejectScore: -400,
  softRejectRoi: -0.5,
  minAvgHitPreferred: 1.2,
  minRoundsForTrust: 6,
  strongScoreFloor: 80,
  usableScoreFloor: 10
};

const STRATEGY_STATS_TABLE = 'strategy_stats';
const STRATEGY_POOL_TABLE = 'strategy_pool';
const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';

const PROTECTED_STATUS = new Set(['protected']);
const TERMINAL_STATUS = new Set(['disabled', 'retired']);

const MIN_ACTIVE_STRATEGY = 30;
const TARGET_ACTIVE_STRATEGY = 60;
const MAX_ACTIVE_STRATEGY = 80;
const MAX_SPAWN_PER_RUN = 12;

const SOFT_SHRINK_TRIGGER = MAX_ACTIVE_STRATEGY + 1;
const HARD_SHRINK_TRIGGER = 120;
const EXTREME_SHRINK_TRIGGER = 160;

const KNOWN_GENES = [
  'hot',
  'cold',
  'warm',
  'zone',
  'tail',
  'mix',
  'repeat',
  'guard',
  'balanced',
  'balance',
  'chase',
  'jump',
  'pattern',
  'structure',
  'split',
  'cluster',
  'gap',
  'spread',
  'rotation',
  'odd',
  'even',
  'reverse',
  'skip'
];

let supabase = null;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE env');
  }

  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });
  }

  return supabase;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round4(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function safeArray(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function uniqueSorted(nums = []) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))]
    .filter((n) => n >= 1 && n <= 80)
    .sort((a, b) => a - b);
}

function parseNums(value) {
  if (Array.isArray(value)) {
    return uniqueSorted(value);
  }

  if (typeof value === 'string') {
    return uniqueSorted(
      value
        .replace(/[{}[\]]/g, ' ')
        .split(/[,\s|/]+/)
        .map(Number)
    );
  }

  if (value && typeof value === 'object') {
    return parseNums(
      value.numbers ||
        value.draw_numbers ||
        value.result_numbers ||
        value.open_numbers ||
        value.nums ||
        []
    );
  }

  return [];
}

function normalizeGroups(groups = []) {
  return (Array.isArray(groups) ? groups : [])
    .map((group, idx) => {
      if (!group || typeof group !== 'object') return null;

      const numsSource = Array.isArray(group.nums)
        ? group.nums
        : Array.isArray(group.numbers)
          ? group.numbers
          : Array.isArray(group.values)
            ? group.values
            : [];

      const nums = uniqueSorted(numsSource).slice(0, 4);
      if (nums.length !== 4) return null;

      const meta = group.meta && typeof group.meta === 'object' ? group.meta : {};

      return {
        key: String(group.key || meta.strategy_key || `group_${idx + 1}`),
        label: String(group.label || meta.strategy_name || `第${idx + 1}組`),
        nums,
        meta: {
          ...meta,
          strategy_key: String(meta.strategy_key || group.key || `group_${idx + 1}`),
          strategy_name: String(meta.strategy_name || group.label || `第${idx + 1}組`)
        }
      };
    })
    .filter(Boolean);
}

function buildGroupPriorityTuple(group = {}) {
  const meta = group?.meta && typeof group.meta === 'object' ? group.meta : {};

  return [
    Math.max(
      toNum(meta.recent_50_hit_rate, 0),
      toNum(meta.hit2_rate, 0)
    ),
    Math.max(
      toNum(meta.recent_50_roi, -999),
      toNum(meta.roi, -999)
    ),
    Math.max(
      toNum(meta.recent_50_hit3_rate, 0),
      toNum(meta.hit3_rate, 0)
    ),
    toNum(meta.score, 0),
    toNum(meta.decision_score, 0),
    toNum(meta.market_boost, 1) - 1,
    -toNum(meta.selection_rank, 999)
  ];
}

function compareGroupPriorityDesc(a, b) {
  const aTuple = buildGroupPriorityTuple(a);
  const bTuple = buildGroupPriorityTuple(b);
  const size = Math.max(aTuple.length, bTuple.length);

  for (let i = 0; i < size; i += 1) {
    const diff = toNum(bTuple[i], 0) - toNum(aTuple[i], 0);
    if (diff !== 0) return diff;
  }

  return String(a?.key || a?.meta?.strategy_key || '').localeCompare(
    String(b?.key || b?.meta?.strategy_key || '')
  );
}

function sortGroupsForInstantCandidate(groups = []) {
  return normalizeGroups(groups).sort(compareGroupPriorityDesc);
}



function buildInstantFormalCandidateGroups(groups = []) {
  const normalized = sortGroupsForInstantCandidate(groups).slice(0, 60);
  if (normalized.length < 4) return [];

  const byStrategy = [];
  const seenStrategy = new Set();

  for (const group of normalized) {
    const strategyKey = String(group?.meta?.strategy_key || group?.key || '').trim();
    if (!strategyKey) continue;
    if (seenStrategy.has(strategyKey)) continue;
    seenStrategy.add(strategyKey);
    byStrategy.push(group);
  }

  if (byStrategy.length < 4) return [];

  const getHit2 = (group) =>
    Math.max(
      toNum(group?.meta?.recent_50_hit_rate, 0),
      toNum(group?.meta?.hit2_rate, 0)
    );

  const getHit3 = (group) =>
    Math.max(
      toNum(group?.meta?.recent_50_hit3_rate, 0),
      toNum(group?.meta?.hit3_rate, 0)
    );

  const getRoi = (group) =>
    Math.max(
      toNum(group?.meta?.recent_50_roi, Number.NEGATIVE_INFINITY),
      toNum(group?.meta?.roi, Number.NEGATIVE_INFINITY)
    );

  const getScore = (group) =>
    Math.max(
      toNum(group?.meta?.decision_score, Number.NEGATIVE_INFINITY),
      toNum(group?.meta?.score, Number.NEGATIVE_INFINITY)
    );

  const classifyRole = (group) => {
    const hit2 = getHit2(group);
    const hit3 = getHit3(group);
    const roi = getRoi(group);

    if (hit2 >= 0.28 && roi >= -0.4) return 'guard';
    if (hit2 >= 0.24 && roi >= -0.55) return 'extend';
    if (hit3 >= 0.05 && hit2 >= 0.22) return 'attack';

    return 'reject';
  };

  const scoreGuard = (group) => {
    const hit2 = getHit2(group);
    const hit3 = getHit3(group);
    const roi = getRoi(group);
    const score = getScore(group);
    return hit2 * 1000 + roi * 120 - hit3 * 120 + score * 0.001;
  };

  const scoreExtend = (group) => {
    const hit2 = getHit2(group);
    const hit3 = getHit3(group);
    const roi = getRoi(group);
    const score = getScore(group);
    return hit2 * 1200 + roi * 120 + hit3 * 30 + score * 0.001;
  };

  const scoreAttack = (group) => {
    const hit2 = getHit2(group);
    const hit3 = getHit3(group);
    const roi = getRoi(group);
    const score = getScore(group);
    return hit3 * 1200 + hit2 * 250 + roi * 80 + score * 0.001;
  };

  const guardPool = [];
  const extendPool = [];
  const attackPool = [];

  for (const group of byStrategy) {
    const role = classifyRole(group);
    if (role === 'guard') {
      guardPool.push(group);
      extendPool.push(group);
      continue;
    }
    if (role === 'extend') {
      extendPool.push(group);
      continue;
    }
    if (role === 'attack') {
      attackPool.push(group);
    }
  }

  guardPool.sort((a, b) => scoreGuard(b) - scoreGuard(a));
  extendPool.sort((a, b) => scoreExtend(b) - scoreExtend(a));
  attackPool.sort((a, b) => scoreAttack(b) - scoreAttack(a));

  const used = new Set();

  const pickUnique = (pool) => {
    for (const group of pool) {
      const strategyKey = String(group?.meta?.strategy_key || group?.key || '').trim();
      if (!strategyKey) continue;
      if (used.has(strategyKey)) continue;
      used.add(strategyKey);
      return group;
    }
    return null;
  };

  const slot1 = pickUnique(guardPool);
  const slot2 = pickUnique(extendPool);
  const slot3 = pickUnique(extendPool);
  const slot4 = pickUnique(attackPool);

  if (!slot1 || !slot2 || !slot3 || !slot4) return [];

  const wrap = (group, slotNo, preferredRole, focusLabel) => ({
    ...group,
    label: `${focusLabel} / ${group.meta?.strategy_name || group.label}`,
    reason:
      preferredRole === 'attack'
        ? '即戰候選 / 穩中2版：三穩一衝'
        : '即戰候選 / 穩中2版：穩定優先',
    meta: {
      ...(group.meta || {}),
      selection_rank: slotNo,
      source_selection_rank: toNum(group?.meta?.selection_rank, slotNo),
      instant_candidate: true,
      instant_candidate_mode: 'stable_hit2_v3_data_classifier',
      focus_mode: 'stable_hit2_v3_data_classifier',
      focus_bucket: preferredRole,
      focus_tag: focusLabel,
      focus_slot_no: slotNo,
      preferred_role: preferredRole,
      slot_no: slotNo
    }
  });

  return [
    wrap(slot1, 1, 'guard', 'GUARD 1'),
    wrap(slot2, 2, 'extend', 'EXTEND 2'),
    wrap(slot3, 3, 'extend', 'EXTEND 3'),
    wrap(slot4, 4, 'attack', 'ATTACK 4')
  ];
}

async function upsertFormalCandidateFromTest(db, predictionRow) {
  if (!predictionRow || String(predictionRow.mode || '').toLowerCase() !== TEST_MODE) {
    return null;
  }

  const sourceDrawNo = String(predictionRow.source_draw_no || '').trim();
  if (!sourceDrawNo) return null;

  const candidateGroups = buildInstantFormalCandidateGroups(predictionRow.groups_json || []);
  let finalGroups = candidateGroups;
  if (candidateGroups.length !== 4) {
    const normalized = normalizeGroups(predictionRow.groups_json || []);

    // 🔥 SEMI FILTER fallback（至少保住一半穩定來源）
    const filtered = normalized.filter((g) => {
      const meta = g.meta || {};
      const hit2 = Math.max(
        Number(meta.recent_50_hit_rate || 0),
        Number(meta.hit2_rate || 0)
      );
      const roi = Math.max(
        Number(meta.recent_50_roi || -999),
        Number(meta.roi || -999)
      );
      return hit2 >= 0.28 && roi >= -0.4;
    });

    let base = [];
    let fallbackMode = 'fallback_semi_filtered';

    if (filtered.length >= 2) {
      const filteredKeys = new Set(
        filtered.map((g) => String(g?.meta?.strategy_key || g?.key || '').trim()).filter(Boolean)
      );

      const remainder = normalized.filter((g) => {
        const key = String(g?.meta?.strategy_key || g?.key || '').trim();
        return !filteredKeys.has(key);
      });

      base = [...filtered, ...remainder];
      fallbackMode = 'fallback_semi_filtered';
    } else if (filtered.length === 1) {
      const onlyKey = String(filtered[0]?.meta?.strategy_key || filtered[0]?.key || '').trim();
      const remainder = normalized.filter((g) => {
        const key = String(g?.meta?.strategy_key || g?.key || '').trim();
        return key !== onlyKey;
      });

      base = [filtered[0], ...remainder];
      fallbackMode = 'fallback_one_filtered';
    } else {
      return null;
    }

    const deduped = [];
    const seenKeys = new Set();

    for (const g of base) {
      const key = String(g?.meta?.strategy_key || g?.key || '').trim();
      if (key && seenKeys.has(key)) continue;
      if (key) seenKeys.add(key);
      deduped.push(g);
      if (deduped.length >= 4) break;
    }

    const fallback = deduped.slice(0, 4);

    if (fallback.length === 4) {
      finalGroups = fallback.map((g, idx) => ({
        ...g,
        meta: {
          ...(g.meta || {}),
          slot_no: idx + 1,
          preferred_role: idx === 0 ? 'guard' : (idx < 3 ? 'extend' : 'attack_blocked'),
          focus_mode: fallbackMode
        }
      }));
    } else {
      return null;
    }
  }

  const nowIso = new Date().toISOString();

  const candidatePayload = {
    mode: FORMAL_CANDIDATE_MODE,
    status: 'ready',
    source_draw_no: sourceDrawNo,
    target_periods: TARGET_PERIODS,
    groups_json: finalGroups,
    compare_status: 'candidate',
    compare_result: null,
    compare_result_json: null,
    hit_count: 0,
    verdict: null,
    latest_draw_numbers: predictionRow.latest_draw_numbers || null,
    market_snapshot_json: predictionRow.market_snapshot_json || null,
    created_at: nowIso
  };

  const { data: existingCandidate, error: existingCandidateError } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', FORMAL_CANDIDATE_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingCandidateError) throw existingCandidateError;

  let candidateRow = null;

  if (existingCandidate?.id) {
    const { data: updatedCandidate, error: updateCandidateError } = await db
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'ready',
        groups_json: finalGroups,
        compare_status: 'candidate',
        compare_result: null,
        compare_result_json: null,
        hit_count: 0,
        verdict: null,
        latest_draw_numbers: predictionRow.latest_draw_numbers || null,
        market_snapshot_json: predictionRow.market_snapshot_json || null
      })
      .eq('id', existingCandidate.id)
      .select('*')
      .maybeSingle();

    if (updateCandidateError) throw updateCandidateError;
    candidateRow = updatedCandidate || existingCandidate;
  } else {
    const { data: insertedCandidate, error: insertCandidateError } = await db
      .from(PREDICTIONS_TABLE)
      .insert(candidatePayload)
      .select('*')
      .maybeSingle();

    if (insertCandidateError) throw insertCandidateError;
    candidateRow = insertedCandidate || null;
  }

  const formalPayload = {
    mode: FORMAL_MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: TARGET_PERIODS,
    groups_json: finalGroups,
    compare_status: 'pending',
    compare_result: null,
    compare_result_json: null,
    hit_count: 0,
    verdict: null,
    latest_draw_numbers: predictionRow.latest_draw_numbers || null,
    market_snapshot_json: predictionRow.market_snapshot_json || null,
    created_at: nowIso
  };

  const { data: existingFormal, error: existingFormalError } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', FORMAL_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingFormalError) throw existingFormalError;

  if (existingFormal?.id) {
    const { error: updateFormalError } = await db
      .from(PREDICTIONS_TABLE)
      .update({
        status: 'created',
        groups_json: finalGroups,
        compare_status: 'pending',
        compare_result: null,
        compare_result_json: null,
        hit_count: 0,
        verdict: null,
        latest_draw_numbers: predictionRow.latest_draw_numbers || null,
        market_snapshot_json: predictionRow.market_snapshot_json || null
      })
      .eq('id', existingFormal.id);

    if (updateFormalError) throw updateFormalError;
  } else {
    const { error: insertFormalError } = await db
      .from(PREDICTIONS_TABLE)
      .insert(formalPayload);

    if (insertFormalError) throw insertFormalError;
  }

  return candidateRow;
}

function normalizeHitRate(raw) {
  const value = toNum(raw, 0);
  if (value <= 0) return 0;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return 1;
}

function isDuplicateDrawModeError(error) {
  const msg = String(error?.message || '');
  const details = String(error?.details || '');
  const code = String(error?.code || '');

  return (
    code === '23505' ||
    msg.includes('unique_draw_mode') ||
    details.includes('unique_draw_mode') ||
    msg.includes('duplicate key value violates unique constraint')
  );
}

function tokenizeStrategyKey(strategyKey = '') {
  return String(strategyKey || '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token));
}

function strategyLabel(strategyKey = '') {
  return String(strategyKey || '')
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function normalizeStrategyKey(raw = '') {
  return String(raw || '').trim().toLowerCase();
}

function getDecisionRank(decision = '') {
  const d = String(decision || '').toLowerCase();
  if (d === 'reject') return 0;
  if (d === 'weak') return 1;
  if (d === 'candidate') return 2;
  if (d === 'usable') return 3;
  if (d === 'strong') return 4;
  return 5;
}

function inferGenesFromStrategyKey(strategyKey = '') {
  const tokens = tokenizeStrategyKey(strategyKey);
  const genes = tokens.filter((t) => KNOWN_GENES.includes(t));

  return {
    gene_a: genes[0] || 'mix',
    gene_b: genes[1] || 'balanced'
  };
}

function uniqueTokens(tokens = []) {
  return [...new Set((Array.isArray(tokens) ? tokens : []).filter(Boolean))];
}

function buildStrategyKeyFromTokens(tokens = []) {
  return normalizeStrategyKey(uniqueTokens(tokens).slice(0, 3).join('_'));
}

function buildChildStrategyKey(parentAKey = '', parentBKey = '', mode = 'crossover', seq = 0) {
  const tokensA = tokenizeStrategyKey(parentAKey);
  const tokensB = tokenizeStrategyKey(parentBKey);

  if (mode === 'exploration') {
    const a = KNOWN_GENES[seq % KNOWN_GENES.length];
    const b = KNOWN_GENES[(seq + 7) % KNOWN_GENES.length];
    const c = KNOWN_GENES[(seq + 13) % KNOWN_GENES.length];
    return buildStrategyKeyFromTokens([a, b, c]);
  }

  if (mode === 'mutation') {
    const base = tokensA.length ? [...tokensA] : ['mix', 'balanced'];
    const extra = KNOWN_GENES[(seq + base.length) % KNOWN_GENES.length];
    return buildStrategyKeyFromTokens([...base, extra]);
  }

  const a1 = tokensA[0] || 'mix';
  const a2 = tokensA[1] || '';
  const b1 = tokensB[0] || 'balanced';
  const b2 = tokensB[1] || '';

  return buildStrategyKeyFromTokens([a1, b1, a2 || b2].filter(Boolean));
}

function chooseSpawnSourceType(index = 0, activeCount = 0) {
  if (activeCount < 36) {
    return index % 3 === 0 ? 'exploration' : 'evolved';
  }

  if (index % 4 === 0) return 'exploration';
  if (index % 2 === 0) return 'crossover';
  return 'evolved';
}

function normalizePredictionStatus(status = '') {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'compared') return 'compared';
  if (s === 'created') return 'created';
  return s || 'created';
}

function normalizePredictionMode(mode = '') {
  return String(mode || '').trim().toLowerCase() === FORMAL_MODE ? FORMAL_MODE : TEST_MODE;
}

function countOverlap(a = [], b = []) {
  const setB = new Set(uniqueSorted(b));
  return uniqueSorted(a).filter((n) => setB.has(n)).length;
}

function pickFromPool(pool = [], selectedSet = new Set(), seed = 0) {
  const candidates = uniqueSorted(pool).filter((n) => !selectedSet.has(n));
  if (!candidates.length) return null;
  const index = Math.abs(toNum(seed, 0)) % candidates.length;
  return candidates[index];
}

function fillToFour(base = [], fallbackPools = [], seed = 0) {
  const result = uniqueSorted(base).slice(0, 4);
  const selected = new Set(result);
  let cursor = 0;

  for (const pool of fallbackPools) {
    while (result.length < 4 && cursor < 220) {
      const value = pickFromPool(pool, selected, seed + cursor);
      cursor += 1;
      if (value == null) break;
      selected.add(value);
      result.push(value);
    }

    if (result.length >= 4) break;
  }

  if (result.length < 4) {
    const allNums = Array.from({ length: 80 }, (_, i) => i + 1);
    while (result.length < 4 && cursor < 500) {
      const value = pickFromPool(allNums, selected, seed + cursor);
      cursor += 1;
      if (value == null) break;
      selected.add(value);
      result.push(value);
    }
  }

  return uniqueSorted(result).slice(0, 4);
}

function mutateOne(nums = [], pools = [], seed = 0) {
  const current = uniqueSorted(nums).slice(0, 4);
  if (current.length !== 4) return current;

  const selected = new Set(current);
  const removeIndex = Math.abs(seed) % current.length;
  selected.delete(current[removeIndex]);

  for (let i = 0; i < pools.length; i += 1) {
    const value = pickFromPool(pools[i], selected, seed + i * 17 + 3);
    if (value != null) {
      selected.add(value);
      return uniqueSorted([...selected]).slice(0, 4);
    }
  }

  return uniqueSorted([...selected]).slice(0, 4);
}

function forceGroupDifference(nums = [], existingGroups = [], pools = {}, seed = 0) {
  let result = uniqueSorted(nums).slice(0, 4);
  const poolOrder = [pools.attack, pools.extend, pools.guard, pools.recent, pools.hot, pools.all];

  for (let round = 0; round < 10; round += 1) {
    let changed = false;

    for (const group of existingGroups) {
      const overlap = countOverlap(result, group?.nums || []);
      if (overlap >= 3) {
        result = mutateOne(result, poolOrder, seed + round * 23 + overlap);
        changed = true;
        break;
      }
    }

    if (!changed) break;
  }

  return uniqueSorted(result).slice(0, 4);
}

function getZoneIndex(n) {
  if (n >= 1 && n <= 20) return 1;
  if (n <= 40) return 2;
  if (n <= 60) return 3;
  return 4;
}

function buildMarketState(drawRows = []) {
  const rows = (Array.isArray(drawRows) ? drawRows : []).map((row) => ({
    draw_no: toNum(row?.draw_no, 0),
    numbers: parseNums(
      row?.numbers ??
        row?.draw_numbers ??
        row?.result_numbers ??
        row?.open_numbers ??
        row?.nums
    )
  }));

  const latest = rows[0]?.numbers || [];
  const recent20 = rows.slice(0, 20);
  const recent50 = rows.slice(0, 50);
  const recent80 = rows.slice(0, 80);

  const freq20 = new Map();
  const freq50 = new Map();
  const freq80 = new Map();
  const lastSeen = new Map();
  const tailFreq20 = new Map();
  const zoneFreq20 = new Map();

  for (let n = 1; n <= 80; n += 1) {
    freq20.set(n, 0);
    freq50.set(n, 0);
    freq80.set(n, 0);
  }

  for (let t = 0; t <= 9; t += 1) {
    tailFreq20.set(t, 0);
  }

  for (let z = 1; z <= 4; z += 1) {
    zoneFreq20.set(z, 0);
  }

  recent20.forEach((row, idx) => {
    for (const n of row.numbers) {
      freq20.set(n, toNum(freq20.get(n), 0) + 1);
      lastSeen.set(n, idx);
      tailFreq20.set(n % 10, toNum(tailFreq20.get(n % 10), 0) + 1);
      zoneFreq20.set(getZoneIndex(n), toNum(zoneFreq20.get(getZoneIndex(n)), 0) + 1);
    }
  });

  recent50.forEach((row) => {
    for (const n of row.numbers) {
      freq50.set(n, toNum(freq50.get(n), 0) + 1);
    }
  });

  recent80.forEach((row) => {
    for (const n of row.numbers) {
      freq80.set(n, toNum(freq80.get(n), 0) + 1);
    }
  });

  const allNums = Array.from({ length: 80 }, (_, i) => i + 1);

  const hot = allNums
    .slice()
    .sort((a, b) => {
      const d20 = toNum(freq20.get(b), 0) - toNum(freq20.get(a), 0);
      if (d20 !== 0) return d20;

      const d50 = toNum(freq50.get(b), 0) - toNum(freq50.get(a), 0);
      if (d50 !== 0) return d50;

      return a - b;
    });

  const cold = allNums
    .slice()
    .sort((a, b) => {
      const d20 = toNum(freq20.get(a), 0) - toNum(freq20.get(b), 0);
      if (d20 !== 0) return d20;

      const gapA = lastSeen.has(a) ? toNum(lastSeen.get(a), 999) : 999;
      const gapB = lastSeen.has(b) ? toNum(lastSeen.get(b), 999) : 999;
      if (gapB !== gapA) return gapB - gapA;

      return a - b;
    });

  const gap = allNums
    .slice()
    .sort((a, b) => {
      const gapA = lastSeen.has(a) ? toNum(lastSeen.get(a), 999) : 999;
      const gapB = lastSeen.has(b) ? toNum(lastSeen.get(b), 999) : 999;
      return gapB - gapA || a - b;
    });

  const warm = [...hot.slice(10), ...hot.slice(0, 10)];

  return {
    latest,
    recent20,
    recent50,
    recent80,
    hot,
    cold,
    gap,
    warm,
    all: allNums,
    freq20,
    freq50,
    freq80,
    tailFreq20,
    zoneFreq20
  };
}

function buildDecisionPools(market = {}, marketSnapshot = {}) {
  const hot5 = uniqueSorted(marketSnapshot?.hot_windows?.hot_5?.numbers || marketSnapshot?.hot_5_numbers || []);
  const hot10 = uniqueSorted(marketSnapshot?.hot_windows?.hot_10?.numbers || marketSnapshot?.hot_10_numbers || []);
  const hot20 = uniqueSorted(marketSnapshot?.hot_windows?.hot_20?.numbers || marketSnapshot?.hot_20_numbers || []);
  const streak2 = uniqueSorted(marketSnapshot?.streak2 || marketSnapshot?.streaks?.streak2 || []);
  const streak3 = uniqueSorted(marketSnapshot?.streak3 || marketSnapshot?.streaks?.streak3 || []);
  const streak4 = uniqueSorted(marketSnapshot?.streak4 || marketSnapshot?.streaks?.streak4 || []);
  const decisionBasis = marketSnapshot?.decision_basis || {};

  const attack = uniqueSorted([
    ...(decisionBasis.attack_core_numbers || []),
    ...streak4,
    ...streak3,
    ...hot5.slice(0, 10),
    ...hot10.slice(0, 6)
  ]);

  const extend = uniqueSorted([
    ...(decisionBasis.extend_numbers || []),
    ...streak2,
    ...hot10.slice(0, 14),
    ...hot20.slice(0, 8)
  ]);

  const guard = uniqueSorted([
    ...(decisionBasis.guard_numbers || []),
    ...hot20.slice(0, 20),
    ...market.warm?.slice(0, 20)
  ]);

  const recent = uniqueSorted([
    ...(decisionBasis.recent_focus_numbers || []),
    ...market.latest,
    ...hot5.slice(0, 12)
  ]);

  const hot = uniqueSorted([...hot5, ...hot10, ...hot20, ...(market.hot || []).slice(0, 30)]);
  const cold = uniqueSorted([...(market.cold || []).slice(0, 24), ...(market.gap || []).slice(0, 24)]);
  const gap = uniqueSorted([...(market.gap || []).slice(0, 24)]);
  const warm = uniqueSorted([...(market.warm || []).slice(0, 24)]);

  return {
    attack,
    extend,
    guard,
    recent,
    hot,
    cold,
    gap,
    warm,
    all: uniqueSorted(market.all || [])
  };
}

function scorePoolHits(nums = [], pool = [], weight = 1) {
  const setPool = new Set(uniqueSorted(pool));
  let score = 0;
  for (const n of uniqueSorted(nums)) {
    if (setPool.has(n)) score += weight;
  }
  return score;
}

function buildStrategyNums(strategyKey = '', market = {}, marketSnapshot = {}, seed = 0, role = 'mix') {
  const pools = buildDecisionPools(market, marketSnapshot);
  const tokens = tokenizeStrategyKey(strategyKey);
  const selected = new Set();
  const base = [];

  const rolePoolMap = {
    attack: [pools.attack, pools.hot, pools.extend, pools.all],
    extend: [pools.extend, pools.attack, pools.guard, pools.all],
    guard: [pools.guard, pools.extend, pools.hot, pools.all],
    recent: [pools.recent, pools.attack, pools.hot, pools.all],
    mix: [pools.hot, pools.extend, pools.guard, pools.all]
  };

  const pushFromPool = (pool, count = 1, salt = 0) => {
    let cursor = 0;
    while (base.length < 4 && cursor < count * 20) {
      const value = pickFromPool(pool, selected, seed + salt + cursor * 13);
      cursor += 1;
      if (value == null) break;
      if (selected.has(value)) continue;
      selected.add(value);
      base.push(value);
      if (count <= 1) break;
      if (base.length >= 4) break;
    }
  };

  if (rolePoolMap[role]) {
    const list = rolePoolMap[role];
    if (role === 'attack') {
      pushFromPool(list[0], 2, 11);
      pushFromPool(list[1], 1, 17);
      pushFromPool(list[2], 1, 23);
    } else if (role === 'extend') {
      pushFromPool(list[0], 2, 29);
      pushFromPool(list[1], 1, 31);
      pushFromPool(list[2], 1, 37);
    } else if (role === 'guard') {
      pushFromPool(list[0], 2, 41);
      pushFromPool(list[1], 1, 43);
      pushFromPool(list[2], 1, 47);
    } else if (role === 'recent') {
      pushFromPool(list[0], 2, 53);
      pushFromPool(list[1], 1, 59);
      pushFromPool(list[2], 1, 61);
    } else {
      pushFromPool(list[0], 1, 67);
      pushFromPool(list[1], 1, 71);
      pushFromPool(list[2], 1, 73);
    }
  }

  for (const token of tokens) {
    if (base.length >= 4) break;

    if (token === 'hot' || token === 'repeat') {
      pushFromPool(pools.attack.length ? pools.attack : pools.hot, 1, 101);
      continue;
    }

    if (token === 'cold' || token === 'reverse' || token === 'skip') {
      pushFromPool(pools.cold.length ? pools.cold : pools.gap, 1, 103);
      continue;
    }

    if (token === 'warm' || token === 'balanced' || token === 'balance' || token === 'mix') {
      pushFromPool(pools.guard.length ? pools.guard : pools.warm, 1, 107);
      continue;
    }

    if (token === 'gap' || token === 'jump' || token === 'chase') {
      pushFromPool(pools.extend.length ? pools.extend : pools.gap, 1, 109);
      continue;
    }

    if (token === 'zone' || token === 'pattern' || token === 'structure' || token === 'cluster') {
      pushFromPool(pools.attack.length ? pools.attack : pools.hot, 1, 113);
      continue;
    }

    if (token === 'tail' || token === 'split' || token === 'rotation' || token === 'spread') {
      pushFromPool(pools.recent.length ? pools.recent : pools.guard, 1, 127);
      continue;
    }

    if (token === 'odd' || token === 'even' || token === 'guard') {
      pushFromPool(pools.guard.length ? pools.guard : pools.hot, 1, 131);
      continue;
    }
  }

  const fallbackPools = rolePoolMap[role] || [pools.hot, pools.extend, pools.guard, pools.all];
  return fillToFour(base, fallbackPools, seed + 199);
}

function calcMarketBoost(strategyKey = '', marketSnapshot = {}, market = {}) {
  const tokens = tokenizeStrategyKey(strategyKey);
  const hot5 = uniqueSorted(marketSnapshot?.hot_windows?.hot_5?.numbers || marketSnapshot?.hot_5_numbers || []);
  const hot10 = uniqueSorted(marketSnapshot?.hot_windows?.hot_10?.numbers || marketSnapshot?.hot_10_numbers || []);
  const hot20 = uniqueSorted(marketSnapshot?.hot_windows?.hot_20?.numbers || marketSnapshot?.hot_20_numbers || []);
  const streak2 = uniqueSorted(marketSnapshot?.streak2 || marketSnapshot?.streaks?.streak2 || []);
  const streak3 = uniqueSorted(marketSnapshot?.streak3 || marketSnapshot?.streaks?.streak3 || []);
  const attack = uniqueSorted(marketSnapshot?.decision_basis?.attack_core_numbers || []);
  const extend = uniqueSorted(marketSnapshot?.decision_basis?.extend_numbers || []);
  const guard = uniqueSorted(marketSnapshot?.decision_basis?.guard_numbers || []);
  const recent = uniqueSorted(marketSnapshot?.decision_basis?.recent_focus_numbers || []);
  const nums = buildStrategyNums(strategyKey, market, marketSnapshot, 17, 'mix');

  let boost = 1;
  const reasons = [];

  const attackHits = scorePoolHits(nums, attack, 0.09);
  const extendHits = scorePoolHits(nums, extend, 0.05);
  const guardHits = scorePoolHits(nums, guard, 0.03);
  const recentHits = scorePoolHits(nums, recent, 0.03);
  const streak3Hits = scorePoolHits(nums, streak3, 0.15);
  const streak2Hits = scorePoolHits(nums, streak2, 0.08);
  const hot5Hits = scorePoolHits(nums, hot5, 0.08);
  const hot10Hits = scorePoolHits(nums, hot10, 0.05);
  const hot20Hits = scorePoolHits(nums, hot20, 0.03);

  boost += attackHits + extendHits + guardHits + recentHits + streak3Hits + streak2Hits + hot5Hits + hot10Hits + hot20Hits;

  if (streak3Hits > 0) reasons.push('streak3_core');
  if (streak2Hits > 0) reasons.push('streak2_support');
  if (attackHits > 0) reasons.push('attack_core');
  if (extendHits > 0) reasons.push('extend_support');
  if (guardHits > 0) reasons.push('guard_support');
  if (hot5Hits > 0) reasons.push('hot5');
  if (hot10Hits > 0) reasons.push('hot10');
  if (hot20Hits > 0) reasons.push('hot20');
  if (recentHits > 0) reasons.push('recent_focus');

  if (tokens.includes('hot') || tokens.includes('repeat')) {
    boost += streak3.length ? 0.08 : 0;
    boost += hot5.length ? 0.06 : 0;
  }

  if (tokens.includes('cold') || tokens.includes('reverse') || tokens.includes('skip')) {
    const coldPool = uniqueSorted([...(market.cold || []).slice(0, 20), ...(market.gap || []).slice(0, 20)]);
    const coldHits = scorePoolHits(nums, coldPool, 0.05);
    boost += coldHits;
    if (coldHits > 0) reasons.push('cold_gap');
  }

  if (tokens.includes('gap') || tokens.includes('jump') || tokens.includes('chase')) {
    boost += extend.length ? 0.05 : 0;
    if (extend.length) reasons.push('gap_extend');
  }

  if (tokens.includes('zone') || tokens.includes('cluster') || tokens.includes('structure')) {
    boost += attack.length ? 0.04 : 0;
    if (attack.length) reasons.push('zone_focus');
  }

  if (tokens.includes('tail') || tokens.includes('rotation') || tokens.includes('split')) {
    boost += recent.length ? 0.03 : 0;
    if (recent.length) reasons.push('tail_recent');
  }

  return {
    market_boost: round4(clamp(boost, 0.8, 2.2)),
    market_reason: uniqueTokens(reasons).join('|')
  };
}

function chooseDecision(row = {}) {
  const roi = toNum(row.roi, 0);
  const score = toNum(row.score, 0);
  const avgHit = toNum(row.avg_hit, 0);
  const rounds = toNum(row.total_rounds, 0);
  const hit3Rate = normalizeHitRate(row.hit3_rate);
  const recent50Hit3Rate = normalizeHitRate(row.recent_50_hit3_rate);
  const hit4Rate = normalizeHitRate(row.hit4_rate);
  const marketBoost = toNum(row.market_boost, 1);

  if (roi <= DECISION_CONFIG.hardRejectRoi || score <= DECISION_CONFIG.hardRejectScore) {
    return 'reject';
  }

  const weighted = score * marketBoost;
  const trustBonus = rounds >= DECISION_CONFIG.minRoundsForTrust ? 20 : 0;
  const explodeBonus = hit3Rate * 220 + recent50Hit3Rate * 300 + hit4Rate * 500;
  const avgBonus = avgHit >= DECISION_CONFIG.minAvgHitPreferred ? 35 : avgHit * 18;
  const decisionScore = weighted + trustBonus + explodeBonus + avgBonus;

  row.decision_score = round4(decisionScore);

  if (
    decisionScore >= DECISION_CONFIG.strongScoreFloor * 2.8 ||
    (recent50Hit3Rate >= 0.06 && avgHit >= 1.15) ||
    (hit3Rate >= 0.08 && marketBoost >= 1.1)
  ) {
    return 'strong';
  }

  if (
    decisionScore >= DECISION_CONFIG.strongScoreFloor ||
    (avgHit >= 1.2 && roi >= -0.1) ||
    recent50Hit3Rate >= 0.03
  ) {
    return 'usable';
  }

  if (
    decisionScore >= DECISION_CONFIG.usableScoreFloor ||
    score >= 0 ||
    roi >= DECISION_CONFIG.softRejectRoi
  ) {
    return 'candidate';
  }

  return 'weak';
}

function calcRecentRates(row = {}) {
  const totalRounds = toNum(row.total_rounds, 0);
  const hit2 = toNum(row.hit2, 0);
  const hit3 = toNum(row.hit3, 0);
  const hit4 = toNum(row.hit4, 0);

  const recentHits = safeArray(row.recent_hits);
  const recentProfit = safeArray(row.recent_profit);
  const recentCost = safeArray(row.recent_cost);

  const recent50Hits = recentHits.slice(-50).map((x) => toNum(x, 0));
  const recent50Profit = recentProfit.slice(-50).map((x) => toNum(x, 0));
  const recent50Cost = recentCost.slice(-50).map((x) => toNum(x, 0));

  const recent50HitRate = recent50Hits.length
    ? recent50Hits.filter((x) => x >= 2).length / recent50Hits.length
    : 0;

  const recent50Hit3Rate = recent50Hits.length
    ? recent50Hits.filter((x) => x >= 3).length / recent50Hits.length
    : 0;

  const recent50Hit4Rate = recent50Hits.length
    ? recent50Hits.filter((x) => x >= 4).length / recent50Hits.length
    : 0;

  const sumRecentCost = recent50Cost.reduce((acc, n) => acc + n, 0);
  const sumRecentProfit = recent50Profit.reduce((acc, n) => acc + n, 0);
  const recent50Roi = sumRecentCost > 0 ? sumRecentProfit / sumRecentCost : 0;

  return {
    total_rounds: totalRounds,
    hit2,
    hit3,
    hit4,
    hit2_rate: totalRounds > 0 ? hit2 / totalRounds : 0,
    hit3_rate: totalRounds > 0 ? hit3 / totalRounds : 0,
    hit4_rate: totalRounds > 0 ? hit4 / totalRounds : 0,
    recent_50_hit_rate: recent50HitRate,
    recent_50_hit3_rate: recent50Hit3Rate,
    recent_50_hit4_rate: recent50Hit4Rate,
    recent_50_roi: recent50Roi
  };
}

function mergePoolWithStats(poolRows = [], statsRows = [], marketSnapshot = {}, market = {}) {
  const statsMap = new Map(
    (Array.isArray(statsRows) ? statsRows : []).map((row) => [
      normalizeStrategyKey(row?.strategy_key),
      row
    ])
  );

  return (Array.isArray(poolRows) ? poolRows : []).map((poolRow, idx) => {
    const strategyKey = normalizeStrategyKey(poolRow?.strategy_key);
    const stats = statsMap.get(strategyKey) || {};
    const genes = inferGenesFromStrategyKey(strategyKey);

    const totalRounds = toNum(stats?.total_rounds, 0);
    const totalCost = toNum(stats?.total_cost, 0);
    const totalReward = toNum(stats?.total_reward, 0);
    const totalProfit = totalReward - totalCost;
    const avgHit =
      totalRounds > 0 ? toNum(stats?.total_hits, 0) / totalRounds : 0;
    const roi = totalCost > 0 ? totalProfit / totalCost : 0;
    const score = round4(
      totalProfit +
        avgHit * 100 +
        toNum(stats?.hit3, 0) * 70 +
        toNum(stats?.hit4, 0) * 160
    );

    const recent = calcRecentRates(stats);
    const marketFit = calcMarketBoost(strategyKey, marketSnapshot, market);
    const row = {
      ...poolRow,
      ...stats,
      strategy_key: strategyKey,
      strategy_name: poolRow?.strategy_name || strategyLabel(strategyKey),
      gene_a: poolRow?.gene_a || genes.gene_a,
      gene_b: poolRow?.gene_b || genes.gene_b,
      status: String(poolRow?.status || 'active').toLowerCase(),
      total_rounds: totalRounds,
      avg_hit: round4(avgHit),
      roi: round4(roi),
      score,
      market_boost: marketFit.market_boost,
      market_reason: marketFit.market_reason,
      ...recent,
      selection_rank: idx + 1
    };

    row.decision = chooseDecision(row);
    if (!Number.isFinite(row.decision_score)) {
      row.decision_score = round4(
        score * marketFit.market_boost +
          row.hit3_rate * 220 +
          row.recent_50_hit3_rate * 300 +
          row.hit4_rate * 500
      );
    }

    return row;
  });
}

function byPowerDesc(a, b) {
  const decisionDiff = getDecisionRank(b?.decision) - getDecisionRank(a?.decision);
  if (decisionDiff !== 0) return decisionDiff;

  const scoreDiff = toNum(b?.decision_score, 0) - toNum(a?.decision_score, 0);
  if (scoreDiff !== 0) return scoreDiff;

  const hit3Diff =
    toNum(b?.recent_50_hit3_rate, toNum(b?.hit3_rate, 0)) -
    toNum(a?.recent_50_hit3_rate, toNum(a?.hit3_rate, 0));
  if (hit3Diff !== 0) return hit3Diff;

  const roiDiff = toNum(b?.recent_50_roi, toNum(b?.roi, 0)) - toNum(a?.recent_50_roi, toNum(a?.roi, 0));
  if (roiDiff !== 0) return roiDiff;

  return String(a?.strategy_key || '').localeCompare(String(b?.strategy_key || ''));
}

function sortByFormalSelection(a, b) {
  const roleA = String(a?.preferred_role || '');
  const roleB = String(b?.preferred_role || '');
  const roleScore = { attack: 4, extend: 3, guard: 2, recent: 1, mix: 0 };

  const rd = toNum(roleScore[roleB], 0) - toNum(roleScore[roleA], 0);
  if (rd !== 0) return rd;

  return byPowerDesc(a, b);
}

function assignPreferredRole(row = {}, marketSnapshot = {}) {
  const marketReason = String(row?.market_reason || '');
  const key = String(row?.strategy_key || '');

  if (marketReason.includes('streak3') || marketReason.includes('attack_core') || key.includes('hot') || key.includes('repeat')) {
    return 'attack';
  }

  if (marketReason.includes('extend') || key.includes('gap') || key.includes('chase') || key.includes('jump')) {
    return 'extend';
  }

  if (marketReason.includes('guard') || key.includes('guard') || key.includes('balanced') || key.includes('mix')) {
    return 'guard';
  }

  if (marketReason.includes('recent') || key.includes('tail') || key.includes('rotation') || key.includes('split')) {
    return 'recent';
  }

  if ((marketSnapshot?.streak3 || []).length > 0) return 'attack';
  return 'mix';
}

async function fetchStrategyCandidates(db, marketSnapshot = {}, market = {}) {
  await ensureStrategyPoolStrategies();

  const { data: poolRows, error: poolError } = await db
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  if (poolError) throw poolError;

  const strategyKeys = (poolRows || [])
    .map((row) => String(row?.strategy_key || '').trim().toLowerCase())
    .filter(Boolean);

  if (!strategyKeys.length) {
    return [];
  }

  const { data: statsRows, error: statsError } = await db
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .in('strategy_key', strategyKeys);

  if (statsError) throw statsError;

  const merged = mergePoolWithStats(poolRows || [], statsRows || [], marketSnapshot, market);

  return merged
    .filter((row) => !TERMINAL_STATUS.has(String(row?.status || '').toLowerCase()))
    .map((row) => ({
      ...row,
      preferred_role: assignPreferredRole(row, marketSnapshot)
    }))
    .sort(byPowerDesc);
}

function decorateGroupMeta(row = {}, idx = 0, role = 'mix') {
  return {
    strategy_key: String(row.strategy_key),
    strategy_name: String(row.strategy_name || strategyLabel(row.strategy_key)),
    strategy_tier: row.strategy_tier || 'core',
    decision: row.decision,
    selection_rank: idx + 1,
    decision_score: round4(row.decision_score),
    market_boost: round4(row.market_boost),
    market_reason: row.market_reason || '',
    preferred_role: role,
    hit2: toNum(row.hit2, 0),
    hit3: toNum(row.hit3, 0),
    hit4: toNum(row.hit4, 0),
    hit2_rate: round4(row.hit2_rate),
    hit3_rate: round4(row.hit3_rate),
    hit4_rate: round4(row.hit4_rate),
    recent_50_hit_rate: round4(row.recent_50_hit_rate),
    recent_50_hit3_rate: round4(row.recent_50_hit3_rate),
    recent_50_hit4_rate: round4(row.recent_50_hit4_rate),
    recent_50_roi: round4(row.recent_50_roi),
    avg_hit: round4(row.avg_hit),
    total_rounds: toNum(row.total_rounds, 0),
    roi: round4(row.roi),
    score: round4(row.score)
  };
}

function buildPredictionGroups(strategyCandidates = [], market = {}, marketSnapshot = {}, seedBase = 0) {
  const selected = [];
  const usedKeys = new Set();

  const ranked = (Array.isArray(strategyCandidates) ? strategyCandidates : [])
    .map((row) => ({
      ...row,
      preferred_role: row.preferred_role || assignPreferredRole(row, marketSnapshot)
    }))
    .sort(sortByFormalSelection);

  const roleTargets = ['attack', 'extend', 'guard', 'recent'];

  for (const role of roleTargets) {
    const candidatesForRole = ranked.filter((row) => row.preferred_role === role);
    const fallback = ranked.filter((row) => row.preferred_role !== role);
    const queue = [...candidatesForRole, ...fallback];

    for (const row of queue) {
      if (selected.length >= BET_GROUP_COUNT) break;

      const key = String(row?.strategy_key || '').trim();
      if (!key || usedKeys.has(key)) continue;

      const rawNums = buildStrategyNums(key, market, marketSnapshot, seedBase + selected.length * 19 + 11, role);
      const pools = buildDecisionPools(market, marketSnapshot);
      const finalNums = forceGroupDifference(rawNums, selected, pools, seedBase + selected.length * 23 + 3);

      if (finalNums.length !== 4) continue;

      const tooClose = selected.some((prev) => countOverlap(prev?.nums || [], finalNums) >= 3);
      if (tooClose) continue;

      usedKeys.add(key);
      selected.push({
        key,
        label: `${role.toUpperCase()}｜${row.strategy_name || strategyLabel(key)}`,
        nums: finalNums,
        meta: decorateGroupMeta(row, selected.length, role)
      });
      break;
    }
  }

  if (selected.length < BET_GROUP_COUNT) {
    for (const row of ranked) {
      if (selected.length >= BET_GROUP_COUNT) break;

      const key = String(row?.strategy_key || '').trim();
      if (!key || usedKeys.has(key)) continue;

      const role = row.preferred_role || 'mix';
      const rawNums = buildStrategyNums(key, market, marketSnapshot, seedBase + selected.length * 29 + 17, role);
      const pools = buildDecisionPools(market, marketSnapshot);
      const finalNums = forceGroupDifference(rawNums, selected, pools, seedBase + selected.length * 31 + 5);

      if (finalNums.length !== 4) continue;

      usedKeys.add(key);
      selected.push({
        key,
        label: `${role.toUpperCase()}｜${row.strategy_name || strategyLabel(key)}`,
        nums: finalNums,
        meta: decorateGroupMeta(row, selected.length, role)
      });
    }
  }

  return normalizeGroups(selected)
    .sort(compareGroupPriorityDesc)
    .slice(0, BET_GROUP_COUNT)
    .map((group, idx) => ({
      ...group,
      meta: {
        ...(group.meta || {}),
        selection_rank: idx + 1
      }
    }));
}

async function fetchMarketRows(db) {
  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(MARKET_LOOKBACK_LIMIT);

  if (error) {
    throw new Error(`fetchMarketRows failed: ${error.message || error}`);
  }

  return Array.isArray(data) ? data : [];
}

async function fetchLatestDraw(db) {
  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`fetchLatestDraw failed: ${error.message || error}`);
  }

  return data || null;
}

async function fetchNextDrawRows(db, sourceDrawNo, targetPeriods = 1) {
  const safeSource = toNum(sourceDrawNo, 0);
  const safeTarget = Math.max(1, toNum(targetPeriods, 1));

  if (!safeSource) return [];

  const { data, error } = await db
    .from(DRAWS_TABLE)
    .select('*')
    .gt('draw_no', safeSource)
    .order('draw_no', { ascending: true })
    .limit(safeTarget);

  if (error) {
    throw new Error(`fetchNextDrawRows failed: ${error.message || error}`);
  }

  return Array.isArray(data) ? data : [];
}

async function countCreatedPredictions(db) {
  const { count, error } = await db
    .from(PREDICTIONS_TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('status', 'created');

  if (error) {
    throw new Error(`countCreatedPredictions failed: ${error.message || error}`);
  }

  return toNum(count, 0);
}

function buildCompareHistoryEntry(payload = {}, drawRows = [], latestDrawNumbers = []) {
  return {
    compared_at: new Date().toISOString(),
    hit_count: toNum(payload.hitCount, 0),
    verdict: payload.verdict || 'bad',
    compared_draw_count: Array.isArray(drawRows) ? drawRows.length : 0,
    latest_draw_numbers: uniqueSorted(latestDrawNumbers),
    total_hit: toNum(payload?.compareResult?.total_hit, 0),
    total_cost: toNum(payload?.compareResult?.total_cost, 0),
    total_reward: toNum(payload?.compareResult?.total_reward, 0),
    total_profit: toNum(payload?.compareResult?.total_profit, 0),
    roi: round4(payload?.compareResult?.roi)
  };
}

async function comparePendingPredictions(db) {
  const { data: predictions, error } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .in('mode', COMPARE_MODES)
    .eq('status', 'created')
    .order('created_at', { ascending: true })
    .limit(COMPARE_BATCH_LIMIT);

  if (error) {
    throw new Error(`compare pending prediction fetch failed: ${error.message || error}`);
  }

  const processedByMode = {
    [TEST_MODE]: 0,
    [FORMAL_MODE]: 0
  };

  const waitingByMode = {
    [TEST_MODE]: 0,
    [FORMAL_MODE]: 0
  };

  let processed = 0;
  let waiting = 0;
  const disabledKeysAll = [];

  for (const prediction of predictions || []) {
    const mode = normalizePredictionMode(prediction?.mode);
    const targetPeriods = Math.max(1, toNum(prediction?.target_periods, TARGET_PERIODS));
    const sourceDrawNo = toNum(prediction?.source_draw_no, 0);

    if (!sourceDrawNo) {
      waiting += 1;
      waitingByMode[mode] += 1;
      continue;
    }

    const drawRows = await fetchNextDrawRows(db, sourceDrawNo, targetPeriods);

    if (drawRows.length < targetPeriods) {
      waiting += 1;
      waitingByMode[mode] += 1;
      continue;
    }

    const latestDrawNumbers = parseNums(drawRows[drawRows.length - 1]?.numbers || drawRows[drawRows.length - 1]?.draw_numbers);
    const payload = buildComparePayload({
      groups: prediction?.groups_json || [],
      drawRows,
      costPerGroupPerPeriod: COST_PER_GROUP_PER_PERIOD
    });

    const comparedAt = new Date().toISOString();
    const existingHistory = safeArray(prediction?.compare_history_json);
    const historyEntry = buildCompareHistoryEntry(payload, drawRows, latestDrawNumbers);
    const compareHistoryJson = [...existingHistory, historyEntry].slice(-20);

    const updatePayload = {
      status: 'compared',
      compare_status: 'done',
      hit_count: toNum(payload.hitCount, 0),
      compare_result: payload.compareResult,
      compare_result_json: payload.compareResult,
      verdict: payload.verdict || 'bad',
      compared_at: comparedAt,
      compared_draw_count: drawRows.length,
      latest_draw_numbers: latestDrawNumbers,
      compare_history_json: compareHistoryJson
    };

    const { error: updateError } = await db
      .from(PREDICTIONS_TABLE)
      .update(updatePayload)
      .eq('id', prediction.id);

    if (updateError) {
      throw new Error(`prediction compare update failed: ${updateError.message || updateError}`);
    }

    const statsResult = await recordStrategyCompareResult(payload.compareResult);

    if (Array.isArray(statsResult?.disabled_keys) && statsResult.disabled_keys.length) {
      disabledKeysAll.push(...statsResult.disabled_keys);
    }

    processed += 1;
    processedByMode[mode] += 1;
  }

  return {
    ok: true,
    processed,
    waiting,
    processed_by_mode: processedByMode,
    waiting_by_mode: waitingByMode,
    total_candidates: (predictions || []).length,
    compare_modes: [...COMPARE_MODES],
    disabled_keys: [...new Set(disabledKeysAll)]
  };
}

async function spawnStrategiesIfNeeded(db, latestDrawNo = 0) {
  const { data: activeRows, error: activeError } = await db
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  if (activeError) {
    throw new Error(`strategy_pool active fetch failed: ${activeError.message || activeError}`);
  }

  const active = Array.isArray(activeRows) ? activeRows : [];
  const activeCount = active.length;

  if (activeCount >= TARGET_ACTIVE_STRATEGY) {
    return {
      ok: true,
      active_count: activeCount,
      target_active_strategy: TARGET_ACTIVE_STRATEGY,
      max_active_strategy: MAX_ACTIVE_STRATEGY,
      spawned_count: 0,
      spawned_keys: [],
      skipped: true,
      reason: 'target_active_strategy_reached'
    };
  }

  const sorted = active
    .slice()
    .sort((a, b) => String(a?.strategy_key || '').localeCompare(String(b?.strategy_key || '')));

  const existingSet = new Set(
    sorted.map((row) => normalizeStrategyKey(row?.strategy_key)).filter(Boolean)
  );

  const needCount = Math.min(MAX_SPAWN_PER_RUN, TARGET_ACTIVE_STRATEGY - activeCount);
  const spawnedKeys = [];
  const skippedDuplicateKeys = [];
  


const nowIso = new Date().toISOString();

  if (!sorted.length) {
    return {
      ok: true,
      active_count: activeCount,
      target_active_strategy: TARGET_ACTIVE_STRATEGY,
      max_active_strategy: MAX_ACTIVE_STRATEGY,
      spawned_count: 0,
      spawned_keys: [],
      skipped_duplicate_keys: [],
      skipped: true,
      reason: 'no_active_strategy_source'
    };
  }

  let attemptCursor = 0;
  let createdCount = 0;
  const maxAttempts = Math.max(needCount * 12, 24);

  while (createdCount < needCount && attemptCursor < maxAttempts) {
    const sourceType = chooseSpawnSourceType(attemptCursor, activeCount);
    const parentA =
      sorted[attemptCursor % Math.max(sorted.length, 1)] || {
        strategy_key: 'mix_balanced',
        generation: 1
      };
    const parentB =
      sorted[(attemptCursor + 7) % Math.max(sorted.length, 1)] || {
        strategy_key: 'hot_repeat',
        generation: 1
      };

    const strategyKey = buildChildStrategyKey(
      parentA?.strategy_key || '',
      parentB?.strategy_key || '',
      sourceType === 'evolved' ? 'mutation' : sourceType,
      attemptCursor + activeCount + 1
    );

    attemptCursor += 1;

    if (!strategyKey) {
      continue;
    }

    if (existingSet.has(strategyKey)) {
      skippedDuplicateKeys.push(strategyKey);
      continue;
    }

    const genes = inferGenesFromStrategyKey(strategyKey);

    const insertRow = {
      strategy_key: strategyKey,
      strategy_name: strategyLabel(strategyKey),
      gene_a: genes.gene_a,
      gene_b: genes.gene_b,
      parameters: {
        source_type: sourceType,
        parent_a: parentA?.strategy_key || null,
        parent_b: parentB?.strategy_key || null
      },
      generation: Math.max(1, toNum(parentA?.generation, 1), toNum(parentB?.generation, 1)) + 1,
      source_type: sourceType,
      parent_keys: [parentA?.strategy_key || null, parentB?.strategy_key || null].filter(Boolean),
      status: 'active',
      protected_rank: false,
      incubation_until_draw: toNum(latestDrawNo, 0) + 1,
      created_draw_no: toNum(latestDrawNo, 0),
      created_at: nowIso,
      updated_at: nowIso
    };

    const { error: insertError } = await db
      .from(STRATEGY_POOL_TABLE)
      .insert(insertRow);

    if (insertError) {
      if (isDuplicateDrawModeError(insertError) || String(insertError?.code || '') === '23505') {
        existingSet.add(strategyKey);
        skippedDuplicateKeys.push(strategyKey);
        continue;
      }

      throw new Error(`strategy_pool spawn insert failed: ${insertError.message || insertError}`);
    }

    existingSet.add(strategyKey);
    spawnedKeys.push(strategyKey);
    createdCount += 1;
  }

  return {
    ok: true,
    active_count: activeCount,
    target_active_strategy: TARGET_ACTIVE_STRATEGY,
    max_active_strategy: MAX_ACTIVE_STRATEGY,
    spawned_count: createdCount,
    spawned_keys: spawnedKeys,
    skipped_duplicate_keys: [...new Set(skippedDuplicateKeys)],
    skipped: createdCount === 0,
    reason:
      createdCount === 0
        ? skippedDuplicateKeys.length > 0
          ? 'duplicate_keys_skipped'
          : 'no_new_spawn_key'
        : attemptCursor >= maxAttempts && createdCount < needCount
          ? 'partial_spawn_max_attempts_reached'
          : ''
  };
}

async function shrinkStrategiesIfNeeded(db) {
  const { data: activeRows, error: activeError } = await db
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  if (activeError) {
    throw new Error(`strategy_pool shrink fetch failed: ${activeError.message || activeError}`);
  }

  const active = Array.isArray(activeRows) ? activeRows : [];
  const activeCount = active.length;

  if (activeCount <= SOFT_SHRINK_TRIGGER) {
    return {
      ok: true,
      active_count: activeCount,
      disabled_count: 0,
      disabled_keys: [],
      skipped: true,
      reason: 'below_soft_trigger'
    };
  }

  const strategyKeys = active.map((row) => normalizeStrategyKey(row?.strategy_key)).filter(Boolean);

  if (!strategyKeys.length) {
    return {
      ok: true,
      active_count: activeCount,
      disabled_count: 0,
      disabled_keys: [],
      skipped: true,
      reason: 'no_active_keys'
    };
  }

  const { data: statsRows, error: statsError } = await db
    .from(STRATEGY_STATS_TABLE)
    .select('*')
    .in('strategy_key', strategyKeys);

  if (statsError) {
    throw new Error(`strategy_stats shrink fetch failed: ${statsError.message || statsError}`);
  }

  const statsMap = new Map(
    (statsRows || []).map((row) => [normalizeStrategyKey(row?.strategy_key), row])
  );

  const candidates = active
    .map((poolRow) => {
      const key = normalizeStrategyKey(poolRow?.strategy_key);
      const stats = statsMap.get(key) || {};
      const rounds = toNum(stats?.total_rounds, 0);
      const roi = toNum(stats?.roi, 0);
      const avgHit = toNum(stats?.avg_hit, 0);
      const hit3 = toNum(stats?.hit3, 0);
      const hit4 = toNum(stats?.hit4, 0);
      const recent50Hit3Rate = toNum(stats?.recent_50_hit3_rate, 0);
      const protectedRank = Boolean(poolRow?.protected_rank) || PROTECTED_STATUS.has(String(poolRow?.status || '').toLowerCase());

      return {
        key,
        protected_rank: protectedRank,
        rounds,
        roi,
        avg_hit: avgHit,
        hit3,
        hit4,
        recent_50_hit3_rate: recent50Hit3Rate,
        weakness:
          (roi < -0.15 ? 3 : 0) +
          (avgHit < 1.0 ? 2 : 0) +
          (hit3 <= 0 ? 2 : 0) +
          (hit4 <= 0 ? 1 : 0) +
          (recent50Hit3Rate <= 0.01 ? 2 : 0) -
          (rounds < 5 ? 2 : 0)
      };
    })
    .filter((row) => !row.protected_rank)
    .sort((a, b) => {
      if (b.weakness !== a.weakness) return b.weakness - a.weakness;
      if (a.roi !== b.roi) return a.roi - b.roi;
      return String(a.key).localeCompare(String(b.key));
    });

  let disableCount = 0;
  if (activeCount >= EXTREME_SHRINK_TRIGGER) disableCount = Math.min(24, candidates.length);
  else if (activeCount >= HARD_SHRINK_TRIGGER) disableCount = Math.min(12, candidates.length);
  else disableCount = Math.min(6, candidates.length);

  const disabledKeys = candidates.slice(0, disableCount).map((row) => row.key).filter(Boolean);

  if (disabledKeys.length > 0) {
    const { error: updateError } = await db
      .from(STRATEGY_POOL_TABLE)
      .update({
        status: 'disabled',
        updated_at: new Date().toISOString()
      })
      .in('strategy_key', disabledKeys);

    if (updateError) {
      throw new Error(`strategy_pool shrink update failed: ${updateError.message || updateError}`);
    }
  }

  return {
    ok: true,
    active_count: activeCount,
    disabled_count: disabledKeys.length,
    disabled_keys: disabledKeys,
    skipped: disabledKeys.length === 0,
    reason: disabledKeys.length === 0 ? 'no_disable_target' : ''
  };
}

async function createLatestTestPrediction(db, latestDrawNo, marketSnapshot = {}) {
  const sourceDrawNo = String(latestDrawNo || '').trim();

  if (!sourceDrawNo) {
    return {
      created_count: 0,
      active_created_prediction: null,
      skipped: true,
      reason: 'missing_source_draw_no'
    };
  }

  const createdNowCount = await countCreatedPredictions(db);
  if (createdNowCount >= MAX_CREATED_PREDICTIONS) {
    return {
      created_count: 0,
      active_created_prediction: null,
      skipped: true,
      reason: 'created_pool_reached_limit'
    };
  }

  const { data: existingPrediction, error: existingError } = await db
    .from(PREDICTIONS_TABLE)
    .select('*')
    .eq('mode', TEST_MODE)
    .eq('source_draw_no', sourceDrawNo)
    .eq('status', 'created')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;

  const allowCreateNow = ALLOW_CREATE_WHEN_EXISTING || !existingPrediction;
  if (!allowCreateNow) {
    return {
      created_count: 0,
      active_created_prediction: existingPrediction || null,
      skipped: true,
      reason: 'existing_created_prediction_found'
    };
  }

  const marketRows = await fetchMarketRows(db);
  const market = buildMarketState(marketRows);
  const strategyCandidates = await fetchStrategyCandidates(db, marketSnapshot, market);

  const groups = buildPredictionGroups(
    strategyCandidates,
    market,
    marketSnapshot,
    Date.now()
  )
    .slice()
    .sort(compareGroupPriorityDesc)
    .slice(0, BET_GROUP_COUNT);

  if (groups.length < BET_GROUP_COUNT) {
    return {
      created_count: 0,
      active_created_prediction: null,
      skipped: true,
      reason: 'not_enough_groups_built',
      candidate_count: strategyCandidates.length
    };
  }

  const latestDrawNumbers = uniqueSorted(market.latest || []);
  const payload = {
    mode: TEST_MODE,
    status: 'created',
    source_draw_no: sourceDrawNo,
    target_periods: TARGET_PERIODS,
    groups_json: groups,
    compare_status: 'pending',
    compare_result: null,
    compare_result_json: null,
    hit_count: 0,
    verdict: null,
    latest_draw_numbers: latestDrawNumbers,
    market_snapshot_json: marketSnapshot,
    created_at: new Date().toISOString()
  };

  let inserted = null;

  if (existingPrediction?.id) {
    const { data: updated, error: updateError } = await db
      .from(PREDICTIONS_TABLE)
      .update(payload)
      .eq('id', existingPrediction.id)
      .select('*')
      .maybeSingle();

    if (updateError) throw updateError;
    inserted = updated || existingPrediction;
  } else {
    const { data: insertedRow, error: insertError } = await db
      .from(PREDICTIONS_TABLE)
      .insert(payload)
      .select('*')
      .maybeSingle();

    if (insertError) {
      if (isDuplicateDrawModeError(insertError)) {
        return {
          created_count: 0,
          active_created_prediction: null,
          skipped: true,
          reason: 'duplicate_draw_mode'
        };
      }

      throw insertError;
    }

    inserted = insertedRow || null;
  }

  await upsertFormalCandidateFromTest(db, inserted);

  return {
    created_count: inserted?.id ? 1 : 0,
    active_created_prediction: inserted || null,
    skipped: !inserted?.id,
    reason: inserted?.id ? '' : 'insert_failed',
    groups,
    source_draw_no: sourceDrawNo,
    latest_draw_numbers: latestDrawNumbers,
    candidate_count: strategyCandidates.length
  };
}

function buildTopStrategiesSummary(strategyCandidates = []) {
  return (Array.isArray(strategyCandidates) ? strategyCandidates : [])
    .slice(0, 8)
    .map((row, idx) => ({
      rank: idx + 1,
      strategy_key: String(row?.strategy_key || ''),
      strategy_name: String(row?.strategy_name || strategyLabel(row?.strategy_key || '')),
      decision: row?.decision || '',
      decision_score: round4(row?.decision_score),
      market_boost: round4(row?.market_boost),
      market_reason: row?.market_reason || '',
      avg_hit: round4(row?.avg_hit),
      roi: round4(row?.roi),
      hit3_rate: round4(row?.hit3_rate),
      recent_50_hit3_rate: round4(row?.recent_50_hit3_rate)
    }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      api_version: API_VERSION,
      error: 'Method not allowed'
    });
  }

  try {
    const db = getSupabase();

    const compareBeforeCreate = await comparePendingPredictions(db);
    const latestDraw = await fetchLatestDraw(db);
    const latestDrawNo = toNum(latestDraw?.draw_no, 0);

    const marketRows = await fetchMarketRows(db);
    const baseMarketSnapshot = buildRecentMarketSignalSnapshot(marketRows, 'numbers');
    const marketDecision = buildStrategyDecisionFromSnapshot(baseMarketSnapshot);
    const marketSnapshot = {
      ...baseMarketSnapshot,
      ...marketDecision
    };
    const market = buildMarketState(marketRows);

    const spawn = await spawnStrategiesIfNeeded(db, latestDrawNo);
    const shrink = await shrinkStrategiesIfNeeded(db);

    const create = await createLatestTestPrediction(db, latestDrawNo, marketSnapshot);

    const compareAfterCreate = await comparePendingPredictions(db);

    const strategyCandidates = await fetchStrategyCandidates(db, marketSnapshot, market);
    const activeCreatedPrediction = create?.active_created_prediction || null;
    const displayGroups = normalizeGroups(activeCreatedPrediction?.groups_json || create?.groups || []);

    return res.status(200).json({
      ok: true,
      api_version: API_VERSION,
      compare_modes: [...COMPARE_MODES],
      latest_draw_no: latestDrawNo,
      latest_draw_time: latestDraw?.draw_time || null,
      created_count: toNum(create?.created_count, 0),
      compared_count:
        toNum(compareBeforeCreate?.processed, 0) + toNum(compareAfterCreate?.processed, 0),
      market_snapshot: marketSnapshot,
      market_decision: buildStrategyDecisionFromSnapshot(marketSnapshot),
      top_strategies: buildTopStrategiesSummary(strategyCandidates),
      active_created_prediction: activeCreatedPrediction
        ? {
            id: activeCreatedPrediction?.id || null,
            mode: activeCreatedPrediction?.mode || TEST_MODE,
            status: normalizePredictionStatus(activeCreatedPrediction?.status),
            source_draw_no: activeCreatedPrediction?.source_draw_no || null,
            target_periods: toNum(activeCreatedPrediction?.target_periods, TARGET_PERIODS),
            group_count: displayGroups.length,
            groups: displayGroups
          }
        : null,
      pipeline: {
        compare_before_create: compareBeforeCreate,
        spawn,
        shrink,
        create,
        compare_after_create: compareAfterCreate
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      api_version: API_VERSION,
      error: error?.message || 'Unknown error'
    });
  }
}

// 進攻型decision
function calcDecisionScore(meta={}){const h3=Number(meta.recent_50_hit3_rate||0); const h2=Number(meta.hit2_rate||0); const roi=Number(meta.recent_50_roi||0); return h3*60+h2*25+Math.max(roi,-1)*15;}



/* =========================
   🔧 FIX: AUTO COMPARE TRIGGER
   ========================= */

async function runAutoCompareForLatest(db) {
  try {
    const { data: latestDraw } = await db
      .from('bingo_draws')
      .select('draw_no, numbers')
      .order('draw_no', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestDraw?.draw_no) return;

    const targetDrawNo = Number(latestDraw.draw_no);

    const { data: pending } = await db
      .from('bingo_predictions')
      .select('*')
      .in('mode', ['test', 'formal'])
      .eq('compare_status', 'pending')
      .limit(50);

    if (!Array.isArray(pending) || !pending.length) return;

    for (const row of pending) {
      const source = Number(row.source_draw_no || 0);
      if (source + 1 !== targetDrawNo) continue;

      const payload = buildComparePayload({
        prediction: row,
        draw: latestDraw
      });

      const result = payload?.result || null;

      await db
        .from('bingo_predictions')
        .update({
          compare_status: 'compared',
          compare_result_json: result,
          hit_count: result?.hit_count || 0
        })
        .eq('id', row.id);

      await recordStrategyCompareResult(result);
    }
  } catch (e) {
    console.error('AUTO COMPARE ERROR', e);
  }
}

/* 👉 在主流程最後加上這一行（非常重要） */
// await runAutoCompareForLatest(getSupabase());

