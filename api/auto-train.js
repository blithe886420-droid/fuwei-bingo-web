import { createClient } from '@supabase/supabase-js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';
import {
  parsePredictionGroups,
  buildComparePayload,
  parseDrawNumbers
} from '../lib/buildComparePayload.js';

const CURRENT_MODE = 'test';
const TARGET_PERIODS = 2;

const BET_GROUP_COUNT = 4;
const COST_PER_GROUP_PER_PERIOD = 25;

const TRAINING_CORE_GROUP_COUNT = 3;
const TRAINING_EXPLORATION_GROUP_COUNT = 1;

const PROTECTED_TOP_N = 10;

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function pickTopStrategies(pool) {
  return pool
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, Math.max(3, Math.floor(pool.length * 0.2)));
}

function pickExploration(pool) {
  return pool
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);
}

async function buildStrategyGroupsFromPool(recent20) {
  const supabase = getSupabase();

  const { data: pool } = await supabase
    .from('strategy_pool')
    .select('*')
    .eq('status', 'active');

  if (!pool || pool.length === 0) return [];

  const top = pickTopStrategies(pool);
  const explore = pickExploration(pool);

  const final = [
    ...top.slice(0, TRAINING_CORE_GROUP_COUNT),
    ...explore.slice(0, TRAINING_EXPLORATION_GROUP_COUNT)
  ];

  return final.map((s) => ({
    key: s.strategy_key,
    nums: generateNumbers(s)
  }));
}

function generateNumbers(strategy) {
  const base = Array.from({ length: 80 }, (_, i) => i + 1);
  return base.sort(() => Math.random() - 0.5).slice(0, 4);
}

export default async function handler(req, res) {
  const supabase = getSupabase();

  const { data: recent20 } = await supabase
    .from('bingo_draws')
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(20);

  const groups = await buildStrategyGroupsFromPool(recent20);

  const payload = {
    mode: CURRENT_MODE,
    status: 'created',
    groups_json: groups,
    created_at: new Date().toISOString()
  };

  const { data } = await supabase
    .from('bingo_predictions')
    .insert(payload)
    .select('*')
    .single();

  return res.json({ ok: true, created: data });
}
