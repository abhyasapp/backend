// Pure tests for _shared/qid.ts and _shared/weekly-score.ts.
// The invariant under test: a question's identity, revision and score never depend on its position.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQid, qidString, qidKind, flattenQuestions, primaryQid, allQids, correctOf, questionRev, fileRev,
  buildQidIndex, qidCoverage, questionIndexFor, positionWriteAllowed, resolveCanonical, hash53,
} from '../supabase/functions/api/_shared/qid.ts';
import { scoreWeekly, parseAnswersByQid } from '../supabase/functions/api/_shared/weekly-score.ts';

const Q = (id, q, correct = 0, extra = {}) => ({ id, q, options: ['a', 'b', 'c', 'd'], correct, ...extra });
const paper = () => [Q(101, 'one', 0), Q(102, 'two', 1), Q(103, 'three', 2), Q(104, 'four', 3)];
const shuffled = (a) => [a[2], a[0], a[3], a[1]];

test('qid kinds: numeric/public are stable, "<fileId>-<n>" is positional', () => {
  assert.deepEqual(parseQid(' 48213 '), { qid: '48213', kind: 'stable' });
  assert.deepEqual(parseQid('A-123-456-789012'), { qid: 'a-123-456-789012', kind: 'stable' });
  assert.deepEqual(parseQid('50011.110001'), { qid: '50011.110001', kind: 'stable' });
  assert.deepEqual(parseQid('5002mixedqn10001'), { qid: '5002mixedqn10001', kind: 'stable' });
  assert.deepEqual(parseQid('1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1'), { qid: '1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1', kind: 'positional' });
  assert.equal(qidKind('1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1'), 'positional');
  assert.deepEqual(parseQid(''), { qid: '', kind: '' });
  assert.deepEqual(parseQid('abc'), { qid: '', kind: '' });
  assert.equal(qidString(null), '');
});

test('a stable id on any field beats a positional id on another', () => {
  const q = { id: '1-FILEID-7', public_qn: '50011.110001' };
  assert.deepEqual(primaryQid(q), { qid: '50011.110001', kind: 'stable' });
  assert.deepEqual(allQids(q).sort(), ['1-FILEID-7', '50011.110001'].sort());
  // either id finds the question
  const arr = [Q(1, 'x'), q];
  assert.equal(questionIndexFor(arr, 0, '50011.110001'), 1);
  assert.equal(questionIndexFor(arr, 0, '1-FILEID-7'), 1);
});

test('one traversal order everywhere: questions|data|quiz|items first, sections only as a fallback', () => {
  const both = { questions: [Q(1, 'a')], sections: [{ questions: [Q(2, 'b'), Q(3, 'c')] }] };
  assert.deepEqual(flattenQuestions(both).map((q) => q.id), [1]);
  const onlySections = { sections: [{ questions: [Q(2, 'b')] }, { questions: [Q(3, 'c')] }] };
  assert.deepEqual(flattenQuestions(onlySections).map((q) => q.id), [2, 3]);
  assert.deepEqual(flattenQuestions([Q(9, 'z')]).map((q) => q.id), [9]);
  assert.deepEqual(flattenQuestions(null), []);
});

test('revisions: reorder-invariant, edit-sensitive', () => {
  const a = paper();
  assert.equal(fileRev(a), fileRev(shuffled(a)));                 // position is not part of identity
  const edited = paper(); edited[1].q = 'two (fixed)';
  assert.notEqual(fileRev(a), fileRev(edited));
  assert.notEqual(questionRev(a[1]), questionRev(edited[1]));
  assert.equal(questionRev(a[0]), questionRev(edited[0]));         // untouched question keeps its rev
  const answerFlip = paper(); answerFlip[0].correct = 1;
  assert.notEqual(questionRev(a[0]), questionRev(answerFlip[0]));
  assert.equal(hash53('x').length, 14);
});

test('coverage modes and duplicate detection', () => {
  assert.equal(qidCoverage(paper()).mode, 'stable');
  assert.equal(qidCoverage([Q(1, 'a'), { q: 'no id', options: ['a', 'b'], correct: 0 }]).mode, 'partial');
  assert.equal(qidCoverage([{ q: 'x' }, { q: 'y' }]).mode, 'positional');
  const dup = qidCoverage([Q(1, 'a'), Q(1, 'b')]);
  assert.deepEqual(dup.duplicates, ['1']);
  assert.equal(dup.mode, 'partial');
  const pos = qidCoverage([{ id: 'F-1', q: 'a' }, { id: 'F-2', q: 'b' }]);
  assert.equal(pos.positional, 2);
  assert.equal(pos.mode, 'positional');
});

test('position writes are only allowed for questions with no stable id', () => {
  const arr = [Q(5, 'has id'), { q: 'no id', options: ['a', 'b'], correct: 0 }, { id: 'F-3', q: 'positional id' }];
  assert.equal(positionWriteAllowed(arr, 0), false);
  assert.equal(positionWriteAllowed(arr, 1), true);
  assert.equal(positionWriteAllowed(arr, 2), true);
  assert.equal(positionWriteAllowed(arr, 9), false);
});

test('registry index lists qids with derived (informational) positions', () => {
  const rows = buildQidIndex(shuffled(paper()));
  assert.deepEqual(rows.map((r) => [r.qid, r.ord]), [['103', 0], ['101', 1], ['104', 2], ['102', 3]]);
});

test('canonical redirects are followed, loop-safe and depth-bounded', () => {
  const m = new Map([['1', '2'], ['2', '3'], ['9', '9'], ['7', '8'], ['8', '7']]);
  assert.equal(resolveCanonical('1', m), '3');
  assert.equal(resolveCanonical('9', m), '9');
  assert.ok(['7', '8'].includes(resolveCanonical('7', m)));        // cycle terminates
  assert.equal(resolveCanonical('5', m), '5');
});

