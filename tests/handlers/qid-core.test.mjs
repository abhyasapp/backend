// qid core, end to end through the real handlers (in-memory Supabase mock).
// Run: node --import ./tests/handlers/register.mjs tests/handlers/qid-core.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB, reset } from './mock-supabase.mjs';

const W = await import('../../supabase/functions/api/handlers/weekly.ts');
const R = await import('../../supabase/functions/api/handlers/reports.ts');
const S = await import('../../supabase/functions/api/handlers/qstate.ts');
const U = await import('../../supabase/functions/api/handlers/users.ts');
const { tokenHash } = await import('../../supabase/functions/api/_shared/crypto.ts');
const { questionRev } = await import('../../supabase/functions/api/_shared/qid.ts');

const call = async (fn, params) => (await fn(params)).json();
let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);
const iso = (ms) => new Date(ms).toISOString();

reset();
process.env.SYNC_KEY = 'pipeline-test-key';
const hour = 3600000;
DB.tables.admins = [{ username: 'admin', role: 'owner', token: await tokenHash('admin-token'), token_expires: String(Date.now() + hour), must_change_password: 'false' }];
DB.tables.users = [];
for (const u of ['sita', 'ram', 'hari', 'gita', 'mina', 'dev']) {
  DB.tables.users.push({ username: u, status: 'active', permanent_access: 'true', session_token: await tokenHash(u + '-tok'), session_token_expires_at: String(Date.now() + hour) });
}
const as = (u, extra = {}) => ({ username: u, token: u + '-tok', ...extra });
const admin = (extra = {}) => ({ username: 'admin', token: 'admin-token', ...extra });

const Q = (id, q, correct, extra = {}) => ({ id, q, options: ['a', 'b', 'c', 'd'], correct, explanation: '', ...extra });
const base = () => [Q(101, 'one', 0), Q(102, 'two', 1), Q(103, 'three', 2), Q(104, 'four', 3)];
DB.storage['weekly-sets/w1.json'] = JSON.stringify({ questions: base() });

// ═══════════════ WEEKLY: frozen paper, qid scoring, reorder, correction, re-score ═══════════════
let r = await call(W.admincreateweeklyset, admin({ title: 'Week 1', fileId: 'w1.json', releaseAt: iso(Date.now() - 60000) }));
assert.equal(r.success, true);
assert.equal(r.qidReady, true);
assert.equal(r.frozenQuestions, 4);
const wid = r.id;
const wsRow = DB.tables.weekly_sets.find((x) => x.id === wid);
assert.deepEqual(JSON.parse(wsRow.qids), ['101', '102', '103', '104']);
assert.ok(wsRow.file_rev);
assert.equal(DB.tables.question_index.length, 4);            // creating the set registered the questions
ok('creating a weekly set freezes its question ids + revision and registers them');

r = await call(W.submitweeklyattempt, as('sita', { weeklyId: wid, answersByQid: JSON.stringify({ 101: 0, 102: 1, 103: 0, 104: null }) }));
assert.equal(r.success, true, JSON.stringify(r));
assert.equal(r.mode, 'qid');
assert.equal(r.attempt.correct, 2);
assert.equal(r.attempt.skipped, 1);
const stored = DB.tables.weekly_attempts.find((x) => x.username === 'sita');
assert.deepEqual(JSON.parse(stored.answers_by_qid), { 101: 0, 102: 1, 103: 0, 104: null });
assert.deepEqual(JSON.parse(stored.qids), ['101', '102', '103', '104']);
ok('a qid-keyed submission is scored by id and stores the paper the student saw');

// The admin reorders the file after release. Same questions, new order.
const b = base();
DB.storage['weekly-sets/w1.json'] = JSON.stringify({ questions: [b[2], b[0], b[3], b[1]] });
r = await call(W.submitweeklyattempt, as('ram', { weeklyId: wid, answersByQid: JSON.stringify({ 101: 0, 102: 1, 103: 0, 104: null }) }));
assert.equal(r.attempt.correct, 2);                          // identical answers → identical score despite the reorder
ok('REORDER: the same answers score identically after the file is reordered');

