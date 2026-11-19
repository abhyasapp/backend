// handlers/pipeline.ts — the pipeline's three report endpoints (GitHub Actions + Neon).
//
//   syncreportssince  (sync key)   reports CHANGED since a cursor: new, resolved, re-opened
//   resolvereports    (sync key)   the pipeline closes / re-opens reports
//   admincorrect      (admin key)  validate a fix by qn id and start the GitHub workflow
//
// Same actions and JSON as the Apps Script twin (gas/admin-reports.gs), documented in
// docs/PIPELINE-CONTRACT.md and pinned by tests/parity-handlers.test.mjs.
//
// Schema facts these rely on:
//   • every question_reports column is NOT NULL DEFAULT '' → "clear" means '', never null;
//   • updated_at is stamped by a database trigger (migration 20261118…), so the cursor cannot be
//     forged and cannot run past a change.

import { supabase } from '../_shared/db.ts';
import { json, dbMsg } from '../_shared/http.ts';
import { chunk } from '../_shared/pure.ts';
import { qidString } from '../_shared/qid.ts';
import { rlBlocked, rlHit } from '../_shared/rate-limit.ts';

const MAX_RESOLVE_BATCH = 200;
const MAX_CORRECTIONS = 50;
const MAX_DISPATCH_CHARS = 60000;       // GitHub caps every workflow input at 65,535 chars
const MAX_SINCE_LIMIT = 1000;
const CORRECT_RATE_MAX = 60;            // dispatches per hour
const CORRECT_RATE_WINDOW_MS = 60 * 60 * 1000;

const UNAUTHORIZED = { success: false, error: 'unauthorized' };

/** Constant-time over the longer string, so neither content nor length leaks. */
export function safeEq(a: unknown, b: unknown): boolean {
  const x = String(a ?? ''), y = String(b ?? '');
  if (!x || !y) return false;
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

const syncKey = () => Deno.env.get('ABHYAS_SYNC_KEY') || Deno.env.get('SYNC_KEY') || '';
const adminKey = () => Deno.env.get('ABHYAS_ADMIN_KEY') || '';

function isoOrRaw(v: unknown): string {
  const s = String(v ?? '');
  if (!s) return '';
  const t = new Date(s).getTime();
  return isFinite(t) ? new Date(t).toISOString() : s;
}
const msOf = (v: unknown): number => { const t = new Date(String(v ?? '')).getTime(); return isFinite(t) ? t : 0; };
const numOrNull = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

function parseItems(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// ── syncreportssince ─────────────────────────────────────────────────────
export async function syncreportssince(params: Record<string, unknown>) {
  if (!safeEq(params.key, syncKey())) return json(UNAUTHORIZED, 401);
  const since = Math.max(0, Number(params.since) || 0);
  const limit = Math.max(1, Math.min(MAX_SINCE_LIMIT, Number(params.limit) || MAX_SINCE_LIMIT));

  // `since` is INCLUSIVE: the cursor is the newest change already delivered, so equality must not
  // skip a sibling sharing its millisecond. The boundary row is re-sent; the pipeline upserts by id.
  // Ordered by (updated_at, id) IN THE DATABASE: fetching the first N by id and filtering afterwards
  // (the old behaviour) hid every newer report once the table passed N rows.
  let q = supabase.from('question_reports').select('*');
  q = since ? q.gte('updated_at', new Date(since).toISOString()) : q.gt('updated_at', '');
  const { data, error } = await q.order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(limit + 1);
  if (error) return json({ success: false, error: dbMsg(error) }, 500);

  const rows = data || [];
  const page = rows.slice(0, limit);
  const reports = page.map((r: any) => ({
    id: String(r.id || ''), uid: String(r.uid || ''), qid: qidString(r.qid) || null,
    fileId: String(r.file_id || ''), questionSnapshot: String(r.question_snapshot || ''), optionsSnapshot: String(r.options_snapshot || ''),
    correctIndex: numOrNull(r.correct_index), chosenIndex: numOrNull(r.chosen_index),
    reason: String(r.reason || ''), note: String(r.note || ''), reportedBy: String(r.reported_by || ''),
    reportedAt: isoOrRaw(r.reported_at), status: String(r.status || 'open'),
    resolvedAt: isoOrRaw(r.resolved_at), resolvedBy: String(r.resolved_by || ''),
    // 'false' is a non-empty string: never use truthiness on this column.
    corrected: String(r.corrected ?? '').toLowerCase() === 'true', correctedSnapshot: String(r.corrected_snapshot || ''),
    section: String(r.section || ''), appVersion: String(r.app_version || ''),
    updatedAt: isoOrRaw(r.updated_at),
  }));
  const last = page.length ? page[page.length - 1] : null;
  return json({
    success: true, reports, count: reports.length, truncated: rows.length > limit,
    // `now` = the newest change actually RETURNED. Never the wall clock, never past rows cut off by
    // `limit`; with nothing to send it stays at `since`, so a write still in flight is never skipped.
    now: last ? msOf(last.updated_at) : since,
  });
}

// ── resolvereports ───────────────────────────────────────────────────────
export function validateResolveItems(items: unknown): { error: string } | { items: ResolveItem[] } {
  if (!Array.isArray(items) || !items.length) return { error: 'items must be a non-empty list' };
  if (items.length > MAX_RESOLVE_BATCH) return { error: 'too many items in one call' };
  const out: ResolveItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const it: any = items[i] || {};
    const id = String(it.id === null || it.id === undefined ? '' : it.id);
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) return { error: `item ${i}: bad id` };
    if (it.status !== 'open' && it.status !== 'resolved') return { error: `item ${i}: bad status` };
    const snap = it.correctedSnapshot === null || it.correctedSnapshot === undefined ? '' : String(it.correctedSnapshot);
    if (snap.length > 20000) return { error: `item ${i}: snapshot too large` };
    const when = it.resolvedAt ? new Date(it.resolvedAt) : null;
    if (when && isNaN(when.getTime())) return { error: `item ${i}: bad resolvedAt` };
    if (seen.has(id)) continue;                  // the same id twice in one call is one write
    seen.add(id);
    out.push({
      id, status: it.status,
      resolvedAt: when ? when.toISOString() : '',
      resolvedBy: it.resolvedBy ? String(it.resolvedBy).slice(0, 100) : '',
      corrected: it.corrected === true || it.corrected === 'true',
      correctedSnapshot: snap,
    });
  }
  return { items: out };
}
export interface ResolveItem { id: string; status: 'open' | 'resolved'; resolvedAt: string; resolvedBy: string; corrected: boolean; correctedSnapshot: string }

