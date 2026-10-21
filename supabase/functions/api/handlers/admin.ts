import { supabase } from '../_shared/db.ts';
import { json, dbMsg } from '../_shared/http.ts';
import { authAdmin, authUser } from '../_shared/auth.ts';
import { ADMIN_FEATURE_KEYS, OWNER_ONLY_FEATURES, PAY_EXTS, ADMIN_TOKEN_TTL_MS } from '../_shared/config.ts';
import { isStoragePath } from '../_shared/utils.ts';
import { makeStoredHash, verifyPassword, randId, safeEqual } from '../_shared/crypto.ts';
import { publicUser, issueAdminToken } from '../_shared/auth.ts';
import {
  writeAuditLog, passwordProblem, generateTempPassword, grantableFeatures,
  isReservedUsername, countOwners, isOwnerRow, truthy,
} from '../_shared/owner.ts';
import { recordDeletion } from '../_shared/tombstones.ts';
import { rlBlocked, rlHit, rlClear, RL_WINDOW_MS, RL_TOO_MANY } from '../_shared/rate-limit.ts';

// ── helpers ────────────────────────────────────────────────────────────
async function countRows(table: string, apply?: (q: any) => any): Promise<number> {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (apply) q = apply(q);
  const { count } = await q;
  return count || 0;
}

// ── Dashboard / Stats ────────────────────────────────────────────────
export async function adminstats(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'dashboard');
  if (!admin.ok) return json(admin.error);

  // FIX SCALE-03: count queries instead of loading every row.
  const [total, trial, active, expired, pendingPay] = await Promise.all([
    countRows('users'),
    countRows('users', q => q.eq('status', 'trial')),
    countRows('users', q => q.eq('status', 'active')),
    countRows('users', q => q.eq('status', 'expired')),
    countRows('users', q => q.eq('status', 'payment_pending')),
  ]);
  const [totalPay, pending, verified, rejected] = await Promise.all([
    countRows('payments'),
    countRows('payments', q => q.eq('status', 'pending')),
    countRows('payments', q => q.eq('status', 'verified')),
    countRows('payments', q => q.eq('status', 'rejected')),
  ]);
  return json({ success: true, stats: { users: { total, trial, active, expired, paymentPending: pendingPay }, payments: { total: totalPay, pending, verified, rejected } } });
}

export async function admintrends(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'dashboard');
  if (!admin.ok) return json(admin.error);
  const days = Math.max(7, Math.min(90, Number(params.days) || 30));
  const { data: users } = await supabase.from('users').select('status,created_at,approved_at');
  const tz = 'Asia/Kathmandu';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (t: number) => fmt.format(new Date(t));
  const series: Array<{ date: string; signups: number; paid: number }> = [];
  const byKey: Record<string, { date: string; signups: number; paid: number }> = {};
  const nowMs = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(nowMs - i * 86400000);
    if (!byKey[k]) { byKey[k] = { date: k, signups: 0, paid: 0 }; series.push(byKey[k]); }
  }
  let total = 0, paid = 0, trial = 0, awaiting = 0, notPaid = 0, periodSignups = 0, periodPaid = 0;
  (users || []).forEach(u => {
    total++;
    const s = String(u.status || '');
    if (s === 'active') paid++; else if (s === 'trial') trial++; else if (s === 'payment_pending') awaiting++; else if (s === 'expired' || s === 'rejected') notPaid++;
    const created = u.created_at ? new Date(String(u.created_at)).getTime() : NaN;
    if (!isNaN(created)) { const b = byKey[dayKey(created)]; if (b) { b.signups++; periodSignups++; } }
    const approved = u.approved_at ? new Date(String(u.approved_at)).getTime() : NaN;
    if (s === 'active' && !isNaN(approved)) { const b = byKey[dayKey(approved)]; if (b) { b.paid++; periodPaid++; } }
  });
  const { data: amountRows } = await supabase.from('settings').select('value').eq('key', 'paymentAmount').limit(1);
  const amount = amountRows && amountRows[0] ? Number(amountRows[0].value) || 0 : 0;
  return json({
    success: true, days, series, totals: { total, paid, trial, awaiting, notPaid, paidRate: total ? Math.round((paid / total) * 100) : 0, periodSignups, periodPaid, amount, revenueEstimate: paid * amount }
  });
}

export async function adminexpiringtrials(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'dashboard');
  if (!admin.ok) return json(admin.error);
  const hours = Math.max(1, Math.min(168, Number(params.hours) || 24));
  const { data: users } = await supabase.from('users').select('*').eq('status', 'trial');
  const now = Date.now(); const cutoff = now + hours * 60 * 60 * 1000;
  const list: Array<Record<string, unknown>> = [];
  (users || []).forEach(u => {
    if (!u.trial_expires_at) return;
    const t = new Date(String(u.trial_expires_at)).getTime();
    if (isNaN(t) || t <= now || t > cutoff) return;
    list.push(publicUser(u));
  });
  list.sort((a, b) => new Date(String(a.trialExpiresAt)).getTime() - new Date(String(b.trialExpiresAt)).getTime());
  return json({ success: true, hours, count: list.length, users: list });
}

// ── User Management ─────────────────────────────────────────────────
export async function adminlistusers(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'users_view');
  if (!admin.ok) return json(admin.error);
  const limit = Math.min(Number(params.limit) || 3000, 3000);
  // FIX SCALE-04: only select fields publicUser needs.
  const cols = 'username,name,email,mobile,status,created_at,approved_at,role,trial_expires_at,payment_status,permanent_access,access_type,access_expires_at,email_verified';
  const { data, error } = await supabase.from('users').select(cols).order('created_at', { ascending: false }).limit(limit);
  if (error) return json({ success: false, error: dbMsg(error) });
  const totalCount = await countRows('users');
  const users = (data || []).map(publicUser);
  return json({ success: true, users, totalCount, truncated: totalCount > limit });
}

