import assert from 'node:assert/strict';
import { DB, reset } from './mock-supabase.mjs';
const A = await import('../../supabase/functions/api/handlers/admin.ts');
const Auth = await import('../../supabase/functions/api/handlers/auth.ts');
const Content = await import('../../supabase/functions/api/handlers/content.ts');
const { makeStoredHash } = await import('../../supabase/functions/api/_shared/crypto.ts');
const call = async (fn, params, req = new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4' } })) => (await fn(params, req)).json();
let n = 0; const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);

reset();
// 1. first admin login creates the default owner admin/abhyas and demands a change
let r = await call(Auth.adminlogin, { username: 'admin', password: 'abhyas' });
assert.equal(r.success, true); assert.equal(r.mustChangePassword, true); assert.equal(r.isOwner, true);
let tok = r.adminToken; ok('first login admin/abhyas creates the owner, mustChangePassword=true');
assert.equal(DB.tables.admins.length, 1);

// 2. everything except change-password is blocked
r = await call(A.adminstats, { username: 'admin', token: tok }); assert.equal(r.mustChangePassword, true); assert.equal(r.success, false);
r = await call(A.admincreateadmin, { username: 'admin', token: tok, newUsername: 'bob', password: 'Str0ngPass!' }); assert.equal(r.mustChangePassword, true);
r = await call(A.adminlistadmins, { username: 'admin', token: tok }); assert.equal(r.mustChangePassword, true);
ok('every admin action is blocked until the password is changed');

// 3. password policy on change
for (const [pw, why] of [['abhyas', 'default'], ['short', 'short'], ['abhyas123', 'common'], ['abhyas', 'x']]) {
  r = await call(A.adminchangepassword, { username: 'admin', token: tok, currentPassword: 'abhyas', newPassword: pw });
  assert.equal(r.success, false, why);
}
r = await call(A.adminchangepassword, { username: 'admin', token: tok, currentPassword: 'WRONG', newPassword: 'N3w-Secret-Pw' }); assert.equal(r.success, false);
ok('weak / default / wrong-current passwords are rejected');

r = await call(A.adminchangepassword, { username: 'admin', token: tok, currentPassword: 'abhyas', newPassword: 'N3w-Secret-Pw' });
assert.equal(r.success, true); assert.ok(r.adminToken); assert.equal(r.mustChangePassword, false);
const oldTok = tok; tok = r.adminToken;
r = await call(A.adminstats, { username: 'admin', token: oldTok }); assert.equal(r.sessionInvalid, true);
r = await call(A.adminstats, { username: 'admin', token: tok }); assert.equal(r.success, true);
ok('change works, returns a fresh token, old token dies, console unlocked');

r = await call(Auth.adminlogin, { username: 'admin', password: 'abhyas' }, new Request('http://x', { headers: { 'x-forwarded-for': '9.9.9.9' } })); assert.equal(r.success, false);
r = await call(Auth.adminlogin, { username: 'admin', password: 'N3w-Secret-Pw' }, new Request('http://x', { headers: { 'x-forwarded-for': '9.9.9.9' } }));
assert.equal(r.success, true); assert.equal(r.mustChangePassword, false); tok = r.adminToken;
ok('default password no longer works; new password logs in without a forced change');
assert.equal(DB.tables.admins.filter((a) => a.role === 'owner').length, 1);

// 4. owner-only management
DB.tables.users = [{ username: 'sita', pass_hash: await makeStoredHash('Sita-pass-1'), status: 'trial', name: 'Sita', email: '', mobile: '' }];
r = await call(Auth.login, { username: 'SITA', password: 'Sita-pass-1' });
assert.equal(r.success, true);
r = await call(Auth.login, { username: 'sita', password: 'Sita-pass-1' });
assert.equal(r.success, true);
ok('student login accepts a different username case, exact match still wins');
const O = { username: 'admin', token: tok };
r = await call(A.admincreateadmin, { ...O, newUsername: 'root', password: 'Str0ngPass!' }); assert.equal(r.success, false); // reserved
r = await call(A.admincreateadmin, { ...O, newUsername: 'sita', password: 'Str0ngPass!' }); assert.equal(r.success, false); // student exists
r = await call(A.admincreateadmin, { ...O, newUsername: 'bob', password: 'Str0ngPass!', permissions: { users_view: true, admins_manage: true, payments_review: 'true' } });
assert.equal(r.success, true); assert.deepEqual(r.permissions.sort(), ['payments_review', 'users_view']);
ok('owner creates an admin; reserved + student names refused; owner-only features stripped from grants');

