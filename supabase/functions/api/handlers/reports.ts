import { supabase } from '../_shared/db.ts';
import { json, dbMsg } from '../_shared/http.ts';
import { authUser, authAdmin } from '../_shared/auth.ts';
import { CORRECTIONS_SETTING_KEY } from '../_shared/config.ts';
import { randId } from '../_shared/crypto.ts';
import { markFileCorrected } from '../_shared/utils.ts';

function safeJsonParse<T = unknown>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export async function reportquestion(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const uid = String(params.uid || '').trim();
  const reason = String(params.reason || '').trim();
  if (!uid || !reason) return json({ success: false, error: 'uid_and_reason_required' });

  const { data: existing } = await supabase.from('question_reports').select('id').eq('reported_by', auth.username).eq('uid', uid).eq('status', 'open').limit(1);
  if (existing && existing[0]) return json({ success: true, id: existing[0].id, deduped: true });

  const p: Record<string, unknown> = {
    ...params, file_id: params.file_id ?? params.fileId,
    question_snapshot: params.question_snapshot ?? params.questionSnapshot,
    options_snapshot: params.options_snapshot ?? params.optionsSnapshot,
    correct_index: params.correct_index ?? params.correctIndex,
    chosen_index: params.chosen_index ?? params.chosenIndex,
    app_version: params.app_version ?? params.appVersion,
  };
  const asStr = (v: unknown, fb = '') => typeof v === 'string' ? v : v == null ? fb : JSON.stringify(v);

  // ── FIX BUG-02 / SEC-02 ──────────────────────────────────────────
  // Snapshots MUST be validated. A malformed JSON string from a user was
  // previously stored as-is and crashed adminlistquestionreports for every
  // admin because the read path called JSON.parse without try/catch.
  const safeSnap = (v: unknown, fallbackJson: string): string => {
    const raw = asStr(v, fallbackJson);
    try { JSON.parse(raw); return raw; } catch { return fallbackJson; }
  };

  const id = 'RPT-' + Date.now().toString(36) + '-' + randId();

  const { error } = await supabase.from('question_reports').insert({
    id, uid,
    file_id: asStr(p.file_id),
    question_snapshot: asStr(p.question_snapshot),
    options_snapshot: safeSnap(p.options_snapshot, '[]'),
    correct_index: Number.isInteger(p.correct_index) ? p.correct_index : null,
    chosen_index: Number.isInteger(p.chosen_index) ? p.chosen_index : null,
    reason, note: asStr(p.note),
    reported_by: auth.username, reported_at: new Date().toISOString(), status: 'open',
    section: asStr(p.section), app_version: asStr(p.app_version),
    resolved_at: '', resolved_by: '', corrected: '', corrected_snapshot: '',
  });
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, id });
}

export async function getmyreports(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data, error } = await supabase.from('question_reports').select('*').eq('reported_by', auth.username).order('reported_at', { ascending: false }).limit(200);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, reports: data || [] });
}

export async function getcorrections(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const since = Number(params.since) || 0;
  const files: Record<string, number> = {};
  try {
    const { data: row } = await supabase.from('settings').select('value').eq('key', CORRECTIONS_SETTING_KEY).limit(1);
    if (row && row[0]) {
      const parsed = JSON.parse(String(row[0].value || '{}'));
      Object.keys(parsed || {}).forEach(k => { const t = Number(parsed[k]); if (isFinite(t) && t > since) files[k] = t; });
    }
  } catch { /* ignore */ }

  const { data: reports } = await supabase.from('question_reports').select('uid,resolved_at').eq('reported_by', auth.username).eq('status', 'resolved').order('resolved_at', { ascending: false }).limit(50);
  const resolvedMine = (reports || []).map(r => ({ uid: String(r.uid || ''), at: new Date(String(r.resolved_at || '')).getTime() || 0 })).filter(r => r.uid && r.at > since).slice(0, 10);
  return json({ success: true, now: Date.now(), files, resolvedMine });
}