export async function adminupdateuser(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'users_manage');
  if (!admin.ok) return json(admin.error);
  const username = String(params.targetUsername || '').trim();
  if (!username) return json({ success: false, error: 'Username required.' });
  const { data: found } = await supabase.from('users').select('*').eq('username', username).limit(1);
  if (!found || !found[0]) return json({ success: false, error: 'User not found.' });
  const user = found[0];

  const patch: Record<string, unknown> = {};
  if (params.name !== undefined) { const nm = String(params.name).trim(); if (nm.length > 80) return json({ success: false, error: 'Name is too long.' }); patch.name = nm; }
  if (params.email !== undefined) {
    const email = String(params.email).trim().toLowerCase();  // consistent with signup/updateprofile
    if (email.length > 120) return json({ success: false, error: 'Email address is too long.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ success: false, error: 'Invalid email address.' });
    patch.email = email;
    if (email && email.toLowerCase() !== String(user.email || '').toLowerCase()) patch.email_verified = 'false';
  }
  if (params.mobile !== undefined) {
    const mobile = String(params.mobile).trim();
    if (mobile && !/^(98|97|96|99)\d{8}$/.test(mobile)) return json({ success: false, error: 'Invalid Nepali mobile number.' });
    if (mobile) {
      const { data: other } = await supabase.from('users').select('username').eq('mobile', mobile).limit(1);
      if (other && other[0] && String(other[0].username) !== username) return json({ success: false, error: 'Another account already uses this mobile number.' });
    }
    patch.mobile = mobile;
  }
  if (params.status !== undefined && params.status !== '') {
    if (!['trial', 'active', 'expired', 'payment_pending', 'rejected'].includes(String(params.status))) return json({ success: false, error: 'Invalid status.' });
    patch.status = params.status;
  }
  if (params.permanentAccess !== undefined) patch.permanent_access = (params.permanentAccess === true || params.permanentAccess === 'true') ? 'true' : 'false';

  // Password reset for a student. Admin accounts are never reset here —
  // the owner uses adminresetadminpassword so the admin hash and the student
  // hash cannot silently drift apart.
  let passwordChanged = false;
  if (params.password) {
    const pw = String(params.password);
    const problem = passwordProblem(pw, username);
    if (problem) return json({ success: false, error: problem });
    const { data: targetAdminRow } = await supabase.from('admins').select('username').eq('username', username).limit(1);
    if (targetAdminRow && targetAdminRow[0]) {
      return json({ success: false, error: "This account is an admin. Only the owner can reset it, using 'Reset admin password'." });
    }
    patch.pass_hash = await makeStoredHash(pw);
    patch.session_token = '';
    patch.session_token_expires_at = '';
    passwordChanged = true;
  }

  if (!Object.keys(patch).length) return json({ success: true, username });
  const { error } = await supabase.from('users').update(patch).eq('username', username);
  if (error) return json({ success: false, error: dbMsg(error) });

  if (passwordChanged) await writeAuditLog(admin.username, 'Reset user password', username);
  return json({ success: true, username });
}

export async function admingrantaccess(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'users_manage');
  if (!admin.ok) return json(admin.error);
  const username = String(params.targetUsername || '').trim();
  const duration = String(params.duration || '').trim();
  if (!username) return json({ success: false, error: 'Username required.' });
  if (['permanent', 'year'].indexOf(duration) === -1) return json({ success: false, error: "Duration must be 'permanent' or 'year'." });

  const isYearly = duration === 'year';
  let expiresAtIso = '';
  if (isYearly) { const d = new Date(); d.setDate(d.getDate() + 365); expiresAtIso = d.toISOString(); }
  const nowIso = new Date().toISOString();

  // FIX BUG-11: yearly grants must NOT set permanent_access='true'.
  const { error } = await supabase.from('users').update({
    status: 'active',
    approved_at: nowIso,
    payment_status: 'verified',
    permanent_access: isYearly ? 'false' : 'true',
    access_type: isYearly ? 'yearly' : 'permanent',
    access_expires_at: expiresAtIso,
  }).eq('username', username);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, username, duration, accessExpiresAt: expiresAtIso });
}

export async function admingrantaccessbatch(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'users_bulk');
  if (!admin.ok) return json(admin.error);
  let usernames: unknown[];
  try { usernames = Array.isArray(params.usernames) ? params.usernames : JSON.parse(String(params.usernames || '[]')); } catch { return json({ success: false, error: 'usernames must be a JSON array.' }); }
  if (!Array.isArray(usernames) || !usernames.length) return json({ success: false, error: 'No usernames provided.' });
  if (usernames.length > 1000) return json({ success: false, error: 'Limit is 1000 usernames per batch.' });
  const duration = String(params.duration || '').trim();
  if (['permanent', 'year'].indexOf(duration) === -1) return json({ success: false, error: "Duration must be 'permanent' or 'year'." });

  const isYearly = duration === 'year';
  let expiresAtIso = ''; if (isYearly) { const d = new Date(); d.setDate(d.getDate() + 365); expiresAtIso = d.toISOString(); }
  const nowIso = new Date().toISOString();
  const patch = {
    status: 'active',
    approved_at: nowIso,
    payment_status: 'verified',
    permanent_access: isYearly ? 'false' : 'true',
    access_type: isYearly ? 'yearly' : 'permanent',
    access_expires_at: expiresAtIso,
  };

  // FIX SCALE-02: one round trip instead of N.
  const cleanNames = [...new Set(usernames.map(u => String(u || '').trim()).filter(Boolean))];
  const { data: found } = await supabase.from('users').select('username').in('username', cleanNames);
  const foundSet = new Set((found || []).map(r => String(r.username)));

  const results: any[] = usernames.map(raw => {
    const u = String(raw || '').trim();
    if (!u) return { username: u, success: false, error: 'empty' };
    if (!foundSet.has(u)) return { username: u, success: false, error: 'User not found.' };
    return { username: u, success: true };
  });

  const toUpdate = Array.from(foundSet);
  if (toUpdate.length) {
    const { error } = await supabase.from('users').update(patch).in('username', toUpdate);
    if (error) {
      for (const r of results) if (r.success) { r.success = false; r.error = dbMsg(error); }
    }
  }
  return json({ success: true, duration, accessExpiresAt: expiresAtIso, results });
}

export async function admindeleteuser(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'users_manage');
  if (!admin.ok) return json(admin.error);
  const username = String(params.targetUsername || '').trim();
  if (!username) return json({ success: false, error: 'Username required.' });
  const { data: found } = await supabase.from('users').select('username').eq('username', username).limit(1);
  if (!found || !found[0]) return json({ success: false, error: 'User not found.' });

  // FIX BUG-12: refuse to delete admin-capable accounts.
  const { data: adminCheck } = await supabase.from('admins').select('username').eq('username', username).limit(1);
  if (adminCheck && adminCheck[0]) return json({ success: false, error: 'This account also has admin access. Remove the admin role first.' });

  const { data: payRows } = await supabase.from('payments').select('screenshot_url').eq('username', username);
  const { data: subjRows } = await supabase.from('subjective_submissions').select('pdf_file_id,pdf_original_backup_id').eq('username', username);
  const payPaths = (payRows || []).map(r => String(r.screenshot_url || '')).filter(p => isStoragePath(p));
  const subjPaths = (subjRows || []).map(r => String(r.pdf_file_id || '')).filter(p => isStoragePath(p));
  const backupPaths = (subjRows || []).map(r => String(r.pdf_original_backup_id || '')).filter(p => isStoragePath(p));

  const tables = ['progress', 'progress_history', 'progress_backups', 'payments', 'push_tokens', 'weekly_attempts', 'weekly_starts', 'subjective_submissions'];
  for (const t of tables) await supabase.from(t).delete().eq('username', username);
  await supabase.from('question_reports').update({ reported_by: '[deleted user]' }).eq('reported_by', username);
  await supabase.from('logs').update({ target: '[deleted user]' }).eq('target', username);
  if (payPaths.length) await supabase.storage.from('payments').remove(payPaths);
  if (subjPaths.length) await supabase.storage.from('subjective').remove(subjPaths);
  if (backupPaths.length) await supabase.storage.from('subjective-backups').remove(backupPaths);
  const { error } = await supabase.from('users').delete().eq('username', username);
  if (error) return json({ success: false, error: dbMsg(error) });

  await recordDeletion('users', [username]);
  await writeAuditLog(admin.username, 'Delete user', username);
  return json({ success: true, deleted: username });
}

