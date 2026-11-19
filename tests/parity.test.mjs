// Parity: the TypeScript core (Supabase Edge Function) and the Apps Script core (gas/qid-core.gs)
// must derive the SAME qid, revision, index, coverage and weekly score from the same content.
// Hand-written edge cases + seeded fuzzing. A difference here means the two backends would
// disagree about which question is which, or about a student's score.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../supabase/functions/api/_shared/qid.ts';
import * as TW from '../supabase/functions/api/_shared/weekly-score.ts';
import * as TQ from '../supabase/functions/api/_shared/qstate-core.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ctx = vm.createContext({ console, Math, JSON, Object, Array, String, Number, isFinite });
vm.runInContext(fs.readFileSync(path.join(here, '..', 'gas', 'qid-core.gs'), 'utf8'), ctx);
const G = (name) => vm.runInContext(name, ctx);
const norm = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));   // drop cross-realm prototypes

// ── seeded PRNG so a failure is reproducible ──
let seed = 20261117;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const ID_SHAPES = [
  () => String(1000 + Math.floor(rnd() * 90000)),
  () => Math.floor(rnd() * 90000) + 1000,
  () => `A-${100 + Math.floor(rnd() * 800)}-${100 + Math.floor(rnd() * 800)}-${100000 + Math.floor(rnd() * 800000)}`,
  () => `${5000 + Math.floor(rnd() * 900)}.${110000 + Math.floor(rnd() * 9000)}`,
  () => `G${String(Math.floor(rnd() * 999)).padStart(4, '0')}.${110000 + Math.floor(rnd() * 9000)}`,
  () => `5002mixedqn${10000 + Math.floor(rnd() * 9000)}`,
  () => `1-VeNFb81ynETihERKfWNUOZSqrYopyOH-${Math.floor(rnd() * 300)}`,
  () => `Q_${Math.floor(rnd() * 200)}-${Math.floor(rnd() * 90)}`,
  () => ' ' + Math.floor(rnd() * 5000) + ' ',
  () => 'nonsense',
  () => '',
  () => null,
  () => undefined,
  () => 'a'.repeat(300) + '-1',
];
const FIELDS = ['id', 'qid', 'qnid', 'public_qn', 'publicQn', 'publicId', 'code'];
const CORRECTS = [0, 1, 2, 3, 'a', 'B', 'c', 'D', '2', undefined, null, '', 'z', 4, 9, -1, 1.5];
const randQuestion = (i) => {
  const q = { q: pick(['What is', 'Find the', 'Unicode नेपाली प्रश्न', '', 'x'.repeat(5)]) + ' ' + i, options: shuffle(['a', 'b', 'c', 'd']).slice(0, 2 + Math.floor(rnd() * 3)) };
  if (rnd() < 0.85) q[pick(FIELDS)] = pick(ID_SHAPES)();
  if (rnd() < 0.2) q[pick(FIELDS)] = pick(ID_SHAPES)();
  const c = pick(CORRECTS); const ck = pick(['correct', 'answer', 'ans', 'Answer']);
  if (c !== undefined) q[ck] = c;
  if (rnd() < 0.3) q[pick(['explanation', 'explain', 'exp'])] = pick(['because', '', 'नेपाली']);
  if (rnd() < 0.1) delete q.options;
  return q;
};
const randFile = () => {
  const n = 1 + Math.floor(rnd() * 8);
  const qs = Array.from({ length: n }, (_, i) => randQuestion(i));
  const shape = rnd();
  if (shape < 0.5) return qs;
  if (shape < 0.7) return { questions: qs };
  if (shape < 0.8) return { data: qs };
  if (shape < 0.85) return { sections: [{ questions: qs.slice(0, 2) }, { questions: qs.slice(2) }] };
  if (shape < 0.9) return { questions: [], sections: [{ questions: qs }] };
  // Several containers at once: the traversal order decides which questions exist at all.
  const other = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => randQuestion(100 + i));
  if (shape < 0.95) return { questions: qs, sections: [{ questions: other }] };
  return pick([{ data: qs, items: other }, { quiz: qs, questions: other }, { items: qs, sections: [{ questions: other }] }, { sections: [{ questions: other }, { notQuestions: 1 }, null, { questions: qs }] }]);
};

const strings = ['48213', ' 48213 ', 'A-123-456-789012', 'a-123-456-789012', 'a-12-456-789012', '50011.110001', 'G0011.110001', 'g0011.110001',
  '5002mixedqn10001', '1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1', 'X-1', 'x-123456', 'abc', 'a1', 'ab12', '12', '', ' ', null, undefined, 0, 7, 'é1234', '١٢٣', 'a'.repeat(64) + '1', 'a.b.c1', '-1', 'F-'];

test('qid parsing is identical for a table of tricky ids', () => {
  for (const s of strings) assert.deepEqual(norm(G('qidParse_')(s)), norm(T.parseQid(s)), `parse ${JSON.stringify(s)}`);
});

