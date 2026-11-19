import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rowsFromContent, mergeRows } from '../scripts/push-question-index.mjs';
import { buildQidIndex } from '../supabase/functions/api/_shared/qid.ts';

test('registry rows come from content files, with the revision both backends compute', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qidx-'));
  const f1 = { questions: [{ id: 101, q: 'one', options: ['a', 'b'], correct: 0 }, { id: 102, q: 'two', options: ['a', 'b'], correct: 1 }] };
  fs.writeFileSync(path.join(dir, 'chapterA.json'), JSON.stringify(f1));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const rows = rowsFromContent(dir);
  assert.deepEqual(rows.map((r) => [r.qid, r.fileId, r.ord]), [['101', 'chapterA', 0], ['102', 'chapterA', 1]]);
  assert.deepEqual(rows.map((r) => r.rev), buildQidIndex(f1).map((r) => r.rev));     // identical to what each backend derives itself
});

test("Neon's decisions are layered over content rows; empty values never erase content facts", () => {
  const content = [{ qid: '101', fileId: 'A', ord: 0, rev: 'r1' }, { qid: '102', fileId: 'A', ord: 1, rev: 'r2' }];
  const neon = [{ qid: 101, status: 'merged', canonicalQid: 102, fileId: '' }, { qid: 555, status: 'retired', fileId: 'B' }];
  const out = Object.fromEntries(mergeRows(content, neon).map((r) => [r.qid, r]));
  assert.deepEqual(out['101'], { qid: 101, fileId: 'A', ord: 0, rev: 'r1', status: 'merged', canonicalQid: 102 });
  assert.equal(out['102'].status, undefined);
  assert.equal(out['555'].fileId, 'B');
});
