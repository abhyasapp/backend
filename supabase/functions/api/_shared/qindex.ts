// _shared/qindex.ts — the question registry (public.question_index).
//
// The registry maps qid → (file, derived position, revision, kind, status,
// canonical redirect). It is *populated* from content (whenever a file is read
// for a weekly set, a correction, or pushed by the pipeline) and *consulted*
// to (a) resolve merged/retired qids to their canonical qid and (b) answer
// "what question is this legacy uid" for old clients. Position (`ord`) is
// informational: nothing keys on it.

import { supabase } from './db.ts';
import { chunk } from './pure.ts';
import { buildQidIndex, resolveCanonical, qidString } from './qid.ts';

/** Upsert the registry rows of one file. Never touches status / canonical_qid,
 *  so a merge/retire decision survives a re-index. Best-effort: a registry
 *  failure must never fail the request that triggered it. */
export async function registerFileIndex(fileId: string, raw: unknown): Promise<number> {
  try {
    const rows = buildQidIndex(raw);
    if (!rows.length || !fileId) return 0;
    const now = new Date().toISOString();
    for (const part of chunk(rows, 400)) {
      const { error } = await supabase.from('question_index').upsert(
        part.map(r => ({ qid: r.qid, file_id: fileId, ord: String(r.ord), rev: r.rev, kind: r.kind, updated_at: now })),
        { onConflict: 'qid' },
      );
      if (error) return 0;
    }
    return rows.length;
  } catch { return 0; }
}

/** qid → canonical qid for every id given (merged/retired ids redirect).
 *  Ids with no redirect map to themselves. */
export async function canonicalMap(qids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let frontier = [...new Set(qids.map(qidString).filter(Boolean))];
  frontier.forEach(q => out.set(q, q));
  const aliases = new Map<string, string>();
  try {
    for (let hop = 0; hop < 4 && frontier.length; hop++) {
      const next: string[] = [];
      for (const part of chunk(frontier, 200)) {
        const { data } = await supabase.from('question_index').select('qid,canonical_qid').in('qid', part);
        for (const r of data || []) {
          const c = qidString(r.canonical_qid);
          if (c && c !== r.qid) { aliases.set(String(r.qid), c); if (!aliases.has(c)) next.push(c); }
        }
      }
      frontier = [...new Set(next)];
    }
  } catch { /* registry unavailable → identity mapping */ }
  for (const q of qids.map(qidString).filter(Boolean)) out.set(q, resolveCanonical(q, aliases));
  return out;
}

/** Legacy bridge: which qid sits at (file, position) right now? Used only to
 *  attach a qid to a request from an old client that sent just the positional
 *  uid. Best effort — the result is flagged as position-derived by callers. */
export async function qidAtPosition(fileId: string, ord: number): Promise<string> {
  try {
    if (!fileId || !Number.isInteger(ord) || ord < 0) return '';
    const { data } = await supabase.from('question_index').select('qid')
      .eq('file_id', fileId).eq('ord', String(ord)).eq('status', 'active').limit(2);
    return data && data.length === 1 ? qidString(data[0].qid) : '';
  } catch { return ''; }
}
