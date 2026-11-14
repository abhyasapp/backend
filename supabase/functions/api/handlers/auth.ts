import { supabase } from '../_shared/db.ts';
import { json, dbMsg, clientIp, escLike } from '../_shared/http.ts';
import { verifyPassword, pbkdf2, lockedHash, makeStoredHash, safeEqual, randId } from '../_shared/crypto.ts';
import {
  findUserByIdentifier, issueUserToken, issueAdminToken,
  computeAccess, publicUser, authUser, authAdmin, requireAccess,
} from '../_shared/auth.ts';
import { rlBlocked, rlHit, rlClear, RL_WINDOW_MS, RL_TOO_MANY } from '../_shared/rate-limit.ts';
import { PW_ITERATIONS, FUNCTION_VERSION, ADMIN_TOKEN_TTL_MS } from '../_shared/config.ts';
import { ensureDefaultOwner, truthy, writeAuditLog, isReservedUsername, passwordProblem } from '../_shared/owner.ts';

export async function ping() { return json({ success: true, pong: true, version: FUNCTION_VERSION, runtime: 'supabase' }); }

// ── public settings (filters private_/secret_) ────────────────────────
export async function getsettings() {
  const { data, error } = await supabase.from('settings').select('key,value');
  if (error) return json({ success: false, error: dbMsg(error) });
  const settings: Record<string, string> = {};
  (data || []).forEach((r: { key: string; value: string }) => {
    // adminEmail is read by the weekly-summary job only; never expose it to anonymous callers.
    if (!/^(private_|secret_)/i.test(r.key) && r.key !== 'adminEmail') settings[r.key] = r.value;
  });
  return json({ success: true, settings });
}

// ── content key (paid content decryption) ─────────────────────────────
export async function getcontentkey(params: Record<string, unknown>) {
  let adminOk = false;
  if (params.adminToken) {
    const adminRes = await authAdmin({ username: params.username, token: params.adminToken });
    if (adminRes.ok) adminOk = true;
  }
  if (!adminOk) {
    const auth = await authUser(params);
    if (!auth.ok) return json(auth.error);
    const gate = requireAccess(auth);
    if (gate) return json(gate);
  }

  // If the deploy wants paid-only key access, enforce that for non-admin users.
  if (!adminOk && (Deno.env.get('CONTENT_KEY_TRIAL') || 'true') === 'false') {
    const au = await authUser(params);
    if (au.ok && computeAccess(au.user).level !== 'permanent') {
      return json({ success: false, needsPayment: true, error: 'Complete payment to unlock this content.' });
    }
  }

  const currentKid = String(Deno.env.get('CONTENT_KEY_ID') || '').trim();
  const kid = String(params.kid || currentKid).trim();
  if (!kid) return json({ success: false, error: 'No content key is set up.', noKey: true });
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) return json({ success: false, error: 'Invalid key id.' });

  const key = Deno.env.get('CONTENT_KEY_' + kid);
  if (!key) return json({ success: false, error: 'No content key is set up for this id.', noKey: true });
  return json({ success: true, kid, current: currentKid, key: String(key) });
}

