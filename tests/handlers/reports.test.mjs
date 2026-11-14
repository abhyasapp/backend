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
assert.equal(r.reports[0].qid, 48213);
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
assert.deepEqual(r.results, [{ key: 'q48213', ok: true, alsoClosed: 1 }, { key: 'q48214', ok: true }]);
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
assert.equal(byQid[48214].fileId, 'fileA');
assert.equal(byQid[48214].admin, 'admin');
assert.equal(byQid[48214].before.question, '14. Other stem');
assert.equal(byQid[48214].after.question, '14. Better stem');
ok('adminListCorrectionEvents returns the full event audit trail');

r = await call(R.adminlistcorrectionevents, {
  username: 'admin', token: 'admin-token', fileId: 'fileA', qid: 48213,
});
assert.equal(r.success, true);
assert.equal(r.events.length, 1);
assert.equal(r.events[0].qid, 48213);
ok('adminListCorrectionEvents can filter by stable qid');

r = await call(R.adminlistcorrectionevents, {
  username: 'sita', token: 'user-token', fileId: 'fileA',
});
assert.equal(r.success, false);
ok('adminListCorrectionEvents rejects a non-admin session');

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
    key: 'q48213', uid: 'fileA_0', qid: 48213, fileId: 'fileA', index: 0,
    correctedAt: '2026-11-14T10:05:00.000Z', expectedQ: 'Stale text',
    after: { question: 'Should not save', options: ['a', 'b'], correctIndex: 1 },
  }]),
});
assert.equal(r.results[0].ok, false);
assert.equal(r.results[0].conflict, true);
assert.equal(DB.tables.correction_events.length, 2);
assert.equal(JSON.parse(DB.storage['subjective-content/fileA']).questions[0].q, '13. New stem');
ok('a stale expectedQ is refused without changing the file');

r = await call(R.synccorrectionssince, { key: 'pipeline-test-key', since: 0, limit: 500 });
assert.equal(r.success, true);
assert.equal(r.count, 2);
assert.equal(r.corrections[0].qid, 48213);
assert.equal(r.corrections[1].qid, 48214);
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

console.log(`\nALL ${n} REPORT/CORRECTION CHECKS PASSED`);
