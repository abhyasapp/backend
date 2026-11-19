// scripts/schema-census.mjs — which columns does the Edge Function really touch, per table?
// Used by tests/schema.test.mjs so the SQL migration can never drift from the TypeScript.
import fs from 'node:fs';
import path from 'node:path';

const KW = new Set(['true', 'false', 'null', 'undefined', 'ascending', 'onConflict', 'count', 'head',
  'returning', 'ignoreDuplicates', 'contentType', 'upsert', 'cacheControl', 'success', 'error']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

export function census(functionDir) {
  const cols = {};
  const add = (t, c) => { (cols[t] ||= new Set()).add(c); };
  for (const file of walk(functionDir)) {
    const s = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
    for (const m of s.matchAll(/from\('([a-z_]+)'\)/g)) {
      const t = m[1];
      if (s.slice(Math.max(0, m.index - 9), m.index).endsWith('storage.')) continue;   // storage bucket, not a table
      // the statement runs to the first ';' at bracket depth 0
      let depth = 0, k = m.index + m[0].length;
      const stop = Math.min(s.length, k + 1500);
      for (; k < stop; k++) {
        const c = s[k];
        if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; else if (c === ';' && depth <= 0) break;
      }
      const stmt = s.slice(m.index + m[0].length, k);
      for (const sel of stmt.matchAll(/\.select\('([^']*)'/g))
        for (let c of sel[1].split(',')) { c = c.trim(); if (c && c !== '*' && /^[a-z_]+$/.test(c)) add(t, c); }
      for (const fn of ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'is', 'in', 'order', 'contains', 'not'])
        for (const c of stmt.matchAll(new RegExp('\\.' + fn + "\\('([a-z_]+)'", 'g'))) add(t, c[1]);
      for (const op of ['insert', 'update', 'upsert'])
        for (const mm of stmt.matchAll(new RegExp('\\.' + op + '\\(', 'g'))) {
          let d = 0, b = mm.index + mm[0].length;
          const a = b;
          for (; b < stmt.length; b++) { const c = stmt[b]; if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { d--; if (d < 0) break; } }
          let buf = ''; d = 0;
          for (const ch of stmt.slice(a, b)) { if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) d--; buf += d <= 1 ? ch : ' '; }
          // A bare variable as the row argument (`.upsert(part, {...})`) carries no literal
          // keys to read: drop it instead of mistaking the identifier for a column. Those writes
          // are checked against the real schema by tests/handlers/qid-core.test.mjs instead.
          buf = buf.replace(/^\s*[A-Za-z_][\w.]*\s*(?=,|$)/, '');
          for (const key of buf.matchAll(/(?:^|[{,]\s*)([a-z][a-z_0-9]*)\s*(?=[:,}])/g)) if (!KW.has(key[1])) add(t, key[1]);
        }
    }
  }
  return Object.fromEntries(Object.entries(cols).map(([t, v]) => [t, [...v].sort()]));
}

/** Column headers of each sheet, read from gas/code.gs (e.g. USER_HEADERS = [...]). */
export function gasHeaders(codeGsPath) {
  const s = fs.readFileSync(codeGsPath, 'utf8').replace(/\r/g, '');
  const out = {};
  for (const m of s.matchAll(/(?:const|var|let)\s+([A-Z_]+_HEADERS)\s*=\s*\[(.*?)\];/gs))
    out[m[1]] = [...m[2].matchAll(/["']([A-Za-z0-9_]+)["']/g)].map((x) => x[1]);
  return out;
}
