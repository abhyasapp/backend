/* ═══════════════════════════════════════════════════════════════════════
   gas/supabase-bridge.gs — keeps Apps Script and Supabase consistent for the
   few flows that only run on Apps Script (password reset, e-mail verify) and
   lets Apps Script honour sessions that were created on Supabase.

   Setup (Project Settings → Script Properties):
     SUPABASE_SERVICE_ROLE_KEY   required to enable the bridge (service-role key!)
     SUPABASE_URL                optional, defaults to the project below

   With no key set every function here is a harmless no-op, so a GAS-only
   deployment keeps working exactly as before.
   ═══════════════════════════════════════════════════════════════════════ */

const SUPABASE_URL_DEFAULT_ = "https://kdysjiiefvxnkrykgykz.supabase.co";

function bridgeConfig_() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty("SUPABASE_SERVICE_ROLE_KEY") || "";
  const url = String(props.getProperty("SUPABASE_URL") || SUPABASE_URL_DEFAULT_).replace(/\/+$/, "");
  return { key: key, url: url };
}

function bridgeEnabled_() { return !!bridgeConfig_().key; }

/* Returns { ok, status, data }. Never throws. */
function bridgeRequest_(method, path, body) {
  const cfg = bridgeConfig_();
  if (!cfg.key) return { ok: false, status: 0, data: null, disabled: true };
  try {
    const opts = {
      method: method,
      muteHttpExceptions: true,
      headers: { apikey: cfg.key, Authorization: "Bearer " + cfg.key, "Content-Type": "application/json", Prefer: "return=representation" }
    };
    if (body !== undefined) opts.payload = JSON.stringify(body);
    const resp = UrlFetchApp.fetch(cfg.url + path, opts);
    const status = resp.getResponseCode();
    let data = null;
    try { data = JSON.parse(resp.getContentText() || "null"); } catch (e) { data = null; }
    return { ok: status >= 200 && status < 300, status: status, data: data };
  } catch (e) {
    console.error("bridgeRequest_ failed:", e);
    return { ok: false, status: 0, data: null };
  }
}

function _bridgeEnc_(v) { return encodeURIComponent(String(v)); }

/* identifier = username or e-mail. Returns the Supabase users row or null. */
function bridgeGetUser_(identifier) {
  const id = String(identifier || "").trim();
  if (!id || id.length > 120) return null;
  let r = bridgeRequest_("get", "/rest/v1/users?select=*&username=eq." + _bridgeEnc_(id) + "&limit=1");
  if (r.ok && r.data && r.data[0]) return r.data[0];
  if (id.indexOf("@") !== -1) {
    r = bridgeRequest_("get", "/rest/v1/users?select=*&email=ilike." + _bridgeEnc_(id.replace(/[\\%_]/g, "\\$&")) + "&limit=1");
    if (r.ok && r.data && r.data[0]) return r.data[0];
  }
  return null;
}

function _bridgeStr_(v) { return (v === null || v === undefined) ? "" : v; }

/* Supabase users row → Users sheet row (USER_HEADERS order). */
function bridgeUserToSheetRow_(u) {
  return [
    _bridgeStr_(u.username), _bridgeStr_(u.pass_hash), _bridgeStr_(u.name), _bridgeStr_(u.email), _bridgeStr_(u.mobile),
    "", "", _bridgeStr_(u.status), _bridgeStr_(u.created_at), _bridgeStr_(u.approved_at),
    _bridgeStr_(u.role), _bridgeStr_(u.trial_expires_at), _bridgeStr_(u.payment_status), _bridgeStr_(u.permanent_access),
    _bridgeStr_(u.access_type), _bridgeStr_(u.access_expires_at), _bridgeStr_(u.session_token), _bridgeStr_(u.session_token_expires_at),
    _bridgeStr_(u.email_verified)
  ];
}

/* Make sure a Supabase-only account exists in the Users sheet. Returns the
   sheet "found" object ({rowIndex,row}) or null. */
function bridgeHydrateUser_(identifier) {
  if (!bridgeEnabled_()) return null;
  if (!checkRateLimit_("bridge_hydrate", 120, 60000)) return null;
  const u = bridgeGetUser_(identifier);
  if (!u || !u.username) return null;
  const sheet = getUsersSheet_();
  let found = findUserRow_(sheet, u.username);
  if (found) return found;
  sheet.appendRow(bridgeUserToSheetRow_(u));
  _invalidateSheet_(USERS_SHEET);
  return findUserRow_(getUsersSheet_(), u.username);
}

