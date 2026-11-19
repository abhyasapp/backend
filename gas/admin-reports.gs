/* ═══════════════════════════════════════════════════════════════════════
   gas/admin-reports.gs — the pipeline's three report endpoints.

     syncreportssince  (sync key)   reports CHANGED since a cursor (new, resolved, re-opened)
     resolvereports    (sync key)   the pipeline closes / re-opens reports
     admincorrect      (admin key)  validate a fix by qn id and start the GitHub workflow

   Same actions, same JSON contract as supabase/functions/api/handlers/pipeline.ts
   (docs/PIPELINE-CONTRACT.md), pinned by tests/parity-handlers.test.mjs.

   Adapted from the supplied AdminReports.gs. What changed, and why:
   • resolvereports writes the SHEET first (the sheet is what the app is served from and what
     sync reads), then mirrors to Supabase. The supplied module patched only Supabase: with the
     old "gas-wins" sync rule the next sync would have reverted every resolution.
   • '' where the module sent null. Every question_reports column is NOT NULL DEFAULT '', so a
     null (used for every re-open) is rejected as a write error.
   • `corrected` is stored "TRUE" / "" like the rest of the sheet, never the string "false".
   • "changed since" reads a server-stamped updatedAt, not the caller-supplied resolvedAt.
   • Secrets accepted under either name (ABHYAS_SYNC_KEY or SYNC_KEY; SUPABASE_SERVICE_KEY or
     SUPABASE_SERVICE_ROLE_KEY) so renaming one cannot silently lock the pipeline out.
   • admincorrect refuses to run if the admin key equals the sync key (they must be separate),
     is rate limited, and publishes ONLY when publish is exactly true / "true".

   Paste into the Apps Script project as a NEW file called admin-reports.gs.
   Routing is wired in qid.gs (QID_ROUTES_), so no change to doPost is needed.
   ═══════════════════════════════════════════════════════════════════════ */

var ADMIN_REPORTS_CFG_ = {
  githubRepo: "abhyasapp/DRIVETONEONTODRIVE",
  workflow: "apply_admin_corrections.yml",
  ref: "main",
  maxResolveBatch: 200,
  maxCorrections: 50,
  maxDispatchChars: 60000,      /* GitHub caps every workflow input at 65,535 chars */
  maxSince: 1000,
  correctRateMax: 60,           /* dispatches per hour: stops a leaked key from spamming Actions */
  correctRateWindowMs: 60 * 60 * 1000
};

/* ── secrets / small helpers ────────────────────────────────────────── */

function adminReportsProp_(name) { return PropertiesService.getScriptProperties().getProperty(name) || ""; }
function adminReportsSyncKey_() { return adminReportsProp_("ABHYAS_SYNC_KEY") || adminReportsProp_("SYNC_KEY"); }
function adminReportsAdminKey_() { return adminReportsProp_("ABHYAS_ADMIN_KEY"); }

/* Constant-time over the longer of the two strings, so neither content NOR length leaks. */
function adminSafeEqual_(a, b) {
  a = String(a === null || a === undefined ? "" : a); b = String(b === null || b === undefined ? "" : b);
  if (!a || !b) return false;
  var diff = a.length ^ b.length, n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* Sheets turns ISO-looking strings into Date cells; String(date) is not ISO. Normalise. */
function qreportIso_(v) {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString();
  const t = new Date(String(v)).getTime();
  return isFinite(t) ? new Date(t).toISOString() : String(v);
}
function qreportMs_(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (v instanceof Date) return v.getTime() || 0;
  const t = new Date(String(v)).getTime();
  return isFinite(t) ? t : 0;
}
function qreportNum_(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

const ADMIN_UNAUTHORIZED_ = { success: false, error: "unauthorized" };

/* ── syncreportssince ───────────────────────────────────────────────── */

/* Rows that predate the updatedAt column get it once: the latest of reportedAt / resolvedAt /
   the correction time. Cheap no-op afterwards. */
function qreportEnsureUpdatedAt_(sheet) {
  const data = sheet.getDataRange().getValues();
  const fill = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i].length > 19 && String(data[i][19] || "") !== "") continue;
    let t = Math.max(qreportMs_(data[i][7]), qreportMs_(data[i][14]));
    try { const snap = JSON.parse(data[i][17] || "null"); if (snap && snap.at) t = Math.max(t, qreportMs_(snap.at)); } catch (e) {}
    if (t) fill.push([i + 1, new Date(t).toISOString()]);
  }
  fill.forEach(function (f) { sheet.getRange(f[0], 20).setValue(f[1]); });
  if (fill.length) _invalidateSheet_(QREPORTS_SHEET);
  return fill.length;
}

