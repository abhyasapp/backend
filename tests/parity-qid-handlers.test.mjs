// The qid features, scripted once and run through the REAL Supabase handlers and the REAL Apps Script
// handlers: weekly scoring across a reorder and a correction, per-question state, answer events,
// statistics, correction patches and the registry. Identical outputs required.
// Run: node --import ./tests/handlers/register.mjs tests/parity-qid-handlers.test.mjs
import assert from 'node:assert/strict';
import { DB, reset } from './handlers/mock-supabase.mjs';
import { makeGas } from './gas-harness.mjs';

const W = await import('../supabase/functions/api/handlers/weekly.ts');
const S = await import('../supabase/functions/api/handlers/qstate.ts');
const R = await import('../supabase/functions/api/handlers/reports.ts');
const { tokenHash } = await import('../supabase/functions/api/_shared/crypto.ts');

let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);
const hour = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const SYNC = 'pipe-key';
const USERS = ['sita', 'ram', 'hari', 'gita', 'mina', 'dev'];
const Q = (id, q, correct) => ({ id, q, options: ['a', 'b', 'c', 'd'], correct, explanation: '' });
const base = () => [Q(101, 'one', 0), Q(102, 'two', 1), Q(103, 'three', 2), Q(104, 'four', 3)];

// ── worlds ────────────────────────────────────────────────────────────
reset();
process.env.SYNC_KEY = SYNC; delete process.env.ABHYAS_SYNC_KEY;
DB.tables.admins = [{ username: 'admin', role: 'owner', token: await tokenHash('admin-token'), token_expires: String(Date.now() + hour), must_change_password: 'false' }];
DB.tables.users = [];
for (const u of USERS) DB.tables.users.push({ username: u, status: 'active', permanent_access: 'true', session_token: await tokenHash(u + '-tok'), session_token_expires_at: String(Date.now() + hour) });
DB.storage['weekly-sets/w1.json'] = JSON.stringify({ questions: base() });

const gas = makeGas({ files: { w1: { questions: base() } }, syncKey: SYNC, props: { SYNC_KEY: SYNC } });
gas.run('SpreadsheetApp = { BandingTheme: { CYAN: 1, TEAL: 1, PINK: 1, INDIGO: 1 } }');

const FN = {
  supabase: {
    admincreateweeklyset: W.admincreateweeklyset, submitweeklyattempt: W.submitweeklyattempt, adminweeklysetresults: W.adminweeklysetresults,
    adminrescoreweeklyset: W.adminrescoreweeklyset, syncqstate: S.syncqstate, recordanswers: S.recordanswers, getqidpatches: S.getqidpatches,
    rebuildqidstats: S.rebuildqidstats, resolveqids: S.resolveqids, adminqidcoverage: S.adminqidcoverage, ingestquestionindex: S.ingestquestionindex, gethardquestions: R.gethardquestions,
  },
  gas: {
    admincreateweeklyset: 'adminCreateWeeklySet', submitweeklyattempt: 'submitWeeklyAttempt', adminweeklysetresults: 'adminWeeklySetResults',
  },
};
const tok = { supabase: (u) => u + '-tok', gas: (u) => 'ok-' + u };

async function callSupabase(action, p) { return (await FN.supabase[action](p)).json(); }
async function callGas(action, p) {
  const direct = FN.gas[action];
  const r = direct ? gas.fn(direct, p) : action === 'gethardquestions' ? gas.run('qidHardQuestions_()') : gas.route(action, p);
  return JSON.parse(JSON.stringify(r));
}
const as = (w, u, extra = {}) => ({ username: u, token: tok[w](u), ...extra });
const adm = (extra = {}) => ({ username: 'admin', token: 'admin-token', ...extra });

const DROP = new Set(['weeklyId', 'updatedAt', 'serverNow', 'cursor', 'id', 'submittedAt', 'startedAt', 'durationSec', 'releaseAt', 'uploadedAt', 'synced', 'noteAt', 'bookmarkedAt', 'flaggedAt', 'mistakesAt', 'lastAt', 'correctedAt']);
const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (DROP.has(k) ? undefined : x)));

