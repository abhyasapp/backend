/* ═══════════════════════════════════════════════════════════════════════
   gas/qid.gs — the Apps Script twin of supabase/functions/api/handlers/qstate.ts
   (+ the weekly qid pieces of weekly.ts). Same actions, same JSON contract
   (see docs/QID-CONTRACT.md), keyed by qid — never by position or file.

   Paste into the Apps Script project as a NEW file called qid.gs, together with
   qid-core.gs (the pure rules this file calls). It shares the global scope of
   code.gs / report.gs / sync.gs.

   Wiring (already done in code.gs): the doGet default case calls QID_HANDLE_
   before REPORT_HANDLE_, and `ingestquestionindex` is in POST_ONLY_ACTIONS
   because its SYNC_KEY must never appear in a URL.

   Storage is Google Sheets, so this is the FALLBACK path: each read loads a
   sheet into memory (cached per execution). Fine for the volumes a fallback
   sees; the primary (Supabase) is the one built for scale.
   ═══════════════════════════════════════════════════════════════════════ */

var QINDEX_SHEET = "QuestionIndex";
var QSTATE_SHEET = "UserQState";
var QEVENTS_SHEET = "AnswerEvents";
var QSTATS_SHEET = "QidStats";

var QINDEX_HEADERS = ["qid", "fileId", "ord", "rev", "kind", "status", "canonicalQid", "updatedAt"];
var QSTATE_HEADERS = ["username", "qid", "fileId", "note", "noteAt", "bookmarked", "bookmarkedAt", "flagged", "flaggedAt",
  "inMistakes", "mistakesAt", "attempts", "wrong", "lastResult", "lastAt", "updatedAt"];
var QEVENTS_HEADERS = ["username", "qid", "at", "fileId", "ok", "chosen", "mode", "sessionId"];
var QSTATS_HEADERS = ["qid", "attempts", "wrong", "students", "updatedAt"];

var QID_MAX_CHANGES_ = 200;
var QID_MAX_EVENTS_ = 200;
var QID_EVENT_MAX_AGE_MS_ = 30 * 24 * 60 * 60 * 1000;
var QID_HARD_MIN_ATTEMPTS_ = 20;
var QID_HARD_MIN_STUDENTS_ = 5;

/* ── sheets ─────────────────────────────────────────────────────────── */

function qidMakeSheet_(name, headers) {
  /* Every column is plain text: Sheets must not turn "true" into TRUE or an ISO
     timestamp into a Date (both would corrupt a round trip through sync). */
  const all = headers.map(function (_, i) { return i + 1; });
  const sheet = _getOrCreateSheet_(name, headers, all, "#6d28d9", SpreadsheetApp.BandingTheme.INDIGO, 300);
  _topUpHeaders_(sheet, headers, "#6d28d9");
  return sheet;
}
function getQuestionIndexSheet_() { return qidMakeSheet_(QINDEX_SHEET, QINDEX_HEADERS); }
function getUserQStateSheet_()    { return qidMakeSheet_(QSTATE_SHEET, QSTATE_HEADERS); }
function getAnswerEventsSheet_()  { return qidMakeSheet_(QEVENTS_SHEET, QEVENTS_HEADERS); }
function getQidStatsSheet_()      { return qidMakeSheet_(QSTATS_SHEET, QSTATS_HEADERS); }

function qidCell_(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/* Loads a sheet as objects keyed by its ACTUAL header names (robust to column order). */
function qidRead_(name, getter) {
  const sheet = getter();
  const data = _cachedSheetData_(name, function () { return sheet; }).data;
  const head = data[0].map(function (h) { return String(h).trim(); });
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const o = { _row: i + 1 };
    for (let c = 0; c < head.length; c++) o[head[c]] = qidCell_(data[i][c]);
    rows.push(o);
  }
  return { sheet: sheet, head: head, rows: rows, name: name };
}

/* Update in place when the object carries its _row, else append. */
function qidWrite_(tbl, obj) {
  const arr = tbl.head.map(function (h) { return obj[h] === undefined ? "" : obj[h]; });
  if (obj._row) tbl.sheet.getRange(obj._row, 1, 1, tbl.head.length).setValues([arr]);
  else tbl.sheet.appendRow(arr);
}

