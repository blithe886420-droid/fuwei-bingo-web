import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE service role key');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

const CURRENT_MODE = 'test';
const PICK_COUNT = 4;
const DRAW_COMPARE_LIMIT = 2;
const RECENT_ANALYSIS_LIMIT = 20;

const STRATEGY_POOL_TABLE = 'strategy_pool';
const PREDICTIONS_TABLE = 'bingo_predictions';
const DRAWS_TABLE = 'bingo_draws';

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueAsc(nums) {
  return [...new Set((Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
}

function stableHash(text = '') {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function rotateList(source, offset = 0) {
  if (!Array.isArray(source) || source.length === 0) return [];
  const len = source.length;
  const safeOffset = ((offset % len) + len) % len;
  return [...source.slice(safeOffset), ...source.slice(0, safeOffset)];
}

function parseDrawNumbers(value) {
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((s) => Number(String(s).trim()))
      .filter(Number.isFinite);
  }

  return [];
}

function buildRecentAnalysis(rows = []) {
  const parsedRows = (Array.isArray(rows) ? rows : []).map((row) => ({
    draw_no: toNum(row?.draw_no, 0),
    draw_time: row?.draw_time || null,
    numbers: parseDrawNumbers(row?.numbers)
  }));

  const latestDraw = parsedRows[0]?.numbers || [];
  const allNums = parsedRows.flatMap((row) => row.numbers);

  const freq = new Map();
  for (let i = 1; i <= 80; i += 1) freq.set(i, 0);
  for (const n of allNums) freq.set(n, (freq.get(n) || 0) + 1);

  const hottest = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([n]) => n);

  const coldest = [...freq.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([n]) => n);

  return {
    hottest,
    coldest,
    latestDraw
  };
}

function buildGroupsFromStrategies(strategies = [], recentRows = []) {
  const analysis = buildRecentAnalysis(recentRows);

  return strategies.map((row, idx) => {
    const key = row.strategy_key || `strategy_${idx + 1}`;
    const seed = stableHash(`${key}_${idx}`);
    const hotPool = rotateList(analysis.hottest, seed % 17);
    const latestPool = rotateList(analysis.latestDraw, seed % 5);
    const coldPool = rotateList(analysis.coldest, seed % 11);

    const nums = uniqueAsc([
      ...latestPool.slice(0, 1),
      ...hotPool.slice(0, 5),
      ...coldPool.slice(0, 2)
    ]).slice(0, 4);

    return {
      key,
      label: row.strategy_name || key,
      nums,
      reason: '',
      meta: {
        strategy_key: key,
        strategy_name: row.strategy_name || key
      }
    };
  });
}

function getFallbackStrategies() {
  return [
    { strategy_key: 'hot_balanced', strategy_name: 'Hot Balanced' },
    { strategy_key: 'balanced_zone', strategy_name: 'Balanced Zone' },
    { strategy_key: 'hot_chase', strategy_name: 'Hot Chase' },
    { strategy_key: 'repeat_guard', strategy_name: 'Repeat Guard' }
  ];
}

async function getLatestDraw() {
  const { data } = await supabase
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data || null;
}

async function getLastPredictionDrawNo() {
  const { data } = await supabase
    .from(PREDICTIONS_TABLE)
    .select('source_draw_no')
    .eq('mode', CURRENT_MODE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return toNum(data?.source_draw_no, 0);
}

async function getRecentDrawRows(limitCount = RECENT_ANALYSIS_LIMIT) {
  const { data } = await supabase
    .from(DRAWS_TABLE)
    .select('*')
    .order('draw_no', { ascending: false })
    .limit(limitCount);

  return Array.isArray(data) ? data : [];
}

async function getActiveStrategies() {
  const { data } = await supabase
    .from(STRATEGY_POOL_TABLE)
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return getFallbackStrategies();
  return rows.slice(0, PICK_COUNT);
}

export default async function handler(req, res) {
  try {
    // 🔥 關鍵：允許 GET / POST 都可進來
    if (req.method !== 'POST' && req.method !== 'GET') {
      return res.status(405).json({
        ok: false,
        error: 'Method not allowed'
      });
    }

    const latestDraw = await getLatestDraw();
    if (!latestDraw) {
      return res.status(200).json({ ok: true, message: 'no draw' });
    }

    const lastProcessed = await getLastPredictionDrawNo();

    if (toNum(latestDraw.draw_no) === lastProcessed) {
      return res.status(200).json({
        ok: true,
        message: 'already processed',
        draw_no: toNum(latestDraw.draw_no, 0)
      });
    }

    const strategies = await getActiveStrategies();
    const recentRows = await getRecentDrawRows();
    const groups = buildGroupsFromStrategies(strategies, recentRows);

    return res.status(200).json({
      ok: true,
      draw_no: toNum(latestDraw.draw_no, 0),
      groups
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'fail'
    });
  }
}
