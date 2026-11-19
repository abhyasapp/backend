// Same scripted scenario → the REAL Supabase handlers and the REAL Apps Script handlers.
// The outputs must be identical, so the pipeline behaves the same whichever URL it is pointed at.
// Run: node --import ./tests/handlers/register.mjs tests/parity-handlers.test.mjs
import assert from 'node:assert/strict';
import { DB, reset } from './handlers/mock-supabase.mjs';
import { makeGas } from './gas-harness.mjs';

const P = await import('../supabase/functions/api/handlers/pipeline.ts');

let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);
const SYNC = 'sync-secret-123', ADMIN = 'admin-secret-456';
const T = (s) => Date.parse(s);

// ── fixtures: logical reports, written in each backend's own storage shape ──
const REPORTS = [
  { id: 'rep-1', uid: 'f1_0', qid: '50011.110001', fileId: 'f1', q: 'Q one', options: '["a","b","c"]', correct: 1, chosen: 0, reason: 'wrong_answer', note: 'n1', by: 'sita', at: '2026-11-18T08:00:00.000Z', status: 'open', section: 'practice', app: '1.0', upd: '2026-11-18T08:00:00.000Z' },
  { id: 'rep-2', uid: 'f1_1', qid: '50011.110002', fileId: 'f1', q: 'Q two', options: '["a","b"]', correct: 0, chosen: 1, reason: 'typo', note: '', by: 'ram', at: '2026-11-16T08:00:00.000Z', status: 'resolved', resolvedAt: '2026-11-17T10:00:00.000Z', resolvedBy: 'console', corrected: true, snap: '{"x":1}', section: 'exam', app: '1.0', upd: '2026-11-17T10:00:00.000Z' },
  { id: 'rep-3', uid: 'f2_4', qid: '', fileId: 'f2', q: 'Q three', options: '["a","b","c","d"]', correct: '', chosen: '', reason: 'unclear', note: 'n3', by: 'hari', at: '2026-11-18T09:00:00.000Z', status: 'open', section: 'weekly', app: '', upd: '2026-11-18T09:00:00.000Z' },
  { id: 'rep-4', uid: 'f1_2', qid: '50011.110003', fileId: 'f1', q: 'Q four', options: '["a","b"]', correct: 0, chosen: 0, reason: 'other', note: '', by: 'gita', at: '2026-11-18T08:00:00.000Z', status: 'open', section: 'practice', app: '1.1', upd: '2026-11-18T08:00:00.000Z' },
];

const gh = { calls: [], status: 204 };

function supabaseWorld() {
  reset();
  process.env.ABHYAS_SYNC_KEY = SYNC; process.env.ABHYAS_ADMIN_KEY = ADMIN; process.env.GITHUB_TOKEN = 'ghp_test';
  delete process.env.SYNC_KEY;
  DB.tables.question_reports = REPORTS.map((r) => ({
    id: r.id, uid: r.uid, qid: r.qid, file_id: r.fileId, question_snapshot: r.q, options_snapshot: r.options,
    correct_index: String(r.correct), chosen_index: String(r.chosen), reason: r.reason, note: r.note, reported_by: r.by,
    reported_at: r.at, status: r.status, resolved_at: r.resolvedAt || '', resolved_by: r.resolvedBy || '',
    corrected: r.corrected ? 'true' : '', corrected_snapshot: r.snap || '', section: r.section, app_version: r.app, updated_at: r.upd,
  }));
  DB.tables.rate_limits = [];
  globalThis.fetch = async (url, init) => { gh.calls.push({ url: String(url), payload: JSON.parse(init.body), auth: init.headers.Authorization }); return { status: gh.status }; };
  const H = { syncreportssince: P.syncreportssince, resolvereports: P.resolvereports, admincorrect: P.admincorrect };
  return {
    name: 'supabase',
    call: async (action, params) => (await H[action](params)).json(),
    view: (id) => { const r = DB.tables.question_reports.find((x) => x.id === id); return r && { status: r.status, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by, corrected: r.corrected === 'true', correctedSnapshot: r.corrected_snapshot, updatedAt: r.updated_at }; },
  };
}