/** The exact column values an item means. Re-opening clears everything the resolve set. */
export function resolveTarget(item: ResolveItem, existing?: Record<string, any>, nowIso = new Date().toISOString()) {
  const resolved = item.status === 'resolved';
  const corrected = resolved && item.corrected;
  const curResolvedAt = isoOrRaw(existing?.resolved_at);
  return {
    status: item.status,
    // resolved without an explicit time: keep the one already there (idempotent), else now.
    resolved_at: resolved ? (item.resolvedAt || curResolvedAt || nowIso) : '',
    resolved_by: resolved ? item.resolvedBy : '',
    corrected: corrected ? 'true' : '',
    corrected_snapshot: corrected ? item.correctedSnapshot : '',
  };
}

export async function resolvereports(params: Record<string, unknown>) {
  if (!safeEq(params.key, syncKey())) return json(UNAUTHORIZED, 401);
  const checked = validateResolveItems(parseItems(params.items));
  if ('error' in checked) return json({ success: false, error: checked.error });

  const existing = new Map<string, Record<string, any>>();
  for (const part of chunk(checked.items.map(i => i.id), 100)) {
    const { data, error } = await supabase.from('question_reports')
      .select('id,status,resolved_at,resolved_by,corrected,corrected_snapshot').in('id', part);
    if (error) return json({ success: false, error: dbMsg(error) });
    (data || []).forEach((r: any) => existing.set(String(r.id), r));
  }

  const updated: string[] = [], missing: string[] = [], failed: string[] = [];
  const nowIso = new Date().toISOString();
  const work = checked.items.filter(it => {
    if (existing.has(it.id)) return true;
    missing.push(it.id); return false;
  });
  for (const part of chunk(work, 25)) {
    await Promise.all(part.map(async (it) => {
      const ex = existing.get(it.id)!;
      const t = resolveTarget(it, ex, nowIso);
      const same = String(ex.status || 'open') === t.status
        && isoOrRaw(ex.resolved_at) === (t.resolved_at ? isoOrRaw(t.resolved_at) : '')
        && String(ex.resolved_by || '') === t.resolved_by
        && String(ex.corrected ?? '').toLowerCase() === t.corrected
        && String(ex.corrected_snapshot || '') === t.corrected_snapshot;
      if (same) { updated.push(it.id); return; }          // a repeat of the same call writes nothing
      const { error } = await supabase.from('question_reports').update(t).eq('id', it.id);
      (error ? failed : updated).push(it.id);
    }));
  }
  const order = new Map(checked.items.map((it, i) => [it.id, i]));
  const byInput = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  return json({ success: true, updated: updated.sort(byInput), missing: missing.sort(byInput), failed: failed.sort(byInput) });
}

