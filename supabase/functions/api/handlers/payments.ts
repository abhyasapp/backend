import { supabase } from '../_shared/db.ts';
import { json, dbMsg, escLike } from '../_shared/http.ts';
import { writeAuditLog } from '../_shared/owner.ts';
import { authUser, authAdmin, computeAccess } from '../_shared/auth.ts';
import { base64ToBytes, detectImageType, randId } from '../_shared/crypto.ts';
import { ownedUploadPath } from '../_shared/utils.ts';
import { PAY_EXTS } from '../_shared/config.ts';

export async function submitpayment(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const username = auth.username;

  const name = String(params.name || '').trim().slice(0, 80);
  const email = String(params.email || '').trim().slice(0, 120);
  const mobile = String(params.mobile || '').trim().slice(0, 20);
  const txId = String(params.txId || '').trim().slice(0, 80);
  const remarks = String(params.remarks || '').trim().slice(0, 500);
  if (!txId) return json({ success: false, error: 'Transaction ID required.' });

  const status = String(auth.user.status || '');
  const accessLevel = computeAccess(auth.user).level;
  if (!(status === 'expired' || status === 'payment_pending' || status === 'trial' || accessLevel === 'expired')) {
    return json({ success: false, error: 'Payment not required at this time.' });
  }

  let screenshotStored = '';
  const providedPath = String(params.screenshotPath || '').trim();
  const legacyData = String(params.screenshot || '');

  if (providedPath) {
    if (!ownedUploadPath(providedPath, username, PAY_EXTS)) {
      return json({ success: false, error: 'Invalid screenshot path.' });
    }
    const { data: exists } = await supabase.storage
      .from('payments').list(username, { search: providedPath.split('/').pop() });
    if (!exists || !exists.length) return json({ success: false, error: 'Screenshot upload not found.' });
    screenshotStored = providedPath;
  } else if (legacyData.startsWith('data:image')) {
    if (legacyData.length > 8 * 1024 * 1024) {
      return json({ success: false, error: 'Screenshot is too large — max ~6 MB.' });
    }
    const comma = legacyData.indexOf(',');
    if (comma < 0) return json({ success: false, error: 'Invalid screenshot data.' });
    const bytes = base64ToBytes(legacyData.slice(comma + 1));
    const type = detectImageType(bytes);
    if (!type) return json({ success: false, error: 'Unsupported screenshot format. Use PNG, JPG, WEBP, GIF or HEIC.' });
    const path = `${username}/${Date.now()}-${randId()}.${type.ext}`;
    const { error: upErr } = await supabase.storage
      .from('payments').upload(path, bytes, { contentType: type.mime, upsert: false });
    if (upErr) return json({ success: false, error: 'Screenshot upload failed. ' + dbMsg(upErr) });
    screenshotStored = path;
  } else if (legacyData.length <= 500 && /^https:\/\/(drive|docs)\.google\.com\//.test(legacyData)) {
    screenshotStored = legacyData;
  }

  // Case-insensitive, matching how the admin console detects duplicate transaction IDs.
  const { data: dupRows } = await supabase.from('payments').select('*').ilike('tx_id', escLike(txId));
  const dup = (dupRows || []).find(r =>
    String(r.username || '').toLowerCase() !== username.toLowerCase() &&
    String(r.status || '').toLowerCase() !== 'rejected'
  );
  if (dup) return json({ success: false, error: 'This transaction ID has already been used. Check it, or contact support.' });

  const now = new Date().toISOString();
  const { data: existing } = await supabase.from('payments').select('*').eq('username', username).limit(1);

  if (existing && existing[0]) {
    const patch: Record<string, unknown> = {
      name: name || existing[0].name,
      email: email || existing[0].email,
      mobile: mobile || existing[0].mobile,
      tx_id: txId,
      remarks: remarks || existing[0].remarks,
      status: 'pending',
      rejection_reason: '',
      submitted_at: now,
    };
    if (screenshotStored) patch.screenshot_url = screenshotStored;
    const { error } = await supabase.from('payments').update(patch).eq('username', username);
    if (error) return json({ success: false, error: dbMsg(error) });
  } else {
    const { error } = await supabase.from('payments').insert({
      username, name, email, mobile, tx_id: txId, remarks,
      status: 'pending', rejection_reason: '',
      screenshot_url: screenshotStored,
      submitted_at: now, reviewed_at: '',
    });
    if (error) return json({ success: false, error: dbMsg(error) });
  }

  await supabase.from('users')
    .update({ status: 'payment_pending', payment_status: 'pending' })
    .eq('username', username);

  return json({ success: true, message: 'Payment submitted successfully. Waiting for admin verification.' });
}

export async function adminreviewpayment(params: Record<string, unknown>) {
  const admin = await authAdmin(params, 'payments_review');
  if (!admin.ok) return json(admin.error);

  const username = String(params.targetUsername || '').trim();
  const status = String(params.status || '').trim();
  const reason = String(params.rejectionReason || '').trim().slice(0, 500);
  if (!username || !status) return json({ success: false, error: 'Username and status required.' });
  if (!['verified', 'rejected', 'pending'].includes(status)) {
    return json({ success: false, error: 'Status must be verified, rejected, or pending.' });
  }

  const { data: found } = await supabase.from('payments').select('*').eq('username', username).limit(1);
  if (!found || !found[0]) return json({ success: false, error: 'Payment not found.' });

  const nowIso = new Date().toISOString();
  const payPatch: Record<string, unknown> = { status, reviewed_at: nowIso };
  if (reason && status === 'rejected') payPatch.rejection_reason = reason;
  const { error: payErr } = await supabase.from('payments').update(payPatch).eq('username', username);
  if (payErr) return json({ success: false, error: dbMsg(payErr) });

  if (status === 'verified') {
    await supabase.from('users').update({
      status: 'active', payment_status: 'verified',
      permanent_access: 'true', approved_at: nowIso,
      access_type: 'permanent', access_expires_at: '',
    }).eq('username', username);
  } else if (status === 'rejected') {
    await supabase.from('users').update({
      status: 'expired', payment_status: 'rejected', permanent_access: 'false',
    }).eq('username', username);
  } else {
    await supabase.from('users').update({
      status: 'payment_pending', payment_status: 'pending', permanent_access: 'false',
    }).eq('username', username);
  }
  await writeAuditLog(admin.username, 'Review payment: ' + status, username, reason);
  return json({ success: true, username, status });
}