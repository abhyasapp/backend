// _shared/qid.ts — question identity, in one place.
//
// RULE: a question is identified by its qid. Its position in a file and the
// file it lives in are *derived, display-only* facts — they change when a file
// is reordered, split or merged, a qid does not. Everything that stores or
// scores a per-question fact (reports, corrections, weekly answers, notes,
// bookmarks, mistakes, statistics) keys on the qid from this module.
//
// Dependency-free on purpose: it is unit-tested directly and mirrored 1:1 in
// gas/qid.gs, so both backends derive the same qid / revision / ordering.

export type QidKind = 'stable' | 'positional' | '';

/** How much a file's questions can be trusted to carry identity.
 *  stable     every question has a unique stable qid  → position is never needed
 *  partial    some do                                  → qid-less rows need care
 *  positional none do (or only "<fileId>-<n>" ids)     → legacy, position-bound */
export type IdentityMode = 'stable' | 'partial' | 'positional';

// Fields a content question may carry its id on, in the order the app's
// _stableQid() prefers them (public_qn first). Matching accepts ANY of them so
// a question is found whichever id the caller holds.
export const QID_FIELDS = ['public_qn', 'publicQn', 'qnid', 'qid', 'id', 'publicId', 'publicQid', 'code'];

/** Canonical form + kind of an id. '' when the value is not a usable id. */
export function parseQid(v: unknown): { qid: string; kind: QidKind } {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { qid: '', kind: '' };
  if (/^\d+$/.test(s)) return { qid: s, kind: 'stable' };
  // Generated public qn ids (LCCCSSSFQQQQ) — case-insensitive, stored lowercase.
  if (/^[A-Za-z0-9]{1,3}-[0-9]{3}-[0-9]{3}-[0-9]{6}$/.test(s)) {
    return { qid: s.replace(/[^A-Za-z0-9-]/g, '').toLowerCase(), kind: 'stable' };
  }
  // "<fileId>-<position>": the id carries the question's POSITION, so it changes
  // when a file is reordered. Accepted (legacy data exists) but never trusted as
  // stable — callers must treat kind === 'positional' as "needs migrating".
  // Case is preserved because the fileId part is case-sensitive.
  if (/^[A-Za-z0-9_-]{1,200}-\d{1,5}$/.test(s)) return { qid: s, kind: 'positional' };
  // Public qn ids as the pipeline writes them: dotted ("50011.110001") or flat
  // ("5002mixedqn10001"). Lowercased so one question keys identically whichever
  // field delivered it.
  if (/^[A-Za-z0-9][A-Za-z0-9._]{3,63}$/.test(s) && /\d/.test(s)) return { qid: s.toLowerCase(), kind: 'stable' };
  return { qid: '', kind: '' };
}

export function qidString(v: unknown): string { return parseQid(v).qid; }
export function qidKind(v: unknown): QidKind { return parseQid(v).kind; }
export function isStableQid(v: unknown): boolean { return parseQid(v).kind === 'stable'; }

/** True when a stored id is the wanted one, compared in canonical form. */
export function qidMatches(candidate: unknown, wanted: string): boolean {
  if (!wanted) return false;
  const raw = String(candidate == null ? '' : candidate).trim();
  if (!raw) return false;
  if (raw === wanted || raw.toLowerCase() === wanted.toLowerCase()) return true;
  const norm = qidString(raw);
  return !!norm && norm === wanted;
}

/** The question list of a content file. ONE traversal order for every consumer
 *  (scoring, reports, corrections, indexing, the app): an array; else
 *  questions|data|quiz|items; else the flattened sections. Three differing
 *  copies of this used to exist, so positions could disagree between them. */
export function flattenQuestions(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  for (const k of ['questions', 'data', 'quiz', 'items']) {
    if (Array.isArray(o[k]) && (o[k] as unknown[]).length) return o[k] as any[];
  }
  if (Array.isArray(o.sections)) {
    const fromSections = (o.sections as any[]).flatMap(s => (Array.isArray(s?.questions) ? s.questions : []));
    if (fromSections.length) return fromSections;
  }
  for (const k of ['questions', 'data', 'quiz', 'items']) if (Array.isArray(o[k])) return o[k] as any[];
  return [];
}

/** The id the app/pipeline treats as the question's identity (first valid field,
 *  app order). Returns canonical form + kind; qid '' when the question has none. */
export function primaryQid(q: unknown): { qid: string; kind: QidKind } {
  if (!q || typeof q !== 'object') return { qid: '', kind: '' };
  const o = q as Record<string, unknown>;
  let positional: { qid: string; kind: QidKind } | null = null;
  for (const f of QID_FIELDS) {
    const p = parseQid(o[f]);
    if (!p.qid) continue;
    if (p.kind === 'stable') return p;          // a stable id on any field beats a positional one
    if (!positional) positional = p;
  }
  return positional || { qid: '', kind: '' };
}