/* A student session that exists on Supabase but not (yet) in the sheet. */
function bridgeHydrateUserSession_(username, token) {
  if (!bridgeEnabled_() || !username || !token) return null;
  if (!checkRateLimit_("bridge_hydrate", 120, 60000)) return null;
  const r = bridgeRequest_("get", "/rest/v1/users?select=*&username=eq." + _bridgeEnc_(username) + "&limit=1");
  const u = r.ok && r.data && r.data[0] ? r.data[0] : null;
  if (!u || !tokenMatches_(u.session_token, token)) return null;
  const exp = Number(u.session_token_expires_at || 0);
  if (!exp || Date.now() > exp) return null;
  if (String(u.status) === "rejected") return null;

  const sheet = getUsersSheet_();
  const found = findUserRow_(sheet, u.username);
  if (found) {
    sheet.getRange(found.rowIndex, 17, 1, 2).setValues([[u.session_token, String(u.session_token_expires_at)]]);
  } else {
    sheet.appendRow(bridgeUserToSheetRow_(u));
  }
  _invalidateSheet_(USERS_SHEET);
  return findUserRow_(getUsersSheet_(), u.username);
}

/* An admin session that exists on Supabase but not (yet) in the Admins sheet. */
function bridgeHydrateAdminSession_(username, token) {
  if (!bridgeEnabled_() || !username || !token) return null;
  if (!checkRateLimit_("bridge_hydrate_admin", 60, 60000)) return null;
  const r = bridgeRequest_("get", "/rest/v1/admins?select=*&username=eq." + _bridgeEnc_(username) + "&limit=1");
  const a = r.ok && r.data && r.data[0] ? r.data[0] : null;
  if (!a || !tokenMatches_(a.token, token)) return null;
  const exp = Number(a.token_expires || 0);
  if (!exp || Date.now() > exp) return null;

  const row = [
    _bridgeStr_(a.username), _bridgeStr_(a.pass_hash), _bridgeStr_(a.created_at), _bridgeStr_(a.created_by),
    _bridgeStr_(a.token), String(a.token_expires), _bridgeStr_(a.role) || ADMIN_ROLE_ADMIN
  ];
  const sheet = getAdminsSheet_();
  const existing = findAdminRow_(sheet, a.username);
  if (existing) sheet.getRange(existing.rowIndex, 1, 1, row.length).setValues([row]);
  else sheet.appendRow(row);
  setAdminMustChange_(a.username, a.must_change_password === true || String(a.must_change_password) === "true");
  _invalidateSheet_(ADMINS_SHEET);
  return findAdminByToken_(getAdminsSheet_(), token);
}

/* Password reset: write the new hash (and clear sessions) on Supabase.
   Returns { ok, skipped? }. The hash is a PBKDF2 hash made here with
   PW_ITERATIONS rounds; Supabase verifies it and upgrades it to its own
   cost at the student's next login. */
function bridgeSetUserPassword_(username, newHash) {
  if (!bridgeEnabled_()) return { ok: true, skipped: true };
  const u = bridgeGetUser_(username);
  if (!u) return { ok: true, skipped: true };      // account exists only here → nothing to protect
  const r = bridgeRequest_("patch", "/rest/v1/users?username=eq." + _bridgeEnc_(u.username), {
    pass_hash: newHash, session_token: "", session_token_expires_at: "", email_verified: "true"
  });
  return { ok: r.ok };
}

/* E-mail verification: tell Supabase (only if the e-mail is unchanged). */
function bridgeMarkEmailVerified_(username, email) {
  if (!bridgeEnabled_()) return { ok: true, skipped: true };
  const r = bridgeRequest_("patch",
    "/rest/v1/users?username=eq." + _bridgeEnc_(username) + "&email=ilike." + _bridgeEnc_(String(email).replace(/[\\%_]/g, "\\$&")),
    { email_verified: "true" });
  return { ok: r.ok };
}

/* Run once from the editor to check the connection. */
function testSupabaseBridge() {
  if (!bridgeEnabled_()) { Logger.log("Bridge disabled: set the SUPABASE_SERVICE_ROLE_KEY script property."); return "disabled"; }
  const r = bridgeRequest_("get", "/rest/v1/settings?select=key&limit=1");
  Logger.log("Bridge " + (r.ok ? "OK" : "FAILED (HTTP " + r.status + ")"));
  return r.ok ? "ok" : "failed";
}