export async function gethardquestions(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data: rows } = await supabase.from('progress').select('data');
  const tally: Record<string, { n: number; w: number }> = {};
  (rows || []).forEach((row: { data?: string }) => {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.data || '{}')); } catch { return; }
    const sessions = (parsed as any)?.prog?.sessions;
    if (!Array.isArray(sessions)) return;
    for (const s of sessions) {
      const qres = (s as any)?.qres;
      if (!Array.isArray(qres)) continue;
      for (const qr of qres) {
        const uid = (qr as any)?.uid;
        if (!uid) continue;
        const r = tally[uid] || (tally[uid] = { n: 0, w: 0 });
        r.n++; if (!(qr as any).ok) r.w++;
      }
    }
  });
  const map: Record<string, number> = {};
  Object.keys(tally).forEach(uid => { const r = tally[uid]; if (r.n >= 20) map[uid] = Math.round((r.w / r.n) * 100); });
  return json({ success: true, map });
}

export async function adminlistquestionreports(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_view');
  if (!admin.ok) return json(admin.error);
  const limit = Math.min(Number(params.limit) || 2000, 2000);
  let q = supabase.from('question_reports').select('*');
  if (params.status) q = q.eq('status', String(params.status));
  if (params.reason) q = q.eq('reason', String(params.reason));
  if (params.file_id) q = q.eq('file_id', String(params.file_id));
  if (params.reported_by) q = q.eq('reported_by', String(params.reported_by));
  q = q.order('reported_at', { ascending: false }).limit(limit);

  const { data, error } = await q;
  if (error) return json({ success: false, error: dbMsg(error) });

  // FIX BUG-02 (defense-in-depth): every JSON.parse is now guarded.
  const reports = (data || []).map(r => ({
    id: r.id, uid: r.uid, fileId: r.file_id, questionSnapshot: r.question_snapshot,
    reason: r.reason, note: r.note, reportedBy: r.reported_by, reportedAt: r.reported_at,
    status: r.status,
    options: safeJsonParse<unknown[]>(r.options_snapshot, []),
    correctIndex: r.correct_index, chosenIndex: r.chosen_index,
    section: r.section, appVersion: r.app_version, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
    corrected: r.corrected === 'true',
    correctedSnapshot: r.corrected_snapshot ? safeJsonParse<unknown>(r.corrected_snapshot, null) : null,
    openReporters: 0,
  }));

  const openBy: Record<string, Set<string>> = {};
  reports.forEach(r => { if (r.status === 'open') { if (!openBy[r.uid]) openBy[r.uid] = new Set(); openBy[r.uid].add(r.reportedBy); } });
  reports.forEach(r => { r.openReporters = r.status === 'open' ? (openBy[r.uid]?.size || 0) : 0; });
  return json({ success: true, reports, totalCount: reports.length, truncated: false });
}

export async function adminupdatequestionreportstatus(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_manage');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '');
  const status = String(params.status || '');
  if (!id) return json({ success: false, error: 'id required' });
  if (!['open', 'resolved', 'dismissed'].includes(status)) return json({ success: false, error: 'Invalid status' });

  const patch: Record<string, unknown> = { status, resolved_at: new Date().toISOString(), resolved_by: admin.username };
  const signal = status === 'resolved' && String(params.corrected) !== 'false';
  if (signal) patch.corrected = 'true';
  if (params.corrected_snapshot !== undefined) {
    patch.corrected_snapshot = typeof params.corrected_snapshot === 'string' ? params.corrected_snapshot : JSON.stringify(params.corrected_snapshot);
  }
  if (Number.isInteger(params.corrected_index)) patch.correct_index = params.corrected_index;
  if (typeof params.note === 'string') patch.note = params.note;

  const { data: target } = await supabase.from('question_reports').select('uid, file_id').eq('id', id).limit(1);
  if (!target || !target[0]) return json({ success: false, error: 'not_found' });

  const { error } = await supabase.from('question_reports').update(patch).eq('id', id);
  if (error) return json({ success: false, error: dbMsg(error) });

  let alsoClosed = 0;
  if (status === 'resolved') {
    const { data: primary } = await supabase.from('question_reports').select('corrected_snapshot,correct_index').eq('id', id).limit(1);
    const snap = primary && primary[0] ? String(primary[0].corrected_snapshot || '') : '';
    const idx = primary && primary[0] ? primary[0].correct_index : null;

    const { data: siblings } = await supabase.from('question_reports').select('id').eq('uid', target[0].uid).eq('status', 'open').neq('id', id);
    for (const s of (siblings || [])) {
      const sibPatch: Record<string, unknown> = {
        status: 'resolved', resolved_at: patch.resolved_at, resolved_by: patch.resolved_by, corrected: 'true',
      };
      if (snap) sibPatch.corrected_snapshot = snap;
      if (idx !== null && idx !== undefined) sibPatch.correct_index = idx;
      await supabase.from('question_reports').update(sibPatch).eq('id', s.id);
      alsoClosed++;
    }
    if (signal && target[0].file_id) await markFileCorrected(String(target[0].file_id));
  }
  return json({ success: true, id, status, alsoClosed, refreshed: signal });
}