function gasWorld(extraProps = {}) {
  const g = makeGas({ props: { ABHYAS_SYNC_KEY: SYNC, ABHYAS_ADMIN_KEY: ADMIN, GITHUB_TOKEN: 'ghp_test', ...extraProps } });
  delete g.props.SYNC_KEY;
  const sheet = g.run('getQReportsSheet_()');
  REPORTS.forEach((r) => sheet.appendRow([r.id, r.uid, r.fileId, r.q, r.reason, r.note, r.by, r.at, r.status, r.options, r.correct, r.chosen, r.section, r.app,
    r.resolvedAt || '', r.resolvedBy || '', r.corrected ? 'TRUE' : '', r.snap || '', r.qid, r.upd]));
  g.ctx.__gh = gh; g.ctx.__sb = { reqs: [], respond: null };
  g.run(`UrlFetchApp = {
    fetch: function (u, o) { __gh.calls.push({ url: u, payload: JSON.parse(o.payload), auth: o.headers.Authorization }); return { getResponseCode: function () { return __gh.status; } }; },
    fetchAll: function (reqs) { __sb.reqs = __sb.reqs.concat(reqs); return reqs.map(function (r) { var o = __sb.respond ? __sb.respond(r) : { code: 200, body: [] }; return { getResponseCode: function () { return o.code; }, getContentText: function () { return JSON.stringify(o.body); } }; }); }
  }`);
  return {
    name: 'apps-script', g,
    call: async (action, params) => JSON.parse(JSON.stringify(g.route(action, params))),   // exactly once: the write handlers have side effects
    view: (id) => { const r = sheet.rows().find((x) => x.id === id); return r && { status: r.status, resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : '', resolvedBy: r.resolvedBy, corrected: String(r.corrected).toLowerCase() === 'true', correctedSnapshot: r.correctedSnapshot, updatedAt: r.updatedAt }; },
  };
}

// Run one step on both backends and demand identical output (after dropping server-clock fields).
const worlds = [supabaseWorld(), gasWorld()];
const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'updatedAt' || k === 'total' ? undefined : x)));
async function both(action, params, { keepNow = false } = {}) {
  const out = [];
  for (const w of worlds) {
    const r = await w.call(action, JSON.parse(JSON.stringify(params)));
    out.push(r);
  }
  const a = strip(out[0]), b = strip(out[1]);
  if (!keepNow) { delete a.now; delete b.now; }
  assert.deepEqual(b, a, `backends disagree on ${action} ${JSON.stringify(params).slice(0, 160)}\n supabase: ${JSON.stringify(a)}\n appsscript: ${JSON.stringify(b)}`);
  return out;
}
const ids = (r) => r.reports.map((x) => x.id);

// ═════════════ AUTH ═════════════
let [r] = await both('syncreportssince', { key: 'wrong', since: 0 });
assert.deepEqual(r, { success: false, error: 'unauthorized' });
[r] = await both('resolvereports', { key: 'wrong', items: [{ id: 'rep-1', status: 'resolved' }] });
assert.deepEqual(r, { success: false, error: 'unauthorized' });
[r] = await both('admincorrect', { adminKey: SYNC, items: [] });                       // the SYNC key is not the admin key
assert.deepEqual(r, { success: false, error: 'unauthorized' });
[r] = await both('syncreportssince', { since: 0 });                                    // no key at all
assert.equal(r.error, 'unauthorized');
ok('a wrong or missing key is "unauthorized" on every endpoint, identically on both backends');