export async function admindeleteusersbatch(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'users_bulk');
  if (!admin.ok) return json(admin.error);
  let usernames: unknown[];
  try { usernames = Array.isArray(params.usernames) ? params.usernames : JSON.parse(String(params.usernames || '[]')); } catch { return json({ success: false, error: 'usernames must be a JSON array.' }); }
  if (!Array.isArray(usernames) || !usernames.length) return json({ success: false, error: 'No usernames provided.' });
  if (usernames.length > 1000) return json({ success: false, error: 'Limit is 1000 usernames per batch.' });

  const cleanNames = [...new Set(usernames.map(u => String(u || '').trim()).filter(Boolean))];

  // FIX BUG-12: skip admin-capable accounts.
  const { data: adminsFound } = await supabase.from('admins').select('username').in('username', cleanNames);
  const adminSet = new Set((adminsFound || []).map(r => String(r.username)));

  const { data: usersFound } = await supabase.from('users').select('username').in('username', cleanNames);
  const userSet = new Set((usersFound || []).map(r => String(r.username)));

  const deletable = cleanNames.filter(u => userSet.has(u) && !adminSet.has(u));

  const results: any[] = usernames.map(raw => {
    const u = String(raw || '').trim();
    if (!u) return { username: u, success: false, error: 'empty' };
    if (adminSet.has(u)) return { username: u, success: false, error: 'User is an admin — remove admin role first.' };
    if (!userSet.has(u)) return { username: u, success: false, error: 'User not found.' };
    return { username: u, success: true };
  });

  if (deletable.length) {
    // FIX SCALE-02 + BUG-01: aggregate storage paths once.
    const { data: payRows } = await supabase.from('payments').select('screenshot_url').in('username', deletable);
    const { data: subjRows } = await supabase.from('subjective_submissions').select('pdf_file_id,pdf_original_backup_id').in('username', deletable);
    const payPaths = (payRows || []).map(r => String(r.screenshot_url || '')).filter(p => isStoragePath(p));
    const subjPaths = (subjRows || []).map(r => String(r.pdf_file_id || '')).filter(p => isStoragePath(p));
    const backupPaths = (subjRows || []).map(r => String(r.pdf_original_backup_id || '')).filter(p => isStoragePath(p));

    const tables = ['progress', 'progress_history', 'progress_backups', 'payments', 'push_tokens', 'weekly_attempts', 'weekly_starts', 'subjective_submissions'];
    for (const t of tables) {
      await supabase.from(t).delete().in('username', deletable);
    }
    await supabase.from('question_reports').update({ reported_by: '[deleted user]' }).in('reported_by', deletable);
    await supabase.from('logs').update({ target: '[deleted user]' }).in('target', deletable);
    if (payPaths.length) await supabase.storage.from('payments').remove(payPaths);
    if (subjPaths.length) await supabase.storage.from('subjective').remove(subjPaths);
    if (backupPaths.length) await supabase.storage.from('subjective-backups').remove(backupPaths);
    const { error } = await supabase.from('users').delete().in('username', deletable);
    if (error) {
      for (const r of results) if (r.success) { r.success = false; r.error = dbMsg(error); }
    } else {
      await recordDeletion('users', deletable);
      await writeAuditLog(admin.username, 'Delete users (batch)', deletable.slice(0, 50).join(','), `count=${deletable.length}`);
    }
  }
  return json({ success: true, results });
}

// ── Payment Management ─────────────────────────────────────────────
export async function adminlistpayments(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'payments_view');
  if (!admin.ok) return json(admin.error);
  const limit = Math.min(Number(params.limit) || 3000, 3000);
  const { data, error } = await supabase.from('payments').select('*');
  if (error) return json({ success: false, error: dbMsg(error) });
  const all = data || []; const totalCount = all.length;
  const txOwners: Record<string, Set<string>> = {};
  all.forEach(p => { const tx = String(p.tx_id || '').trim().toLowerCase(); if (!tx) return; if (!txOwners[tx]) txOwners[tx] = new Set(); txOwners[tx].add(String(p.username || '')); });

  const payments = all.sort((a, b) => new Date(String(b.submitted_at || '')).getTime() - new Date(String(a.submitted_at || '')).getTime()).slice(0, limit).map(p => {
    const tx = String(p.tx_id || '').trim().toLowerCase();
    const owners = txOwners[tx] ? [...txOwners[tx]].filter(u => u !== String(p.username)) : [];
    return { username: p.username, name: p.name, email: p.email, mobile: String(p.mobile || ''), txId: p.tx_id, remarks: p.remarks, status: p.status, rejectionReason: p.rejection_reason, screenshotUrl: p.screenshot_url, submittedAt: p.submitted_at, reviewedAt: p.reviewed_at, duplicateTxId: owners.length > 0, duplicateTxIdUsers: owners };
  });
  return json({ success: true, payments, totalCount, truncated: totalCount > limit });
}

