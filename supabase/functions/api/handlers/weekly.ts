import { supabase, selectAll } from '../_shared/db.ts';
import { recordDeletion } from '../_shared/tombstones.ts';
import { json, dbMsg } from '../_shared/http.ts';
import { authUser, authAdmin, requireAccess } from '../_shared/auth.ts';
import { WEEKLY_EXAM_WINDOW_MS } from '../_shared/config.ts';
import { rowToWeeklySet, rowToWeeklyAttempt, weeklyMarks, statObject } from '../_shared/utils.ts';
import { scoreWeekly } from '../_shared/weekly-score.ts';
import { buildQidIndex, qidCoverage, fileRev, flattenQuestions, primaryQid, correctOf } from '../_shared/qid.ts';
import { rescoreAttempt } from '../_shared/weekly-score.ts';
import { registerFileIndex } from '../_shared/qindex.ts';

export async function listweeklysets(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  const { data, error } = await supabase.from('weekly_sets').select('*');
  if (error) return json({ success: false, error: dbMsg(error) });
  const now = Date.now();

  const sets = (data || []).map(rowToWeeklySet)
    .filter(s => {
      const rel = new Date(s.releaseAt).getTime();
      const released = !isNaN(rel) && now >= rel;
      return s.status === 'active' || (s.status === 'archived' && released);
    })
    .map(s => {
      const rel = new Date(s.releaseAt).getTime();
      const released = !isNaN(rel) && now >= rel;
      return { id: s.id, title: s.title, chapterLabel: s.chapterLabel, releaseAt: s.releaseAt, released, fileId: released ? s.fileId : undefined };
    })
    .sort((a, b) => new Date(a.releaseAt).getTime() - new Date(b.releaseAt).getTime());

  return json({ success: true, sets });
}

export async function startweeklyattempt(params: Record<string, unknown>) {
  const weeklyId = String(params.weeklyId || '').trim();
  if (!weeklyId) return json({ success: false, error: 'Missing parameters.' });
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  const { data: wsRows } = await supabase.from('weekly_sets').select('*').eq('id', weeklyId).limit(1);
  const ws = wsRows && wsRows[0] ? rowToWeeklySet(wsRows[0]) : null;
  if (!ws) return json({ success: false, error: 'Weekly set not found.' });

  const release = new Date(ws.releaseAt).getTime();
  if (isNaN(release) || Date.now() < release) return json({ success: false, error: 'This weekly set is not open yet.' });

  const { data: attRows } = await supabase.from('weekly_attempts').select('*').eq('username', auth.username).eq('weekly_id', weeklyId).limit(1);
  if (attRows && attRows[0]) return json({ success: true, alreadyAttempted: true, attempt: rowToWeeklyAttempt(attRows[0]) });

  if (Date.now() > release + WEEKLY_EXAM_WINDOW_MS) return json({ success: true, windowClosed: true });

  const { data: startRows } = await supabase.from('weekly_starts').select('*').eq('username', auth.username).eq('weekly_id', weeklyId).limit(1);
  if (startRows && startRows[0]) {
    return json({ success: true, resumed: true, startedAt: Number(startRows[0].started_at || 0), serverNow: Date.now() });
  }

  const now = Date.now();
  const { error } = await supabase.from('weekly_starts').insert({ username: auth.username, weekly_id: weeklyId, started_at: now });
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, resumed: false, startedAt: now, serverNow: now });
}

export async function getweeklyattempt(params: Record<string, unknown>) {
  const weeklyId = String(params.weeklyId || '').trim();
  if (!weeklyId) return json({ success: false, error: 'Missing parameters.' });
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);

  const { data } = await supabase.from('weekly_attempts').select('*').eq('username', auth.username).eq('weekly_id', weeklyId).limit(1);
  return json({ success: true, attempt: data && data[0] ? rowToWeeklyAttempt(data[0]) : null });
}

