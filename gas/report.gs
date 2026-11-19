/* ═══════════════════════════════════════════════════════════════════════
   gas/report.gs — the backend half of the Abhyas reporting system.

   Paste into the Apps Script project as a NEW file called report.gs. It
   shares the global scope of code.gs and setup.gs, so functions here can
   call withLock_, getSpreadsheet_, logAction_, checkAdminCan_, authUser_,
   sanitizeSheetField_, readJsonFileById_, setSettingValue_,
   getSettingValue_, _isoOf_, _submissionDayBound_, and the rest of
   code.gs's helpers, and vice versa.

   ── WHEN LINKING IN ───────────────────────────────────────────────────
   Report.gs and code.gs are both loaded into the same Apps Script
   project, so they share one global namespace. Every name this file
   defines must be removed from code.gs, or the two definitions silently
   shadow each other (the later-loaded file wins).

   DELETE from code.gs — the schema and sheet helpers:

       const QREPORT_HEADERS = …
       const QREPORT_REASONS = …
       const QREPORT_SECTIONS = …
       const CORRECTIONS_SETTING_KEY = …
       const MAX_CORRECTIONS_KEPT = …
       function getQReportsSheet_() { … }
       function rowToQReport_(row) { … }
       function findQReportRow_(sheet, id) { … }
       function normalizeReportPayload_(p) { … }
       function updateCorrectionsMap_(map, fileId, nowMs, max) { … }
       function correctionsSince_(map, since) { … }
       function readCorrectionsMap_() { … }
       function markFileCorrected_(fileId) { … }
       function getCorrections(p) { … }
       function reportQuestion(p) { … }
       function adminListQuestionReports(p) { … }
       function adminUpdateQuestionReportStatus(p) { … }
       function adminMarkFileCorrected(p) { … }
       function adminDeleteQuestionReport(p) { … }
       function adminGetQuestion(p) { … }
       function adminUpdateQuestion(p) { … }
       function _questionArray_(raw) { … }
       function _pickKey_(obj, names) { … }
       function _questionView_(q) { … }

   AND from code.gs's doGet switch — these eight case statements:

       case "getcorrections":                   result = getCorrections(e.parameter); break;
       case "reportquestion":                   result = reportQuestion(e.parameter); break;
       case "adminlistquestionreports":         result = adminListQuestionReports(e.parameter); break;
       case "adminupdatequestionreportstatus":  result = adminUpdateQuestionReportStatus(e.parameter); break;
       case "adminmarkfilecorrected":           result = adminMarkFileCorrected(e.parameter); break;
       case "admindeletequestionreport":        result = adminDeleteQuestionReport(e.parameter); break;
       case "admingetquestion":                 result = adminGetQuestion(e.parameter); break;
       case "adminupdatequestion":              result = adminUpdateQuestion(e.parameter); break;

   AND REPLACE code.gs's doGet default case with:

       default: {
         const handled = REPORT_HANDLE_(action, e.parameter);
         if (handled !== null) { result = handled; break; }
         result = { success: false, error: "Unknown action: '" + action + "'." };
       }

   What stays in code.gs: QREPORTS_SHEET, MAX_LIST_QREPORTS, APP_VERSION,
   MAX_JSON_FILE_BYTES, and every helper (withLock_, _findRowFast_,
   _cachedSheetData_, _invalidateSheet_, _getOrCreateSheet_, _topUpHeaders_,
   _isoOf_, _submissionDayBound_, safeEqual_, checkRateLimit_, logAction_,
   authUser_, checkAdminCan_, sanitizeSheetField_, readJsonFileById_,
   setSettingValue_, getSettingValue_, getOrCreateFolder_).

   If any of the eight case statements is left behind, that endpoint keeps
   working but the router (REPORT_HANDLE_) is never consulted for it, and
   a later edit that removes them all at once can silently break it.

   tests/check.js already has a guard ('Apps Script global names') that
   fails if any name is defined twice across gas/*.gs — linking in without
   the delete will be caught by `npm test`.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── Schema ──────────────────────────────────────────────────────────
   Column 18 (index 17) is new: the corrected snapshot, written by
   adminUpdateQuestion so the console can show before/after and export
   the corrected question without re-reading the file from Drive.
   _topUpHeaders_ adds the column on the next sheet touch. */
const QREPORT_HEADERS = [
  "id","uid","fileId","questionSnapshot","reason","note","reportedBy","reportedAt","status",
  "optionsSnapshot","correctIndex","chosenIndex","section","appVersion","resolvedAt","resolvedBy","corrected",
  "correctedSnapshot","qid",
  "updatedAt"   /* server-set "last changed" time: the cursor the pipeline's syncreportssince reads */
];
const QREPORT_REASONS = ["wrong_answer","unclear","typo","incomplete","image_problem","other"];
const QREPORT_SECTIONS = [
  "practice","exam","daily-paper","weekly","hourly",
  "results","review-missed","review-saved","review-flagged","other"
];

/* fileId -> time (ms) the admin said that file was corrected. Private, so
   it is not in the public settings. */
const CORRECTIONS_SETTING_KEY = "private_corrections";
const MAX_CORRECTIONS_KEPT = 400;

/* ── Sheets ────────────────────────────────────────────────────────── */
function getQReportsSheet_() {
  const sheet = _getOrCreateSheet_(
    QREPORTS_SHEET, QREPORT_HEADERS, [1,2,3],
    "#d81b60", SpreadsheetApp.BandingTheme.PINK, 340
  );
  _topUpHeaders_(sheet, QREPORT_HEADERS, "#d81b60");
  return sheet;
}
function findQReportRow_(sheet, id) { return id ? _findRowFast_(sheet, 1, id) : null; }

/* A public question id is either a legacy numeric id ("48213") or a
   hyphenated one ("a-123-456-789012"). It is stored, compared and returned as
   the canonical lowercase STRING: a hyphenated id cannot survive Number(),
   which yields NaN and turns every such correction into qid null. Mirrors
   qidString() in the Supabase Edge Function so both backends agree. */
