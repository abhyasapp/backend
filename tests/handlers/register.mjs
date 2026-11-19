import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
// DEFAULT_OWNER_PASSWORD is an explicit fixture, never a value the backend ships.
// The suite that proves a missing secret refuses to bootstrap an owner uses
// register-no-owner-password.mjs instead of this file.
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k', DEFAULT_OWNER_PASSWORD: 'abhyas' }[k] ?? process.env[k]) }, serve() {} };
