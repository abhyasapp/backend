import assert from 'node:assert/strict';
import { DB, reset } from './mock-supabase.mjs';
const R = await import('../../supabase/functions/api/handlers/reports.ts');
const { tokenHash } = await import('../../supabase/functions/api/_shared/crypto.ts');

const call = async (fn, params) => (await fn(params)).json();
let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);

reset();
process.env.SYNC_KEY = 'pipeline-test-key';
const at = '2026-11-14T10:00:00.000Z';
DB.tables.admins = [{
  username: 'admin', role: 'owner', token: await tokenHash('admin-token'),
  token_expires: String(Date.now() + 3600000), must_change_password: 'false',
}];
DB.tables.users = [{
  username: 'sita', session_token: await tokenHash('user-token'),
  session_token_expires_at: String(Date.now() + 3600000),
}];
DB.storage['subjective-content/fileA'] = JSON.stringify({
  questions: [
    { id: 48213, q: '13. Old stem', options: ['a', 'b'], correct: 0, explanation: '' },
    { id: 48214, q: '14. Other stem', options: ['c', 'd'], correct: 1, explanation: '' },
  ],
});

let r = await call(R.reportquestion, {
  username: 'sita', token: 'user-token', uid: 'fileA_0', qid: 48213,
  reason: 'wrong_answer', note: 'Option B is right.', questionSnapshot: '13. Old stem',
  optionsSnapshot: ['a', 'b'], correctIndex: 1, chosenIndex: 0,
});
assert.equal(r.success, true);
assert.equal(r.reportId, r.id);
assert.equal(DB.tables.question_reports[0].qid, '48213');
assert.equal(DB.tables.question_reports[0].file_id, 'fileA');
ok('reports store qid and return reportId');

r = await call(R.myquestionreports, { username: 'sita', token: 'user-token' });
assert.equal(r.success, true);
assert.equal(r.reports.length, 1);
assert.equal(r.reports[0].qid, '48213');
assert.equal(r.reports[0].status, 'open');
ok('myQuestionReports is scoped to the session user and exposes qid');

r = await call(R.adminapplycorrections, {
  username: 'admin', token: 'admin-token',
  items: JSON.stringify([
    {
      key: 'q48213', uid: 'fileA_0', qid: 48213, fileId: 'fileA', index: 0,
      reportId: r.reports[0].id, correctedAt: at, expectedQ: '13. Old stem',
      before: { question: '13. Old stem', options: ['a', 'b'] },
      after: { question: '13. New stem', options: ['a', 'b'], correctIndex: 1, explanation: 'Because.' },
      closeReport: true,
    },
    {
      key: 'q48214', uid: 'fileA_1', qid: 48214, fileId: 'fileA', index: 1,
      correctedAt: at, expectedQ: '14. Other stem',
      after: { question: '14. Better stem', options: ['c', 'd'], correctIndex: 0, explanation: '' },
    },
  ]),
});
assert.equal(r.success, true);
// Each result now also reports the question's NEW revision (the optimistic-concurrency token).
assert.ok(r.results.every((x) => /^[0-9a-f]{14}$/.test(x.rev)));
assert.deepEqual(r.results.map(({ rev, ...rest }) => rest), [{ key: 'q48213', ok: true, alsoClosed: 1 }, { key: 'q48214', ok: true }]);
let saved = JSON.parse(DB.storage['subjective-content/fileA']);
assert.equal(saved.questions[0].q, '13. New stem');
assert.equal(saved.questions[0].correct, 1);
assert.equal(saved.questions[1].q, '14. Better stem');
assert.equal(DB.tables.correction_events.length, 2);
assert.equal(DB.tables.correction_events[0].qid, '48213');
assert.equal(DB.tables.question_reports[0].status, 'resolved');
assert.equal(DB.tables.question_reports[0].corrected, 'true');
ok('batch applies both fixes, closes the report, and writes qid correction events');

