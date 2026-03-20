import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function evolveStrategies() {
  const { data } = await supabase
    .from('strategy_stats')
    .select('*');

  if (!data) return;

  const sorted = data.sort((a, b) => (b.roi || 0) - (a.roi || 0));

  const top = sorted.slice(0, 5).map((s) => s.strategy_key);

  for (const key of top) {
    await supabase
      .from('strategy_pool')
      .update({ status: 'active' })
      .eq('strategy_key', key);
  }

  return { ok: true };
}