export async function login(params: Record<string, unknown>, req: Request) {
  const identifier = String(params.username || '').trim();
  const password = String(params.password || '');
  if (!identifier || !password) return json({ success: false, error: 'Enter username and password.' });
  if (password.length > 256 || identifier.length > 120) return json({ success: false, error: 'Invalid username or password.' });

  const ip = clientIp(req);
  const rlUser = 'login:u:' + identifier.toLowerCase();
  const rlIp = 'login:ip:' + ip;
  if ((await rlBlocked(rlUser, 8)) || (await rlBlocked(rlIp, 40))) return json(RL_TOO_MANY);

  const user = await findUserByIdentifier(identifier);
  if (!user) {
    await pbkdf2(password, 'timing-equaliser', PW_ITERATIONS);
    await rlHit(rlUser, RL_WINDOW_MS); await rlHit(rlIp, RL_WINDOW_MS);
    return json({ success: false, error: 'Invalid username or password.' });
  }

  const v = await verifyPassword(password, String(user.pass_hash || ''));
  if (!v.ok) {
    await rlHit(rlUser, RL_WINDOW_MS); await rlHit(rlIp, RL_WINDOW_MS);
    return json({ success: false, error: 'Invalid username or password.' });
  }

  await rlClear(rlUser);
  if (v.upgraded) {
    const oldHash = String(user.pass_hash || '');
    await supabase.from('users').update({ pass_hash: v.upgraded }).eq('username', user.username);
    // A promoted student's admin row shares this hash ("switch to admin" compares them);
    // keep it in step or the link silently breaks after a hash upgrade.
    await supabase.from('admins').update({ pass_hash: v.upgraded }).eq('username', user.username).eq('pass_hash', oldHash);
    user.pass_hash = v.upgraded;
  }
  if (String(user.status) === 'rejected') return json({ success: false, error: 'Account rejected. Contact admin.' });

  const token = await issueUserToken(String(user.username));
  const access = computeAccess(user);
  const out: Record<string, unknown> = { success: true, user: publicUser(user), token };

  if (access.level === 'permanent') {
    out.permanentAccess = true; out.accessType = access.accessType; out.accessExpiresAt = access.accessExpiresAt; out.message = 'Welcome back!';
  } else if (access.level === 'trial') {
    out.isTrial = true; out.trialExpiresAt = access.trialExpiresAt; out.message = 'You got 1-day free trial. Pay to get long-term access.';
  } else {
    out.needsPayment = true; out.message = 'Your trial has expired. Please complete payment to continue.';
  }
  return json(out);
}

