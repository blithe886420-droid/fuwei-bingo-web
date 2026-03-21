import { createClient } from '@supabase/supabase-js';
import {
  buildComparePayload,
  parseDrawNumbers
} from '../lib/buildComparePayload.js';
import { recordStrategyCompareResult } from '../lib/strategyStatsRecorder.js';
import { ensureStrategyPoolStrategies } from '../lib/ensureStrategyPoolStrategies.js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const DEFAULT_TARGET_PERIODS = 2;
const COMPARE_BATCH_LIMIT = 50;
const MARKET_ANALYSIS_DRAW_LIMIT = 80;
const COST_PER_GROUP_PER_PERIOD = 25;

const DEFAULT_STRATEGY_KEYS = [
  'hot_balanced',
  'cold_balanced',
  'warm_gap',
  'balanced_zone',
  'mix_zone',
  'tail_repeat',
  'zone_gap',
  'chase_balanced',
  'jump_mix',
  'cluster_hot',
  'split_balance',
  'pattern_mix',
  'guard_balanced',
  'hot_zone',
  'cold_gap',
  'repeat_tail'
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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function uniqueNums(arr = []) {
  return [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter(Number.isFinite))];
}

function zoneOf(n) {
  if (n >= 1 && n <= 20) return 1;
  if (n >= 21 && n <= 40) return 2;
  if (n >= 41 && n <= 60) return 3;
  return 4;
}

function getTail(n) {
  return n % 10;
}

function hashString(input = '') {
  let h = 2166136261;
  const str = String(input);

  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

function createRng(seedInput = '') {
  let seed = hashString(seedInput) || 123456789;

  return function rng() {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr = [], rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalizeStrategyKey(raw = '') {
  return String(raw || '').trim().toLowerCase();
}

function safeJsonArray(value) {
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

function buildStrategyName(strategyKey = '') {
  return String(strategyKey || '')
    .split('_')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

async function fetchRecentDrawRows(db, limit = MARKET_ANALYSIS_DRAW_LIMIT) {
  const { data, error } = await db
    .from('bingo_draws')
    .select('draw_no, created_at, draw_time, numbers, draw_numbers, result_numbers, open_numbers')
    .order('draw_no', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function analyzeMarket(drawRows = []) {
  const rows = Array.isArray(drawRows) ? drawRows : [];
  const freq10 = new Map();
  const freq30 = new Map();
  const freq60 = new Map();
  const lastSeenGap = new Map();
  const tailFreq = new Map();
  const zoneFreq = new Map();

  for (let n = 1; n <= 80; n++) {
    freq10.set(n, 0);
    freq30.set(n, 0);
    freq60.set(n, 0);
    lastSeenGap.set(n, 999);
  }

  for (let t = 0; t <= 9; t++) tailFreq.set(t, 0);
  for (let z = 1; z <= 4; z++) zoneFreq.set(z, 0);

  const latestRow = rows[0] || null;
  const latestNums = uniqueNums(
    parseDrawNumbers(
      latestRow?.numbers ??
      latestRow?.draw_numbers ??
      latestRow?.result_numbers ??
      latestRow?.open_numbers
    )
  );

  rows.forEach((row, rowIdx) => {
    const nums = uniqueNums(
      parseDrawNumbers(
        row?.numbers ??
        row?.draw_numbers ??
        row?.result_numbers ??
        row?.open_numbers
      )
    );

    nums.forEach((n) => {
      if (rowIdx < 10) freq10.set(n, toNum(freq10.get(n), 0) + 1);
      if (rowIdx < 30) freq30.set(n, toNum(freq30.get(n), 0) + 1);
      if (rowIdx < 60) freq60.set(n, toNum(freq60.get(n), 0) + 1);

      if (toNum(lastSeenGap.get(n), 999) === 999) {
        lastSeenGap.set(n, rowIdx);
      }

      tailFreq.set(getTail(n), toNum(tailFreq.get(getTail(n)), 0) + 1);
      zoneFreq.set(zoneOf(n), toNum(zoneFreq.get(zoneOf(n)), 0) + 1);
    });
  });

  const hotZone = [...zoneFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 1;
  const hotTailOrder = [...tailFreq.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);

  return {
    rows,
    latestRow,
    latestNums,
    freq10,
    freq30,
    freq60,
    lastSeenGap,
    tailFreq,
    zoneFreq,
    hotZone,
    hotTailOrder
  };
}

function getCandidateScore(n, analysis, tokens = []) {
  const f10 = toNum(analysis.freq10.get(n), 0);
  const f30 = toNum(analysis.freq30.get(n), 0);
  const f60 = toNum(analysis.freq60.get(n), 0);
  const gap = toNum(analysis.lastSeenGap.get(n), 999);
  const tailScore = toNum(analysis.tailFreq.get(getTail(n)), 0);
  const zoneScore = toNum(analysis.zoneFreq.get(zoneOf(n)), 0);
  const inLatest = analysis.latestNums.includes(n) ? 1 : 0;
  const nearLatest = analysis.latestNums.some((x) => Math.abs(x - n) <= 2) ? 1 : 0;

  let score = 0;

  if (tokens.includes('hot')) score += f10 * 9 + f30 * 4 + f60 * 1.5;
  if (tokens.includes('cold')) score += gap * 3.8 - f10 * 2.2 - f30 * 0.8;
  if (tokens.includes('warm')) score += f30 * 3 - Math.abs(f10 - 2) * 2 + f60;
  if (tokens.includes('gap')) score += gap * 4.2;
  if (tokens.includes('repeat')) score += inLatest * 9 + nearLatest * 2;
  if (tokens.includes('tail')) score += tailScore * 1.8;
  if (tokens.includes('zone')) score += zoneScore * 1.5 + (zoneOf(n) === analysis.hotZone ? 2 : 0);
  if (tokens.includes('mix')) score += f10 * 2 + f30 * 2 + gap * 1.2 + tailScore * 0.6;
  if (tokens.includes('chase')) score += inLatest * 7 + nearLatest * 5 + f10 * 2.5;
  if (tokens.includes('jump')) score += gap * 3.5 + (inLatest ? -10 : 0);
  if (tokens.includes('cluster')) {
    const latestAvg =
      analysis.latestNums.length > 0
        ? analysis.latestNums.reduce((a, b) => a + b, 0) / analysis.latestNums.length
        : 40;
    score += Math.max(0, 12 - Math.abs(n - latestAvg)) + nearLatest * 4;
  }
  if (tokens.includes('pattern')) score += (n % 3 === 0 ? 2.5 : 0) + (n % 5 === 0 ? 1.5 : 0);
  if (tokens.includes('structure')) score += zoneOf(n) * 0.8 + (n >= 10 && n <= 69 ? 1.2 : 0);
  if (tokens.includes('split')) score += zoneOf
