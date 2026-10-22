#!/usr/bin/env node
// scripts/sync.js — Supabase (primary) ↔ Google Apps Script (fallback) sync.
//
//   node scripts/sync.js              real run
//   node scripts/sync.js --dry-run    print the plan, write nothing (also DRY_RUN=true)
//   node scripts/sync.js --force      allow large delete batches (normally refused)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY),
//      GAS_URL, GAS_SYNC_KEY.
//
// Guarantees
//  • Pulls are paginated and COUNT-VERIFIED (a short read never looks like a delete).
//  • Composite keys are honoured (weekly_attempts, weekly_starts, admin_permissions).
//  • Only rows that actually changed are pushed, and only to the side that differs.
//  • Columns the target does not have are dropped (GAS-only columns never break upserts;
//    GAS-only columns are never wiped by a push).
//  • Deletions propagate through the `deleted_records` tombstone table without
//    resurrecting rows that were re-created afterwards.
//  • Secrets travel in POST bodies/headers, never in a URL.
//  • Any failure ⇒ non-zero exit code, so the Action turns red.
'use strict';

/* ── Per-table rules ────────────────────────────────────────────────────
   direction:
     supabase-wins          Supabase row wins; GAS-only rows are copied to Supabase unless tombstoned
     supabase-authoritative Supabase is the complete truth; GAS-only rows are deleted from GAS
     gas-wins               GAS row wins
     newer-wins             newest of the `ts` field(s) wins (ties → Supabase)
     earliest-wins          earliest non-empty `ts` wins (cheat prevention)
     union                  keep both sides' rows (progress_backups) / merge slots (progress_history)
   tombstone: Supabase table name used in deleted_records + the column holding the
              row's creation time (a row re-created after the tombstone is kept).        */
const TABLES = {
  users:                  { direction: 'supabase-wins', pk: ['username'], tombstone: { created: 'created_at' } },
  admins:                 { direction: 'supabase-wins', pk: ['username'], tombstone: { created: 'created_at' } },
  admin_permissions:      { direction: 'supabase-authoritative', pk: ['username', 'feature_key'] },
  settings:               { direction: 'supabase-wins', pk: ['key'] },
  payments:               { direction: 'newer-wins',    pk: ['username'], ts: ['reviewed_at', 'submitted_at'] },
  progress:               { direction: 'newer-wins',    pk: ['username'], ts: ['updated_at'] },
  progress_history:       { direction: 'union',         pk: ['username'], merge: 'history' },
  progress_backups:       { direction: 'union',         pk: ['backup_id'] },
  push_tokens:            { direction: 'supabase-wins', pk: ['username'] },
  weekly_sets:            { direction: 'supabase-wins', pk: ['id'], tombstone: { created: 'uploaded_at' } },
  weekly_starts:          { direction: 'earliest-wins', pk: ['username', 'weekly_id'], ts: ['started_at'] },
  weekly_attempts:        { direction: 'supabase-wins', pk: ['username', 'weekly_id'] },
  question_reports:       { direction: 'gas-wins',      pk: ['id'] },
  subjective_submissions: { direction: 'newer-wins',    pk: ['id'], ts: ['graded_at', 'submitted_at'] },
  study_docs:             { direction: 'supabase-wins', pk: ['id'], tombstone: { created: 'uploaded_at' } },
};

