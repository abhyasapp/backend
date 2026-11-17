import { supabase } from '../_shared/db.ts';
import { json } from '../_shared/http.ts';
import { authUser, authAdmin, requireAccess } from '../_shared/auth.ts';
import { safeStoragePath } from '../_shared/utils.ts';
import { stripAnswers } from '../_shared/pure.ts';
import { FILE_LEGACY_CONTENT, WEEKLY_EXAM_WINDOW_MS, WEEKLY_HIDE_ANSWERS } from '../_shared/config.ts';
import { overlayFileJson } from '../_shared/corrections.ts';

const BUCKETS = ['subjective-content', 'weekly-sets', 'study-docs'];
// submitweeklyattempt accepts answers until release + window + 3h, so keep answers hidden that long.
const WEEKLY_ANSWER_HIDE_MS = WEEKLY_EXAM_WINDOW_MS + 3 * 60 * 60 * 1000;

/** Exact-name lookup inside the file's own folder. (storage `search` is a fuzzy ILIKE, so never trust its first hit.) */
async function existsInBucket(bucket: string, path: string): Promise<boolean> {
  const idx = path.lastIndexOf('/');
  const dir = idx >= 0 ? path.slice(0, idx) : '';
  const name = path.slice(idx + 1);
  if (!name) return false;
  const { data } = await supabase.storage.from(bucket).list(dir, { search: name, limit: 100 });
  return !!(data || []).find((f) => f.name === name);
}

async function resolveFilePayload(fileId: string, isAdmin = false): Promise<Record<string, unknown>> {
  if (/^https?:\/\//i.test(fileId)) return { success: true, url: fileId, legacy: true };
  if (!safeStoragePath(fileId)) return { success: false, error: 'Invalid file id.', fileId };

  let bucket = ''; let path = '';
  if (fileId.includes('/')) {
    const [b, ...rest] = fileId.split('/');
    if (BUCKETS.includes(b)) { bucket = b; path = rest.join('/'); }
  }
  if (!bucket) {
    for (const b of BUCKETS) {
      if (await existsInBucket(b, fileId)) { bucket = b; path = fileId; break; }
    }
  }
  if (!bucket || !path) return { success: false, error: 'File not found in Storage.', fileId };

  if (bucket === 'study-docs') {
    // Only documents that are published in study_docs may be signed; hidden/unlisted files stay private.
    if (!isAdmin) {
      const { data: doc } = await supabase.from('study_docs').select('id')
        .eq('status', 'published').in('file_id', [path, `study-docs/${path}`]).limit(1);
      if (!doc || !doc[0]) return { success: false, error: "That document isn't available.", fileId };
    }
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    return data ? { success: true, url: data.signedUrl, fileId, bucket, path, mimeType: 'application/pdf' } : { success: false, error: 'Could not sign URL.' };
  }

  // Weekly sets: not served before release, and served WITHOUT answers while the exam window is open.
  let hideAnswers = false;
  if (bucket === 'weekly-sets' && !isAdmin) {
    const { data: sets } = await supabase.from('weekly_sets').select('release_at')
      .in('file_id', [path, `weekly-sets/${path}`, fileId]).limit(1);
    const rel = sets && sets[0] ? new Date(String(sets[0].release_at)).getTime() : NaN;
    const now = Date.now();
    if (isNaN(rel) || now < rel) return { success: false, error: 'This weekly set is not open yet.', fileId };
    hideAnswers = WEEKLY_HIDE_ANSWERS && now <= rel + WEEKLY_ANSWER_HIDE_MS;
  }

  const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(path);
  if (dlErr || !blob) return { success: false, error: 'Could not download file.' };
  let text = await blob.text();
  // The quiz engine reads `result` (parsed JSON). `content` (the raw string)
  // is kept for legacy clients while FILE_LEGACY_CONTENT is not 'false'.
  let result: unknown = text;
  try { result = JSON.parse(text); } catch { /* not JSON — hand back the raw text */ }
  // An admin correction reaches the learner on the next request instead of waiting
  // for the pipeline to re-export the file (docs/content-versioning.md, phase 0).
  // Applied before answers are stripped, so an open exam window never leaks a fixed key.
  if (result && typeof result === 'object') {
    const corrected = await overlayFileJson(result);
    if (corrected) text = JSON.stringify(result);
  }
  if (hideAnswers && typeof result === 'object' && result !== null) {
    result = stripAnswers(result);
    text = JSON.stringify(result);
  }
  const out: Record<string, unknown> = { success: true, result, fileId, bucket, path, size: text.length };
  if (hideAnswers) out.answersHidden = true;
  if (FILE_LEGACY_CONTENT) out.content = text;
  return out;
}

async function callerIsAdmin(params: Record<string, unknown>): Promise<boolean> {
  if (!params.adminToken) return false;
  const res = await authAdmin({ username: params.username, token: params.adminToken });
  return res.ok;
}

/* An admin session is accepted before a student one, the same order Apps Script
   uses. Checking students first rejected every console read with "Session
   expired", so the console could never read content from Storage and had to fall
   back to Drive, where historical sets are no longer allowed. */
export async function getfile(params: Record<string, unknown>) {
  const isAdmin = await callerIsAdmin(params);
  if (!isAdmin) {
    const auth = await authUser(params);
    if (!auth.ok) return json(auth.error);
    const gate = requireAccess(auth);
    if (gate) return json(gate);
  }

  const fileId = String(params.fileId || params.file_id || params.id || params.path || '').trim();
  if (!fileId) return json({ success: false, error: 'fileId required' });
  return json(await resolveFilePayload(fileId, isAdmin));
}

export async function getfiles(params: Record<string, unknown>) {
  const isAdmin = await callerIsAdmin(params);
  if (!isAdmin) {
    const auth = await authUser(params);
    if (!auth.ok) return json(auth.error);
    const gate = requireAccess(auth);
    if (gate) return json(gate);
  }

  const ids = [...new Set(String(params.fileIds || '').split(',').map(s => s.trim()).filter(Boolean))];
  if (!ids.length) return json({ success: false, error: 'Missing fileIds parameter.' });
  if (ids.length > 8) return json({ success: false, error: 'Max 8 files per request.' });

  const files: Record<string, unknown> = {};
  const deferred: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && totalChars > 8 * 1024 * 1024) { deferred.push(ids[i]); continue; }
    const entry = await resolveFilePayload(ids[i], isAdmin);
    files[ids[i]] = entry;
    try { totalChars += JSON.stringify(entry).length; } catch { /* ignore */ }
  }
  return json({ success: true, files, deferred });
}
