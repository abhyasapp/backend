/* Neon half of admin report solving: look a question up by its public qn id and
   apply the correction there. The query function is injected so these tests
   exercise the handler without a database connection. */

import assert from 'node:assert/strict';
import { DB, reset } from './mock-supabase.mjs';

const N = await import('../../supabase/functions/api/handlers/neon.ts');
const { _setNeonQueryForTests } = await import('../../supabase/functions/api/_shared/neon.ts');
const { tokenHash } = await import('../../supabase/functions/api/_shared/crypto.ts');

const call = async (fn, params) => (await fn(params)).json();
let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);

reset();
DB.tables.admins = [{
  username: 'admin', role: 'owner', token: await tokenHash('admin-token'),
  token_expires: String(Date.now() + 3600000), must_change_password: 'false',
}];

const QN = '70024.730011';
const LEGACY = 53903;
const seen = [];
_setNeonQueryForTests(async (sql, params) => {
  seen.push({ sql, params });
  const known = params[0] === QN || params[0] === LEGACY;
  if (/update questions/.test(sql)) {
    if (!known) return [];
    return [{
      id: 41699, stable_qn_id: params[0] === LEGACY ? null : QN, correct_index: params[1],
      explanation: params[2], corrected_at: '2026-11-16T00:00:00.000Z',
      before_index: 1, before_explanation: '', audited: 1,
    }];
  }
  if (/from questions/.test(sql)) {
    if (!known) return [];
    return [{
      id: params[0] === LEGACY ? LEGACY : 41699,
      stable_qn_id: params[0] === LEGACY ? null : QN,
      question_text: 'The distance between terminal points',
      options: ['a', 'b', 'c', 'd'], correct_index: 1, correct_text: 'b',
      explanation: '', corrected_at: null,
    }];
  }
  return [];
});

/* An admin session is required: this writes to the content database. */
let r = await call(N.adminneonquestion, { qn: QN });
assert.equal(r.success, false);
assert.equal(r.sessionInvalid, true);
ok('a lookup without an admin session is refused');

r = await call(N.adminneoncorrect, { qn: QN, correctIndex: 2 });
assert.equal(r.success, false);
assert.equal(r.sessionInvalid, true);
ok('a correction without an admin session is refused');

const admin = { username: 'admin', adminToken: 'admin-token' };

r = await call(N.adminneonquestion, { ...admin, qn: 'not-a-qn' });
assert.equal(r.success, false);
assert.match(r.error, /70024\.730011/);
ok('a malformed qn is rejected before any query runs');

r = await call(N.adminneonquestion, { ...admin, qn: QN });
assert.equal(r.success, true);
assert.equal(r.found, true);
assert.equal(r.question.correctIndex, 1);
assert.equal(seen.at(-1).params[0], QN);
ok('the qn finds its question in Neon');

r = await call(N.adminneonquestion, { ...admin, qn: '70024.999999' });
assert.equal(r.success, true);
assert.equal(r.found, false);
ok('a qn Neon does not hold reports found:false, not an error');

r = await call(N.adminneoncorrect, { ...admin, qn: QN, correctIndex: 'e' });
assert.equal(r.success, false);
assert.match(r.error, /whole number/);
ok('a correction with an unparseable option is rejected');

r = await call(N.adminneoncorrect, { ...admin, qn: QN, correctIndex: 2, explanation: 'B holds the terminal points.' });
assert.equal(r.success, true);
assert.equal(r.after.correctIndex, 2);
assert.equal(r.after.qn, QN);
assert.equal(r.before.correctIndex, 1);
assert.equal(r.audited, 1);
const last = seen.at(-1);
assert.equal(last.params[0], QN);
assert.equal(last.params[1], 2);
assert.equal(last.params[2], 'B holds the terminal points.');
assert.match(last.sql, /update questions/);
assert.match(last.sql, /insert into applied_corrections/);
assert.match(last.sql, /stable_qn_id = \$1/);
ok('the correction updates the question and audits the old answer');

r = await call(N.adminneoncorrect, { ...admin, qn: QN, correctIndex: 0, uid: 'fileX_7', fileId: 'fileX' });
assert.equal(r.success, true);
assert.equal(seen.at(-1).params[3], 'fileX_7');
assert.equal(seen.at(-1).params[4], 'fileX');
ok('the audit row carries the uid and file the report came from');

r = await call(N.adminneoncorrect, { ...admin, qn: '70024.999999', correctIndex: 1 });
assert.equal(r.success, false);
assert.equal(r.notFound, true);
ok('correcting a qn Neon does not hold changes nothing and says so');

/* Reports written before the pipeline published public ids carry the older
   internal number, which is matched against questions.id instead. */
r = await call(N.adminneonquestion, { ...admin, qn: String(LEGACY) });
assert.equal(r.success, true);
assert.equal(r.found, true);
assert.equal(r.matchedBy, 'id');
assert.match(seen.at(-1).sql, /id = \$1::int/);
assert.equal(seen.at(-1).params[0], LEGACY);
ok('a legacy numeric id is matched against questions.id');

r = await call(N.adminneoncorrect, { ...admin, qn: String(LEGACY), correctIndex: 3 });
assert.equal(r.success, true);
assert.equal(r.matchedBy, 'id');
assert.equal(r.after.correctIndex, 3);
ok('a legacy numeric id can be corrected too');

console.log('\nNeon report corrections: all assertions passed');