export async function adminreviewpaymentsbatch(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'payments_bulk');
  if (!admin.ok) return json(admin.error);
  let usernames: unknown[];
  try { usernames = Array.isArray(params.usernames) ? params.usernames : JSON.parse(String(params.usernames || '[]')); } catch { return json({ success: false, error: 'usernames must be a JSON array.' }); }
  if (!Array.isArray(usernames) || !usernames.length) return json({ success: false, error: 'No usernames provided.' });
  if (usernames.length > 1000) return json({ success: false, error: 'Limit is 1000 usernames per batch.' });
  const status = String(params.status || '').trim();
  const reason = String(params.rejectionReason || '').trim().slice(0, 500);
  if (!['verified', 'rejected', 'pending'].includes(status)) return json({ success: false, error: 'Invalid status.' });

  const nowIso = new Date().toISOString();
  const cleanNames = [...new Set(usernames.map(u => String(u || '').trim()).filter(Boolean))];
  const { data: found } = await supabase.from('payments').select('username').in('username', cleanNames);
  const foundSet = new Set((found || []).map(r => String(r.username)));

  const results: any[] = usernames.map(raw => {
    const u = String(raw || '').trim();
    if (!u) return { username: u, success: false, error: 'empty' };
    if (!foundSet.has(u)) return { username: u, success: false, error: 'Payment not found.' };
    return { username: u, success: true };
  });

  const toUpdate = Array.from(foundSet);
  if (toUpdate.length) {
    const payPatch: any = { status, reviewed_at: nowIso };
    if (reason && status === 'rejected') payPatch.rejection_reason = reason;
    // FIX BUG-13: check payment update errors.
    const { error: payErr } = await supabase.from('payments').update(payPatch).in('username', toUpdate);
    if (payErr) {
      for (const r of results) if (r.success) { r.success = false; r.error = dbMsg(payErr); }
    } else {
      let userErr: unknown = null;
      if (status === 'verified') {
        const { error } = await supabase.from('users').update({ status: 'active', payment_status: 'verified', permanent_access: 'true', approved_at: nowIso, access_type: 'permanent', access_expires_at: '' }).in('username', toUpdate);
        userErr = error;
      } else if (status === 'rejected') {
        const { error } = await supabase.from('users').update({ status: 'expired', payment_status: 'rejected', permanent_access: 'false' }).in('username', toUpdate);
        userErr = error;
      } else {
        const { error } = await supabase.from('users').update({ status: 'payment_pending', payment_status: 'pending', permanent_access: 'false' }).in('username', toUpdate);
        userErr = error;
      }
      if (userErr) for (const r of results) if (r.success) { r.success = false; r.error = dbMsg(userErr); }
    }
  }
  return json({ success: true, status, results });
}

export async function admindeletepayment(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'payments_review');
  if (!admin.ok) return json(admin.error);
  const username = String(params.targetUsername || '').trim();
  if (!username) return json({ success: false, error: 'Username required.' });
  const { data: found } = await supabase.from('payments').select('screenshot_url').eq('username', username).limit(1);
  if (!found || !found[0]) return json({ success: false, error: 'Payment not found.' });
  const stored = String(found[0].screenshot_url || '');
  if (isStoragePath(stored)) await supabase.storage.from('payments').remove([stored]);
  const { error } = await supabase.from('payments').delete().eq('username', username);
  if (error) return json({ success: false, error: dbMsg(error) });

  // FIX GAP-03: reset user status if currently payment_pending.
  const { data: userRow } = await supabase.from('users').select('status,trial_expires_at').eq('username', username).limit(1);
  if (userRow && userRow[0] && String(userRow[0].status) === 'payment_pending') {
    const trialExp = userRow[0].trial_expires_at ? new Date(String(userRow[0].trial_expires_at)).getTime() : 0;
    const newStatus = trialExp > Date.now() ? 'trial' : 'expired';
    await supabase.from('users').update({ status: newStatus, payment_status: '' }).eq('username', username);
  }
  return json({ success: true, deleted: username });
}

export async function admindownloadscreenshot(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'screenshots');
  if (!admin.ok) return json(admin.error);
  const username = String(params.targetUsername || '').trim();
  if (!username) return json({ success: false, error: 'Username required.' });
  const { data: found } = await supabase.from('payments').select('screenshot_url').eq('username', username).limit(1);
  if (!found || !found[0]) return json({ success: false, error: 'Payment not found.' });
  const stored = String(found[0].screenshot_url || '');
  if (!stored) return json({ success: false, error: 'No screenshot on file.' });
  if (!isStoragePath(stored)) return json({ success: false, error: 'This screenshot is stored on Drive — not migrated.', legacyUrl: stored });
  const { data: signedData, error } = await supabase.storage.from('payments').createSignedUrl(stored, 3600);
  if (error || !signedData) return json({ success: false, error: 'Could not sign screenshot URL.' });
  return json({ success: true, url: signedData.signedUrl, expiresInSec: 3600 });
}

export async function adminrevokescreenshotsharing(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'maintenance');
  if (!admin.ok) return json(admin.error);
  return json({ success: true, processed: 0, revoked: 0, alreadyPrivate: 0, failed: 0, message: 'Supabase Storage is private by default — nothing to revoke.' });
}

export async function getpaymentuploadurl(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const extRaw = String(params.ext || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase();
  const ext = PAY_EXTS.includes(extRaw) ? extRaw : 'png';
  const path = `${auth.username}/${Date.now()}-${randId()}.${ext}`;
  const { data, error } = await supabase.storage.from('payments').createSignedUploadUrl(path);
  if (error || !data) return json({ success: false, error: (error ? dbMsg(error) : 'could not create upload url') });
  return json({ success: true, path, token: data.token, signedUrl: data.signedUrl });
}

export async function getpaymentstatus(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data } = await supabase.from('payments').select('*').eq('username', auth.username).limit(1);
  if (!data || !data[0]) return json({ success: false, error: 'No payment submission found.' });
  const storedShot = String(data[0].screenshot_url || '');
  let signedShot = '';
  if (storedShot && isStoragePath(storedShot)) {
    const { data: signed } = await supabase.storage.from('payments').createSignedUrl(storedShot, 3600);
    if (signed) signedShot = signed.signedUrl;
  }
  return json({
    success: true, payment: {
      username: data[0].username, name: data[0].name, email: data[0].email, mobile: String(data[0].mobile || ''), txId: data[0].tx_id, remarks: data[0].remarks,
      status: data[0].status, rejectionReason: data[0].rejection_reason, screenshotUrl: storedShot, screenshotSignedUrl: signedShot, submittedAt: data[0].submitted_at, reviewedAt: data[0].reviewed_at,
    }
  });
}

// ── Maintenance ────────────────────────────────────────────────────
export async function adminclearprogressbackups(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'maintenance');
  if (!admin.ok) return json(admin.error);
  const { data: existing } = await supabase.from('progress_backups').select('backup_id');
  const deleted = (existing || []).length;
  const { error } = await supabase.from('progress_backups').delete().neq('backup_id', '');
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, deleted });
}

export async function adminpruneoldbackups(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'maintenance');
  if (!admin.ok) return json(admin.error);
  const days = Math.max(1, Math.min(3650, Number(params.daysToKeep) || 30));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data: stale } = await supabase.from('progress_backups').select('backup_id').lt('created_at', cutoff);
  const ids = (stale || []).map(r => String(r.backup_id));
  let deleted = 0;
  if (ids.length) {
    const { error } = await supabase.from('progress_backups').delete().in('backup_id', ids);
    if (error) return json({ success: false, error: dbMsg(error) });
    deleted = ids.length;
  }
  return json({ success: true, deleted, daysToKeep: days });
}

