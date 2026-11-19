#!/usr/bin/env node
// scripts/push-question-index.mjs — the Neon → Supabase AND Apps Script bridge for the question registry.
//
// The registry maps qid → (file, derived position, revision, kind, status, canonical redirect). Content
// files seed it; a Neon export carries decisions only Neon knows (a question merged into another,
// retired, …). This pushes both to BOTH backends with the same sync key, so a merge decided in Neon
// reaches students whichever backend serves them:
//
//   node scripts/push-question-index.mjs \
//        --content ./content                # a directory of published question JSON files (optional)
//        --rows neon-export.json            # [{qid, fileId?, status?, canonicalQid?}] (optional)
//        --supabase https://<ref>.supabase.co/functions/v1/api \
//        --gas https://script.google.com/macros/s/<id>/exec \
//        [--dry-run]
//
// Key: env ABHYAS_SYNC_KEY. Revisions are computed with the same code both backends use
// (supabase/functions/api/_shared/qid.ts), so they always match what each backend derives itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildQidIndex } from '../supabase/functions/api/_shared/qid.ts';

/** Registry rows for every question in every *.json file under `dir` (file id = file name sans .json). */
export function rowsFromContent(dir) {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }   // a bad file never blocks the rest
    const fileId = f.replace(/\.json$/, '');
    for (const r of buildQidIndex(raw)) rows.push({ qid: r.qid, fileId, ord: r.ord, rev: r.rev });
  }
  return rows;
}

/** Content rows first, then Neon decisions layered on top of the same qid (status / canonicalQid win). */
export function mergeRows(contentRows, neonRows) {
  const by = new Map();
  for (const r of contentRows) by.set(String(r.qid), { ...r });
  for (const r of neonRows || []) {
    const k = String(r.qid);
    by.set(k, { ...(by.get(k) || {}), ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v !== null && v !== '')) });
  }
  return [...by.values()];
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), redirect: 'follow' });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { success: false, error: `non-JSON response (HTTP ${res.status})` }; }
}

async function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const key = process.env.ABHYAS_SYNC_KEY || '';
  const targets = [['supabase', arg('--supabase')], ['apps-script', arg('--gas')]].filter(([, u]) => u);
  if (!key || !targets.length) { console.error('Set ABHYAS_SYNC_KEY and pass --supabase and/or --gas.'); process.exit(2); }
  const content = arg('--content') ? rowsFromContent(arg('--content')) : [];
  const neon = arg('--rows') ? JSON.parse(fs.readFileSync(arg('--rows'), 'utf8')) : [];
  const rows = mergeRows(content, neon);
  console.log(`${rows.length} registry rows (${content.length} from content, ${neon.length} from Neon)`);
  if (argv.includes('--dry-run')) return;
  let failed = false;
  for (const [name, url] of targets) {
    let upserted = 0, rejected = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      const r = await post(url, { action: 'ingestquestionindex', key, rows: rows.slice(i, i + 1000) });
      if (!r.success) { console.error(`${name}: ${r.error || 'failed'}`); failed = true; break; }
      upserted += r.upserted; rejected += (r.rejected || []).length;
    }
    console.log(`${name}: upserted ${upserted}, rejected ${rejected}`);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
