import { supabase } from '../_shared/db.ts';
import { recordDeletion } from '../_shared/tombstones.ts';
import { json, dbMsg } from '../_shared/http.ts';
import { authUser, authAdmin, requireAccess } from '../_shared/auth.ts';
import { randId, base64ToBytes, isPdfBytes } from '../_shared/crypto.ts';
import { isStoragePath, ownedUploadPath } from '../_shared/utils.ts';   // FIX MINOR-04: import isStoragePath

async function signedPdfUrl(bucket: string, pathOrUrl: string): Promise<string> {
  if (!pathOrUrl) return '';
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (!pathOrUrl.includes('/')) return '';
  const { data } = await supabase.storage.from(bucket).createSignedUrl(pathOrUrl, 60 * 60);
  return data ? data.signedUrl : '';
}

export async function adminlistsubjectivesubmissions(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'subjective_view');
  if (!admin.ok) return json(admin.error);
  const status = String(params.status || '').trim();
  const chapterId = String(params.chapterId || '').trim();
  const kind = String(params.kind || '').trim();
  const from = params.dateFrom ? new Date(String(params.dateFrom) + 'T00:00:00').getTime() : null;
  const to = params.dateTo ? new Date(String(params.dateTo) + 'T23:59:59.999').getTime() : null;
  const limit = Math.min(Number(params.limit) || 500, 500);

  let q = supabase.from('subjective_submissions').select('*');
  if (status) q = q.eq('status', status);
  if (chapterId) q = q.eq('chapter_id', chapterId);
  if (kind) q = q.eq('kind', kind);
  q = q.order('submitted_at', { ascending: false }).limit(limit);

  const { data, error } = await q;
  if (error) return json({ success: false, error: dbMsg(error) });
  const rows = (data || []).filter(r => {
    const t = Number(r.submitted_at || 0);
    return (from === null || t >= from) && (to === null || t <= to);
  });

  return json({
    success: true,
    submissions: rows.map(r => ({
      id: r.id, username: r.username, kind: r.kind, questionId: r.question_id, questionText: r.question_text,
      questionMarks: Number(r.question_marks || 0), chapterId: r.chapter_id, solveSec: Number(r.solve_sec || 0),
      startedAt: Number(r.started_at || 0), submittedAt: Number(r.submitted_at || 0), pdfUrl: r.pdf_url || '',
      status: r.status, score: r.score === null || r.score === undefined ? null : Number(r.score),
      feedback: r.feedback || '', gradedBy: r.graded_by || '', gradedAt: r.graded_at || '',
      pdfReplacedAt: r.pdf_replaced_at || '', pdfReplacedBy: r.pdf_replaced_by || '', pdfOriginalBackupId: r.pdf_original_backup_id || '',
    })),
  });
}

export async function admingradesubjectivesubmission(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'subjective_grade');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '').trim();
  const score = Number(params.score);
  const feedback = String(params.feedback || '').trim().slice(0, 2000);
  if (!id) return json({ success: false, error: 'id required.' });
  if (!isFinite(score) || score < 0) return json({ success: false, error: 'Valid score required.' });

  const { data } = await supabase.from('subjective_submissions').select('*').eq('id', id).limit(1);
  if (!data || !data[0]) return json({ success: false, error: 'Submission not found.' });
  const clamped = Math.min(score, Number(data[0].question_marks) || 100);

  const { error } = await supabase.from('subjective_submissions').update({ status: 'graded', score: clamped, feedback, graded_by: admin.username, graded_at: new Date().toISOString() }).eq('id', id);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, id, score: clamped, maxMarks: Number(data[0].question_marks) || 100 });
}

