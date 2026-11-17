import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
// No DEFAULT_OWNER_PASSWORD on purpose: proves the backend refuses to bootstrap a
// known-password owner instead of falling back to one written in the source.
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }[k] ?? process.env[k]) }, serve() {} };