export async function admintrimlogs(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'maintenance');
  if (!admin.ok) return json(admin.error);
  const keepLast = Math.max(100, Math.min(100000, Number(params.keepLast) || 5000));
  const { data: ordered } = await supabase.from('logs').select('timestamp').order('timestamp', { ascending: false }).limit(keepLast);
  if (!ordered || !ordered.length) return json({ success: true, deleted: 0, kept: 0 });
  const oldestKept = String(ordered[ordered.length - 1].timestamp);
  const { count } = await supabase.from('logs').select('*', { count: 'exact', head: true }).lt('timestamp', oldestKept);
  const { error } = await supabase.from('logs').delete().lt('timestamp', oldestKept);
  if (error) return json({ success: false, error: dbMsg(error) });
  return json({ success: true, deleted: count || 0, kept: keepLast });
}

// ── Settings ──────────────────────────────────────────────────────
export async function admingetsettings(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'settings_view');
  if (!admin.ok) return json(admin.error);
  const { data, error } = await supabase.from('settings').select('key,value');
  if (error) return json({ success: false, error: dbMsg(error) });
  const settings: Record<string, string> = {};
  (data || []).forEach((r: { key: string; value: string }) => { settings[r.key] = r.value; });
  return json({ success: true, settings });
}

export async function adminupdatesettings(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'settings_manage');
  if (!admin.ok) return json(admin.error);
  const key = String(params.key || '').trim();
  // FIX BUG-14: value is required.
  if (!key) return json({ success: false, error: 'Setting key required.' });
  if (key.length > 100) return json({ success: false, error: 'Setting key is too long.' });
  if (params.value === undefined) return json({ success: false, error: 'value is required.' });
  const value = params.value;
  const { data: existing } = await supabase.from('settings').select('key').eq('key', key).limit(1);
  if (existing && existing[0]) { const { error } = await supabase.from('settings').update({ value }).eq('key', key); if (error) return json({ success: false, error: dbMsg(error) }); }
  else { const { error } = await supabase.from('settings').insert({ key, value }); if (error) return json({ success: false, error: dbMsg(error) }); }
  return json({ success: true, key, value });
}

export async function adminupdatesettingsbatch(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'settings_manage');
  if (!admin.ok) return json(admin.error);
  let incoming: unknown[];
  try { incoming = Array.isArray(params.settings) ? params.settings : JSON.parse(String(params.settings || '[]')); } catch { return json({ success: false, error: 'settings array required.' }); }
  if (!Array.isArray(incoming) || !incoming.length) return json({ success: false, error: 'settings array required.' });
  if (incoming.length > 200) return json({ success: false, error: 'Too many settings in one batch.' });
  const { data: allRows } = await supabase.from('settings').select('key');
  const existingKeys = new Set<string>((allRows || []).map(r => String(r.key)));
  const applied: string[] = [];
  for (const s of incoming) {
    const key = String((s && (s as any).key) || '').trim(); if (!key || key.length > 100) continue;
    // FIX BUG-14: skip entries without a value.
    if ((s as any).value === undefined) continue;
    const value = (s as any).value;
    if (existingKeys.has(key)) await supabase.from('settings').update({ value }).eq('key', key);
    else { await supabase.from('settings').insert({ key, value }); existingKeys.add(key); }
    applied.push(key);
  }
  return json({ success: true, updated: applied });
}

// ── Admin Accounts (owner-only management) ────────────────────────
// Rules:
//  • Only the owner creates / promotes / deletes admins, sets permissions,
//    resets admin passwords and promotes / demotes owners.
//  • A student becomes an admin only when the owner promotes them.
//  • The last owner can never be deleted or demoted.
//  • While must_change_password is set, authAdmin() blocks everything except
//    adminchangepassword.
async function getAdminRow(username: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabase.from('admins').select('*').eq('username', username).limit(1);
  return data && data[0] ? data[0] as Record<string, unknown> : null;
}

async function replacePermissions(target: string, features: string[], by: string) {
  await supabase.from('admin_permissions').delete().eq('username', target);
  if (!features.length) return null;
  const now = new Date().toISOString();
  const rows = features.map((k) => ({ username: target, feature_key: k, enabled: 'true', updated_at: now, updated_by: by }));
  const { error } = await supabase.from('admin_permissions').insert(rows);
  return error || null;
}

export async function adminlistadmins(params: Record<string, unknown>) {
  const admin = await authAdmin(params);
  if (!admin.ok) return json(admin.error);
  const isOwner = isOwnerRow(admin.admin);
  const { data: admins } = await supabase.from('admins').select('*');
  const { data: perms } = await supabase.from('admin_permissions').select('*');
  const list = (admins || [])
    .filter((a) => isOwner || String(a.username).toLowerCase() === admin.username.toLowerCase())
    .map((a) => {
      const uname = String(a.username);
      const role = String(a.role || 'admin');
      const granted = role === 'owner'
        ? ADMIN_FEATURE_KEYS
        : (perms || []).filter((p) => String(p.username).toLowerCase() === uname.toLowerCase() && truthy(p.enabled)).map((p) => String(p.feature_key));
      return {
        username: uname, createdAt: a.created_at, createdBy: a.created_by, role,
        mustChangePassword: truthy(a.must_change_password), permissions: granted,
      };
    });
  return json({ success: true, admins: list, allFeatures: ADMIN_FEATURE_KEYS, ownerOnlyFeatures: OWNER_ONLY_FEATURES, isOwner });
}

export async function admingetpermissions(params: Record<string, unknown>) {
  const admin = await authAdmin(params);
  if (!admin.ok) return json(admin.error);
  const isOwner = isOwnerRow(admin.admin);
  const role = String(admin.admin.role || 'admin');
  const { data: perms } = await supabase.from('admin_permissions').select('feature_key,enabled').eq('username', admin.username);
  const features: Record<string, boolean> = {};
  ADMIN_FEATURE_KEYS.forEach((k) => { features[k] = isOwner; });
  (perms || []).forEach((p: any) => {
    if (!isOwner) features[String(p.feature_key)] = truthy(p.enabled) && !OWNER_ONLY_FEATURES.includes(String(p.feature_key));
  });
  return json({ success: true, username: admin.username, role, isOwner, features, allFeatures: ADMIN_FEATURE_KEYS, ownerOnlyFeatures: OWNER_ONLY_FEATURES });
}

