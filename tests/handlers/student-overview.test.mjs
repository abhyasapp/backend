import assert from 'node:assert/strict';

// The fixtures below are dated November 2026 and the handler flags students who have been inactive
// for 7+ days, measured with Date.now(). Pin the clock to the day after the fixtures' last activity so
// this test cannot start failing just because the real date moves on (it did, on 2026-11-18).
const PINNED_NOW = Date.parse('2026-11-12T12:00:00.000Z');
Date.now = () => PINNED_NOW;
import { DB, reset } from './mock-supabase.mjs';
const A = await import('../../supabase/functions/api/handlers/admin.ts');
const { tokenHash } = await import('../../supabase/functions/api/_shared/crypto.ts');

const call = async (params) => (await A.admingetstudentoverview(params)).json();
let n = 0;
const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);

const gzipProgress = async (obj) => {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return 'gz1:' + Buffer.from(bytes).toString('base64');
};

reset();
const token = 'overview-admin-token';
DB.tables.admins = [{
  username: 'admin',
  role: 'owner',
  token: await tokenHash(token),
  token_expires: String(Date.now() + 3600000),
  must_change_password: 'false',
}];
DB.tables.users = [{
  username: 'sita',
  status: 'trial',
  trial_expires_at: '2099-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
}];
DB.tables.progress = [{
  username: 'sita',
  updated_at: '2026-11-10T12:00:00.000Z',
  data: await gzipProgress({
    prog: {
      total: 100,
      correct: 62,
      sessions: [
        { at: Date.parse('2026-11-10T10:00:00Z'), total: 20, correct: 15, durationSec: 600, mode: 'practice', chapter: 'Algebra' },
        { at: Date.parse('2026-11-09T10:00:00Z'), total: 10, correct: 3, durationSec: 300, mode: 'exam', chapter: 'Fractions' },
      ],
    },
    chapStats: {
      Algebra: { attempted: 20, correct: 16 },
      Fractions: { attempted: 10, correct: 3 },
      Geometry: { attempted: 2, correct: 0 },
    },
    stk: { days: ['2026-11-10', '2026-11-09'], last: '2026-11-10' },
  }),
}];
DB.tables.question_reports = [
  { id: 'r1', reported_by: 'sita', status: 'resolved', reason: 'Typo', question_snapshot: 'Q1', reported_at: '2026-11-10T09:00:00.000Z' },
  { id: 'r2', reported_by: 'sita', status: 'open', reason: 'Wrong answer', question_snapshot: 'Q2', reported_at: '2026-11-11T09:00:00.000Z' },
  { id: 'other', reported_by: 'ram', status: 'open', reason: 'Other', question_snapshot: 'Q3', reported_at: '2026-11-12T09:00:00.000Z' },
];
DB.tables.subjective_submissions = [
  { id: 's1', username: 'sita', status: 'graded', submitted_at: '2026-11-08T09:00:00.000Z' },
  { id: 's2', username: 'sita', status: 'graded', submitted_at: '2026-11-09T09:00:00.000Z' },
  { id: 's3', username: 'sita', status: 'pending', submitted_at: '2026-11-10T09:00:00.000Z' },
];
DB.tables.weekly_attempts = [
  { username: 'sita', weekly_id: 'w1', submitted_at: '2026-11-07T09:00:00.000Z', duration_sec: '120' },
];

let r = await call({ username: 'admin', token, targetUsername: 'sita' });
assert.equal(r.success, true);
assert.equal(r.study.questionsAnswered, 100);
assert.equal(r.study.accuracy, 62);
assert.equal(r.study.minutes, 15);
assert.equal(r.study.mockPapers, 1);
assert.equal(r.study.lastActiveAt, '2026-11-11T09:00:00.000Z');
assert.deepEqual(r.study.weakChapters, [
  { name: 'Fractions', accuracy: 30, attempted: 10 },
]);
assert.equal(r.reports.open, 1);
assert.equal(r.reports.total, 2);
assert.equal(r.reports.recent[0].id, 'r2');
assert.equal(r.submissions.total, 3);
assert.equal(r.submissions.graded, 2);
assert.equal(r.submissions.pending, 1);
assert.equal(r.risk.level, 'ok');
assert.deepEqual(r.risk.reasons, []);
ok('aggregates gzip progress, weak chapters, reports, submissions and activity');

DB.tables.users.push({
  username: 'newbie', status: 'active', permanent_access: 'true', created_at: '2026-11-13T00:00:00.000Z',
});
r = await call({ username: 'admin', token, targetUsername: 'newbie' });
assert.equal(r.success, true);
assert.deepEqual(r.reports, { open: 0, total: 0, recent: [] });
assert.deepEqual(r.submissions, { pending: 0, graded: 0, total: 0 });
assert.equal(r.study.questionsAnswered, 0);
assert.equal(r.study.accuracy, null);
assert.equal(r.study.streakDays, 0);
assert.equal(r.study.minutes, 0);
assert.equal(r.study.mockPapers, 0);
assert.deepEqual(r.study.weakChapters, []);
assert.equal(r.study.lastActiveAt, '');
assert.equal(r.risk.level, 'high');
ok('a brand-new student gets zeroed study/report/submission data, not an error');

r = await call({ username: 'admin', token, targetUsername: 'missing' });
assert.equal(r.success, false);
assert.match(r.error, /not found/i);
r = await call({ username: 'admin', token });
assert.equal(r.success, false);
assert.match(r.error, /target/i);
ok('missing target and unknown student are rejected');

DB.tables.admins.push({
  username: 'viewer', role: 'admin', token: await tokenHash('viewer-token'),
  token_expires: String(Date.now() + 3600000), must_change_password: 'false',
});
r = await call({ username: 'viewer', token: 'viewer-token', targetUsername: 'sita' });
assert.equal(r.success, false);
assert.equal(r.forbidden, true);
r = await call({ username: 'admin', token: 'wrong', targetUsername: 'sita' });
assert.equal(r.success, false);
assert.equal(r.sessionInvalid, true);
ok('overview requires users_view and a valid admin session');

console.log(`\nALL ${n} STUDENT 360 CHECKS PASSED`);
