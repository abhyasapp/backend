// _shared/corrections.ts — replay the correction log over the questions being served.
//
// Objective chapter files are read-only mirrors of the Drive export, so a fix is
// recorded as a `correction_events` row and used to reach a learner only after the
// pipeline re-exported the file — which takes hours and, while the CDN served
// `@main`, could be served from a stale branch cache anyway. This module applies the
// latest event per qid to any file the backend hands out, so the fix is visible on
// the very next request. The pipeline still bakes events into the next artifact;
// replaying an already-baked correction is idempotent (newest row wins).
//
// Read paths only. Write paths must keep reading the file as published, or a second
// edit would record the first edit's text as `before`.

import { supabase } from './db.ts';
import { questionQid, qidString } from './qid.ts';

export type Correction = {
  question?: string;
  options?: string[];
  correctIndex?: number | null;
  explanation?: string;
};

const CHUNK = 100;
const MAX_EVENTS = 5000;

/** The `after` snapshot of an event, or null when it carries nothing usable. */
function parseAfter(raw: unknown): Correction | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(String(raw == null ? '' : raw));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const out: Correction = {};
  if (typeof o.question === 'string' && o.question.trim()) out.question = o.question;
  if (Array.isArray(o.options)) out.options = o.options.map(String);
  if (o.correctIndex === null || Number.isInteger(o.correctIndex)) {
    out.correctIndex = o.correctIndex as number | null;
  }
  if (typeof o.explanation === 'string') out.explanation = o.explanation;
  return Object.keys(out).length ? out : null;
}

/** Latest correction per qid. Events arrive oldest-first, so the last write wins. */
export async function latestCorrections(qids: string[]): Promise<Map<string, Correction>> {
  const out = new Map<string, Correction>();
  const wanted = [...new Set(qids.map(qidString).filter(Boolean))];
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const slice = wanted.slice(i, i + CHUNK);
    const { data, error } = await supabase.from('correction_events')
      .select('id,qid,after,corrected_at')
      .in('qid', slice)
      .order('corrected_at', { ascending: true })
      .limit(MAX_EVENTS);
    if (error || !data) continue;
    for (const row of data as Array<Record<string, unknown>>) {
      const qid = qidString(row.qid);
      const after = parseAfter(row.after);
      if (qid && after) out.set(qid, after);
    }
  }
  return out;
}

/** Overwrite the keys the question already uses, else the published one. */
function assign(q: Record<string, unknown>, keys: string[], value: unknown): void {
  const present = keys.filter(k => Object.prototype.hasOwnProperty.call(q, k));
  for (const k of (present.length ? present : [keys[0]])) q[k] = value;
}

/** Apply corrections to a flat question array in place. Returns how many changed. */
export function applyCorrections(arr: unknown[], latest: Map<string, Correction>): number {
  if (!latest.size || !Array.isArray(arr)) return 0;
  let changed = 0;
  for (const q of arr) {
    if (!q || typeof q !== 'object') continue;
    const fix = latest.get(questionQid(q as Record<string, unknown>));
    if (!fix) continue;
    const target = q as Record<string, unknown>;
    if (fix.question !== undefined) assign(target, ['q', 'question'], fix.question);
    if (fix.options !== undefined) assign(target, ['options', 'opts'], fix.options);
    if (fix.correctIndex !== undefined) assign(target, ['correct', 'answer', 'ans'], fix.correctIndex);
    if (fix.explanation !== undefined) assign(target, ['explain', 'explanation', 'exp'], fix.explanation);
    changed++;
  }
  return changed;
}

/** The question objects inside any file shape the content pipeline publishes. */
export function questionObjects(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.sections)) {
    const fromSections = (o.sections as Array<Record<string, unknown>>)
      .flatMap(s => (Array.isArray(s?.questions) ? s.questions : []));
    if (fromSections.length) return fromSections;
  }
  if (Array.isArray(o.questions)) return o.questions;
  return [];
}

/** Overlay service for a parsed file: correct the objects in place. */
export async function overlayFileJson(raw: unknown): Promise<number> {
  const questions = questionObjects(raw);
  if (!questions.length) return 0;
  const qids = questions.map(q => questionQid(q as Record<string, unknown>)).filter(Boolean);
  if (!qids.length) return 0;
  return applyCorrections(questions, await latestCorrections(qids));
}

/** Overlay service for an already-flattened question array (console reads). */
export async function overlayQuestions(arr: unknown[]): Promise<number> {
  if (!Array.isArray(arr) || !arr.length) return 0;
  const qids = arr.map(q => questionQid(q as Record<string, unknown>)).filter(Boolean);
  if (!qids.length) return 0;
  return applyCorrections(arr, await latestCorrections(qids));
}