export async function admindeletequestionreport(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_manage');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '');
  if (!id) return json({ success: false, error: 'id required' });
  const { error } = await supabase.from('question_reports').delete().eq('id', id);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, deleted: id });
}

export async function getreport(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_view');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '');
  if (!id) return json({ success: false, error: 'id_required' });
  const { data } = await supabase.from('question_reports').select('*').eq('id', id).limit(1);
  if (!data || !data[0]) return json({ success: false, error: 'not_found' });
  return json({ success: true, report: data[0] });
}

// ── FIX BUG-07 helper: enumerate questions regardless of file shape ──
function flattenQuestions(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.sections)) {
    const fromSections = (o.sections as any[]).flatMap(s => Array.isArray(s?.questions) ? s.questions : []);
    if (fromSections.length) return fromSections;
  }
  if (Array.isArray(o.questions)) return o.questions;
  return [];
}

export async function admingetquestion(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_manage');
  if (!admin.ok) return json(admin.error);
  const fileId = String(params.fileId || '').trim();
  const index = Number(params.index);
  if (!fileId || isNaN(index) || index < 0) return json({ success: false, error: 'Invalid reference' });

  try {
    const { data: blob, error } = await supabase.storage.from('subjective-content').download(fileId);
    if (error || !blob) throw new Error('File not found');
    const raw = JSON.parse(await blob.text());
    const arr = flattenQuestions(raw);
    if (!arr[index]) return json({ success: false, error: 'Question not found in file' });
    const q = arr[index];
    return json({ success: true, index, total: arr.length, question: { q: q.q || q.question || '', options: q.options || q.opts || [], correct: q.correct ?? q.answer ?? null, explanation: q.explanation || q.exp || '' } });
  } catch (e) { return json({ success: false, error: 'Could not read file: ' + String(e) }); }
}

export async function adminupdatequestion(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_manage');
  if (!admin.ok) return json(admin.error);
  const fileId = String(params.fileId || '').trim();
  const index = Number(params.index);
  const expectedQ = String(params.expectedQ || '').trim();
  if (!fileId || isNaN(index) || index < 0) return json({ success: false, error: 'Invalid reference' });

  let fields: any;
  try { fields = typeof params.fields === 'string' ? JSON.parse(params.fields) : params.fields; } catch { return json({ success: false, error: 'Invalid fields' }); }

  try {
    const { data: blob, error } = await supabase.storage.from('subjective-content').download(fileId);
    if (error || !blob) throw new Error('File not found');
    const raw = JSON.parse(await blob.text());
    const arr = flattenQuestions(raw);
    if (!arr[index]) return json({ success: false, error: 'Question not found' });

    const currentQ = arr[index].q || arr[index].question || '';
    if (String(currentQ).trim() !== expectedQ) return json({ success: false, error: 'File changed since you opened it. Please reload.' });

    // Verbatim before-side for the correction pipeline (source number and
    // full option text included). The report snapshot is trimmed for display.
    const curCorrect = arr[index].correct ?? arr[index].answer ?? null;
    const beforeEdit = {
      question: String(currentQ),
      options: (Array.isArray(arr[index].options) ? arr[index].options : (arr[index].opts || [])).map(String),
      correctIndex: Number.isInteger(curCorrect) ? curCorrect : null,
    };

    arr[index].q = fields.q; arr[index].options = fields.options; arr[index].correct = fields.correct; arr[index].explanation = fields.explanation;
    const newContent = JSON.stringify(raw);
    const { error: upErr } = await supabase.storage.from('subjective-content').upload(fileId, newContent, { upsert: true, contentType: 'application/json' });
    if (upErr) throw upErr;

    try {
      await markFileCorrected(fileId);
      await supabase.from('settings').upsert({ key: 'contentVersion', value: String(Date.now()) });
    } catch (e) { console.warn('[adminupdatequestion] signal write failed (file already saved):', e); }

    // Per-edit identity: (uid, corrected_at) is the pipeline's idempotency
    // key, so a re-edit or a Restore needs a NEW uid/at or it is skipped as
    // already_applied. Stamp every report for this question (open and
    // resolved) so restores keep propagating.
    const editUid = 'corr_' + randId();
    const editAt = new Date().toISOString();
    const snapshot = {
      uid: editUid, at: editAt, before: beforeEdit,
      after: {
        question: fields.q, options: fields.options,
        correctIndex: fields.correct, explanation: fields.explanation || '',
      },
      // Legacy top-level keys kept for existing console/export readers.
      q: fields.q, options: fields.options, correct: fields.correct,
      explanation: fields.explanation || '',
    };
    try {
      await supabase.from('question_reports')
        .update({ corrected_snapshot: JSON.stringify(snapshot), correct_index: fields.correct })
        .eq('file_id', fileId).eq('uid', `${fileId}_${index}`);
      const reportId = String(params.reportId || '').trim();
      if (reportId) {
        await supabase.from('question_reports')
          .update({ corrected_snapshot: JSON.stringify(snapshot), correct_index: fields.correct })
          .eq('id', reportId);
      }
    } catch (e) { console.warn('[adminupdatequestion] could not populate corrected_snapshot (non-fatal):', e); }

    return json({ success: true });
  } catch (e) { return json({ success: false, error: 'Could not save: ' + String(e) }); }
}