// ── admincorrect ─────────────────────────────────────────────────────────
export function validateCorrections(items: unknown): { error: string } | { items: Correction[] } {
  if (!Array.isArray(items) || !items.length) return { error: 'items must be a non-empty list' };
  if (items.length > MAX_CORRECTIONS) return { error: `at most ${MAX_CORRECTIONS} corrections per call` };
  const seen = new Set<string>();
  const out: Correction[] = [];
  for (let i = 0; i < items.length; i++) {
    const it: any = items[i] || {};
    const tag = `item ${i}: `;
    const qn = String(it.qn === null || it.qn === undefined ? '' : it.qn).trim();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(qn)) return { error: tag + 'bad qn id' };
    if (seen.has(qn)) return { error: tag + 'duplicate qn id ' + qn };
    seen.add(qn);
    const question = String(it.question === null || it.question === undefined ? '' : it.question).trim();
    if (!question || question.length > 2000) return { error: tag + 'question must be 1-2000 chars' };
    const options = it.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 10) return { error: tag + 'need 2-10 options' };
    const cleaned: string[] = [];
    for (let j = 0; j < options.length; j++) {
      const o = String(options[j] === null || options[j] === undefined ? '' : options[j]).trim();
      if (!o || o.length > 1000) return { error: tag + `option ${j} must be 1-1000 chars` };
      cleaned.push(o);
    }
    const ci = it.correctIndex;
    if (typeof ci !== 'number' || ci % 1 !== 0 || ci < 0 || ci >= cleaned.length) return { error: tag + 'correctIndex must be an integer inside the options' };
    const explanation = it.explanation === null || it.explanation === undefined ? '' : String(it.explanation);
    if (explanation.length > 4000) return { error: tag + 'explanation too long' };
    out.push({ qn, question, options: cleaned, correctIndex: ci, explanation, note: it.note ? String(it.note).slice(0, 200) : '' });
  }
  return { items: out };
}
export interface Correction { qn: string; question: string; options: string[]; correctIndex: number; explanation: string; note: string }

export function dispatchBody(items: Correction[], publish: unknown): { error: string } | { body: Record<string, unknown> } {
  const text = JSON.stringify(items);
  if (text.length > MAX_DISPATCH_CHARS) return { error: 'payload too large for one workflow run; send fewer corrections' };
  // Publishing republishes the question JSON to Drive, which students see. Only an explicit
  // true / "true" does that; an omitted or garbled flag never publishes.
  const doPublish = publish === true || publish === 'true';
  return { body: { ref: Deno.env.get('GITHUB_REF') || 'main', inputs: { corrections_json: text, publish: doPublish ? 'true' : 'false' } } };
}

export async function admincorrect(params: Record<string, unknown>) {
  const key = adminKey();
  if (!safeEq(params.adminKey, key)) return json(UNAUTHORIZED, 401);
  // The admin key must be its own secret: if it equals the sync key, anything that can read the
  // pipeline secret could also dispatch workflows.
  if (safeEq(key, syncKey())) return json({ success: false, error: 'ABHYAS_ADMIN_KEY must differ from the sync key' });
  const checked = validateCorrections(parseItems(params.items));
  if ('error' in checked) return json({ success: false, error: checked.error });
  const built = dispatchBody(checked.items, params.publish);
  if ('error' in built) return json({ success: false, error: built.error });

  const token = Deno.env.get('GITHUB_TOKEN') || '';
  if (!token) return json({ success: false, error: 'GITHUB_TOKEN not set' });
  if (await rlBlocked('admincorrect', CORRECT_RATE_MAX)) return json({ success: false, error: 'too many corrections dispatched; try again later' });
  await rlHit('admincorrect', CORRECT_RATE_WINDOW_MS);

  const repo = Deno.env.get('GITHUB_REPO') || 'abhyasapp/DRIVETONEONTODRIVE';
  const workflow = Deno.env.get('GITHUB_WORKFLOW') || 'apply_admin_corrections.yml';
  let status = 0;
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
      },
      body: JSON.stringify(built.body),
      signal: AbortSignal.timeout(15000),
    });
    status = resp.status;
  } catch { /* network error → status stays 0 */ }
  if (status !== 204) return json({ success: false, error: `GitHub dispatch failed (HTTP ${status})` });
  return json({ success: true, queued: checked.items.length });
}
