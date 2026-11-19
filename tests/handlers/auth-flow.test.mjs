// Login, session and bootstrap behaviour after the efficiency changes.
// Run: node --import ./tests/handlers/register.mjs tests/handlers/auth-flow.test.mjs
import assert from 'node:assert/strict';
import { DB, reset } from './mock-supabase.mjs';

const A = await import('../../supabase/functions/api/handlers/auth.ts');
const U = await import('../../supabase/functions/api/handlers/users.ts');
const B = await import('../../supabase/functions/api/handlers/bootstrap.ts');
const { makeStoredHash, tokenHash } = await import('../../supabase/functions/api/_shared/crypto.ts');

const call = async (fn, ...a) => (await fn(...a)).json();
const req = (ip = '1.1.1.1') => new Request('http://x', { headers: { 'x-forwarded-for': ip } });
let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);
const hour = 3600000;

reset();
const PW = 'Correct-Horse-9';
DB.tables.users = [{
  username: 'asha', email: 'asha@x.np', name: 'Asha', pass_hash: await makeStoredHash(PW), status: 'active',
  permanent_access: 'true', role: 'user', session_token: '', session_token_expires_at: '',
}];
DB.tables.admins = [];

// ── login ────────────────────────────────────────────────────────────
let r = await call(A.login, { username: 'asha', password: PW }, req());
assert.equal(r.success, true);
assert.ok(r.token);
assert.equal(r.user.username, 'asha');
assert.ok(!('pass_hash' in r.user), 'the public user never carries the hash');
assert.equal(r.permanentAccess, true);
const tok1 = r.token;
assert.equal(DB.tables.users[0].session_token, await tokenHash(tok1));
ok('login succeeds, issues a session token, and never returns the hash');

r = await call(A.login, { username: 'asha@x.np', password: PW }, req());
assert.equal(r.success, true);
ok('login also works by email');

r = await call(A.login, { username: 'asha', password: 'wrong' }, req('2.2.2.2'));
assert.equal(r.success, false); assert.equal(r.error, 'Invalid username or password.');
r = await call(A.login, { username: 'nobody', password: 'whatever' }, req('2.2.2.2'));
assert.equal(r.error, 'Invalid username or password.');         // identical message: no account enumeration
ok('wrong password and unknown user give the identical error');

// The per-account limit still trips (8 failures), whichever IP they come from.
for (let i = 0; i < 8; i++) await call(A.login, { username: 'asha', password: 'bad' + i }, req('9.9.9.' + i));
r = await call(A.login, { username: 'asha', password: PW }, req('7.7.7.7'));
assert.equal(r.success, false);
assert.match(r.error || '', /too many|try again/i);
ok('the account rate limit still blocks after repeated failures, even with the right password');

// ── authUser no longer reads the password hash, but the handlers that need it still work ──
DB.tables.rate_limits = [];
const tok = 'session-token-abc';
DB.tables.users[0].session_token = await tokenHash(tok);
DB.tables.users[0].session_token_expires_at = String(Date.now() + 30 * 24 * hour);
r = await call(U.changepassword, { username: 'asha', token: tok, currentPassword: PW, newPassword: 'Brand-New-Pass-77' });
assert.equal(r.success, true, JSON.stringify(r));
ok('changepassword (needs the hash) works under real column projection');

DB.tables.users[0].session_token = await tokenHash(tok);
DB.tables.users[0].session_token_expires_at = String(Date.now() + 30 * 24 * hour);
DB.tables.admins = [{ username: 'asha', pass_hash: DB.tables.users[0].pass_hash, role: 'admin' }];
r = await call(A.checkadmincapable, { username: 'asha', token: tok });
assert.equal(r.success, true); assert.equal(r.adminCapable, true);
r = await call(A.adminswitchfromuser, { username: 'asha', token: tok }, req());
assert.equal(r.success, true, JSON.stringify(r)); assert.equal(r.isAdmin, true);
ok('checkadmincapable and adminswitchfromuser still compare the stored hash');

DB.tables.users[0].session_token = await tokenHash(tok);
DB.tables.users[0].session_token_expires_at = String(Date.now() + 30 * 24 * hour);
r = await call(U.deletemyaccount, { username: 'asha', token: tok, password: 'wrong-password' });
assert.equal(r.success, false);
ok('deletemyaccount still verifies the password against the stored hash');

// ── bootstrap ────────────────────────────────────────────────────────
DB.tables.settings = [{ key: 'contentVersion', value: '5' }, { key: 'private_x', value: 'hide' }, { key: 'adminEmail', value: 'a@b' }];
DB.tables.weekly_sets = [];
DB.tables.users[0].session_token = await tokenHash(tok);
DB.tables.users[0].session_token_expires_at = String(Date.now() + 30 * 24 * hour);   // far from expiry → no rotation
r = await call(B.bootstrap, { username: 'asha', token: tok, correctionsSince: 0 });
assert.equal(r.success, true);
assert.equal(r.session.token, tok);
assert.equal(r.settings.settings.contentVersion, '5');
assert.ok(!('private_x' in r.settings.settings) && !('adminEmail' in r.settings.settings));
assert.equal(r.corrections.success, true);
assert.equal(r.weekly.success, true);
assert.equal(r.qstate, null);
assert.ok(r.capabilities.includes('qid-weekly'));
ok('bootstrap returns session, settings (private keys hidden), corrections and weekly sets in one call');

// The race bootstrap is designed around: a token close to expiry is ROTATED by the session
// check. Every other part must run with the NEW token, not the one it replaced.
DB.tables.users[0].session_token = await tokenHash(tok);
DB.tables.users[0].session_token_expires_at = String(Date.now() + 1 * 24 * hour);    // < 7 days → rotates
r = await call(B.bootstrap, { username: 'asha', token: tok, qstateSince: '' });
assert.equal(r.success, true);
assert.notEqual(r.session.token, tok);
assert.equal(r.corrections.sessionInvalid, undefined);
assert.equal(r.weekly.sessionInvalid, undefined);
assert.equal(r.weekly.success, true);
assert.equal(r.qstate.success, true);
ok('bootstrap survives a token rotation: the other parts use the fresh token');

r = await call(B.bootstrap, { username: 'asha', token: 'not-the-token' });
assert.equal(r.success, false); assert.equal(r.sessionInvalid, true);
ok('bootstrap rejects a bad session before doing any other work');

console.log(`\nALL ${n} AUTH-FLOW CHECKS PASSED`);