export async function getmyweeklyattempts(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data, error } = await supabase.from('weekly_attempts').select('*').eq('username', auth.username).order('submitted_at', { ascending: false });
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, attempts: (data || []).map(rowToWeeklyAttempt) });
}

export async function submitweeklyattempt(params: Record<string, unknown>) {
  const weeklyId = String(params.weeklyId || '').trim();
  if (!weeklyId) return json({ success: false, error: 'Missing parameters.' });
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  const { data: wsRows } = await supabase.from('weekly_sets').select('*').eq('id', weeklyId).limit(1);
  const ws = wsRows && wsRows[0] ? rowToWeeklySet(wsRows[0]) : null;
  if (!ws) return json({ success: false, error: 'Weekly set not found.' });

  const releaseTime = new Date(ws.releaseAt).getTime();
  if (isNaN(releaseTime) || Date.now() < releaseTime) return json({ success: false, error: "This weekly set hasn't been released yet." });
  if (Date.now() > releaseTime + WEEKLY_EXAM_WINDOW_MS + 3 * 60 * 60 * 1000) return json({ success: false, error: 'The exam window for this set has closed.' });

  // The server holds the answer key and scores by question id against the paper
  // frozen at creation. The legacy positional `answers` array is still accepted
  // and converted by the scoring core; it is never trusted for its positions.
  const hasQid = params.answersByQid !== undefined && String(params.answersByQid ?? '') !== '';
  let scored: ReturnType<typeof scoreWeekly>;
  try {
    const { data: blob, error: dlErr } = await supabase.storage.from('weekly-sets').download(ws.fileId);
    if (dlErr || !blob) return json({ success: false, error: 'Could not load weekly set for scoring. Please try again.' });
    const raw = JSON.parse(await blob.text());
    scored = scoreWeekly({
      raw, frozenQids: ws.qids,
      answersByQid: hasQid ? params.answersByQid : undefined,
      answers: hasQid ? undefined : params.answers ?? '[]',
    });
  } catch {
    return json({ success: false, error: 'Could not score submission. Please try again.' });
  }
  if (!scored.ok) return json({ success: false, error: scored.error, code: scored.code });
  const { total, correct: correctFinal, skipped } = scored;
  const normalized = scored.answers;

  const { data: existing } = await supabase.from('weekly_attempts').select('*').eq('username', auth.username).eq('weekly_id', weeklyId).limit(1);
  if (existing && existing[0]) return json({ success: false, alreadyAttempted: true, attempt: rowToWeeklyAttempt(existing[0]), error: 'This weekly set has already been submitted.' });

  const submittedAt = Date.now();
  const { data: startRows } = await supabase.from('weekly_starts').select('*').eq('username', auth.username).eq('weekly_id', weeklyId).limit(1);
  const serverStart = startRows && startRows[0] ? Number(startRows[0].started_at || 0) : 0;

  let startedAt: number;
  let durationSec: number;
  if (serverStart > 0 && serverStart <= submittedAt) {
    startedAt = serverStart;
    durationSec = Math.max(0, Math.min(6 * 60 * 60, Math.round((submittedAt - startedAt) / 1000)));
  } else {
    durationSec = Math.max(0, Math.min(6 * 60 * 60, Number(params.durationSec) || 0));
    startedAt = submittedAt - durationSec * 1000;
  }

  const { error } = await supabase.from('weekly_attempts').insert({
    username: auth.username, weekly_id: weeklyId, answers_json: JSON.stringify(normalized),
    answers_by_qid: JSON.stringify(scored.answersByQid), qids: JSON.stringify(scored.qids.filter(Boolean)),
    file_rev: scored.fileRev, voided: JSON.stringify(scored.voided),
    total_questions: total, correct_claimed: correctFinal, skipped_count: skipped,
    started_at: startedAt, submitted_at: submittedAt, duration_sec: durationSec,
  });
  if (error) return json({ success: false, error: dbMsg(error) });

  return json({ success: true, mode: scored.mode, warnings: scored.warnings, attempt: { weeklyId, answers: normalized, answersByQid: scored.answersByQid, qids: scored.qids.filter(Boolean), voided: scored.voided, total, correct: correctFinal, pct: weeklyMarks(correctFinal, skipped, total).pct, skipped, startedAt, submittedAt, durationSec, synced: true } });
}

