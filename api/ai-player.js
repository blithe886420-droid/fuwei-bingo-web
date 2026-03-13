export default async function handler(req, res) {

  try {

    const SUPABASE_URL = process.env.SUPABASE_URL
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      return res.status(500).json({
        ok:false,
        error:"Missing Supabase env"
      })
    }

    // 1️⃣ 檢查是否有 test prediction 正在跑
    const runningRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions?mode=eq.test&status=eq.running`,
      {
        headers:{
          apikey:SUPABASE_SECRET_KEY,
          Authorization:`Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    )

    const running = await runningRes.json()

    if (running.length > 0) {
      return res.status(200).json({
        ok:true,
        message:"AI test already running"
      })
    }

    // 2️⃣ 取得策略生成
    const strategyRes = await fetch(`${process.env.APP_URL}/api/strategy-generate`)
    const strategyData = await strategyRes.json()

    if (!strategyData.ok) {
      return res.status(500).json({
        ok:false,
        error:"strategy generate failed"
      })
    }

    const groups = strategyData.groups || []

    if (!groups.length) {
      return res.status(500).json({
        ok:false,
        error:"No groups generated"
      })
    }

    // 3️⃣ 建立 test prediction
    const payload = {
      id: Date.now(),
      mode:"test",
      status:"created",
      source_draw_no:"AI_PLAYER",
      target_periods:2,
      groups_json: groups
    }

    const saveRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bingo_predictions`,
      {
        method:"POST",
        headers:{
          apikey:SUPABASE_SECRET_KEY,
          Authorization:`Bearer ${SUPABASE_SECRET_KEY}`,
          "Content-Type":"application/json",
          Prefer:"return=representation"
        },
        body:JSON.stringify(payload)
      }
    )

    const row = await saveRes.json()

    return res.status(200).json({
      ok:true,
      created:true,
      row
    })

  } catch(err) {

    return res.status(500).json({
      ok:false,
      error:err.message
    })

  }

}