r = await call(R.adminlistcorrectionevents, {
  username: 'admin', token: 'admin-token', fileId: 'fileA', limit: 10,
});
assert.equal(r.success, true);
assert.equal(r.events.length, 2);
const byQid = Object.fromEntries(r.events.map(e => [e.qid, e]));
assert.equal(byQid['48214'].fileId, 'fileA');
assert.equal(byQid['48214'].admin, 'admin');
assert.equal(byQid['48214'].before.question, '14. Other stem');
assert.equal(byQid['48214'].after.question, '14. Better stem');
ok('adminListCorrectionEvents returns the full event audit trail');

r = await call(R.adminlistcorrectionevents, {
  username: 'admin', token: 'admin-token', fileId: 'fileA', qid: 48213,
});
assert.equal(r.success, true);
assert.equal(r.events.length, 1);
assert.equal(r.events[0].qid, '48213');
ok('adminListCorrectionEvents can filter by stable qid');

r = await call(R.adminlistcorrectionevents, {
  username: 'sita', token: 'user-token', fileId: 'fileA',
});
assert.equal(r.success, false);
ok('adminListCorrectionEvents rejects a non-admin session');

DB.tables.question_reports.push({
  id: 'legacy-1', uid: 'fileA_1', qid: '', file_id: 'fileA', status: 'open',
  reason: 'wrong_answer', question_snapshot: '14. Better stem',
  options_snapshot: '["c","d"]', reported_by: 'sita', reported_at: at,
});
r = await call(R.adminbackfillreportqids, {
  username: 'admin', token: 'admin-token', apply: false,
});
assert.equal(r.success, true);
assert.equal(r.scanned, 1);
assert.equal(r.matched, 1);
assert.equal(r.applied, 0);
assert.equal(r.examples[0].qid, '48214');
assert.equal(DB.tables.question_reports.find(x => x.id === 'legacy-1').qid, '');
ok('the qid backfill previews a unique text match without writing');

r = await call(R.adminbackfillreportqids, {
  username: 'admin', token: 'admin-token', apply: true,
});
assert.equal(r.success, true);
assert.equal(r.applied, 1);
assert.equal(DB.tables.question_reports.find(x => x.id === 'legacy-1').qid, '48214');
assert.equal(DB.tables.question_reports.length, 2);
ok('the qid backfill writes only the matched report and deletes nothing');

// Drive-backed objective files are not in Supabase Storage; their public CDN
// mirror must be used or every legacy report is falsely counted as noFile.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('/content/drive-file.json')) {
    return { ok: true, json: async () => ({ questions: [{ id: 777, q: '15. Drive stem', options: ['x', 'y'], correct: 0 }] }) };
  }
  return { ok: false, json: async () => ({}) };
};
DB.tables.question_reports.push({
  id: 'legacy-drive', uid: 'drive-file_0', qid: '', file_id: 'drive-file', status: 'open',
  reason: 'wrong_answer', question_snapshot: '15. Drive stem',
  options_snapshot: '["x","y"]', reported_by: 'sita', reported_at: at,
});
r = await call(R.adminbackfillreportqids, {
  username: 'admin', token: 'admin-token', apply: false,
});
globalThis.fetch = nativeFetch;
assert.equal(r.success, true);
assert.equal(r.matched, 1);
assert.equal(r.noFile, 0);
assert.equal(r.examples[0].qid, '777');
ok('the qid backfill falls back to the CDN for Drive-backed chapter files');

r = await call(R.adminapplycorrections, {
  username: 'admin', token: 'admin-token',
  items: JSON.stringify([{
    key: 'q48213', uid: 'fileA_0', qid: 48213, fileId: 'fileA', index: 0,
    correctedAt: at, expectedQ: '13. New stem',
    after: { question: '13. Duplicate retry', options: ['a', 'b'], correctIndex: 1 },
  }]),
});
assert.deepEqual(r.results, [{ key: 'q48213', ok: true, duplicate: true }]);
assert.equal(DB.tables.correction_events.length, 2);
ok('a retry with the same correctedAt is idempotent');