export async function adminlistadminpermissions(params: Record<string, unknown>) {
  const admin = await authAdmin(params, undefined, { ownerOnly: true });
  if (!admin.ok) return json(admin.error);
  const target = String(params.targetUsername || params.username || '').trim();
  if (!target) return json({ success: false, error: 'username required.' });
  const adm = await getAdminRow(target);
  if (!adm) return json({ success: false, error: 'Admin not found.' });
  const role = String(adm.role || 'admin');
  const { data: perms } = await supabase.from('admin_permissions').select('feature_key,enabled').eq('username', target);
  const features: Record<string, boolean> = {};
  ADMIN_FEATURE_KEYS.forEach((k) => { features[k] = role === 'owner'; });
  (perms || []).forEach((p) => { if (role !== 'owner') features[String(p.feature_key)] = truthy(p.enabled); });
  return json({ success: true, username: target, role, features, allFeatures: ADMIN_FEATURE_KEYS, ownerOnlyFeatures: OWNER_ONLY_FEATURES });
}

export async function adminsetadminpermissions(params: Record<string, unknown>) {
  const admin = await authAdmin(params, undefined, { ownerOnly: true });
  if (!admin.ok) return json(admin.error);
  const target = String(params.targetUsername || params.username || '').trim();
  if (!target) return json({ success: false, error: 'username required.' });
  const adm = await getAdminRow(target);
  if (!adm) return json({ success: false, error: 'Admin not found.' });
  if (isOwnerRow(adm)) return json({ success: false, error: "An owner's permissions cannot be changed." });

  const granted = grantableFeatures(params.features);
  const err = await replacePermissions(target, granted, admin.username);
  if (err) return json({ success: false, error: dbMsg(err) });
  await writeAuditLog(admin.username, 'Set admin permissions', target, granted.join(','));
  return json({ success: true, username: target, permissions: granted });
}

export async function admincreateadmin(params: Record<string, unknown>) {
  const admin = await authAdmin(params, undefined, { ownerOnly: true });
  if (!admin.ok) return json(admin.error);
  const newUsername = String(params.newUsername || params.targetUsername || '').trim();
  const password = String(params.password || '');
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(newUsername)) return json({ success: false, error: 'Username must be 3-30 chars: letters, numbers, dots, dashes, underscores.' });
  if (isReservedUsername(newUsername)) return json({ success: false, error: 'That username is reserved. Choose another.' });
  const problem = passwordProblem(password, newUsername);
  if (problem) return json({ success: false, error: problem });

  if (await getAdminRow(newUsername)) return json({ success: false, error: 'That admin username already exists.' });
  const { data: userExists } = await supabase.from('users').select('username').eq('username', newUsername).limit(1);
  if (userExists && userExists[0]) {
    return json({ success: false, error: 'A student account with this username already exists. Promote the student instead, or pick a different username.' });
  }

  const hash = await makeStoredHash(password);
  const { error } = await supabase.from('admins').insert({
    username: newUsername, pass_hash: hash, created_at: new Date().toISOString(),
    created_by: admin.username, token: '', token_expires: '', role: 'admin', must_change_password: false,
  });
  if (error) return json({ success: false, error: dbMsg(error) });

  const granted = grantableFeatures(params.permissions);
  if (granted.length) await replacePermissions(newUsername, granted, admin.username);
  await writeAuditLog(admin.username, 'Create admin', newUsername, granted.join(','));
  return json({ success: true, username: newUsername, permissions: granted, message: 'Admin account created.' });
}

export async function admindeleteadmin(params: Record<string, unknown>) {
  const admin = await authAdmin(params, undefined, { ownerOnly: true });
  if (!admin.ok) return json(admin.error);
  const target = String(params.targetUsername || '').trim();
  if (!target) return json({ success: false, error: 'username required.' });
  if (target.toLowerCase() === admin.username.toLowerCase()) return json({ success: false, error: "You can't delete the admin account you're logged in as." });
  const row = await getAdminRow(target);
  if (!row) return json({ success: false, error: 'Admin not found.' });
  if (isOwnerRow(row)) return json({ success: false, error: 'Demote this owner to admin first; an owner cannot be deleted directly.' });

  await supabase.from('admin_permissions').delete().eq('username', target);
  const { error } = await supabase.from('admins').delete().eq('username', target);
  if (error) return json({ success: false, error: dbMsg(error) });
  await recordDeletion('admins', [target]);

  // Clear the student session so the admin-switch token cannot be reused.
  await supabase.from('users').update({ session_token: '', session_token_expires_at: '' }).eq('username', target);
  await writeAuditLog(admin.username, 'Delete admin', target);
  return json({ success: true, username: target });
}

export async function adminpromoteowner(params: Record<string, unknown>) {
  const admin = await authAdmin(params, undefined, { ownerOnly: true });
  if (!admin.ok) return json(admin.error);
  const target = String(params.targetUsername || '').trim();
  if (!target) return json({ success: false, error: 'username required.' });
  const row = await getAdminRow(target);
  if (!row) return json({ success: false, error: 'Admin not found.' });
  if (isOwnerRow(row)) return json({ success: false, error: 'This admin is already an owner.' });
  const { error } = await supabase.from('admins').update({ role: 'owner' }).eq('username', target);
  if (error) return json({ success: false, error: dbMsg(error) });
  await supabase.from('admin_permissions').delete().eq('username', target);   // owners hold every feature implicitly
  await writeAuditLog(admin.username, 'Promote to owner', target);
  return json({ success: true, username: target });
}

export async function admindemoteowner(params: Record<string, unknown>) {
  const admin = await authAdmin(params, undefined, { ownerOnly: true });
  if (!admin.ok) return json(admin.error);
  const target = String(params.targetUsername || '').trim();
  if (!target) return json({ success: false, error: 'username required.' });
  const row = await getAdminRow(target);
  if (!row) return json({ success: false, error: 'Admin not found.' });
  if (!isOwnerRow(row)) return json({ success: false, error: 'This admin is not an owner.' });
  if ((await countOwners()) <= 1) return json({ success: false, error: "The last owner can't be demoted. Promote another admin to owner first." });

  const { error } = await supabase.from('admins').update({ role: 'admin', token: '', token_expires: '' }).eq('username', target);
  if (error) return json({ success: false, error: dbMsg(error) });
  const granted = grantableFeatures(params.permissions);
  await replacePermissions(target, granted, admin.username);
  await writeAuditLog(admin.username, 'Demote owner', target, granted.join(','));
  return json({ success: true, username: target, permissions: granted });
}