/* GAS sheet column → Supabase column. Identical names pass through. */
const RENAMES_FROM_GAS = {
  users: {
    passHash: 'pass_hash', createdAt: 'created_at', approvedAt: 'approved_at',
    trialExpiresAt: 'trial_expires_at', paymentStatus: 'payment_status',
    permanentAccess: 'permanent_access', accessType: 'access_type',
    accessExpiresAt: 'access_expires_at', sessionToken: 'session_token',
    sessionTokenExpiresAt: 'session_token_expires_at', emailVerified: 'email_verified',
  },
  admins: {
    passHash: 'pass_hash', createdAt: 'created_at', createdBy: 'created_by',
    tokenExpires: 'token_expires',
  },
  admin_permissions: { featureKey: 'feature_key', updatedAt: 'updated_at', updatedBy: 'updated_by' },
  payments: {
    txId: 'tx_id', rejectionReason: 'rejection_reason', screenshotUrl: 'screenshot_url',
    submittedAt: 'submitted_at', reviewedAt: 'reviewed_at',
  },
  progress: { updatedAt: 'updated_at' },
  progress_history: { savedAt1: 'saved_at1', savedAt2: 'saved_at2', savedAt3: 'saved_at3' },
  progress_backups: { backupId: 'backup_id', importId: 'import_id', createdAt: 'created_at', createdBy: 'created_by' },
  push_tokens: { fcmToken: 'fcm_token', updatedAt: 'updated_at' },
  weekly_sets: {
    fileId: 'file_id', chapterLabel: 'chapter_label', uploadedBy: 'uploaded_by',
    uploadedAt: 'uploaded_at', releaseAt: 'release_at',
  },
  weekly_starts: { weeklyId: 'weekly_id', startedAt: 'started_at' },
  weekly_attempts: {
    weeklyId: 'weekly_id', answersJson: 'answers_json', totalQuestions: 'total_questions',
    correctClaimed: 'correct_claimed', skippedCount: 'skipped_count',
    startedAt: 'started_at', submittedAt: 'submitted_at', durationSec: 'duration_sec',
  },
  question_reports: {
    fileId: 'file_id', questionSnapshot: 'question_snapshot', reportedBy: 'reported_by',
    reportedAt: 'reported_at', optionsSnapshot: 'options_snapshot',
    correctIndex: 'correct_index', chosenIndex: 'chosen_index',
    appVersion: 'app_version', resolvedAt: 'resolved_at', resolvedBy: 'resolved_by',
    correctedSnapshot: 'corrected_snapshot',
  },
  subjective_submissions: {
    questionId: 'question_id', questionText: 'question_text', questionMarks: 'question_marks',
    chapterId: 'chapter_id', solveSec: 'solve_sec', startedAt: 'started_at',
    submittedAt: 'submitted_at', pdfFileId: 'pdf_file_id', pdfUrl: 'pdf_url',
    gradedBy: 'graded_by', gradedAt: 'graded_at', pdfReplacedAt: 'pdf_replaced_at',
    pdfReplacedBy: 'pdf_replaced_by', pdfOriginalBackupId: 'pdf_original_backup_id',
  },
  study_docs: {
    chapterId: 'chapter_id', fileId: 'file_id', fileName: 'file_name',
    sizeBytes: 'size_bytes', sortOrder: 'sort_order', uploadedBy: 'uploaded_by',
    uploadedAt: 'uploaded_at', updatedAt: 'updated_at',
  },
};

const RENAMES_TO_GAS = {};
Object.keys(RENAMES_FROM_GAS).forEach((t) => {
  RENAMES_TO_GAS[t] = {};
  Object.keys(RENAMES_FROM_GAS[t]).forEach((g) => { RENAMES_TO_GAS[t][RENAMES_FROM_GAS[t][g]] = g; });
});

/* Supabase-only columns that GAS handles through a side channel and must still
   be sent (GAS stores them outside the sheet). */
const GAS_PASSTHROUGH = { admins: ['must_change_password'] };

/* ── Pure helpers (unit-tested) ─────────────────────────────────────── */

function timeOf(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = new Date(s).getTime();
  return isNaN(t) ? 0 : t;
}

function tsOf(row, fields) {
  if (!row) return 0;
  return Math.max(0, ...fields.map((f) => timeOf(row[f])));
}

function pkOf(name, row) {
  return TABLES[name].pk.map((f) => String(row[f] === null || row[f] === undefined ? '' : row[f]).trim()).join('|').toLowerCase();
}

function pkParts(name, row) {
  const out = {};
  TABLES[name].pk.forEach((f) => { out[f] = row[f]; });
  return out;
}

function gasToSupabase(name, gasRow) {
  const map = RENAMES_FROM_GAS[name] || {};
  const out = {};
  Object.keys(gasRow).forEach((k) => { out[map[k] || k] = gasRow[k]; });
  return out;
}

