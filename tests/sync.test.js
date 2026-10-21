'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scripts/sync.js');

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 9, 1);

test('composite primary keys are kept distinct and case-insensitive', () => {
  const a = { username: 'Sita', weekly_id: 'w1' };
  const b = { username: 'sita', weekly_id: 'w2' };
  assert.equal(S.pkOf('weekly_attempts', a), 'sita|w1');
  assert.notEqual(S.pkOf('weekly_attempts', a), S.pkOf('weekly_attempts', b));
  assert.equal(S.pkOf('admin_permissions', { username: 'A', feature_key: 'users_view' }), 'a|users_view');
});

test('rename maps convert GAS columns and back, including admins / permissions / backups', () => {
  assert.deepEqual(S.gasToSupabase('admins', { username: 'x', passHash: 'h', tokenExpires: '1', createdBy: 'o' }),
    { username: 'x', pass_hash: 'h', token_expires: '1', created_by: 'o' });
  assert.deepEqual(S.gasToSupabase('admin_permissions', { featureKey: 'f', updatedBy: 'o' }), { feature_key: 'f', updated_by: 'o' });
  assert.deepEqual(S.gasToSupabase('progress_backups', { backupId: 'b', importId: 'i' }), { backup_id: 'b', import_id: 'i' });
  assert.deepEqual(S.supabaseToGas('users', { pass_hash: 'h', mobile: null }), { passHash: 'h', mobile: '' });
});

test('supabase-wins: Supabase row beats GAS row; identical rows are not pushed', () => {
  const supa = [{ username: 'a', name: 'Supa', pass_hash: 'p2:new' }];
  const gas = [{ username: 'a', name: 'Gas', passHash: 'p2:old' }];
  const r = S.mergeTable('users', supa, gas, {});
  assert.equal(r.toSupabase.length, 0);
  assert.equal(r.toGas.length, 1);
  assert.equal(r.toGas[0].name, 'Supa');
  assert.equal(r.toGas[0].passHash, 'p2:new');

  const same = S.mergeTable('users', [{ username: 'a', name: 'X' }], [{ username: 'a', name: 'X' }], {});
  assert.equal(same.toGas.length + same.toSupabase.length, 0);
  assert.equal(same.unchanged, 1);
});

test('GAS-only users (fallback signups) are copied to Supabase', () => {
  const r = S.mergeTable('users', [], [{ username: 'new', passHash: 'h', createdAt: iso(T0) }], { tombstones: new Map() });
  assert.equal(r.toSupabase.length, 1);
  assert.equal(r.toSupabase[0].pass_hash, 'h');
  assert.equal(r.deleteGas.length, 0);
});

test('a deleted user is deleted from GAS instead of being resurrected', () => {
  const tomb = new Map([['gone', T0 + 1000]]);
  const r = S.mergeTable('users', [], [{ username: 'gone', passHash: 'h', createdAt: iso(T0) }], { tombstones: tomb });
  assert.deepEqual(r.deleteGas, [{ username: 'gone' }]);
  assert.equal(r.toSupabase.length, 0);
});

test('a user re-created AFTER the tombstone is kept (resurrection guard)', () => {
  const tomb = new Map([['again', T0]]);
  const r = S.mergeTable('users', [], [{ username: 'again', passHash: 'h', createdAt: iso(T0 + 86400000) }], { tombstones: tomb });
  assert.equal(r.deleteGas.length, 0);
  assert.equal(r.toSupabase.length, 1);
});

test('admin_permissions: revoked permissions are removed from GAS, never copied back', () => {
  const supa = [{ username: 'ad', feature_key: 'users_view', enabled: 'true' }];
  const gas = [
    { username: 'ad', featureKey: 'users_view', enabled: 'true' },
    { username: 'ad', featureKey: 'payments_review', enabled: 'true' },   // revoked in Supabase
  ];
  const r = S.mergeTable('admin_permissions', supa, gas, {});
  assert.deepEqual(r.deleteGas, [{ username: 'ad', feature_key: 'payments_review' }]);
  assert.equal(r.toSupabase.length, 0);
});

test('newer-wins picks the most recently changed side (progress)', () => {
  const supa = [{ username: 'u', data: 'S', updated_at: iso(T0) }];
  const gas = [{ username: 'u', data: 'G', updatedAt: iso(T0 + 5000) }];
  const r = S.mergeTable('progress', supa, gas, {});
  assert.equal(r.toSupabase.length, 1);
  assert.equal(r.toSupabase[0].data, 'G');
  assert.equal(r.toGas.length, 0);
});

