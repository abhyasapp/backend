import assert from 'node:assert/strict';
import { json, SECURITY_HEADERS } from '../supabase/functions/api/_shared/http.ts';

const res = json({ success: true }, 201);
assert.equal(res.status, 201);
assert.equal(res.headers.get('content-type'), 'application/json');

for (const [name, expected] of Object.entries(SECURITY_HEADERS)) {
  assert.equal(res.headers.get(name.toLowerCase()), expected, `${name} header`);
}

console.log('API JSON responses send no-store, nosniff, and no-referrer headers');