export async function adminpromoteusertoadmin(params: Record<string, unknown>) {
  const admin = await authAdmin(params, undefined, { ownerOnly: true });
  if (!admin.ok) return json(admin.error);
  const target = String(params.targetUsername || '').trim();
  if (!target) return json({ success: false, error: 'Username required.' });
  const { data: user } = await supabase.from('users').select('*').eq('username', target).limit(1);
  if (!user || !user[0]) return json({ success: false, error: 'User not found.' });
  if (String(user[0].status) === 'rejected') return json({ success: false, error: 'A rejected account cannot be promoted.' });
  if (String(user[0].pass_hash || '').startsWith('locked:')) {
    return json({ success: false, error: 'This student signs in with Google and has no password. Create a separate admin account instead.' });
  }
  if (await getAdminRow(target)) return json({ success: false, error: 'This user is already an admin.' });

  // The admin row shares the student's password hash so "switch to admin" works.
  const { error } = await supabase.from('admins').insert({
    username: target, pass_hash: String(user[0].pass_hash), created_at: new Date().toISOString(),
    created_by: admin.username, token: '', token_expires: '', role: 'admin', must_change_password: false,
  });
  if (error) return json({ success: false, error: dbMsg(error) });

  const granted = grantableFeatures(params.permissions);
  if (granted.length) await replacePermissions(target, granted, admin.username);
  await writeAuditLog(admin.username, 'Promote user to admin', target, granted.join(','));
  return json({ success: true, username: target, permissions: granted, message: 'User promoted to admin.' });
}

/** Owner-only: sets a one-time temporary password on an admin account. The
 *  admin must change it at next login. It deliberately detaches the admin
 *  password from the student password (the "switch to admin" link). */
export async function adminresetadminpassword(params: Record<string, unknown>) {
  const admin = await authAdmin(params, undefined, { ownerOnly: true });
  if (!admin.ok) return json(admin.error);
  const target = String(params.targetUsername || '').trim();
  if (!target) return json({ success: false, error: 'username required.' });
  if (target.toLowerCase() === admin.username.toLowerCase()) return json({ success: false, error: 'Use "Change password" for your own account.' });
  const row = await getAdminRow(target);
  if (!row) return json({ success: false, error: 'Admin not found.' });

  let temp = String(params.tempPassword || '');
  if (temp) {
    const problem = passwordProblem(temp, target);
    if (problem) return json({ success: false, error: problem });
  } else temp = generateTempPassword();

  const { error } = await supabase.from('admins').update({
    pass_hash: await makeStoredHash(temp), token: '', token_expires: '', must_change_password: true,
  }).eq('username', target);
  if (error) return json({ success: false, error: dbMsg(error) });
  await writeAuditLog(admin.username, 'Reset admin password', target);
  return json({ success: true, username: target, tempPassword: temp, mustChangePassword: true, message: 'Share this temporary password once. The admin must change it at next login.' });
}

export async function adminchangepassword(params: Record<string, unknown>) {
  // Works while must_change_password is set; needs no feature permission.
  const admin = await authAdmin(params, undefined, { allowMustChange: true });
  if (!admin.ok) return json(admin.error);
  const rlKey = 'achpw:' + admin.username.toLowerCase();
  if (await rlBlocked(rlKey, 5)) return json(RL_TOO_MANY);

  const currentPassword = String(params.currentPassword || '');
  const newPassword = String(params.newPassword || '');
  const problem = passwordProblem(newPassword, admin.username, currentPassword);
  if (problem) return json({ success: false, error: problem });

  const row = await getAdminRow(admin.username);
  if (!row) return json({ success: false, error: 'Admin account not found.' });
  const v = await verifyPassword(currentPassword, String(row.pass_hash));
  if (!v.ok) { await rlHit(rlKey, RL_WINDOW_MS); return json({ success: false, error: 'Current password is incorrect.' }); }
  await rlClear(rlKey);

  const oldHash = String(row.pass_hash);
  const newHash = await makeStoredHash(newPassword);
  const { error } = await supabase.from('admins').update({ pass_hash: newHash, must_change_password: false, token: '', token_expires: '' }).eq('username', admin.username);
  if (error) return json({ success: false, error: dbMsg(error) });

  // If the student account is linked (same hash), keep it linked.
  const { data: userRow } = await supabase.from('users').select('username,pass_hash').eq('username', admin.username).limit(1);
  if (userRow && userRow[0] && safeEqual(String(userRow[0].pass_hash || ''), oldHash)) {
    await supabase.from('users').update({ pass_hash: newHash, session_token: '', session_token_expires_at: '' }).eq('username', admin.username);
  }

  // Fresh token so the console stays signed in after the change.
  const token = await issueAdminToken(admin.username);
  await writeAuditLog(admin.username, 'Change admin password', admin.username);
  return json({ success: true, message: 'Password changed.', adminToken: token, token, mustChangePassword: false, expiresInMs: ADMIN_TOKEN_TTL_MS });
}