// ═════════════ syncreportssince: ordering, limit, cursor ═════════════
let out = await both('syncreportssince', { key: SYNC, since: 0, limit: 2 }, { keepNow: true });
assert.deepEqual(ids(out[0]), ['rep-2', 'rep-1']);                                     // by (changed-at, id), oldest first
assert.equal(out[0].truncated, true);
for (const o of out) assert.equal(o.now, T('2026-11-18T08:00:00.000Z'));              // now = newest change RETURNED, not the wall clock
ok('reports come oldest-changed first, honour limit, and `now` is the newest change returned');

out = await both('syncreportssince', { key: SYNC, since: T('2026-11-18T08:00:00.000Z'), limit: 10 });
assert.deepEqual(ids(out[0]), ['rep-1', 'rep-4', 'rep-3']);                            // inclusive: the boundary row is re-sent, siblings are not skipped
ok('the cursor is inclusive, so a sibling sharing the boundary millisecond is never skipped');

out = await both('syncreportssince', { key: SYNC, since: T('2030-01-01T00:00:00Z') }, { keepNow: true });
assert.deepEqual(out[0].reports, []);
for (const o of out) assert.equal(o.now, T('2030-01-01T00:00:00Z'));                  // nothing to send → the cursor does not move
ok('with nothing new, `now` stays at `since` (the cursor never skips a write still in flight)');

const first = (await both('syncreportssince', { key: SYNC, since: 0, limit: 1000 }))[0].reports.find((x) => x.id === 'rep-1');
assert.deepEqual(first, {
  id: 'rep-1', uid: 'f1_0', qid: '50011.110001', fileId: 'f1', questionSnapshot: 'Q one', optionsSnapshot: '["a","b","c"]',
  correctIndex: 1, chosenIndex: 0, reason: 'wrong_answer', note: 'n1', reportedBy: 'sita', reportedAt: '2026-11-18T08:00:00.000Z',
  status: 'open', resolvedAt: '', resolvedBy: '', corrected: false, correctedSnapshot: '', section: 'practice', appVersion: '1.0',
  updatedAt: '2026-11-18T08:00:00.000Z',   // server-stamped change time (an addition to the brief's field list)
});
const third = (await both('syncreportssince', { key: SYNC, since: 0 }))[0].reports.find((x) => x.id === 'rep-3');
assert.equal(third.qid, null); assert.equal(third.correctIndex, null); assert.equal(third.chosenIndex, null);
ok('every field the pipeline asked for is present, typed the same on both backends (nulls for missing qid/indices)');

// ═════════════ resolvereports ═════════════
const snapshot = JSON.stringify({ uid: 'q50011.110001', at: '2026-11-18T10:00:00.000Z', after: { question: 'Fixed', options: ['a', 'b', 'c'], correctIndex: 2 } });
const resolveItem = { id: 'rep-1', status: 'resolved', resolvedAt: '2026-11-18T10:00:00+00:00', resolvedBy: 'console', corrected: true, correctedSnapshot: snapshot };
[r] = await both('resolvereports', { key: SYNC, items: [resolveItem] });
assert.deepEqual(r, { success: true, updated: ['rep-1'], missing: [], failed: [] });
for (const w of worlds) {
  assert.deepEqual({ ...w.view('rep-1'), updatedAt: undefined }, { status: 'resolved', resolvedAt: '2026-11-18T10:00:00.000Z', resolvedBy: 'console', corrected: true, correctedSnapshot: snapshot, updatedAt: undefined }, w.name);
}
ok('resolvereports closes the report: the row shows resolved, with the corrected flag and snapshot');

const stamp1 = worlds.map((w) => w.view('rep-1').updatedAt);
[r] = await both('resolvereports', { key: SYNC, items: [resolveItem] });
assert.deepEqual(r, { success: true, updated: ['rep-1'], missing: [], failed: [] });
assert.deepEqual(worlds.map((w) => w.view('rep-1').updatedAt), stamp1);
ok('the same call twice gives the same result and does not re-stamp the row (idempotent, no downstream churn)');

