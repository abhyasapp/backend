// _shared/config.ts — shared constants for every handler in the API function.

export const FUNCTION_VERSION = '1.63';

// Origin allow-list (also used by withCors in index.ts). Override in the
// Supabase dashboard → Project Settings → Edge Functions → Secrets.
export const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ||
  'https://app.mku.name.np,https://abhyasapp.github.io,http://localhost:5500,http://127.0.0.1:5500')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Token lifetimes
export const USER_TOKEN_TTL_MS  = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;         // 24 hours

// Password hashing
export const PW_ITERATIONS = 600000;   // PBKDF2-HMAC-SHA256 iterations

// ── Owner / admin model ────────────────────────────────────────────────
// The owner account is created lazily on the first admin login when no owner
// exists yet. It starts with DEFAULT_OWNER_PASSWORD (default: "abhyas") and is
// flagged must_change_password, so nothing except changing the password works
// until the owner picks a new one.
// For safety set DEFAULT_OWNER_PASSWORD to a private value before the first
// login:  supabase secrets set DEFAULT_OWNER_PASSWORD=<private>
export const DEFAULT_OWNER_USERNAME = (Deno.env.get('DEFAULT_OWNER_USERNAME') || 'admin').trim().toLowerCase();
export const DEFAULT_OWNER_PASSWORD = Deno.env.get('DEFAULT_OWNER_PASSWORD') || 'abhyas';
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;
export const RESERVED_USERNAMES = ['admin', 'administrator', 'root', 'owner', 'system', 'support', 'abhyas'];

// Features that only the owner may use. They can never be granted to a normal
// admin (they are stripped from any permission set).
export const OWNER_ONLY_FEATURES = ['admins_view', 'admins_manage'];

// getfile/getfiles used to return only `content`; the quiz engine reads
// `result`. While this is not 'false' both are returned (legacy clients keep
// working). Set FILE_LEGACY_CONTENT=false once every client reads `result`.
export const FILE_LEGACY_CONTENT = (Deno.env.get('FILE_LEGACY_CONTENT') || 'true').toLowerCase() !== 'false';

// Progress history archiving
export const PROGRESS_HISTORY_MIN_GAP_MS = 30 * 60 * 1000;   // 30 minutes
export const PROGRESS_GZ_PREFIX = 'gz1:';

// Weekly test window
export const WEEKLY_EXAM_WINDOW_MS = 12 * 60 * 60 * 1000;    // 12 hours

// Corrections map (in settings table, hidden behind private_ prefix)
export const CORRECTIONS_SETTING_KEY = 'private_corrections';
export const MAX_CORRECTIONS_KEPT = 400;

// Payment screenshot extensions accepted on upload (magic-byte detection
// in crypto.ts decides the actual mime type — this list only gates the
// final file extension).
export const PAY_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif'];

// Admin capability list. Every admin action maps to one of these keys;
// the owner account implicitly has all of them (see authAdmin() in
// _shared/auth.ts).
export const ADMIN_FEATURE_KEYS = [
  'dashboard',
  'users_view', 'users_manage', 'users_bulk',
  'payments_view', 'payments_review', 'payments_bulk', 'screenshots',
  'weeklysets_view', 'weeklysets_manage',
  'studydocs_view', 'studydocs_manage',
  'qreports_view', 'qreports_manage',
  'subjective_view', 'subjective_grade', 'subjective_import',
  'logs_view',
  'settings_view', 'settings_manage',
  'admins_view', 'admins_manage',
  'maintenance', 'exports', 'imports'
];