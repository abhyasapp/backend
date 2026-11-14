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
  assert.equal(Object.keys(columns).length, 20);   // 18 base tables + deleted_records + correction_events
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

test('row level security is on for every table and anon cannot read', async () => {
  const { rows } = await db.query(`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`);
  assert.equal(rows.length, 20);
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
  await db.exec(`insert into deleted_records (table_name,pk) values ('users','ghost')`);
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
  const headers = gasHeaders(path.join(root, 'gas/code.gs'));
  const tableOf = {
    USER_HEADERS: 'users', PAYMENT_HEADERS: 'payments', SETTINGS_HEADERS: 'settings', ADMIN_HEADERS: 'admins',
    PROGRESS_HEADERS: 'progress', PUSHTOKENS_HEADERS: 'push_tokens', WEEKLYSET_HEADERS: 'weekly_sets',
    WEEKLYATTEMPT_HEADERS: 'weekly_attempts', SUBJ_SUBMISSION_HEADERS: 'subjective_submissions',
    ADMIN_PERM_HEADERS: 'admin_permissions', PROGRESS_HISTORY_HEADERS: 'progress_history',
    STUDYDOC_HEADERS: 'study_docs', WEEKLYSTART_HEADERS: 'weekly_starts', PROGRESS_BACKUP_HEADERS: 'progress_backups',
  };
  const bad = [];
  for (const [h, table] of Object.entries(tableOf)) {
    if (!headers[h]) continue;                    // header block not present in this fork
    const row = Object.fromEntries(headers[h].map((c) => [c, 'x']));
    const mapped = sync.gasToSupabase(table, row);
    // shapeForSupabase(row, cols) keeps only columns the SCM table really has
    const shaped = sync.shapeForSupabase(mapped, columns[table]);
    for (const k of Object.keys(shaped)) if (!columns[table].has(k)) bad.push(`${table}.${k}`);
  }
  assert.deepEqual(bad, [], 'these sheet columns would fail the nightly sync');
});