export async function googlelogin(params: Record<string, unknown>, req: Request) {
  if (await rlBlocked('glogin:ip:' + clientIp(req), 60)) return json(RL_TOO_MANY);
  await rlHit('glogin:ip:' + clientIp(req), RL_WINDOW_MS);
  const idToken = String(params.idToken || '').trim();
  if (!idToken) return json({ success: false, error: 'Missing Google ID token.' });
  if (idToken.length > 4096) return json({ success: false, error: 'Invalid Google ID token.' });

  let payload: any;
  try {
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!resp.ok) throw new Error('Google returned an error.');
    payload = await resp.json();
  } catch {
    return json({ success: false, error: 'Google sign-in verification failed. Please try again.' });
  }

  const expectedClientId = Deno.env.get('GOOGLE_CLIENT_ID') || '242226857075-hpkbjoqhlem95fu6vkf712e8ijs33sng.apps.googleusercontent.com';
  const gIss = String(payload.iss || '');
  if (gIss !== 'https://accounts.google.com' && gIss !== 'accounts.google.com') {
    return json({ success: false, error: 'Invalid Google sign-in issuer.' });
  }
  if (Number(payload.exp || 0) * 1000 < Date.now()) return json({ success: false, error: 'Google sign-in expired. Please try again.' });
  if (!payload.aud || payload.aud !== expectedClientId) return json({ success: false, error: 'This Google sign-in was not issued for this app.' });
  if (payload.email_verified !== 'true' && payload.email_verified !== true) return json({ success: false, error: 'Your Google email is not verified.' });

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return json({ success: false, error: 'Google did not return an email address.' });
  const name = String(payload.name || email.split('@')[0]).slice(0, 80);

  let user: Record<string, unknown> | null = null;
  const { data: existing } = await supabase.from('users').select('*').ilike('email', escLike(email)).limit(1);

  if (existing && existing[0]) {
    const ex = existing[0] as Record<string, unknown>;
    user = ex;
    if (String(ex.email_verified) !== 'true') {
      await supabase.from('users').update({ email_verified: 'true', pass_hash: lockedHash(), session_token: '', session_token_expires_at: '' }).eq('username', ex.username);
      ex.email_verified = 'true';
    }
  } else {
    let base = email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24) || 'user';
    let candidate = base;
    let n = 1;
    // A derived username must not be reserved (admin, support, ...) or collide with an admin account.
    const usernameTaken = async (c: string): Promise<boolean> => {
      if (isReservedUsername(c)) return true;
      const { data: u } = await supabase.from('users').select('username').eq('username', c).limit(1);
      if (u && u[0]) return true;
      const { data: a } = await supabase.from('admins').select('username').eq('username', c).limit(1);
      return !!(a && a[0]);
    };
    while (n < 50) {
      if (!(await usernameTaken(candidate))) break;
      candidate = base + n; n++;
    }
    if (n >= 50) candidate = base + randId();

    const now = new Date();
    const trialExpires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const { error: insErr } = await supabase.from('users').insert({
      username: candidate, pass_hash: lockedHash(), name, email, mobile: '',
      status: 'trial', trial_expires_at: trialExpires.toISOString(),
      created_at: now.toISOString(), approved_at: '', role: 'user', payment_status: '',
      permanent_access: 'false', access_type: '', access_expires_at: '', email_verified: 'true',
      session_token: '', session_token_expires_at: ''
    });
    if (insErr) return json({ success: false, error: dbMsg(insErr) });
    const { data: newData } = await supabase.from('users').select('*').eq('username', candidate).limit(1);
    user = newData && newData[0] ? newData[0] : null;
  }

  if (!user) return json({ success: false, error: 'Could not create or find user.' });
  if (String(user.status) === 'rejected') return json({ success: false, error: 'Account rejected. Contact admin.' });

  const token = await issueUserToken(String(user.username));
  const access = computeAccess(user);
  const out: Record<string, unknown> = { success: true, user: publicUser(user), token };
  if (access.level === 'permanent') { out.permanentAccess = true; out.accessType = access.accessType; out.accessExpiresAt = access.accessExpiresAt; }
  else if (access.level === 'trial') { out.isTrial = true; out.trialExpiresAt = access.trialExpiresAt; }
  else { out.needsPayment = true; }

  const { data: adminRow } = await supabase.from('admins').select('username').eq('username', user.username).limit(1);
  out.adminCapable = !!(adminRow && adminRow[0]);
  return json(out);
}

export async function signup(params: Record<string, unknown>, req: Request) {
  const username = String(params.username || '').trim();
  const password = String(params.password || '');
  const name     = String(params.name || '').trim();
  const email    = String(params.email || '').trim().toLowerCase();
  const mobile   = String(params.mobile || '').trim();

  if (await rlBlocked('signup:ip:' + clientIp(req), 10)) return json(RL_TOO_MANY);
  await rlHit('signup:ip:' + clientIp(req), 60 * 60 * 1000);

  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return json({ success: false, error: 'Username must be 3-30 chars: letters, numbers, dots, dashes, underscores.' });
  if (isReservedUsername(username)) return json({ success: false, error: 'That username is reserved. Please choose another.' });
  if (!password) return json({ success: false, error: 'Password required.' });
  const pwProblem = passwordProblem(password, username);   // same policy as admin passwords
  if (pwProblem) return json({ success: false, error: pwProblem });
  if (!name) return json({ success: false, error: 'Name required.' });
  if (name.length > 80) return json({ success: false, error: 'Name is too long.' });
  if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return json({ success: false, error: 'Invalid email address.' });
  if (mobile && !/^(98|97|96|99)\d{8}$/.test(mobile)) return json({ success: false, error: 'Invalid Nepali mobile number.' });

  const { data: dupUser } = await supabase.from('users').select('username').eq('username', username).limit(1);
  if (dupUser && dupUser[0]) return json({ success: false, error: 'That username is already taken.' });
  if (email) {
    const { data: dupEmail } = await supabase.from('users').select('username').ilike('email', escLike(email)).limit(1);
    if (dupEmail && dupEmail[0]) return json({ success: false, error: 'An account with this email already exists.' });
  }
  if (mobile) {
    const { data: dupMobile } = await supabase.from('users').select('username').eq('mobile', mobile).limit(1);
    if (dupMobile && dupMobile[0]) return json({ success: false, error: 'An account with this mobile number already exists.' });
  }

  const passHash = await makeStoredHash(password);
  const now = new Date();
  const trialExpires = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const { error } = await supabase.from('users').insert({
    username, pass_hash: passHash, name, email, mobile, status: 'trial',
    trial_expires_at: trialExpires.toISOString(), created_at: now.toISOString(),
    approved_at: '', role: 'user', payment_status: '', permanent_access: 'false',
    access_type: '', access_expires_at: '', email_verified: 'false',
    session_token: '', session_token_expires_at: '',
  });
  if (error) return json({ success: false, error: dbMsg(error) });

  const token = await issueUserToken(username);
  const { data: userData } = await supabase.from('users').select('*').eq('username', username).limit(1);
  const user = userData && userData[0] ? userData[0] : null;

  return json({
    success: true, user: user ? publicUser(user) : { username, name, email, mobile, status: 'trial' }, token, isTrial: true,
    trialExpiresAt: trialExpires.toISOString(), message: 'Account created. You got a 1-day free trial. Pay to get long-term access.',
  });
}