out = await both('syncreportssince', { key: SYNC, since: T('2026-11-18T09:00:00.000Z') });
assert.deepEqual(ids(out[0]), ['rep-3', 'rep-1']);
const changed = out[0].reports.find((x) => x.id === 'rep-1');
assert.equal(changed.status, 'resolved'); assert.equal(changed.corrected, true); assert.equal(changed.correctedSnapshot, snapshot);
ok('a resolved report re-appears in syncreportssince (it CHANGED), carrying its resolution');

[r] = await both('resolvereports', { key: SYNC, items: [{ id: 'rep-1', status: 'open' }] });
assert.deepEqual(r, { success: true, updated: ['rep-1'], missing: [], failed: [] });
for (const w of worlds) assert.deepEqual({ ...w.view('rep-1'), updatedAt: undefined }, { status: 'open', resolvedAt: '', resolvedBy: '', corrected: false, correctedSnapshot: '', updatedAt: undefined }, w.name);
assert.ok(worlds.every((w, i) => w.view('rep-1').updatedAt > stamp1[i]), 're-open must move the cursor');
out = await both('syncreportssince', { key: SYNC, since: T('2026-11-18T09:30:00.000Z') });
assert.deepEqual(ids(out[0]), ['rep-1']);
assert.equal(out[0].reports[0].status, 'open'); assert.equal(out[0].reports[0].resolvedAt, '');
ok('status open clears resolvedAt/resolvedBy/corrected/snapshot AND is visible to the cursor (the old resolved_at cursor could not see it)');

[r] = await both('resolvereports', { key: SYNC, items: [{ id: 'made-up-id', status: 'resolved' }] });
assert.deepEqual(r, { success: true, updated: [], missing: ['made-up-id'], failed: [] });
[r] = await both('resolvereports', { key: SYNC, items: [{ id: 'rep-4', status: 'resolved', resolvedBy: 'console' }, { id: 'nope-1', status: 'open' }, { id: 'rep-4', status: 'resolved', resolvedBy: 'console' }] });
assert.deepEqual(r, { success: true, updated: ['rep-4'], missing: ['nope-1'], failed: [] });
for (const w of worlds) { assert.equal(w.view('rep-4').status, 'resolved'); assert.equal(w.view('rep-4').corrected, false); assert.equal(w.view('rep-4').correctedSnapshot, ''); }
ok('an unknown id is "missing"; a mixed batch splits correctly; a duplicate id in one call is one write');

[r] = await both('resolvereports', { key: SYNC, items: [{ id: 'rep-3', status: 'resolved' }] });
for (const w of worlds) { assert.equal(w.view('rep-3').status, 'resolved'); assert.equal(w.view('rep-3').resolvedBy, ''); }   // no resolvedBy → '' (a null would violate NOT NULL)
ok('a resolve with no resolvedBy / resolvedAt works (empty string, not null)');

const bad = [
  [{ id: 'bad id!', status: 'open' }, 'item 0: bad id'],
  [{ id: 'rep-1', status: 'dismissed' }, 'item 0: bad status'],
  [{ id: 'rep-1', status: 'resolved', resolvedAt: 'not a date' }, 'item 0: bad resolvedAt'],
  [{ id: 'rep-1', status: 'resolved', correctedSnapshot: 'x'.repeat(20001) }, 'item 0: snapshot too large'],
];
for (const [item, msg] of bad) { [r] = await both('resolvereports', { key: SYNC, items: [item] }); assert.deepEqual(r, { success: false, error: msg }); }
[r] = await both('resolvereports', { key: SYNC, items: Array.from({ length: 201 }, (_, i) => ({ id: 'x' + i, status: 'open' })) });
assert.equal(r.error, 'too many items in one call');
[r] = await both('resolvereports', { key: SYNC, items: [] }); assert.equal(r.error, 'items must be a non-empty list');
[r] = await both('resolvereports', { key: SYNC, items: 'not json' }); assert.equal(r.error, 'items must be a non-empty list');
ok('validation: bad id / status / date, oversized snapshot, 201 items, empty or malformed list — same errors on both');