/** Every distinct canonical id a question answers to (numeric id + public id…). */
export function allQids(q: unknown): string[] {
  if (!q || typeof q !== 'object') return [];
  const o = q as Record<string, unknown>;
  const out: string[] = [];
  for (const f of QID_FIELDS) { const s = qidString(o[f]); if (s && !out.includes(s)) out.push(s); }
  return out;
}

/** Correct answer of a question as scoring sees it (index number, or the raw
 *  string a legacy file used). Letters a–e map to 0–4. */
export function correctOf(q: unknown): number | string | undefined {
  if (!q || typeof q !== 'object') return undefined;
  const o = q as Record<string, unknown>;
  let c: unknown = o.correct !== undefined ? o.correct
    : o.answer !== undefined ? o.answer
    : o.ans !== undefined ? o.ans
    : o.Answer;
  if (typeof c === 'string' && /^[a-eA-E]$/.test(c.trim())) c = 'abcde'.indexOf(c.trim().toLowerCase());
  return c as number | string | undefined;
}

/** Deterministic 53-bit string hash (cyrb53) → 14 hex chars. Pure and sync so
 *  the Apps Script copy produces byte-identical revisions. */
export function hash53(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

function textOf(q: Record<string, unknown>): string {
  return String(q.q ?? q.question ?? q.text ?? '');
}
function optionsOf(q: Record<string, unknown>): unknown[] {
  const o = q.options ?? q.choices ?? q.opts;
  return Array.isArray(o) ? o : [];
}
function explanationOf(q: Record<string, unknown>): string {
  return String(q.explanation ?? q.explain ?? q.exp ?? '');
}

/** Revision of what a student SEES and is scored on: text, options, correct
 *  answer, explanation. Changes exactly when an admin correction changes the
 *  question — the unit of optimistic concurrency and of "which version did this
 *  attempt see". Never includes position. */
export function questionRev(q: unknown): string {
  if (!q || typeof q !== 'object') return '';
  const o = q as Record<string, unknown>;
  return hash53(JSON.stringify([textOf(o), optionsOf(o), correctOf(o) ?? null, explanationOf(o)]));
}

/** Revision of the whole paper: the ordered (qid, rev) pairs — position is NOT
 *  part of it, so reordering a file does not change it but editing a question
 *  or adding/removing one does. */
export function fileRev(arr: unknown[]): string {
  const pairs = arr.map(q => [primaryQid(q).qid, questionRev(q)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return hash53(JSON.stringify(pairs));
}

export interface QidIndexRow { qid: string; kind: QidKind; ord: number; rev: string }

/** The registry rows of one file. `ord` is informational only. */
export function buildQidIndex(raw: unknown): QidIndexRow[] {
  const out: QidIndexRow[] = [];
  flattenQuestions(raw).forEach((q, i) => {
    const p = primaryQid(q);
    if (p.qid) out.push({ qid: p.qid, kind: p.kind, ord: i, rev: questionRev(q) });
  });
  return out;
}

export interface QidCoverage {
  total: number; withQid: number; stable: number; positional: number; missing: number;
  duplicates: string[]; mode: IdentityMode;
}

export function qidCoverage(raw: unknown): QidCoverage {
  const arr = flattenQuestions(raw);
  const seen = new Map<string, number>();
  let stable = 0, positional = 0, missing = 0;
  for (const q of arr) {
    const p = primaryQid(q);
    if (!p.qid) { missing++; continue; }
    if (p.kind === 'stable') stable++; else positional++;
    seen.set(p.qid, (seen.get(p.qid) || 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  const mode: IdentityMode = arr.length && stable === arr.length && !duplicates.length ? 'stable'
    : stable > 0 ? 'partial' : 'positional';
  return { total: arr.length, withQid: stable + positional, stable, positional, missing, duplicates, mode };
}

/** Position of a question inside its file, resolved by identity:
 *  1. the id on any id-bearing field, 2. the position — only when the caller
 *  supplied NO id. A supplied id that matches nothing returns -1, so a change
 *  can never silently land on whatever now sits at the old position. */
export function questionIndexFor(arr: any[], index: number, qid: string): number {
  if (!qid) return index;
  for (const field of QID_FIELDS) {
    const found = arr.findIndex(q => qidMatches(q?.[field], qid));
    if (found >= 0) return found;
  }
  return -1;
}

/** May a write that carries NO qid be applied by position? Only when the
 *  question at that position has no stable identity of its own — otherwise the
 *  caller must say which question it means. */
export function positionWriteAllowed(arr: any[], index: number): boolean {
  const q = arr[index];
  if (!q || typeof q !== 'object') return false;
  return primaryQid(q).kind !== 'stable';
}

/** Follows merge/retire redirects (qid → canonical qid), loop- and depth-safe. */
export function resolveCanonical(qid: string, aliases: Map<string, string> | Record<string, string>, maxHops = 8): string {
  const get = (k: string) => (aliases instanceof Map ? aliases.get(k) : (aliases as Record<string, string>)[k]);
  let cur = qid;
  const seen = new Set<string>();
  for (let i = 0; i < maxHops; i++) {
    const next = get(cur);
    if (!next || next === cur || seen.has(next)) break;
    seen.add(cur);
    cur = next;
  }
  return cur;
}