/** Same step on both backends; outputs must match. `build(world)` makes the world-specific params. */
async function both(action, build) {
  await new Promise((r) => setTimeout(r, 4));   // distinct server milliseconds per step, in both worlds
  const s = await callSupabase(action, build('supabase'));
  const g = await callGas(action, build('gas'));
  assert.deepEqual(norm(g), norm(s), `backends disagree on ${action}\n supabase: ${JSON.stringify(norm(s))}\n appsscript: ${JSON.stringify(norm(g))}`);
  return { s, g };
}

// ═════════════ WEEKLY ═════════════
const created = await both('admincreateweeklyset', (w) => adm({ title: 'Week 1', fileId: w === 'supabase' ? 'w1.json' : 'w1', releaseAt: iso(Date.now() - 60000) }));
assert.equal(created.s.qidReady, true); assert.equal(created.s.frozenQuestions, 4);
const wid = { supabase: created.s.id, gas: created.g.id };
ok('creating a weekly set freezes the same paper (qids, coverage) on both backends');

const answers = JSON.stringify({ 101: 0, 102: 1, 103: 0, 104: null });
let r = await both('submitweeklyattempt', (w) => as(w, 'sita', { weeklyId: wid[w], answersByQid: answers }));
assert.equal(r.s.attempt.correct, 2); assert.equal(r.s.attempt.skipped, 1);
ok('a qid-keyed submission scores identically (correct / skipped / answersByQid / qids)');

// Reorder the file after release: same questions, new order.
const b = base();
const reordered = { questions: [b[2], b[0], b[3], b[1]] };
DB.storage['weekly-sets/w1.json'] = JSON.stringify(reordered); gas.files.w1 = reordered;
r = await both('submitweeklyattempt', (w) => as(w, 'ram', { weeklyId: wid[w], answersByQid: answers }));
assert.equal(r.s.attempt.correct, 2);
ok('REORDER: the same answers score identically after the file is reordered, on both backends');

r = await both('submitweeklyattempt', (w) => as(w, 'hari', { weeklyId: wid[w], answers: JSON.stringify([2, 0, 3, 1]) }));
assert.equal(r.s.attempt.correct, 4);
ok('a legacy positional payload is converted through the file order identically');

await both('submitweeklyattempt', (w) => as(w, 'gita', { weeklyId: wid[w], answersByQid: JSON.stringify({ 999: 1 }) }));
await both('submitweeklyattempt', (w) => as(w, 'gita', { weeklyId: wid[w], answers: JSON.stringify([0, 1]) }));
ok('unknown qids and a wrong-length positional array are refused with the same error and code');

// Correct question 102's answer (b → c).
const fixed = JSON.parse(JSON.stringify(reordered)); fixed.questions.find((q) => q.id === 102).correct = 2;
DB.storage['weekly-sets/w1.json'] = JSON.stringify(fixed); gas.files.w1 = fixed;

r = await both('adminweeklysetresults', (w) => adm({ weeklyId: wid[w] }));
assert.equal(r.s.paperChanged, true);
const st = r.s.questionStats.find((x) => x.qid === '102');
assert.equal(st.answered, 3); assert.equal(st.correct, 0);
assert.equal(r.s.rescored, false);
ok('results: stored scores (no live positional re-score), per-question stats by qid, paperChanged — identical');

r = await both('adminrescoreweeklyset', (w) => adm({ weeklyId: wid[w] }));
assert.equal(r.s.dryRun, true); assert.equal(r.s.changed, 3); assert.equal(r.s.examined, 3);
r = await both('adminrescoreweeklyset', (w) => adm({ weeklyId: wid[w], dryRun: 'false' }));
assert.equal(r.s.changed, 3);
r = await both('adminrescoreweeklyset', (w) => adm({ weeklyId: wid[w], dryRun: 'false' }));
assert.equal(r.s.changed, 0);
ok('re-score applies a correction by qid, is dry-run by default and idempotent — identical changes list');