// ── Pipeline sync (sync/apply_corrections.py) ────────────────────────
// POST text/plain JSON: {action:"syncCorrectionsSince", key, since, limit}
// The admin console routes every admin action here (abhyasEndpointFor), so
// this store - not only the Apps Script sheet - has to answer the pipeline.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function synccorrectionssince(params: Record<string, unknown>) {
  const expected = Deno.env.get('SYNC_KEY') || Deno.env.get('ABHYAS_SYNC_KEY') || '';
  if (!expected) {
    return json({ success: false, code: 'not_configured', error: 'SYNC_KEY is not set on the api function.' }, 503);
  }
  const key = String(params.key || '');
  if (!key || !constantTimeEqual(key, expected)) {
    // 401, not success:false — the pipeline turns that into a named auth
    // failure instead of reporting a data problem.
    return json({
      success: false, code: 'unauthorized',
      error: 'ABHYAS_SYNC_KEY does not match SYNC_KEY in the api function environment.',
    }, 401);
  }

  const since = Math.max(0, Number(params.since) || 0);
  const limit = Math.max(1, Math.min(500, Number(params.limit) || 500));

  const { data, error } = await supabase.from('question_reports')
    .select('*').eq('status', 'resolved').eq('corrected', 'true');
  if (error) return json({ success: false, error: dbMsg(error) }, 500);

  const asInt = (v: unknown): number | null => Number.isInteger(v) && (v as number) >= 0 ? v as number : null;
  const byKey = new Map<string, any>();

  for (const r of (data || [])) {
    const snap = safeJsonParse<Record<string, any> | null>(r.corrected_snapshot, null);
    if (!snap) continue;

    const after = (snap.after && typeof snap.after === 'object')
      ? snap.after
      : (snap.q != null
          ? { question: snap.q, options: snap.options, correctIndex: snap.correct, explanation: snap.explanation }
          : null);
    if (!after || !String(after.question || '').trim()) continue;

    const atMs = new Date(String(snap.at || r.resolved_at || '')).getTime();
    if (!isFinite(atMs) || atMs < since) continue;

    const before = (snap.before && typeof snap.before === 'object')
      ? snap.before
      : { question: r.question_snapshot || '', options: safeJsonParse<unknown[]>(r.options_snapshot, []), correctIndex: null };

    const numMatch = String(r.uid || '').match(/^(.+)_(\d+)$/);
    const entry = {
      uid: String(snap.uid || r.id),
      correctedAt: new Date(atMs).toISOString(),
      fileId: r.file_id,
      questionIndex: numMatch ? Number(numMatch[2]) : null,
      reason: r.reason,
      note: r.note || '',
      reportedBy: r.reported_by,
      reportedAt: r.reported_at,
      correctedBy: r.resolved_by,
      before: {
        question: String(before.question || ''),
        options: (Array.isArray(before.options) ? before.options : []).map(String),
      },
      after: {
        question: String(after.question || ''),
        options: (Array.isArray(after.options) ? after.options : []).map(String),
        correctIndex: asInt(after.correctIndex ?? after.correct),
        explanation: String(after.explanation || ''),
      },
    };

    const k = entry.uid + '|' + entry.correctedAt;
    if (!byKey.has(k)) byKey.set(k, entry);
  }

  const list = [...byKey.values()].sort((a, b) =>
    (new Date(a.correctedAt).getTime() - new Date(b.correctedAt).getTime()) ||
    String(a.uid).localeCompare(String(b.uid)));
  const out = list.slice(0, limit);
  const last = out.length ? out[out.length - 1] : null;

  // Watermark trap: advance only to the newest row actually sent, never to
  // wall-clock time while truncating, or rows past `limit` are lost forever.
  return json({
    success: true,
    now: last ? new Date(last.correctedAt).getTime() : Date.now(),
    count: out.length,
    total: list.length,
    truncated: list.length > out.length,
    corrections: out,
  });
}

