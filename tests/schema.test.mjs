import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { census, gasHeaders } from '../scripts/schema-census.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sync = require('../scripts/sync.js');

let db, columns;                       // { table: Set(columns) }

// Both migrations, in filename order: base schema first, then the admin
// enhancements (must_change_password + deleted_records tombstones).
const MIGRATIONS = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

before(async () => {
  db = new PGlite();
  const full = MIGRATIONS.map((f) =>
    ['-- migration: ' + f, fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8')].join('\n')
  ).join('\n\n');
  await db.exec(full);
  const { rows } = await db.query(`select table_name t, column_name c from information_schema.columns where table_schema='public'`);
  columns = {};
  for (const r of rows) (columns[r.t] ||= new Set()).add(r.c);
});

test('migrations applied cleanly and are idempotent', async () => {
  await db.exec(MIGRATIONS.map((f) => fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8')).join('\n'));
  assert.equal(Object.keys(columns).length, 24);   // 18 base + deleted_records + correction_events + question_index, user_qstate, answer_events, qid_stats
});

test('every column the Edge Function touches exists in the schema', () => {
  const used = census(path.join(root, 'supabase/functions/api'));
  const missing = [];
  for (const [table, cols] of Object.entries(used)) {
    if (!columns[table]) { missing.push(`table ${table}`); continue; }
    for (const c of cols) if (!columns[table].has(c)) missing.push(`${table}.${c}`);
  }
  assert.deepEqual(missing, []);
  assert.ok(Object.keys(used).length >= 17, 'census should see all tables');
});

test('authUser projects every users column except pass_hash (no silent omissions)', () => {
  const src = fs.readFileSync(path.join(root, 'supabase/functions/api/_shared/auth.ts'), 'utf8');
  const m = src.match(/USER_COLS_NO_HASH\s*=\s*'([^']+)'/);
  assert.ok(m, 'USER_COLS_NO_HASH constant not found');
  const projected = new Set(m[1].split(','));
  const expected = [...columns.users].filter((c) => c !== 'pass_hash').sort();
  assert.deepEqual([...projected].sort(), expected);
  assert.ok(!projected.has('pass_hash'));
});

test('row level security is on for every table and anon cannot read', async () => {
  const { rows } = await db.query(`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`);
  assert.equal(rows.length, 24);
  for (const r of rows) assert.equal(r.relrowsecurity, true, `${r.relname} must have RLS enabled`);
  const pol = await db.query(`select count(*)::int n from pg_policies where schemaname='public'`);
  assert.equal(pol.rows[0].n, 0, 'no policies: only the service role may access data');
});

test('the app\'s own insert shapes are accepted (empty strings included)', async () => {
  await db.exec(`insert into users (username,pass_hash,name,email,mobile,status,trial_expires_at,created_at,approved_at,role,payment_status,permanent_access,access_type,access_expires_at,email_verified,session_token,session_token_expires_at)
    values ('asha','h','Asha','a@x.np','','trial','2026-02-01T00:00:00Z','2026-01-01T00:00:00Z','','user','','false','','','false','','')`);
  await db.exec(`insert into progress (username,data,updated_at) values ('asha','gz1:abc','2026-01-01T00:00:00Z')`);
  await db.exec(`insert into settings (key,value) values ('contentVersion','1') on conflict (key) do update set value='2'`);
  await db.exec(`insert into logs (timestamp,admin,action,target,details) values ('2026-01-01T00:00:00Z','owner','login','','')`);
  const { rows } = await db.query(`select id from logs`);
  assert.equal(rows.length, 1);
});

test('a student cannot start or submit the same weekly test twice', async () => {
  await db.exec(`insert into weekly_starts (username,weekly_id,started_at) values ('asha','w1','t')`);
  await assert.rejects(db.exec(`insert into weekly_starts (username,weekly_id,started_at) values ('asha','w1','t2')`));
  await db.exec(`insert into weekly_attempts (username,weekly_id,answers_json) values ('asha','w1','[]')`);
  await assert.rejects(db.exec(`insert into weekly_attempts (username,weekly_id,answers_json) values ('asha','w1','[1]')`));
});

test('deleted_records tombstone table behaves (used by sync.js)', async () => {
  // An explicit old stamp: a row written "now" is not strictly older than now(),
  // so a same-tick prune legitimately keeps it and the test would flap.
  await db.exec(`insert into deleted_records (table_name,pk,deleted_at) values ('users','ghost', now() - interval '1 day')`);
  await assert.rejects(db.exec(`insert into deleted_records (table_name,pk) values ('users','ghost')`),
    'same (table,pk) cannot be tombstoned twice');
  await db.exec(`select prune_deleted_records(keep_days => 0)`);
  const { rows } = await db.query(`select count(*)::int n from deleted_records`);
  assert.equal(rows[0].n, 0, 'zero-day prune clears tombstones');
});

test('rate_limits compares numerically', async () => {
  await db.exec(`insert into rate_limits (key,count,reset_at) values ('login:asha',1,1893456000000)`);
  await db.exec(`update rate_limits set count = count + 1 where key='login:asha'`);
  const { rows } = await db.query(`select count, reset_at from rate_limits where key='login:asha'`);
  assert.equal(rows[0].count, 2);
  assert.equal(Number(rows[0].reset_at), 1893456000000);
});

test('every Apps Script column maps onto a real Postgres column after sync renames', () => {
  const headers = { ...gasHeaders(path.join(root, 'gas/code.gs')), ...gasHeaders(path.join(root, 'gas/report.gs')), ...gasHeaders(path.join(root, 'gas/qid.gs')) };
  const tableOf = {
    USER_HEADERS: 'users', PAYMENT_HEADERS: 'payments', SETTINGS_HEADERS: 'settings', ADMIN_HEADERS: 'admins',
    PROGRESS_HEADERS: 'progress', PUSHTOKENS_HEADERS: 'push_tokens', WEEKLYSET_HEADERS: 'weekly_sets',
    WEEKLYATTEMPT_HEADERS: 'weekly_attempts', SUBJ_SUBMISSION_HEADERS: 'subjective_submissions',
    ADMIN_PERM_HEADERS: 'admin_permissions', PROGRESS_HISTORY_HEADERS: 'progress_history',
    STUDYDOC_HEADERS: 'study_docs', WEEKLYSTART_HEADERS: 'weekly_starts', PROGRESS_BACKUP_HEADERS: 'progress_backups',
    QREPORT_HEADERS: 'question_reports',
    QINDEX_HEADERS: 'question_index', QSTATE_HEADERS: 'user_qstate', QEVENTS_HEADERS: 'answer_events', QSTATS_HEADERS: 'qid_stats',
  };
  // The qid tables are new and must map PERFECTLY: a header with no Postgres column would be dropped
  // silently by the sync (shapeForSupabase) and never reach the other backend.
  // Every table is strict. The one deliberate exception is a Supabase-only column GAS keeps outside the sheet.
  const strict = new Set(Object.values(tableOf));
  const gasPassthrough = { admins: ['must_change_password'] };
  const bad = [];
  for (const [h, table] of Object.entries(tableOf)) {
    if (!headers[h]) { if (strict.has(table)) bad.push(`${table}: header block ${h} not found`); continue; }
    const row = Object.fromEntries(headers[h].map((c) => [c, 'x']));
    const mapped = sync.gasToSupabase(table, row);
    for (const k of Object.keys(mapped)) if (!columns[table].has(k) && strict.has(table)) bad.push(`${table}.${k}`);
    // and the reverse: every Postgres column of a strict table has a sheet header
    if (strict.has(table)) {
      const back = new Set(Object.keys(mapped));
      for (const c of columns[table]) if (!back.has(c) && !(gasPassthrough[table] || []).includes(c)) bad.push(`${table}: Postgres column ${c} has no sheet header`);
    }
  }
  assert.deepEqual(bad, [], 'these columns would not survive the sync');
});

test('question_reports.updated_at: backfilled, server-stamped, ignores no-op writes, cannot be forged', async () => {
  const dir = path.join(root, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const last = files.indexOf('20261118000000_report_updated_at.sql');
  assert.ok(last > 0, 'migration present');
  const fresh = new PGlite();
  await fresh.exec(files.slice(0, last).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n'));

  // Legacy rows exist BEFORE the migration: one only reported, one reported then resolved.
  await fresh.exec(`insert into public.question_reports (id, uid, file_id, reported_at, status, resolved_at)
    values ('old-open','f_0','f','2026-10-01T08:00:00.000Z','open',''),
           ('old-done','f_1','f','2026-10-01T08:00:00.000Z','resolved','2026-10-05T09:30:00.000Z')`);
  await fresh.exec(fs.readFileSync(path.join(dir, files[last]), 'utf8'));
  const get = async (id) => (await fresh.query('select updated_at, status, resolved_by from public.question_reports where id=$1', [id])).rows[0];

  assert.equal((await get('old-open')).updated_at, '2026-10-01T08:00:00.000Z');   // backfill: reported_at
  assert.equal((await get('old-done')).updated_at, '2026-10-05T09:30:00.000Z');   // backfill: later of the two

  await fresh.exec(`insert into public.question_reports (id, uid, file_id, reported_at, status) values ('new','f_2','f','2026-11-18T01:00:00.000Z','open')`);
  const t0 = (await get('new')).updated_at;
  assert.match(t0, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(t0 > '2026-11-01', 'stamped by the server clock, not copied from reported_at');

  await new Promise((r) => setTimeout(r, 15));
  // A write that changes nothing (retried resolvereports / the nightly sync re-upserting) must not move the cursor…
  await fresh.exec(`update public.question_reports set status='open' where id='new'`);
  assert.equal((await get('new')).updated_at, t0);
  // …even when the sync hands in a different updated_at of its own.
  await fresh.exec(`update public.question_reports set updated_at='1999-01-01T00:00:00.000Z' where id='new'`);
  assert.equal((await get('new')).updated_at, t0);

  // A meaningful change bumps it, and the caller cannot choose the value.
  await fresh.exec(`update public.question_reports set status='resolved', resolved_by='console', updated_at='2000-01-01T00:00:00.000Z' where id='new'`);
  const t1 = (await get('new')).updated_at;
  assert.ok(t1 > t0, 'a real change moves the cursor forward');
  assert.notEqual(t1, '2000-01-01T00:00:00.000Z');

  // Re-opening clears resolved_at/by — exactly the change the old reported_at/resolved_at cursor could not see.
  await new Promise((r) => setTimeout(r, 15));
  await fresh.exec(`update public.question_reports set status='open', resolved_by='', resolved_at='' where id='new'`);
  assert.ok((await get('new')).updated_at > t1, 'a re-open is visible to the cursor');

  // The pipeline's NULL writes are impossible on this schema (every column is NOT NULL DEFAULT '').
  await assert.rejects(fresh.exec(`update public.question_reports set resolved_at=null where id='new'`), /null value|not-null/i);
});