function adminReportsSince_(p) {
  if (!adminSafeEqual_(p.key, adminReportsSyncKey_())) return ADMIN_UNAUTHORIZED_;
  const since = Math.max(0, Number(p.since) || 0);
  const limit = Math.max(1, Math.min(ADMIN_REPORTS_CFG_.maxSince, Number(p.limit) || ADMIN_REPORTS_CFG_.maxSince));

  const sheet = getQReportsSheet_();
  withLock_(function () { qreportEnsureUpdatedAt_(sheet); return null; });
  const data = _cachedSheetData_(QREPORTS_SHEET, getQReportsSheet_).data;

  const list = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    /* changed-at = the newest of the server-stamped updatedAt and the caller-supplied times
       (the latter only as a fallback for a row that somehow has no updatedAt). */
    const at = Math.max(qreportMs_(r[19]), qreportMs_(r[14]), qreportMs_(r[7]));
    if (!at) continue;
    /* `since` is INCLUSIVE: the cursor is the newest change already delivered, so equality must
       not skip a sibling that shares its millisecond. The boundary row is re-sent; the pipeline
       upserts by id, so that is harmless. */
    if (since && at < since) continue;
    list.push({
      at: at,
      item: {
        id: String(r[0] || ""), uid: String(r[1] || ""), qid: normalizeQReportQid_(r[18]) || null,
        fileId: String(r[2] || ""), questionSnapshot: String(r[3] || ""), optionsSnapshot: String(r[9] || ""),
        correctIndex: qreportNum_(r[10]), chosenIndex: qreportNum_(r[11]),
        reason: String(r[4] || ""), note: String(r[5] || ""), reportedBy: String(r[6] || ""),
        reportedAt: qreportIso_(r[7]), status: String(r[8] || "open"),
        resolvedAt: qreportIso_(r[14]), resolvedBy: String(r[15] || ""),
        corrected: String(r[16]).toLowerCase() === "true", correctedSnapshot: String(r[17] || ""),
        section: String(r[12] || ""), appVersion: String(r[13] || ""),
        updatedAt: qreportIso_(r[19]) || new Date(at).toISOString()
      }
    });
  }
  list.sort(function (a, b) { return (a.at - b.at) || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0); });
  const page = list.slice(0, limit);
  /* `now` is the newest change actually RETURNED (never the wall clock, never past rows cut off by
     `limit`). With nothing to send it stays at `since`, so the cursor cannot skip a write that was
     still in flight. */
  return {
    success: true, reports: page.map(function (x) { return x.item; }), count: page.length,
    total: list.length, truncated: list.length > page.length,
    now: page.length ? page[page.length - 1].at : since
  };
}

/* ── resolvereports ─────────────────────────────────────────────────── */

function adminReportsValidateResolve_(items) {
  const cfg = ADMIN_REPORTS_CFG_;
  if (!Array.isArray(items) || !items.length) return { error: "items must be a non-empty list" };
  if (items.length > cfg.maxResolveBatch) return { error: "too many items in one call" };
  const out = [], seen = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const id = String(it.id === null || it.id === undefined ? "" : it.id);
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) return { error: "item " + i + ": bad id" };
    if (it.status !== "open" && it.status !== "resolved") return { error: "item " + i + ": bad status" };
    const snap = it.correctedSnapshot === null || it.correctedSnapshot === undefined ? "" : String(it.correctedSnapshot);
    if (snap.length > 20000) return { error: "item " + i + ": snapshot too large" };
    const when = it.resolvedAt ? new Date(it.resolvedAt) : null;
    if (when && isNaN(when.getTime())) return { error: "item " + i + ": bad resolvedAt" };
    if (seen[id]) continue;                      /* the same id twice in one call is one write */
    seen[id] = true;
    out.push({
      id: id, status: it.status,
      resolvedAt: when ? when.toISOString() : "",
      resolvedBy: it.resolvedBy ? String(it.resolvedBy).slice(0, 100) : "",
      corrected: it.corrected === true || it.corrected === "true",
      correctedSnapshot: snap
    });
  }
  return { items: out };
}

/* The exact column values an item means. Re-opening clears everything the resolve set. */
function adminReportsTarget_(item) {
  const resolved = item.status === "resolved";
  const corrected = resolved && item.corrected;
  return {
    status: item.status,
    resolvedAt: resolved ? item.resolvedAt : "",     /* "" here = "keep the existing time, else now" */
    resolvedBy: resolved ? item.resolvedBy : "",
    corrected: corrected,
    correctedSnapshot: corrected ? item.correctedSnapshot : ""
  };
}