function supabaseToGas(name, supaRow) {
  const map = RENAMES_TO_GAS[name] || {};
  const out = {};
  Object.keys(supaRow).forEach((k) => {
    const v = supaRow[k];
    out[map[k] || k] = (v === null || v === undefined) ? '' : v;
  });
  return out;
}

/* Canonical form used ONLY for "did this change?" comparisons. */
function norm(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return String(v.getTime());
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) { const t = new Date(s).getTime(); if (!isNaN(t)) return String(t); }
  if (/^(true|false)$/i.test(s)) return s.toLowerCase();
  return s;
}

function sameOn(a, b, cols) {
  return cols.every((c) => norm(a[c]) === norm(b[c]));
}

/* Convert a value to what a Supabase column of `type` accepts. */
function coerceForSupabase(value, type) {
  if (value === undefined) return undefined;
  if (type === 'integer' || type === 'number') {
    if (value === '' || value === null) return null;
    const n = Number(value);
    return isNaN(n) ? null : (type === 'integer' ? Math.trunc(n) : n);
  }
  if (type === 'boolean') {
    if (value === '' || value === null) return null;
    return value === true || String(value).toLowerCase() === 'true';
  }
  if (value instanceof Date) return value.toISOString();
  return value === null ? null : value;
}

/* Keep only columns the target has (+ coerce types). `cols` is a Set; `types` optional. */
function shapeForSupabase(row, cols, types) {
  const out = {};
  Object.keys(row).forEach((k) => {
    if (cols && cols.size && !cols.has(k)) return;
    out[k] = coerceForSupabase(row[k], types && types[k]);
  });
  return out;
}

/* progress_history: three most-recent distinct snapshots across both sides. */
function mergeHistory(s, g) {
  const slots = [];
  [s, g].forEach((row) => {
    if (!row) return;
    for (let i = 1; i <= 3; i++) {
      const data = row['data' + i];
      if (data) slots.push({ data: String(data), at: row['saved_at' + i] || '', ms: timeOf(row['saved_at' + i]) });
    }
  });
  const seen = new Set();
  const uniq = slots.sort((a, b) => b.ms - a.ms).filter((x) => (seen.has(x.data) ? false : (seen.add(x.data), true))).slice(0, 3);
  const out = { username: (s || g).username };
  for (let i = 1; i <= 3; i++) {
    out['data' + i] = uniq[i - 1] ? uniq[i - 1].data : '';
    out['saved_at' + i] = uniq[i - 1] ? uniq[i - 1].at : '';
  }
  return out;
}

/* Email verified on either side stays verified if the email did not change. */
function keepVerifiedEmail(winner, s, g) {
  if (!winner || !g || !s) return winner;
  const verified = (r) => String(r.email_verified).toLowerCase() === 'true';
  const sameEmail = String(s.email || '').trim().toLowerCase() === String(g.email || '').trim().toLowerCase();
  if (sameEmail && verified(g) && !verified(winner)) return { ...winner, email_verified: 'true' };
  return winner;
}

/**
 * Merge one table.
 * @param name        table name
 * @param supaRows    rows from Supabase (Supabase column names)
 * @param gasRowsRaw  rows from GAS (GAS column names)
 * @param ctx         { tombstones: Map<pk,ms> | null, supaCols:Set, supaTypes:{}, gasCols:Set }
 * @returns { toSupabase:[], toGas:[], deleteGas:[], unchanged:n, skippedByTombstone:n }
 */
