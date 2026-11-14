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

function qidString(v: unknown): string {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? s : '';
}

function asText(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : JSON.stringify(v);
}

function reportView(r: Record<string, any>) {
  const qid = qidString(r.qid);
  return {
    id: r.id,
    uid: r.uid,
    qid: qid ? Number(qid) : null,
    fileId: r.file_id,
    questionSnapshot: r.question_snapshot,
    reason: r.reason,
    note: r.note,
    reportedBy: r.reported_by,
    reportedAt: r.reported_at,
    status: r.status,
    options: safeJsonParse<unknown[]>(r.options_snapshot, []),
    correctIndex: r.correct_index,
    chosenIndex: r.chosen_index,
    section: r.section,
    appVersion: r.app_version,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    corrected: r.corrected === 'true',
    correctedSnapshot: r.corrected_snapshot ? safeJsonParse<unknown>(r.corrected_snapshot, null) : null,
    openReporters: 0,
  };
}

function questionIndexFor(arr: any[], index: number, qid: string): number {
  if (!qid) return index;
  const at = arr[index];
  if (at && String(at.id ?? '') === qid) return index;
  const found = arr.findIndex(q => String(q?.id ?? '') === qid);
  return found >= 0 ? found : index;
}

async function correctionExists(dedupeKey: string, correctedAt: string): Promise<boolean> {
  const { data } = await supabase.from('correction_events').select('id')
    .eq('dedupe_key', dedupeKey).eq('corrected_at', correctedAt).limit(1);
  return !!(data && data[0]);
}

function correctionSnapshot(uid: string, at: string, before: any, after: any) {
  return {
    uid, at, before, after,
    q: after.question, options: after.options, correct: after.correctIndex,
    explanation: after.explanation || '',
  };
}

async function writeCorrectionEvent(row: Record<string, unknown>): Promise<{ error?: unknown }> {
  const { error } = await supabase.from('correction_events').insert(row);
  return { error };
}

async function closeOpenReports(opts: {
  reportId?: string; qid?: string; uid?: string; admin: string; at: string; after: any; close: boolean;
}): Promise<number> {
  if (!opts.close) return 0;
  const { data } = await supabase.from('question_reports').select('id,uid,qid').eq('status', 'open').limit(1000);
  const patch = {
    status: 'resolved', resolved_at: opts.at, resolved_by: opts.admin,
    corrected: 'true', corrected_snapshot: JSON.stringify(opts.after),
  };
  let closed = 0;
  for (const r of (data || [])) {
    const sameReport = opts.reportId && String(r.id) === opts.reportId;
    const sameQid = opts.qid && qidString(r.qid) === opts.qid;
    const sameUid = !opts.qid && opts.uid && String(r.uid) === opts.uid;
    if (!sameReport && !sameQid && !sameUid) continue;
    await supabase.from('question_reports').update(patch).eq('id', r.id);
    closed++;
  }
  return closed;
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
  const asStr = asText;

  // ── FIX BUG-02 / SEC-02 ──────────────────────────────────────────
  // Snapshots MUST be validated. A malformed JSON string from a user was
  // previously stored as-is and crashed adminlistquestionreports for every
  // admin because the read path called JSON.parse without try/catch.
  const safeSnap = (v: unknown, fallbackJson: string): string => {
    const raw = asStr(v, fallbackJson);
    try { JSON.parse(raw); return raw; } catch { return fallbackJson; }
  };

  const id = 'RPT-' + Date.now().toString(36) + '-' + randId();
  const qid = qidString(params.qid);
  const fileId = asStr(p.file_id) || (uid.match(/^(.+)_\d+$/) || [])[1] || '';

  const { error } = await supabase.from('question_reports').insert({
    id, uid, qid,
    file_id: fileId,
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
  return json({ success: true, id, reportId: id });
}

export async function getmyreports(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data, error } = await supabase.from('question_reports').select('*').eq('reported_by', auth.username).order('reported_at', { ascending: false }).limit(200);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, reports: data || [] });
}

