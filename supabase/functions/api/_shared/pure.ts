// _shared/pure.ts — dependency-free helpers (no Supabase/Deno imports) so they
// can be unit-tested with `node --test` or `deno test` (see pure.test.ts).

/** Decides what a user may access. Fails CLOSED: a trial without a valid expiry is expired. */
export function computeAccess(user: Record<string, unknown>, nowMs: number = Date.now()) {
  const status = String(user.status || "");
  const permanent = user.permanent_access === true || String(user.permanent_access) === "true";
  const accessType = String(user.access_type || "");
  const expiresAt = user.access_expires_at ? new Date(String(user.access_expires_at)) : null;
  const now = new Date(nowMs);
  if (permanent || status === "active") {
    if (accessType === "yearly" && expiresAt && !isNaN(expiresAt.getTime()) && now > expiresAt) return { level: "expired" };
    return { level: "permanent", accessType: accessType || "permanent", accessExpiresAt: user.access_expires_at || "" };
  }
  if (status === "trial") {
    const t = user.trial_expires_at ? new Date(String(user.trial_expires_at)) : null;
    if (t && !isNaN(t.getTime()) && now <= t) return { level: "trial", trialExpiresAt: user.trial_expires_at || "" };
    return { level: "expired" };
  }
  if (status === "payment_pending") return { level: "pending_review" };
  return { level: "expired" };
}

/** Split an array into chunks (PostgREST `.in()` filters go in the URL, so keep them short). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += Math.max(1, size)) out.push(arr.slice(i, i + size));
  return out;
}

/** YYYY-MM-DD in Asia/Kathmandu (the app timezone) for an epoch-ms value. */
const KTM = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu", year: "numeric", month: "2-digit", day: "2-digit" });
export function kathmanduDay(ms: number): string { return KTM.format(new Date(ms)); }

/** Parse ISO strings AND numeric epoch-ms strings/numbers. Returns 0 when unparseable. */
export function toMs(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = new Date(s).getTime();
  return isNaN(t) ? 0 : t;
}

// `explain` is what the published content files use for the explanation; the
// others are older spellings. Missing it leaked the reason during exam windows.
const ANSWER_KEYS = ["correct", "correctIndex", "answer", "ans", "Answer", "explanation", "exp", "explain"];
const OPTION_FLAGS = ["correct", "isCorrect"];

function stripQuestion(q: unknown): unknown {
  if (!q || typeof q !== "object" || Array.isArray(q)) return q;
  const o: Record<string, unknown> = { ...(q as Record<string, unknown>) };
  for (const k of ANSWER_KEYS) delete o[k];
  for (const key of ["options", "opts"]) {
    if (Array.isArray(o[key])) {
      o[key] = (o[key] as unknown[]).map((opt) => {
        if (!opt || typeof opt !== "object" || Array.isArray(opt)) return opt;
        const c: Record<string, unknown> = { ...(opt as Record<string, unknown>) };
        for (const f of OPTION_FLAGS) delete c[f];
        return c;
      });
    }
  }
  return o;
}

/** Returns a copy of a quiz file with correct answers and explanations removed. */
export function stripAnswers(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(stripQuestion);
  if (!raw || typeof raw !== "object") return raw;
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of ["questions", "data", "quiz", "items"]) {
    if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).map(stripQuestion);
  }
  if (Array.isArray(o.sections)) {
    o.sections = (o.sections as unknown[]).map((s) => {
      if (!s || typeof s !== "object") return s;
      const sec = { ...(s as Record<string, unknown>) };
      if (Array.isArray(sec.questions)) sec.questions = (sec.questions as unknown[]).map(stripQuestion);
      return sec;
    });
  }
  return o;
}

/** A path is unsafe if any SEGMENT is "." or ".." (consecutive dots inside a name are fine). */
export function hasTraversalSegment(p: string): boolean {
  return p.split("/").some((seg) => seg === ".." || seg === ".");
}
