/* ═══════════════════════════════════════════════════════════════════════
   gas/sync.gs — bidirectional sync endpoints for the GitHub Action.
   Auth: SYNC_KEY (Script Properties). Both actions are POST-only
   (see POST_ONLY_ACTIONS in code.gs) so the key never appears in a URL.

   POST {action:"syncpull", key, tables:"users,payments"}
        → { tables:{name:[row,...]}, headers:{name:[col,...]}, errors:{} }
   POST {action:"syncpush", key, tables:{name:[row,...]}, deletes:{name:[{keyCol:val,...}]}}
        → { results:{name:{inserted,updated,skipped,deleted}}, errors:{} }

   Rows are matched by the table's (possibly composite) key, so
   weekly_attempts / weekly_starts / admin_permissions never collapse.
   Wrapped in withLock_ so it cannot race with student writes.
   ═══════════════════════════════════════════════════════════════════════ */

function _syncAuthOk_(p) {
  const expected = PropertiesService.getScriptProperties().getProperty("SYNC_KEY");
  const key = String((p && p.key) || "");
  if (!expected || !key) return false;
  return safeEqual_(key, expected);
}

/* table → { sheet getter, sheet name, key columns (GAS header names) } */
/* A function (not a top-level const) on purpose: Apps Script loads project
   files in an unspecified order and these constants live in code.gs. */
function syncTables_() {
  return {
  users:                  { get: function () { return getUsersSheet_(); },           name: USERS_SHEET,            key: ["username"] },
  admins:                 { get: function () { return getAdminsSheet_(); },          name: ADMINS_SHEET,           key: ["username"] },
  admin_permissions:      { get: function () { return getAdminPermsSheet_(); },      name: ADMIN_PERMS_SHEET,      key: ["username", "featureKey"] },
  settings:               { get: function () { return getSettingsSheet_(); },        name: SETTINGS_SHEET,         key: ["key"] },
  payments:               { get: function () { return getPaymentsSheet_(); },        name: PAYMENTS_SHEET,         key: ["username"] },
  progress:               { get: function () { return getProgressSheet_(); },        name: PROGRESS_SHEET,         key: ["username"] },
  progress_history:       { get: function () { return getProgressHistorySheet_(); }, name: PROGRESS_HISTORY_SHEET, key: ["username"] },
  progress_backups:       { get: function () { return getProgressBackupsSheet_(); }, name: PROGRESS_BACKUPS_SHEET, key: ["backupId"] },
  push_tokens:            { get: function () { return getPushTokensSheet_(); },      name: PUSHTOKENS_SHEET,       key: ["username"] },
  weekly_sets:            { get: function () { return getWeeklySetsSheet_(); },      name: WEEKLYSETS_SHEET,       key: ["id"] },
  weekly_starts:          { get: function () { return getWeeklyStartsSheet_(); },    name: WEEKLYSTARTS_SHEET,     key: ["username", "weeklyId"] },
  weekly_attempts:        { get: function () { return getWeeklyAttemptsSheet_(); },  name: WEEKLYATTEMPTS_SHEET,   key: ["username", "weeklyId"] },
  question_reports:       { get: function () { return getQReportsSheet_(); },        name: QREPORTS_SHEET,         key: ["id"] },
  subjective_submissions: { get: function () { return getSubjSubmissionsSheet_(); }, name: SUBJ_SUBMISSIONS_SHEET, key: ["id"] },
  study_docs:             { get: function () { return getStudyDocsSheet_(); },       name: STUDYDOCS_SHEET,        key: ["id"] },
  question_index:         { get: function () { return getQuestionIndexSheet_(); },   name: QINDEX_SHEET,           key: ["qid"] },
  user_qstate:            { get: function () { return getUserQStateSheet_(); },      name: QSTATE_SHEET,           key: ["username", "qid"] },
  answer_events:          { get: function () { return getAnswerEventsSheet_(); },    name: QEVENTS_SHEET,          key: ["username", "qid", "at"] },
  qid_stats:              { get: function () { return getQidStatsSheet_(); },        name: QSTATS_SHEET,           key: ["qid"] }
  };
}

/* Supabase-side columns GAS keeps outside the sheet. */
const SYNC_MUSTCHANGE_FIELD_ = "must_change_password";

function _syncKeyOf_(keyCols, obj) {
  return keyCols.map(function (c) { return String(obj[c] === null || obj[c] === undefined ? "" : obj[c]).toLowerCase().trim(); }).join("|");
}

/* ── PULL ───────────────────────────────────────────────────────────── */
function syncPull(p) {
  if (!_syncAuthOk_(p)) return { success: false, error: "auth failed" };

  const requested = String(p.tables || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const tables = {};
  const headersOut = {};
  const errors = {};

  requested.forEach(function (name) {
    const def = syncTables_()[name];
    if (!def) { errors[name] = "unknown table"; return; }
    try {
      const sheet = def.get();
      const lastRow = sheet.getLastRow();
      const lastCol = sheet.getLastColumn();
      const headers = lastCol >= 1
        ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h); })
        : [];
      headersOut[name] = headers;
      if (lastRow < 2) { tables[name] = []; return; }
      const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      tables[name] = rows.map(function (row) {
        const obj = {};
        headers.forEach(function (h, i) { obj[h] = row[i]; });
        if (name === "admins") obj[SYNC_MUSTCHANGE_FIELD_] = adminMustChangePassword_(obj.username) ? "true" : "false";
        return obj;
      });
    } catch (e) {
      errors[name] = String(e && e.message ? e.message : e);
    }
  });

  return {
    success: true, backend: "gas", version: APP_VERSION,
    serverTime: Date.now(), tables: tables, headers: headersOut, errors: errors
  };
}