/* Writes one item into the sheet. Returns "unchanged" | "written". A repeat of the same call
   writes nothing, so it neither re-stamps updatedAt nor re-sends the row downstream. */
function adminReportsWriteSheetRow_(sheet, found, target, nowIso) {
  const row = found.row;
  const curStatus = String(row[8] || "open");
  const curResolvedAt = qreportIso_(row[14]);
  const resolvedAt = target.status === "resolved" ? (target.resolvedAt || curResolvedAt || nowIso) : "";
  const curCorrected = String(row[16]).toLowerCase() === "true";
  const curSnap = String(row[17] || "");
  const same = curStatus === target.status
    && (target.status !== "resolved" || curResolvedAt === resolvedAt)
    && String(row[15] || "") === target.resolvedBy
    && curCorrected === target.corrected
    && curSnap === target.correctedSnapshot
    && (target.status === "resolved" || curResolvedAt === "");
  if (same) return { change: "unchanged", resolvedAt: resolvedAt };
  sheet.getRange(found.rowIndex, 9).setValue(target.status);
  sheet.getRange(found.rowIndex, 15, 1, 4).setValues([[resolvedAt, target.resolvedBy, target.corrected ? "TRUE" : "", target.correctedSnapshot]]);
  sheet.getRange(found.rowIndex, 20).setValue(nowIso);
  return { change: "written", resolvedAt: resolvedAt };
}

function adminReportsResolve_(p) {
  if (!adminSafeEqual_(p.key, adminReportsSyncKey_())) return ADMIN_UNAUTHORIZED_;
  const checked = adminReportsValidateResolve_(typeof p.items === "string" ? adminReportsParse_(p.items) : p.items);
  if (checked.error) return { success: false, error: checked.error };

  return withLock_(function () {
    const sheet = getQReportsSheet_();
    const nowIso = new Date().toISOString();
    const sheetHit = {}, sheetErr = {}, resolvedAtUsed = {};

    /* 1. The sheet: what the app is served from and what sync reads. */
    checked.items.forEach(function (item) {
      try {
        const found = findQReportRow_(sheet, item.id);
        if (!found) return;
        sheetHit[item.id] = true;
        resolvedAtUsed[item.id] = adminReportsWriteSheetRow_(sheet, found, adminReportsTarget_(item), nowIso).resolvedAt;
      } catch (e) { sheetErr[item.id] = true; }
    });
    _invalidateSheet_(QREPORTS_SHEET);

    /* 2. Mirror to Supabase when the bridge is configured. One batched round trip. */
    const sbHit = {}, sbErr = {};
    const cfg = bridgeConfig_();
    if (cfg.key) {
      const reqs = checked.items.map(function (item) {
        const t = adminReportsTarget_(item);
        const resolvedAt = t.status === "resolved" ? (t.resolvedAt || resolvedAtUsed[item.id] || nowIso) : "";
        return {
          url: cfg.url + "/rest/v1/question_reports?id=eq." + encodeURIComponent(item.id),
          method: "patch", contentType: "application/json", muteHttpExceptions: true,
          headers: { apikey: cfg.key, Authorization: "Bearer " + cfg.key, Prefer: "return=representation" },
          payload: JSON.stringify({
            status: t.status, resolved_at: resolvedAt, resolved_by: t.resolvedBy,
            corrected: t.corrected ? "true" : "", corrected_snapshot: t.correctedSnapshot
          })
        };
      });
      let resps = [];
      try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { resps = []; }
      checked.items.forEach(function (item, i) {
        const resp = resps[i];
        if (!resp) { sbErr[item.id] = true; return; }
        const code = resp.getResponseCode();
        if (code >= 200 && code < 300) {
          let rows = [];
          try { rows = JSON.parse(resp.getContentText() || "[]"); } catch (e) { rows = []; }
          if (rows.length) sbHit[item.id] = true;
        } else sbErr[item.id] = true;
      });
    }

    /* 3. Classify. A write error in a store that matters means "retry me", not "missing". */
    const updated = [], missing = [], failed = [];
    checked.items.forEach(function (item) {
      const id = item.id;
      if (sheetErr[id] || sbErr[id]) failed.push(id);
      else if (sheetHit[id] || sbHit[id]) updated.push(id);
      else missing.push(id);
    });
    return { success: true, updated: updated, missing: missing, failed: failed };
  });
}

function adminReportsParse_(s) { try { return JSON.parse(s); } catch (e) { return null; } }

/* ── admincorrect ───────────────────────────────────────────────────── */

