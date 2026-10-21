import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }[k] ?? process.env[k]) }, serve() {} };