export async function getweeklystanding(params: Record<string, unknown>) {
  const weeklyId = String(params.weeklyId || '').trim();
  if (!weeklyId) return json({ success: false, error: 'Missing parameters.' });
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  const { data: wsRows } = await supabase.from('weekly_sets').select('*').eq('id', weeklyId).limit(1);
  const ws = wsRows && wsRows[0] ? rowToWeeklySet(wsRows[0]) : null;
  if (!ws) return json({ success: false, error: 'Weekly set not found.' });

  const release = new Date(ws.releaseAt).getTime();
  if (isNaN(release) || Date.now() <= release + WEEKLY_EXAM_WINDOW_MS) return json({ success: true, ready: false, message: 'Rankings appear when the exam window closes.' });

  // Page through ALL attempts: a plain select() stops at 1000 rows and would corrupt ranks.
  let data: any[];
  try { data = await selectAll('weekly_attempts', '*', { orderBy: 'username', apply: q => q.eq('weekly_id', weeklyId) }); }
  catch (error) { return json({ success: false, error: dbMsg(error) }); }

  const me = auth.username.toLowerCase();
  const scores: number[] = [];
  let mine: number | null = null;

  (data || []).forEach((row: Record<string, unknown>) => {
    const total = Number(row.total_questions || 0);
    const correct = Number(row.correct_claimed || 0);
    const skipped = Number(row.skipped_count || 0);
    const pct = weeklyMarks(correct, skipped, total).exactPct;
    scores.push(pct);
    if (String(row.username || '').toLowerCase().trim() === me) mine = pct;
  });

  if (mine === null) return json({ success: true, ready: true, attempted: false });
  const better = scores.filter(s => s > mine!).length;
  const rank = better + 1;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return json({ success: true, ready: true, attempted: true, rank, total: scores.length, percentile: scores.length > 1 ? Math.round(((scores.length - rank) / (scores.length - 1)) * 100) : 100, avgPct: Math.max(0, Math.round(avg)) });
}

export async function admincreateweeklyset(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'weeklysets_manage');
  if (!admin.ok) return json(admin.error);
  const title = String(params.title || '').trim().slice(0, 120);
  const fileId = String(params.fileId || '').trim();
  const chapterLabel = String(params.chapterLabel || '').trim().slice(0, 120);
  const releaseAtRaw = String(params.releaseAt || '').trim();
  if (!title || !fileId) return json({ success: false, error: 'Title and fileId required.' });
  const releaseAt = new Date(releaseAtRaw);
  if (!releaseAtRaw || isNaN(releaseAt.getTime())) return json({ success: false, error: 'A valid release date/time is required.' });

  // The file must already be in the weekly-sets bucket, otherwise nobody could ever be scored on it.
  if (!(await statObject('weekly-sets', fileId))) return json({ success: false, error: 'File not found in weekly-sets storage. Upload it first.' });

  const { data: dupe } = await supabase.from('weekly_sets').select('id,title').eq('file_id', fileId).limit(1);
  const duplicateOf = dupe && dupe[0] ? String(dupe[0].title) : null;

  // Freeze the paper: the ordered qid list + revision as they are NOW. Scoring
  // and re-scoring are always against these question ids, never positions.
  const paper = await freezePaper(fileId);
  if (paper.error) return json({ success: false, error: paper.error });

  const id = crypto.randomUUID();
  const { error } = await supabase.from('weekly_sets').insert({
    id, title, file_id: fileId, chapter_label: chapterLabel, status: 'active', uploaded_by: admin.username,
    uploaded_at: new Date().toISOString(), release_at: releaseAt.toISOString(),
    qids: JSON.stringify(paper.qids), file_rev: paper.rev,
  });
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({
    success: true, id, title, releaseAt: releaseAt.toISOString(),
    qidReady: paper.qidReady, qidCoverage: paper.coverage, frozenQuestions: paper.qids.length,
    duplicateWarning: duplicateOf ? `This fileId is already used by weekly set "${duplicateOf}" — double check.` : null,
    qidWarning: paper.qidReady ? null : 'Some questions have no unique id; this set will be scored by position (legacy). Add ids and re-create the set for reorder-safe scoring.',
  });
}