// Contract name used by the cross-device My reports screen. Keep the old
// getMyReports action as-is for callers that still read raw rows.
export async function myquestionreports(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data, error } = await supabase.from('question_reports').select('*')
    .eq('reported_by', auth.username).order('reported_at', { ascending: false }).limit(100);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, reports: (data || []).map(r => reportView(r as Record<string, any>)) });
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
  const resolvedMine = (reports || []).map(r => ({
    uid: String(r.uid || ''),
    qid: qidString(r.qid) ? Number(qidString(r.qid)) : null,
    at: new Date(String(r.resolved_at || '')).getTime() || 0,
  })).filter(r => r.uid && r.at > since).slice(0, 10);
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
  const reports = (data || []).map(r => reportView(r as Record<string, any>));

  const openBy: Record<string, Set<string>> = {};
  reports.forEach(r => {
    if (r.status !== 'open') return;
    const key = r.qid ? 'q:' + r.qid : 'u:' + r.uid;
    (openBy[key] ||= new Set()).add(r.reportedBy);
  });
  reports.forEach(r => {
    const key = r.qid ? 'q:' + r.qid : 'u:' + r.uid;
    r.openReporters = r.status === 'open' ? (openBy[key]?.size || 0) : 0;
  });
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

  const { data: target } = await supabase.from('question_reports').select('uid, file_id, qid').eq('id', id).limit(1);
  if (!target || !target[0]) return json({ success: false, error: 'not_found' });

  const { error } = await supabase.from('question_reports').update(patch).eq('id', id);
  if (error) return json({ success: false, error: dbMsg(error) });

  let alsoClosed = 0;
  if (status === 'resolved') {
    const { data: primary } = await supabase.from('question_reports').select('corrected_snapshot,correct_index').eq('id', id).limit(1);
    const snap = primary && primary[0] ? String(primary[0].corrected_snapshot || '') : '';
    const idx = primary && primary[0] ? primary[0].correct_index : null;

    const qid = qidString(target[0].qid);
    let siblingQuery = supabase.from('question_reports').select('id').eq('status', 'open').neq('id', id);
    siblingQuery = qid ? siblingQuery.eq('qid', qid) : siblingQuery.eq('uid', target[0].uid);
    const { data: siblings } = await siblingQuery;
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
  const qid = qidString(params.qid);
  if (!fileId || isNaN(index) || index < 0) return json({ success: false, error: 'Invalid reference' });

  try {
    const { data: blob, error } = await supabase.storage.from('subjective-content').download(fileId);
    if (error || !blob) throw new Error('File not found');
    const raw = JSON.parse(await blob.text());
    const arr = flattenQuestions(raw);
    const at = questionIndexFor(arr, index, qid);
    if (!arr[at]) return json({ success: false, error: 'Question not found in file' });
    const q = arr[at];
    return json({ success: true, index: at, qid: qid ? Number(qid) : null, total: arr.length, question: { q: q.q || q.question || '', options: q.options || q.opts || [], correct: q.correct ?? q.answer ?? null, explanation: q.explanation || q.exp || '' } });
  } catch (e) { return json({ success: false, error: 'Could not read file: ' + String(e) }); }
}