test('qidMatches is identical (case and normalisation rules)', () => {
  const wants = ['48213', 'a-123-456-789012', '1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1', '50011.110001', 'x'];
  for (const c of strings) for (const w of wants) assert.equal(G('qidMatches_')(c, w), T.qidMatches(c, w), `${JSON.stringify(c)} vs ${w}`);
});

test('correctOf and hashing agree', () => {
  for (const c of CORRECTS) {
    const q = { correct: c };
    assert.deepEqual(norm(G('qidCorrectOf_')(q)), norm(T.correctOf(q)), `correct ${JSON.stringify(c)}`);
  }
  for (const s of ['', 'x', 'हेलो', 'the quick brown fox', JSON.stringify([1, 2, { a: 'b' }]), 'a'.repeat(5000)]) assert.equal(G('qidHash53_')(s), T.hash53(s));
});

test('FUZZ: flatten / primary / revisions / index / coverage agree on 600 random files', () => {
  for (let i = 0; i < 600; i++) {
    const f = randFile();
    assert.deepEqual(norm(G('qidFlatten_')(f)), norm(T.flattenQuestions(f)), `flatten #${i}`);
    const arr = T.flattenQuestions(f);
    arr.forEach((q, k) => {
      assert.deepEqual(norm(G('qidPrimary_')(q)), norm(T.primaryQid(q)), `primary #${i}.${k}`);
      assert.deepEqual(norm(G('qidAll_')(q)), norm(T.allQids(q)), `all #${i}.${k}`);
      assert.equal(G('qidQuestionRev_')(q), T.questionRev(q), `questionRev #${i}.${k}`);
      assert.equal(G('qidPositionWriteAllowed_')(arr, k), T.positionWriteAllowed(arr, k), `posWrite #${i}.${k}`);
    });
    assert.equal(G('qidFileRev_')(arr), T.fileRev(arr), `fileRev #${i}`);
    assert.deepEqual(norm(G('qidBuildIndex_')(f)), norm(T.buildQidIndex(f)), `index #${i}`);
    assert.deepEqual(norm(G('qidCoverage_')(f)), norm(T.qidCoverage(f)), `coverage #${i}`);
    for (const wanted of [String(arr.length ? T.primaryQid(arr[0]).qid : ''), '', 'zzz', '48213']) {
      assert.equal(G('qidIndexFor_')(arr, 3, wanted), T.questionIndexFor(arr, 3, wanted), `indexFor #${i} ${wanted}`);
    }
  }
});

test('canonical redirects agree (including cycles and depth)', () => {
  const alias = { 1: '2', 2: '3', 3: '4', 4: '5', 5: '6', 6: '7', 7: '8', 8: '9', 9: '10', 20: '21', 21: '20', 30: '30' };
  for (const q of ['1', '2', '9', '20', '21', '30', '99']) {
    assert.equal(G('qidResolveCanonical_')(q, alias, 8), T.resolveCanonical(q, alias, 8), `canon ${q}`);
    assert.equal(G('qidResolveCanonical_')(q, alias), T.resolveCanonical(q, alias), `canon default ${q}`);
  }
});

const randAnswers = (arr, ids) => {
  const form = rnd();
  const choice = () => pick([0, 1, 2, 3, null, '1', 7, 12, -1, 'x', '', undefined, 1.5]);
  if (form < 0.3) return { answers: arr.map(choice) };                                              // positional
  if (form < 0.4) return { answers: JSON.stringify(arr.map(choice)) };
  if (form < 0.5) return { answers: pick([[], 'not json', 5, null, arr.slice(1).map(choice)]) };   // degenerate
  const m = {};
  for (const id of ids) if (rnd() < 0.8) m[id] = choice();
  if (rnd() < 0.15) m[pick(['999999', 'bad id', ids[0] || '1'])] = 1;                              // unknown / bad
  if (form < 0.75) return { answersByQid: m };
  if (form < 0.85) return { answersByQid: JSON.stringify(m) };
  return { answersByQid: Object.entries(m).map(([q, a]) => (rnd() < 0.5 ? { q, a } : { qid: q, answer: a })).concat(rnd() < 0.1 ? [{ q: ids[0], a: 1 }, { q: ids[0], a: 2 }] : []) };
};

test('FUZZ: weekly scoring agrees on 1500 random (file, frozen paper, payload) triples', () => {
  let ok = 0, fail = 0;
  for (let i = 0; i < 1500; i++) {
    const f = randFile();
    const arr = T.flattenQuestions(f);
    const ids = arr.map((q) => T.primaryQid(q).qid).filter(Boolean);
    const frozenKind = rnd();
    const frozen = frozenKind < 0.4 ? [] : frozenKind < 0.8 ? shuffle(ids) : [...ids.slice(1), 'removed-1'].map((x) => (rnd() < 0.1 ? ' ' + x : x));
    const input = { raw: f, frozenQids: frozen, ...randAnswers(arr, ids) };
    const a = norm(TW.scoreWeekly(input));
    const b = norm(G('weeklyScoreQid_')(input));
    assert.deepEqual(b, a, `weekly #${i}: ${JSON.stringify(input).slice(0, 300)}`);
    if (a.ok) ok++; else fail++;
  }
  assert.ok(ok > 150 && fail > 150, `the fuzz must exercise both outcomes (ok=${ok}, fail=${fail})`);
});