r = await call(R.adminapplycorrections, {
  username: 'admin', token: 'admin-token',
  items: JSON.stringify([{
    key: 'q48213', uid: 'fileA_0', qid: null, fileId: 'fileA', index: 0,
    correctedAt: '2026-11-14T10:05:00.000Z', expectedQ: 'Stale text',
    after: { question: 'Should not save', options: ['a', 'b'], correctIndex: 1 },
  }]),
});
// The question at this position carries a stable id, so a position-only write is refused outright.
assert.equal(r.results[0].ok, false);
assert.equal(r.results[0].code, 'qid_required');
assert.equal(DB.tables.correction_events.length, 2);
assert.equal(JSON.parse(DB.storage['subjective-content/fileA']).questions[0].q, '13. New stem');
ok('a position-only write to a question with a stable id is refused (qid_required)');

// Legacy files whose questions have NO ids still use the expectedQ text guard.
DB.storage['subjective-content/legacyNoIds'] = JSON.stringify({ questions: [{ q: 'Old text', options: ['a', 'b'], correct: 0 }] });
r = await call(R.adminapplycorrections, {
  username: 'admin', token: 'admin-token',
  items: JSON.stringify([{
    key: 'legacy0', uid: 'legacyNoIds_0', fileId: 'legacyNoIds', index: 0,
    correctedAt: '2026-11-14T10:06:00.000Z', expectedQ: 'Stale text',
    after: { question: 'Should not save', options: ['a', 'b'], correctIndex: 1 },
  }]),
});
assert.equal(r.results[0].ok, false);
assert.equal(r.results[0].conflict, true);
assert.equal(DB.tables.correction_events.length, 2);
assert.equal(JSON.parse(DB.storage['subjective-content/legacyNoIds']).questions[0].q, 'Old text');
ok('a stale expectedQ is still refused for an id-less legacy question, without changing the file');

r = await call(R.synccorrectionssince, { key: 'pipeline-test-key', since: 0, limit: 500 });
assert.equal(r.success, true);
assert.equal(r.count, 2);
assert.equal(r.corrections[0].qid, '48213');
assert.equal(r.corrections[1].qid, '48214');
assert.equal(r.corrections[0].after.question, '13. New stem');
ok('syncCorrectionsSince emits qid-bearing events for Drive -> Neon');

r = await call(R.synccorrectionssince, { key: 'pipeline-test-key', since: Date.parse(at), limit: 500 });
assert.equal(r.success, true);
assert.equal(r.count, 0);
ok('syncCorrectionsSince treats the watermark as exclusive');

r = await call(R.synccorrectionssince, { key: 'wrong', since: 0 });
assert.equal(r.success, false);
assert.equal(r.code, 'unauthorized');
ok('the pipeline endpoint still requires SYNC_KEY');

// Closing a report as "no change needed" must not tell the student their
// question was corrected. The admin can resolve a report without touching
// the question file, so only correctedMine may drive the "corrected" toast.
DB.tables.question_reports.push({
  id: 'reviewed-only', uid: 'fileA_1', qid: '48214', file_id: 'fileA', status: 'open',
  reason: 'unclear', question_snapshot: '14. Better stem',
  options_snapshot: '["c","d"]', reported_by: 'sita', reported_at: at,
});
r = await call(R.adminupdatequestionreportstatus, {
  username: 'admin', token: 'admin-token', id: 'reviewed-only', status: 'resolved', corrected: false,
});
assert.equal(r.success, true);
r = await call(R.getcorrections, { username: 'sita', token: 'user-token', since: 0 });
assert.equal(r.success, true);
const reviewed = r.resolvedMine.find(x => x.uid === 'fileA_1');
assert.equal(reviewed.corrected, false);
assert.equal(r.correctedMine.some(x => x.uid === 'fileA_1'), false);
assert.equal(r.correctedMine.some(x => x.uid === 'fileA_0'), true);
ok('a no-change resolution is not reported to the student as a correction');