r = await call(Auth.adminlogin, { username: 'bob', password: 'Str0ngPass!' }, new Request('http://x', { headers: { 'x-forwarded-for': '5.5.5.5' } }));
assert.equal(r.success, true); assert.equal(r.isOwner, false); const bob = { username: 'bob', token: r.adminToken };
r = await call(A.adminlistusers, bob); assert.equal(r.success, true);              // has users_view
r = await call(A.adminlistpayments, bob); assert.equal(r.forbidden, true);         // no payments_view
for (const [fn, extra] of [[A.admincreateadmin, { newUsername: 'x1', password: 'Str0ngPass!' }], [A.admindeleteadmin, { targetUsername: 'admin' }], [A.adminsetadminpermissions, { targetUsername: 'bob', features: { dashboard: true } }], [A.adminpromoteowner, { targetUsername: 'bob' }], [A.adminpromoteusertoadmin, { targetUsername: 'sita' }], [A.adminresetadminpassword, { targetUsername: 'admin' }], [A.admindemoteowner, { targetUsername: 'admin' }]]) {
  r = await call(fn, { ...bob, ...extra }); assert.equal(r.success, false); assert.equal(r.ownerOnly, true);
}
ok('a normal admin is refused every owner-only action');

r = await call(A.adminpromoteusertoadmin, { ...O, targetUsername: 'sita', permissions: ['users_view', 'admins_view'] });
assert.equal(r.success, true); assert.deepEqual(r.permissions, ['users_view']);
assert.equal(DB.tables.admins.find((a) => a.username === 'sita').pass_hash, DB.tables.users[0].pass_hash);
ok('student promoted by owner with permissions (shares password hash for switch-to-admin)');

// 5. last-owner protection
r = await call(A.admindemoteowner, { ...O, targetUsername: 'admin' }); assert.equal(r.success, false);
r = await call(A.admindeleteadmin, { ...O, targetUsername: 'admin' }); assert.equal(r.success, false);
r = await call(A.adminpromoteowner, { ...O, targetUsername: 'bob' }); assert.equal(r.success, true);
r = await call(A.admindemoteowner, { ...O, targetUsername: 'admin' }); assert.equal(r.success, true);          // two owners → allowed
r = await call(Auth.adminlogin, { username: 'admin', password: 'N3w-Secret-Pw' }, new Request('http://x', { headers: { 'x-forwarded-for': '6.6.6.6' } }));
tok = r.adminToken; assert.equal(r.isOwner, false);
r = await call(Auth.adminlogin, { username: 'bob', password: 'Str0ngPass!' }, new Request('http://x', { headers: { 'x-forwarded-for': '7.7.7.7' } }));
const O2 = { username: 'bob', token: r.adminToken }; assert.equal(r.isOwner, true);
r = await call(A.admindemoteowner, { ...O2, targetUsername: 'bob' }); assert.equal(r.success, false);              // now the last owner
r = await call(A.admindeleteadmin, { ...O2, targetUsername: 'admin' }); assert.equal(r.success, true);
assert.ok(DB.tables.deleted_records.some((d) => d.table_name === 'admins' && d.pk === 'admin'));
ok('last owner cannot be demoted/deleted; owner promote/demote works; deletion writes a tombstone');

// 6. owner resets an admin password -> temp password, forced change
r = await call(A.adminresetadminpassword, { ...O2, targetUsername: 'sita' });
assert.equal(r.success, true); assert.ok(r.tempPassword);
r = await call(Auth.adminlogin, { username: 'sita', password: r.tempPassword }, new Request('http://x', { headers: { 'x-forwarded-for': '8.8.8.8' } }));
assert.equal(r.success, true); assert.equal(r.mustChangePassword, true);
r = await call(A.adminlistusers, { username: 'sita', token: r.adminToken }); assert.equal(r.mustChangePassword, true);
ok('owner reset gives a one-time temp password and forces a change');

// 7. audit log
assert.ok(DB.tables.logs.some((l) => l.action === 'Create admin') && DB.tables.logs.some((l) => l.action === 'Reset admin password'));
ok('audit log entries written');

// 8. getfile returns parsed result (+ legacy content)
DB.tables.users.push({ username: 'stu', status: 'active', permanent_access: 'true', session_token: 'h:' + Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tkn'))).toString('hex'), session_token_expires_at: String(Date.now() + 1e6) });
DB.storage['weekly-sets/w1.json'] = JSON.stringify({ questions: [{ q: 'a', correct: 1 }] });
DB.tables.weekly_sets = [{ file_id: 'w1.json', release_at: '2020-01-01T00:00:00.000Z' }];
r = await call(Content.getfile, { username: 'stu', token: 'tkn', fileId: 'weekly-sets/w1.json' });
assert.equal(r.success, true); assert.deepEqual(r.result, { questions: [{ q: 'a', correct: 1 }] }); assert.equal(typeof r.content, 'string');
r = await call(Content.getfiles, { username: 'stu', token: 'tkn', fileIds: 'weekly-sets/w1.json' });
assert.deepEqual(r.files['weekly-sets/w1.json'].result.questions[0].correct, 1);
ok('getfile/getfiles return parsed `result` and legacy `content`');
console.log(`\nALL ${n} BEHAVIOUR CHECKS PASSED`);
