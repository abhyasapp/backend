// tests/gas-harness.mjs — runs the REAL Apps Script files (gas/*.gs) in a vm sandbox on top of an
// in-memory Sheets mock. Only the platform edges are faked (sheets, locks, auth, Drive reads);
// every handler under test — submitWeeklyAttempt, adminCreateWeeklySet, syncQState_, … — is the
// shipped code.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class MockRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.data[this.r - 1 + i] || [];
      out.push(Array.from({ length: this.nc }, (_, j) => (row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j])));
    }
    return out;
  }
  setValues(v) {
    v.forEach((row, i) => {
      const idx = this.r - 1 + i;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      row.forEach((x, j) => { this.sheet.data[idx][this.c - 1 + j] = x; });
    });
    return this;
  }
  setValue(x) { return this.setValues([[x]]); }
  setNumberFormat() { return this; } setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; }
  createTextFinder(text) {
    const self = this; let matchCase = false, entire = false;
    const hits = () => {
      const out = [];
      for (let i = 0; i < self.nr; i++) for (let j = 0; j < self.nc; j++) {
        const row = self.sheet.data[self.r - 1 + i] || [];
        let cell = row[self.c - 1 + j]; cell = cell === undefined || cell === null ? '' : String(cell);
        const a = matchCase ? cell : cell.toLowerCase(), b = matchCase ? String(text) : String(text).toLowerCase();
        if (entire ? a === b : a.includes(b)) out.push({ getRow: () => self.r + i, getColumn: () => self.c + j });
      }
      return out;
    };
    const f = { matchCase(v) { matchCase = v; return f; }, matchEntireCell(v) { entire = v; return f; }, findAll: () => hits(), findNext: () => hits()[0] || null };
    return f;
  }
}

class MockSheet {
  constructor(name, headers) { this.name = name; this.data = [headers.slice()]; }
  getName() { return this.name; }
  getLastRow() { return this.data.length; }
  getLastColumn() { return Math.max(...this.data.map((r) => r.length), 0); }
  getMaxRows() { return 1000; }
  appendRow(arr) { this.data.push(arr.slice()); return this; }
  getDataRange() { return { getValues: () => this.data.map((r) => r.slice()) }; }
  getRange(r, c, nr = 1, nc = 1) { return new MockRange(this, r, c, nr, nc); }
  deleteRow(n) { this.data.splice(n - 1, 1); }
  rows() { const [h, ...rest] = this.data; return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); }
}

const stub = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub), apply: () => stub, construct: () => stub });
const FILES_ORDER = ['code.gs', 'report.gs', 'sync.gs', 'supabase-bridge.gs', 'setup.gs', 'private-files.gs', 'qid-core.gs', 'qid.gs', 'admin-reports.gs'];

/** @param {{ files?: Record<string, any>, syncKey?: string }} opts  Drive "files": id → parsed JSON */
export function makeGas({ files = {}, syncKey = 'sync-secret', props = {} } = {}) {
  const scriptProps = { SYNC_KEY: syncKey, ...props };
  const sheets = {};
  const bridgeCalls = [];
  const ctx = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    SpreadsheetApp: stub, DriveApp: stub, CacheService: stub, LockService: stub,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in scriptProps ? scriptProps[k] : null), setProperty: (k, v) => { scriptProps[k] = v; } }) },
    ContentService: { createTextOutput: (t) => ({ setMimeType() { return this; }, getContent: () => t }), MimeType: { JSON: 'json' } },
    Utilities: { getUuid: () => 'uuid-' + Math.random().toString(36).slice(2, 10), formatDate: () => '2026-11-17' },
    UrlFetchApp: stub, Session: stub, ScriptApp: stub, MailApp: stub, HtmlService: stub, Logger: stub, GmailApp: stub, Drive: stub,
    JSON, Math, Date, Object, Array, String, Number, RegExp, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, Error, Map, Set, Promise,
  });
  for (const f of FILES_ORDER) vm.runInContext(fs.readFileSync(path.join(root, 'gas', f), 'utf8'), ctx, { filename: f });

  ctx.__files = files; ctx.__sheets = sheets; ctx.__bridge = bridgeCalls; ctx.__key = syncKey;
  ctx.__MockSheet = MockSheet;
  // Platform edges only. Everything else is the shipped code.
  vm.runInContext(`
    _getOrCreateSheet_ = function (name, headers) { if (!__sheets[name]) __sheets[name] = new __MockSheet(name, headers); return __sheets[name]; };
    _topUpHeaders_ = function (sheet, headers) {
      const cur = sheet.data[0].map(String); const missing = headers.filter(function (h) { return cur.indexOf(h) < 0; });
      missing.forEach(function (h) { sheet.data[0].push(h); });
    };
    withLock_ = function (fn) { return fn(); };
    checkRateLimit_ = function () { return true; };
    logAction_ = function () {};
    authUser_ = function (p) { return p.token === 'ok-' + p.username ? { ok: true, username: String(p.username), found: { row: [p.username] } } : { ok: false, error: { success: false, error: 'Session expired. Please log in again.', sessionInvalid: true } }; };
    requireAccess_ = function () { return null; };
    checkAdminCan_ = function (p) { return p.token === 'admin-token' ? { ok: true, actor: 'admin', role: 'owner' } : { ok: false, error: 'Admin auth failed.' }; };
    readJsonFileById_ = function (id) { return __files[id] === undefined ? { success: false, error: 'not found' } : { success: true, result: JSON.parse(JSON.stringify(__files[id])) }; };
    _syncAuthOk_ = function (p) { return String(p && p.key) === __key; };
    requireAccess_ = function () { return null; };
    bridgeRequest_ = function (method, path, body) { __bridge.push({ method: method, path: path, body: body }); return { ok: true, status: 200, data: [] }; };
  `, ctx);

  return {
    ctx, sheets, bridgeCalls, files, props: scriptProps,
    run: (code) => vm.runInContext(code, ctx),
    /** Call any global function by name with a params object. */
    fn: (name, params) => { ctx.__p = params; return vm.runInContext(`${name}(__p)`, ctx); },
    /** Dispatch through the real routers (QID first, then REPORT), like doGet's default case. */
    route: (action, params) => {
      ctx.__a = action; ctx.__p = params;
      return vm.runInContext('(function(){ var h = QID_HANDLE_(__a, __p); if (h === null) h = REPORT_HANDLE_(__a, __p); return h; })()', ctx);
    },
  };
}
