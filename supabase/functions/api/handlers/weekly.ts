import { supabase, selectAll } from '../_shared/db.ts';
import { recordDeletion } from '../_shared/tombstones.ts';
import { json, dbMsg } from '../_shared/http.ts';
import { authUser, authAdmin, requireAccess } from '../_shared/auth.ts';
import { WEEKLY_EXAM_WINDOW_MS } from '../_shared/config.ts';
import { rowToWeeklySet, rowToWeeklyAttempt, weeklyMarks, extractCorrectAnswers, scoreAnswers, statObject } from '../_shared/utils.ts';

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

  let answers: unknown[];
  try { answers = JSON.parse(String(params.answers || '[]')); } catch { return json({ success: false, error: 'Malformed answers array.' }); }
  if (!Array.isArray(answers) || !answers.length || answers.length > 500) return json({ success: false, error: 'Invalid answers array.' });

  const normalized = answers.map(a => {
    if (a === null || a === undefined) return null;
    const n = Number(a);
    return Number.isInteger(n) && n >= 0 && n < 10 ? n : null;
  });
  const total = normalized.length;
  const skipped = normalized.filter(a => a === null).length;

  // ── FIX SEC-01 ────────────────────────────────────────────────────
  // The server MUST verify the answer key exists and matches the submitted
  // length. Previously the code fell back to client-supplied correctCount,
  // which allowed any authenticated user to fabricate their score.
  let correctFinal: number;
  try {
    const { data: blob, error: dlErr } = await supabase.storage.from('weekly-sets').download(ws.fileId);
    if (dlErr || !blob) {
      return json({ success: false, error: 'Could not load weekly set for scoring. Please try again.' });
    }
    const raw = JSON.parse(await blob.text());
    const key = extractCorrectAnswers(raw);
    if (!key || key.length !== total) {
      return json({
        success: false,
        error: 'This weekly set is missing a valid answer key or the question count does not match. Contact the admin.',
      });
    }
    correctFinal = scoreAnswers(normalized, key);
  } catch {
    return json({ success: false, error: 'Could not score submission. Please try again.' });
  }

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
    total_questions: total, correct_claimed: correctFinal, skipped_count: skipped,
    started_at: startedAt, submitted_at: submittedAt, duration_sec: durationSec,
  });
  if (error) return json({ success: false, error: dbMsg(error) });

  return json({ success: true, attempt: { weeklyId, answers: normalized, total, correct: correctFinal, pct: weeklyMarks(correctFinal, skipped, total).pct, skipped, startedAt, submittedAt, durationSec, synced: true } });
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

  const id = crypto.randomUUID();
  const { error } = await supabase.from('weekly_sets').insert({ id, title, file_id: fileId, chapter_label: chapterLabel, status: 'active', uploaded_by: admin.username, uploaded_at: new Date().toISOString(), release_at: releaseAt.toISOString() });
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, id, title, releaseAt: releaseAt.toISOString(), duplicateWarning: duplicateOf ? `This fileId is already used by weekly set "${duplicateOf}" — double check.` : null });
}

export async function adminupdateweeklyset(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'weeklysets_manage');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'id required.' });

  const patch: Record<string, unknown> = {};
  if (params.title !== undefined) patch.title = String(params.title).trim().slice(0, 120);
  if (params.fileId !== undefined) patch.file_id = String(params.fileId).trim();
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
  });
}