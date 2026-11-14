// Minimal in-memory PostgREST-like client: enough for the handlers under test.
export const DB = { tables: {}, storage: {} };
const T = (n) => (DB.tables[n] ||= []);
export function reset() { DB.tables = {}; DB.storage = {}; }
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.opts = {}; this.lim = null; this.ord = null; this.rng = null; }
  select(cols, opts = {}) { if (this.op === 'select') this.op = 'select'; this.opts = opts; this.sel = true; return this; }
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
  order(c, o = {}) { this.ord = [c, o.ascending === false ? -1 : 1]; return this; }
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
        rows.push({ ...x });
      }
      return { data: arr, error: null };
    }
    if (this.op === 'upsert') {
      const arr = Array.isArray(this.v) ? this.v : [this.v];
      const cols = String(this.o.onConflict || 'key').split(',');
      for (const x of arr) { const i = rows.findIndex((r) => cols.every((c) => r[c] === x[c])); if (i >= 0) rows[i] = { ...rows[i], ...x }; else rows.push({ ...x }); }
      return { data: arr, error: null };
    }
    if (this.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, this.v)); return { data: this.sel ? hit.map((r) => ({ ...r })) : null, error: null }; }
    if (this.op === 'delete') { const keep = rows.filter((r) => !match(r)); const n = rows.length - keep.length; DB.tables[this.t] = keep; return { data: null, error: null, count: n }; }
    let out = rows.filter(match).map((r) => ({ ...r }));
    const count = out.length;
    if (this.ord) out.sort((a, b) => (a[this.ord[0]] > b[this.ord[0]] ? 1 : -1) * this.ord[1]);
    if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
    if (this.lim != null) out = out.slice(0, this.lim);
    return { data: this.opts.head ? null : out, error: null, count: this.opts.count ? count : null };
  }
}
const storage = { from: (b) => ({
  download: async (p) => { const v = DB.storage[b + '/' + p]; return v == null ? { data: null, error: { message: 'nf' } } : { data: { text: async () => v }, error: null }; },
  upload: async (p, v) => { DB.storage[b + '/' + p] = String(v); return { data: { path: p }, error: null }; },
  list: async (_p, o) => ({ data: Object.keys(DB.storage).filter((k) => k.startsWith(b + '/') && k.includes(o?.search || '')).map((k) => ({ name: k.slice(b.length + 1) })) }),
  createSignedUrl: async (p) => ({ data: { signedUrl: 'http://signed/' + p } }), remove: async () => ({}),
}) };
export function createClient() { return { from: (t) => new Q(t), storage }; }
