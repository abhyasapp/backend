// scripts/check-syntax.mjs — fast syntax gate for every backend source file (no network, no deploy).
//   * sync.js and every Apps Script .gs  → parsed by V8
//   * every Edge Function .ts            → parsed by the TypeScript compiler (syntax only)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = (dir, ext) => fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));
let bad = 0, n = 0;

for (const f of [path.join(root, 'scripts/sync.js'), ...files(path.join(root, 'gas'), '.gs')]) {
  n++;
  try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); }
  catch (e) { bad++; console.error('SYNTAX', path.relative(root, f), '-', e.message); }
}

let ts;
try { ts = createRequire(import.meta.url)('typescript'); } catch { console.warn('typescript not installed - skipping .ts (run npm install)'); }
if (ts) {
  for (const f of files(path.join(root, 'supabase/functions'), '.ts')) {
    n++;
    const out = ts.transpileModule(fs.readFileSync(f, 'utf8'), { reportDiagnostics: true, compilerOptions: { target: 'ES2022', module: 'ESNext' }, fileName: f });
    for (const d of out.diagnostics || []) { bad++; console.error('SYNTAX', path.relative(root, f), '-', ts.flattenDiagnosticMessageText(d.messageText, ' ')); }
  }
}
console.log(`${n} backend files checked, ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
