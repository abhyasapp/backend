/* Neon holds the questions the Drive -> Neon pipeline maintains. The console
   reads reported questions from Supabase, but a correction belongs in Neon,
   where the question is found by its stable public qn id (70024.730011).
   Everything that reaches Neon goes through this module, so a deployment
   without NEON_DATABASE_URL fails with one clear message instead of a crash
   somewhere inside a handler. */

export type NeonRow = Record<string, unknown>;
export type NeonQueryFn = (sql: string, params: unknown[]) => Promise<NeonRow[]>;

let injected: NeonQueryFn | null = null;

/* Handler tests supply their own query function. Production never calls this. */
export function _setNeonQueryForTests(fn: NeonQueryFn | null) { injected = fn; }

export function neonConfigured(): boolean {
  return !!injected || !!Deno.env.get('NEON_DATABASE_URL');
}

let live: NeonQueryFn | null = null;

async function liveQuery(): Promise<NeonQueryFn> {
  const url = Deno.env.get('NEON_DATABASE_URL') || '';
  if (!url) throw new Error('Neon is not configured on this deployment.');
  if (live) return live;
  /* The serverless driver speaks SQL over HTTPS, so it works in an Edge
     Function where a raw Postgres socket would not. */
  const mod = await import('npm:@neondatabase/serverless');
  const sql = mod.neon(url);
  live = async (text, params) => (await sql.query(text, params)) as NeonRow[];
  return live;
}

export async function neonQuery(text: string, params: unknown[] = []): Promise<NeonRow[]> {
  const run = injected || (await liveQuery());
  return run(text, params);
}