function normalizeQReportQid_(v) {
  const s = String(v == null ? "" : v).trim();
  if (/^\d+$/.test(s)) return s;
  if (/^[A-Za-z0-9]{1,3}-[0-9]{3}-[0-9]{3}-[0-9]{6}$/.test(s)) {
    return s.replace(/[^A-Za-z0-9-]/g, "").toLowerCase();
  }
  /* Ids as actually published in abhyasapp/content: "<fileId>-<position>",
     e.g. "1-VeNFb81ynETihERKfWNUOZSqrYopyOH-1". The old pattern rejected every
     one of them, so qid was stored as "". Case is preserved: the fileId part
     is case-sensitive for every other consumer. */
  if (/^[A-Za-z0-9_-]{1,200}-\d{1,5}$/.test(s)) return s;
  /* The public qn id the pipeline writes to public_qn: level token, chapter,
     subtopic and sequence, either dotted ("50011.110001", "G0011.110001") or
     flat, the only shape that can carry a word subtopic ("5002mixedqn10001").
     Both were rejected before, so such a question fell back to its position.
     Lowercased like every other public id. */
  if (/^[A-Za-z0-9][A-Za-z0-9._]{3,63}$/.test(s) && /\d/.test(s)) {
    return s.toLowerCase();
  }
  return "";
}

/* Fields a content question may carry its stable id on, and the lookup order:
   internal qid first, then the public qn id on any of these keys, then the
   position - only when no id was supplied at all. Mirrors questionIndexFor()
   in the Supabase Edge Function so both backends resolve a question the same
   way. Returns -1 when an id was supplied but matches nothing. */
const QREPORT_QID_FIELDS = ["id", "qid", "qnid", "publicId", "publicQid", "code"];
function qidMatchesGas_(candidate, wanted) {
  if (!wanted) return false;
  const raw = String(candidate == null ? "" : candidate).trim();
  if (!raw) return false;
  if (raw === wanted) return true;
  if (raw.toLowerCase() === wanted.toLowerCase()) return true;
  const norm = normalizeQReportQid_(raw);
  return !!norm && norm === wanted;
}
function questionIndexForId_(arr, index, qid) {
  if (!qid) return index;
  for (let f = 0; f < QREPORT_QID_FIELDS.length; f++) {
    const field = QREPORT_QID_FIELDS[f];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && qidMatchesGas_(arr[i][field], qid)) return i;
    }
  }
  return -1;
}

/* ── Row → object. Parses the correctedSnapshot column (index 17). ── */
function rowToQReport_(row) {
  const uid = String(row[1] || "");
  const m = uid.match(/^(.+)_(\d+)$/);
  let options = [];
  try { const o = JSON.parse(row[9] || "[]"); if (Array.isArray(o)) options = o; } catch (e) {}
  const num = v => (v === "" || v === null || v === undefined) ? null : Number(v);
  let correctedSnapshot = null;
  if (row.length > 17 && row[17]) {
    try {
      const o = JSON.parse(row[17]);
      if (o && typeof o === "object") correctedSnapshot = o;
    } catch (e) {}
  }
  return {
    id: row[0] || "",
    uid: uid,
    qid: row.length > 18 ? (normalizeQReportQid_(row[18]) || null) : null,
    fileId: row[2] || "",
    questionNumber: m ? Number(m[2]) + 1 : null,
    questionSnapshot: row[3] || "",
    reason: row[4] || "",
    note: row[5] || "",
    reportedBy: row[6] || "",
    reportedAt: row[7] || "",
    status: row[8] || "open",
    options: options,
    correctIndex: num(row[10]),
    chosenIndex: num(row[11]),
    section: row[12] || "",
    appVersion: row[13] || "",
    resolvedAt: row[14] || "",
    resolvedBy: row[15] || "",
    corrected: String(row[16]).toLowerCase() === "true",
    correctedSnapshot: correctedSnapshot,
    updatedAt: row.length > 19 ? qreportIso_(row[19]) : ""
  };
}

/* ── Payload validation (pure) ─────────────────────────────────────── */
function normalizeReportPayload_(p) {
  const uid = String(p.uid || "").trim().slice(0, 200);
  if (!uid) return { error: "Missing question reference." };
  if (!/^[A-Za-z0-9_.:-]+$/.test(uid)) return { error: "Invalid question reference." };
  const reason = String(p.reason || "").trim();
  if (QREPORT_REASONS.indexOf(reason) === -1) return { error: "Invalid report reason." };
  const m = uid.match(/^(.+)_(\d+)$/);
  const idx = v => {
    const n = Number(v);
    return (v !== "" && v !== null && v !== undefined &&
            isFinite(n) && n >= 0 && n < 10 && Math.floor(n) === n)
      ? n : "";
  };
  let opts = p.optionsSnapshot;
  if (typeof opts === "string") {
    try { opts = JSON.parse(opts); } catch (e) { opts = null; }
  }
  const optionsSnapshot = Array.isArray(opts)
    ? JSON.stringify(opts.slice(0, 6).map(o =>
        String(o == null ? "" : o).replace(/[\r\n]+/g, " ").slice(0, 200)
      )).slice(0, 1200)
    : "";
  const section = QREPORT_SECTIONS.indexOf(String(p.section || "")) !== -1
    ? String(p.section) : "other";
  return { value: {
    uid: uid,
    qid: normalizeQReportQid_(p.qid),
    fileId: m ? m[1] : uid,
    reason: reason,
    note: sanitizeSheetField_(String(p.note || "").trim().slice(0, 500)),
    snapshot: sanitizeSheetField_(String(p.questionSnapshot || "").trim().slice(0, 1000)),
    optionsSnapshot: optionsSnapshot,
    correctIndex: idx(p.correctIndex),
    chosenIndex: idx(p.chosenIndex),
    section: section,
    appVersion: String(p.appVersion || "").replace(/[^0-9A-Za-z._-]/g, "").slice(0, 12)
  }};
}

