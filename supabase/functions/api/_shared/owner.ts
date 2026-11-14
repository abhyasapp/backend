// _shared/owner.ts — owner/admin model helpers: default-owner bootstrap,
// password policy, audit log, owner counting.

import { supabase } from './db.ts';
import { makeStoredHash } from './crypto.ts';
import {
  DEFAULT_OWNER_USERNAME, DEFAULT_OWNER_PASSWORD,
  MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, RESERVED_USERNAMES,
  ADMIN_FEATURE_KEYS, OWNER_ONLY_FEATURES,
} from './config.ts';

const COMMON_PASSWORDS = [
  '12345678', '123456789', '1234567890', 'password', 'password1', 'password123',
  'qwerty123', 'qwertyuiop', '11111111', '00000000', '12341234', 'abcd1234',
  'iloveyou', 'admin123', 'letmein1', 'abhyas123', 'loksewa123', 'nepal123',
  '987654321', 'asdfghjkl', '1q2w3e4r', 'q1w2e3r4', 'changeme123!',
];

export function truthy(v: unknown): boolean {
  return v === true || String(v).toLowerCase() === 'true';
}

export function isOwnerRow(admin: Record<string, unknown> | null | undefined): boolean {
  return !!admin && String(admin.role || '').toLowerCase() === 'owner';
}

export function isReservedUsername(u: string): boolean {
  return RESERVED_USERNAMES.includes(String(u || '').trim().toLowerCase());
}

/** Returns an error message, or '' when the password is acceptable. */
export function passwordProblem(password: string, username = '', currentPassword = ''): string {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > MAX_PASSWORD_LENGTH) return 'Password is too long.';
  const low = pw.toLowerCase();
  if (COMMON_PASSWORDS.includes(low) || /^(.)\1+$/.test(pw)) return 'That password is too easy to guess. Choose something less common.';
  if (low === DEFAULT_OWNER_PASSWORD.toLowerCase()) return "Choose a password that isn't the default one.";
  if (username && username.length >= 4 && low.includes(username.toLowerCase())) return "Your password shouldn't contain your username.";
  if (currentPassword && pw === currentPassword) return 'New password must be different from the current one.';
  return '';
}

/** Random one-time password shown once to the owner after a reset. */
export function generateTempPassword(): string {
  const a = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const b = crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
  return `${a}-${b}`;
}

export async function writeAuditLog(adminName: string, action: string, target: string, details = ''): Promise<void> {
  try {
    const { error } = await supabase.from('logs').insert({
      timestamp: new Date().toISOString(),
      admin: adminName, action, target, details: String(details).slice(0, 2000),
    });
    if (error) console.error('[audit] log insert failed:', action, error.message);
  } catch { /* non-fatal */ }
}

export async function countOwners(): Promise<number> {
  const { count } = await supabase.from('admins').select('*', { count: 'exact', head: true }).eq('role', 'owner');
  return count || 0;
}

let ownerKnownToExist = false;

/**
 * Creates the default owner (admin / DEFAULT_OWNER_PASSWORD) when NO owner
 * exists yet. The account is flagged must_change_password. Safe to call on
 * every admin login: it is a no-op once an owner exists, and a concurrent
 * insert loses harmlessly on the primary key.
 */
export async function ensureDefaultOwner(): Promise<void> {
  if (ownerKnownToExist) return;
  try {
    if ((await countOwners()) > 0) { ownerKnownToExist = true; return; }

    const { data: existing } = await supabase.from('admins').select('username,role')
      .eq('username', DEFAULT_OWNER_USERNAME).limit(1);
    if (existing && existing[0]) {
      // An admin already holds the default username but nobody is owner:
      // repair the situation by promoting that account and forcing a change.
      await supabase.from('admins').update({ role: 'owner', must_change_password: true })
        .eq('username', DEFAULT_OWNER_USERNAME);
      await writeAuditLog('system', 'Owner Repaired', DEFAULT_OWNER_USERNAME, 'No owner existed; promoted default admin.');
      ownerKnownToExist = true;
      return;
    }

    const { error } = await supabase.from('admins').insert({
      username: DEFAULT_OWNER_USERNAME,
      pass_hash: await makeStoredHash(DEFAULT_OWNER_PASSWORD),
      created_at: new Date().toISOString(),
      created_by: 'system',
      token: '', token_expires: '',
      role: 'owner',
      must_change_password: true,
    });
    if (error && error.code !== '23505') console.error('[owner] default owner insert failed:', error.message);
    else if (!error) await writeAuditLog('system', 'Default Owner Created', DEFAULT_OWNER_USERNAME, 'Created on first admin login; password change is mandatory.');
    if (!error || error.code === '23505') ownerKnownToExist = true;
  } catch (e) {
    console.error('[owner] ensureDefaultOwner failed:', e);
  }
}

/** Keeps only valid, grantable (non-owner-only) feature keys that are truthy. */
export function grantableFeatures(input: unknown): string[] {
  let features: Record<string, unknown> = {};
  if (input && typeof input === 'object') features = input as Record<string, unknown>;
  else if (typeof input === 'string' && input.trim()) { try { features = JSON.parse(input); } catch { features = {}; } }
  if (Array.isArray(features)) {
    const o: Record<string, unknown> = {};
    (features as unknown[]).forEach((k) => { o[String(k)] = true; });
    features = o;
  }
  return Object.keys(features).filter((k) =>
    ADMIN_FEATURE_KEYS.includes(k) && !OWNER_ONLY_FEATURES.includes(k) && truthy(features[k]));
}