// A legacy client sends positions, in the order of the (now reordered) file it downloaded: 103,101,104,102.
r = await call(W.submitweeklyattempt, as('hari', { weeklyId: wid, answers: JSON.stringify([2, 0, 3, 1]) }));
assert.equal(r.success, true, JSON.stringify(r));
assert.equal(r.attempt.correct, 4);
assert.deepEqual(JSON.parse(DB.tables.weekly_attempts.find((x) => x.username === 'hari').answers_by_qid), { 101: 0, 102: 1, 103: 2, 104: 3 });
ok('a legacy positional payload is converted to qid answers through the file order');

r = await call(W.submitweeklyattempt, as('gita', { weeklyId: wid, answersByQid: JSON.stringify({ 999: 1 }) }));
assert.equal(r.success, false); assert.equal(r.code, 'unknown_qid');
r = await call(W.submitweeklyattempt, as('gita', { weeklyId: wid, answers: JSON.stringify([0, 1]) }));
assert.equal(r.success, false); assert.equal(r.code, 'count_mismatch');
assert.equal(DB.tables.weekly_attempts.length, 3);
ok('unknown qids and a wrong-length positional array are refused without storing anything');

r = await call(W.submitweeklyattempt, as('sita', { weeklyId: wid, answersByQid: JSON.stringify({ 101: 0 }) }));
assert.equal(r.alreadyAttempted, true);
ok('a second submission is still refused');

// The admin corrects question 102's answer (b → c) in the reordered file.
const reordered = JSON.parse(DB.storage['weekly-sets/w1.json']);
reordered.questions.find((q) => q.id === 102).correct = 2;
DB.storage['weekly-sets/w1.json'] = JSON.stringify(reordered);

r = await call(W.adminweeklysetresults, admin({ weeklyId: wid }));
assert.equal(r.success, true);
assert.equal(r.paperChanged, true);
const stat102 = r.questionStats.find((x) => x.qid === '102');
assert.equal(stat102.answered, 3); assert.equal(stat102.correct, 0);   // everyone chose b, key is now c
ok('results report per-question stats by qid and flag that the paper changed');

r = await call(W.adminrescoreweeklyset, admin({ weeklyId: wid }));           // dry run by default
assert.equal(r.dryRun, true); assert.equal(r.examined, 3); assert.equal(r.changed, 3);
assert.equal(DB.tables.weekly_attempts.find((x) => x.username === 'sita').correct_claimed, 2);   // untouched
r = await call(W.adminrescoreweeklyset, admin({ weeklyId: wid, dryRun: 'false' }));
assert.equal(r.changed, 3);
const att = (u) => DB.tables.weekly_attempts.find((x) => x.username === u);
assert.equal(att('sita').correct_claimed, '1');   // lost 102
assert.equal(att('hari').correct_claimed, '3');   // lost 102
r = await call(W.adminrescoreweeklyset, admin({ weeklyId: wid, dryRun: 'false' }));
assert.equal(r.changed, 0);
ok('re-scoring applies a correction by qid, is dry-run by default, and is idempotent');

r = await call(W.adminupdateweeklyset, admin({ id: wid, fileId: 'other.json' }));
assert.equal(r.success, false);
assert.match(r.error, /already attempted/);
ok('swapping a weekly set\'s file after attempts exist is refused');

// ═══════════════ CORRECTIONS: CDN overlay, revision concurrency, qid_required ═══════════════
const cdn = { questions: [Q(701, 'Original', 0), Q(702, 'Second', 1)] };
globalThis.fetch = async (url) => String(url).includes('/content/cdnFile.json') ? { ok: true, json: async () => JSON.parse(JSON.stringify(cdn)) } : { ok: false };

r = await call(R.admingetquestion, admin({ fileId: 'cdnFile', index: 0, qid: 701 }));
assert.equal(r.success, true);
const rev0 = r.rev;
assert.equal(r.question.q, 'Original');