function mergeTable(name, supaRows, gasRowsRaw, ctx = {}) {
  const rule = TABLES[name];
  const tomb = ctx.tombstones || new Map();
  const gasRows = gasRowsRaw.map((r) => ({ raw: r, row: gasToSupabase(name, r) }));

  const sBy = new Map(); supaRows.forEach((r) => sBy.set(pkOf(name, r), r));
  const gBy = new Map(); gasRows.forEach((x) => gBy.set(pkOf(name, x.row), x));

  const out = { toSupabase: [], toGas: [], deleteGas: [], unchanged: 0, skippedByTombstone: 0 };
  const allPks = new Set([...sBy.keys(), ...gBy.keys()]);

  allPks.forEach((pk) => {
    if (!pk.replace(/\|/g, '')) return;                      // empty key → ignore
    const s = sBy.get(pk);
    const gx = gBy.get(pk);
    const g = gx ? gx.row : undefined;
    let winner;

    switch (rule.direction) {
      case 'supabase-authoritative':
        if (!s && g) { out.deleteGas.push(pkParts(name, g)); return; }
        winner = s; break;
      case 'supabase-wins':
        if (!s && g) {
          const t = tomb.get(pk);
          const created = rule.tombstone ? timeOf(g[rule.tombstone.created]) : 0;
          if (t && (!created || created <= t)) { out.deleteGas.push(pkParts(name, g)); out.skippedByTombstone++; return; }
        }
        winner = s || g; break;
      case 'gas-wins':
        winner = g || s; break;
      case 'newer-wins':
        if (!s) winner = g; else if (!g) winner = s;
        else winner = tsOf(s, rule.ts) >= tsOf(g, rule.ts) ? s : g;
        break;
      case 'earliest-wins': {
        if (!s) { winner = g; break; }
        if (!g) { winner = s; break; }
        const st = tsOf(s, rule.ts), gt = tsOf(g, rule.ts);
        winner = (!st && !gt) ? s : !st ? g : !gt ? s : (st <= gt ? s : g);
        break;
      }
      case 'union':
        winner = rule.merge === 'history' ? mergeHistory(s, g) : (s || g);
        break;
      default:
        winner = s || g;
    }
    if (!winner) return;
    if (name === 'users') winner = keepVerifiedEmail(winner, s, g);

    // → Supabase: only if its row differs over the columns Supabase actually has.
    const supaCols = ctx.supaCols && ctx.supaCols.size ? [...ctx.supaCols] : Object.keys(winner);
    const wanted = Object.keys(winner).filter((c) => supaCols.includes(c));
    let changed = false;
    if (!s) { changed = true; out.toSupabase.push(shapeForSupabase(winner, ctx.supaCols, ctx.supaTypes)); }
    else if (!sameOn(winner, s, wanted)) { changed = true; out.toSupabase.push(shapeForSupabase(winner, ctx.supaCols, ctx.supaTypes)); }

    // → GAS: only if its row differs over the columns GAS has; preserve GAS-only columns.
    const gasCols = ctx.gasCols && ctx.gasCols.size ? ctx.gasCols : null;
    const winnerGas = supabaseToGas(name, winner);
    GAS_PASSTHROUGH[name] && GAS_PASSTHROUGH[name].forEach((c) => { if (winner[c] !== undefined) winnerGas[c] = winner[c]; });
    const gasKeys = Object.keys(winnerGas).filter((k) => !gasCols || gasCols.has(k) || (GAS_PASSTHROUGH[name] || []).includes(k));
    let gasDiffers = !gx;
    if (gx) gasDiffers = gasKeys.some((k) => (GAS_PASSTHROUGH[name] || []).includes(k) ? false : norm(winnerGas[k]) !== norm(gx.raw[k]));
    if (gasDiffers) { changed = true; out.toGas.push({ ...(gx ? gx.raw : {}), ...pickKeys(winnerGas, gasKeys) }); }
    else if (GAS_PASSTHROUGH[name]) {
      // pass-through flags (e.g. admins.must_change_password) are always sent when set
      if (GAS_PASSTHROUGH[name].some((k) => winner[k] !== undefined && String(winner[k]) === 'true')) out.toGas.push({ ...gx.raw, ...pickKeys(winnerGas, gasKeys) });
    }
    if (!changed) out.unchanged++;
  });
  return out;
}

function pickKeys(obj, keys) { const o = {}; keys.forEach((k) => { if (k in obj) o[k] = obj[k]; }); return o; }

