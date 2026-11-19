import { supabase } from '../_shared/db.ts';
import { recordDeletion } from '../_shared/tombstones.ts';
import { json, dbMsg, escLike } from '../_shared/http.ts';
import { authUser, issueUserToken } from '../_shared/auth.ts';
import { verifyPassword, makeStoredHash, safeEqual } from '../_shared/crypto.ts';
import { passwordProblem } from '../_shared/owner.ts';
import { rlBlocked, rlHit, rlClear, RL_WINDOW_MS, RL_TOO_MANY } from '../_shared/rate-limit.ts';
import { REQUIRE_BASE_REVISION } from '../_shared/config.ts';
import { archivePreviousProgress, sameRevision, isAcceptableProgressData, isStoragePath } from '../_shared/utils.ts';

export async function saveprogress(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const dataStr = String(params.data || '');
  if (!dataStr) return json({ success: false, error: 'No data provided.' });
  if (dataStr.length > 45000) return json({ success: false, error: 'Progress data too large to sync.' });
  if (!isAcceptableProgressData(dataStr)) return json({ success: false, error: 'Malformed progress data.' });
  const checkRevision = Object.prototype.hasOwnProperty.call(params, 'baseUpdatedAt');

  const { data: existing } = await supabase.from('progress').select('*').eq('username', auth.username).limit(1);
  const row = existing && existing[0] ? existing[0] as Record<string, unknown> : null;
  if (row && !checkRevision && REQUIRE_BASE_REVISION) {
    // Refuse blind overwrites: the client must send the revision it last saw.
    return json({ success: false, conflict: true, data: row.data, updatedAt: row.updated_at });
  }
  if (row && checkRevision && !sameRevision(params.baseUpdatedAt, row.updated_at)) {
    return json({ success: false, conflict: true, data: row.data, updatedAt: row.updated_at });
  }
  const now = new Date().toISOString();
  if (row) {
    await archivePreviousProgress(auth.username, String(row.data || ''), String(row.updated_at || ''), dataStr);
    let uq = supabase.from('progress').update({ data: dataStr, updated_at: now }).eq('username', auth.username);
    if (checkRevision) uq = uq.eq('updated_at', row.updated_at as string);
    const { data: upd, error } = await uq.select('username');
    if (error) return json({ success: false, error: dbMsg(error) });
    if (checkRevision && (!upd || !upd.length)) {
      const { data: cur } = await supabase.from('progress').select('*').eq('username', auth.username).limit(1);
      const c = cur && cur[0] ? cur[0] as Record<string, unknown> : null;
      return json({ success: false, conflict: true, data: c ? c.data : null, updatedAt: c ? c.updated_at : null });
    }
  } else {
    const { error } = await supabase.from('progress').insert({ username: auth.username, data: dataStr, updated_at: now });
    if (error) return json({ success: false, error: dbMsg(error) });
  }
  return json({ success: true, updatedAt: now });
}

export async function getprogress(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data } = await supabase.from('progress').select('*').eq('username', auth.username).limit(1);
  const row = data && data[0] ? data[0] as Record<string, unknown> : null;
  if (!row) return json({ success: true, data: null });
  return json({ success: true, data: row.data, updatedAt: row.updated_at });
}

export async function getprogresshistory(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data } = await supabase.from('progress_history').select('*').eq('username', auth.username).limit(1);
  const row = data && data[0] ? data[0] as Record<string, unknown> : null;
  if (!row) return json({ success: true, entries: [] });
  const slot = Number(params.slot);
  if (slot >= 1 && slot <= 3) {
    const d = String(row[`data${slot}`] || '');
    if (!d) return json({ success: false, error: 'That copy is not available.' });
    return json({ success: true, data: d, savedAt: String(row[`saved_at${slot}`] || '') });
  }
  const entries: any[] = [];
  for (let i = 1; i <= 3; i++) {
    const d = String(row[`data${i}`] || '');
    if (d) entries.push({ slot: i, savedAt: String(row[`saved_at${i}`] || ''), chars: d.length });
  }
  return json({ success: true, entries });
}