// ═════════════ admincorrect ═════════════
const good = { qn: '50011.110001', question: 'What is 2+2?', options: ['3', '4', '5'], correctIndex: 1, explanation: 'because', note: 'fix' };
[r] = await both('admincorrect', { adminKey: 'wrong', items: [good] });
assert.deepEqual(r, { success: false, error: 'unauthorized' });
assert.equal(gh.calls.length, 0, 'nothing dispatched on a bad key');

gh.calls.length = 0;
[r] = await both('admincorrect', { adminKey: ADMIN, publish: false, items: [good] });
assert.deepEqual(r, { success: true, queued: 1 });
assert.equal(gh.calls.length, 2);                                                       // one dispatch per backend
for (const c of gh.calls) {
  assert.equal(c.url, 'https://api.github.com/repos/abhyasapp/DRIVETONEONTODRIVE/actions/workflows/apply_admin_corrections.yml/dispatches');
  assert.equal(c.payload.ref, 'main'); assert.equal(c.payload.inputs.publish, 'false');
  assert.deepEqual(JSON.parse(c.payload.inputs.corrections_json), [{ ...good }]);
  assert.equal(c.auth, 'Bearer ghp_test');
}
ok('a valid correction is queued: the workflow is dispatched with corrections_json and publish=false');

gh.calls.length = 0;
await both('admincorrect', { adminKey: ADMIN, items: [good] });                         // publish omitted
await both('admincorrect', { adminKey: ADMIN, publish: 'banana', items: [good] });      // garbled
await both('admincorrect', { adminKey: ADMIN, publish: true, items: [good] });
await both('admincorrect', { adminKey: ADMIN, publish: 'true', items: [good] });
assert.deepEqual(gh.calls.map((c) => c.payload.inputs.publish), ['false', 'false', 'false', 'false', 'true', 'true', 'true', 'true']);
ok('publish happens ONLY for an explicit true; omitted or garbled never publishes');

const badFix = [
  [{ ...good, qn: 'has space' }, 'item 0: bad qn id'],
  [{ ...good, question: '' }, 'item 0: question must be 1-2000 chars'],
  [{ ...good, options: ['only one'] }, 'item 0: need 2-10 options'],
  [{ ...good, options: ['a', ''] }, 'item 0: option 1 must be 1-1000 chars'],
  [{ ...good, correctIndex: 3 }, 'item 0: correctIndex must be an integer inside the options'],
  [{ ...good, correctIndex: 1.5 }, 'item 0: correctIndex must be an integer inside the options'],
  [{ ...good, correctIndex: '1' }, 'item 0: correctIndex must be an integer inside the options'],
  [{ ...good, explanation: 'x'.repeat(4001) }, 'item 0: explanation too long'],
];
gh.calls.length = 0;
for (const [item, msg] of badFix) { [r] = await both('admincorrect', { adminKey: ADMIN, items: [item] }); assert.deepEqual(r, { success: false, error: msg }); }
[r] = await both('admincorrect', { adminKey: ADMIN, items: [good, { ...good }] }); assert.equal(r.error, 'item 1: duplicate qn id 50011.110001');
[r] = await both('admincorrect', { adminKey: ADMIN, items: Array.from({ length: 51 }, (_, i) => ({ ...good, qn: 'q' + i })) }); assert.equal(r.error, 'at most 50 corrections per call');
[r] = await both('admincorrect', { adminKey: ADMIN, items: [] }); assert.equal(r.error, 'items must be a non-empty list');
[r] = await both('admincorrect', { adminKey: ADMIN, items: [{ ...good, question: 'q'.repeat(2000), options: Array.from({ length: 10 }, () => 'o'.repeat(1000)), explanation: 'e'.repeat(4000) }, ...Array.from({ length: 5 }, (_, i) => ({ ...good, qn: 'z' + i, question: 'q'.repeat(2000), options: Array.from({ length: 10 }, () => 'o'.repeat(1000)) }))] });
assert.equal(r.error, 'payload too large for one workflow run; send fewer corrections');
assert.equal(gh.calls.length, 0, 'invalid input never reaches GitHub');
ok('validation: every rule from the brief, plus the 60,000-char dispatch cap, identical on both; nothing invalid reaches GitHub');