export async function adminlistcorrections(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_view');
  if (!admin.ok) return json(admin.error);
  const { data } = await supabase.from('question_reports').select('*').eq('status', 'resolved').eq('corrected', 'true');
  const all: any[] = []; const byFile: Record<string, any> = {}; const seen = new Set();
  (data || []).forEach(r => {
    const key = r.file_id + '#' + r.uid; if (seen.has(key)) return; seen.add(key);
    const correctedSnapshot = safeJsonParse<Record<string, any> | null>(r.corrected_snapshot, null);
    const entry = {
      id: r.id, uid: r.uid, fileId: r.file_id, questionNumber: String(r.uid || '').split('_').pop(), reason: r.reason, note: r.note,
      reportedBy: r.reported_by, reportedAt: r.reported_at, correctedAt: r.resolved_at, correctedBy: r.resolved_by,
      oldSnapshot: { question: r.question_snapshot, options: safeJsonParse<unknown[]>(r.options_snapshot, []), correctIndex: r.correct_index },
      newSnapshot: correctedSnapshot ? { question: correctedSnapshot.q, options: correctedSnapshot.options, correctIndex: correctedSnapshot.correct, explanation: correctedSnapshot.explanation } : null
    };
    all.push(entry);
    const m = String(r.uid || '').match(/^(.+)_(\d+)$/);
    if (m) { const idx = Number(m[2]); byFile[r.file_id] = byFile[r.file_id] || {}; byFile[r.file_id][idx] = entry; }
  });
  all.sort((a, b) => new Date(b.correctedAt).getTime() - new Date(a.correctedAt).getTime());
  return json({ success: true, all, byFile, totalCount: all.length });
}

export async function adminexportcorrections(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_view');
  if (!admin.ok) return json(admin.error);
  const { data } = await supabase.from('question_reports').select('*').eq('status', 'resolved').eq('corrected', 'true');
  const res = data || [];
  const payload = { version: 1, exportedAt: new Date().toISOString(), total: res.length, corrections: res };
  return json({ success: true, json: JSON.stringify(payload, null, 2), filename: 'corrections.json', count: res.length });
}

export async function adminmarkfilecorrected(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_manage');
  if (!admin.ok) return json(admin.error);
  const fileId = String(params.fileId || '').trim();
  if (!fileId) return json({ success: false, error: 'fileId required' });
  await markFileCorrected(fileId);
  await supabase.from('settings').upsert({ key: 'contentVersion', value: String(Date.now()) });
  return json({ success: true });
}

export async function adminmostmissedquestions(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'dashboard');
  if (!admin.ok) return json(admin.error);
  const limit = Math.max(1, Math.min(100, Number(params.limit) || 20));
  const minAttempts = Math.max(1, Number(params.minAttempts) || 3);

  const { data: rows } = await supabase.from('progress').select('username,data');
  // FIX BUG-08: track unique usernames per uid instead of hardcoding 1.
  const tally: Record<string, { n: number; w: number; users: Set<string> }> = {};
  (rows || []).forEach((row: { username?: string; data?: string }) => {
    const user = String(row.username || '');
    try {
      const parsed = JSON.parse(String(row.data || '{}'));
      (parsed?.prog?.sessions || []).forEach((s: any) => {
        (s.qres || []).forEach((qr: any) => {
          if (!qr.uid) return;
          const r = tally[qr.uid] || (tally[qr.uid] = { n: 0, w: 0, users: new Set() });
          r.n++; if (!qr.ok) r.w++;
          if (user) r.users.add(user);
        });
      });
    } catch { /* ignore */ }
  });

  const results = Object.keys(tally).map(uid => {
    const r = tally[uid]; const fileId = uid.replace(/_\d+$/, '');
    return {
      uid, fileId,
      index: Number(String(uid).split('_').pop()),
      wrong: r.w, total: r.n,
      wrongRate: Math.round((r.w / r.n) * 100),
      accuracy: Math.round(((r.n - r.w) / r.n) * 100),
      uniqueStudents: r.users.size,
    };
  }).filter(r => r.total >= minAttempts).sort((a, b) => b.wrongRate - a.wrongRate).slice(0, limit);

  return json({ success: true, results, truncated: false, totalRowsScanned: rows?.length || 0 });
}

