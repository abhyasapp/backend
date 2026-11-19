import { supabase } from './db.ts';
import { tokenHash, tokenMatches } from './crypto.ts';
import { USER_TOKEN_TTL_MS, ADMIN_TOKEN_TTL_MS } from './config.ts';
import { escLike } from './http.ts';

// computeAccess lives in pure.ts (dependency-free, unit-tested). Re-exported for handlers.
export { computeAccess } from './pure.ts';
import { computeAccess } from './pure.ts';

export function publicUser(u: Record<string, unknown>) {
  return {
    username: u.username, name: u.name, email: u.email, mobile: u.mobile,
    status: u.status, createdAt: u.created_at, approvedAt: u.approved_at,
    role: u.role, trialExpiresAt: u.trial_expires_at, paymentStatus: u.payment_status,
    permanentAccess: u.permanent_access === true || String(u.permanent_access) === 'true',
    accessType: u.access_type, accessExpiresAt: u.access_expires_at,
    emailVerified: u.email_verified === true || String(u.email_verified) === 'true',
  };
}

export async function issueUserToken(username: string): Promise<string> {
  const token = crypto.randomUUID();
  const expires = String(Date.now() + USER_TOKEN_TTL_MS);
  await supabase.from('users').update({ session_token: await tokenHash(token), session_token_expires_at: expires }).eq('username', username);
  return token;
}

export async function issueAdminToken(username: string): Promise<string> {
  const token = crypto.randomUUID();
  const expires = String(Date.now() + ADMIN_TOKEN_TTL_MS);
  await supabase.from('admins').update({ token: await tokenHash(token), token_expires: expires }).eq('username', username);
  return token;
}

// Every users column EXCEPT pass_hash. authUser runs on every authenticated request,
// so it must not drag the password hash across the wire (and into memory) each time.
// tests/schema.test.mjs pins this list to the real table so a new column cannot be
// silently missing from `auth.user`.
export const USER_COLS_NO_HASH =
  'username,name,email,mobile,contact,contact_type,status,created_at,approved_at,role,trial_expires_at,payment_status,permanent_access,access_type,access_expires_at,session_token,session_token_expires_at,email_verified';

/** `withHash: true` only for the few handlers that verify or compare the password hash. */
export async function authUser(params: Record<string, unknown>, opts: { withHash?: boolean } = {}) {
  const username = String(params.username || '').trim();
  const errResp = { success: false, error: 'Session expired. Please log in again.', sessionInvalid: true };
  if (!username) return { ok: false as const, error: { success: false, error: 'Username required.' } };

  const { data } = await supabase.from('users').select(opts.withHash ? '*' : USER_COLS_NO_HASH).eq('username', username).limit(1);
  const user = data && data[0] ? data[0] : null;
  if (!user) return { ok: false as const, error: errResp };
  // A rejected account may not keep using a session that was issued before it was rejected.
  if (String(user.status || '') === 'rejected') return { ok: false as const, error: errResp };

  const token = String(params.token || '');
  if (!token || !(await tokenMatches(String(user.session_token || ''), token))) return { ok: false as const, error: errResp };
  const expires = Number(user.session_token_expires_at || 0);
  if (!expires || Date.now() > expires) return { ok: false as const, error: errResp };

  return { ok: true as const, username: String(user.username), user };
}

export const MUST_CHANGE_RESPONSE = {
  success: false,
  error: 'You must change the default password before using the admin console.',
  mustChangePassword: true,
};

/**
 * Authenticates an admin token.
 *  - featureKey: permission required (owner always passes).
 *  - opts.allowMustChange: only adminchangepassword sets this. Every other
 *    admin action is refused while must_change_password is set.
 *  - opts.ownerOnly: the caller must hold the owner role.
 */
export async function authAdmin(
  params: Record<string, unknown>,
  featureKey?: string,
  opts: { allowMustChange?: boolean; ownerOnly?: boolean } = {},
) {
  const username = String(params.username || '').trim();
  const token = String(params.token || params.adminToken || '');
  const errResp = { success: false, error: 'Admin session expired.', sessionInvalid: true };
  if (!username || !token) return { ok: false as const, error: errResp };

  const { data } = await supabase.from('admins').select('*').eq('username', username).limit(1);
  const admin = data && data[0] ? data[0] as Record<string, unknown> : null;
  if (!admin || !(await tokenMatches(String(admin.token || ''), token))) return { ok: false as const, error: errResp };

  const expires = Number(admin.token_expires || 0);
  if (!expires || Date.now() > expires) return { ok: false as const, error: errResp };

  const isOwner = String(admin.role || '').toLowerCase() === 'owner';
  const mustChange = admin.must_change_password === true || String(admin.must_change_password).toLowerCase() === 'true';
  if (mustChange && !opts.allowMustChange) return { ok: false as const, error: { ...MUST_CHANGE_RESPONSE } };

  if (opts.ownerOnly && !isOwner) {
    return { ok: false as const, error: { success: false, error: 'Only the owner can do this.', forbidden: true, ownerOnly: true } };
  }
  if (isOwner || !featureKey) return { ok: true as const, username, admin };

  const { data: perms } = await supabase.from('admin_permissions').select('feature_key,enabled').eq('username', username);
  const enabled = (perms || []).some((p: any) => p.feature_key === featureKey && String(p.enabled).toLowerCase() === 'true');
  if (!enabled) return { ok: false as const, error: { success: false, error: 'No permission: ' + featureKey, forbidden: true } };

  return { ok: true as const, username, admin };
}

export async function findUserByIdentifier(identifier: string) {
  const id = identifier.trim();
  if (!id) return null;

  if (id.includes('@')) {
    const { data } = await supabase.from('users').select('*').ilike('email', escLike(id)).limit(1);
    return data && data[0] ? data[0] : null;
  }
  if (/^(98|97|96|99)\d{8}$/.test(id)) {
    const { data } = await supabase.from('users').select('*').eq('mobile', id).limit(1);
    return data && data[0] ? data[0] : null;
  }

  // Usernames are typed by hand, so accept a different case after an exact
  // match. Only use the case-insensitive hit when it is unique: two accounts
  // that differ only by case must never log into each other's account.
  const exact = await supabase.from('users').select('*').eq('username', id).limit(1);
  if (exact.data && exact.data[0]) return exact.data[0];
  const { data } = await supabase.from('users').select('*').ilike('username', escLike(id)).limit(2);
  return data && data.length === 1 ? data[0] : null;
}

export function requireAccess(auth: { ok: true; username: string; user: Record<string, unknown> }) {
  const access = computeAccess(auth.user);
  if (access.level === 'permanent' || access.level === 'trial') return null;
  return { success: false, needsPayment: true, error: 'Your access has expired. Please complete payment to continue.' };
}