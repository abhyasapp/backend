/* Admin reports: the console lists reports from Supabase, then looks the same
   question up in Neon by its public qn id and applies the correction there.
   These two handlers are that Neon half. */

import { json } from '../_shared/http.ts';
import { authAdmin } from '../_shared/auth.ts';
import { neonConfigured, neonQuery } from '../_shared/neon.ts';

/* The chip a student sees: 70024.730011. Reports written before the pipeline
   published those carry the older internal number instead (53903), so both forms
   are accepted and matched against the column that holds each. */
const QN_RE = /^\d{1,6}\.\d{6}$/;
const LEGACY_RE = /^\d{1,9}$/;

export function qnOf(v: unknown): string {
  const s = String(v == null ? '' : v).trim();
  return (QN_RE.test(s) || LEGACY_RE.test(s)) ? s : '';
}

const isLegacyId = (s: string) => !s.includes('.');
const whereFor = (qn: string) => (isLegacyId(qn) ? 'id = $1::int' : 'stable_qn_id = $1');
const paramFor = (qn: string) => (isLegacyId(qn) ? Number(qn) : qn);

const missing = () => json({
  success: false,
  neonMissing: true,
  error: 'Neon is not configured on this deployment, so corrections cannot be applied there yet.',
});

const failed = (e: unknown) => {
  console.error('[neon]', (e as Error)?.message || String(e));
  return json({ success: false, error: 'Neon could not be reached. Nothing was changed there.' });
};

/* Was this qn ever corrected in Neon, and what does Neon hold now? */
export async function adminneonquestion(params: Record<string, unknown>) {
  const auth = await authAdmin(params);
  if (!auth.ok) return json(auth.error);
  if (!neonConfigured()) return missing();

  const qn = qnOf(params.qn ?? params.qid ?? params.public_qn);
  if (!qn) return json({ success: false, error: 'A public question id looks like 70024.730011.' });

  try {
    const rows = await neonQuery(
      `select id, stable_qn_id, question_text, options, correct_index, correct_text,
              explanation, corrected_at
         from questions
        where ${whereFor(qn)}
        limit 1`,
      [paramFor(qn)],
    );
    if (!rows.length) return json({ success: true, found: false, qn, matchedBy: isLegacyId(qn) ? 'id' : 'qn' });
    const r = rows[0];
    return json({
      success: true,
      found: true,
      qn,
      matchedBy: isLegacyId(qn) ? 'id' : 'qn',
      question: {
        id: r.id,
        qn: r.stable_qn_id,
        text: r.question_text,
        options: r.options,
        correctIndex: r.correct_index,
        correctText: r.correct_text,
        explanation: r.explanation,
        correctedAt: r.corrected_at,
      },
    });
  } catch (e) {
    return failed(e);
  }
}

/* Apply the correction in Neon: the question keeps its qn id, its options and
   its place, and the previous answer is written to applied_corrections so the
   change can be traced back to the report that caused it. */
export async function adminneoncorrect(params: Record<string, unknown>) {
  const auth = await authAdmin(params);
  if (!auth.ok) return json(auth.error);
  if (!neonConfigured()) return missing();

  const qn = qnOf(params.qn ?? params.qid);
  if (!qn) return json({ success: false, error: 'A public question id looks like 70024.730011.' });
  const matchedBy = isLegacyId(qn) ? 'id' : 'qn';

  const rawIndex = params.correctIndex;
  let correctIndex: number | null = null;
  if (rawIndex !== null && rawIndex !== undefined && String(rawIndex).trim() !== '') {
    const n = Number(rawIndex);
    if (!Number.isInteger(n) || n < 0 || n > 9) {
      return json({ success: false, error: 'The correct option must be a whole number from 0 to 9.' });
    }
    correctIndex = n;
  }
  const explanation = params.explanation == null ? null : String(params.explanation).slice(0, 4000);
  const fileId = String(params.fileId || '').trim().slice(0, 200) || null;
  const uid = (String(params.uid || '').trim().slice(0, 200))
    || (fileId ? fileId + '_' + String(params.index ?? '') : 'admin-console');
  const note = String(params.note || '').trim().slice(0, 500)
    || ('Corrected from the admin console for qn ' + qn);

  try {
    const rows = await neonQuery(
      `with target as (
         select id, stable_qn_id, correct_index, explanation
           from questions
          where ${whereFor(qn)}
          limit 1
       ), updated as (
         update questions q
            set correct_index = $2,
                explanation  = coalesce($3, q.explanation),
                corrected_at = now()
           from target t
          where q.id = t.id
        returning q.id, q.stable_qn_id, q.correct_index, q.explanation, q.corrected_at
       ), audit as (
         insert into applied_corrections
                (uid, corrected_at, question_id, file_id, notes, before_identity, after_identity, matched_by)
         select $4, now(), u.id, $5, $6,
                'correct_index=' || coalesce(t.correct_index::text, 'null'),
                'correct_index=' || coalesce(u.correct_index::text, 'null'),
                'admin-console'
           from updated u
           join target t on t.id = u.id
        returning uid
       )
       select u.id, u.stable_qn_id, u.correct_index, u.explanation, u.corrected_at,
              t.correct_index as before_index, t.explanation as before_explanation,
              (select count(*)::int from audit) as audited
         from updated u
         join target t on t.id = u.id`,
      [paramFor(qn), correctIndex, explanation, uid, fileId, note],
    );
    if (!rows.length) {
      return json({ success: false, notFound: true, qn, matchedBy, error: 'No question in Neon carries that qn id.' });
    }
    const r = rows[0];
    return json({
      success: true,
      qn,
      matchedBy,
      audited: r.audited,
      before: { correctIndex: r.before_index, explanation: r.before_explanation },
      after: {
        id: r.id,
        qn: r.stable_qn_id,
        correctIndex: r.correct_index,
        explanation: r.explanation,
        correctedAt: r.corrected_at,
      },
    });
  } catch (e) {
    return failed(e);
  }
}