/* ── Corrections map (pure helpers + reader/writer) ───────────────── */
function updateCorrectionsMap_(map, fileId, nowMs, max) {
  const out = {};
  Object.keys(map || {}).forEach(k => {
    if (isFinite(Number(map[k]))) out[k] = Number(map[k]);
  });
  out[fileId] = nowMs;
  const keys = Object.keys(out);
  if (keys.length > max) {
    keys.sort((a, b) => out[a] - out[b])
      .slice(0, keys.length - max)
      .forEach(k => delete out[k]);
  }
  return out;
}
function correctionsSince_(map, since) {
  const out = {}, s = Number(since) || 0;
  Object.keys(map || {}).forEach(k => {
    const t = Number(map[k]);
    if (isFinite(t) && t > s) out[k] = t;
  });
  return out;
}
function readCorrectionsMap_() {
  try {
    const o = JSON.parse(String(getSettingValue_(CORRECTIONS_SETTING_KEY, "{}")));
    return (o && typeof o === "object" && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}
function markFileCorrected_(fileId) {
  if (!fileId) return;
  setSettingValue_(
    CORRECTIONS_SETTING_KEY,
    JSON.stringify(updateCorrectionsMap_(
      readCorrectionsMap_(), fileId, Date.now(), MAX_CORRECTIONS_KEPT
    ))
  );
}

/* ── Endpoints: student side ───────────────────────────────────────── */

function getCorrections(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const since = Number(p.since) || 0;
  const mine = [];
  try {
    const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;
    const me = auth.username.toLowerCase();
    for (let i = data.length - 1; i >= 1 && mine.length < 10; i--) {
      if (String(data[i][6]).toLowerCase() !== me) continue;
      if (String(data[i][8]) !== "resolved") continue;
      const at = new Date(_isoOf_(data[i][14])).getTime();
      if (isFinite(at) && at > since) {
        mine.push({ uid: String(data[i][1]), at: at });
      }
    }
  } catch (e) {}
  return {
    success: true,
    now: Date.now(),
    files: correctionsSince_(readCorrectionsMap_(), since),
    resolvedMine: mine
  };
}

function reportQuestion(p) {
  const auth = authUser_(p);
  if (!auth.ok) return auth.error;
  const username = auth.username;
  const norm = normalizeReportPayload_(p);
  if (norm.error) return { success: false, error: norm.error };
  const r = norm.value;
  if (!checkRateLimit_("qreport_" + username.toLowerCase(), 30, 60 * 60 * 1000)) {
    return { success: false, error: "Too many reports \u2014 please try again later." };
  }
  return withLock_(() => {
    const sheet = getQReportsSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if ((String(data[i][1]) === r.uid || (r.qid && normalizeQReportQid_(data[i][18]) === r.qid)) &&
          String(data[i][6]) === username &&
          String(data[i][8]) === "open") {
        return { success: true, message: "You've already reported this question \u2014 it's in the queue." };
      }
    }
    sheet.appendRow([
      Utilities.getUuid(), r.uid, r.fileId, r.snapshot, r.reason, r.note,
      username, new Date().toISOString(), "open",
      r.optionsSnapshot, r.correctIndex, r.chosenIndex, r.section, r.appVersion,
      "", "", "", "", r.qid, new Date().toISOString()
    ]);
    _invalidateSheet_(QREPORTS_SHEET);
    return { success: true, message: "Thanks \u2014 this has been sent for review." };
  });
}

/* ── Endpoints: admin side ─────────────────────────────────────────── */

function adminListQuestionReports(p) {
  const chk = checkAdminCan_(p, "qreports_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;
  const totalCount = Math.max(0, data.length - 1);
  const limit = Math.min(totalCount, MAX_LIST_QREPORTS);
  const reports = [];
  for (let i = data.length - 1; i >= data.length - limit; i--) {
    reports.push(rowToQReport_(data[i]));
  }
  const openBy = {};
  reports.forEach(r => {
    if (r.status === "open") {
      const key = r.qid ? "q:" + r.qid : "u:" + r.uid;
      (openBy[key] = openBy[key] || {})[r.reportedBy] = true;
    }
  });
  reports.forEach(r => {
    const key = r.qid ? "q:" + r.qid : "u:" + r.uid;
    r.openReporters = r.status === "open"
      ? Object.keys(openBy[key] || {}).length : 0;
  });
  reports.sort((a, b) => {
    if (a.status === "open" && b.status !== "open") return -1;
    if (a.status !== "open" && b.status === "open") return 1;
    if (a.status === "open" && b.status === "open" &&
        b.openReporters !== a.openReporters) {
      return b.openReporters - a.openReporters;
    }
    return new Date(b.reportedAt) - new Date(a.reportedAt);
  });
  return {
    success: true, reports: reports,
    totalCount: totalCount, truncated: totalCount > MAX_LIST_QREPORTS
  };
}

function adminUpdateQuestionReportStatus(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const id = String(p.id || "").trim();
  const status = String(p.status || "").trim();
  if (!id) return { success: false, error: "id required." };
  if (["open", "resolved", "dismissed"].indexOf(status) === -1) {
    return { success: false, error: "Status must be open, resolved, or dismissed." };
  }
  const signal = status === "resolved" && String(p.corrected) !== "false";

  return withLock_(() => {
    const sheet = getQReportsSheet_();
    const found = findQReportRow_(sheet, id);
    if (!found) return { success: false, error: "Report not found." };
    const stamp = status === "open"
      ? ["", "", ""]
      : [new Date().toISOString(), actor, signal ? "TRUE" : ""];
    const changedAt = new Date().toISOString();
    sheet.getRange(found.rowIndex, 9).setValue(status);
    sheet.getRange(found.rowIndex, 15, 1, 3).setValues([stamp]);
    sheet.getRange(found.rowIndex, 20).setValue(changedAt);
    let alsoClosed = 0;
    if (status === "resolved") {
      const data = sheet.getDataRange().getValues();
      const uid = String(found.row[1] || "");
      const qid = normalizeQReportQid_(found.row[18]);
      for (let i = 1; i < data.length; i++) {
        if (i + 1 === found.rowIndex) continue;
        if ((String(data[i][1]) === uid || (qid && normalizeQReportQid_(data[i][18]) === qid)) &&
            String(data[i][8]) === "open") {
          sheet.getRange(i + 1, 9).setValue("resolved");
          sheet.getRange(i + 1, 15, 1, 3).setValues([stamp]);
          sheet.getRange(i + 1, 20).setValue(changedAt);
          alsoClosed++;
        }
      }
    }
    _invalidateSheet_(QREPORTS_SHEET);
    if (signal) markFileCorrected_(String(found.row[2] || ""));
    logAction_(actor, "Update Question Report", id,
      "Status: " + status +
      (signal ? " (students told to refresh the file)" : "") +
      (alsoClosed
        ? "; also closed " + alsoClosed + " other report(s) on this question"
        : ""));
    return {
      success: true, id: id, status: status,
      alsoClosed: alsoClosed, refreshed: signal
    };
  });
}

function adminMarkFileCorrected(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const fileId = String(p.fileId || "").trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
    return { success: false, error: "That does not look like a Drive file id." };
  }
  return withLock_(() => {
    markFileCorrected_(fileId);
    setSettingValue_("contentVersion", String(Date.now()));
    logAction_(chk.actor, "Refresh Question File", fileId,
      "Students' apps will replace their copy");
    return { success: true };
  });
}

function adminDeleteQuestionReport(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;
  const id = String(p.id || "").trim();
  if (!id) return { success: false, error: "id required." };
  return withLock_(() => {
    const sheet = getQReportsSheet_();
    const found = findQReportRow_(sheet, id);
    if (!found) return { success: false, error: "Report not found." };
    sheet.deleteRow(found.rowIndex);
    _invalidateSheet_(QREPORTS_SHEET);
    logAction_(actor, "Delete Question Report", id, "");
    return { success: true, deleted: id };
  });
}

/* One-time export of the whole Q-reports sheet as JSON (for migrating to
   Neon). Run from the editor; it writes gas_reports.json to your Google
   Drive root and logs the download link. */
function exportAllQReports() {
  return withLock_(() => {
    const sheet = getQReportsSheet_();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return { success: true, count: 0, rows: [] };
    const headers = data[0];
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const r = {};
      for (let j = 0; j < headers.length; j++) r[headers[j]] = data[i][j];
      rows.push(r);
    }
    const json = JSON.stringify({ success: true, count: rows.length, rows: rows });
    const file = DriveApp.createFile('gas_reports.json', json, MimeType.PLAIN_TEXT);
    console.log('gas_reports.json created: ' + file.getUrl());
    return { success: true, count: rows.length, fileId: file.getId(), url: file.getUrl() };
  });
}

