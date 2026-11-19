// _shared/weekly-score.ts — weekly paper scoring, keyed by qid.
//
// A student's answer is "question <qid> → option <n>". The server holds the
// answer key, so it scores by looking each qid up in the paper; position never
// decides anything. A paper is frozen at creation (the ordered qid list +
// revision), so an attempt can be re-scored later against exactly the questions
// the student was asked, even after the file has been corrected or reordered.
//
// The legacy positional payload (`answers: [1,null,3,…]`) is still accepted: it
// is converted to qid answers by mapping index → the file's qid at that index,
// then flows through the same core. Dependency-free; mirrored in gas/qid.gs.

import { flattenQuestions, primaryQid, correctOf, qidCoverage, fileRev, qidString } from './qid.ts';

export interface WeeklyInput {
  raw: unknown;                       // the parsed weekly-sets file
  frozenQids?: string[];              // qids frozen on the set at creation ([] / undefined = not frozen)
  answersByQid?: unknown;             // {qid: n|null}  or  [{q|qid: string, a|answer: n|null}]
  answers?: unknown;                  // legacy positional array
}

export interface WeeklyScore {
  ok: true;
  mode: 'qid' | 'positional';
  total: number;                      // questions that count (voided ones excluded)
  correct: number;
  skipped: number;
  qids: string[];                     // the paper as scored, in presentation order ('' entries only in positional mode)
  answersByQid: Record<string, number | null>;
  answers: (number | null)[];         // aligned to `qids` (what the legacy `answers_json` column holds)
  voided: string[];                   // qids on the frozen paper that no longer exist / have no key
  fileRev: string;
  warnings: string[];
}
export interface WeeklyFail { ok: false; error: string; code: string }

const fail = (code: string, error: string): WeeklyFail => ({ ok: false, code, error });

function choice(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 10 ? n : null;
}

function isRight(expected: number | string | undefined, a: number | null): boolean {
  if (a === null) return false;
  return (typeof expected === 'number' && a === expected) || (typeof expected === 'string' && String(a) === expected);
}

/** Parses the qid-keyed answer payload into a Map; rejects duplicates. */
export function parseAnswersByQid(v: unknown): { ok: true; map: Map<string, number | null> } | WeeklyFail {
  let src: unknown = v;
  if (typeof src === 'string') { try { src = JSON.parse(src); } catch { return fail('malformed', 'Malformed answers.'); } }
  const map = new Map<string, number | null>();
  const put = (rawKey: unknown, rawVal: unknown): WeeklyFail | null => {
    const key = qidString(rawKey);
    if (!key) return fail('bad_qid', 'An answer refers to an unrecognised question id.');
    if (map.has(key)) return fail('duplicate_qid', 'The same question was answered twice.');
    map.set(key, choice(rawVal));
    return null;
  };
  if (Array.isArray(src)) {
    for (const it of src as any[]) {
      const e = put(it?.q ?? it?.qid, it?.a ?? it?.answer);
      if (e) return e;
    }
  } else if (src && typeof src === 'object') {
    for (const [k, val] of Object.entries(src as Record<string, unknown>)) {
      const e = put(k, val);
      if (e) return e;
    }
  } else return fail('malformed', 'Malformed answers.');
  if (!map.size || map.size > 500) return fail('size', 'Invalid answers.');
  return { ok: true, map };
}