// A correction is logged, but the CDN copy still serves the old text (the pipeline has not re-exported).
DB.tables.correction_events = [{
  id: 1, dedupe_key: 'q701', uid: 'q701', qid: '701', file_id: 'cdnFile', report_id: '', corrected_at: '2026-11-17T01:00:00.000Z',
  before: JSON.stringify({ question: 'Original', options: ['a', 'b', 'c', 'd'], correctIndex: 0 }),
  after: JSON.stringify({ question: 'Fixed once', options: ['a', 'b', 'c', 'd'], correctIndex: 2, explanation: '' }),
  note: '', admin_user: 'admin', created_at: '', base_rev: '', new_rev: '',
}];
r = await call(R.admingetquestion, admin({ fileId: 'cdnFile', index: 0, qid: 701 }));
assert.equal(r.question.q, 'Fixed once');                      // overlay applied: the admin sees what students will see
assert.equal(r.question.correct, 2);
assert.equal(r.overlay.applied, 1);
assert.notEqual(r.rev, rev0);
const rev1 = r.rev;
ok('a logged correction is overlaid onto the lagging CDN copy by qid');

r = await call(R.adminupdatequestion, admin({
  fileId: 'cdnFile', index: 5, qid: 701, baseRev: rev1, correctedAt: '2026-11-17T02:00:00.000Z',
  fields: JSON.stringify({ q: 'Fixed twice', options: ['a', 'b', 'c', 'd'], correct: 3, explanation: 'why' }),
}));
assert.equal(r.success, true, JSON.stringify(r));             // index 5 is wrong on purpose: the qid decides
assert.ok(r.rev && r.rev !== rev1);
const ev = DB.tables.correction_events.find((e) => e.corrected_at === '2026-11-17T02:00:00.000Z');
assert.equal(ev.base_rev, rev1);
assert.equal(ev.new_rev, r.rev);
assert.equal(JSON.parse(ev.before).question, 'Fixed once');   // `before` is the corrected view, not the stale CDN copy
ok('an update locates by qid (not position), records base_rev → new_rev, and its before-side is the overlaid view');

r = await call(R.adminupdatequestion, admin({
  fileId: 'cdnFile', index: 0, qid: 701, baseRev: rev1, correctedAt: '2026-11-17T03:00:00.000Z',
  fields: JSON.stringify({ q: 'Stale overwrite', options: ['a', 'b', 'c', 'd'], correct: 0 }),
}));
assert.equal(r.success, false); assert.equal(r.code, 'rev_conflict');
assert.equal(DB.tables.correction_events.length, 2);
ok('a stale baseRev is refused (optimistic concurrency per question)');

r = await call(R.admingetquestion, admin({ fileId: 'cdnFile', index: 0 }));
assert.equal(r.success, false); assert.equal(r.code, 'qid_required');
r = await call(R.admingetquestion, admin({ fileId: 'cdnFile', index: 0, qid: 701 }));
assert.equal(r.question.q, 'Fixed twice');                     // chained overlay: both events applied in order
assert.equal(r.overlay.applied, 2);
ok('a position-only read of an id-bearing question is refused; chained corrections overlay in order');

// An event whose `before` no longer matches (the pipeline already absorbed / something else changed it) is not re-applied.
cdn.questions[0].q = 'Rewritten by the pipeline';
r = await call(R.admingetquestion, admin({ fileId: 'cdnFile', index: 0, qid: 701 }));
assert.equal(r.question.q, 'Rewritten by the pipeline');
assert.equal(r.overlay.applied, 0); assert.equal(r.overlay.skipped, 2);
ok('the overlay never reverts a question the pipeline has since changed');

// A uid-only report from an old client gets its qid from the registry.
DB.tables.question_index = [{ qid: '702', file_id: 'cdnFile', ord: '1', rev: 'x', kind: 'stable', status: 'active', canonical_qid: '', updated_at: '' }];
r = await call(R.reportquestion, as('sita', { uid: 'cdnFile_1', reason: 'wrong_answer', fileId: 'cdnFile' }));
assert.equal(r.success, true);
assert.equal(r.qid, '702'); assert.equal(r.qidSource, 'registry_by_position');
r = await call(R.reportquestion, as('ram', { uid: 'cdnFile_1', qid: 702, reason: 'wrong_answer' }));
assert.equal(r.qidSource, 'client');
ok('an old client\'s uid-only report is filed against the qid the registry knows');

