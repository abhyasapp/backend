import { supabase } from './db.ts';

const memRL = new Map<string, { c: number; r: number }>();

export async function rlBlocked(key: string, max: number): Promise<boolean> {
  const now = Date.now();
  const m = memRL.get(key);
  if (m && m.r > now && m.c >= max) return true;
  try {
    const { data } = await supabase.from('rate_limits').select('count,reset_at').eq('key', key).limit(1);
    const row = data && data[0];
    if (row && Number(row.reset_at) > now && Number(row.count) >= max) return true;
  } catch { /* ignore */ }
  return false;
}

export async function rlHit(key: string, windowMs: number): Promise<void> {
  const now = Date.now();
  const m = memRL.get(key);
  if (!m || m.r <= now) memRL.set(key, { c: 1, r: now + windowMs });
  else m.c++;
  if (memRL.size > 5000) { for (const [k, v] of memRL) if (v.r <= now) memRL.delete(k); }
  try {
    // Atomic increment (public.rl_hit, migration 20261115000000): concurrent requests can no longer
    // read the same count and under-count. Falls back to read-then-write if the function isn't deployed yet.
    const { error: rpcErr } = await supabase.rpc('rl_hit', { p_key: key, p_window_ms: windowMs });
    if (!rpcErr) return;
    const { data } = await supabase.from('rate_limits').select('count,reset_at').eq('key', key).limit(1);
    const row = data && data[0];
    if (!row || Number(row.reset_at) <= now) {
      await supabase.from('rate_limits').upsert({ key, count: 1, reset_at: now + windowMs });
    } else {
      await supabase.from('rate_limits').update({ count: Number(row.count) + 1 }).eq('key', key);
    }
  } catch { /* ignore */ }
}

export async function rlClear(key: string): Promise<void> {
  memRL.delete(key);
  try { await supabase.from('rate_limits').delete().eq('key', key); } catch { /* ignore */ }
}

export const RL_WINDOW_MS = 15 * 60 * 1000;
export const RL_TOO_MANY = { success: false, rateLimited: true, error: 'Too many attempts. Please wait a few minutes and try again.' };