export async function updateownmobile(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const mobile = String(params.mobile || '').trim();
  if (!/^(98|97|96|99)\d{8}$/.test(mobile)) return json({ success: false, error: 'Invalid Nepali mobile number.' });
  const { data: other } = await supabase.from('users').select('username').eq('mobile', mobile).limit(1);
  if (other && other[0] && String(other[0].username).toLowerCase() !== auth.username.toLowerCase()) {
    return json({ success: false, error: 'An account with this mobile number already exists.' });
  }
  const { error } = await supabase.from('users').update({ mobile }).eq('username', auth.username);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, message: 'Mobile number saved.' });
}

export async function updateprofile(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];

  if (params.name !== undefined) {
    const nm = String(params.name).trim();
    if (!nm) return json({ success: false, error: 'Name cannot be empty.' });
    if (nm.length > 80) return json({ success: false, error: 'Name is too long.' });
    patch.name = nm; changes.push('name');
  }
  if (params.email !== undefined) {
    // FIX BUG-04: lowercase + ilike (case-insensitive) dup check to match signup.
    const email = String(params.email).trim().toLowerCase();
    if (email.length > 120) return json({ success: false, error: 'Email address is too long.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ success: false, error: 'Invalid email address.' });
    if (email) {
      const { data: dup } = await supabase.from('users').select('username').ilike('email', escLike(email)).neq('username', auth.username).limit(1);
      if (dup && dup[0]) return json({ success: false, error: 'That email is already in use by another account.' });
    }
    patch.email = email; patch.email_verified = 'false'; changes.push('email');
  }
  if (params.mobile !== undefined) {
    const mob = String(params.mobile).trim();
    if (!/^(98|97|96|99)\d{8}$/.test(mob)) return json({ success: false, error: 'Invalid Nepali mobile number.' });
    const { data: dup } = await supabase.from('users').select('username').eq('mobile', mob).neq('username', auth.username).limit(1);
    if (dup && dup[0]) return json({ success: false, error: 'That mobile number is already in use by another account.' });
    patch.mobile = mob; changes.push('mobile');
  }
  if (!Object.keys(patch).length) return json({ success: true, message: 'Nothing to update.', updated: [] });

  const { error } = await supabase.from('users').update(patch).eq('username', auth.username);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, message: 'Profile updated.', updated: changes });
}

// GAP-01: user-facing change-password (previously only via GAS stubs)
export async function changepassword(params: Record<string, unknown>) {
  const auth = await authUser(params, { withHash: true });
  if (!auth.ok) return json(auth.error);
  const currentPassword = String(params.currentPassword || '');
  const newPassword = String(params.newPassword || '');
  if (!currentPassword) return json({ success: false, error: 'Enter your current password.' });
  const problem = passwordProblem(newPassword, auth.username, currentPassword);
  if (problem) return json({ success: false, error: problem });

  // A stolen session token must not allow unlimited guessing of the current password.
  const rlKey = 'chpw:' + auth.username.toLowerCase();
  if (await rlBlocked(rlKey, 5)) return json(RL_TOO_MANY);
  const oldHash = String(auth.user.pass_hash || '');
  const v = await verifyPassword(currentPassword, oldHash);
  if (!v.ok) { await rlHit(rlKey, RL_WINDOW_MS); return json({ success: false, error: 'Current password is incorrect.' }); }
  await rlClear(rlKey);

  const newHash = await makeStoredHash(newPassword);
  const { error } = await supabase.from('users').update({ pass_hash: newHash, session_token: '', session_token_expires_at: '' }).eq('username', auth.username);
  if (error) return json({ success: false, error: dbMsg(error) });

  // Keep the matching admin row in sync so adminswitchfromuser still works.
  // Only when the admin row is still LINKED (identical hash). If the owner reset the admin
  // password it is deliberately detached, and a student password change must not overwrite it.
  const { data: adminRow } = await supabase.from('admins').select('username,pass_hash').eq('username', auth.username).limit(1);
  if (adminRow && adminRow[0] && safeEqual(String(adminRow[0].pass_hash || ''), oldHash)) {
    await supabase.from('admins').update({ pass_hash: newHash, token: '', token_expires: '' }).eq('username', auth.username);
  }

  const newToken = await issueUserToken(auth.username);
  return json({ success: true, token: newToken, message: 'Password changed.' });
}