// ═══════════════ QSTATE: per-field merge across devices, delta sync, redirects ═══════════════
const T0 = Date.now() - 10 * 60000;
r = await call(S.syncqstate, as('sita', { changes: JSON.stringify([
  { qid: 701, fileId: 'cdnFile', note: 'phone note', noteAt: iso(T0 + 1000) },
  { qid: 702, bookmarked: true, bookmarkedAt: iso(T0 + 1000) },
  { qid: 'bad id' },
]) }));
assert.equal(r.success, true);
assert.equal(r.applied, 2);
assert.deepEqual(r.rejected, [{ index: 2, reason: 'bad_qid' }]);
const cursor1 = r.cursor;

// A laptop edits the bookmark (older clock) and flags it (new field) — per-field LWW: bookmark stays, flag lands.
r = await call(S.syncqstate, as('sita', { changes: JSON.stringify([
  { qid: 702, bookmarked: false, bookmarkedAt: iso(T0 + 500), flagged: true, flaggedAt: iso(T0 + 2000) },
  { qid: 701, note: 'older note', noteAt: iso(T0 + 100) },
]), since: cursor1 }));
const st = Object.fromEntries(r.rows.map((x) => [x.qid, x]));
assert.equal(st['702'].bookmarked, true);          // the older write lost, field by field
assert.equal(st['702'].flagged, true);             // the new field merged in
assert.equal(DB.tables.user_qstate.find((x) => x.qid === '701').note, 'phone note');
ok('qstate merges per FIELD by timestamp: an older edit never clobbers a newer one, new fields still land');

r = await call(S.syncqstate, as('sita', { since: cursor1 }));
// INCLUSIVE cursor: the boundary row (701, written in the same request as the cursor) is re-sent so a
// sibling sharing the cursor's millisecond can never be skipped; 702 changed afterwards.
assert.deepEqual(r.rows.map((x) => x.qid), ['701', '702']);
r = await call(S.syncqstate, as('ram', { since: '' }));
assert.deepEqual(r.rows, []);
// A tiny requested page can never split a group of rows that share one timestamp.
r = await call(S.syncqstate, as('sita', { since: '', limit: 1 }));
assert.equal(r.rows.length, 2); assert.equal(r.more, false);
ok('delta sync is inclusive, totally ordered, scoped to the student, and a tiny limit cannot split a tie group');

r = await call(S.syncqstate, as('sita', { changes: JSON.stringify([{ qid: 701, note: 'future', noteAt: iso(Date.now() + 10 * hour) }]) }));
const f = DB.tables.user_qstate.find((x) => x.qid === '701' && x.username === 'sita');
assert.ok(new Date(f.note_at).getTime() < Date.now() + 10 * 60000);   // a wrong device clock is clamped to "now"
ok('a timestamp far in the future is clamped, so a bad clock can never win forever');

// A merged question: qid 900 now redirects to 902.
DB.tables.question_index.push({ qid: '900', file_id: 'f', ord: '0', rev: '', kind: 'stable', status: 'merged', canonical_qid: '902', updated_at: '' });
r = await call(S.syncqstate, as('mina', { changes: JSON.stringify([{ qid: 900, note: 'on the merged one' }]) }));
assert.deepEqual(DB.tables.user_qstate.filter((x) => x.username === 'mina').map((x) => x.qid), ['902']);
r = await call(S.resolveqids, as('mina', { qids: JSON.stringify([900, 701, 12345]) }));
assert.equal(r.qids['900'].canonicalQid, '902'); assert.equal(r.qids['900'].redirected, true);
assert.equal(r.qids['701'].redirected, false);
ok('state saved against a merged qid lands on the canonical qid; resolveqids reports the redirect');