/** Reads a weekly file once and returns what must be frozen on the set. */
async function freezePaper(fileId: string): Promise<{ qids: string[]; rev: string; qidReady: boolean; coverage: ReturnType<typeof qidCoverage> | null; error?: string }> {
  try {
    const { data: blob, error } = await supabase.storage.from('weekly-sets').download(fileId);
    if (error || !blob) return { qids: [], rev: '', qidReady: false, coverage: null, error: 'Could not read the weekly file to freeze its questions.' };
    const raw = JSON.parse(await blob.text());
    const coverage = qidCoverage(raw);
    const qidReady = coverage.total > 0 && coverage.missing === 0 && coverage.duplicates.length === 0;
    if (coverage.duplicates.length) return { qids: [], rev: '', qidReady: false, coverage, error: `Duplicate question ids in this file: ${coverage.duplicates.slice(0, 5).join(', ')}. Fix them and re-upload.` };
    await registerFileIndex(fileId, raw);
    return { qids: qidReady ? buildQidIndex(raw).map(r => r.qid) : [], rev: fileRev(flattenQuestions(raw)), qidReady, coverage };
  } catch {
    return { qids: [], rev: '', qidReady: false, coverage: null, error: 'The weekly file could not be parsed.' };
  }
}

export async function adminupdateweeklyset(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'weeklysets_manage');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'id required.' });

  const patch: Record<string, unknown> = {};
  if (params.title !== undefined) patch.title = String(params.title).trim().slice(0, 120);
  if (params.fileId !== undefined) {
    const newFile = String(params.fileId).trim();
    const { data: cur } = await supabase.from('weekly_sets').select('file_id').eq('id', id).limit(1);
    if (cur && cur[0] && String(cur[0].file_id) !== newFile) {
      // Swapping the paper under students who already answered it would score
      // their answers against different questions. Create a new set instead.
      const { data: att } = await supabase.from('weekly_attempts').select('username').eq('weekly_id', id).limit(1);
      if (att && att[0] && String(params.force || '') !== 'true') {
        return json({ success: false, error: 'Students have already attempted this set; changing its file would re-score them against different questions. Create a new set (or pass force=true to re-freeze).' });
      }
      const paper = await freezePaper(newFile);
      if (paper.error) return json({ success: false, error: paper.error });
      patch.qids = JSON.stringify(paper.qids); patch.file_rev = paper.rev;
    }
    patch.file_id = newFile;
  }
  if (params.chapterLabel !== undefined) patch.chapter_label = String(params.chapterLabel).trim().slice(0, 120);
  if (params.status !== undefined && ['active','archived'].includes(String(params.status))) patch.status = params.status;
  if (params.releaseAt !== undefined) {
    const d = new Date(String(params.releaseAt));
    if (isNaN(d.getTime())) return json({ success: false, error: 'Invalid release date/time.' });
    patch.release_at = d.toISOString();
  }
  if (!Object.keys(patch).length) return json({ success: true, id });
  const { error } = await supabase.from('weekly_sets').update(patch).eq('id', id);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, id });
}

export async function admindeleteweeklyset(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'weeklysets_manage');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'id required.' });
  const { error } = await supabase.from('weekly_sets').delete().eq('id', id);
  if (error) return json({ success: false, error: dbMsg(error) });
  await recordDeletion('weekly_sets', [id]);
  return json({ success: true, deleted: id });
}