/* Bulk clear of the Q-reports sheet (run once from the editor after
   migrating reports to Neon). Keeps the header row. */
function clearAllQReports() {
  return withLock_(() => {
    const sheet = getQReportsSheet_();
    const last = sheet.getLastRow();
    if (last <= 1) return { success: true, cleared: 0 };
    sheet.deleteRows(2, last - 1);
    _invalidateSheet_(QREPORTS_SHEET);
    logAction_('system', 'Clear All Q Reports', 'bulk', '');
    return { success: true, cleared: last - 1 };
  });
}

/* ── Question editor helpers ──────────────────────────────────────── */

/* Shared with gas/content-index.gs. Keep this one definition; the copy in
   code.gs must be deleted (see the header). */
function _questionArray_(raw) {
  /* ONE traversal order shared with the Supabase side and the app (qid-core.gs). */
  const arr = qidFlatten_(raw);
  return (Array.isArray(raw) || arr.length) ? arr : null;
}
function _pickKey_(obj, names) {
  for (let i = 0; i < names.length; i++) {
    if (Object.prototype.hasOwnProperty.call(obj, names[i])) return names[i];
  }
  return null;
}
function _questionView_(q) {
  const tk = _pickKey_(q, ["q", "question", "Question", "stem", "ques", "text"]);
  const ok = _pickKey_(q, ["options", "opts", "choices", "Options"]);
  const ck = _pickKey_(q, ["correct", "answer", "ans", "Answer"]);
  const ek = _pickKey_(q, ["explanation", "explain", "exp", "solution", "hint"]);
  let correct = ck ? q[ck] : null;
  if (typeof correct === "string" && /^[a-eA-E]$/.test(correct.trim())) {
    correct = "abcde".indexOf(correct.trim().toLowerCase());
  }
  correct = (correct === null || correct === "" || isNaN(Number(correct)))
    ? null : Number(correct);
  return {
    q: tk ? String(q[tk]) : "",
    options: (ok && Array.isArray(q[ok])) ? q[ok].map(String) : [],
    correct: correct,
    explanation: ek ? String(q[ek] || "") : "",
    keys: { text: tk, options: ok, correct: ck, explanation: ek }
  };
}

function adminGetQuestion(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const fileId = String(p.fileId || "").trim();
  const index = Number(p.index);
  const qid = normalizeQReportQid_(p.qid);
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId) || !(index >= 0)) {
    return { success: false, error: "Invalid question reference." };
  }
  const cache = CacheService.getScriptCache();
  const cacheKey = "aq_" + fileId + "_" + index + (qid ? "_" + qid : "");
  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      const hit = JSON.parse(cached);
      if (hit && hit.question) {
        return { success: true, index: hit.at, qid: qid || hit.qid || null, rev: hit.rev || "", overlay: { applied: 0, skipped: 0 }, total: hit.total, question: hit.question, cached: true };
      }
    }
  } catch (e) {}
  const res = readJsonFileById_(fileId);
  if (!res.success) return res;
  const arr = _questionArray_(res.result);
  if (!arr) return { success: false, error: "That question was not found in the file." };
  const at = questionIndexForId_(arr, index, qid);
  if (at < 0) {
    return { success: false, error: "That question is no longer in the file - reopen the report." };
  }
  if (!arr[at] || typeof arr[at] !== "object") {
    return { success: false, error: "That question was not found in the file." };
  }
  /* A read without a qid may only target a question that has no stable id of its own. */
  if (!qid && !qidPositionWriteAllowed_(arr, at)) {
    return { success: false, error: "This question has a stable id; send its qid.", code: "qid_required" };
  }
  const view = _questionView_(arr[at]);
  if (!view.keys.text || !view.keys.options || view.options.length < 2) {
    return { success: false, error: "This question uses a format the editor cannot change. Edit the JSON file in Drive instead." };
  }
  const out = {
    success: true, index: at, qid: qid || qidPrimary_(arr[at]).qid || null, rev: qidQuestionRev_(arr[at]),
    overlay: { applied: 0, skipped: 0 }, total: arr.length,
    question: {
      q: view.q, options: view.options,
      correct: view.correct, explanation: view.explanation
    }
  };
  try { cache.put(cacheKey, JSON.stringify({ at: out.index, total: out.total, question: out.question, rev: out.rev, qid: out.qid }), 120); } catch (e) {}
  return out;
}

