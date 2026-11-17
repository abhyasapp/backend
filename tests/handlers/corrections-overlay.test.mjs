// corrections-overlay.test.mjs — a correction must be visible on the next request.
// Objective files are read-only mirrors of the Drive export, so before this the fix
// only appeared after the pipeline re-exported the file (hours, or never for a file
// the CDN had cached). Every read now replays the correction log over the questions.
import assert from 'node:assert/strict';
import { DB, reset } from './mock-supabase.mjs';

const R = await import('../../supabase/functions/api/handlers/reports.ts');
const C = await import('../../supabase/functions/api/handlers/content.ts');
const { tokenHash } = await import('../../supabase/functions/api/_shared/crypto.ts');

const call = async (fn, params) => (await fn(params, new Request('http://x'))).json();
let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);

reset();
DB.tables.admins = [{
  username: 'admin', role: 'owner', token: await tokenHash('admin-token'),
  token_expires: String(Date.now() + 3600000), must_change_password: 'false',
}];
DB.tables.users = [{
  username: 'sita', session_token: await tokenHash('user-token'),
  session_token_expires_at: String(Date.now() + 3600000), status: 'active',
}];

const qid = '1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1';
const fileId = 'fileD';
DB.storage['subjective-content/' + fileId] = JSON.stringify([
  { id: qid, q: '901. Exported stem', options: ['a', 'b', 'c'], correct: 0, explain: 'old text' },
  { id: '1-VeNFb81ynETihERKfWNUOZSqrYopyOH-2', q: '902. Untouched', options: ['a', 'b'], correct: 1, explain: '' },
]);

// Two edits of the same question: the newest must win.
DB.tables.correction_events = [
  {
    id: '1', dedupe_key: 'q' + qid, uid: 'q' + qid, qid, file_id: fileId,
    corrected_at: '2026-11-14T10:00:00.000Z',
    after: JSON.stringify({ question: '901. First correction', options: ['a', 'b', 'c'], correctIndex: 2, explanation: 'first' }),
  },
  {
    id: '2', dedupe_key: 'q' + qid, uid: 'q' + qid, qid, file_id: fileId,
    corrected_at: '2026-11-15T10:00:00.000Z',
    after: JSON.stringify({ question: '901. Corrected stem', options: ['a', 'b', 'c'], correctIndex: 1, explanation: 'Because B is right.' }),
  },
];

// 1. The quiz reads getfile — the corrected text comes back, no re-export needed.
let r = await call(C.getfile, { username: 'admin', adminToken: 'admin-token', fileId: 'subjective-content/' + fileId });
assert.equal(r.success, true);
assert.equal(r.result[0].q, '901. Corrected stem');
assert.equal(r.result[0].correct, 1);
assert.equal(r.result[0].explain, 'Because B is right.');
assert.equal(r.result[1].q, '902. Untouched', 'a question without a correction must be untouched');
assert.equal(r.result[1].correct, 1);
ok('getfile serves the latest correction without a re-export');

// The legacy `content` string must not still carry the old text.
assert.ok(String(r.content).includes('901. Corrected stem'));
assert.ok(!String(r.content).includes('901. Exported stem'));
ok('the legacy content string carries the correction too');

// 2. A student sees the same corrected question.
r = await call(C.getfile, { username: 'sita', token: 'user-token', fileId: 'subjective-content/' + fileId });
assert.equal(r.success, true);
assert.equal(r.result[0].q, '901. Corrected stem');
ok('a student sees the correction');

// 3. The admin console shows the corrected question, so a second edit starts from it.
r = await call(R.admingetquestion, { username: 'admin', token: 'admin-token', fileId, index: 0, qid });
assert.equal(r.success, true);
assert.equal(r.question.q, '901. Corrected stem');
assert.equal(r.question.correct, 1);
assert.equal(r.question.explanation, 'Because B is right.');
ok('admingetquestion shows the corrected question');

// 4. A correction for a qid that is not in this file changes nothing.
DB.tables.correction_events.push({
  id: '3', dedupe_key: 'qother', uid: 'qother', qid: '70024.730011', file_id: 'anotherFile',
  corrected_at: '2026-11-16T10:00:00.000Z',
  after: JSON.stringify({ question: 'not in this file' }),
});
r = await call(C.getfile, { username: 'admin', adminToken: 'admin-token', fileId: 'subjective-content/' + fileId });
assert.equal(r.result.length, 2);
assert.equal(r.result[1].q, '902. Untouched');
ok('a correction for another file does not leak in');

// 5. With no events the published text is returned unchanged.
DB.tables.correction_events = [];
r = await call(C.getfile, { username: 'admin', adminToken: 'admin-token', fileId: 'subjective-content/' + fileId });
assert.equal(r.result[0].q, '901. Exported stem');
assert.equal(r.result[0].correct, 0);
ok('with no correction events the published file is unchanged');