// A hyphenated public qid cannot survive Number(): it becomes NaN, and JSON
// writes NaN as null, so the pipeline used to receive a correction with no id.
// Every response must carry the canonical lowercase string instead.
const hyphenQid = 'a-123-456-789012';
DB.storage['subjective-content/fileB'] = JSON.stringify({
  questions: [{ id: hyphenQid, q: '16. Hyphenated stem', options: ['p', 'q'], correct: 0, explanation: '' }],
});
r = await call(R.reportquestion, {
  username: 'sita', token: 'user-token', uid: 'fileB_0', qid: hyphenQid,
  reason: 'typo', note: 'id check', questionSnapshot: '16. Hyphenated stem',
  optionsSnapshot: ['p', 'q'], correctIndex: 0, chosenIndex: 1,
});
assert.equal(r.success, true);
assert.equal(DB.tables.question_reports.find(x => x.uid === 'fileB_0').qid, hyphenQid);
r = await call(R.myquestionreports, { username: 'sita', token: 'user-token' });
assert.equal(r.reports.find(x => x.uid === 'fileB_0').qid, hyphenQid);
r = await call(R.adminapplycorrections, {
  username: 'admin', token: 'admin-token',
  items: JSON.stringify([{
    key: 'q' + hyphenQid, uid: 'fileB_0', qid: hyphenQid, fileId: 'fileB', index: 0,
    correctedAt: '2026-11-14T11:00:00.000Z', expectedQ: '16. Hyphenated stem',
    after: { question: '16. Hyphenated fixed', options: ['p', 'q'], correctIndex: 1 },
    closeReport: true,
  }]),
});
assert.equal(r.success, true);
assert.equal(r.results[0].ok, true);
r = await call(R.adminlistcorrectionevents, {
  username: 'admin', token: 'admin-token', fileId: 'fileB', qid: hyphenQid,
});
assert.equal(r.events.length, 1);
assert.equal(r.events[0].qid, hyphenQid);
r = await call(R.synccorrectionssince, { key: 'pipeline-test-key', since: 0, limit: 500 });
const hyphenSynced = r.corrections.filter(c => c.fileId === 'fileB');
assert.equal(hyphenSynced.length, 1);
assert.equal(hyphenSynced[0].qid, hyphenQid);
ok('a hyphenated qid survives reports, correction events and the correction sync');

// A report filed again for the same question after a reorder must dedupe on the
// stable id, not on the position it used to sit at.
r = await call(R.reportquestion, {
  username: 'sita', token: 'user-token', uid: 'fileA_1', qid: 48214,
  reason: 'unclear', note: 'first filing', questionSnapshot: '14. Better stem',
  optionsSnapshot: ['c', 'd'], correctIndex: 0, chosenIndex: 1,
});
assert.equal(r.success, true);
assert.equal(r.deduped, undefined);
r = await call(R.reportquestion, {
  username: 'sita', token: 'user-token', uid: 'fileA_9', qid: 48214,
  reason: 'unclear', note: 'after reorder', questionSnapshot: '14. Better stem',
  optionsSnapshot: ['c', 'd'], correctIndex: 0, chosenIndex: 1,
});
assert.equal(r.deduped, true);
ok('a re-filed report dedupes by qid, not by its old position');

// The public qn id is matched in canonical form and by id, so an uppercase id
// with a stale position still opens the right question.
r = await call(R.admingetquestion, {
  username: 'admin', token: 'admin-token', fileId: 'fileB', index: 5, qid: 'A-123-456-789012',
});
assert.equal(r.success, true);
assert.equal(r.index, 0);
assert.equal(r.qid, 'a-123-456-789012');
ok('a public qn id resolves by id, case-insensitively, ignoring the position');