export function scoreWeekly(input: WeeklyInput): WeeklyScore | WeeklyFail {
  const arr = flattenQuestions(input.raw);
  if (!arr.length) return fail('no_questions', 'This weekly set has no questions.');
  const cov = qidCoverage(input.raw);
  const qidReady = cov.missing === 0 && cov.duplicates.length === 0;
  const warnings: string[] = [];
  if (qidReady && cov.positional > 0) warnings.push('Some question ids are position-derived ("<file>-<n>") and are not reorder-safe.');

  const hasQidPayload = input.answersByQid !== undefined && input.answersByQid !== null && input.answersByQid !== '';

  // ── positional-only paper (legacy file with no usable ids) ─────────────
  if (!qidReady) {
    if (hasQidPayload) return fail('paper_not_qid_ready', 'This weekly set has questions without unique ids, so it cannot be scored by question id. Contact the admin.');
    let list: unknown;
    try { list = typeof input.answers === 'string' ? JSON.parse(input.answers) : input.answers; } catch { return fail('malformed', 'Malformed answers array.'); }
    if (!Array.isArray(list) || !list.length || list.length > 500) return fail('size', 'Invalid answers array.');
    if (list.length !== arr.length) return fail('count_mismatch', 'The number of answers does not match the number of questions in this set. Contact the admin.');
    const answers = list.map(choice);
    let correct = 0, skipped = 0;
    answers.forEach((a, i) => { if (a === null) skipped++; else if (isRight(correctOf(arr[i]), a)) correct++; });
    warnings.push('Paper has no unique question ids; scored by position (legacy).');
    return { ok: true, mode: 'positional', total: arr.length, correct, skipped, qids: arr.map(() => ''), answersByQid: {}, answers, voided: [], fileRev: fileRev(arr), warnings };
  }

  // ── qid paper ─────────────────────────────────────────────────────────
  const byQid = new Map<string, { correct: number | string | undefined }>();
  const fileOrder: string[] = [];
  for (const q of arr) { const id = primaryQid(q).qid; byQid.set(id, { correct: correctOf(q) }); fileOrder.push(id); }

  // The paper = what was frozen at creation, else the file as it is now.
  const frozen = (input.frozenQids || []).map(qidString).filter(Boolean);
  const paper = frozen.length ? frozen : fileOrder;
  const voided: string[] = [];
  const active: string[] = [];
  for (const id of paper) {
    const e = byQid.get(id);
    const k = e?.correct;
    if (!e || k === undefined || k === null || k === '') voided.push(id); else active.push(id);
  }
  if (!active.length) return fail('empty_paper', 'No scorable questions remain on this weekly set. Contact the admin.');

  // Normalise the payload to qid → choice.
  let answerMap: Map<string, number | null>;
  if (hasQidPayload) {
    const parsed = parseAnswersByQid(input.answersByQid);
    if (!parsed.ok) return parsed;
    answerMap = parsed.map;
  } else {
    let list: unknown;
    try { list = typeof input.answers === 'string' ? JSON.parse(input.answers) : input.answers; } catch { return fail('malformed', 'Malformed answers array.'); }
    if (!Array.isArray(list) || !list.length || list.length > 500) return fail('size', 'Invalid answers array.');
    // Positional payload: a legacy client answers in the order of the file it
    // downloaded, i.e. the file's CURRENT order. Map index → that file's qid,
    // then keep only questions that are on the frozen paper.
    if (list.length !== arr.length) return fail('count_mismatch', 'The number of answers does not match the number of questions in this set. Contact the admin.');
    answerMap = new Map();
    const onFrozen = new Set(paper);
    fileOrder.forEach((id, i) => { if (onFrozen.has(id)) answerMap.set(id, choice(list[i])); });
    warnings.push('Positional answers were converted to question ids using the file order.');
  }

  const onPaper = new Set(paper);
  const unknown = [...answerMap.keys()].filter(k => !onPaper.has(k));
  if (unknown.length) return fail('unknown_qid', `These question ids are not on this weekly set: ${unknown.slice(0, 5).join(', ')}.`);

  const answersByQid: Record<string, number | null> = {};
  let correct = 0, skipped = 0;
  for (const id of active) {
    const a = answerMap.has(id) ? answerMap.get(id)! : null;
    answersByQid[id] = a;
    if (a === null) skipped++; else if (isRight(byQid.get(id)!.correct, a)) correct++;
  }
  if (voided.length) warnings.push(`${voided.length} question(s) on the frozen paper were voided (removed or no answer key).`);
  return {
    ok: true, mode: 'qid', total: active.length, correct, skipped,
    qids: active, answersByQid, answers: active.map(id => answersByQid[id]),
    voided, fileRev: fileRev(arr), warnings,
  };
}

/** Re-score a stored attempt against the current key (after admin corrections). */
export function rescoreAttempt(raw: unknown, frozenQids: string[], answersByQid: Record<string, unknown>) {
  return scoreWeekly({ raw, frozenQids, answersByQid });
}