function adminReportsValidateCorrections_(items) {
  const cfg = ADMIN_REPORTS_CFG_;
  if (!Array.isArray(items) || !items.length) return { error: "items must be a non-empty list" };
  if (items.length > cfg.maxCorrections) return { error: "at most " + cfg.maxCorrections + " corrections per call" };
  const seen = {}, out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {}, tag = "item " + i + ": ";
    const qn = String(it.qn === null || it.qn === undefined ? "" : it.qn).trim();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(qn)) return { error: tag + "bad qn id" };
    if (seen[qn]) return { error: tag + "duplicate qn id " + qn };
    seen[qn] = true;
    const question = String(it.question === null || it.question === undefined ? "" : it.question).trim();
    if (!question || question.length > 2000) return { error: tag + "question must be 1-2000 chars" };
    const options = it.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 10) return { error: tag + "need 2-10 options" };
    const cleaned = [];
    for (let j = 0; j < options.length; j++) {
      const o = String(options[j] === null || options[j] === undefined ? "" : options[j]).trim();
      if (!o || o.length > 1000) return { error: tag + "option " + j + " must be 1-1000 chars" };
      cleaned.push(o);
    }
    const ci = it.correctIndex;
    if (typeof ci !== "number" || ci % 1 !== 0 || ci < 0 || ci >= cleaned.length) {
      return { error: tag + "correctIndex must be an integer inside the options" };
    }
    const explanation = it.explanation === null || it.explanation === undefined ? "" : String(it.explanation);
    if (explanation.length > 4000) return { error: tag + "explanation too long" };
    out.push({ qn: qn, question: question, options: cleaned, correctIndex: ci, explanation: explanation, note: it.note ? String(it.note).slice(0, 200) : "" });
  }
  return { items: out };
}

function adminReportsDispatchBody_(items, publish) {
  const json = JSON.stringify(items);
  if (json.length > ADMIN_REPORTS_CFG_.maxDispatchChars) return { error: "payload too large for one workflow run; send fewer corrections" };
  /* Publishing republishes the question JSON to Drive, which students see. Only an explicit
     true / "true" does that; an omitted or garbled flag never publishes. */
  const doPublish = publish === true || publish === "true";
  return {
    body: {
      ref: adminReportsProp_("GITHUB_REF") || ADMIN_REPORTS_CFG_.ref,
      inputs: { corrections_json: json, publish: doPublish ? "true" : "false" }
    }
  };
}

function adminReportsCorrect_(p) {
  const adminKey = adminReportsAdminKey_();
  if (!adminSafeEqual_(p.adminKey, adminKey)) return ADMIN_UNAUTHORIZED_;
  /* The admin key must be its own secret: if it equals the sync key, anything that can read the
     pipeline secret could also dispatch workflows. */
  if (adminSafeEqual_(adminKey, adminReportsSyncKey_())) return { success: false, error: "ABHYAS_ADMIN_KEY must differ from the sync key" };
  const checked = adminReportsValidateCorrections_(typeof p.items === "string" ? adminReportsParse_(p.items) : p.items);
  if (checked.error) return { success: false, error: checked.error };
  const built = adminReportsDispatchBody_(checked.items, p.publish);
  if (built.error) return { success: false, error: built.error };

  const token = adminReportsProp_("GITHUB_TOKEN");
  if (!token) return { success: false, error: "GITHUB_TOKEN not set" };
  if (!checkRateLimit_("admincorrect", ADMIN_REPORTS_CFG_.correctRateMax, ADMIN_REPORTS_CFG_.correctRateWindowMs)) {
    return { success: false, error: "too many corrections dispatched; try again later" };
  }
  const repo = adminReportsProp_("GITHUB_REPO") || ADMIN_REPORTS_CFG_.githubRepo;
  const workflow = adminReportsProp_("GITHUB_WORKFLOW") || ADMIN_REPORTS_CFG_.workflow;
  const resp = UrlFetchApp.fetch("https://api.github.com/repos/" + repo + "/actions/workflows/" + workflow + "/dispatches", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    payload: JSON.stringify(built.body)
  });
  if (resp.getResponseCode() !== 204) return { success: false, error: "GitHub dispatch failed (HTTP " + resp.getResponseCode() + ")" };
  return { success: true, queued: checked.items.length };
}

/* Compatibility with the supplied wiring ("first thing in doPost"): not needed here because
   QID_ROUTES_ already routes these actions through doGet, but harmless if someone calls it. */
function adminReportsRoute_(req) {
  if (!req || ["resolvereports", "admincorrect", "syncreportssince"].indexOf(req.action) < 0) return null;
  const fn = { resolvereports: adminReportsResolve_, admincorrect: adminReportsCorrect_, syncreportssince: adminReportsSince_ }[req.action];
  let result;
  try { result = fn(req); } catch (err) { result = { success: false, error: String((err && err.message) || err) }; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
