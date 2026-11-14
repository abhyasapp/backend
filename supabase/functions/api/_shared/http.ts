export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// Applied to every API response, including errors and preflight. API responses
// may contain session tokens and personal data, so intermediaries must not
// cache them. The other two headers make the JSON content type explicit to
// browsers and avoid leaking the site URL through the Referer header.
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, ...SECURITY_HEADERS, 'Content-Type': 'application/json' },
  });

export function dbMsg(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  console.error('[db]', err && err.code ? err.code : '', err && err.message ? err.message : String(e));
  if (err && err.code === '23505') return 'That value is already in use.';
  return 'Something went wrong. Please try again.';
}

export function escLike(s: string): string { return s.replace(/[\\%_]/g, '\\$&'); }

export function clientIp(req: Request): string {
  return (req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || 'unknown').trim();
}