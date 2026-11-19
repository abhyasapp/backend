// _shared/qfile.ts — load a question file for reading/editing, with logged
// corrections overlaid by qid.
//
// Subjective files live in Storage and are written back directly. Objective
// files live in the content repo, served through a CDN that can lag the
// correction log by hours (and by the pipeline's re-export). Without an
// overlay, an admin re-opening a question they just corrected sees the OLD
// text, and a second correction records a stale `before`. The overlay applies
// every logged correction for the file to the CDN copy — matched by qid, never
// by position — but ONLY when the CDN copy still equals that event's `before`
// (i.e. it has not been absorbed yet and nothing else touched the question).

import { supabase, selectAll } from './db.ts';
import { flattenQuestions, questionIndexFor, qidString } from './qid.ts';

export interface LoadedFile {
  raw: any;
  arr: any[];
  writable: boolean;
  source: 'storage' | 'cdn';
  overlay: { applied: number; skipped: number };
}

const cdnBase = () => (Deno.env.get('CONTENT_CDN_BASE') || 'https://cdn.jsdelivr.net/gh/abhyasapp/content@main').replace(/\/+$/, '');

function optionsOf(q: any): string[] { return (Array.isArray(q?.options) ? q.options : (q?.opts || [])).map(String); }
function correctIdx(q: any): number | null { const c = q?.correct ?? q?.answer ?? null; return Number.isInteger(c) ? c : null; }

/** Does the question still look like the `before` side of a logged correction? */
export function matchesBefore(q: any, before: any): boolean {
  if (!q || !before) return false;
  if (String(q.q || q.question || '').trim() !== String(before.question || '').trim()) return false;
  if (JSON.stringify(optionsOf(q)) !== JSON.stringify((before.options || []).map(String))) return false;
  return before.correctIndex === null || before.correctIndex === undefined || correctIdx(q) === before.correctIndex;
}

export function applyAfter(q: any, after: any): void {
  q.q = String(after.question || '');
  if (Array.isArray(after.options) && after.options.length) q.options = after.options.map(String);
  if (Number.isInteger(after.correctIndex)) q.correct = after.correctIndex;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(q, k);
  q[has('explanation') ? 'explanation' : has('explain') ? 'explain' : has('exp') ? 'exp' : 'explanation'] = String(after.explanation ?? '');
}

export async function applyCorrectionOverlay(fileId: string, arr: any[]): Promise<{ applied: number; skipped: number }> {
  const out = { applied: 0, skipped: 0 };
  try {
    const events = await selectAll('correction_events', 'qid,before,after,corrected_at', {
      orderBy: 'corrected_at', thenBy: 'id', apply: q => q.eq('file_id', fileId),
    });
    for (const ev of events) {
      const qid = qidString(ev.qid);
      if (!qid) { out.skipped++; continue; }              // legacy position-only event: never overlaid
      const at = questionIndexFor(arr, -1, qid);
      if (at < 0) { out.skipped++; continue; }
      let before: any, after: any;
      try { before = JSON.parse(ev.before); after = JSON.parse(ev.after); } catch { out.skipped++; continue; }
      if (matchesBefore(arr[at], before)) { applyAfter(arr[at], after); out.applied++; } else out.skipped++;
    }
  } catch { /* overlay is best-effort: the unmodified file is still correct data */ }
  return out;
}

/** Storage first (writable, authoritative), then the CDN mirror with the
 *  correction overlay. `null` when the file cannot be read anywhere. */
export async function loadFileForEdit(fileId: string): Promise<LoadedFile | null> {
  try {
    const { data: blob, error } = await supabase.storage.from('subjective-content').download(fileId);
    if (!error && blob) {
      const raw = JSON.parse(await blob.text());
      return { raw, arr: flattenQuestions(raw), writable: true, source: 'storage', overlay: { applied: 0, skipped: 0 } };
    }
  } catch { /* fall through to the CDN */ }
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) return null;
  try {
    const res = await fetch(`${cdnBase()}/content/${encodeURIComponent(fileId)}.json`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const raw = await res.json();
    const arr = flattenQuestions(raw);
    const overlay = await applyCorrectionOverlay(fileId, arr);
    return { raw, arr, writable: false, source: 'cdn', overlay };
  } catch { return null; }
}
