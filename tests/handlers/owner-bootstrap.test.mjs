// owner-bootstrap.test.mjs — a fresh install must never get an owner account with
// a password that is written in the source. Without DEFAULT_OWNER_PASSWORD the
// bootstrap has to refuse, not fall back to the old published default.
import assert from 'node:assert/strict';
import { DB, reset } from './mock-supabase.mjs';

const Auth = await import('../../supabase/functions/api/handlers/auth.ts');
const call = async (fn, params) => (await fn(params, new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4' } }))).json();

reset();

const r = await call(Auth.adminlogin, { username: 'admin', password: 'abhyas' });
assert.equal(r.success, false, 'login with the old published default must fail');
assert.equal(DB.tables.admins.length, 0, 'no owner row may be created without the secret');

const r2 = await call(Auth.adminlogin, { username: 'admin', password: '' });
assert.equal(r2.success, false);

console.log('  \u2713 owner bootstrap refuses without DEFAULT_OWNER_PASSWORD');