export async function adminupdatequestion(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_manage');
  if (!admin.ok) return json(admin.error);
  const fileId = String(params.fileId || '').trim();
  const index = Number(params.index);
  const qid = qidString(params.qid);
  const expectedQ = String(params.expectedQ || '').trim();
  if (!fileId || isNaN(index) || index < 0) return json({ success: false, error: 'Invalid reference' });

  let fields: any;
  try { fields = typeof params.fields === 'string' ? JSON.parse(params.fields) : params.fields; } catch { return json({ success: false, error: 'Invalid fields' }); }

  const atMs = new Date(String(params.correctedAt || '')).getTime();
  const correctedAt = isFinite(atMs) && atMs > 0 ? new Date(atMs).toISOString() : new Date().toISOString();
  const reportUid = `${fileId}_${index}`;
  const dedupeKey = qid ? `q${qid}` : `u${reportUid}`;
  const editUid = qid ? `q${qid}` : reportUid;
  if (await correctionExists(dedupeKey, correctedAt)) {
    return json({ success: true, duplicate: true, qid: qid ? Number(qid) : null });
  }

  try {
    const { data: blob, error } = await supabase.storage.from('subjective-content').download(fileId);
    if (error || !blob) throw new Error('File not found');
    const raw = JSON.parse(await blob.text());
    const arr = flattenQuestions(raw);
    const at = questionIndexFor(arr, index, qid);
    if (!arr[at]) return json({ success: false, error: 'Question not found' });

    const currentQ = arr[at].q || arr[at].question || '';
    if (String(currentQ).trim() !== expectedQ) return json({ success: false, error: 'File changed since you opened it. Please reload.' });

    // Verbatim before-side for the correction pipeline (source number and
    // full option text included). The report snapshot is trimmed for display.
    const curCorrect = arr[at].correct ?? arr[at].answer ?? null;
    const beforeEdit = {
      question: String(currentQ),
      options: (Array.isArray(arr[at].options) ? arr[at].options : (arr[at].opts || [])).map(String),
      correctIndex: Number.isInteger(curCorrect) ? curCorrect : null,
    };

    const after = {
      question: String(fields.q || ''),
      options: Array.isArray(fields.options) ? fields.options.map(String) : [],
      correctIndex: Number.isInteger(fields.correct) ? fields.correct : null,
      explanation: String(fields.explanation || ''),
    };
    if (!after.question.trim()) return json({ success: false, error: 'Question text is required.' });

    // Per-edit event: (dedupe_key, corrected_at) is the pipeline's idempotency
    // key, so a re-edit needs a new correctedAt from the client.
    const event = {
      dedupe_key: dedupeKey, uid: editUid, qid, file_id: fileId,
      report_id: String(params.reportId || ''), corrected_at: correctedAt,
      before: JSON.stringify(beforeEdit), after: JSON.stringify(after),
      note: String(params.adminNote || ''), admin_user: admin.username,
      created_at: new Date().toISOString(),
    };
    const ev = await writeCorrectionEvent(event);
    if (ev.error) {
      if (String((ev.error as any)?.code || '') === '23505') return json({ success: true, duplicate: true });
      return json({ success: false, error: dbMsg(ev.error) });
    }

    arr[at].q = fields.q; arr[at].options = fields.options; arr[at].correct = fields.correct; arr[at].explanation = fields.explanation;
    const newContent = JSON.stringify(raw);
    const { error: upErr } = await supabase.storage.from('subjective-content').upload(fileId, newContent, { upsert: true, contentType: 'application/json' });
    if (upErr) {
      await supabase.from('correction_events').delete().eq('dedupe_key', dedupeKey).eq('corrected_at', correctedAt);
      throw upErr;
    }

    try {
      await markFileCorrected(fileId);
      await supabase.from('settings').upsert({ key: 'contentVersion', value: String(Date.now()) });
    } catch (e) { console.warn('[adminupdatequestion] signal write failed (file already saved):', e); }

    const snapshot = correctionSnapshot(editUid, correctedAt, beforeEdit, after);
    const snapshotText = JSON.stringify(snapshot);
    try {
      if (qid) await supabase.from('question_reports').update({ corrected_snapshot: snapshotText, correct_index: fields.correct }).eq('qid', qid);
      else await supabase.from('question_reports').update({ corrected_snapshot: snapshotText, correct_index: fields.correct }).eq('file_id', fileId).eq('uid', reportUid);
      const reportId = String(params.reportId || '').trim();
      if (reportId) {
        await supabase.from('question_reports')
          .update({ corrected_snapshot: snapshotText, correct_index: fields.correct })
          .eq('id', reportId);
      }
    } catch (e) { console.warn('[adminupdatequestion] could not populate corrected_snapshot (non-fatal):', e); }

    const alsoClosed = await closeOpenReports({
      reportId: String(params.reportId || ''), qid, uid: reportUid,
      admin: admin.username, at: correctedAt, after, close: params.closeReport !== false,
    });
    return json({ success: true, qid: qid ? Number(qid) : null, alsoClosed });
  } catch (e) { return json({ success: false, error: 'Could not save: ' + String(e) }); }
}

