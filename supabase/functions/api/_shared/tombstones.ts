// _shared/tombstones.ts — records deletions so the Supabase↔GAS sync job can
// propagate them instead of resurrecting deleted rows from the other side.
// Table `deleted_records(table_name, pk, deleted_at)` is created by the
// 20261021000000_admin_enhancements.sql migration. Failures are non-fatal.

import { supabase } from './db.ts';

export async function recordDeletion(table: string, pks: string[]): Promise<void> {
  const clean = [...new Set(pks.map((p) => String(p || '').trim()).filter(Boolean))];
  if (!clean.length) return;
  try {
    const now = new Date().toISOString();
    const { error } = await supabase.from('deleted_records').upsert(
      clean.map((pk) => ({ table_name: table, pk: pk.toLowerCase(), deleted_at: now })),
      { onConflict: 'table_name,pk' },
    );
    // supabase-js returns errors instead of throwing, so check explicitly.
    if (error) console.error('[tombstone] upsert failed', table, error.message);
  } catch (e) {
    console.error('[tombstone] could not record deletion', table, e);
  }
}
