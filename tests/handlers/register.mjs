import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
// DEFAULT_OWNER_PASSWORD is a test fixture: the backend itself has no default and
// refuses to create the owner without the secret (see owner-bootstrap.test.mjs).
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k', DEFAULT_OWNER_PASSWORD: 'abhyas' }[k] ?? process.env[k]) }, serve() {} };