/* Group rows by identical key set: PostgREST bulk upserts need uniform objects. */
function groupBySignature(rows) {
  const groups = new Map();
  rows.forEach((r) => {
    const sig = Object.keys(r).sort().join(',');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(r);
  });
  return [...groups.values()];
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

/* ── HTTP clients ───────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (e && e.noRetry) break;
      if (i < tries) await sleep(500 * i * i);
    }
  }
  throw new Error(`${label}: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

function createSupabase({ url, key, fetchImpl = fetch, pageSize = 1000 }) {
  const base = url.replace(/\/+$/, '');
  const headers = (extra = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra });

  async function call(path, opts = {}) {
    const resp = await fetchImpl(`${base}${path}`, { ...opts, headers: headers(opts.headers) });
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`HTTP ${resp.status} ${text.slice(0, 300)}`);
      if (resp.status >= 400 && resp.status < 500) err.noRetry = true;
      err.status = resp.status; err.body = text;
      throw err;
    }
    return resp;
  }

  /** Paginated, count-verified read of a whole table. */
  async function pullAll(table, orderCols) {
    return withRetry(`pull ${table}`, async () => {
      const rows = [];
      let total = null;
      const order = orderCols.map((c) => `${c}.asc`).join(',');
      for (let from = 0; ; from += pageSize) {
        const resp = await call(`/rest/v1/${table}?select=*&order=${order}`, {
          headers: { 'Range-Unit': 'items', Range: `${from}-${from + pageSize - 1}`, Prefer: 'count=exact' },
        });
        const page = await resp.json();
        rows.push(...page);
        const cr = resp.headers.get('content-range') || '';
        const m = cr.match(/\/(\d+|\*)$/);
        if (m && m[1] !== '*') total = Number(m[1]);
        if (page.length < pageSize) break;
        if (total !== null && rows.length >= total) break;
        if (from > 5_000_000) throw new Error('pagination runaway');
      }
      if (total !== null && rows.length !== total) {
        throw new Error(`count mismatch for ${table}: read ${rows.length}, server says ${total}`);
      }
      return rows;
    });
  }

  /** Column names + types from the PostgREST OpenAPI document. */
  async function schema() {
    try {
      const resp = await call('/rest/v1/', { headers: { Accept: 'application/openapi+json' } });
      const doc = await resp.json();
      const defs = doc.definitions || (doc.components && doc.components.schemas) || {};
      const out = {};
      Object.keys(defs).forEach((t) => {
        const props = defs[t].properties || {};
        out[t] = { cols: new Set(Object.keys(props)), types: {} };
        Object.keys(props).forEach((c) => { out[t].types[c] = props[c].type; });
      });
      return out;
    } catch (e) {
      console.warn('[sync] could not read the Supabase schema; falling back to sampled columns:', e.message);
      return {};
    }
  }

  async function upsert(table, rows, pkCols) {
    for (const group of groupBySignature(rows)) {
      for (const part of chunk(group, 400)) {
        await withRetry(`upsert ${table}`, () => call(`/rest/v1/${table}?on_conflict=${pkCols.join(',')}`, {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(part),
        }));
      }
    }
  }

  return { pullAll, schema, upsert, call };
}

function createGas({ url, key, fetchImpl = fetch }) {
  // The action name is not a secret, so it also goes in the URL. If Apps Script ever
  // drops the POST body (seen as "Unknown action: ''"), the request is still routed
  // correctly and fails as "auth failed" instead — and every failure is retried.
  const withAction = (action) => url + (url.includes('?') ? '&' : '?') + 'action=' + encodeURIComponent(action);

  async function post(body) {
    return withRetry(`GAS ${body.action}`, async () => {
      const resp = await fetchImpl(withAction(body.action), {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },     // avoids a CORS preflight; GAS parses the body itself
        body: JSON.stringify({ ...body, key }),                       // the secret key stays in the body, never in the URL
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`non-JSON response (HTTP ${resp.status}): ${text.slice(0, 120)}`); }
      if (!data.success) {
        const e = new Error(data.error || 'unknown error');
        e.noRetry = /must (use|be sent as) (a )?post/i.test(String(data.error));   // everything else may be transient
        throw e;
      }
      return data;
    }, 4);
  }
  return {
    pull: (table) => post({ action: 'syncpull', tables: table }),
    push: (table, rows) => post({ action: 'syncpush', tables: { [table]: rows } }),
    del: (table, keys) => post({ action: 'syncpush', tables: {}, deletes: { [table]: keys } }),
  };
}