/* ── small helpers ──────────────────────────────────────────────────── */

function qidArrayParam_(v) {
  try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? a : null; } catch (e) { return null; }
}
function qidLc_(s) { return String(s || "").toLowerCase().trim(); }

/* qid → canonical qid for each id (merged/retired ids redirect); identity when none. */
function qidCanonicalMap_(qids) {
  const out = {};
  const wanted = [];
  qids.forEach(function (q) { const s = qidStr_(q); if (s && out[s] === undefined) { out[s] = s; wanted.push(s); } });
  const aliases = {};
  try {
    qidRead_(QINDEX_SHEET, getQuestionIndexSheet_).rows.forEach(function (r) {
      const c = qidStr_(r.canonicalQid);
      if (c && c !== r.qid) aliases[r.qid] = c;
    });
  } catch (e) { /* registry unavailable → identity */ }
  wanted.forEach(function (q) { out[q] = qidResolveCanonical_(q, aliases); });
  return out;
}

function qidStateView_(r) {
  return {
    qid: String(r.qid || ""), fileId: String(r.fileId || ""),
    note: String(r.note || ""), noteAt: String(r.noteAt || ""),
    bookmarked: qidToBool_(r.bookmarked), bookmarkedAt: String(r.bookmarkedAt || ""),
    flagged: qidToBool_(r.flagged), flaggedAt: String(r.flaggedAt || ""),
    inMistakes: qidToBool_(r.inMistakes), mistakesAt: String(r.mistakesAt || ""),
    attempts: Number(r.attempts || 0), wrong: Number(r.wrong || 0),
    lastResult: String(r.lastResult || ""), lastAt: String(r.lastAt || ""),
    updatedAt: String(r.updatedAt || "")
  };
}

/* ── question registry ──────────────────────────────────────────────── */

/* Upsert the registry rows of one file. Never touches status / canonicalQid. Best-effort. */
function qidRegisterFile_(fileId, rawOrArr) {
  try {
    const rows = qidBuildIndex_(rawOrArr);
    if (!rows.length || !fileId) return 0;
    const tbl = qidRead_(QINDEX_SHEET, getQuestionIndexSheet_);
    const byQid = {};
    tbl.rows.forEach(function (r) { byQid[r.qid] = r; });
    const now = new Date().toISOString();
    rows.forEach(function (r) {
      const ex = byQid[r.qid];
      const o = ex || { qid: r.qid, status: "active", canonicalQid: "" };
      o.fileId = fileId; o.ord = String(r.ord); o.rev = r.rev; o.kind = r.kind; o.updatedAt = now;
      qidWrite_(tbl, o);
    });
    _invalidateSheet_(QINDEX_SHEET);
    return rows.length;
  } catch (e) { return 0; }
}

/* Reads a weekly file once and returns what must be frozen on the set. */
function weeklyFreezePaper_(fileId) {
  try {
    const res = readJsonFileById_(fileId);
    if (!res || !res.success) return { qids: [], rev: "", qidReady: false, coverage: null, error: "Could not read the weekly file to freeze its questions." };
    const raw = res.result;
    const coverage = qidCoverage_(raw);
    const qidReady = coverage.total > 0 && coverage.missing === 0 && coverage.duplicates.length === 0;
    if (coverage.duplicates.length) {
      return { qids: [], rev: "", qidReady: false, coverage: coverage, error: "Duplicate question ids in this file: " + coverage.duplicates.slice(0, 5).join(", ") + ". Fix them and re-upload." };
    }
    qidRegisterFile_(fileId, raw);
    return { qids: qidReady ? qidBuildIndex_(raw).map(function (r) { return r.qid; }) : [], rev: qidFileRev_(qidFlatten_(raw)), qidReady: qidReady, coverage: coverage };
  } catch (e) {
    return { qids: [], rev: "", qidReady: false, coverage: null, error: "The weekly file could not be parsed." };
  }
}