export async function adminlistweeklysets(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'weeklysets_view');
  if (!admin.ok) return json(admin.error);
  const { data, error } = await supabase.from('weekly_sets').select('*');
  if (error) return json({ success: false, error: dbMsg(error) });
  const sets = (data || []).map(rowToWeeklySet).sort((a, b) => new Date(a.releaseAt).getTime() - new Date(b.releaseAt).getTime());
  return json({ success: true, sets, totalCount: sets.length, truncated: false });
}

export async function adminweeklysetresults(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'weeklysets_view');
  if (!admin.ok) return json(admin.error);
  const weeklyId = String(params.weeklyId || '').trim();
  if (!weeklyId) return json({ success: false, error: 'weeklyId required.' });

  const { data: wsRows } = await supabase.from('weekly_sets').select('*').eq('id', weeklyId).limit(1);
  const ws = wsRows && wsRows[0] ? rowToWeeklySet(wsRows[0]) : null;
  if (!ws) return json({ success: false, error: 'Weekly set not found.' });

  let data: any[];
  try { data = await selectAll('weekly_attempts', '*', { orderBy: 'username', apply: q => q.eq('weekly_id', weeklyId) }); }
  catch (error) { return json({ success: false, error: dbMsg(error) }); }

  const attempts = (data || []).map(r => {
    const at = rowToWeeklyAttempt(r);
    const wrong = Math.max(0, at.total - at.correct - at.skipped);
    const denom = at.total || 1;
    const pct = weeklyMarks(at.correct, at.skipped, denom).pct;
    return { username: String(r.username || ''), pct, correct: at.correct, wrong, skipped: at.skipped, total: at.total, durationSec: at.durationSec, submittedAt: at.submittedAt };
  });

  if (!attempts.length) return json({ success: true, weeklyId, title: ws.title, attempts: 0, uniqueStudents: 0, rescored: false });

  // Per-question analysis, keyed by qid (position-free): who answered, who got it right.
  let questionStats: Array<Record<string, unknown>> = [];
  let paperChanged = false;
  try {
    const { data: blob } = await supabase.storage.from('weekly-sets').download(ws.fileId);
    if (blob) {
      const raw = JSON.parse(await blob.text());
      const arr = flattenQuestions(raw);
      paperChanged = !!ws.fileRev && ws.fileRev !== fileRev(arr);
      const key = new Map<string, number | string | undefined>(arr.map((q: any) => [primaryQid(q).qid, correctOf(q)] as [string, number | string | undefined]));
      const tally = new Map<string, { answered: number; right: number; skipped: number }>();
      for (const r of data || []) {
        let m: Record<string, number | null> = {};
        try { m = JSON.parse(String(r.answers_by_qid || '{}')); } catch { /* legacy row */ }
        for (const [qid, a] of Object.entries(m)) {
          const t = tally.get(qid) || { answered: 0, right: 0, skipped: 0 };
          if (a === null || a === undefined) t.skipped++;
          else { t.answered++; const e = key.get(qid); if ((typeof e === 'number' && a === e) || (typeof e === 'string' && String(a) === e)) t.right++; }
          tally.set(qid, t);
        }
      }
      questionStats = [...tally.entries()].map(([qid, t]) => ({
        qid, answered: t.answered, correct: t.right, skipped: t.skipped,
        pctCorrect: t.answered ? Math.round((t.right / t.answered) * 100) : null,
      })).sort((a, b) => ((a.pctCorrect as number) ?? 101) - ((b.pctCorrect as number) ?? 101));
    }
  } catch { /* analysis is optional */ }

  const pcts = attempts.map(a => a.pct);
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const sorted = [...pcts].sort((a, b) => a - b);
  const variance = pcts.reduce((acc, v) => acc + (v - mean) ** 2, 0) / pcts.length;
  const buckets = Array.from({ length: 10 }, (_, i) => ({ range: `${i*10}-${i*10+9}`, count: 0 }));
  pcts.forEach(v => { buckets[Math.min(9, Math.floor(v / 10))].count++; });

  return json({
    success: true, weeklyId, title: ws.title, attempts: attempts.length, uniqueStudents: attempts.length,
    avgPct: Math.round(mean), minPct: sorted[0], maxPct: sorted[sorted.length - 1],
    stdDev: Math.round(Math.sqrt(variance)), distribution: buckets,
    recent: attempts.sort((a, b) => b.submittedAt - a.submittedAt).slice(0, 50), rescored: false,
    paperChanged, questionStats: questionStats.slice(0, 200),
  });
}