/* ── Orchestration ──────────────────────────────────────────────────── */

async function run({ supa, gas, dryRun = false, force = false, log = console }) {
  const errors = [];
  const report = [];
  const schema = await supa.schema();

  // Tombstones (needed only by tables that use them). Fail closed if unavailable.
  let tombstonesOk = true;
  const tombstones = {};
  try {
    const rows = await supa.pullAll('deleted_records', ['table_name', 'pk']);
    rows.forEach((r) => {
      (tombstones[r.table_name] = tombstones[r.table_name] || new Map()).set(String(r.pk).toLowerCase(), timeOf(r.deleted_at));
    });
  } catch (e) {
    tombstonesOk = false;
    errors.push(`deleted_records unavailable (${e.message}) — run the SQL migration. Tables with deletions are skipped.`);
  }

  for (const name of Object.keys(TABLES)) {
    const rule = TABLES[name];
    if (rule.tombstone && !tombstonesOk) { report.push({ table: name, status: 'SKIPPED (no tombstones)' }); continue; }
    try {
      const supaRows = await supa.pullAll(name, rule.pk);
      const gasData = await gas.pull(name);
      if (gasData.errors && gasData.errors[name]) throw new Error('GAS: ' + gasData.errors[name]);
      const gasRows = (gasData.tables && gasData.tables[name]) || [];
      const gasHeaders = gasData.headers && gasData.headers[name];

      const sch = schema[name];
      const supaCols = sch ? sch.cols : new Set(supaRows.length ? Object.keys(supaRows[0]) : []);
      const gasColSet = gasHeaders ? new Set(gasHeaders) : new Set(gasRows.length ? Object.keys(gasRows[0]) : []);

      const m = mergeTable(name, supaRows, gasRows, {
        tombstones: tombstones[name], supaCols, supaTypes: sch ? sch.types : {}, gasCols: gasColSet,
      });

      const limit = Math.max(10, Math.ceil(gasRows.length * 0.2));
      if (m.deleteGas.length > limit && !force) {
        throw new Error(`refusing to delete ${m.deleteGas.length} of ${gasRows.length} GAS rows (limit ${limit}); re-run with --force if intended`);
      }

      report.push({
        table: name, supabase: supaRows.length, gas: gasRows.length,
        '→supabase': m.toSupabase.length, '→gas': m.toGas.length, 'gas deletes': m.deleteGas.length, unchanged: m.unchanged,
      });
      if (dryRun) continue;

      if (m.toSupabase.length) await supa.upsert(name, m.toSupabase, rule.pk);
      for (const part of chunk(m.toGas, 150)) await gas.push(name, part);
      for (const part of chunk(m.deleteGas, 150)) await gas.del(name, part);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      report.push({ table: name, status: 'FAILED' });
    }
  }
  return { report, errors };
}

async function main() {
  const need = (n, alt) => { const v = process.env[n] || (alt && process.env[alt]); if (!v) throw new Error(`Missing env var: ${n}`); return v; };
  const dryRun = process.argv.includes('--dry-run') || String(process.env.DRY_RUN).toLowerCase() === 'true';
  const force = process.argv.includes('--force');
  const supa = createSupabase({ url: need('SUPABASE_URL'), key: need('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY') });
  const gas = createGas({ url: need('GAS_URL'), key: need('GAS_SYNC_KEY') });

  console.log(`[sync] ${dryRun ? 'DRY RUN — nothing will be written' : 'live run'}`);
  const { report, errors } = await run({ supa, gas, dryRun, force });
  console.table(report);
  if (errors.length) {
    console.error('[sync] FAILED:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
  console.log('[sync] done');
}

module.exports = {
  TABLES, RENAMES_FROM_GAS, RENAMES_TO_GAS,
  timeOf, pkOf, norm, gasToSupabase, supabaseToGas, coerceForSupabase, shapeForSupabase,
  mergeHistory, keepVerifiedEmail, mergeTable, groupBySignature, chunk,
  createSupabase, createGas, run,
};

if (require.main === module) {
  main().catch((err) => { console.error('[sync] FATAL:', err.message || err); process.exit(1); });
}