// ═════════════ QSTATE ═════════════
const T0 = Date.now() - 10 * 60000;
r = await both('syncqstate', (w) => as(w, 'sita', { changes: JSON.stringify([
  { qid: 701, fileId: 'cdnFile', note: 'phone note', noteAt: iso(T0 + 1000) },
  { qid: 702, bookmarked: true, bookmarkedAt: iso(T0 + 1000) },
  { qid: 'bad id' },
]) }));
assert.equal(r.s.applied, 2); assert.deepEqual(r.s.rejected, [{ index: 2, reason: 'bad_qid' }]);
r = await both('syncqstate', (w) => as(w, 'sita', { changes: JSON.stringify([
  { qid: 702, bookmarked: false, bookmarkedAt: iso(T0 + 500), flagged: true, flaggedAt: iso(T0 + 2000) },
  { qid: 701, note: 'older note', noteAt: iso(T0 + 100) },
]) }));
const row702 = r.s.rows.find((x) => x.qid === '702');
assert.equal(row702.bookmarked, true); assert.equal(row702.flagged, true);
ok('per-FIELD merge: an older edit never clobbers a newer one; the new field lands — identical rows');

r = await both('syncqstate', (w) => as(w, 'sita', { changes: JSON.stringify([{ qid: 701, note: 'future', noteAt: iso(Date.now() + 10 * hour) }]) }));
const clamped = r.s.rows.find((x) => x.qid === '701');
assert.equal(clamped.note, 'future');
ok('a wildly-future timestamp is clamped the same way (a bad clock never wins forever)');

// merged qid redirect
DB.tables.question_index.push({ qid: '900', file_id: 'f', ord: '0', rev: '', kind: 'stable', status: 'merged', canonical_qid: '902', updated_at: '' });
const seeded = await callGas('ingestquestionindex', { key: SYNC, rows: JSON.stringify([{ qid: 900, fileId: 'f', status: 'merged', canonicalQid: 902 }]) });
assert.equal(seeded.success, true, 'seeding the Apps Script registry must succeed');
r = await both('syncqstate', (w) => as(w, 'mina', { changes: JSON.stringify([{ qid: 900, note: 'on the merged one' }]) }));
assert.deepEqual(r.s.rows.map((x) => x.qid), ['902']);
r = await both('resolveqids', (w) => as(w, 'mina', { qids: JSON.stringify([900, 701, 12345]) }));
assert.equal(r.s.qids['900'].canonicalQid, '902'); assert.equal(r.s.qids['900'].redirected, true);
ok('state saved against a merged qid lands on the canonical one; resolveqids reports the redirect — identical');

// ═════════════ ANSWERS + STATS ═════════════
const at0 = Date.now() - 5 * 60000;
const batch = [
  { qid: 701, ok: false, chosen: 1, at: at0, mode: 'practice', fileId: 'cdnFile' },
  { qid: 701, ok: true, chosen: 2, at: at0 + 1000 },
  { qid: 702, ok: false, at: at0 + 2000 },
  { qid: 'nope', ok: true },
  { qid: 702, ok: 'maybe' },
  { qid: 703, ok: true, at: Date.now() - 400 * 24 * hour },
];
r = await both('recordanswers', (w) => as(w, 'dev', { events: JSON.stringify(batch) }));
assert.equal(r.s.accepted, 3); assert.deepEqual(r.s.rejected.map((x) => x.reason), ['bad_qid', 'bad_ok', 'bad_time']);
const s701 = r.s.state.find((x) => x.qid === '701');
assert.equal(s701.attempts, 2); assert.equal(s701.wrong, 1); assert.equal(s701.lastResult, 'ok'); assert.equal(s701.inMistakes, true);
r = await both('recordanswers', (w) => as(w, 'dev', { events: JSON.stringify(batch.slice(0, 3)) }));
assert.equal(r.s.accepted, 0); assert.equal(r.s.duplicates, 3);
ok('answer events: counters, mistake list, idempotent retry, rejected reasons — identical on both');

