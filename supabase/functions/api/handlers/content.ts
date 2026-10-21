import { supabase } from '../_shared/db.ts';
import { json } from '../_shared/http.ts';
import { authUser, requireAccess } from '../_shared/auth.ts';
import { safeStoragePath } from '../_shared/utils.ts';
import { FILE_LEGACY_CONTENT } from '../_shared/config.ts';

async function resolveFilePayload(fileId: string): Promise<Record<string, unknown>> {
  if (/^https?:\/\//i.test(fileId)) return { success: true, url: fileId, legacy: true };
  if (!safeStoragePath(fileId)) return { success: false, error: 'Invalid file id.', fileId };

  let bucket = ''; let path = '';
  if (fileId.includes('/')) {
    const [b, ...rest] = fileId.split('/');
    if (['subjective-content', 'weekly-sets', 'study-docs'].includes(b)) { bucket = b; path = rest.join('/'); }
  }
  if (!bucket) {
    const needle = fileId.split('/').pop() || fileId;
    for (const b of ['subjective-content', 'weekly-sets', 'study-docs']) {
      const { data: list } = await supabase.storage.from(b).list('', { search: needle, limit: 5, sortBy: { column: 'name', order: 'asc' } });
      if (list && list.length) { bucket = b; path = (list.find(f => f.name === needle) || list[0]).name; break; }
    }
  }
  if (!bucket) return { success: false, error: 'File not found in Storage.', fileId };

  // FIX MINOR-05: 'subjective' was dead — only 'study-docs' actually reaches here.
  if (bucket === 'study-docs') {
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    return data ? { success: true, url: data.signedUrl, fileId, bucket, path, mimeType: 'application/pdf' } : { success: false, error: 'Could not sign URL.' };
  }

  const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(path);
  if (dlErr || !blob) return { success: false, error: 'Could not download file.' };
  const text = await blob.text();
  // The quiz engine reads `result` (parsed JSON). `content` (the raw string)
  // is kept for legacy clients while FILE_LEGACY_CONTENT is not 'false'.
  let result: unknown = text;
  try { result = JSON.parse(text); } catch { /* not JSON — hand back the raw text */ }
  const out: Record<string, unknown> = { success: true, result, fileId, bucket, path, size: text.length };
  if (FILE_LEGACY_CONTENT) out.content = text;
  return out;
}

export async function getfile(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  const fileId = String(params.fileId || params.file_id || params.id || params.path || '').trim();
  if (!fileId) return json({ success: false, error: 'fileId required' });
  return json(await resolveFilePayload(fileId));
}

export async function getfiles(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);

  const ids = [...new Set(String(params.fileIds || '').split(',').map(s => s.trim()).filter(Boolean))];
  if (!ids.length) return json({ success: false, error: 'Missing fileIds parameter.' });
  if (ids.length > 8) return json({ success: false, error: 'Max 8 files per request.' });

  const files: Record<string, unknown> = {};
  const deferred: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && totalChars > 8 * 1024 * 1024) { deferred.push(ids[i]); continue; }
    const entry = await resolveFilePayload(ids[i]);
    files[ids[i]] = entry;
    try { totalChars += JSON.stringify(entry).length; } catch { /* ignore */ }
  }
  return json({ success: true, files, deferred });
}