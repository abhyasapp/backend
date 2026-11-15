import { supabase, selectAll } from '../_shared/db.ts';
import { json, dbMsg } from '../_shared/http.ts';
import { authUser, authAdmin, requireAccess } from '../_shared/auth.ts';
import { CORRECTIONS_SETTING_KEY } from '../_shared/config.ts';
import { randId } from '../_shared/crypto.ts';
import { markFileCorrected, readProgress, extractCorrectAnswers } from '../_shared/utils.ts';
import { chunk } from '../_shared/pure.ts';
import { rlBlocked, rlHit, RL_TOO_MANY } from '../_shared/rate-limit.ts';

function safeJsonParse<T = unknown>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function qidString(v: unknown): string {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? s : '';
}

/* A report made before questions had ids stores only the text the student saw.
   Numbers are decorative (parts get renumbered), so compare the words. */
function normalizedQuestionText(v: unknown): string {
  return String(v == null ? '' : v)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\s*\d+\s*[\.\)]\s*/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameReportedQuestion(snapshot: unknown, current: unknown): boolean {
  const a = normalizedQuestionText(snapshot);
  const b = normalizedQuestionText(current);
  if (!a || !b) return false;
  if (a === b) return true;
  // The report snapshot can be truncated; a long prefix is still a match.
  if (a.length >= 40 && b.startsWith(a)) return true;
  if (b.length >= 40 && a.startsWith(b)) return true;
  return false;
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

function validateCorrection(
  after: { question: string; options: string[]; correctIndex: number | null },
  before: { options: string[] },
): string {
  if (!after.question.trim()) return 'Question text is required.';
  if (before.options.length && after.options.length < 2) return 'A question with options needs at least two options.';
  if (after.options.length && after.correctIndex !== null && after.correctIndex >= after.options.length) return 'Correct answer index is out of range.';
  return '';
}

async function writeCorrectionEvent(row: Record<string, unknown>): Promise<{ error?: unknown }> {
  const { error } = await supabase.from('correction_events').insert(row);
  return { error };
}

async function closeOpenReports(opts: {
  reportId?: string; qid?: string; uid?: string; admin: string; at: string; after: any; close: boolean;
}): Promise<number> {
  if (!opts.close) return 0;
  // Look up exactly the open reports this correction covers (the old version scanned only the first 1000 open reports).
  const ids = new Set<string>();
  const collect = async (col: string, val: string) => {
    const { data } = await supabase.from('question_reports').select('id').eq('status', 'open').eq(col, val).limit(5000);
    (data || []).forEach(r => ids.add(String(r.id)));
  };
  if (opts.reportId) await collect('id', opts.reportId);
  if (opts.qid) await collect('qid', opts.qid);
  else if (opts.uid) await collect('uid', opts.uid);

  const patch = {
    status: 'resolved', resolved_at: opts.at, resolved_by: opts.admin,
    corrected: 'true', corrected_snapshot: JSON.stringify(opts.after),
  };
  let closed = 0;
  for (const part of chunk([...ids], 100)) {
    const { error } = await supabase.from('question_reports').update(patch).in('id', part);
    if (!error) closed += part.length;
  }
  return closed;
}

export async function reportquestion(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const uid = String(params.uid || '').trim().slice(0, 200);
  const reason = String(params.reason || '').trim().slice(0, 100);
  if (!uid || !reason) return json({ success: false, error: 'uid_and_reason_required' });
  const rlKey = 'rpt:' + auth.username.toLowerCase();
  if (await rlBlocked(rlKey, 40)) return json(RL_TOO_MANY);

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
  const fileId = (asStr(p.file_id) || (uid.match(/^(.+)_\d+$/) || [])[1] || '').slice(0, 200);
  // The columns are TEXT NOT NULL DEFAULT '': never send null, and accept "2" as well as 2.
  const idxText = (v: unknown): string => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,2}$/.test(v.trim()) ? Number(v) : NaN);
    return Number.isInteger(n) && n >= 0 && n < 100 ? String(n) : '';
  };
  const optionsSnap = safeSnap(p.options_snapshot, '[]');
  await rlHit(rlKey, 60 * 60 * 1000);

  const { error } = await supabase.from('question_reports').insert({
    id, uid, qid,
    file_id: fileId,
    question_snapshot: asStr(p.question_snapshot).slice(0, 4000),
    options_snapshot: optionsSnap.length <= 8000 ? optionsSnap : '[]',
    // Omitted when invalid so the column default applies (a null would violate NOT NULL).
    ...(idxText(p.correct_index) !== '' ? { correct_index: idxText(p.correct_index) } : {}),
    ...(idxText(p.chosen_index) !== '' ? { chosen_index: idxText(p.chosen_index) } : {}),
    reason, note: asStr(p.note).slice(0, 1000),
    reported_by: auth.username, reported_at: new Date().toISOString(), status: 'open',
    section: asStr(p.section).slice(0, 100), app_version: asStr(p.app_version).slice(0, 30),
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

  const { data: reports } = await supabase.from('question_reports').select('uid,qid,resolved_at,corrected').eq('reported_by', auth.username).eq('status', 'resolved').order('resolved_at', { ascending: false }).limit(50);
  const resolvedMine = (reports || []).map(r => ({
    uid: String(r.uid || ''),
    qid: qidString(r.qid) ? Number(qidString(r.qid)) : null,
    at: new Date(String(r.resolved_at || '')).getTime() || 0,
    corrected: String(r.corrected || '').toLowerCase() === 'true',
  })).filter(r => r.uid && r.at > since).slice(0, 10);
  // A report closed as "no change needed" is still resolved, but calling it
  // corrected tells the student their question changed when it did not.
  const correctedMine = resolvedMine.filter(r => r.corrected);
  return json({ success: true, now: Date.now(), files, resolvedMine, correctedMine });
}

const HARD_CACHE_KEY = 'private_hard_questions';
const HARD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export async function gethardquestions(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  // Scanning every student's progress is expensive: serve a cached result for a few hours.
  try {
    const { data: cached } = await supabase.from('settings').select('value').eq('key', HARD_CACHE_KEY).limit(1);
    if (cached && cached[0]) {
      const c = JSON.parse(String(cached[0].value || '{}'));
      if (c && c.map && Date.now() - Number(c.at || 0) < HARD_CACHE_TTL_MS) return json({ success: true, map: c.map, cached: true });
    }
  } catch { /* recompute */ }

  let rows: any[];
  try { rows = await selectAll('progress', 'username,data', { orderBy: 'username' }); }
  catch (e) { return json({ success: false, error: dbMsg(e) }); }
  const tally: Record<string, { n: number; w: number }> = {};
  for (const row of rows) {
    const parsed = await readProgress(row.data);   // understands gz1: compressed rows
    const sessions = parsed?.prog?.sessions;
    if (!Array.isArray(sessions)) continue;
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
  }
  const map: Record<string, number> = {};
  Object.keys(tally).forEach(uid => { const r = tally[uid]; if (r.n >= 20) map[uid] = Math.round((r.w / r.n) * 100); });
  try { await supabase.from('settings').upsert({ key: HARD_CACHE_KEY, value: JSON.stringify({ at: Date.now(), map }) }, { onConflict: 'key' }); } catch { /* cache is best-effort */ }
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
        status: 'resolved', resolved_at: patch.resolved_at, resolved_by: patch.resolved_by,
      };
      if (signal) sibPatch.corrected = 'true';
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

/* Objective chapter files live on Drive and are mirrored to the public content
   CDN under their Drive id. Older reports store that Drive id, so reading only
   Supabase Storage reports every one of them as "file missing" even though the
   student app can load the file. Try Storage first (subjective files), then the
   read-only CDN mirror. */
async function loadQuestionFile(fileId: string): Promise<any[] | null> {
  // Subjective files live in Storage; objective chapter files live on Drive and
  // are mirrored to the CDN. Try Storage briefly, then fall back. A bare Drive
  // id often makes Storage wait, so cap that attempt instead of spending the
  // whole request timeout on a key that cannot exist there.
  try {
    const download = supabase.storage.from('subjective-content').download(fileId)
      .catch(() => ({ data: null, error: true }));
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), 1500));
    const hit: any = await Promise.race([download, timeout]);
    if (hit && !hit.error && hit.data) return flattenQuestions(JSON.parse(await hit.data.text()));
  } catch { /* fall through to the CDN */ }

  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) return null;
  const base = (Deno.env.get('CONTENT_CDN_BASE') || 'https://cdn.jsdelivr.net/gh/abhyasapp/content@main').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/content/${encodeURIComponent(fileId)}.json`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return flattenQuestions(await res.json());
  } catch { return null; }
}

export async function admingetquestion(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_manage');
  if (!admin.ok) return json(admin.error);
  const fileId = String(params.fileId || '').trim();
  const index = Number(params.index);
  const qid = qidString(params.qid);
  if (!fileId || isNaN(index) || index < 0) return json({ success: false, error: 'Invalid reference' });

  // Load the file from Supabase Storage first (subjective files), then fall
  // back to the public CONTENT CDN for objective/Drive-backed files. When a
  // qid is present the question is located by id, so position is never
  // trusted — the same position may hold a different question after a reorder.
  let arr: any[] | null = null;
  let raw: any = null;
  try {
    const { data: blob, error } = await supabase.storage.from('subjective-content').download(fileId);
    if (error || !blob) throw new Error('not in storage');
    raw = JSON.parse(await blob.text());
    arr = flattenQuestions(raw);
  } catch {
    if (/^[A-Za-z0-9_-]+$/.test(fileId)) {
      const base = (Deno.env.get('CONTENT_CDN_BASE') || 'https://cdn.jsdelivr.net/gh/abhyasapp/content@main').replace(/\/+$/, '');
      try {
        const res = await fetch(`${base}/content/${encodeURIComponent(fileId)}.json`, { signal: AbortSignal.timeout(10000) });
        if (res.ok) { raw = await res.json(); arr = flattenQuestions(raw); }
      } catch { /* fall through */ }
    }
  }
  if (!arr || !arr.length) return json({ success: false, error: 'Could not read file' });
  const at = questionIndexFor(arr, index, qid);
  if (!arr[at]) return json({ success: false, error: 'Question not found in file' });
  const q = arr[at];
  return json({ success: true, index: at, qid: qid ? Number(qid) : null, total: arr.length, question: { q: q.q || q.question || '', options: q.options || q.opts || [], correct: q.correct ?? q.answer ?? null, explanation: q.explanation || q.exp || '' } });
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

  // Load the file from Supabase Storage (subjective) or the CONTENT CDN
  // (objective/Drive-backed). Track whether we can write it back.
  let raw: any = null;
  let arr: any[] = [];
  let writable = false;
  try {
    const { data: blob, error } = await supabase.storage.from('subjective-content').download(fileId);
    if (!error && blob) {
      raw = JSON.parse(await blob.text());
      arr = flattenQuestions(raw);
      writable = true;
    } else {
      throw new Error('not in storage');
    }
  } catch {
    if (/^[A-Za-z0-9_-]+$/.test(fileId)) {
      const base = (Deno.env.get('CONTENT_CDN_BASE') || 'https://cdn.jsdelivr.net/gh/abhyasapp/content@main').replace(/\/+$/, '');
      try {
        const res = await fetch(`${base}/content/${encodeURIComponent(fileId)}.json`, { signal: AbortSignal.timeout(10000) });
        if (res.ok) { raw = await res.json(); arr = flattenQuestions(raw); }
      } catch { /* fall through */ }
    }
  }
  if (!arr || !arr.length) return json({ success: false, error: 'Could not read file' });

  const at = questionIndexFor(arr, index, qid);
  if (!arr[at]) return json({ success: false, error: 'Question not found' });

  const currentQ = arr[at].q || arr[at].question || '';
  // When a qid is present the question was located by id, so position/text
  // drift does not mean "wrong question" — qid is authoritative. Only enforce
  // the concurrency guard for legacy (qid-less) reports.
  if (!qid && String(currentQ).trim() !== expectedQ) return json({ success: false, error: 'File changed since you opened it. Please reload.' });

  try {
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
    const invalid = validateCorrection(after, beforeEdit);
    if (invalid) return json({ success: false, error: invalid });

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

    // Write exactly what the event log records (not the raw client payload), and never blank an existing answer.
    arr[at].q = after.question;
    if (after.options.length) arr[at].options = after.options;
    if (after.correctIndex !== null) arr[at].correct = after.correctIndex;
    arr[at].explanation = after.explanation;
    // Only subjective files live in Supabase Storage and can be written back.
    // Objective/Drive-backed files are corrected through the event log + pipeline
    // (which re-exports from Neon), so no file write is needed there.
    if (writable) {
      const newContent = JSON.stringify(raw);
      const { error: upErr } = await supabase.storage.from('subjective-content').upload(fileId, newContent, { upsert: true, contentType: 'application/json' });
      if (upErr) {
        await supabase.from('correction_events').delete().eq('dedupe_key', dedupeKey).eq('corrected_at', correctedAt);
        throw upErr;
      }
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
    apply: () => void;
  };
  const entries: any[] = [];
  const pending: Pending[] = [];
  const seen = new Set<string>();
  const files = new Map<string, { arr: any[]; raw: any; writable: boolean }>();

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
        let raw: any = null;
        let writable = false;
        try {
          const { data: blob, error } = await supabase.storage.from('subjective-content').download(fileId);
          if (!error && blob) { raw = JSON.parse(await blob.text()); writable = true; }
          else throw new Error('not in storage');
        } catch {
          if (/^[A-Za-z0-9_-]+$/.test(fileId)) {
            const base = (Deno.env.get('CONTENT_CDN_BASE') || 'https://cdn.jsdelivr.net/gh/abhyasapp/content@main').replace(/\/+$/, '');
            try {
              const res = await fetch(`${base}/content/${encodeURIComponent(fileId)}.json`, { signal: AbortSignal.timeout(10000) });
              if (res.ok) raw = await res.json();
            } catch { /* fall through */ }
          }
        }
        if (!raw) throw new Error('File not found');
        file = { arr: flattenQuestions(raw), raw, writable };
        files.set(fileId, file);
      }
      const at = questionIndexFor(file.arr, index, qid);
      const q = file.arr[at];
      if (!q) throw new Error('Question not found');
      const currentQ = q.q || q.question || '';
      const expectedQ = String(item.expectedQ || '').trim();
      // qid is authoritative: when present, the question was located by id, so
      // position/text drift is not a conflict. Only legacy (qid-less) reports
      // use the expectedQ concurrency guard.
      if (!qid && expectedQ && String(currentQ).trim() !== expectedQ) {
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
      const invalid = validateCorrection(cleanAfter, before);
      if (invalid) throw new Error(invalid);
      // Applied to the in-memory file only AFTER the event row is saved (see below).
      const apply = () => {
        q.q = cleanAfter.question;
        if (cleanAfter.options.length) q.options = cleanAfter.options;
        if (cleanAfter.correctIndex !== null) q.correct = cleanAfter.correctIndex;
        q.explanation = cleanAfter.explanation;
      };

      const editUid = qid ? `q${qid}` : (uid || `${fileId}_${at}`);
      pending.push({
        entry, fileId, dedupeKey, qid, reportId, uid, after: cleanAfter, apply,
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

  // Same order as adminupdatequestion: event log FIRST, file SECOND, roll the event back if the
  // file save fails. The pipeline never sees an unsaved edit and a file never changes without an event.
  const written: Pending[] = [];
  for (const p of pending) {
    const ev = await writeCorrectionEvent(p.event);
    if (ev.error) {
      if (String((ev.error as any)?.code || '') === '23505') { p.entry.ok = true; p.entry.duplicate = true; continue; }
      p.entry.ok = false; p.entry.error = dbMsg(ev.error);
      continue;
    }
    p.apply();
    written.push(p);
  }

  // Save each changed file once. A file failure fails only that file's items.
  const touched = new Set(written.map(p => p.fileId));
  const failedFiles = new Set<string>();
  for (const [fileId, file] of files) {
    if (!touched.has(fileId)) continue;
    // Objective/Drive-backed files are not writable here; the pipeline applies
    // the correction via the event log and re-exports from Neon.
    if (!file.writable) continue;
    const { error } = await supabase.storage.from('subjective-content')
      .upload(fileId, JSON.stringify(file.raw), { upsert: true, contentType: 'application/json' });
    if (error) failedFiles.add(fileId);
  }

  const savedFiles = new Set<string>();
  for (const p of written) {
    if (failedFiles.has(p.fileId)) {
      await supabase.from('correction_events').delete()
        .eq('dedupe_key', p.dedupeKey).eq('corrected_at', String(p.event.corrected_at));
      p.entry.ok = false; p.entry.error = 'Could not save the file.';
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

// Pipeline audit: expose reports (with qid) to the Neon pipeline so reported
// questions can be joined against Neon questions for dedupe/correction status.
// SYNC_KEY auth, like syncCorrectionsSince.
export async function syncreportssince(params: Record<string, unknown>) {
  const expected = Deno.env.get('SYNC_KEY') || Deno.env.get('ABHYAS_SYNC_KEY') || '';
  if (!expected) {
    return json({ success: false, code: 'not_configured', error: 'SYNC_KEY is not set on the api function.' }, 503);
  }
  const key = String(params.key || '');
  if (!key || !constantTimeEqual(key, expected)) {
    return json({ success: false, code: 'unauthorized', error: 'ABHYAS_SYNC_KEY does not match SYNC_KEY in the api function environment.' }, 401);
  }

  const since = Math.max(0, Number(params.since) || 0);
  const limit = Math.max(1, Math.min(5000, Number(params.limit) || 2000));
  const rows = await selectAll('question_reports', '*', { orderBy: 'id', max: limit });
  const out: any[] = [];
  for (const r of (rows || [])) {
    const atMs = new Date(String(r.reported_at || r.created_at || '')).getTime();
    if (since && (!isFinite(atMs) || atMs <= since)) continue;
    const qid = qidString(r.qid);
    out.push({
      id: r.id,
      uid: r.uid,
      qid: qid ? Number(qid) : null,
      fileId: r.file_id,
      status: r.status,
      reason: r.reason,
      reportedBy: r.reported_by,
      reportedAt: isFinite(atMs) ? new Date(atMs).toISOString() : (r.reported_at || ''),
      questionSnapshot: String(r.question_snapshot || '').slice(0, 300),
      corrected: !!r.corrected,
    });
  }
  return json({ success: true, reports: out, count: out.length });
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
  // Read events strictly AFTER the watermark, oldest first. (Fetching the newest N and filtering
  // in JS dropped older events permanently once more than N were queued, because the watermark
  // then advanced past them.) limit+1 lets us report `truncated` accurately.
  const eventRows = await supabase.from('correction_events').select('*')
    .gt('corrected_at', new Date(since).toISOString())
    .order('corrected_at', { ascending: true }).limit(limit + 1);
  let data: any[];
  try {
    data = await selectAll('question_reports', '*', { orderBy: 'id', apply: q => q.eq('status', 'resolved').eq('corrected', 'true') });
  } catch (e) { return json({ success: false, error: dbMsg(e) }, 500); }

  const asInt = (v: unknown): number | null => Number.isInteger(v) && (v as number) >= 0 ? v as number : null;
  const byKey = new Map<string, any>();

  for (const ev of (eventRows.error ? [] : (eventRows.data || []))) {
    const after = safeJsonParse<Record<string, any> | null>(ev.after, null);
    if (!after || !String(after.question || '').trim()) continue;
    const atMs = new Date(String(ev.corrected_at || '')).getTime();
    // The watermark is the newest timestamp already delivered. Treat it as
    // exclusive so a queued correction is not fetched again on every run.
    if (!isFinite(atMs) || atMs <= since) continue;
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
    if (!isFinite(atMs) || atMs <= since) continue;

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
  const data = await selectAll('question_reports', '*', { orderBy: 'id', apply: q => q.eq('status', 'resolved').eq('corrected', 'true') });
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

// Full per-edit audit trail. adminListCorrections only exposes the snapshot on
// reports that were closed; a direct edit or a restore lives here instead.
// Reports managers need qreports_view, not logs_view, so this works for the
// same people who can open the report console.
export async function adminlistcorrectionevents(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_view');
  if (!admin.ok) return json(admin.error);

  const fileId = String(params.fileId || '').trim().slice(0, 300);
  const qid = qidString(params.qid);
  const limit = Math.max(1, Math.min(2000, Number(params.limit) || 500));
  const data = await selectAll('correction_events', '*', {
    orderBy: 'id', ascending: false, max: limit,
    apply: q => {
      let out = fileId ? q.eq('file_id', fileId) : q;
      if (qid) out = out.eq('qid', qid);
      return out;
    },
  });

  const events = data.map(e => ({
    id: e.id,
    dedupeKey: e.dedupe_key,
    uid: e.uid,
    qid: qidString(e.qid) ? Number(qidString(e.qid)) : null,
    fileId: e.file_id,
    reportId: e.report_id || '',
    correctedAt: e.corrected_at,
    before: safeJsonParse<Record<string, any>>(e.before, {}),
    after: safeJsonParse<Record<string, any>>(e.after, {}),
    note: e.note || '',
    admin: e.admin_user || '',
    createdAt: e.created_at || '',
  }));
  return json({ success: true, events, totalCount: events.length, limit });
}

// Older reports predate stable qids. Match their saved text to the current
// file, but only apply a match when exactly one question has that text; never
// guess from a position and never delete a report. `apply` is opt-in.
export async function adminbackfillreportqids(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_manage');
  if (!admin.ok) return json(admin.error);

  const apply = params.apply === true || String(params.apply) === 'true';
  const limit = Math.max(1, Math.min(5000, Number(params.limit) || 2000));
  const reports = await selectAll('question_reports', '*', {
    orderBy: 'id', max: limit, apply: q => q.eq('qid', ''),
  });
  const candidates = reports.filter((r: any) => !qidString(r.qid));
  const files = new Map<string, any[] | null>();
  let matched = 0, applied = 0, ambiguous = 0, noMatch = 0;
  let noFile = 0, noQuestionId = 0, failed = 0;
  const examples: any[] = [];

  for (const r of candidates) {
    const snapshot = String(r.question_snapshot || '').trim();
    const fileId = String(r.file_id || '').trim()
      || String(r.uid || '').replace(/_\d+$/, '');
    if (!fileId || !snapshot) { noMatch++; continue; }

    let arr = files.get(fileId);
    if (arr === undefined) {
      arr = await loadQuestionFile(fileId);
      files.set(fileId, arr);
    }
    if (!arr) { noFile++; continue; }

    const atMatch = String(r.uid || '').match(/_(\d+)$/);
    const at = atMatch ? Number(atMatch[1]) : -1;
    let hit: any = null;
    if (at >= 0 && arr[at] && sameReportedQuestion(snapshot, arr[at].q || arr[at].question)) {
      hit = arr[at];
    }
    if (!hit) {
      const hits = arr.filter((q: any) => sameReportedQuestion(snapshot, q.q || q.question));
      if (hits.length === 1) hit = hits[0];
      else if (hits.length > 1) { ambiguous++; continue; }
    }
    if (!hit) { noMatch++; continue; }

    const qid = qidString(hit.id);
    if (!qid) { noQuestionId++; continue; }
    matched++;
    if (examples.length < 10) {
      examples.push({ reportId: r.id, qid: Number(qid), text: String(snapshot).slice(0, 120) });
    }
    if (apply) {
      const { error } = await supabase.from('question_reports').update({ qid }).eq('id', r.id);
      if (error) failed++; else applied++;
    }
  }

  return json({
    success: true, apply, scanned: candidates.length, matched, applied,
    ambiguous, noMatch, noFile, noQuestionId, failed, examples,
  });
}

export async function adminexportcorrections(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_view');
  if (!admin.ok) return json(admin.error);
  const data = await selectAll('question_reports', '*', { orderBy: 'id', apply: q => q.eq('status', 'resolved').eq('corrected', 'true') });
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

  const rows = await selectAll('progress', 'username,data', { orderBy: 'username' });
  // FIX BUG-08: track unique usernames per uid instead of hardcoding 1.
  const tally: Record<string, { n: number; w: number; users: Set<string> }> = {};
  for (const row of rows) {
    const user = String(row.username || '');
    const parsed = await readProgress(row.data);   // understands gz1: compressed rows
    const sessions = Array.isArray(parsed?.prog?.sessions) ? parsed.prog.sessions : [];
    sessions.forEach((s: any) => {
      (s?.qres || []).forEach((qr: any) => {
        if (!qr.uid) return;
        const r = tally[qr.uid] || (tally[qr.uid] = { n: 0, w: 0, users: new Set() });
        r.n++; if (!qr.ok) r.w++;
        if (user) r.users.add(user);
      });
    });
  }

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

  return json({ success: true, results, truncated: false, totalRowsScanned: rows.length });
}

const MAX_UPLOAD_B64 = 7 * 1024 * 1024;   // ~5 MB of JSON

function decodeJsonUpload(fileData: string): { bytes: Uint8Array; parsed: unknown } | { error: string } {
  if (!fileData.startsWith('data:')) return { error: 'Invalid file data' };
  const base64 = fileData.split(',')[1] || '';
  if (!base64) return { error: 'Invalid file data' };
  if (base64.length > MAX_UPLOAD_B64) return { error: 'File is too large (max ~5 MB).' };
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); } catch { return { error: 'Invalid file data' }; }
  try { return { bytes, parsed: JSON.parse(new TextDecoder().decode(bytes)) }; }
  catch { return { error: 'File is not valid JSON.' }; }
}

export async function adminuploadweeklysetfile(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'weeklysets_manage');
  if (!admin.ok) return json(admin.error);
  const filename = String(params.filename || 'weeklyset.json').replace(/[^\w.\-]+/g, '_');
  const dec = decodeJsonUpload(String(params.fileData || ''));
  if ('error' in dec) return json({ success: false, error: dec.error });

  // Reject unscorable sets NOW instead of when the first student submits.
  const key = extractCorrectAnswers(dec.parsed);
  if (!key || !key.length) return json({ success: false, error: 'No questions found in this file.' });
  const missing = key.filter(k => k === undefined || k === null || k === '').length;
  if (missing) return json({ success: false, error: `${missing} of ${key.length} questions have no correct answer.` });

  try {
    const path = `sets/${Date.now()}-${filename}`;
    const { error } = await supabase.storage.from('weekly-sets').upload(path, dec.bytes, { contentType: 'application/json' });
    if (error) throw error;
    return json({ success: true, fileId: path, filename, questionCount: key.length });
  } catch (e) { return json({ success: false, error: String(e) }); }
}

export async function adminuploadsubjectivefile(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'subjective_import');
  if (!admin.ok) return json(admin.error);
  const filename = String(params.filename || 'subjective.json').replace(/[^\w.\-]+/g, '_');
  const dec = decodeJsonUpload(String(params.fileData || ''));
  if ('error' in dec) return json({ success: false, error: dec.error });
  const parsed: any = dec.parsed;
  const arr = Array.isArray(parsed) ? parsed : (parsed?.questions || []);
  if (!Array.isArray(arr)) return json({ success: false, error: 'Expected an array of questions.' });
  try {
    const path = `questions/${Date.now()}-${filename}`;
    const { error } = await supabase.storage.from('subjective-content').upload(path, dec.bytes, { contentType: 'application/json' });
    if (error) throw error;
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