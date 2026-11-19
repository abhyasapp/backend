// _shared/qstate-core.ts — the pure rules behind per-question student state.
// No I/O. Mirrored 1:1 in gas/qid-core.gs and pinned by tests/parity.test.mjs, so
// both backends merge notes/bookmarks/flags/mistakes and fold answers identically.
// (Column names here are the Postgres ones; the Apps Script twin uses camelCase.)

export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const NOTE_MAX = 2000;

/** ISO string with ms from a ms number, numeric string or ISO string; '' if unusable. */
export function isoOf(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  let ms = NaN;
  if (typeof v === 'number') ms = v;
  else if (/^\d{10,14}$/.test(String(v).trim())) ms = Number(v);
  else ms = new Date(String(v)).getTime();
  return isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

export const boolText = (v: unknown): string => (v === true || v === 'true' || v === 1 || v === '1' ? 'true' : 'false');
export const toBool = (v: unknown): boolean => v === true || v === 'true';

export const FIELD_SETS: Array<{ prop: string; col: string; at: string; atCol: string; text: boolean }> = [
  { prop: 'note', col: 'note', at: 'noteAt', atCol: 'note_at', text: true },
  { prop: 'bookmarked', col: 'bookmarked', at: 'bookmarkedAt', atCol: 'bookmarked_at', text: false },
  { prop: 'flagged', col: 'flagged', at: 'flaggedAt', atCol: 'flagged_at', text: false },
  { prop: 'inMistakes', col: 'in_mistakes', at: 'mistakesAt', atCol: 'mistakes_at', text: false },
];

/** Merge one incoming change into the existing row, field by field (last writer wins
 *  per field by its own timestamp). Returns the columns that changed, or null when
 *  nothing did (an idempotent replay). */
export function mergeStateChange(existing: Record<string, any> | undefined, change: Record<string, any>, nowIso: string): Record<string, string> | null {
  const patch: Record<string, string> = {};
  const nowMs = new Date(nowIso).getTime();
  for (const f of FIELD_SETS) {
    if (change[f.prop] === undefined) continue;
    let at = isoOf(change[f.at]) || nowIso;
    if (new Date(at).getTime() > nowMs + FUTURE_SKEW_MS) at = nowIso;     // a wrong device clock never wins forever
    const cur = String(existing?.[f.atCol] || '');
    if (cur && cur >= at) continue;                                        // existing field is newer (or same) → keep
    const val = f.text ? String(change[f.prop] ?? '').slice(0, NOTE_MAX) : boolText(change[f.prop]);
    if (existing && String(existing[f.col] ?? '') === val && cur === at) continue;
    patch[f.col] = val; patch[f.atCol] = at;
  }
  return Object.keys(patch).length ? patch : null;
}

export interface AnsEv { qid: string; at: string; ok: boolean; fileId: string }

const EMPTY_STATE = { note: '', note_at: '', bookmarked: '', bookmarked_at: '', flagged: '', flagged_at: '', in_mistakes: '', mistakes_at: '' };

/** Fold a student's new answer events for ONE qid into their state row.
 *  A wrong answer puts the question on the mistake list (field-level LWW against an
 *  explicit clear); a right answer never clears it — the app owns the mastery rule. */
export function foldAnswers(ex: Record<string, any> | undefined, evsIn: AnsEv[], nowIso: string) {
  const evs = [...evsIn].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const last = evs[evs.length - 1];
  const wrongN = evs.filter(e => !e.ok).length;
  const prevAttempts = Number(ex?.attempts || 0);
  const newer = !ex?.last_at || last.at > String(ex.last_at);
  const row: Record<string, any> = {
    ...(ex || EMPTY_STATE),
    qid: last.qid,
    file_id: last.fileId || ex?.file_id || '',
    attempts: String(prevAttempts + evs.length),
    wrong: String(Number(ex?.wrong || 0) + wrongN),
    last_result: newer ? (last.ok ? 'ok' : 'wrong') : String(ex?.last_result || ''),
    last_at: newer ? last.at : String(ex?.last_at || ''),
    updated_at: nowIso,
  };
  const lastWrong = [...evs].reverse().find(e => !e.ok);
  if (lastWrong && (!ex?.mistakes_at || lastWrong.at > String(ex.mistakes_at))) { row.in_mistakes = 'true'; row.mistakes_at = lastWrong.at; }
  return { row, wrongN, prevAttempts };
}
