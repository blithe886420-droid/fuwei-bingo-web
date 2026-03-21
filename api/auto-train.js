import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

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

function genNums(seed) {
  const base = (seed * 131) % 80;

  return [
    (base % 80) + 1,
    ((base + 9) % 80) + 1,
    ((base + 21) % 80) + 1,
    ((base + 37) % 80) + 1
  ];
}

function getBaseUrl(req) {
  const proto =
    req.headers['x-forwarded-proto'] ||
    req.headers['x-forwarded-protocol'] ||
    'https';

  const host =
    req.headers['x-forwarded-host'] ||
    req.headers.host;

  if (!host) return null;

  return `${proto}://${host}`;
}

async function callInternalApi(baseUrl, path) {
  if (!baseUrl) {
    return {
      ok: false,
      path,
      error: 'Missing base URL'
    };
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'content-type': 'application/json'
      }
    });

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      path,
      data
    };
  } catch (error) {
    return {
      ok: false,
      path,
      error: error?.message || 'Internal fetch failed'
    };
  }
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

export default async function handler(req, res) {
  try {
    const db = getSupabase();
    const baseUrl = getBaseUrl(req);

    const pipeline = {
      catchup: await callInternalApi(baseUrl, '/api/catchup'),
      sync: await callInternalApi(baseUrl, '/api/sync'),
      compare: await callInternalApi(baseUrl, '/api/prediction-compare')
    };

    const { data: latest, error: latestError } = await db
      .from('bingo_draws')
      .select('*')
      .order('draw_no', { ascending: false })
      .limit(1);

    if (latestError) {
      throw latestError;
    }

    if (!latest || latest.length === 0) {
      return res.status(200).json({
        ok: true,
        pipeline,
        train: {
          ok: true,
          skipped: true,
          reason: 'No bingo_draws'
        }
      });
    }

    const draw = latest[0];
    const sourceDrawNo = String(draw.draw_no);

    const { data: existingPrediction, error: existingError } = await db
      .from('bingo_predictions')
      .select('id, mode, source_draw_no, status, created_at')
      .eq('mode', 'test')
      .eq('source_draw_no', sourceDrawNo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (existingPrediction) {
      return res.status(200).json({
        ok: true,
        pipeline,
        train: {
          ok: true,
          skipped: true,
          reason: 'Prediction already exists for current draw and mode',
          existing: existingPrediction
        }
      });
    }

    const now = Date.now();

    const groups = Array.from({ length: 4 }, (_, i) => ({
      key: `g_${i + 1}`,
      nums: genNums(now + i),
      meta: {
        strategy_key: `g_${i + 1}`
      }
    }));

    const payload = {
      id: now,
      mode: 'test',
      status: 'created',
      source_draw_no: sourceDrawNo,
      target_periods: 2,
      groups_json: groups,
      created_at: new Date().toISOString()
    };

    const { data: inserted, error: insertError } = await db
      .from('bingo_predictions')
      .insert(payload)
      .select('id, mode, source_draw_no, target_periods, status, created_at')
      .single();

    if (insertError) {
      if (isDuplicateDrawModeError(insertError)) {
        const { data: existingAfterDup } = await db
          .from('bingo_predictions')
          .select('id, mode, source_draw_no, status, created_at')
          .eq('mode', 'test')
          .eq('source_draw_no', sourceDrawNo)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        return res.status(200).json({
          ok: true,
          pipeline,
          train: {
            ok: true,
            skipped: true,
            reason: 'Duplicate prevented by unique_draw_mode',
            existing: existingAfterDup || null
          }
        });
      }

      throw insertError;
    }

    return res.status(200).json({
      ok: true,
      pipeline,
      train: {
        ok: true,
        inserted
      }
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || 'auto-train failed'
    });
  }
}