export async function admindownloadsubmissionpdf(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'subjective_view');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'Submission id required.' });
  const { data } = await supabase.from('subjective_submissions').select('*').eq('id', id).limit(1);
  if (!data || !data[0]) return json({ success: false, error: 'Submission not found.' });
  const stored = String(data[0].pdf_file_id || '').trim();
  if (!isStoragePath(stored)) return json({ success: false, error: 'This file is stored on Drive — not migrated yet.' });
  const signed = await signedPdfUrl('subjective', stored);
  if (!signed) return json({ success: false, error: 'Could not sign PDF URL.' });
  return json({ success: true, url: signed, expiresInSec: 3600 });
}

export async function adminreplacesubmissionpdf(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'subjective_grade');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'Submission id required.' });

  const { data } = await supabase.from('subjective_submissions').select('*').eq('id', id).limit(1);
  if (!data || !data[0]) return json({ success: false, error: 'Submission not found.' });
  const currentPath = String(data[0].pdf_file_id || '').trim();
  if (!isStoragePath(currentPath)) return json({ success: false, error: 'This file is on Drive — cannot replace here.' });

  let newPath = String(params.newPdfPath || '').trim();
  if (!newPath) {
    const legacyData = String(params.pdfData || params.fileData || '');
    if (!legacyData.startsWith('data:')) return json({ success: false, error: 'Missing new PDF data.' });
    const bytes = base64ToBytes(legacyData.split(',')[1]);
    if (!isPdfBytes(bytes)) return json({ success: false, error: "That file isn't a valid PDF." });
    newPath = `replaced/${Date.now()}-${id.slice(0, 8)}.pdf`;
    const { error: upErr } = await supabase.storage.from('subjective').upload(newPath, bytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) return json({ success: false, error: 'PDF upload failed. ' + dbMsg(upErr) });
  }
  if (!isStoragePath(newPath)) return json({ success: false, error: 'Invalid new PDF path.' });

  let backupId = String(data[0].pdf_original_backup_id || '').trim();
  if (!backupId) {
    // FIX BUG-01: backups go into the "backups/" subfolder so that
    // isStoragePath() returns true and delete cleanup works.
    const backupName = `backups/${id.slice(0, 8)}-${Date.now()}.pdf`;
    const { error: cpErr } = await supabase.storage.from('subjective').copy(currentPath, backupName);
    if (!cpErr) {
      const { data: fileBlob } = await supabase.storage.from('subjective').download(backupName);
      if (fileBlob) {
        await supabase.storage.from('subjective-backups').upload(backupName, fileBlob, { upsert: true });
        await supabase.storage.from('subjective').remove([backupName]);
        backupId = backupName;
      }
    }
  }

  const now = new Date().toISOString();
  const { error: updErr } = await supabase.from('subjective_submissions').update({ pdf_file_id: newPath, pdf_replaced_at: now, pdf_replaced_by: admin.username, pdf_original_backup_id: backupId }).eq('id', id);
  if (updErr) return json({ success: false, error: dbMsg(updErr) });
  return json({ success: true, id, newPath, backupId, replacedAt: now });
}

export async function getsubjectiveuploadurl(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);
  const path = `${auth.username}/${Date.now()}-${randId()}.pdf`;
  const { data, error } = await supabase.storage.from('subjective').createSignedUploadUrl(path);
  if (error || !data) return json({ success: false, error: (error ? dbMsg(error) : 'could not create upload url') });
  return json({ success: true, path, token: data.token, signedUrl: data.signedUrl });
}