test('REORDER INVARIANCE holds on BOTH implementations', () => {
  const base = [1, 2, 3, 4, 5].map((n) => ({ id: 100 + n, q: 'q' + n, options: ['a', 'b', 'c', 'd'], correct: n % 4 }));
  const answers = { 101: 1, 102: 2, 103: 3, 104: 0, 105: 1 };
  for (const score of [(i) => TW.scoreWeekly(i), (i) => G('weeklyScoreQid_')(i)]) {
    const ref = norm(score({ raw: base, answersByQid: answers }));
    for (let k = 0; k < 20; k++) {
      const r = norm(score({ raw: shuffle(base), answersByQid: answers }));
      assert.equal(r.correct, ref.correct); assert.equal(r.total, ref.total); assert.equal(r.fileRev, ref.fileRev);
    }
  }
});

// ── per-question student state: the same merge / fold rules on both backends ──
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const camelKeys = (o) => (o === null ? null : Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v])));
const snakeKeys = (o) => (o === null ? null : Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()), v])));

test('qidIso agrees on a table of timestamp shapes', () => {
  const vals = [0, -5, 1700000000000, '1700000000000', '1700000000', ' 1700000000000 ', '2026-11-17T01:00:00.000Z', '2026-11-17', 'garbage', '', null, undefined, true, 1e15, '99999999999999', NaN];
  for (const v of vals) assert.equal(G('qidIso_')(v), TQ.isoOf(v), `iso ${String(v)}`);
});

const NOW = '2026-11-17T12:00:00.000Z';
const randTs = () => pick([undefined, '', null, 'bad', NOW, '2026-11-17T11:00:00.000Z', '2026-11-17T13:00:00.000Z', '2026-11-18T12:00:00.000Z', '2025-01-01T00:00:00.000Z', Date.parse(NOW) - 1000, Date.parse(NOW) + 1000, Date.parse(NOW) + 3600000]);
const randVal = (text) => (text ? pick(['', 'hello', 'x'.repeat(2500), 'नेपाली', null, 5]) : pick([true, false, 'true', 'false', 1, 0, '1', 'yes', null]));
const randExisting = () => (rnd() < 0.12 ? undefined : { note: pick(['', 'old']), note_at: pick(['', '2026-11-17T11:00:00.000Z', NOW, NOW, '2026-11-17T14:00:00.000Z']), bookmarked: pick(['', 'true', 'false']), bookmarked_at: pick(['', '2026-11-17T11:00:00.000Z', NOW, '2026-11-17T14:00:00.000Z']), flagged: pick(['', 'true']), flagged_at: pick(['', NOW, '2026-11-17T14:00:00.000Z']), in_mistakes: pick(['', 'true']), mistakes_at: pick(['', '2026-11-17T10:00:00.000Z', NOW, '2026-11-17T14:00:00.000Z']) });

test('FUZZ: per-field state merge agrees on 1500 random (existing row, change) pairs', () => {
  let patched = 0, skipped = 0;
  for (let i = 0; i < 1500; i++) {
    const ex = randExisting();
    const change = {};
    for (const f of TQ.FIELD_SETS) {
      if (rnd() < 0.4) change[f.prop] = randVal(f.text);
      if (rnd() < 0.6) change[f.at] = randTs();
    }
    const a = TQ.mergeStateChange(ex, change, NOW);
    const b = G('qstateMergeChange_')(ex ? camelKeys(ex) : undefined, change, NOW);
    assert.deepEqual(norm(snakeKeys(norm(b))), norm(a), `merge #${i}: ${JSON.stringify({ ex, change })}`);
    if (a) patched++; else skipped++;
  }
  assert.ok(patched > 250 && skipped > 250, `both outcomes must be exercised (patched=${patched}, skipped=${skipped})`);
});

test('FUZZ: answer folding agrees on 800 random (state, events) pairs', () => {
  for (let i = 0; i < 800; i++) {
    const ex = rnd() < 0.4 ? undefined : { ...(randExisting() || {}), attempts: pick(['0', '3', '10']), wrong: pick(['0', '1', '4']), last_result: pick(['', 'ok', 'wrong']), last_at: pick(['', '2026-11-17T09:00:00.000Z', '2026-11-17T11:30:00.000Z']), file_id: pick(['', 'f1']) };
    const evs = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({ qid: '701', at: new Date(Date.parse('2026-11-17T08:00:00.000Z') + Math.floor(rnd() * 5) * 3600000 + Math.floor(rnd() * 3) * 1000).toISOString(), ok: rnd() < 0.5, fileId: pick(['', 'f1', 'f2']) }));
    const a = TQ.foldAnswers(ex, evs, NOW);
    const b = G('qstateFoldAnswers_')(ex ? camelKeys(ex) : undefined, evs, NOW);
    assert.deepEqual(norm(snakeKeys(norm(b.row))), norm(a.row), `fold #${i}`);
    assert.equal(b.wrongN, a.wrongN); assert.equal(b.prevAttempts, a.prevAttempts);
  }
});