export async function adminuploadweeklysetfile(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'weeklysets_manage');
  if (!admin.ok) return json(admin.error);
  const fileData = String(params.fileData || '');
  const filename = String(params.filename || 'weeklyset.json').replace(/[^\w.\-]+/g, '_');
  if (!fileData.startsWith('data:')) return json({ success: false, error: 'Invalid file data' });
  try {
    const base64 = fileData.split(',')[1];
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const path = `sets/${Date.now()}-${filename}`;
    const { error } = await supabase.storage.from('weekly-sets').upload(path, bytes, { contentType: 'application/json' });
    if (error) throw error;
    return json({ success: true, fileId: path, filename });
  } catch (e) { return json({ success: false, error: String(e) }); }
}

export async function adminuploadsubjectivefile(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'subjective_import');
  if (!admin.ok) return json(admin.error);
  const fileData = String(params.fileData || '');
  const filename = String(params.filename || 'subjective.json').replace(/[^\w.\-]+/g, '_');
  if (!fileData.startsWith('data:')) return json({ success: false, error: 'Invalid file data' });
  try {
    const base64 = fileData.split(',')[1];
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const path = `questions/${Date.now()}-${filename}`;
    const { error } = await supabase.storage.from('subjective-content').upload(path, bytes, { contentType: 'application/json' });
    if (error) throw error;
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : (parsed.questions || []);
    return json({ success: true, fileId: path, filename, questionCount: arr.length, warning: null });
  } catch (e) { return json({ success: false, error: String(e) }); }
}

export async function admincommitsubjectiveimport(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'subjective_import');
  if (!admin.ok) return json(admin.error);
  const fileId = String(params.fileId || '');
  const sectionName = String(params.section || 'UNCLASSIFIED (Smart Paste)');
  let items: any[];
  try { items = typeof params.items === 'string' ? JSON.parse(params.items) : params.items; } catch { return json({ success: false, error: 'Invalid items' }); }
  if (!Array.isArray(items) || !items.length) return json({ success: false, error: 'No items to insert' });

  try {
    const { data: blob } = await supabase.storage.from('subjective-content').download(fileId);
    if (!blob) throw new Error('File not found');
    const raw = JSON.parse(await blob.text());
    let existing: any[] = Array.isArray(raw) ? raw : (raw.sections?.find((s: any) => s.section === sectionName)?.questions || []) || raw.questions || [];
    const seen = new Set(existing.map((q: any) => String(q.q || q.question).toLowerCase().replace(/\s+/g, ' ').trim()));

    let inserted = 0;
    items.forEach(it => {
      const text = String(it.question || it.q || '').trim(); if (!text) return;
      const key = text.toLowerCase().replace(/\s+/g, ' ').trim(); if (seen.has(key)) return;
      const qObj = { type: 'subjective', chapter: sectionName, q: text, marks: Number(it.marks) || 10 };
      // FIX BUG-09: only count insertions that actually landed.
      if (Array.isArray(raw)) { raw.push(qObj); inserted++; }
      else if (Array.isArray(raw.sections)) {
        let sec = raw.sections.find((s: any) => s.section === sectionName);
        if (!sec) { sec = { section: sectionName, questions: [] }; raw.sections.push(sec); }
        sec.questions.push(qObj); inserted++;
      } else if (Array.isArray(raw.questions)) { raw.questions.push(qObj); inserted++; }
    });

    if (inserted > 0) {
      const { error } = await supabase.storage.from('subjective-content').upload(fileId, JSON.stringify(raw), { upsert: true, contentType: 'application/json' });
      if (error) throw error;
      try {
        await markFileCorrected(fileId);
        await supabase.from('settings').upsert({ key: 'contentVersion', value: String(Date.now()) });
      } catch (e) { console.warn('[admincommitsubjectiveimport] signal write failed (file already saved):', e); }
    }
    return json({ success: true, inserted, skipped: items.length - inserted, section: sectionName });
  } catch (e) { return json({ success: false, error: 'Could not write to file: ' + String(e) }); }
}