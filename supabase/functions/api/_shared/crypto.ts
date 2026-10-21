import { PW_ITERATIONS } from './config.ts';

const enc = new TextEncoder();

export function randId(): string { return crypto.randomUUID().replace(/-/g, '').slice(0, 12); }
export function lockedHash(): string { return 'locked:' + crypto.randomUUID() + crypto.randomUUID(); }
export function makeSalt(): string { return crypto.randomUUID().replace(/-/g, ''); }

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}

export function safeEqual(a: string, b: string): boolean {
  const A = enc.encode(a), B = enc.encode(b);
  if (A.length !== B.length) return false;
  let d = 0;
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i];
  return d === 0;
}

export async function makeStoredHash(password: string): Promise<string> {
  const salt = makeSalt();
  return `p2:${PW_ITERATIONS}:${salt}:${await pbkdf2(password, salt, PW_ITERATIONS)}`;
}

export async function tokenHash(token: string): Promise<string> { return 'h:' + await sha256Hex(token); }
export async function tokenMatches(stored: string, token: string): Promise<boolean> {
  if (!stored || !token || !stored.startsWith('h:')) return false;
  return safeEqual(stored, await tokenHash(token));
}

export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; upgraded?: string }> {
  if (!stored) return { ok: false };
  if (stored.startsWith('p2:')) {
    const parts = stored.split(':');
    if (parts.length !== 4) return { ok: false };
    const iters = parseInt(parts[1], 10);
    if (!(iters >= 1 && iters <= 1000000)) return { ok: false };
    const got = await pbkdf2(password, parts[2], iters);
    if (!safeEqual(got, parts[3])) return { ok: false };
    return iters < PW_ITERATIONS ? { ok: true, upgraded: await makeStoredHash(password) } : { ok: true };
  }
  const sep = stored.indexOf(':');
  if (sep === -1) {
    if (safeEqual(await sha256Hex(password), stored)) return { ok: true, upgraded: await makeStoredHash(password) };
    return { ok: false };
  }
  if (safeEqual(await sha256Hex(stored.slice(0, sep) + password), stored.slice(sep + 1))) {
    return { ok: true, upgraded: await makeStoredHash(password) };
  }
  return { ok: false };
}

// ── binary helpers (used by payments + subjective uploads) ───────────
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length > 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export function detectImageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes.length < 12) return null;
  const b = (i: number) => bytes[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return { mime: 'image/gif', ext: 'gif' };
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}