export async function checksession(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const user = auth.user;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const remaining = Number(user.session_token_expires_at || 0) - Date.now();
  const freshToken = remaining < SEVEN_DAYS ? await issueUserToken(auth.username) : String(params.token || '');
  const access = computeAccess(user);
  const out: Record<string, unknown> = { success: true, user: publicUser(user), token: freshToken };
  if (access.level === 'permanent') { out.permanentAccess = true; out.accessType = access.accessType; out.accessExpiresAt = access.accessExpiresAt; }
  else if (access.level === 'trial') { out.isTrial = true; out.hoursLeft = Math.max(0, Math.ceil((new Date(String(user.trial_expires_at)).getTime() - Date.now()) / 3600000)); }
  else if (access.level === 'pending_review' || access.level === 'expired') { out.needsPayment = true; }
  const { data: adminRow } = await supabase.from('admins').select('username').eq('username', user.username).limit(1);
  out.adminCapable = !!(adminRow && adminRow[0]);
  return json(out);
}

export async function logoutotherdevices(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const newToken = await issueUserToken(auth.username);
  return json({ success: true, token: newToken });
}

export async function checkadmincapable(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const { data } = await supabase.from('admins').select('username,pass_hash').eq('username', auth.username).limit(1);
  const admin = data && data[0] ? data[0] as Record<string, unknown> : null;
  const capable = !!(admin && admin.pass_hash && safeEqual(String(admin.pass_hash), String(auth.user.pass_hash)));
  return json({ success: true, adminCapable: capable });
}

export async function adminswitchfromuser(params: Record<string, unknown>) {
  const auth = await authUser(params);
  if (!auth.ok) return json(auth.error);
  const username = auth.username;
  const rlKey = 'aswitch:' + username.toLowerCase();
  if (await rlBlocked(rlKey, 10)) return json(RL_TOO_MANY);
  await rlHit(rlKey, RL_WINDOW_MS);

  const { data } = await supabase.from('admins').select('*').eq('username', username).limit(1);
  const admin = data && data[0] ? data[0] as Record<string, unknown> : null;
  if (!admin || !admin.pass_hash || !safeEqual(String(admin.pass_hash), String(auth.user.pass_hash))) {
    return json({ success: false, error: 'This account does not have admin access.' });
  }
  const adminToken = await issueAdminToken(username);
  await writeAuditLog(username, 'Switch to Admin (from user session)', username);
  return json({
    success: true, isAdmin: true, adminToken, username,
    isOwner: String(admin.role || '').toLowerCase() === 'owner',
    mustChangePassword: truthy(admin.must_change_password),
    expiresInMs: ADMIN_TOKEN_TTL_MS,
  });
}