// ═══════════════ ANSWERS: idempotent events, counters, mistake list, atomic stats ═══════════════
const at0 = Date.now() - 5 * 60000;
const batch = [
  { qid: 701, ok: false, chosen: 1, at: at0, mode: 'practice', fileId: 'cdnFile' },
  { qid: 701, ok: true, chosen: 2, at: at0 + 1000 },
  { qid: 702, ok: false, at: at0 + 2000 },
  { qid: 'nope', ok: true },
  { qid: 702, ok: 'maybe' },
];
r = await call(S.recordanswers, as('dev', { events: JSON.stringify(batch) }));
assert.equal(r.success, true);
assert.equal(r.accepted, 3);
assert.deepEqual(r.rejected.map((x) => x.reason), ['bad_qid', 'bad_ok']);
let row701 = DB.tables.user_qstate.find((x) => x.username === 'dev' && x.qid === '701');
assert.equal(row701.attempts, '2'); assert.equal(row701.wrong, '1'); assert.equal(row701.last_result, 'ok');
assert.equal(row701.in_mistakes, 'true');                       // a wrong answer put it on the mistake list
r = await call(S.recordanswers, as('dev', { events: JSON.stringify(batch.slice(0, 3)) }));
assert.equal(r.accepted, 0); assert.equal(r.duplicates, 3);     // a retried batch is a no-op
assert.equal(DB.tables.user_qstate.find((x) => x.username === 'dev' && x.qid === '701').attempts, '2');
assert.equal(DB.tables.answer_events.filter((x) => x.username === 'dev').length, 3);
ok('answer events are idempotent per (student, qid, instant); counters and the mistake list update');

// Clearing the mistake with an OLDER clock loses to the wrong answer; a NEWER clear wins.
await call(S.syncqstate, as('dev', { changes: JSON.stringify([{ qid: 701, inMistakes: false, mistakesAt: iso(at0 - 60000) }]) }));
assert.equal(DB.tables.user_qstate.find((x) => x.username === 'dev' && x.qid === '701').in_mistakes, 'true');
await call(S.syncqstate, as('dev', { changes: JSON.stringify([{ qid: 701, inMistakes: false, mistakesAt: iso(Date.now()) }]) }));
assert.equal(DB.tables.user_qstate.find((x) => x.username === 'dev' && x.qid === '701').in_mistakes, 'false');
ok('mistake-list membership follows field-level last-writer-wins against answer events');

r = await call(S.recordanswers, as('dev', { events: JSON.stringify([{ qid: 701, ok: true, at: Date.now() - 400 * 24 * hour }]) }));
assert.equal(r.accepted, 0); assert.equal(r.rejected[0].reason, 'bad_time');
ok('an answer event with an absurd timestamp is rejected');

// Hard questions come from qid_stats and need distinct students.
const stat = DB.tables.qid_stats.find((x) => x.qid === '701');
assert.equal(stat.attempts, '2'); assert.equal(stat.wrong, '1'); assert.equal(stat.students, '1');
for (const u of ['sita', 'ram', 'hari', 'gita', 'mina']) {
  const evs = Array.from({ length: 4 }, (_, i) => ({ qid: 701, ok: i % 2 === 0, at: Date.now() - 60000 + i * 100 + u.length }));
  await call(S.recordanswers, as(u, { events: JSON.stringify(evs) }));
}
r = await call(R.gethardquestions, as('sita'));
assert.equal(r.source, 'qid_stats');
assert.equal(DB.tables.qid_stats.find((x) => x.qid === '701').attempts, '22');   // 2 from dev + 5 students × 4
assert.equal(DB.tables.qid_stats.find((x) => x.qid === '701').wrong, '11');
assert.equal(r.qidMap['701'], 50);                                              // 11 wrong of 22, by 6 distinct students
assert.equal(DB.tables.qid_stats.find((x) => x.qid === '701').students, '6');
ok('most-missed comes from qid_stats, counting distinct students');