function adminUpdateQuestion(p) {
  const chk = checkAdminCan_(p, "qreports_manage");
  if (!chk.ok) return { success: false, error: chk.error };
  const actor = chk.actor;

  const fileId = String(p.fileId || "").trim();
  const index = Number(p.index);
  const expected = String(p.expectedQ || "").trim();
  const qid = normalizeQReportQid_(p.qid);
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId) || !(index >= 0)) {
    return { success: false, error: "Invalid question reference." };
  }

  let fields;
  try {
    fields = (p.fields && typeof p.fields === "object")
      ? p.fields : JSON.parse(p.fields || "{}");
  } catch (e) { return { success: false, error: "The changes were not understood." }; }

  const newQ = String(fields.q || "").trim().slice(0, 2000);
  const options = Array.isArray(fields.options)
    ? fields.options.map(o => String(o == null ? "" : o).trim().slice(0, 500))
    : [];
  const correct = Number(fields.correct);
  const explanation = String(fields.explanation || "").trim().slice(0, 3000);
  if (!newQ) return { success: false, error: "The question text cannot be empty." };
  if (options.length < 2 || options.length > 6 || options.some(o => !o)) {
    return { success: false, error: "Every option needs text (2 to 6 options)." };
  }
  if (!(correct >= 0 && correct < options.length) ||
      Math.floor(correct) !== correct) {
    return { success: false, error: "Choose which option is correct." };
  }

  return withLock_(() => {
    let file;
    try { file = DriveApp.getFileById(fileId); }
    catch (e) {
      return { success: false, error: "Could not open the question file. (" + (e.message || e) + ")" };
    }
    if (file.getSize() > MAX_JSON_FILE_BYTES) {
      return { success: false, error: "The file is too large to edit here." };
    }

    let raw;
    try { raw = JSON.parse(file.getBlob().getDataAsString("UTF-8")); }
    catch (e) { return { success: false, error: "The question file is not valid JSON." }; }
    const arr = _questionArray_(raw);
    if (!arr) return { success: false, error: "That question was not found in the file." };
    const at = questionIndexForId_(arr, index, qid);
    if (at < 0) {
      return { success: false, error: "That question is no longer in the file - reopen the report." };
    }
    if (!arr[at] || typeof arr[at] !== "object") {
      return { success: false, error: "That question was not found in the file." };
    }

    const q = arr[at];
    const view = _questionView_(q);
    if (!view.keys.text || !view.keys.options) {
      return { success: false, error: "This question uses a format the editor cannot change." };
    }
    /* Identity first: a qid-less edit may only target a question with no stable id. */
    if (!qid && !qidPositionWriteAllowed_(arr, at)) {
      return { success: false, error: "This question has a stable id; send its qid.", code: "qid_required" };
    }
    /* By qid the concurrency guard is the question REVISION (what students see: text,
       options, answer, explanation) — `baseRev` from adminGetQuestion. Same token, same
       hash as the Supabase side. A qid-less edit keeps the text guard below. */
    const curRev = qidQuestionRev_(q);
    const baseRev = String(p.baseRev || "").trim();
    if (qid && baseRev && baseRev !== curRev) {
      return { success: false, error: "This question was changed by someone else since you opened it. Reload it.", code: "rev_conflict", currentRev: curRev };
    }
    const resolvedQid = qid || qidPrimary_(q).qid;
    if (!qid && view.q.trim() !== expected) {
      return {
        success: false,
        error: "The file changed since you opened it. Close this and open the report again."
      };
    }

    /* The pipeline matches on this snapshot, so it must be the file's
       current text and options verbatim - including a printed "51." and
       every option at full length. The report's own snapshot is trimmed
       for display and cannot be used. */
    const beforeEdit = {
      question: String(view.q),
      options: (view.options || []).map(String),
      correctIndex: (typeof view.correct === "number" && isFinite(view.correct))
        ? view.correct : null
    };
    const editUid = "corr_" + Utilities.getUuid();
    const editAt = new Date().toISOString();

    /* The snapshot written into every matching report row. Without this the
       loop below throws a ReferenceError inside a try/catch, so the sheet
       silently never receives the before/after pair the console reads. */
    /* The revision this edit produces, computed on a copy BEFORE anything is written. */
    const projected = JSON.parse(JSON.stringify(q));
    projected[view.keys.text] = newQ; projected[view.keys.options] = options;
    projected[view.keys.correct || "correct"] = correct; projected[view.keys.explanation || "explanation"] = explanation;
    const newRev = qidQuestionRev_(projected);
    const correctedJson = JSON.stringify({
      uid: editUid, at: editAt, baseRev: curRev, newRev: newRev,
      before: beforeEdit,
      after: {
        question: newQ, options: options,
        correctIndex: correct, explanation: explanation
      },
      /* Legacy top-level shape, still read by adminListCorrections. */
      q: newQ, options: options, correct: correct, explanation: explanation
    });

    /* One explicit full-file copy per day. Drive also keeps every previous
       version, but a separate copy is easier to find if something goes badly
       wrong. Making one on every save was the slow part. */
    try {
      const props = PropertiesService.getScriptProperties();
      const backupKey = "backup_day_" + fileId;
      const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
      if (String(props.getProperty(backupKey) || "") !== today) {
        file.makeCopy("daily-backup_" + today + "_" + file.getName(),
          getOrCreateFolder_("QuestionEditBackups"));
        props.setProperty(backupKey, today);
      }
    } catch (e) {
      return { success: false, error: "Could not make today's backup, so nothing was changed." };
    }

    q[view.keys.text] = newQ;
    q[view.keys.options] = options;
    const ck = view.keys.correct || "correct";
    const orig = q[ck];
    if (typeof orig === "string" && /^[a-eA-E]$/.test(orig.trim())) {
      q[ck] = (orig.trim() === orig.trim().toLowerCase())
        ? "abcde".charAt(correct)
        : "ABCDE".charAt(correct);
    } else if (typeof orig === "string") {
      q[ck] = String(correct);
    } else {
      q[ck] = correct;
    }
    q[view.keys.explanation || "explanation"] = explanation;

    try { file.setContent(JSON.stringify(raw, null, 2)); }
    catch (e) {
      return { success: false, error: "Could not write the file: " + (e.message || e) };
    }
    try { CacheService.getScriptCache().remove("aq_" + fileId + "_" + index); } catch (e) {}

    /* Store the corrected question on every report for this file+index,
       so the console always has a before/after pair without re-reading
       Drive. One setValues call, not one setValue per matching row — a
       question with fifty reporters would otherwise block every other
       request on the script lock for the length of fifty writes. */
    try {
      const reportsSheet = getQReportsSheet_();
      const lastRow = reportsSheet.getLastRow();
      if (lastRow > 1) {
        /* Match reports by the question's IDENTITY. The old lookup keyed on
           "<fileId>_<requested position>", which misses reports filed while the question
           sat elsewhere AND stamps reports about whatever else sits at that position now.
           Without a qid (legacy question) the located position is the only identity left. */
        const byQid = !!resolvedQid;
        const hits = byQid
          ? reportsSheet.getRange(2, 19, lastRow - 1, 1).createTextFinder(resolvedQid).matchCase(false).matchEntireCell(true).findAll()
          : reportsSheet.getRange(2, 2, lastRow - 1, 1).createTextFinder(fileId + "_" + at).matchCase(true).matchEntireCell(true).findAll();
        if (hits.length) {
          const rows = hits.map(function (r) { return r.getRow(); });
          const lo = Math.min.apply(null, rows);
          const hi = Math.max.apply(null, rows);
          const col = reportsSheet.getRange(lo, 18, hi - lo + 1, 1);
          const vals = col.getValues();
          rows.forEach(function (rowIdx) { vals[rowIdx - lo][0] = correctedJson; });
          col.setValues(vals);
          /* The snapshot changed, so these reports "changed": move their cursor. */
          const stampCol = reportsSheet.getRange(lo, 20, hi - lo + 1, 1);
          const stampVals = stampCol.getValues();
          rows.forEach(function (rowIdx) { stampVals[rowIdx - lo][0] = editAt; });
          stampCol.setValues(stampVals);
          _invalidateSheet_(QREPORTS_SHEET);
        }
      }
    } catch (e) {
      /* The correctedSnapshot is a convenience, not the record of truth:
         the file itself already holds the fix. A failed write here must
         not stop the save. */
      console.error("adminUpdateQuestion: could not store correctedSnapshot:", e);
    }

    /* The file edit has to happen here (Drive), but the admin console and the
       correction pipeline read Supabase. Mirror the same per-edit snapshot
       before returning so the fix is visible immediately instead of waiting
       for the nightly sheet sync. */
    try {
      mirrorCorrectionToSupabase_(
        fileId, at, beforeEdit,
        { question: newQ, options: options, correctIndex: correct, explanation: explanation },
        editUid, editAt, actor, String(p.reportId || ""),
        String(p.reportReason || ""), String(p.adminNote || ""),
        resolvedQid, curRev, newRev
      );
    } catch (e) {
      console.error("adminUpdateQuestion: Supabase mirror failed:", e);
    }

    qidRegisterFile_(fileId, arr);   /* keep the qid registry (rev, derived position) current */
    setSettingValue_("contentVersion", String(Date.now()));
    markFileCorrected_(fileId);
    logAction_(actor, "Edit Question", fileId + "#" + at,
      "Question text, options, answer or explanation changed (daily backup + Drive revision)");
    return { success: true, qid: resolvedQid || null, rev: newRev };
  });
}