// ── Imports / Logs / Push ─────────────────────────────────────────
export async function adminimportprogress(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'imports');
  if (!admin.ok) return json(admin.error);
  const mode = String(params.mode || 'preview').trim().toLowerCase();
  if (!['preview', 'merge', 'replace'].includes(mode)) return json({ success: false, error: 'mode must be preview, merge, or replace.' });
  let payload: Record<string, unknown> | null = null;
  const raw = params.payload !== undefined ? params.payload : params.data;
  if (typeof raw === 'string') { if (raw.length > 450000) return json({ success: false, error: 'Import payload is too large.' }); try { payload = JSON.parse(raw); } catch { return json({ success: false, error: 'Import payload is not valid JSON.' }); } }
  else if (raw && typeof raw === 'object') payload = raw as Record<string, unknown>;
  if (!payload) return json({ success: false, error: 'Import payload must be a JSON object.' });

  let records: Array<Record<string, unknown>> = [];
  if (Array.isArray(payload.records)) records = payload.records as any[];
  else if (Array.isArray(payload.users)) records = payload.users as any[];
  else if (payload.username && payload.data) records = [payload as any];
  if (!records.length) return json({ success: false, error: 'No import records found.' });
  if (records.length > 500) return json({ success: false, error: 'Import is limited to 500 records.' });

  const importId = crypto.randomUUID(); const now = new Date().toISOString();
  // FIX BUG-18: check insert error.
  const { error: insErr } = await supabase.from('progress_imports').insert({ import_id: importId, admin: admin.username, mode, status: 'started', records_received: records.length, records_accepted: 0, records_skipped: 0, error_count: 0, created_at: now, completed_at: '', details: '' });
  if (insErr) return json({ success: false, error: dbMsg(insErr) });

  const errors: any[] = []; const accepted: any[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i] || {}; const username = String(r.username || '').trim().slice(0, 120); if (!username) { errors.push({ index: i, error: 'username is required.' }); continue; }
    let dataStr = ''; const dv = r.data !== undefined ? r.data : r.progress;
    if (typeof dv === 'string') dataStr = dv; else if (dv && typeof dv === 'object') dataStr = JSON.stringify(dv);
    if (!dataStr) { errors.push({ index: i, username, error: 'Progress data is empty.' }); continue; }
    if (dataStr.length > 45000) { errors.push({ index: i, username, error: 'Progress data exceeds 45,000 chars.' }); continue; }
    let parsed: any = null; try { parsed = JSON.parse(dataStr); } catch { errors.push({ index: i, username, error: 'Not valid JSON.' }); continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { errors.push({ index: i, username, error: 'Progress data must be a JSON object.' }); continue; }
    accepted.push({ username, data: dataStr });
  }

  if (mode === 'preview') {
    await supabase.from('progress_imports').update({ status: 'preview', records_accepted: accepted.length, records_skipped: errors.length, error_count: errors.length, completed_at: new Date().toISOString(), details: JSON.stringify(errors).slice(0, 30000) }).eq('import_id', importId);
    return json({ success: true, importId, mode, preview: true, recordsReceived: records.length, recordsAccepted: accepted.length, recordsSkipped: errors.length, errors });
  }

  let appliedCount = 0; let skippedCount = errors.length;
  for (const item of accepted) {
    const { data: userRow } = await supabase.from('users').select('username').eq('username', item.username).limit(1);
    if (!userRow || !userRow[0]) { errors.push({ username: item.username, error: 'User account does not exist.' }); skippedCount++; continue; }
    const { data: existing } = await supabase.from('progress').select('*').eq('username', item.username).limit(1);
    const hasExisting = existing && existing[0];
    if (mode === 'replace' && hasExisting) await supabase.from('progress_backups').insert({ backup_id: crypto.randomUUID(), import_id: importId, username: item.username, data: String(existing[0].data || ''), created_at: new Date().toISOString(), created_by: admin.username });

    let finalData = item.data;
    if (mode === 'merge' && hasExisting) {
      let existingObj: any = {}; try { existingObj = JSON.parse(String(existing[0].data || '{}')); } catch { /* ignore */ }
      let newObj: any = {}; try { newObj = JSON.parse(item.data); } catch { /* ignore */ }
      const merged = { ...existingObj, ...newObj };
      const exSess = Array.isArray(existingObj?.prog?.sessions) ? existingObj.prog.sessions : [];
      const nwSess = Array.isArray(newObj?.prog?.sessions) ? newObj.prog.sessions : [];
      if (exSess.length || nwSess.length) {
        const seen = new Set<string>(); const combined: any[] = [];
        for (const s of [...exSess, ...nwSess]) { const id = String(s.id || s.at || Math.random()); if (seen.has(id)) continue; seen.add(id); combined.push(s); }
        combined.sort((a: any, b: any) => Number(a.at || 0) - Number(b.at || 0));
        merged.prog = { ...(existingObj.prog || {}), ...(newObj.prog || {}), sessions: combined };
      }
      merged.updatedAt = new Date().toISOString();
      try { finalData = JSON.stringify(merged); } catch { /* ignore */ }
      if (finalData.length > 45000) { errors.push({ username: item.username, error: 'Merged progress exceeds 45,000 chars.' }); skippedCount++; continue; }
    }
    const nowIso = new Date().toISOString();
    if (hasExisting) await supabase.from('progress').update({ data: finalData, updated_at: nowIso }).eq('username', item.username);
    else await supabase.from('progress').insert({ username: item.username, data: finalData, updated_at: nowIso });
    appliedCount++;
  }
  const status = errors.length ? 'completed_with_errors' : 'completed';
  // FIX BUG-18: log status update failure (non-fatal but visible).
  const { error: updErr } = await supabase.from('progress_imports').update({ status, records_accepted: appliedCount, records_skipped: skippedCount, error_count: errors.length, completed_at: new Date().toISOString(), details: JSON.stringify(errors).slice(0, 30000) }).eq('import_id', importId);
  if (updErr) console.error('[adminimportprogress] status update failed:', updErr);
  return json({ success: true, importId, mode, preview: false, recordsAccepted: appliedCount, recordsSkipped: skippedCount, errors });
}

export async function adminimportstatus(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'imports');
  if (!admin.ok) return json(admin.error);
  const importId = String(params.importId || '').trim().slice(0, 100);
  if (!importId) return json({ success: false, error: 'importId is required.' });
  const { data } = await supabase.from('progress_imports').select('*').eq('import_id', importId).limit(1);
  if (!data || !data[0]) return json({ success: false, error: 'Import not found.' });
  const row = data[0];
  let errors: unknown[] = []; const details = String(row.details || '');
  if (details) { try { errors = JSON.parse(details); } catch { errors = [{ error: details }]; } }
  return json({ success: true, import: { importId: row.import_id, admin: row.admin, mode: row.mode, status: row.status, recordsReceived: Number(row.records_received || 0), recordsAccepted: Number(row.records_accepted || 0), recordsSkipped: Number(row.records_skipped || 0), errorCount: Number(row.error_count || 0), createdAt: row.created_at, completedAt: row.completed_at, errors } });
}

export async function adminlistlogs(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'logs_view');
  if (!admin.ok) return json(admin.error);
  const limit = Math.min(Number(params.limit) || 1000, 1000);
  const { data, error } = await supabase.from('logs').select('*').order('timestamp', { ascending: false }).limit(limit);
  if (error) return json({ success: false, error: dbMsg(error) });
  const { count } = await supabase.from('logs').select('*', { count: 'exact', head: true });
  const logs = (data || []).map(r => ({ timestamp: r.timestamp, admin: r.admin, action: r.action, target: r.target, details: r.details }));
  return json({ success: true, logs, totalCount: count || 0, truncated: (count || 0) > logs.length });
}

export async function savepushtoken(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const token = String(params.fcmToken || '').trim();
  if (!token) return json({ success: false, error: 'Username and fcmToken required.' });
  if (token.length > 4096) return json({ success: false, error: 'fcmToken is too long.' });

  // FIX BUG-19: clear this token from any other users first, so a device
  // token only belongs to one username at a time.
  await supabase.from('push_tokens').delete().eq('fcm_token', token).neq('username', auth.username);

  const now = new Date().toISOString();
  const { data: existing } = await supabase.from('push_tokens').select('username').eq('username', auth.username).limit(1);
  if (existing && existing[0]) { const { error } = await supabase.from('push_tokens').update({ fcm_token: token, updated_at: now }).eq('username', auth.username); if (error) return json({ success: false, error: dbMsg(error) }); }
  else { const { error } = await supabase.from('push_tokens').insert({ username: auth.username, fcm_token: token, updated_at: now }); if (error) return json({ success: false, error: dbMsg(error) }); }
  return json({ success: true });
}