// The ids actually published in abhyasapp/content are "<fileId>-<position>"
// (e.g. "1-VeNF…-1") and the files are top-level arrays. The old qidString()
// rejected every one of them, so real reports stored qid '' and fell back to
// the position. They must round-trip, and a correction must write the
// explanation into the field the file already uses (`explain`).
const realQid = '1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1';
DB.storage['subjective-content/fileC'] = JSON.stringify([
  { id: realQid, q: '901. Real content shape', options: ['a', 'b'], correct: 0, explain: 'old text' },
]);
r = await call(R.reportquestion, {
  username: 'sita', token: 'user-token', uid: 'fileC_0', qid: realQid,
  reason: 'wrong_answer', note: 'real id', questionSnapshot: '901. Real content shape',
  optionsSnapshot: ['a', 'b'], correctIndex: 1, chosenIndex: 0,
});
assert.equal(r.success, true);
assert.equal(DB.tables.question_reports.find(x => x.uid === 'fileC_0').qid, realQid);
r = await call(R.adminapplycorrections, {
  username: 'admin', token: 'admin-token',
  items: JSON.stringify([{
    key: 'q' + realQid, uid: 'fileC_0', qid: realQid, fileId: 'fileC', index: 0,
    correctedAt: '2026-11-14T12:00:00.000Z', expectedQ: '901. Real content shape',
    after: { question: '901. Real content fixed', options: ['a', 'b'], correctIndex: 1, explanation: 'new text' },
    closeReport: true,
  }]),
});
assert.equal(r.success, true);
assert.equal(r.results[0].ok, true);
const fileC = JSON.parse(DB.storage['subjective-content/fileC']);
assert.equal(fileC[0].q, '901. Real content fixed');
assert.equal(fileC[0].explain, 'new text');
assert.equal(fileC[0].explanation, undefined);
ok('a published "<fileId>-<n>" qid round-trips and updates the existing explain field');

// Reporting keys a question by its stable qid, so the same question answered
// from two different positions (after a reorder) is one row, not two. A blob
// with no qid must still be counted by uid, and a corrupt blob must not throw.
DB.tables.progress = [
  { username: 'sita', data: JSON.stringify({ prog: { sessions: [{ qres: [
    { uid: 'fileA_0', qid: 48213, ok: false },
    { uid: 'fileA_1', qid: 48213, ok: true },
    { uid: 'fileA_2', ok: false },
  ] }] } }) },
  { username: 'ram', data: 'gz1:not-really-gzip' },
];
r = await call(R.adminmostmissedquestions, { username: 'admin', token: 'admin-token', minAttempts: 1 });
assert.equal(r.success, true);
const byId = Object.fromEntries(r.results.map(x => [x.id, x]));
assert.equal(byId['48213'].total, 2);
assert.equal(byId['48213'].wrong, 1);
assert.equal(byId['48213'].qid, '48213');
assert.equal(byId['48213'].fileId, 'fileA');
assert.equal(byId['fileA_2'].qid, '');
assert.equal(byId['fileA_2'].fileId, 'fileA');
ok('most-missed questions merge a question by qid across positions');

// The pipeline publishes public qn ids that carry letters and a dot
// ("G0011.110001" for General Knowledge, "5002mixedqn10001" for a word
// subtopic). These were rejected by the old pattern, so such a report lost its
// qid and fell back to the position. They must be stored, lowercased.
DB.storage['subjective-content/fileD'] = JSON.stringify({
  questions: [{ id: 'G0011.110001', q: '1. GK stem', options: ['a', 'b'], correct: 0 }],
});
r = await call(R.reportquestion, {
  username: 'sita', token: 'user-token', uid: 'fileD_0', qid: 'G0011.110001',
  reason: 'typo', note: '', questionSnapshot: '1. GK stem',
});
assert.equal(r.success, true);
const gkRows = DB.tables.question_reports.filter(x => x.qid === 'g0011.110001');
assert.equal(gkRows.length, 1, 'a dotted public qn id is stored, lowercased');
assert.equal(gkRows[0].file_id, 'fileD');
ok('a published dotted public qn id is stored instead of the position');

r = await call(R.reportquestion, {
  username: 'sita', token: 'user-token', uid: 'fileD_0', qid: '5002mixedqn10001',
  reason: 'typo', note: '', questionSnapshot: '1. GK stem',
});
assert.equal(r.success, true);
assert.equal(
  DB.tables.question_reports.some(x => x.qid === '5002mixedqn10001'), true,
  'a word-subtopic public qn id is stored too');
ok('a published word-subtopic public qn id is stored');

console.log(`\nALL ${n} REPORT/CORRECTION CHECKS PASSED`);