gh.calls.length = 0; gh.status = 500;
[r] = await both('admincorrect', { adminKey: ADMIN, items: [good] });
assert.deepEqual(r, { success: false, error: 'GitHub dispatch failed (HTTP 500)' });
gh.status = 204;
ok('a GitHub failure is reported with its HTTP status');

// The admin key must be a separate secret.
process.env.ABHYAS_ADMIN_KEY = SYNC;
worlds[1].g.props.ABHYAS_ADMIN_KEY = SYNC;
[r] = await both('admincorrect', { adminKey: SYNC, items: [good] });
assert.equal(r.error, 'ABHYAS_ADMIN_KEY must differ from the sync key');
process.env.ABHYAS_ADMIN_KEY = ADMIN; worlds[1].g.props.ABHYAS_ADMIN_KEY = ADMIN;
ok('admincorrect refuses to run when the admin key equals the sync key');

// Secrets accepted under either name.
delete worlds[1].g.props.ABHYAS_SYNC_KEY; worlds[1].g.props.SYNC_KEY = SYNC;
r = await worlds[1].call('syncreportssince', { key: SYNC, since: 0 });
assert.equal(r.success, true);
worlds[1].g.props.ABHYAS_SYNC_KEY = SYNC; delete worlds[1].g.props.SYNC_KEY;
ok('the Apps Script accepts the sync key under either property name (SYNC_KEY or ABHYAS_SYNC_KEY)');

// ═════════════ write failures are "failed" (so the pipeline retries), not "missing" ═════════════
{
  const s = supabaseWorld();
  DB.failUpdates = { question_reports: new Set(['rep-3']) };
  const res = await s.call('resolvereports', { key: SYNC, items: [{ id: 'rep-1', status: 'resolved' }, { id: 'rep-3', status: 'resolved' }, { id: 'ghost', status: 'open' }] });
  assert.deepEqual(res, { success: true, updated: ['rep-1'], missing: ['ghost'], failed: ['rep-3'] });
  DB.failUpdates = undefined;

  const a = gasWorld({ SUPABASE_SERVICE_KEY: 'svc-key', SUPABASE_URL: 'https://x.supabase.co' });
  a.g.run(`bridgeConfig_ = function () { return { key: 'svc-key', url: 'https://x.supabase.co' }; }`);
  a.g.ctx.__sb.respond = (req) => (req.url.endsWith('id=eq.rep-3') ? { code: 500, body: {} } : req.url.endsWith('id=eq.ghost') ? { code: 200, body: [] } : { code: 200, body: [{ id: 'x' }] });
  const res2 = await a.call('resolvereports', { key: SYNC, items: [{ id: 'rep-1', status: 'resolved' }, { id: 'rep-3', status: 'resolved' }, { id: 'ghost', status: 'open' }] });
  assert.deepEqual(res2, { success: true, updated: ['rep-1'], missing: ['ghost'], failed: ['rep-3'] });
  const sent = a.g.ctx.__sb.reqs.find((q) => q.url.endsWith('id=eq.rep-1'));
  assert.deepEqual(JSON.parse(sent.payload), { status: 'resolved', resolved_at: a.view('rep-1').resolvedAt, resolved_by: '', corrected: '', corrected_snapshot: '' });
  assert.equal(sent.headers.apikey, 'svc-key');
  ok('a write error lands in `failed` (retried), never `missing`; the Supabase mirror sends "" not null and never logs a secret');
}

console.log(`\nALL ${n} PIPELINE PARITY CHECKS PASSED`);