// One account alone can never make a question look hard.
DB.tables.qid_stats.push({ qid: '888', attempts: '500', wrong: '500', students: '1', updated_at: '' });
r = await call(R.gethardquestions, as('sita'));
assert.equal(r.qidMap['888'], undefined);
ok('a single student cannot push a question into the hard list');

// ═══════════════ PATCHES, REGISTRY, COVERAGE, INGEST, RESET ═══════════════
r = await call(S.getqidpatches, as('sita', { since: '2026-11-01T00:00:00.000Z', fileId: 'cdnFile' }));
assert.equal(r.success, true);
assert.equal(r.patches.length, 1);                              // latest per qid, not every event
assert.equal(r.patches[0].qid, '701');
assert.equal(r.patches[0].question, 'Fixed twice');
assert.ok(r.patches[0].rev);
r = await call(S.getqidpatches, as('sita', { since: r.cursor }));
assert.deepEqual(r.patches, []);
ok('students get admin corrections as qid-keyed patches with an exclusive cursor');

r = await call(S.ingestquestionindex, { key: 'wrong', rows: '[]' });
assert.equal(r.success, false); assert.equal(r.code, 'unauthorized');
r = await call(S.ingestquestionindex, { key: 'pipeline-test-key', rows: JSON.stringify([
  { qid: 'A-123-456-789012', fileId: 'f9', ord: 3, rev: 'r1' },
  { qid: 5, status: 'merged', canonicalQid: 6 },
  { qid: 7, status: 'merged', canonicalQid: 7 },
  { qid: '???' },
]) });
assert.equal(r.upserted, 2);
assert.deepEqual(r.rejected.map((x) => x.reason), ['bad_canonical', 'bad_qid']);
const reg = DB.tables.question_index.find((x) => x.qid === 'a-123-456-789012');
assert.equal(reg.file_id, 'f9'); assert.equal(reg.kind, 'stable');
assert.equal(DB.tables.question_index.find((x) => x.qid === '5').canonical_qid, '6');
ok('the pipeline can push the registry (SYNC_KEY), including merge redirects; bad rows are rejected');

r = await call(S.adminqidcoverage, admin({ fileId: 'cdnFile' }));
assert.equal(r.coverage.mode, 'stable'); assert.equal(r.coverage.total, 2);
r = await call(S.adminqidcoverage, admin());
// 702 (re-registered), 900 (merged → 902), the pipeline's a-123-… and 5 (merged → 6)
assert.equal(r.questions, 4); assert.equal(r.stable, 4); assert.equal(r.merged, 2);
ok('admins can see how identity-ready a file / the whole bank is');

assert.ok(DB.tables.user_qstate.some((x) => x.username === 'dev'));
r = await call(U.resetmyprogress, as('dev', { confirm: 'RESET' }));
assert.equal(r.success, true);
assert.equal(DB.tables.user_qstate.filter((x) => x.username === 'dev').length, 0);
assert.equal(DB.tables.answer_events.filter((x) => x.username === 'dev').length, 0);
ok('"reset my progress" also clears notes, bookmarks, mistakes and the answer log');

// ═══════════════ SCHEMA CROSS-CHECK: every column the handlers wrote exists in the real migrations ═══════════════
const { PGlite } = await import('@electric-sql/pglite');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const db = new PGlite();
const migs = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
await db.exec(migs.map((f) => fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8')).join('\n'));
const { rows: colRows } = await db.query(`select table_name t, column_name c from information_schema.columns where table_schema='public'`);
const cols = {};
colRows.forEach((x) => (cols[x.t] ||= new Set()).add(x.c));
const unknown = [];
for (const t of ['question_index', 'user_qstate', 'answer_events', 'qid_stats', 'weekly_sets', 'weekly_attempts', 'correction_events']) {
  for (const row of DB.tables[t] || []) for (const k of Object.keys(row)) if (!cols[t].has(k) && !(t === 'correction_events' && k === 'id')) unknown.push(`${t}.${k}`);
}
assert.deepEqual([...new Set(unknown)], []);
ok('every column the new handlers write exists in the migrated Postgres schema');

console.log(`\nALL ${n} QID-CORE CHECKS PASSED`);