/* ── PUSH ───────────────────────────────────────────────────────────── */
function syncPush(p) {
  if (!_syncAuthOk_(p)) return { success: false, error: "auth failed" };

  const parseObj = function (v, label) {
    if (v === undefined || v === null || v === "") return {};
    if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) { throw new Error(label + " must be a JSON object"); } }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(label + " must be a JSON object");
    return v;
  };
  let incoming, deletes;
  try { incoming = parseObj(p.tables, "tables"); deletes = parseObj(p.deletes, "deletes"); }
  catch (e) { return { success: false, error: String(e.message || e) }; }

  return withLock_(function () {
    const results = {};
    const errors = {};

    Object.keys(incoming).concat(Object.keys(deletes)).filter(function (n, i, a) { return a.indexOf(n) === i; }).forEach(function (name) {
      const def = syncTables_()[name];
      if (!def) { errors[name] = "unknown table"; return; }
      const rowsIn = Array.isArray(incoming[name]) ? incoming[name] : [];
      const delIn = Array.isArray(deletes[name]) ? deletes[name] : [];
      if (!rowsIn.length && !delIn.length) { results[name] = { inserted: 0, updated: 0, skipped: 0, deleted: 0 }; return; }

      try {
        const sheet = def.get();
        const lastCol = sheet.getLastColumn();
        /* Trim, the same way _topUpHeaders_ reads them, so a header saved with
           stray whitespace is not "missing" here and "present" there. */
        const headers = lastCol >= 1 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
        if (!headers.length) { errors[name] = "sheet has no headers"; return; }
        const missingKey = def.key.filter(function (c) { return headers.indexOf(c) === -1; });
        if (missingKey.length) { errors[name] = "sheet is missing key column(s): " + missingKey.join(","); return; }
        const keyIdx = def.key.map(function (c) { return headers.indexOf(c); });

        const keyOfRow = function (row) {
          return keyIdx.map(function (i) { return String(row[i] === null || row[i] === undefined ? "" : row[i]).toLowerCase().trim(); }).join("|");
        };

        const lastRow = sheet.getLastRow();
        const existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
        const rowByKey = {};
        existing.forEach(function (row, i) {
          const k = keyOfRow(row);
          if (k.replace(/\|/g, "")) rowByKey[k] = i + 2;
        });

        let inserted = 0, updated = 0, skipped = 0, deleted = 0;

        /* upserts */
        const newRows = [];
        rowsIn.forEach(function (rec) {
          if (!rec || typeof rec !== "object") { skipped++; return; }
          const k = _syncKeyOf_(def.key, rec);
          if (!k.replace(/\|/g, "")) { skipped++; return; }

          if (name === "admins" && rec[SYNC_MUSTCHANGE_FIELD_] !== undefined) {
            setAdminMustChange_(rec.username, String(rec[SYNC_MUSTCHANGE_FIELD_]).toLowerCase() === "true");
          }

          const rowOut = headers.map(function (h, ci) {
            if (rec[h] === undefined) {
              /* column not supplied → keep what the sheet already has (GAS-only columns survive) */
              const at = rowByKey[k];
              return at ? existing[at - 2][ci] : "";
            }
            return rec[h] === null ? "" : rec[h];
          });

          const target = rowByKey[k];
          if (target) { sheet.getRange(target, 1, 1, headers.length).setValues([rowOut]); updated++; }
          else { newRows.push(rowOut); inserted++; rowByKey[k] = -1; }
        });
        if (newRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);

        /* deletes — bottom-up so row numbers stay valid */
        if (delIn.length) {
          const doomed = [];
          delIn.forEach(function (rec) {
            if (!rec || typeof rec !== "object") return;
            const k = _syncKeyOf_(def.key, rec);
            if (!k.replace(/\|/g, "")) return;
            const at = rowByKey[k];
            if (at && at > 1) doomed.push(at);
            if (name === "admins") setAdminMustChange_(rec.username, false);
          });
          doomed.filter(function (n, i, a) { return a.indexOf(n) === i; }).sort(function (a, b) { return b - a; })
                .forEach(function (rowNum) { sheet.deleteRow(rowNum); deleted++; });
        }

        _invalidateSheet_(def.name);
        results[name] = { inserted: inserted, updated: updated, skipped: skipped, deleted: deleted };
      } catch (e) {
        errors[name] = String(e && e.message ? e.message : e);
      }
    });

    logAction_("system", "Sync Push from GitHub Action", Object.keys(results).join(","), JSON.stringify(results).slice(0, 2000));
    return { success: Object.keys(errors).length === 0, results: results, errors: errors,
             error: Object.keys(errors).length ? JSON.stringify(errors).slice(0, 500) : undefined };
  });
}

/* ── Run this ONCE from the editor to generate the sync key ──────────── */
function generateSyncKey() {
  const key = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty("SYNC_KEY", key);
  Logger.log("════════════════════════════════════════════════");
  Logger.log("  SYNC_KEY = " + key);
  Logger.log("  Add this to GitHub Secrets as GAS_SYNC_KEY");
  Logger.log("════════════════════════════════════════════════");
  return key;
}
