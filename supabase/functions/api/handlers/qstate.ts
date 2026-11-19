// handlers/qstate.ts — everything a student or admin stores ABOUT a question,
// keyed by the question's qid (never its position or file).
//
//   syncqstate        notes / bookmarks / flags / mistake-list, merged per FIELD
//   recordanswers     idempotent answer events → counters + per-qid statistics
//   getqidpatches     admin corrections as qid-keyed patches (apply on-device)
//   resolveqids       merged / retired qid → canonical qid
//   adminqidcoverage  how identity-ready a file / the whole bank is
//   ingestquestionindex   pipeline (SYNC_KEY) pushes the registry
//
// All of these have a 1:1 Apps Script twin in gas/qid.gs and the same JSON
// contract (see docs/QID-CONTRACT.md), pinned by tests/parity.test.mjs.

import { supabase, selectAll } from '../_shared/db.ts';
import { json, dbMsg } from '../_shared/http.ts';
import { authUser, authAdmin, requireAccess } from '../_shared/auth.ts';
import { chunk } from '../_shared/pure.ts';
import { rlBlocked, rlHit, RL_TOO_MANY } from '../_shared/rate-limit.ts';
import { qidString, parseQid, qidCoverage, questionRev } from '../_shared/qid.ts';
import { canonicalMap } from '../_shared/qindex.ts';
import { loadFileForEdit } from '../_shared/qfile.ts';
import { constantTimeEqual } from './reports.ts';
import { isoOf, boolText, toBool, FIELD_SETS, mergeStateChange, foldAnswers, FUTURE_SKEW_MS, type AnsEv } from '../_shared/qstate-core.ts';

const MAX_CHANGES = 200;
const MAX_EVENTS = 200;
const EVENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function arrayParam(v: unknown): any[] | null {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? a : null;
  } catch { return null; }
}

function stateView(r: Record<string, any>) {
  return {
    qid: String(r.qid || ''), fileId: String(r.file_id || ''),
    note: String(r.note || ''), noteAt: String(r.note_at || ''),
    bookmarked: toBool(r.bookmarked), bookmarkedAt: String(r.bookmarked_at || ''),
    flagged: toBool(r.flagged), flaggedAt: String(r.flagged_at || ''),
    inMistakes: toBool(r.in_mistakes), mistakesAt: String(r.mistakes_at || ''),
    attempts: Number(r.attempts || 0), wrong: Number(r.wrong || 0),
    lastResult: String(r.last_result || ''), lastAt: String(r.last_at || ''),
    updatedAt: String(r.updated_at || ''),
  };
}

export async function syncqstate(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  const changes = params.changes === undefined || params.changes === '' ? [] : arrayParam(params.changes);
  if (changes === null) return json({ success: false, error: 'Malformed changes.' });
  if (changes.length > MAX_CHANGES) return json({ success: false, error: `At most ${MAX_CHANGES} changes per request.` });
  const since = isoOf(params.since);
  // Every row written by one request shares one timestamp (up to MAX_CHANGES rows). The page size is
  // never smaller than that, so a tie group always fits in one page and the inclusive cursor below
  // can never skip a row.
  const limit = Math.max(MAX_CHANGES, Math.min(2000, Number(params.limit) || 1000));
  const nowIso = new Date().toISOString();

  const rejected: Array<{ index: number; reason: string }> = [];
  let applied = 0;

  if (changes.length) {
    const rlKey = 'qs:' + auth.username.toLowerCase();
    if (await rlBlocked(rlKey, 600)) return json(RL_TOO_MANY);
    await rlHit(rlKey, 60 * 60 * 1000);

    // Normalise ids, redirect merged/retired ids to their canonical qid.
    const wanted = changes.map(c => qidString(c?.qid));
    const canon = await canonicalMap(wanted.filter(Boolean));
    const byQid = new Map<string, Record<string, any>>();         // later changes for one qid fold in order
    changes.forEach((c, i) => {
      const q = wanted[i];
      if (!q) { rejected.push({ index: i, reason: 'bad_qid' }); return; }
      const cq = canon.get(q) || q;
      const prev = byQid.get(cq) || { qid: cq };
      // Fold: per field keep the change with the newer timestamp.
      for (const f of FIELD_SETS) {
        if (c[f.prop] === undefined) continue;
        const a = isoOf(c[f.at]) || nowIso;
        if (prev[f.prop] === undefined || a >= (isoOf(prev[f.at]) || '')) { prev[f.prop] = c[f.prop]; prev[f.at] = a; }
      }
      if (c.fileId) prev.fileId = String(c.fileId).slice(0, 200);
      byQid.set(cq, prev);
    });

    const existing = new Map<string, Record<string, any>>();
    for (const part of chunk([...byQid.keys()], 150)) {
      const { data } = await supabase.from('user_qstate').select('*').eq('username', auth.username).in('qid', part);
      (data || []).forEach(r => existing.set(String(r.qid), r));
    }

    const upserts: Record<string, any>[] = [];
    for (const [qid, ch] of byQid) {
      const ex = existing.get(qid);
      const patch = mergeStateChange(ex, ch, nowIso);
      if (!patch) continue;
      upserts.push({
        ...(ex || { username: auth.username, qid, file_id: '', attempts: '0', wrong: '0', last_result: '', last_at: '' }),
        username: auth.username, qid,
        file_id: ch.fileId || ex?.file_id || '',
        ...patch, updated_at: nowIso,
      });
    }
    for (const part of chunk(upserts, 100)) {
      const { error } = await supabase.from('user_qstate').upsert(part, { onConflict: 'username,qid' });
      if (error) return json({ success: false, error: dbMsg(error) });
      applied += part.length;
    }
  }

  // Delta read: everything that changed on the server after `since` — this
  // device's own writes included — so a second device converges in one call.
  let q = supabase.from('user_qstate').select('*').eq('username', auth.username);
  // INCLUSIVE: the cursor is the newest change already delivered; a sibling sharing its millisecond must
  // not be skipped. The boundary row is re-sent, and clients merge by field timestamp, so that is harmless.
  if (since) q = q.gte('updated_at', since);
  const { data: rows, error } = await q.order('updated_at', { ascending: true }).order('qid', { ascending: true }).limit(limit + 1);
  if (error) return json({ success: false, error: dbMsg(error) });
  const page = (rows || []).slice(0, limit);
  return json({
    success: true, applied, rejected, serverNow: nowIso,
    rows: page.map(stateView),
    cursor: page.length ? String(page[page.length - 1].updated_at) : since,
    more: (rows || []).length > limit,
  });
}