export async function submitsubjectiveanswer(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);
  const username = auth.username;

  const kind = String(params.kind || 'qotd').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) || 'qotd';
  const questionId = String(params.questionId || '').trim().slice(0, 200);
  const questionText = String(params.questionText || '').trim().slice(0, 3000);
  const questionMarks = Math.max(1, Math.min(100, Number(params.marks) || 10));
  const chapterId = String(params.chapterId || '').trim().slice(0, 80);
  const solveSec = Math.max(0, Math.min(6 * 60 * 60, Number(params.solveSec) || 0));
  const startedAt = Number(params.startedAt) || Date.now();

  if (!questionId) return json({ success: false, error: 'Missing questionId.' });

  let pdfPath = '';
  const providedPath = String(params.pdfPath || '').trim();
  const legacyData = String(params.pdfData || '');

  if (providedPath) {
    if (!ownedUploadPath(providedPath, username, ['pdf'])) return json({ success: false, error: 'Invalid PDF path.' });
    const { data: exists } = await supabase.storage.from('subjective').list(username, { search: providedPath.split('/').pop() });
    if (!exists || !exists.length) return json({ success: false, error: 'PDF upload not found.' });
    pdfPath = providedPath;
  } else if (legacyData.startsWith('data:')) {
    if (legacyData.length > 14 * 1024 * 1024) return json({ success: false, error: 'PDF too large — max ~10 MB.' });
    const bytes = base64ToBytes(legacyData.slice(legacyData.indexOf(',') + 1));
    if (!isPdfBytes(bytes)) return json({ success: false, error: "That file isn't a valid PDF." });
    const path = `${username}/${Date.now()}-${randId()}.pdf`;
    const { error: upErr } = await supabase.storage.from('subjective').upload(path, bytes, { contentType: 'application/pdf', upsert: false });
    if (upErr) return json({ success: false, error: 'PDF upload failed. ' + dbMsg(upErr) });
    pdfPath = path;
  } else {
    return json({ success: false, error: 'Missing PDF data.' });
  }

  if (kind === 'qotd') {
    const { data: dupe } = await supabase.from('subjective_submissions').select('id').eq('username', username).eq('question_id', questionId).limit(1);
    if (dupe && dupe[0]) {
      await supabase.storage.from('subjective').remove([pdfPath]);
      return json({ success: false, alreadySubmitted: true, error: "You've already submitted this question." });
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const { error } = await supabase.from('subjective_submissions').insert({
    id, username, kind, question_id: questionId, question_text: questionText, question_marks: questionMarks,
    chapter_id: chapterId, solve_sec: solveSec, started_at: startedAt, submitted_at: now, pdf_file_id: pdfPath,
    pdf_url: '', status: 'pending', score: null, feedback: '', graded_by: '', graded_at: '',
    pdf_replaced_at: '', pdf_replaced_by: '', pdf_original_backup_id: '',
  });
  if (error) return json({ success: false, error: dbMsg(error) });
  const signed = await signedPdfUrl('subjective', pdfPath);
  return json({ success: true, submissionId: id, pdfUrl: signed, message: 'Submitted for grading.' });
}

export async function getmysubjectivesubmissions(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data, error } = await supabase.from('subjective_submissions').select('*').eq('username', auth.username).order('submitted_at', { ascending: false });
  if (error) return json({ success: false, error: dbMsg(error) });
  const submissions = (data || []).map(r => ({
    id: r.id, username: r.username, kind: r.kind, questionId: r.question_id, questionText: r.question_text,
    questionMarks: Number(r.question_marks || 0), chapterId: r.chapter_id, solveSec: Number(r.solve_sec || 0),
    startedAt: Number(r.started_at || 0), submittedAt: Number(r.submitted_at || 0), pdfUrl: r.pdf_url || '',
    status: r.status, score: r.score === null || r.score === undefined ? null : Number(r.score),
    feedback: r.feedback || '', gradedBy: r.graded_by || '', gradedAt: r.graded_at || '',
  }));
  return json({ success: true, submissions });
}

export async function getmysubmissionpdf(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'Submission id required.' });
  const { data } = await supabase.from('subjective_submissions').select('*').eq('id', id).eq('username', auth.username).limit(1);
  if (!data || !data[0]) return json({ success: false, error: 'Submission not found.' });
  const stored = String(data[0].pdf_file_id || '').trim();
  if (!isStoragePath(stored)) return json({ success: false, error: 'This file is stored on Drive — not migrated yet.' });
  const signed = await signedPdfUrl('subjective', stored);
  if (!signed) return json({ success: false, error: 'Could not sign PDF URL.' });
  return json({ success: true, url: signed, expiresInSec: 3600 });
}