/* ── Immediate Supabase mirror ──────────────────────────────────────
   The Drive file is the source of truth for the question, but reports and
   corrections are read from Supabase. A sheet-only write leaves the console
   and the pipeline on the old row until the nightly sync, which is why
   "Fix the question" looked saved but stayed stale. This runs before the
   response returns.

   Existing rows are updated in place. A legacy report that only ever lived in
   the sheet gets a resolved row with the report id, so the console's follow-up
   status call and the pipeline can both find it. */
function mirrorCorrectionToSupabase_(fileId, index, beforeEdit, after, editUid, editAt, actor, reportId, reason, note, qid, baseRev, newRev) {
  if (typeof bridgeRequest_ !== "function") return false;

  const enc = encodeURIComponent;
  const uid = fileId + "_" + index;
  const snapshot = JSON.stringify({
    uid: editUid, at: editAt, baseRev: baseRev || "", newRev: newRev || "",
    before: beforeEdit,
    after: {
      question: after.question, options: after.options,
      correctIndex: after.correctIndex, explanation: after.explanation
    },
    q: after.question, options: after.options, correct: after.correctIndex,
    explanation: after.explanation
  });
  /* Supabase stores the flag lower-case and the pipeline filters on
     corrected=eq.true; "TRUE" would be silently skipped. */
  const patch = {
    corrected_snapshot: snapshot,
    correct_index: String(after.correctIndex),
    corrected: "true",
    /* Repair a legacy row whose file_id was blank so the next by-uid lookup
       and the corrections list stay linked to the file. */
    file_id: fileId
  };

  /* One qid-keyed event in the log the pipeline reads, exactly like a Supabase-side edit
     (so a correction made here reaches the pipeline and the other backend identically). */
  mirrorCorrectionEvent_(fileId, uid, qid, beforeEdit, after, editAt, actor, reportId, note, baseRev, newRev);

  /* Reports are matched by the question's qid when it has one. "<file>_<position>" is only
     the fallback for a legacy question with no id — position alone would hit the wrong rows. */
  const byUid = bridgeRequest_("patch",
    qid
      ? "/rest/v1/question_reports?qid=eq." + enc(qid)
      : "/rest/v1/question_reports?uid=eq." + enc(uid) + "&file_id=eq." + enc(fileId), patch);
  if (byUid.ok && Array.isArray(byUid.data) && byUid.data.length) {
    if (!reportId || byUid.data.some(function (r) { return String(r.id) === reportId; })) return true;
  }
  let byId = { ok: false, data: [] };
  if (reportId) {
    byId = bridgeRequest_("patch", "/rest/v1/question_reports?id=eq." + enc(reportId), patch);
  }
  if (byId.ok && Array.isArray(byId.data) && byId.data.length) return true;

  /* Bridge disabled (no SUPABASE_SERVICE_ROLE_KEY) or no report id: nothing
     to insert. A normal edit with an existing Supabase row already returned. */
  if (byUid.disabled || !reportId) return false;

  const ins = bridgeRequest_("post", "/rest/v1/question_reports", {
    id: reportId,
    uid: uid,
    file_id: fileId,
    question_snapshot: String(beforeEdit.question || ""),
    options_snapshot: JSON.stringify(beforeEdit.options || []),
    correct_index: String(after.correctIndex),
    chosen_index: "",
    reason: reason || "admin_edit",
    note: note || "",
    reported_by: actor,
    reported_at: editAt,
    status: "resolved",
    resolved_at: editAt,
    resolved_by: actor,
    corrected: "true",
    corrected_snapshot: snapshot,
    section: "",
    app_version: ""
  });
  return !!ins.ok;
}