export async function recordanswers(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  const events = arrayParam(params.events);
  if (!events || !events.length) return json({ success: false, error: 'events required.' });
  if (events.length > MAX_EVENTS) return json({ success: false, error: `At most ${MAX_EVENTS} events per request.` });
  const rlKey = 'ans:' + auth.username.toLowerCase();
  if (await rlBlocked(rlKey, 600)) return json(RL_TOO_MANY);
  await rlHit(rlKey, 60 * 60 * 1000);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const rejected: Array<{ index: number; reason: string }> = [];
  const wanted = events.map(e => qidString(e?.qid));
  const canon = await canonicalMap(wanted.filter(Boolean));

  type Ev = { qid: string; at: string; ok: boolean; chosen: string; fileId: string; mode: string; sessionId: string };
  const clean: Ev[] = [];
  events.forEach((e, i) => {
    const q = wanted[i];
    if (!q) { rejected.push({ index: i, reason: 'bad_qid' }); return; }
    if (typeof e.ok !== 'boolean' && e.ok !== 'true' && e.ok !== 'false') { rejected.push({ index: i, reason: 'bad_ok' }); return; }
    const at = isoOf(e.at) || nowIso;
    const atMs = new Date(at).getTime();
    if (atMs > nowMs + FUTURE_SKEW_MS || atMs < nowMs - EVENT_MAX_AGE_MS) { rejected.push({ index: i, reason: 'bad_time' }); return; }
    const n = Number(e.chosen);
    clean.push({
      qid: canon.get(q) || q, at, ok: toBool(e.ok),
      chosen: Number.isInteger(n) && n >= 0 && n < 10 ? String(n) : '',
      fileId: String(e.fileId || '').slice(0, 200), mode: String(e.mode || '').slice(0, 20), sessionId: String(e.sessionId || '').slice(0, 64),
    });
  });

  // Idempotency: one event per (student, qid, instant). A retried batch is a no-op.
  const have = new Set<string>();
  for (const part of chunk([...new Set(clean.map(c => c.qid))], 100)) {
    const { data } = await supabase.from('answer_events').select('qid,at').eq('username', auth.username).in('qid', part);
    (data || []).forEach(r => have.add(r.qid + '|' + r.at));
  }
  const fresh = clean.filter((c, i) => {
    const k = c.qid + '|' + c.at;
    if (have.has(k)) return false;
    have.add(k); return true;
  });
  const duplicates = clean.length - fresh.length;

  const accepted: Ev[] = [];
  for (const ev of fresh) {
    const { error } = await supabase.from('answer_events').insert({
      username: auth.username, qid: ev.qid, at: ev.at, file_id: ev.fileId, ok: String(ev.ok),
      chosen: ev.chosen, mode: ev.mode, session_id: ev.sessionId,
    });
    if (error) { if (String((error as any).code || '') === '23505') continue; return json({ success: false, error: dbMsg(error) }); }
    accepted.push(ev);
  }

  // Fold into per-qid state + atomic global stats.
  const perQid = new Map<string, Ev[]>();
  accepted.forEach(e => perQid.set(e.qid, [...(perQid.get(e.qid) || []), e]));
  const existing = new Map<string, Record<string, any>>();
  for (const part of chunk([...perQid.keys()], 150)) {
    const { data } = await supabase.from('user_qstate').select('*').eq('username', auth.username).in('qid', part);
    (data || []).forEach(r => existing.set(String(r.qid), r));
  }
  const touched: any[] = [];
  for (const [qid, evs] of perQid) {
    const ex = existing.get(qid);
    const { row, wrongN, prevAttempts } = foldAnswers(ex, evs as AnsEv[], nowIso);
    touched.push({ ...row, username: auth.username, qid });
    await supabase.rpc('bump_qid_stats', { p_qid: qid, p_attempts: evs.length, p_wrong: wrongN, p_students: prevAttempts === 0 ? 1 : 0 });
  }
  for (const part of chunk(touched, 100)) {
    const { error } = await supabase.from('user_qstate').upsert(part, { onConflict: 'username,qid' });
    if (error) return json({ success: false, error: dbMsg(error) });
  }
  return json({ success: true, accepted: accepted.length, duplicates, rejected, state: touched.map(stateView) });
}