// Study Docs
export async function getstudydocuploadurl(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'studydocs_manage');
  if (!admin.ok) return json(admin.error);
  const path = `uploads/${Date.now()}-${randId()}.pdf`;
  const { data, error } = await supabase.storage.from('study-docs').createSignedUploadUrl(path);
  if (error || !data) return json({ success: false, error: (error ? dbMsg(error) : 'could not create upload url') });
  return json({ success: true, path, token: data.token, signedUrl: data.signedUrl });
}

export async function adminliststudydocs(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'studydocs_view');
  if (!admin.ok) return json(admin.error);
  const { data, error } = await supabase.from('study_docs').select('*');
  if (error) return json({ success: false, error: dbMsg(error) });
  const docs = (data || []).map(r => ({
    id: r.id, title: r.title, category: r.category, chapterId: r.chapter_id, description: r.description,
    fileName: r.file_name, sizeBytes: Number(r.size_bytes || 0), status: r.status,
    sortOrder: r.sort_order === null || r.sort_order === undefined ? 100 : Number(r.sort_order),
    uploadedBy: r.uploaded_by, uploadedAt: Number(r.uploaded_at || 0), updatedAt: Number(r.updated_at || 0),
    hasFile: !!String(r.file_id || '').trim(),
  })).sort((a, b) => (a.sortOrder - b.sortOrder) || (b.uploadedAt - a.uploadedAt));
  return json({ success: true, docs, categories: ['model-answer', 'notes', 'past-paper', 'syllabus', 'other'] });
}

export async function adminaddstudydoc(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'studydocs_manage');
  if (!admin.ok) return json(admin.error);
  const title = String(params.title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!title) return json({ success: false, error: 'Give the PDF a title.' });
  const category = String(params.category || 'model-answer').toLowerCase();
  const allowed = ['model-answer', 'notes', 'past-paper', 'syllabus', 'other'];
  if (!allowed.includes(category)) return json({ success: false, error: 'Unknown category.' });
  const chapterId = String(params.chapterId || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
  const description = String(params.description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
  const rawSort = (params.sortOrder === undefined || params.sortOrder === null || String(params.sortOrder).trim() === '') ? NaN : Number(params.sortOrder);
  const sortOrder = isFinite(rawSort) ? Math.max(0, Math.min(9999, Math.round(rawSort))) : 100;
  const status = params.publish === false || params.publish === 'false' ? 'hidden' : 'published';

  let filePath = String(params.pdfPath || '').trim();
  let sizeBytes = 0;
  if (!filePath) {
    const pdfData = String(params.pdfData || '');
    if (!pdfData.startsWith('data:')) return json({ success: false, error: 'Choose a PDF file to upload.' });
    const bytes = base64ToBytes(pdfData.split(',')[1]);
    if (!isPdfBytes(bytes)) return json({ success: false, error: "That file isn't a valid PDF." });
    sizeBytes = bytes.length;
    filePath = `uploads/${Date.now()}-${randId()}.pdf`;
    const { error: upErr } = await supabase.storage.from('study-docs').upload(filePath, bytes, { contentType: 'application/pdf', upsert: false });
    if (upErr) return json({ success: false, error: 'PDF upload failed. ' + dbMsg(upErr) });
  } else {
    const { data: exists } = await supabase.storage.from('study-docs').list('uploads', { search: filePath.split('/').pop() });
    if (!exists || !exists.length) return json({ success: false, error: 'PDF upload not found.' });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const fileName = title.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60) || 'study';
  const { error } = await supabase.from('study_docs').insert({ id, title, category, chapter_id: chapterId, description, file_id: filePath, file_name: fileName + '.pdf', size_bytes: sizeBytes, status, sort_order: sortOrder, uploaded_by: admin.username, uploaded_at: now, updated_at: now });
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, id });
}

