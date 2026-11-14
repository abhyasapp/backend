import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

/**
 * Reads EVERY matching row, page by page. PostgREST silently caps a single
 * response at 1000 rows (the project default), so plain select() calls
 * under-report once a table grows past that.
 * `orderBy` must be a unique-ish, stable column so pages don't overlap.
 */
export async function selectAll(
  table: string,
  columns: string,
  opts: { orderBy: string; thenBy?: string; ascending?: boolean; max?: number; apply?: (q: any) => any },
): Promise<any[]> {
  const page = 1000;
  const max = opts.max ?? 100000;
  const out: any[] = [];
  for (let from = 0; from < max; from += page) {
    let q: any = supabase.from(table).select(columns);
    if (opts.apply) q = opts.apply(q);
    q = q.order(opts.orderBy, { ascending: opts.ascending ?? true });
    if (opts.thenBy) q = q.order(opts.thenBy, { ascending: true });   // tie-breaker so pages never overlap
    q = q.range(from, Math.min(from + page, max) - 1);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}