/** Re-scores every qid-keyed attempt of a set against the file's CURRENT answer
 *  key — the explicit, auditable way to apply an admin correction to a weekly
 *  result. Attempts are matched to questions by qid, so a reordered or edited
 *  file re-scores exactly the right questions. `dryRun=true` only reports. */
export async function adminrescoreweeklyset(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'weeklysets_manage');
  if (!admin.ok) return json(admin.error);
  const weeklyId = String(params.weeklyId || '').trim();
  if (!weeklyId) return json({ success: false, error: 'weeklyId required.' });
  const dryRun = String(params.dryRun ?? 'true') !== 'false';

  const { data: wsRows } = await supabase.from('weekly_sets').select('*').eq('id', weeklyId).limit(1);
  const ws = wsRows && wsRows[0] ? rowToWeeklySet(wsRows[0]) : null;
  if (!ws) return json({ success: false, error: 'Weekly set not found.' });

  let raw: unknown;
  try {
    const { data: blob, error } = await supabase.storage.from('weekly-sets').download(ws.fileId);
    if (error || !blob) return json({ success: false, error: 'Could not read the weekly file.' });
    raw = JSON.parse(await blob.text());
  } catch { return json({ success: false, error: 'The weekly file could not be parsed.' }); }

  let rows: any[];
  try { rows = await selectAll('weekly_attempts', '*', { orderBy: 'username', apply: q => q.eq('weekly_id', weeklyId) }); }
  catch (error) { return json({ success: false, error: dbMsg(error) }); }

  const rev = fileRev(flattenQuestions(raw));
  const changes: Array<Record<string, unknown>> = [];
  let examined = 0, legacySkipped = 0, changed = 0, failed = 0;
  for (const r of rows) {
    let byQid: Record<string, unknown> = {};
    try { byQid = JSON.parse(String(r.answers_by_qid || '{}')); } catch { /* legacy */ }
    if (!Object.keys(byQid).length) { legacySkipped++; continue; }   // pre-qid attempt: cannot be re-scored safely
    examined++;
    let frozen: string[] = ws.qids;
    try { const f = JSON.parse(String(r.qids || '[]')); if (Array.isArray(f) && f.length) frozen = f.map(String); } catch { /* keep set's */ }
    const sc = rescoreAttempt(raw, frozen, byQid);
    if (!sc.ok) { failed++; continue; }
    const before = { correct: Number(r.correct_claimed || 0), total: Number(r.total_questions || 0), skipped: Number(r.skipped_count || 0) };
    if (before.correct === sc.correct && before.total === sc.total && before.skipped === sc.skipped && String(r.file_rev || '') === rev) continue;
    changed++;
    if (changes.length < 50) changes.push({ username: r.username, before, after: { correct: sc.correct, total: sc.total, skipped: sc.skipped } });
    if (!dryRun) {
      await supabase.from('weekly_attempts').update({
        correct_claimed: String(sc.correct), total_questions: String(sc.total), skipped_count: String(sc.skipped),
        file_rev: rev, voided: JSON.stringify(sc.voided),
      }).eq('username', r.username).eq('weekly_id', weeklyId);
    }
  }
  return json({ success: true, weeklyId, dryRun, examined, changed, legacySkipped, failed, fileRev: rev, changes });
}