/** Admin corrections as qid-keyed patches: a client applies each by qid to its
 *  cached copy of ANY file, so a correction reaches students without waiting
 *  for the content CDN / pipeline re-export. */
export async function getqidpatches(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  const since = isoOf(params.since) || new Date(0).toISOString();
  const limit = Math.max(1, Math.min(500, Number(params.limit) || 500));
  const fileId = String(params.fileId || '').trim();
  let q = supabase.from('correction_events').select('qid,file_id,corrected_at,before,after,base_rev,new_rev').gt('corrected_at', since);
  if (fileId) q = q.eq('file_id', fileId);
  const { data, error } = await q.order('corrected_at', { ascending: true }).limit(limit + 1);
  if (error) return json({ success: false, error: dbMsg(error) });
  const page = (data || []).slice(0, limit);
  const latest = new Map<string, any>();
  for (const ev of page) {
    const qid = qidString(ev.qid);
    if (!qid) continue;                        // legacy position-only events cannot be applied by id
    let after: any = null;
    try { after = JSON.parse(ev.after); } catch { /* skip */ }
    if (!after || !String(after.question || '').trim()) continue;
    latest.set(qid, {
      qid, fileId: ev.file_id, correctedAt: ev.corrected_at, baseRev: ev.base_rev || '',
      // Events written before the revision columns existed have no new_rev: derive it from the `after`
      // side with the same hash inputs as questionRev() (and the Apps Script twin), never leave it blank.
      rev: ev.new_rev || questionRev({
        q: String(after.question || ''), options: Array.isArray(after.options) ? after.options.map(String) : [],
        correct: Number.isInteger(after.correctIndex) && after.correctIndex >= 0 ? after.correctIndex : undefined,
        explanation: String(after.explanation || ''),
      }),
      question: after.question, options: after.options || [], correctIndex: after.correctIndex ?? null, explanation: after.explanation || '',
    });
  }
  const canon = await canonicalMap([...latest.keys()]);
  const patches = [...latest.values()].map(p => ({ ...p, canonicalQid: canon.get(p.qid) || p.qid }));
  return json({
    success: true, patches, truncated: (data || []).length > limit,
    cursor: page.length ? String(page[page.length - 1].corrected_at) : since, serverNow: new Date().toISOString(),
  });
}

export async function resolveqids(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const list = arrayParam(params.qids);
  if (!list || !list.length || list.length > 500) return json({ success: false, error: 'qids required (max 500).' });
  const ids = [...new Set(list.map(qidString).filter(Boolean))];
  const canon = await canonicalMap(ids);
  const info: Record<string, any> = {};
  for (const part of chunk([...new Set([...canon.values()])], 150)) {
    const { data } = await supabase.from('question_index').select('qid,file_id,rev,status,kind').in('qid', part);
    (data || []).forEach(r => { info[String(r.qid)] = { fileId: r.file_id, rev: r.rev, status: r.status, kind: r.kind }; });
  }
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const c = canon.get(id) || id;
    out[id] = { canonicalQid: c, redirected: c !== id, ...(info[c] || { fileId: '', rev: '', status: 'unknown', kind: parseQid(c).kind }) };
  }
  return json({ success: true, qids: out });
}