/* Per-question analysis keyed by qid (position-free) + whether the paper changed since creation. */
function weeklyQuestionStats_(ws, qidAnswerMaps) {
  let questionStats = [], paperChanged = false;
  try {
    const res = readJsonFileById_(ws.fileId);
    if (res && res.success) {
      const arr = qidFlatten_(res.result);
      paperChanged = !!ws.fileRev && ws.fileRev !== qidFileRev_(arr);
      const key = {};
      arr.forEach(function (q) { key[qidPrimary_(q).qid] = qidCorrectOf_(q); });
      const tally = {}, order = [];
      qidAnswerMaps.forEach(function (m) {
        Object.keys(m || {}).forEach(function (qid) {
          if (!tally[qid]) { tally[qid] = { answered: 0, right: 0, skipped: 0 }; order.push(qid); }
          const a = m[qid], t = tally[qid];
          if (a === null || a === undefined) t.skipped++;
          else {
            t.answered++;
            const e = key[qid];
            if ((typeof e === "number" && a === e) || (typeof e === "string" && String(a) === e)) t.right++;
          }
        });
      });
      questionStats = order.map(function (qid) {
        const t = tally[qid];
        return { qid: qid, answered: t.answered, correct: t.right, skipped: t.skipped,
                 pctCorrect: t.answered ? Math.round((t.right / t.answered) * 100) : null };
      }).sort(function (a, b) {
        return (a.pctCorrect === null ? 101 : a.pctCorrect) - (b.pctCorrect === null ? 101 : b.pctCorrect);
      });
    }
  } catch (e) { /* analysis is optional */ }
  return { questionStats: questionStats, paperChanged: paperChanged };
}

/* ── syncqstate ─────────────────────────────────────────────────────── */

function syncQState_(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;
  const username = auth.username;

  const changes = (p.changes === undefined || p.changes === "") ? [] : qidArrayParam_(p.changes);
  if (changes === null) return { success: false, error: "Malformed changes." };
  if (changes.length > QID_MAX_CHANGES_) return { success: false, error: "At most " + QID_MAX_CHANGES_ + " changes per request." };
  const since = qidIso_(p.since);
  /* One request's rows share one timestamp (up to QID_MAX_CHANGES_). The page is never smaller, so a
     tie group always fits and the inclusive cursor below can never skip a row. */
  const limit = Math.max(QID_MAX_CHANGES_, Math.min(2000, Number(p.limit) || 1000));
  const nowIso = new Date().toISOString();
  const rejected = [];
  let applied = 0;

  return withLock_(function () {
    const tbl = qidRead_(QSTATE_SHEET, getUserQStateSheet_);
    const who = qidLc_(username);

    if (changes.length) {
      if (!checkRateLimit_("qs_" + who, 600, 60 * 60 * 1000)) {
        return { success: false, error: "Too many requests. Please wait a moment and try again.", rateLimited: true };
      }
      const wanted = changes.map(function (c) { return qidStr_(c && c.qid); });
      const canon = qidCanonicalMap_(wanted.filter(function (x) { return !!x; }));
      const byQid = {}, order = [];
      changes.forEach(function (c, i) {
        const q = wanted[i];
        if (!q) { rejected.push({ index: i, reason: "bad_qid" }); return; }
        const cq = canon[q] || q;
        if (!byQid[cq]) { byQid[cq] = { qid: cq }; order.push(cq); }
        const prev = byQid[cq];
        QSTATE_FIELDS_.forEach(function (f) {
          if (c[f.prop] === undefined) return;
          const a = qidIso_(c[f.at]) || nowIso;
          if (prev[f.prop] === undefined || a >= (qidIso_(prev[f.at]) || "")) { prev[f.prop] = c[f.prop]; prev[f.at] = a; }
        });
        if (c.fileId) prev.fileId = String(c.fileId).slice(0, 200);
      });

      const existing = {};
      tbl.rows.forEach(function (r) { if (qidLc_(r.username) === who) existing[r.qid] = r; });

      order.forEach(function (qid) {
        const ch = byQid[qid], ex = existing[qid];
        const patch = qstateMergeChange_(ex, ch, nowIso);
        if (!patch) return;
        const row = ex || { username: username, qid: qid, fileId: "", attempts: "0", wrong: "0", lastResult: "", lastAt: "" };
        row.username = username; row.qid = qid;
        row.fileId = ch.fileId || (ex && ex.fileId ? ex.fileId : "");
        Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
        row.updatedAt = nowIso;
        qidWrite_(tbl, row);
        applied++;
      });
      _invalidateSheet_(QSTATE_SHEET);
    }

    /* Delta read: everything changed after `since`, this device's own writes included. */
    const fresh = changes.length ? qidRead_(QSTATE_SHEET, getUserQStateSheet_) : tbl;
    /* INCLUSIVE cursor (>=): see the Supabase twin. Total order: (updatedAt, qid). */
    const mine = fresh.rows.filter(function (r) { return qidLc_(r.username) === who && (!since || r.updatedAt >= since); });
    mine.sort(function (a, b) { return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : (a.qid < b.qid ? -1 : a.qid > b.qid ? 1 : 0); });
    const page = mine.slice(0, limit);
    return {
      success: true, applied: applied, rejected: rejected, serverNow: nowIso,
      rows: page.map(qidStateView_),
      cursor: page.length ? page[page.length - 1].updatedAt : since,
      more: mine.length > limit
    };
  });
}