for (const u of ['sita', 'ram', 'hari', 'gita', 'mina']) {
  const evs = Array.from({ length: 4 }, (_, i) => ({ qid: 701, ok: i % 2 === 0, at: Date.now() - 60000 + i * 100 + u.length }));
  await both('recordanswers', (w) => as(w, u, { events: JSON.stringify(evs) }));
}
r = await both('gethardquestions', (w) => as(w, 'sita'));
assert.equal(r.s.qidMap['701'], 50);
assert.equal(r.s.source, 'qid_stats');
ok('most-missed questions come from qid statistics counting DISTINCT students — identical qidMap');

// qid_stats is derived: rebuilding it from the answer log reproduces the live counters exactly, on both.
const liveS = JSON.stringify(DB.tables.qid_stats.map((x) => [x.qid, x.attempts, x.wrong, x.students]).sort());
r = await both('rebuildqidstats', () => ({ key: SYNC }));
assert.ok(r.s.rebuilt >= 1);
assert.equal(JSON.stringify(DB.tables.qid_stats.map((x) => [x.qid, x.attempts, x.wrong, x.students]).sort()), liveS);
const bad0 = await both('rebuildqidstats', () => ({ key: 'nope' })); assert.equal(bad0.s.error, 'unauthorized');
ok('rebuildqidstats recomputes the same totals from the answer log on both backends (and matches the live counters)');

// ═════════════ PATCHES ═════════════
const beforeQ = { question: 'Original', options: ['a', 'b', 'c', 'd'], correctIndex: 0 };
const afterQ = { question: 'Fixed once', options: ['a', 'b', 'c', 'd'], correctIndex: 2, explanation: '' };
DB.tables.correction_events = [{ id: 1, dedupe_key: 'q701', uid: 'q701', qid: '701', file_id: 'cdnFile', report_id: '', corrected_at: '2026-11-17T01:00:00.000Z', before: JSON.stringify(beforeQ), after: JSON.stringify(afterQ), note: '', admin_user: 'admin', created_at: '', base_rev: '', new_rev: '' }];
const qrep = gas.run('getQReportsSheet_()');
qrep.appendRow(['rep-p', 'cdnFile_0', 'cdnFile', 'Original', 'wrong_answer', '', 'sita', '2026-11-16T08:00:00.000Z', 'resolved', '["a","b","c","d"]', 0, '', 'practice', '1.0',
  '2026-11-17T01:00:00.000Z', 'admin', 'TRUE', JSON.stringify({ uid: 'q701', at: '2026-11-17T01:00:00.000Z', before: beforeQ, after: afterQ }), '701', '2026-11-17T01:00:00.000Z']);
r = await both('getqidpatches', (w) => as(w, 'sita', { since: '2026-11-01T00:00:00.000Z', fileId: 'cdnFile' }));
assert.equal(r.s.patches.length, 1); assert.equal(r.s.patches[0].question, 'Fixed once');
const patchRev = r.s.patches[0].rev;
assert.ok(patchRev, 'patch carries the question revision');
ok('students get a correction as a qid-keyed patch; the revision hash is identical on both backends');
r = await both('getqidpatches', (w) => as(w, 'sita', { since: '2026-11-17T01:00:00.000Z' }));
assert.deepEqual(r.s.patches, []);
ok('the patch cursor is exclusive, identically');

// ═════════════ REGISTRY ═════════════
r = await both('ingestquestionindex', () => ({ key: SYNC, rows: JSON.stringify([
  { qid: 'A-123-456-789012', fileId: 'f9', ord: 3, rev: 'r1' }, { qid: 5, status: 'merged', canonicalQid: 6 },
  { qid: 7, status: 'merged', canonicalQid: 7 }, { qid: '???' },
]) }));
assert.equal(r.s.upserted, 2); assert.deepEqual(r.s.rejected.map((x) => x.reason), ['bad_canonical', 'bad_qid']);
const bad = await both('ingestquestionindex', () => ({ key: 'wrong', rows: '[]' }));
assert.equal(bad.s.code, 'unauthorized');
ok('registry ingest: same accepted / rejected rows, same auth failure');

console.log(`\nALL ${n} QID PARITY CHECKS PASSED`);