export async function resetmyprogress(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  if (String(params.confirm || '').trim().toUpperCase() !== 'RESET') return json({ success: false, error: 'Type RESET to confirm.' });

  await supabase.from('progress').delete().eq('username', auth.username);
  // Per-question state (notes, bookmarks, mistakes, counters) and the answer log are progress too.
  await supabase.from('user_qstate').delete().eq('username', auth.username);
  await supabase.from('answer_events').delete().eq('username', auth.username);
  await supabase.from('progress_history').delete().eq('username', auth.username);
  await supabase.from('progress_backups').delete().eq('username', auth.username);
  return json({ success: true, cleared: { progress: 1, history: 1, backups: 1 } });
}

export async function deletemyaccount(params: Record<string, unknown>) {
  const auth = await authUser(params, { withHash: true });
  if (!auth.ok) return json(auth.error);
  if (String(params.confirm || '').trim().toUpperCase() !== 'DELETE') return json({ success: false, error: 'Type DELETE to confirm.' });
  // Google-only accounts have a locked (unusable) hash and no password to confirm with;
  // they confirm by typing DELETE. App stores require in-app deletion for every account.
  const googleOnly = String(auth.user.pass_hash || '').startsWith('locked:');
  if (!googleOnly) {
    const password = String(params.password || '');
    if (!password) return json({ success: false, needsPassword: true, error: 'Enter your password to delete your account.' });
    const rlKey = 'delacct:' + auth.username.toLowerCase();
    if (await rlBlocked(rlKey, 5)) return json(RL_TOO_MANY);
    const v = await verifyPassword(password, String(auth.user.pass_hash || ''));
    if (!v.ok) { await rlHit(rlKey, RL_WINDOW_MS); return json({ success: false, error: 'Password is incorrect.' }); }
    await rlClear(rlKey);
  }

  const { data: adminRow } = await supabase.from('admins').select('username').eq('username', auth.username).limit(1);
  if (adminRow && adminRow[0]) return json({ success: false, error: 'This account also has admin access. Ask the main admin to remove the admin role first.' });

  const { data: payRows } = await supabase.from('payments').select('screenshot_url').eq('username', auth.username);
  const { data: subjRows } = await supabase.from('subjective_submissions').select('pdf_file_id,pdf_original_backup_id').eq('username', auth.username);
  const payPaths = (payRows || []).map(r => String(r.screenshot_url || '')).filter(p => isStoragePath(p));
  const subjPaths = (subjRows || []).map(r => String(r.pdf_file_id || '')).filter(p => isStoragePath(p));
  const backupPaths = (subjRows || []).map(r => String(r.pdf_original_backup_id || '')).filter(p => isStoragePath(p));

  const tables = ['progress', 'progress_history', 'progress_backups', 'payments', 'push_tokens', 'weekly_attempts', 'weekly_starts', 'subjective_submissions', 'user_qstate', 'answer_events'];
  for (const t of tables) {
    const { error } = await supabase.from(t).delete().eq('username', auth.username);
    if (error) return json({ success: false, error: `${t}: ${dbMsg(error)}` });
  }
  await supabase.from('question_reports').update({ reported_by: '[deleted user]' }).eq('reported_by', auth.username);
  await supabase.from('logs').update({ target: '[deleted user]' }).eq('target', auth.username);

  if (payPaths.length)    await supabase.storage.from('payments').remove(payPaths);
  if (subjPaths.length)   await supabase.storage.from('subjective').remove(subjPaths);
  if (backupPaths.length) await supabase.storage.from('subjective-backups').remove(backupPaths);

  const { error: delErr } = await supabase.from('users').delete().eq('username', auth.username);
  if (delErr) return json({ success: false, error: dbMsg(delErr) });
  await recordDeletion('users', [auth.username]);
  return json({ success: true, deleted: true, message: 'Your account and its data have been deleted.' });
}