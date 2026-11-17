// _shared/qid.ts — canonical question-id normalisation.
//
// Every handler, and the Apps Script fallback (gas/report.gs, qidString), must agree
// on this: a report, a correction and a per-question result are the same thing only
// if they normalise to the same string. Keep the rules here and mirror them, never
// fork them.

/** Fields a content question may carry its id on. `id` holds the internal numeric
    qid in older files and the public hyphenated qn id in newer ones; the others are
    accepted so a file that keeps both is never split into two identities. */
export const QID_FIELDS = ['id', 'qid', 'qnid', 'publicId', 'publicQid', 'code'];

export function qidString(v: unknown): string {
  const s = String(v == null ? '' : v).trim();
  if (/^\d+$/.test(s)) return s;
  // Generated public qn ids (LCCCSSSFQQQQ): accept any reasonable casing and
  // normalise to a stable lowercase form so dedup, sibling-closure and
  // correction-event idempotency keys stay consistent across the stack.
  if (/^[A-Za-z0-9]{1,3}-[0-9]{3}-[0-9]{3}-[0-9]{6}$/.test(s)) {
    return s.replace(/[^A-Za-z0-9-]/g, '').toLowerCase();
  }
  // Ids as actually published in abhyasapp/content: "<fileId>-<position>",
  // e.g. "1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1". Positional by construction — kept
  // so existing reports keep matching until the pipeline emits immutable ids
  // (docs/content-versioning.md, phase 1). Case is preserved because the fileId
  // part is case-sensitive for every other consumer.
  if (/^[A-Za-z0-9_-]{1,200}-\d{1,5}$/.test(s)) return s;
  // The public qn id the pipeline writes to `public_qn`: level token, chapter,
  // subtopic and sequence, either dotted ("50011.110001", "G0011.110001") or
  // flat, the only shape that can carry a word subtopic ("5002mixedqn10001").
  // Lowercased like every other public id so one question keys identically
  // whichever field delivered it.
  if (/^[A-Za-z0-9][A-Za-z0-9._]{3,63}$/.test(s) && /\d/.test(s)) {
    return s.toLowerCase();
  }
  return '';
}

/** True when a stored id is the wanted one, compared in canonical form — so the
    public `A-123-456-789012` matches `a-123-456-789012` instead of falling through
    to the position. */
export function qidMatches(candidate: unknown, wanted: string): boolean {
  if (!wanted) return false;
  const raw = String(candidate == null ? '' : candidate).trim();
  if (!raw) return false;
  if (raw === wanted) return true;
  if (raw.toLowerCase() === wanted.toLowerCase()) return true;
  const norm = qidString(raw);
  return !!norm && norm === wanted;
}

/** The canonical id of a question object, or '' when it carries none. */
export function questionQid(q: Record<string, unknown> | null | undefined): string {
  if (!q || typeof q !== 'object') return '';
  for (const field of QID_FIELDS) {
    const id = qidString((q as Record<string, unknown>)[field]);
    if (id) return id;
  }
  return '';
}