/* ── Corrections list + export ─────────────────────────────────────
   Every report that was closed by actually fixing the question,
   deduped by (fileId, question index). Returns both a flat list (for
   export and the UI) and a map keyed by fileId -> { index -> entry }
   so any file-preview screen can look up its marks in O(1). */
function adminListCorrections(p) {
  const chk = checkAdminCan_(p, "qreports_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;
  const byFile = {};
  const all = [];
  const seen = new Set();
  for (let i = 1; i < data.length; i++) {
    const r = rowToQReport_(data[i]);
    if (r.status !== "resolved" || !r.corrected) continue;
    const key = r.fileId + "#" +
      (r.questionNumber != null ? r.questionNumber : r.uid);
    if (seen.has(key)) continue;   /* many students can report one question: keep the newest */
    seen.add(key);
    const entry = {
      id: r.id,
      uid: r.uid,
      fileId: r.fileId,
      questionNumber: r.questionNumber,
      reason: r.reason,
      note: r.note || "",
      reportedBy: r.reportedBy,
      reportedAt: r.reportedAt,
      correctedAt: r.resolvedAt,
      correctedBy: r.resolvedBy,
      oldSnapshot: {
        question: r.questionSnapshot,
        options: r.options || [],
        correctIndex: r.correctIndex
      },
      newSnapshot: r.correctedSnapshot ? {
        question: r.correctedSnapshot.q,
        options: r.correctedSnapshot.options || [],
        correctIndex: r.correctedSnapshot.correct,
        explanation: r.correctedSnapshot.explanation || ""
      } : null
    };
    all.push(entry);
    const idx = r.questionNumber != null ? r.questionNumber - 1 : null;
    if (idx !== null) {
      byFile[r.fileId] = byFile[r.fileId] || {};
      byFile[r.fileId][idx] = entry;
    }
  }
  all.sort((a, b) => new Date(b.correctedAt) - new Date(a.correctedAt));
  return {
    success: true, all: all, byFile: byFile, totalCount: all.length
  };
}

function adminExportCorrections(p) {
  const chk = checkAdminCan_(p, "qreports_view");
  if (!chk.ok) return { success: false, error: chk.error };
  const r = adminListCorrections({ adminToken: p.adminToken });
  if (!r.success) return r;
  let list = r.all;
  const fileFilter = String(p.fileId || "").trim();
  if (fileFilter) list = list.filter(c => c.fileId === fileFilter);
  /* _submissionDayBound_ (code.gs) is the ONE date parser used across the
     backend: it accepts YYYY-MM-DD, an ISO string or epoch ms, and returns
     null for anything it cannot read. Using the same helper here means a
     future fix to date handling applies to reports, submissions and this
     export in one edit. */
  const fromT = p.dateFrom ? _submissionDayBound_(p.dateFrom, false) : null;
  const toT   = p.dateTo   ? _submissionDayBound_(p.dateTo,   true)  : null;
  if (fromT !== null) {
    list = list.filter(c => {
      const t = new Date(c.correctedAt).getTime();
      return isFinite(t) && t >= fromT;
    });
  }
  if (toT !== null) {
    list = list.filter(c => {
      const t = new Date(c.correctedAt).getTime();
      return isFinite(t) && t <= toT;
    });
  }
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    totalCorrections: list.length,
    corrections: list.map(c => ({
      fileId: c.fileId,
      questionIndex: c.questionNumber != null ? c.questionNumber - 1 : null,
      uid: c.uid,
      reason: c.reason,
      note: c.note || "",
      reportedBy: c.reportedBy,
      reportedAt: c.reportedAt,
      correctedAt: c.correctedAt,
      correctedBy: c.correctedBy,
      before: c.oldSnapshot,
      after: c.newSnapshot
    }))
  };
  return {
    success: true,
    json: JSON.stringify(payload, null, 2),
    filename: "abhyas-corrections-" +
      new Date().toISOString().slice(0, 10) + ".json",
    count: list.length
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   DRIVETONEONTODRIVE SYNC — read-only endpoint
   Auth by SYNC_KEY only. Called once per pipeline run.
   ═══════════════════════════════════════════════════════════════════════ */

function setSyncKey() {
  const key = Utilities.getUuid().replace(/-/g, "")
            + Utilities.getUuid().replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty("SYNC_KEY", key);
  console.log("SYNC_KEY = " + key);
  return key;
}

function syncCorrectionsSince(p) {
  const key = String(p.key || "");
  const expected = PropertiesService
    .getScriptProperties()
    .getProperty("SYNC_KEY");
  if (!expected) {
    return {
      success: false, code: "not_configured",
      error: "Sync endpoint not configured. Run generateSyncKey() in the Apps Script editor."
    };
  }
  if (!key || !safeEqual_(key, expected)) {
    return {
      success: false, code: "unauthorized", unauthorized: true,
      error: "ABHYAS_SYNC_KEY does not match SYNC_KEY in the Apps Script project."
    };
  }

  const since = Math.max(0, Number(p.since) || 0);
  const limit = Math.max(1, Math.min(500, Number(p.limit) || 500));

  const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;
  const byKey = {};

  for (let i = 1; i < data.length; i++) {
    const r = rowToQReport_(data[i]);
    if (r.status !== "resolved" || !r.corrected) continue;

    const snap = r.correctedSnapshot || null;
    if (!snap) continue;

    /* Current shape: {uid, at, before, after}. Legacy rows stored only the
       after side at the top level; accept both. */
    const after = (snap.after && typeof snap.after === "object")
      ? snap.after
      : (snap.q != null
          ? { question: snap.q, options: snap.options,
              correctIndex: snap.correct, explanation: snap.explanation }
          : null);
    if (!after || !String(after.question || "").trim()) continue;

    /* `since` means "at or after": the watermark is the newest correctedAt
       we sent, so equality must not skip rows sharing that millisecond. */
    const atMs = new Date(snap.at || r.resolvedAt).getTime();
    if (!isFinite(atMs) || atMs < since) continue;

    const before = (snap.before && typeof snap.before === "object")
      ? snap.before
      : { question: r.questionSnapshot || "", options: r.options || [],
          correctIndex: r.correctIndex };

    const m = String(r.uid || "").match(/^(.+)_(\d+)$/);
    const ac = after.correctIndex;
    const entry = {
      /* Per-edit id: half of the (uid, corrected_at) idempotency key, so a
         second edit or a Restore is not mistaken for already_applied. */
      uid: String(snap.uid || r.id || r.uid),
      qid: r.qid || null,
      /* ISO-8601 string: a timestamptz column rejects epoch-ms integers. */
      correctedAt: new Date(atMs).toISOString(),
      fileId: r.fileId,
      questionIndex: m ? Number(m[2]) : null,
      questionNumber: r.questionNumber,
      reason: r.reason,
      note: r.note || "",
      reportedBy: r.reportedBy,
      reportedAt: r.reportedAt,
      correctedBy: r.resolvedBy,
      before: {
        question: String(before.question || ""),
        options: (Array.isArray(before.options) ? before.options : []).map(String)
      },
      after: {
        question: String(after.question || ""),
        options: (Array.isArray(after.options) ? after.options : []).map(String),
        /* Integer 0..len-1, or null. A string "2" or true is unanswered. */
        correctIndex: (typeof ac === "number" && isFinite(ac) &&
                       Math.floor(ac) === ac && ac >= 0) ? ac : null,
        explanation: String(after.explanation || "")
      }
    };

    const k = entry.uid + "|" + entry.correctedAt;
    if (!byKey[k]) byKey[k] = entry;
  }

  const list = Object.keys(byKey).map(k => byKey[k]);
  list.sort((a, b) =>
    (new Date(a.correctedAt).getTime() - new Date(b.correctedAt).getTime()) ||
    String(a.uid).localeCompare(String(b.uid)));
  const out = list.slice(0, limit);
  const last = out.length ? out[out.length - 1] : null;

  /* The watermark trap: never move past rows cut off by `limit`. Return the
     newest correctedAt actually sent (wall clock only when nothing matched).
     The boundary row is re-sent and skipped downstream as already_applied. */
  return {
    success: true,
    now: last ? new Date(last.correctedAt).getTime() : Date.now(),
    count: out.length,
    total: list.length,
    truncated: list.length > out.length,
    corrections: out
  };
}

/* ── Router for code.gs's doGet default case ───────────────────────── */
const REPORT_ROUTES_ = {
  reportquestion:                  function (p) { return reportQuestion(p); },
  getcorrections:                  function (p) { return getCorrections(p); },
  adminlistquestionreports:        function (p) { return adminListQuestionReports(p); },
  adminupdatequestionreportstatus: function (p) { return adminUpdateQuestionReportStatus(p); },
  admindeletequestionreport:       function (p) { return adminDeleteQuestionReport(p); },
  clearallqreports:                function (p) { return clearAllQReports(); },
  exportallqreports:               function (p) { return exportAllQReports(); },
  admingetquestion:                function (p) { return adminGetQuestion(p); },
  adminupdatequestion:             function (p) { return adminUpdateQuestion(p); },
  adminmarkfilecorrected:          function (p) { return adminMarkFileCorrected(p); },
  adminlistcorrections:            function (p) { return adminListCorrections(p); },
  adminexportcorrections:          function (p) { return adminExportCorrections(p); },
  synccorrectionssince:            function (p) { return syncCorrectionsSince(p); }
};

/* Returns the result object for a report action, or null for anything
   else, so code.gs can fall through to its own "Unknown action". */
function REPORT_HANDLE_(action, params) {
  const fn = REPORT_ROUTES_[String(action || "").toLowerCase()];
  return fn ? fn(params || {}) : null;
}

/* Writes the qid-keyed correction event. (dedupe_key, corrected_at) is unique, so a retry is
   a harmless 409. base_rev/new_rev are retried without if the 20261117 migration has not been
   applied yet, so the mirror never fails just because Supabase is one migration behind. */
function mirrorCorrectionEvent_(fileId, uid, qid, before, after, editAt, actor, reportId, note, baseRev, newRev) {
  if (typeof bridgeRequest_ !== "function") return false;
  const row = {
    dedupe_key: qid ? "q" + qid : "u" + uid,
    uid: qid ? "q" + qid : uid,
    qid: qid || "", file_id: fileId, report_id: reportId || "",
    corrected_at: editAt,
    before: JSON.stringify(before), after: JSON.stringify(after),
    note: note || "", admin_user: actor, created_at: new Date().toISOString(),
    base_rev: baseRev || "", new_rev: newRev || ""
  };
  let r = bridgeRequest_("post", "/rest/v1/correction_events", row);
  if (!r.ok && r.status !== 409 && !r.disabled) {
    delete row.base_rev; delete row.new_rev;
    r = bridgeRequest_("post", "/rest/v1/correction_events", row);
  }
  return !!(r.ok || r.status === 409);
}