/* ── recordanswers ──────────────────────────────────────────────────── */

function recordAnswers_(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;
  const username = auth.username;

  const events = qidArrayParam_(p.events);
  if (!events || !events.length) return { success: false, error: "events required." };
  if (events.length > QID_MAX_EVENTS_) return { success: false, error: "At most " + QID_MAX_EVENTS_ + " events per request." };
  if (!checkRateLimit_("ans_" + qidLc_(username), 600, 60 * 60 * 1000)) {
    return { success: false, error: "Too many requests. Please wait a moment and try again.", rateLimited: true };
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const rejected = [];
  const wanted = events.map(function (e) { return qidStr_(e && e.qid); });
  const canon = qidCanonicalMap_(wanted.filter(function (x) { return !!x; }));

  const clean = [];
  events.forEach(function (e, i) {
    const q = wanted[i];
    if (!q) { rejected.push({ index: i, reason: "bad_qid" }); return; }
    if (typeof e.ok !== "boolean" && e.ok !== "true" && e.ok !== "false") { rejected.push({ index: i, reason: "bad_ok" }); return; }
    const at = qidIso_(e.at) || nowIso;
    const atMs = new Date(at).getTime();
    if (atMs > nowMs + QSTATE_FUTURE_SKEW_MS_ || atMs < nowMs - QID_EVENT_MAX_AGE_MS_) { rejected.push({ index: i, reason: "bad_time" }); return; }
    const n = Number(e.chosen);
    clean.push({
      qid: canon[q] || q, at: at, ok: qidToBool_(e.ok),
      chosen: (e.chosen !== null && e.chosen !== undefined && e.chosen !== "" && isFinite(n) && Math.floor(n) === n && n >= 0 && n < 10) ? String(n) : "",
      fileId: String(e.fileId || "").slice(0, 200), mode: String(e.mode || "").slice(0, 20), sessionId: String(e.sessionId || "").slice(0, 64)
    });
  });

  return withLock_(function () {
    const who = qidLc_(username);
    const evTbl = qidRead_(QEVENTS_SHEET, getAnswerEventsSheet_);
    const have = {};
    evTbl.rows.forEach(function (r) { if (qidLc_(r.username) === who) have[r.qid + "|" + r.at] = true; });

    /* Idempotency: one event per (student, qid, instant). A retried batch is a no-op. */
    const fresh = [];
    clean.forEach(function (c) {
      const k = c.qid + "|" + c.at;
      if (have[k]) return;
      have[k] = true; fresh.push(c);
    });
    const duplicates = clean.length - fresh.length;

    fresh.forEach(function (ev) {
      qidWrite_(evTbl, { username: username, qid: ev.qid, at: ev.at, fileId: ev.fileId, ok: String(ev.ok), chosen: ev.chosen, mode: ev.mode, sessionId: ev.sessionId });
    });
    _invalidateSheet_(QEVENTS_SHEET);

    /* Fold into per-qid state + global stats. */
    const perQid = {}, order = [];
    fresh.forEach(function (e) { if (!perQid[e.qid]) { perQid[e.qid] = []; order.push(e.qid); } perQid[e.qid].push(e); });
    const stTbl = qidRead_(QSTATE_SHEET, getUserQStateSheet_);
    const existing = {};
    stTbl.rows.forEach(function (r) { if (qidLc_(r.username) === who) existing[r.qid] = r; });
    const gTbl = qidRead_(QSTATS_SHEET, getQidStatsSheet_);
    const gBy = {};
    gTbl.rows.forEach(function (r) { gBy[r.qid] = r; });

    const touched = [];
    order.forEach(function (qid) {
      const evs = perQid[qid], ex = existing[qid];
      const f = qstateFoldAnswers_(ex, evs, nowIso);
      const row = f.row;
      row.username = username; row.qid = qid;
      if (ex) row._row = ex._row;
      qidWrite_(stTbl, row);
      touched.push(row);
      const g = gBy[qid] || { qid: qid, attempts: "0", wrong: "0", students: "0" };
      g.attempts = String(Number(g.attempts || 0) + evs.length);
      g.wrong = String(Number(g.wrong || 0) + f.wrongN);
      g.students = String(Number(g.students || 0) + (f.prevAttempts === 0 ? 1 : 0));
      g.updatedAt = nowIso;
      qidWrite_(gTbl, g);
      gBy[qid] = g;
    });
    _invalidateSheet_(QSTATE_SHEET);
    _invalidateSheet_(QSTATS_SHEET);
    return { success: true, accepted: fresh.length, duplicates: duplicates, rejected: rejected, state: touched.map(qidStateView_) };
  });
}

/* ── corrections as qid-keyed patches ───────────────────────────────── */

/* Latest-per-qid patches derived from resolved+corrected reports (the Apps Script
   side keeps corrections on the report row; there is no separate event table). */
function qidCollectPatches_(sinceIso, fileId, limit) {
  const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;
  const list = [];
  for (let i = 1; i < data.length; i++) {
    const r = rowToQReport_(data[i]);
    if (r.status !== "resolved" || !r.corrected || !r.correctedSnapshot) continue;
    const qid = qidStr_(r.qid);
    if (!qid) continue;                                  /* legacy position-only corrections cannot be applied by id */
    if (fileId && String(r.fileId) !== fileId) continue;
    const snap = r.correctedSnapshot;
    const after = (snap.after && typeof snap.after === "object") ? snap.after
      : (snap.q != null ? { question: snap.q, options: snap.options, correctIndex: snap.correct, explanation: snap.explanation } : null);
    if (!after || !String(after.question || "").trim()) continue;
    const atMs = new Date(snap.at || r.resolvedAt).getTime();
    if (!isFinite(atMs)) continue;
    const correctedAt = new Date(atMs).toISOString();
    if (correctedAt <= sinceIso) continue;                /* exclusive cursor, same as the Supabase side */
    const options = (Array.isArray(after.options) ? after.options : []).map(String);
    const ac = after.correctIndex;
    const correctIndex = (typeof ac === "number" && isFinite(ac) && Math.floor(ac) === ac && ac >= 0) ? ac : null;
    list.push({
      qid: qid, fileId: r.fileId, correctedAt: correctedAt,
      baseRev: String(snap.baseRev || ""),
      rev: String(snap.newRev || qidQuestionRev_({ q: String(after.question || ""), options: options, correct: correctIndex === null ? undefined : correctIndex, explanation: String(after.explanation || "") })),
      question: String(after.question || ""), options: options, correctIndex: correctIndex, explanation: String(after.explanation || "")
    });
  }
  list.sort(function (a, b) { return a.correctedAt < b.correctedAt ? -1 : a.correctedAt > b.correctedAt ? 1 : 0; });
  return list;
}

function getQidPatches_(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const gate = requireAccess_(auth);
  if (gate) return gate;

  const since = qidIso_(p.since) || new Date(0).toISOString();
  const limit = Math.max(1, Math.min(500, Number(p.limit) || 500));
  const fileId = String(p.fileId || "").trim();
  const events = qidCollectPatches_(since, fileId, limit);
  const page = events.slice(0, limit);
  const latest = {}, order = [];
  page.forEach(function (ev) { if (latest[ev.qid] === undefined) order.push(ev.qid); latest[ev.qid] = ev; });
  const canon = qidCanonicalMap_(order);
  const patches = order.map(function (q) { const o = latest[q]; o.canonicalQid = canon[q] || q; return o; });
  return {
    success: true, patches: patches, truncated: events.length > limit,
    cursor: page.length ? page[page.length - 1].correctedAt : since, serverNow: new Date().toISOString()
  };
}

/* ── resolveqids / coverage / ingest ────────────────────────────────── */

function resolveQids_(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const list = qidArrayParam_(p.qids);
  if (!list || !list.length || list.length > 500) return { success: false, error: "qids required (max 500)." };
  const ids = [];
  list.forEach(function (x) { const s = qidStr_(x); if (s && ids.indexOf(s) < 0) ids.push(s); });
  const canon = qidCanonicalMap_(ids);
  const info = {};
  qidRead_(QINDEX_SHEET, getQuestionIndexSheet_).rows.forEach(function (r) { info[r.qid] = { fileId: r.fileId, rev: r.rev, status: r.status, kind: r.kind }; });
  const out = {};
  ids.forEach(function (id) {
    const c = canon[id] || id;
    const base = info[c] || { fileId: "", rev: "", status: "unknown", kind: qidKind_(c) };
    out[id] = { canonicalQid: c, redirected: c !== id, fileId: base.fileId, rev: base.rev, status: base.status, kind: base.kind };
  });
  return { success: true, qids: out };
}

function adminQidCoverage_(p) {
  const chk = checkAdminCan_(p, "qreports_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const fileId = String(p.fileId || "").trim();
  if (fileId) {
    const res = readJsonFileById_(fileId);
    if (!res || !res.success) return { success: false, error: "Could not read file" };
    return { success: true, fileId: fileId, source: "drive", overlay: { applied: 0, skipped: 0 }, coverage: qidCoverage_(res.result) };
  }
  const rows = qidRead_(QINDEX_SHEET, getQuestionIndexSheet_).rows;
  const files = {}, sum = { questions: rows.length, stable: 0, positional: 0, retired: 0, merged: 0 };
  rows.forEach(function (r) {
    files[r.fileId] = true;
    if (r.kind === "stable") sum.stable++; else if (r.kind === "positional") sum.positional++;
    if (r.status === "retired") sum.retired++;
    if (r.status === "merged" || String(r.canonicalQid || "")) sum.merged++;
  });
  return { success: true, files: Object.keys(files).length, questions: sum.questions, stable: sum.stable, positional: sum.positional,
           retired: sum.retired, merged: sum.merged, note: "Per-file detail: pass fileId." };
}

function ingestQuestionIndex_(p) {
  if (!_syncAuthOk_(p)) return { success: false, code: "unauthorized", error: "unauthorized" };
  const rows = qidArrayParam_(p.rows);
  if (!rows || !rows.length) return { success: false, error: "rows required." };
  if (rows.length > 1000) return { success: false, error: "At most 1000 rows per call." };

  return withLock_(function () {
    const tbl = qidRead_(QINDEX_SHEET, getQuestionIndexSheet_);
    const by = {};
    tbl.rows.forEach(function (r) { by[r.qid] = r; });
    const now = new Date().toISOString();
    const rejected = [];
    let upserted = 0;
    rows.forEach(function (r, i) {
      const parsed = qidParse_(r && r.qid);
      if (!parsed.qid) { rejected.push({ index: i, reason: "bad_qid" }); return; }
      const o = by[parsed.qid] || { qid: parsed.qid, fileId: "", ord: "", rev: "", status: "active", canonicalQid: "" };
      o.kind = parsed.kind; o.updatedAt = now;
      if (r.fileId !== undefined) o.fileId = String(r.fileId).slice(0, 200);
      if (r.ord !== undefined) o.ord = String(Number(r.ord) >= 0 ? Number(r.ord) : "");
      if (r.rev !== undefined) o.rev = String(r.rev).slice(0, 40);
      if (r.status !== undefined && ["active", "retired", "merged"].indexOf(String(r.status)) >= 0) o.status = String(r.status);
      if (r.canonicalQid !== undefined) {
        const c = qidStr_(r.canonicalQid);
        if (String(r.canonicalQid) && (!c || c === parsed.qid)) { rejected.push({ index: i, reason: "bad_canonical" }); return; }
        o.canonicalQid = c;
      }
      qidWrite_(tbl, o);
      by[parsed.qid] = o;
      upserted++;
    });
    _invalidateSheet_(QINDEX_SHEET);
    return { success: true, upserted: upserted, rejected: rejected };
  });
}

/* ── rebuild qid statistics from the immutable answer log (SYNC_KEY) ──────
   QidStats is DERIVED: sync never merges it. Run after syncing AnswerEvents so both backends
   hold the same totals. Idempotent. Twin of rebuildqidstats in qstate.ts. */
function rebuildQidStats_(p) {
  if (!_syncAuthOk_(p)) return { success: false, code: "unauthorized", error: "unauthorized" };
  return withLock_(function () {
    const ev = qidRead_(QEVENTS_SHEET, getAnswerEventsSheet_).rows;
    const tally = {}, order = [];
    ev.forEach(function (e) {
      const qid = qidStr_(e.qid);
      if (!qid) return;
      if (!tally[qid]) { tally[qid] = { attempts: 0, wrong: 0, users: {} }; order.push(qid); }
      tally[qid].attempts++;
      if (String(e.ok) !== "true") tally[qid].wrong++;
      tally[qid].users[e.username] = true;
    });
    const tbl = qidRead_(QSTATS_SHEET, getQidStatsSheet_);
    const by = {};
    tbl.rows.forEach(function (r) { by[r.qid] = r; });
    const now = new Date().toISOString();
    order.forEach(function (qid) {
      const o = by[qid] || { qid: qid };
      o.attempts = String(tally[qid].attempts); o.wrong = String(tally[qid].wrong);
      o.students = String(Object.keys(tally[qid].users).length); o.updatedAt = now;
      qidWrite_(tbl, o);
    });
    _invalidateSheet_(QSTATS_SHEET);
    return { success: true, rebuilt: order.length, events: ev.length };
  });
}

/* ── re-score a weekly set by qid (explicit, dry-run by default) ─────── */

function adminRescoreWeeklySet_(p) {
  const chk = checkAdminCan_(p, "weeklysets_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const weeklyId = String(p.weeklyId || "").trim();
  if (!weeklyId) return { success: false, error: "weeklyId required." };
  const dryRun = String(p.dryRun === undefined ? "true" : p.dryRun) !== "false";

  const found = findWeeklySetRow_(getWeeklySetsSheet_(), weeklyId);
  if (!found) return { success: false, error: "Weekly set not found." };
  const ws = rowToWeeklySet_(found.row);
  const res = readJsonFileById_(ws.fileId);
  if (!res || !res.success) return { success: false, error: "Could not read the weekly file." };
  const raw = res.result;
  const rev = qidFileRev_(qidFlatten_(raw));

  return withLock_(function () {
    const sheet = getWeeklyAttemptsSheet_();
    const data = sheet.getDataRange().getValues();
    const changes = [];
    let examined = 0, legacySkipped = 0, changed = 0, failed = 0;
    /* Username order — the same deterministic order as the Supabase side — so the capped
       `changes` list shows the same subset on both backends. */
    const order = [];
    for (let i = 1; i < data.length; i++) if (String(data[i][1]).trim() === weeklyId) order.push(i);
    order.sort(function (a, b) { const x = String(data[a][0]), y = String(data[b][0]); return x < y ? -1 : x > y ? 1 : 0; });
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const at = rowToWeeklyAttempt_(data[i]);
      if (!Object.keys(at.answersByQid).length) { legacySkipped++; continue; }   /* pre-qid attempt: cannot be re-scored safely */
      examined++;
      const frozen = at.qids.length ? at.qids : ws.qids;
      const sc = weeklyScoreQid_({ raw: raw, frozenQids: frozen, answersByQid: at.answersByQid });
      if (!sc.ok) { failed++; continue; }
      const before = { correct: Number(data[i][4] || 0), total: Number(data[i][3] || 0), skipped: Number(data[i][5] || 0) };
      if (before.correct === sc.correct && before.total === sc.total && before.skipped === sc.skipped && String(data[i][11] || "") === rev) continue;
      changed++;
      if (changes.length < 50) changes.push({ username: data[i][0], before: before, after: { correct: sc.correct, total: sc.total, skipped: sc.skipped } });
      if (!dryRun) {
        sheet.getRange(i + 1, 4, 1, 3).setValues([[sc.total, sc.correct, sc.skipped]]);      /* totalQuestions, correctClaimed, skippedCount */
        sheet.getRange(i + 1, 12, 1, 2).setValues([[rev, JSON.stringify(sc.voided)]]);        /* fileRev, voided */
      }
    }
    if (!dryRun) _invalidateSheet_(WEEKLYATTEMPTS_SHEET);
    return { success: true, weeklyId: weeklyId, dryRun: dryRun, examined: examined, changed: changed, legacySkipped: legacySkipped, failed: failed, fileRev: rev, changes: changes };
  });
}

/* ── hard questions from the qid-keyed statistics ───────────────────── */

/* Returns the response object when QidStats has data, else null (caller uses the legacy scan). */
function qidHardQuestions_() {
  try {
    const rows = qidRead_(QSTATS_SHEET, getQidStatsSheet_).rows;
    if (!rows.length) return null;
    const qidMap = {};
    rows.forEach(function (r) {
      const n = Number(r.attempts || 0), w = Number(r.wrong || 0), u = Number(r.students || 0);
      if (n >= QID_HARD_MIN_ATTEMPTS_ && u >= QID_HARD_MIN_STUDENTS_) qidMap[r.qid] = Math.round((w / n) * 100);
    });
    return { success: true, map: {}, qidMap: qidMap, cached: false, source: "qid_stats" };
  } catch (e) { return null; }
}

/* ── bootstrap: one request for everything the app needs at start-up ── */

var QID_CAPABILITIES_ = ["bootstrap", "qid-weekly", "qstate", "recordanswers", "qidpatches", "resolveqids", "rev-concurrency"];

function bootstrapGas_(p) {
  /* checkSession may ROTATE the token; run it first and give every other part the fresh one. */
  const session = checkSession(p);
  if (!session || !session.success) return session || { success: false, error: "Session expired. Please log in again.", sessionInvalid: true };
  const p2 = {};
  Object.keys(p).forEach(function (k) { p2[k] = p[k]; });
  p2.token = session.token;
  function part(fn) { try { return fn(); } catch (e) { return { success: false, error: "unavailable" }; } }
  const c2 = {}; Object.keys(p2).forEach(function (k) { c2[k] = p2[k]; }); c2.since = p.correctionsSince;
  const q2 = {}; Object.keys(p2).forEach(function (k) { q2[k] = p2[k]; }); q2.since = p.qstateSince; q2.limit = p.qstateLimit;
  return {
    success: true, serverNow: new Date().toISOString(), capabilities: QID_CAPABILITIES_,
    session: session,
    settings: part(function () { return getSettings(); }),
    corrections: part(function () { return getCorrections(c2); }),
    weekly: part(function () { return listWeeklySets(p2); }),
    qstate: p.qstateSince !== undefined ? part(function () { return syncQState_(q2); }) : null
  };
}

/* ── routes ─────────────────────────────────────────────────────────── */

var QID_ROUTES_ = {
  bootstrap: bootstrapGas_,
  syncqstate: syncQState_,
  recordanswers: recordAnswers_,
  getqidpatches: getQidPatches_,
  resolveqids: resolveQids_,
  adminqidcoverage: adminQidCoverage_,
  ingestquestionindex: ingestQuestionIndex_,
  rebuildqidstats: rebuildQidStats_,
  adminrescoreweeklyset: adminRescoreWeeklySet_,
  /* Pipeline endpoints (admin-reports.gs). Lazy lookups: Apps Script loads files in no fixed order. */
  syncreportssince: function (p) { return adminReportsSince_(p); },
  resolvereports: function (p) { return adminReportsResolve_(p); },
  admincorrect: function (p) { return adminReportsCorrect_(p); }
};

function QID_HANDLE_(action, params) {
  const fn = QID_ROUTES_[String(action || "").toLowerCase()];
  return fn ? fn(params || {}) : null;
}