test('earliest-wins keeps the first weekly start (cheat prevention)', () => {
  const supa = [{ username: 'u', weekly_id: 'w', started_at: T0 + 9000 }];
  const gas = [{ username: 'u', weeklyId: 'w', startedAt: T0 + 1000 }];
  const r = S.mergeTable('weekly_starts', supa, gas, {});
  assert.equal(r.toSupabase[0].started_at, T0 + 1000);
});

test('progress_history merges both sides into the 3 newest distinct snapshots', () => {
  const m = S.mergeHistory(
    { username: 'u', data1: 'a', saved_at1: iso(T0 + 3), data2: 'b', saved_at2: iso(T0 + 1), data3: '', saved_at3: '' },
    { username: 'u', data1: 'c', saved_at1: iso(T0 + 4), data2: 'a', saved_at2: iso(T0 + 3), data3: 'd', saved_at3: iso(T0) });
  assert.deepEqual([m.data1, m.data2, m.data3], ['c', 'a', 'b']);
});

test('verified email on GAS survives a Supabase-wins merge when the email is unchanged', () => {
  const s = { username: 'u', email: 'a@x.com', email_verified: 'false' };
  const g = { username: 'u', email: 'A@x.com', email_verified: 'true' };
  assert.equal(S.keepVerifiedEmail(s, s, g).email_verified, 'true');
  const changed = { ...g, email: 'other@x.com' };
  assert.equal(S.keepVerifiedEmail(s, s, changed).email_verified, 'false');
});

test('GAS-only columns are dropped for Supabase and preserved on GAS', () => {
  const supa = [{ username: 'u', name: 'N' }];
  const gas = [{ username: 'u', name: 'Old', contact: 'keep-me', contactType: 'sms' }];
  const r = S.mergeTable('users', supa, gas, {
    supaCols: new Set(['username', 'name']), gasCols: new Set(['username', 'name', 'contact', 'contactType']),
  });
  assert.equal(r.toGas[0].contact, 'keep-me');            // GAS-only data not wiped
  const gasNew = S.mergeTable('users', [], [{ username: 'n', name: 'N', contact: 'c' }], { supaCols: new Set(['username', 'name']), tombstones: new Map() });
  assert.deepEqual(Object.keys(gasNew.toSupabase[0]).sort(), ['name', 'username']);   // contact filtered
});

test('type coercion: empty strings become null for numeric Supabase columns', () => {
  assert.equal(S.coerceForSupabase('', 'integer'), null);
  assert.equal(S.coerceForSupabase('3', 'integer'), 3);
  assert.equal(S.coerceForSupabase('true', 'boolean'), true);
  assert.equal(S.coerceForSupabase('', 'string'), '');
});

test('bulk upserts are grouped by identical key sets', () => {
  const g = S.groupBySignature([{ a: 1, b: 2 }, { a: 3 }, { b: 4, a: 5 }]);
  assert.equal(g.length, 2);
});

test('pullAll paginates and verifies the server-side count', async () => {
  const all = Array.from({ length: 25 }, (_, i) => ({ id: String(i) }));
  const mk = (lie) => async (url, opts) => {
    const [from, to] = opts.headers.Range.split('-').map(Number);
    const page = all.slice(from, to + 1);
    return { ok: true, status: 200, json: async () => page, text: async () => '', headers: { get: () => `${from}-${from + page.length - 1}/${lie ? 99 : all.length}` } };
  };
  const ok = S.createSupabase({ url: 'http://x', key: 'k', fetchImpl: mk(false), pageSize: 10 });
  assert.equal((await ok.pullAll('t', ['id'])).length, 25);
  const bad = S.createSupabase({ url: 'http://x', key: 'k', fetchImpl: mk(true), pageSize: 10 });
  await assert.rejects(() => bad.pullAll('t', ['id']), /count mismatch|pagination/);
});

test('run(): failures are reported (exit-code material) and dry-run writes nothing', async () => {
  const writes = [];
  const supa = {
    schema: async () => ({}),
    pullAll: async (t) => (t === 'deleted_records' ? [] : t === 'users' ? [{ username: 'a', name: 'S' }] : []),
    upsert: async (...a) => writes.push(['supa', ...a]),
  };
  const gas = {
    pull: async (t) => (t === 'settings' ? { success: true, tables: {}, errors: { settings: 'boom' } } : { success: true, tables: { [t]: t === 'users' ? [{ username: 'a', name: 'G' }] : [] } }),
    push: async (...a) => writes.push(['gas', ...a]),
    del: async (...a) => writes.push(['del', ...a]),
  };
  const dry = await S.run({ supa, gas, dryRun: true, log: { log() {}, warn() {} } });
  assert.equal(writes.length, 0);
  assert.ok(dry.errors.some((e) => e.startsWith('settings:')));
  const live = await S.run({ supa, gas, dryRun: false });
  assert.ok(writes.some((w) => w[0] === 'gas' && w[1] === 'users'));
});
