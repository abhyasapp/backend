import { supabase } from './db.ts';
import { PROGRESS_HISTORY_MIN_GAP_MS, CORRECTIONS_SETTING_KEY, MAX_CORRECTIONS_KEPT } from './config.ts';

// ── progress ───────────────────────────────────────────────────────
export function sameRevision(a: unknown, b: unknown): boolean {
  return Math.abs(revMs(a) - revMs(b)) < 1000;
}
export function revMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = new Date(String(v == null ? '' : v)).getTime();
  return isNaN(t) ? 0 : t;
}
export function isAcceptableProgressData(dataStr: string): boolean {
  if (!dataStr) return false;
  if (dataStr.startsWith('gz1:')) return dataStr.length > 24 && /^gz1:[A-Za-z0-9+/]+={0,2}$/.test(dataStr);
  try { JSON.parse(dataStr); return true; } catch { return false; }
}
export async function archivePreviousProgress(username: string, prevData: string, prevAt: string, newData: string): Promise<void> {
  try {
    const prevMs = new Date(prevAt).getTime() || Date.now();
    const { data } = await supabase.from('progress_history').select('*').eq('username', username).limit(1);
    const row = data && data[0] ? data[0] as Record<string, unknown> : null;
    const slots: [string, string][] = row
      ? [[String(row.data1 || ''), String(row.saved_at1 || '')],
         [String(row.data2 || ''), String(row.saved_at2 || '')],
         [String(row.data3 || ''), String(row.saved_at3 || '')]]
      : [['', ''], ['', ''], ['', '']];
    const newestMs = slots[0][1] ? (new Date(slots[0][1]).getTime() || 0) : 0;
    const shouldArchive = (prevData.length >= 50) && (newData !== prevData) && (!slots[0][0] || (prevMs - newestMs >= PROGRESS_HISTORY_MIN_GAP_MS));
    if (!shouldArchive) return;
    const next = [[String(prevData), new Date(prevMs).toISOString()], slots[0], slots[1]];
    const rowVals = {
      username,
      data1: next[0][0], saved_at1: next[0][1],
      data2: next[1][0], saved_at2: next[1][1],
      data3: next[2][0], saved_at3: next[2][1],
    };
    if (row) await supabase.from('progress_history').update(rowVals).eq('username', username);
    else await supabase.from('progress_history').insert(rowVals);
  } catch { /* ignore */ }
}
export async function markFileCorrected(fileId: string): Promise<void> {
  if (!fileId) return;
  const now = Date.now();
  const { data: row } = await supabase.from('settings').select('value').eq('key', CORRECTIONS_SETTING_KEY).limit(1);
  let map: Record<string, number> = {};
  if (row && row[0]) { try { map = JSON.parse(String(row[0].value || '{}')); } catch { /* ignore */ } }
  map[fileId] = now;
  const keys = Object.keys(map);
  if (keys.length > MAX_CORRECTIONS_KEPT) {
    keys.sort((a, b) => map[a] - map[b]).slice(0, keys.length - MAX_CORRECTIONS_KEPT).forEach(k => delete map[k]);
  }
  const value = JSON.stringify(map);
  if (row && row[0]) await supabase.from('settings').update({ value }).eq('key', CORRECTIONS_SETTING_KEY);
  else await supabase.from('settings').insert({ key: CORRECTIONS_SETTING_KEY, value });
}

// ── storage path validation ────────────────────────────────────────
export function safeStoragePath(p: string): boolean {
  return !!p && p.length <= 300 && !p.includes('..') && !p.startsWith('/') &&
    !p.includes('\\') && !/[\u0000-\u001f]/.test(p);
}
export function ownedUploadPath(p: string, username: string, exts: string[]): boolean {
  if (!safeStoragePath(p)) return false;
  const parts = p.split('/');
  if (parts.length !== 2 || parts[0] !== username) return false;
  return new RegExp('^[A-Za-z0-9_-]+\\.(' + exts.join('|') + ')$').test(parts[1]);
}
export function isStoragePath(v: string): boolean {
  return !!v && v.includes('/') && !/^https?:\/\//i.test(v);
}

// ── weekly helpers (ported from monolith) ──────────────────────────
export function weeklyMarks(correct: number, skipped: number, total: number) {
  const t = Math.max(0, Number(total) || 0);
  const c = Math.max(0, Math.min(t, Number(correct) || 0));
  const sk = Math.max(0, Number(skipped) || 0);
  const wrong = Math.max(0, t - c - sk);
  const marks = c - wrong * 0.2;
  return {
    wrong,
    marks: Math.round(marks * 10) / 10,
    pct: t ? Math.max(0, Math.round((marks / t) * 1000) / 10) : 0,
    exactPct: t ? (marks / t) * 100 : 0,
  };
}

export function rowToWeeklyAttempt(row: Record<string, unknown>) {
  let answers: unknown[] = [];
  try { answers = JSON.parse(String(row.answers_json || '[]')); } catch { /* ignore */ }
  const total = Number(row.total_questions || 0);
  const correct = Number(row.correct_claimed || 0);
  const skipped = Number(row.skipped_count || 0);
  return {
    weeklyId: String(row.weekly_id || ''),
    answers,
    total,
    correct,
    pct: weeklyMarks(correct, skipped, total).pct,
    skipped,
    startedAt: Number(row.started_at || 0),
    submittedAt: Number(row.submitted_at || 0),
    durationSec: Number(row.duration_sec || 0),
    synced: true,
  };
}

export function rowToWeeklySet(row: Record<string, unknown>) {
  return {
    id: String(row.id || ''),
    title: String(row.title || ''),
    fileId: String(row.file_id || ''),
    chapterLabel: String(row.chapter_label || ''),
    status: String(row.status || 'active'),
    uploadedBy: String(row.uploaded_by || ''),
    uploadedAt: String(row.uploaded_at || ''),
    releaseAt: String(row.release_at || ''),
  };
}

export function extractCorrectAnswers(raw: unknown): (number | string | undefined)[] | null {
  let qs: unknown[] = [];
  if (Array.isArray(raw)) qs = raw;
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    qs = (o.questions || o.data || o.quiz || o.items || []) as unknown[];
    if ((!Array.isArray(qs) || !qs.length) && Array.isArray(o.sections)) {
      qs = (o.sections as Array<Record<string, unknown>>)
        .reduce((acc: unknown[], s) => acc.concat(Array.isArray(s?.questions) ? s.questions : []), []);
    }
  }
  if (!Array.isArray(qs)) return null;
  return qs.map(q => {
    if (!q || typeof q !== 'object') return undefined;
    const o = q as Record<string, unknown>;
    let c: unknown = o.correct !== undefined ? o.correct
      : o.answer !== undefined ? o.answer
      : o.ans    !== undefined ? o.ans
      : o.Answer;
    if (typeof c === 'string' && /^[a-eA-E]$/.test(c.trim())) {
      c = 'abcde'.indexOf(c.trim().toLowerCase());
    }
    return c as number | string | undefined;
  });
}

export function scoreAnswers(answers: (number | null)[], key: (number | string | undefined)[]): number {
  let correct = 0;
  answers.forEach((a, i) => {
    if (a === null) return;
    const expected = key[i];
    if ((typeof expected === 'number' && a === expected) ||
        (typeof expected === 'string' && String(a) === expected)) correct++;
  });
  return correct;
}