test('correctOf maps letters and keeps numbers', () => {
  assert.equal(correctOf({ correct: 2 }), 2);
  assert.equal(correctOf({ answer: 'C' }), 2);
  assert.equal(correctOf({ ans: 'b' }), 1);
  assert.equal(correctOf({}), undefined);
});

// ───────────────────────── weekly scoring ─────────────────────────

test('qid scoring: right answers counted by id, unanswered are skipped', () => {
  const r = scoreWeekly({ raw: paper(), answersByQid: { 101: 0, 102: 0, 103: 2 } });   // 104 unanswered
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'qid');
  assert.equal(r.total, 4); assert.equal(r.correct, 2); assert.equal(r.skipped, 1);
  assert.deepEqual(r.answersByQid, { 101: 0, 102: 0, 103: 2, 104: null });
});

test('REORDER INVARIANCE: shuffling the file never changes a qid-scored result', () => {
  const answers = { 101: 0, 102: 1, 103: 0, 104: null };
  const a = scoreWeekly({ raw: paper(), answersByQid: answers });
  const b = scoreWeekly({ raw: shuffled(paper()), answersByQid: answers });
  const c = scoreWeekly({ raw: { sections: [{ questions: shuffled(paper()).reverse() }] }, answersByQid: answers });
  for (const x of [b, c]) { assert.equal(x.correct, a.correct); assert.equal(x.total, a.total); assert.equal(x.skipped, a.skipped); assert.equal(x.fileRev, a.fileRev); }
  assert.equal(a.correct, 2);
});

test('an answers payload in array form is equivalent; duplicates and bad ids are rejected', () => {
  const ok = scoreWeekly({ raw: paper(), answersByQid: [{ q: 101, a: 0 }, { qid: '102', answer: 1 }] });
  assert.equal(ok.correct, 2);
  assert.equal(scoreWeekly({ raw: paper(), answersByQid: [{ q: 101, a: 0 }, { q: 101, a: 1 }] }).code, 'duplicate_qid');
  assert.equal(scoreWeekly({ raw: paper(), answersByQid: { 'zzz': 1 } }).code, 'bad_qid');
  assert.equal(scoreWeekly({ raw: paper(), answersByQid: { 999: 1 } }).code, 'unknown_qid');
  assert.equal(parseAnswersByQid('not json').ok, false);
});

test('frozen paper: a removed question is voided, a question added later is ignored', () => {
  const frozen = ['101', '102', '103', '104'];
  const now = [Q(101, 'one', 0), Q(103, 'three', 2), Q(104, 'four', 3), Q(105, 'NEW', 0)];   // 102 removed, 105 added
  const r = scoreWeekly({ raw: now, frozenQids: frozen, answersByQid: { 101: 0, 102: 1, 103: 2, 104: 0 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.voided, ['102']);
  assert.equal(r.total, 3);                                  // 102 no longer counts
  assert.equal(r.correct, 2);                                // 101, 103 right; 104 wrong
  assert.ok(!('105' in r.answersByQid));                     // never part of this paper
  assert.ok(r.warnings.some((w) => /voided/.test(w)));
});

test('a question with no answer key is voided, never silently counted wrong', () => {
  const raw = [Q(1, 'ok', 0), { id: 2, q: 'no key', options: ['a', 'b'] }];
  const r = scoreWeekly({ raw, answersByQid: { 1: 0, 2: 1 } });
  assert.deepEqual(r.voided, ['2']);
  assert.equal(r.total, 1); assert.equal(r.correct, 1);
});

test('legacy positional payload is mapped through the file order and reorder-proof afterwards', () => {
  const raw = paper();
  const r = scoreWeekly({ raw, answers: [0, 1, 2, 3] });
  assert.equal(r.correct, 4);
  assert.deepEqual(r.answersByQid, { 101: 0, 102: 1, 103: 2, 104: 3 });   // stored qid-keyed from now on
  // The same positional array against a file the client downloaded in a different order:
  const r2 = scoreWeekly({ raw: shuffled(raw), answers: [2, 0, 3, 1] });   // 103,101,104,102 → all right
  assert.equal(r2.correct, 4);
  assert.equal(scoreWeekly({ raw, answers: [0, 1] }).code, 'count_mismatch');
});

test('a paper without unique ids is scored by position (legacy) and refuses a qid payload', () => {
  const raw = [{ q: 'a', options: ['x', 'y'], correct: 0 }, { q: 'b', options: ['x', 'y'], correct: 1 }];
  const r = scoreWeekly({ raw, answers: [0, 0] });
  assert.equal(r.ok, true); assert.equal(r.mode, 'positional'); assert.equal(r.correct, 1);
  assert.equal(scoreWeekly({ raw, answersByQid: { 1: 0 } }).code, 'paper_not_qid_ready');
  assert.equal(scoreWeekly({ raw: [Q(1, 'a'), Q(1, 'b')], answers: [0, 0] }).mode, 'positional');   // duplicate ids → not qid-ready
});

test('degenerate inputs fail closed', () => {
  assert.equal(scoreWeekly({ raw: [], answers: [0] }).code, 'no_questions');
  assert.equal(scoreWeekly({ raw: paper(), answers: 'not json' }).ok, false);
  assert.equal(scoreWeekly({ raw: paper(), answers: [] }).ok, false);
  assert.equal(scoreWeekly({ raw: [Q(1, 'a', undefined)].map((q) => ({ ...q, correct: undefined })), answersByQid: { 1: 0 } }).code, 'empty_paper');
});