export async function adminlogin(params: Record<string, unknown>, req: Request) {
  const username = String(params.username || '').trim();
  const password = String(params.password || '');
  if (!username || !password) return json({ success: false, error: 'Enter admin username and password.' });
  if (password.length > 256 || username.length > 120) return json({ success: false, error: 'Invalid admin credentials.' });
  const rlA = 'alogin:u:' + username.toLowerCase();
  const rlAIp = 'alogin:ip:' + clientIp(req);
  if ((await rlBlocked(rlA, 5)) || (await rlBlocked(rlAIp, 20))) return json(RL_TOO_MANY);

  // First admin login on a fresh install: create the default owner.
  await ensureDefaultOwner();

  const { data } = await supabase.from('admins').select('*').eq('username', username).limit(1);
  const admin = data && data[0] ? data[0] as Record<string, unknown> : null;
  if (!admin) {
    await pbkdf2(password, 'timing-equaliser', PW_ITERATIONS);
    await rlHit(rlA, RL_WINDOW_MS); await rlHit(rlAIp, RL_WINDOW_MS);
    return json({ success: false, error: 'Invalid admin credentials.' });
  }
  const v = await verifyPassword(password, String(admin.pass_hash || ''));
  if (!v.ok) {
    await rlHit(rlA, RL_WINDOW_MS); await rlHit(rlAIp, RL_WINDOW_MS);
    return json({ success: false, error: 'Invalid admin credentials.' });
  }
  await rlClear(rlA);
  if (v.upgraded) {
    await supabase.from('admins').update({ pass_hash: v.upgraded }).eq('username', admin.username);
    // Linked student account (promoted user) keeps sharing the same hash.
    await supabase.from('users').update({ pass_hash: v.upgraded }).eq('username', admin.username).eq('pass_hash', String(admin.pass_hash));
  }
  const role = String(admin.role || 'admin');
  const token = await issueAdminToken(String(admin.username));
  await writeAuditLog(String(admin.username), 'Admin Login', '');
  return json({
    success: true, isAdmin: true, adminToken: token,
    mustChangePassword: truthy(admin.must_change_password),
    isOwner: role.toLowerCase() === 'owner',
    user: { username: admin.username, name: 'Administrator', role },
    message: 'Welcome to Admin World',
  });
}

export async function logclienterror(params: Record<string, unknown>, req: Request) {
  const ip = clientIp(req);
  const rlKey = 'cerr:' + ip;
  if (await rlBlocked(rlKey, 30)) return json({ success: true });
  await rlHit(rlKey, 60000);
  const clip = (v: unknown, n: number) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').slice(0, n);
  const details = `${clip(params.msg, 200)} @ ${clip(params.src, 80)}:${clip(params.line, 8)} v${clip(params.v, 10)} ${clip(params.ua, 80)}`;
  try { await supabase.from('logs').insert({ timestamp: new Date().toISOString(), admin: 'client', action: 'Client Error', target: clip(params.page, 60), details }); } catch { /* ignore */ }
  return json({ success: true });
}

export async function getpublicinfo() {
  const { data } = await supabase.from('settings').select('key,value');
  const all: Record<string, string> = {};
  (data || []).forEach((r: { key: string; value: string }) => { all[r.key] = r.value; });
  return json({
    success: true, announcement: all.announcement || '', contentVersion: all.contentVersion || '', loksewaScheme: all.loksewaScheme || '',
    paymentAmount: all.paymentAmount || '', contactPhone: all.contactPhone || '', qrCodeUrl: all.qrCodeUrl || '', paymentInstructions: all.paymentInstructions || '',
  });
}