export async function adminupdatestudydoc(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'studydocs_manage');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'Document id required.' });

  const patch: Record<string, unknown> = {};
  if (params.title !== undefined) patch.title = String(params.title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (params.category !== undefined) {
    const category = String(params.category).toLowerCase();
    if (!['model-answer', 'notes', 'past-paper', 'syllabus', 'other'].includes(category)) return json({ success: false, error: 'Unknown category.' });
    patch.category = category;
  }
  if (params.chapterId !== undefined) patch.chapter_id = String(params.chapterId || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
  if (params.description !== undefined) patch.description = String(params.description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
  if (params.status !== undefined) patch.status = String(params.status) === 'hidden' ? 'hidden' : 'published';
  if (params.sortOrder !== undefined) { const n = Number(params.sortOrder); patch.sort_order = isFinite(n) ? Math.max(0, Math.min(9999, Math.round(n))) : 100; }
  patch.updated_at = Date.now();

  const { error } = await supabase.from('study_docs').update(patch).eq('id', id);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, id });
}

export async function admindeletestudydoc(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'studydocs_manage');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'Document id required.' });
  const { data } = await supabase.from('study_docs').select('*').eq('id', id).limit(1);
  if (!data || !data[0]) return json({ success: false, error: 'Document not found.' });
  const stored = String(data[0].file_id || '').trim();
  if (isStoragePath(stored)) await supabase.storage.from('study-docs').remove([stored]);
  const { error } = await supabase.from('study_docs').delete().eq('id', id);
  if (error) return json({ success: false, error: dbMsg(error) });
  await recordDeletion('study_docs', [id]);
  return json({ success: true, id });
}

export async function admindownloadstudydoc(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'studydocs_view');
  if (!admin.ok) return json(admin.error);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'Document id required.' });
  const { data } = await supabase.from('study_docs').select('*').eq('id', id).limit(1);
  if (!data || !data[0]) return json({ success: false, error: 'Document not found.' });
  const stored = String(data[0].file_id || '').trim();
  if (!isStoragePath(stored)) return json({ success: false, error: 'This document is stored on Drive — not migrated yet.' });
  const signed = await signedPdfUrl('study-docs', stored);
  if (!signed) return json({ success: false, error: 'Could not sign PDF URL.' });
  return json({ success: true, url: signed, title: data[0].title, expiresInSec: 3600 });
}

export async function liststudydocs(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);
  const { data, error } = await supabase.from('study_docs').select('*').eq('status', 'published');
  if (error) return json({ success: false, error: dbMsg(error) });
  const docs = (data || []).map(r => ({
    id: r.id, title: r.title, category: r.category, chapterId: r.chapter_id, description: r.description,
    fileName: r.file_name, sizeBytes: Number(r.size_bytes || 0), status: r.status,
    sortOrder: r.sort_order === null || r.sort_order === undefined ? 100 : Number(r.sort_order),
    uploadedAt: Number(r.uploaded_at || 0), updatedAt: Number(r.updated_at || 0),
  })).sort((a, b) => (a.sortOrder - b.sortOrder) || (b.uploadedAt - a.uploadedAt));
  return json({ success: true, docs });
}

export async function getstudydocpdf(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const gate = requireAccess(auth);
  if (gate) return json(gate);
  const id = String(params.id || '').trim();
  if (!id) return json({ success: false, error: 'Document id required.' });
  const { data } = await supabase.from('study_docs').select('*').eq('id', id).limit(1);
  if (!data || !data[0] || data[0].status !== 'published') return json({ success: false, error: "That document isn't available." });
  const stored = String(data[0].file_id || '').trim();
  if (!isStoragePath(stored)) return json({ success: false, error: 'This document is stored on Drive — not migrated yet.' });
  const signed = await signedPdfUrl('study-docs', stored);
  if (!signed) return json({ success: false, error: 'Could not sign PDF URL.' });
  return json({ success: true, url: signed, title: data[0].title, expiresInSec: 3600 });
}