// One batch for every queued fix. Each item is isolated: a conflict or a bad
// file must not discard the fixes around it. File writes and the correction
// event log are kept together so the Drive -> Neon pipeline never sees an
// edit that was not saved.
export async function adminapplycorrections(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_manage');
  if (!admin.ok) return json(admin.error);

  let items: any[];
  try {
    const raw = typeof params.items === 'string' ? JSON.parse(params.items) : params.items;
    items = Array.isArray(raw) ? raw : [];
  } catch { return json({ success: false, error: 'items must be a JSON array' }); }
  if (!items.length) return json({ success: true, results: [] });

  type Pending = {
    entry: any; fileId: string; dedupeKey: string; event: Record<string, unknown>;
    qid: string; reportId: string; uid: string; after: any; close: boolean;
  };
  const entries: any[] = [];
  const pending: Pending[] = [];
  const seen = new Set<string>();
  const files = new Map<string, { arr: any[]; raw: any }>();

  for (const item of items) {
    const key = String(item?.key || '');
    const entry: any = { key, ok: false };
    entries.push(entry);
    try {
      if (!key) throw new Error('key is required');
      const fileId = String(item.fileId || '').trim();
      const index = Number(item.index);
      const qid = qidString(item.qid);
      const uid = String(item.uid || (fileId && !isNaN(index) ? `${fileId}_${index}` : ''));
      const reportId = String(item.reportId || '');
      const correctedAtRaw = new Date(String(item.correctedAt || '')).getTime();
      const correctedAt = isFinite(correctedAtRaw) && correctedAtRaw > 0
        ? new Date(correctedAtRaw).toISOString() : new Date().toISOString();
      const dedupeKey = qid ? `q${qid}` : `u${uid || key}`;
      const runKey = dedupeKey + '|' + correctedAt;

      if (seen.has(runKey) || await correctionExists(dedupeKey, correctedAt)) {
        entry.ok = true; entry.duplicate = true;
        seen.add(runKey);
        continue;
      }
      seen.add(runKey);

      if (!fileId || isNaN(index) || index < 0) throw new Error('Invalid reference');
      const after = item.after && typeof item.after === 'object' ? item.after : null;
      if (!after || !String(after.question || '').trim()) throw new Error('Question text is required.');

      let file = files.get(fileId);
      if (!file) {
        const { data: blob, error } = await supabase.storage.from('subjective-content').download(fileId);
        if (error || !blob) throw new Error('File not found');
        const raw = JSON.parse(await blob.text());
        file = { arr: flattenQuestions(raw), raw };
        files.set(fileId, file);
      }
      const at = questionIndexFor(file.arr, index, qid);
      const q = file.arr[at];
      if (!q) throw new Error('Question not found');
      const currentQ = q.q || q.question || '';
      const expectedQ = String(item.expectedQ || '').trim();
      if (expectedQ && String(currentQ).trim() !== expectedQ) {
        entry.conflict = true;
        throw new Error('The question changed since you opened it.');
      }

      const curCorrect = q.correct ?? q.answer ?? null;
      const before = {
        question: String(currentQ),
        options: (Array.isArray(q.options) ? q.options : (q.opts || [])).map(String),
        correctIndex: Number.isInteger(curCorrect) ? curCorrect : null,
      };
      const cleanAfter = {
        question: String(after.question || ''),
        options: Array.isArray(after.options) ? after.options.map(String) : [],
        correctIndex: Number.isInteger(after.correctIndex) ? after.correctIndex : null,
        explanation: String(after.explanation || ''),
      };
      q.q = cleanAfter.question;
      q.options = cleanAfter.options;
      q.correct = cleanAfter.correctIndex;
      q.explanation = cleanAfter.explanation;

      const editUid = qid ? `q${qid}` : (uid || `${fileId}_${at}`);
      pending.push({
        entry, fileId, dedupeKey, qid, reportId, uid, after: cleanAfter,
        close: !(item.closeReport === false || item.closeReport === 'false' || item.closeReport === 0),
        event: {
          dedupe_key: dedupeKey, uid: editUid, qid, file_id: fileId,
          report_id: reportId, corrected_at: correctedAt,
          before: JSON.stringify(before), after: JSON.stringify(cleanAfter),
          note: String(item.adminNote || ''), admin_user: admin.username,
          created_at: new Date().toISOString(),
        },
      });
    } catch (e: any) {
      entry.ok = false;
      entry.error = String(e?.message || e);
    }
  }

  // Save each changed file once. A file failure fails only that file's items.
  const failedFiles = new Set<string>();
  for (const [fileId, file] of files) {
    const { error } = await supabase.storage.from('subjective-content')
      .upload(fileId, JSON.stringify(file.raw), { upsert: true, contentType: 'application/json' });
    if (error) failedFiles.add(fileId);
  }

  const savedFiles = new Set<string>();
  for (const p of pending) {
    if (failedFiles.has(p.fileId)) {
      p.entry.ok = false; p.entry.error = 'Could not save the file.';
      continue;
    }
    const ev = await writeCorrectionEvent(p.event);
    if (ev.error) {
      p.entry.ok = false; p.entry.error = dbMsg(ev.error);
      continue;
    }
    p.entry.ok = true;
    savedFiles.add(p.fileId);
    const closed = await closeOpenReports({
      reportId: p.reportId, qid: p.qid, uid: p.uid,
      admin: admin.username, at: String(p.event.corrected_at), after: p.after, close: p.close,
    });
    if (closed) p.entry.alsoClosed = closed;
    const snapshot = correctionSnapshot(String(p.event.uid), String(p.event.corrected_at), safeJsonParse<any>(p.event.before, {}), p.after);
    const snapshotText = JSON.stringify(snapshot);
    if (p.qid) await supabase.from('question_reports').update({ corrected_snapshot: snapshotText, correct_index: p.after.correctIndex }).eq('qid', p.qid);
    if (p.reportId) await supabase.from('question_reports').update({ corrected_snapshot: snapshotText, correct_index: p.after.correctIndex }).eq('id', p.reportId);
  }

  // Mark each affected file once for the student poller, then bump the
  // content version once for the whole batch.
  for (const fileId of savedFiles) await markFileCorrected(fileId);
  if (savedFiles.size) {
    await supabase.from('settings').upsert({ key: 'contentVersion', value: String(Date.now()) });
  }

  return json({ success: true, results: entries });
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

  // New corrections live in the event log. Fall back to the report snapshot
  // for databases that have not applied the qid/event migration yet.
  const eventRows = await supabase.from('correction_events').select('*')
    .order('corrected_at', { ascending: false }).limit(2000);
  const { data, error } = await supabase.from('question_reports')
    .select('*').eq('status', 'resolved').eq('corrected', 'true');
  if (error) return json({ success: false, error: dbMsg(error) }, 500);

  const asInt = (v: unknown): number | null => Number.isInteger(v) && (v as number) >= 0 ? v as number : null;
  const byKey = new Map<string, any>();

  for (const ev of (eventRows.error ? [] : (eventRows.data || []))) {
    const after = safeJsonParse<Record<string, any> | null>(ev.after, null);
    if (!after || !String(after.question || '').trim()) continue;
    const atMs = new Date(String(ev.corrected_at || '')).getTime();
    if (!isFinite(atMs) || atMs < since) continue;
    const before = safeJsonParse<Record<string, any>>(ev.before, {});
    const m = String(ev.uid || '').match(/^(.+)_(\d+)$/);
    const qid = qidString(ev.qid);
    const entry = {
      uid: String(ev.uid || ev.dedupe_key),
      qid: qid ? Number(qid) : null,
      correctedAt: new Date(atMs).toISOString(),
      fileId: ev.file_id,
      questionIndex: m ? Number(m[2]) : null,
      reason: '',
      note: ev.note || '',
      reportedBy: '',
      reportedAt: '',
      correctedBy: ev.admin_user || '',
      before: {
        question: String(before.question || ''),
        options: (Array.isArray(before.options) ? before.options : []).map(String),
        correctIndex: asInt(before.correctIndex),
      },
      after: {
        question: String(after.question || ''),
        options: (Array.isArray(after.options) ? after.options : []).map(String),
        correctIndex: asInt(after.correctIndex ?? after.correct),
        explanation: String(after.explanation || ''),
      },
    };
    byKey.set(entry.uid + '|' + entry.correctedAt, entry);
  }

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
      qid: qidString(r.qid) ? Number(qidString(r.qid)) : null,
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
      id: r.id, uid: r.uid, qid: qidString(r.qid) ? Number(qidString(r.qid)) : null,
      fileId: r.file_id, questionNumber: String(r.uid || '').split('_').pop(), reason: r.reason, note: r.note,
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