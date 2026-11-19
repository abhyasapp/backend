// Minimal in-memory PostgREST-like client: enough for the handlers under test.
export const DB = { tables: {}, storage: {} };
const T = (n) => (DB.tables[n] ||= []);
export function reset() { DB.tables = {}; DB.storage = {}; }
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.opts = {}; this.lim = null; this.ords = []; this.rng = null; }
  select(cols, opts = {}) { if (this.op === 'select') this.op = 'select'; this.opts = opts; this.sel = true; this.cols = cols; return this; }
  insert(v) { this.op = 'insert'; this.v = v; return this; }
  upsert(v, o = {}) { this.op = 'upsert'; this.v = v; this.o = o; return this; }
  update(v) { this.op = 'update'; this.v = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  neq(c, v) { this.f.push((r) => String(r[c]) !== String(v)); return this; }
  in(c, a) { this.f.push((r) => a.map(String).includes(String(r[c]))); return this; }
  lt(c, v) { this.f.push((r) => String(r[c]) < String(v)); return this; }
  lte(c, v) { this.f.push((r) => String(r[c]) <= String(v)); return this; }
  gt(c, v) { this.f.push((r) => r[c] != null && String(r[c]) > String(v)); return this; }
  gte(c, v) { this.f.push((r) => r[c] != null && String(r[c]) >= String(v)); return this; }
  ilike(c, v) { const re = new RegExp('^' + String(v).replace(/\\([\\%_])/g, '\u0000$1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.').replace(/\u0000(.)/g, '$1') + '$', 'i'); this.f.push((r) => re.test(String(r[c] ?? ''))); return this; }
  order(c, o = {}) { this.ords.push([c, o.ascending === false ? -1 : 1]); return this; }   // multi-key, like PostgREST
  limit(n) { this.lim = n; return this; }
  range(from, to) { this.rng = [from, to]; return this; }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  run() {
    const rows = T(this.t);
    const match = (r) => this.f.every((f) => f(r));
    if (this.op === 'insert') {
      const arr = Array.isArray(this.v) ? this.v : [this.v];
      const pk = { admins: 'username', users: 'username', admin_permissions: null, logs: null, deleted_records: null, settings: 'key' }[this.t];
      for (const x of arr) {
        if (pk && rows.some((r) => r[pk] === x[pk])) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        const nr = { ...x }; if (this.t === 'question_reports') touchReport(nr); rows.push(nr);
      }
      return { data: arr, error: null };
    }
    if (this.op === 'upsert') {
      const arr = Array.isArray(this.v) ? this.v : [this.v];
      const cols = String(this.o.onConflict || 'key').split(',');
      for (const x of arr) { const i = rows.findIndex((r) => cols.every((c) => r[c] === x[c])); if (i >= 0) rows[i] = { ...rows[i], ...x }; else rows.push({ ...x }); }
      return { data: arr, error: null };
    }
    if (this.op === 'update') {
      const hit = rows.filter(match);
      // Test hook: DB.failUpdates = { table: Set(ids) } makes writes to those rows fail like a DB error would.
      if (DB.failUpdates && DB.failUpdates[this.t] && hit.some((r) => DB.failUpdates[this.t].has(r.id))) return { data: null, error: { message: 'simulated write failure' } };
      hit.forEach((r) => { const old = { ...r }; Object.assign(r, this.v); if (this.t === 'question_reports') touchReport(r, old); });
      return { data: this.sel ? hit.map((r) => ({ ...r })) : null, error: null }; }
    if (this.op === 'delete') { const keep = rows.filter((r) => !match(r)); const n = rows.length - keep.length; DB.tables[this.t] = keep; return { data: null, error: null, count: n }; }
    let out = rows.filter(match).map((r) => ({ ...r }));
    const count = out.length;
    if (this.ords.length) out.sort((a, b) => {
      for (const [c, dir] of this.ords) { if (a[c] === b[c]) continue; return (a[c] > b[c] ? 1 : -1) * dir; }
      return 0;
    });
    if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
    if (this.lim != null) out = out.slice(0, this.lim);
    // Honour column projection like PostgREST does: a handler that reads a column it did not
    // select gets `undefined` here, exactly as in production, so the mistake fails a test.
    if (this.op === 'select' && typeof this.cols === 'string' && this.cols.trim() && this.cols.trim() !== '*' && !/[()]/.test(this.cols)) {
      const want = this.cols.split(',').map((c) => c.trim()).filter(Boolean);
      out = out.map((r) => Object.fromEntries(want.filter((c) => c in r).map((c) => [c, r[c]])));
    }
    return { data: this.opts.head ? null : out, error: null, count: this.opts.count ? count : null };
  }
}
const storage = { from: (b) => ({
  download: async (p) => { const v = DB.storage[b + '/' + p]; return v == null ? { data: null, error: { message: 'nf' } } : { data: { text: async () => v }, error: null }; },
  upload: async (p, v) => { DB.storage[b + '/' + p] = String(v); return { data: { path: p }, error: null }; },
  list: async (_p, o) => ({ data: Object.keys(DB.storage).filter((k) => k.startsWith(b + '/') && k.includes(o?.search || '')).map((k) => ({ name: k.slice(b.length + 1) })) }),
  createSignedUrl: async (p) => ({ data: { signedUrl: 'http://signed/' + p } }), remove: async () => ({}),
}) };
// rpc: only bump_qid_stats is emulated; anything else (rl_hit …) reports "not deployed" so
// the callers' existing fallbacks run exactly as they did before rpc existed in the mock.
async function rpc(name, a) {
  if (name === 'bump_qid_stats') {
    const rows = T('qid_stats'); let r = rows.find((x) => x.qid === a.p_qid);
    if (!r) { r = { qid: a.p_qid, attempts: '0', wrong: '0', students: '0', updated_at: '' }; rows.push(r); }
    r.attempts = String(Number(r.attempts) + a.p_attempts); r.wrong = String(Number(r.wrong) + a.p_wrong);
    r.students = String(Number(r.students) + a.p_students); r.updated_at = new Date().toISOString();
    return { data: null, error: null };
  }
  return { data: null, error: { message: 'function not deployed' } };
}
// Emulates the question_reports_touch() trigger (migration 20261118…): updated_at is stamped by the
// "database" on insert and on any update that changes something other than updated_at itself.
const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
function touchReport(row, old) {
  if (old) {
    const a = { ...old }, b = { ...row }; delete a.updated_at; delete b.updated_at;
    if (canon(a) === canon(b)) { row.updated_at = old.updated_at; return; }
  }
  row.updated_at = new Date().toISOString();
}
export function createClient() { return { from: (t) => new Q(t), storage, rpc }; }
