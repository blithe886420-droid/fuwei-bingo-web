export default async function handler(req, res) {
  try {

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SUPABASE_SECRET_KEY =
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing environment variables"
      })
    }

    const headers = {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json"
    }

    const latestRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?mode=eq.test&status=eq.running&order=created_at.desc&limit=1`,
      { headers }
    )

    const latest = await latestRes.json()

    if (Array.isArray(latest) && latest.length > 0) {
      return res.status(200).json({
        ok: true,
        message: "test prediction already running"
      })
    }

    const strategyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/strategy_pool_active?order=recent_50_roi.desc&limit=4`,
      { headers }
    )

    const strategies = await strategyRes.json()

    if (!Array.isArray(strategies) || strategies.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "no strategy available"
      })
    }

    const groups = strategies.slice(0, 4).map((s, i) => ({
      key: s.key,
      label: s.label,
      nums: s.nums,
      reason: `AI Player strategy ${s.label}`
    }))

    const sourceDrawNo = Date.now()

    const payload = {
      id: Date.now(),
      mode: "test",
      status: "running",
      source_draw_no: sourceDrawNo,
      target_periods: 2,
      groups_json: groups
    }

    const saveRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions`,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify(payload)
      }
    )

    if (!saveRes.ok) {
      const detail = await saveRes.text()
      return res.status(500).json({
        ok: false,
        error: "create ai player prediction failed",
        detail
      })
    }

    return res.status(200).json({
      ok: true,
      created: true
    })

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "ai player failed"
    })
  }
}