export async function adminqidcoverage(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'qreports_view');
  if (!admin.ok) return json(admin.error);
  const fileId = String(params.fileId || '').trim();
  if (fileId) {
    const lf = await loadFileForEdit(fileId);
    if (!lf) return json({ success: false, error: 'Could not read file' });
    return json({ success: true, fileId, source: lf.source, overlay: lf.overlay, coverage: qidCoverage(lf.arr) });
  }
  let rows: any[];
  try { rows = await selectAll('question_index', 'qid,file_id,kind,status,canonical_qid', { orderBy: 'qid', max: 200000 }); }
  catch (e) { return json({ success: false, error: dbMsg(e) }); }
  const files = new Set<string>();
  const sum = { questions: rows.length, stable: 0, positional: 0, retired: 0, merged: 0 };
  rows.forEach(r => {
    files.add(String(r.file_id));
    if (r.kind === 'stable') sum.stable++; else if (r.kind === 'positional') sum.positional++;
    if (r.status === 'retired') sum.retired++;
    if (r.status === 'merged' || String(r.canonical_qid || '')) sum.merged++;
  });
  return json({ success: true, files: files.size, ...sum, note: 'Per-file detail: pass fileId.' });
}

/** Recomputes qid_stats from the immutable answer log (SYNC_KEY). qid_stats is DERIVED data: the
 *  nightly sync never merges it (two backends' counters cannot be added without double counting);
 *  it runs this after syncing answer_events so both sides hold the same totals. Idempotent. */
export async function rebuildqidstats(params: Record<string, unknown>) {
  const expected = Deno.env.get('SYNC_KEY') || Deno.env.get('ABHYAS_SYNC_KEY') || '';
  if (!expected) return json({ success: false, code: 'not_configured', error: 'SYNC_KEY is not set on the api function.' }, 503);
  if (!constantTimeEqual(String(params.key || ''), expected)) return json({ success: false, code: 'unauthorized', error: 'unauthorized' }, 401);
  let events: any[];
  try { events = await selectAll('answer_events', 'username,qid,ok', { orderBy: 'username', max: 2000000 }); }
  catch (e) { return json({ success: false, error: dbMsg(e) }); }
  const tally = new Map<string, { attempts: number; wrong: number; users: Set<string> }>();
  for (const e of events) {
    const qid = qidString(e.qid);
    if (!qid) continue;
    const t = tally.get(qid) || { attempts: 0, wrong: 0, users: new Set<string>() };
    t.attempts++; if (String(e.ok) !== 'true') t.wrong++; t.users.add(String(e.username));
    tally.set(qid, t);
  }
  const now = new Date().toISOString();
  const rows = [...tally.entries()].map(([qid, t]) => ({ qid, attempts: String(t.attempts), wrong: String(t.wrong), students: String(t.users.size), updated_at: now }));
  for (const part of chunk(rows, 400)) {
    const { error } = await supabase.from('qid_stats').upsert(part, { onConflict: 'qid' });
    if (error) return json({ success: false, error: dbMsg(error) });
  }
  return json({ success: true, rebuilt: rows.length, events: events.length });
}

export async function ingestquestionindex(params: Record<string, unknown>) {
  const expected = Deno.env.get('SYNC_KEY') || Deno.env.get('ABHYAS_SYNC_KEY') || '';
  if (!expected) return json({ success: false, code: 'not_configured', error: 'SYNC_KEY is not set on the api function.' }, 503);
  const key = String(params.key || '');
  if (!key || !constantTimeEqual(key, expected)) {
    return json({ success: false, code: 'unauthorized', error: 'unauthorized' }, 401);
  }
  const rows = arrayParam(params.rows);
  if (!rows || !rows.length) return json({ success: false, error: 'rows required.' });
  if (rows.length > 1000) return json({ success: false, error: 'At most 1000 rows per call.' });

  const now = new Date().toISOString();
  const out: Record<string, any>[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  rows.forEach((r, i) => {
    const p = parseQid(r?.qid);
    if (!p.qid) { rejected.push({ index: i, reason: 'bad_qid' }); return; }
    const row: Record<string, any> = { qid: p.qid, kind: p.kind, updated_at: now };
    if (r.fileId !== undefined) row.file_id = String(r.fileId).slice(0, 200);
    if (r.ord !== undefined) row.ord = String(Number(r.ord) >= 0 ? Number(r.ord) : '');
    if (r.rev !== undefined) row.rev = String(r.rev).slice(0, 40);
    if (r.status !== undefined && ['active', 'retired', 'merged'].includes(String(r.status))) row.status = String(r.status);
    if (r.canonicalQid !== undefined) {
      const c = qidString(r.canonicalQid);
      if (String(r.canonicalQid) && (!c || c === p.qid)) { rejected.push({ index: i, reason: 'bad_canonical' }); return; }
      row.canonical_qid = c;
    }
    out.push(row);
  });
  for (const part of chunk(out, 400)) {
    const { error } = await supabase.from('question_index').upsert(part, { onConflict: 'qid' });
    if (error) return json({ success: false, error: dbMsg(error) });
  }
  return json({ success: true, upserted: out.length, rejected });
}
