/* ═══════════════════════════════════════════════════════════════════════
   gas/qid-core.gs — question identity + weekly scoring, in pure JavaScript.

   This is a line-for-line port of supabase/functions/api/_shared/qid.ts and
   _shared/weekly-score.ts. It touches no Sheets, no Drive, no globals except
   the helpers defined here, so the two backends derive THE SAME qid,
   revision, index, coverage and score from the same content.

   tests/parity.test.mjs loads this file and the TypeScript modules side by
   side and fails if their output differs on any fixture. If you change
   behaviour here, change it in the .ts files too (and vice versa).

   Paste into the Apps Script project as a NEW file called qid-core.gs.
   Names are suffixed with an underscore (Apps Script's "private" convention)
   and prefixed `qid` / `weeklyScore` so they cannot shadow code.gs / report.gs.
   Deliberately avoids ?. and ?? so it runs on every Apps Script runtime.
   ═══════════════════════════════════════════════════════════════════════ */

/* Fields a question may carry its id on, app order (public_qn first). */
var QID_FIELDS_ = ["public_qn", "publicQn", "qnid", "qid", "id", "publicId", "publicQid", "code"];

function qidIsNil_(v) { return v === null || v === undefined; }

/* Canonical form + kind of an id: { qid, kind: "stable" | "positional" | "" }. */
function qidParse_(v) {
  var s = String(qidIsNil_(v) ? "" : v).trim();
  if (!s) return { qid: "", kind: "" };
  if (/^\d+$/.test(s)) return { qid: s, kind: "stable" };
  if (/^[A-Za-z0-9]{1,3}-[0-9]{3}-[0-9]{3}-[0-9]{6}$/.test(s)) {
    return { qid: s.replace(/[^A-Za-z0-9-]/g, "").toLowerCase(), kind: "stable" };
  }
  /* "<fileId>-<position>" carries the POSITION, so it is not reorder-safe. */
  if (/^[A-Za-z0-9_-]{1,200}-\d{1,5}$/.test(s)) return { qid: s, kind: "positional" };
  if (/^[A-Za-z0-9][A-Za-z0-9._]{3,63}$/.test(s) && /\d/.test(s)) return { qid: s.toLowerCase(), kind: "stable" };
  return { qid: "", kind: "" };
}
function qidStr_(v) { return qidParse_(v).qid; }
function qidKind_(v) { return qidParse_(v).kind; }

function qidMatches_(candidate, wanted) {
  if (!wanted) return false;
  var raw = String(qidIsNil_(candidate) ? "" : candidate).trim();
  if (!raw) return false;
  if (raw === wanted || raw.toLowerCase() === String(wanted).toLowerCase()) return true;
  var norm = qidStr_(raw);
  return !!norm && norm === wanted;
}

/* ONE traversal order: array; else questions|data|quiz|items; else sections. */
function qidFlatten_(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  var keys = ["questions", "data", "quiz", "items"], i;
  for (i = 0; i < keys.length; i++) {
    if (Array.isArray(raw[keys[i]]) && raw[keys[i]].length) return raw[keys[i]];
  }
  if (Array.isArray(raw.sections)) {
    var out = [];
    raw.sections.forEach(function (s) { if (s && Array.isArray(s.questions)) out = out.concat(s.questions); });
    if (out.length) return out;
  }
  for (i = 0; i < keys.length; i++) if (Array.isArray(raw[keys[i]])) return raw[keys[i]];
  return [];
}

/* The id a question is identified by: a stable id on ANY field beats a positional one. */
function qidPrimary_(q) {
  if (!q || typeof q !== "object") return { qid: "", kind: "" };
  var positional = null;
  for (var i = 0; i < QID_FIELDS_.length; i++) {
    var p = qidParse_(q[QID_FIELDS_[i]]);
    if (!p.qid) continue;
    if (p.kind === "stable") return p;
    if (!positional) positional = p;
  }
  return positional || { qid: "", kind: "" };
}

function qidAll_(q) {
  if (!q || typeof q !== "object") return [];
  var out = [];
  for (var i = 0; i < QID_FIELDS_.length; i++) {
    var s = qidStr_(q[QID_FIELDS_[i]]);
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

/* Correct answer as scoring sees it; letters a–e map to 0–4. */
function qidCorrectOf_(q) {
  if (!q || typeof q !== "object") return undefined;
  var c = q.correct !== undefined ? q.correct
    : q.answer !== undefined ? q.answer
    : q.ans !== undefined ? q.ans
    : q.Answer;
  if (typeof c === "string" && /^[a-eA-E]$/.test(c.trim())) c = "abcde".indexOf(c.trim().toLowerCase());
  return c;
}

/* Deterministic 53-bit hash (cyrb53) → 14 hex chars. Identical to hash53 in qid.ts. */
function qidHash53_(str) {
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (var i = 0; i < str.length; i++) {
    var ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  var n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  var hex = n.toString(16);
  while (hex.length < 14) hex = "0" + hex;
  return hex;
}

function qidText_(q) { var v = q.q !== undefined && q.q !== null ? q.q : (q.question !== undefined && q.question !== null ? q.question : q.text); return String(qidIsNil_(v) ? "" : v); }
function qidOptions_(q) {
  var o = q.options !== undefined && q.options !== null ? q.options : (q.choices !== undefined && q.choices !== null ? q.choices : q.opts);
  return Array.isArray(o) ? o : [];
}
function qidExplanation_(q) {
  var v = q.explanation !== undefined && q.explanation !== null ? q.explanation
    : (q.explain !== undefined && q.explain !== null ? q.explain : q.exp);
  return String(qidIsNil_(v) ? "" : v);
}

/* Revision of what a student SEES and is scored on. Never includes position. */
function qidQuestionRev_(q) {
  if (!q || typeof q !== "object") return "";
  var c = qidCorrectOf_(q);
  return qidHash53_(JSON.stringify([qidText_(q), qidOptions_(q), c === undefined ? null : c, qidExplanation_(q)]));
}

/* Revision of the whole paper: sorted (qid, rev) pairs — position-independent. */
function qidFileRev_(arr) {
  var pairs = arr.map(function (q) { return [qidPrimary_(q).qid, qidQuestionRev_(q)]; });
  pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  return qidHash53_(JSON.stringify(pairs));
}

function qidBuildIndex_(raw) {
  var out = [];
  qidFlatten_(raw).forEach(function (q, i) {
    var p = qidPrimary_(q);
    if (p.qid) out.push({ qid: p.qid, kind: p.kind, ord: i, rev: qidQuestionRev_(q) });
  });
  return out;
}

function qidCoverage_(raw) {
  var arr = qidFlatten_(raw);
  var seen = {}, order = [];
  var stable = 0, positional = 0, missing = 0;
  arr.forEach(function (q) {
    var p = qidPrimary_(q);
    if (!p.qid) { missing++; return; }
    if (p.kind === "stable") stable++; else positional++;
    if (seen[p.qid] === undefined) { seen[p.qid] = 0; order.push(p.qid); }
    seen[p.qid]++;
  });
  var duplicates = order.filter(function (k) { return seen[k] > 1; });
  var mode = arr.length && stable === arr.length && !duplicates.length ? "stable"
    : stable > 0 ? "partial" : "positional";
  return { total: arr.length, withQid: stable + positional, stable: stable, positional: positional, missing: missing, duplicates: duplicates, mode: mode };
}

/* Position by identity; a supplied id that matches nothing is -1 (never the old position). */
function qidIndexFor_(arr, index, qid) {
  if (!qid) return index;
  for (var f = 0; f < QID_FIELDS_.length; f++) {
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && qidMatches_(arr[i][QID_FIELDS_[f]], qid)) return i;
    }
  }
  return -1;
}

/* A write with NO qid may only target a question that has no stable id. */
function qidPositionWriteAllowed_(arr, index) {
  var q = arr[index];
  if (!q || typeof q !== "object") return false;
  return qidPrimary_(q).kind !== "stable";
}

function qidResolveCanonical_(qid, aliases, maxHops) {
  var cur = qid, seen = {}, hops = maxHops || 8;
  for (var i = 0; i < hops; i++) {
    var next = aliases[cur];
    if (!next || next === cur || seen[next]) break;
    seen[cur] = true;
    cur = next;
  }
  return cur;
}

/* ───────────────────────── weekly scoring ───────────────────────── */

function weeklyScoreFail_(code, error) { return { ok: false, error: error, code: code }; }

function weeklyScoreChoice_(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isFinite(n) && Math.floor(n) === n && n >= 0 && n < 10 ? n : null;
}

function weeklyScoreIsRight_(expected, a) {
  if (a === null) return false;
  return (typeof expected === "number" && a === expected) || (typeof expected === "string" && String(a) === expected);
}

/* Parses {qid: n} or [{q|qid, a|answer}] → { ok, map (plain object), size } or a failure. */
function weeklyParseAnswersByQid_(v) {
  var src = v;
  if (typeof src === "string") { try { src = JSON.parse(src); } catch (e) { return weeklyScoreFail_("malformed", "Malformed answers."); } }
  var map = {}, size = 0, err = null;
  function put(rawKey, rawVal) {
    var key = qidStr_(rawKey);
    if (!key) return weeklyScoreFail_("bad_qid", "An answer refers to an unrecognised question id.");
    if (Object.prototype.hasOwnProperty.call(map, key)) return weeklyScoreFail_("duplicate_qid", "The same question was answered twice.");
    map[key] = weeklyScoreChoice_(rawVal);
    size++;
    return null;
  }
  if (Array.isArray(src)) {
    for (var i = 0; i < src.length; i++) {
      var it = src[i] || {};
      var k = it.q !== undefined && it.q !== null ? it.q : it.qid;
      var a = it.a !== undefined && it.a !== null ? it.a : it.answer;
      err = put(k, a);
      if (err) return err;
    }
  } else if (src && typeof src === "object") {
    var keys = Object.keys(src);
    for (var j = 0; j < keys.length; j++) { err = put(keys[j], src[keys[j]]); if (err) return err; }
  } else return weeklyScoreFail_("malformed", "Malformed answers.");
  if (!size || size > 500) return weeklyScoreFail_("size", "Invalid answers.");
  return { ok: true, map: map, size: size };
}

/* input: { raw, frozenQids, answersByQid, answers } — same contract as scoreWeekly() in weekly-score.ts. */
function weeklyScoreQid_(input) {
  var arr = qidFlatten_(input.raw);
  if (!arr.length) return weeklyScoreFail_("no_questions", "This weekly set has no questions.");
  var cov = qidCoverage_(input.raw);
  var qidReady = cov.missing === 0 && cov.duplicates.length === 0;
  var warnings = [];
  if (qidReady && cov.positional > 0) warnings.push('Some question ids are position-derived ("<file>-<n>") and are not reorder-safe.');

  var hasQidPayload = input.answersByQid !== undefined && input.answersByQid !== null && input.answersByQid !== "";
  var list, i;

  function parseList() {
    try { return typeof input.answers === "string" ? JSON.parse(input.answers) : input.answers; } catch (e) { return undefined; }
  }

  /* positional-only paper (legacy file with no usable ids) */
  if (!qidReady) {
    if (hasQidPayload) return weeklyScoreFail_("paper_not_qid_ready", "This weekly set has questions without unique ids, so it cannot be scored by question id. Contact the admin.");
    list = parseList();
    if (list === undefined && typeof input.answers === "string") return weeklyScoreFail_("malformed", "Malformed answers array.");
    if (!Array.isArray(list) || !list.length || list.length > 500) return weeklyScoreFail_("size", "Invalid answers array.");
    if (list.length !== arr.length) return weeklyScoreFail_("count_mismatch", "The number of answers does not match the number of questions in this set. Contact the admin.");
    var answersP = list.map(weeklyScoreChoice_);
    var correctP = 0, skippedP = 0;
    answersP.forEach(function (a, idx) { if (a === null) skippedP++; else if (weeklyScoreIsRight_(qidCorrectOf_(arr[idx]), a)) correctP++; });
    warnings.push("Paper has no unique question ids; scored by position (legacy).");
    return { ok: true, mode: "positional", total: arr.length, correct: correctP, skipped: skippedP,
      qids: arr.map(function () { return ""; }), answersByQid: {}, answers: answersP, voided: [], fileRev: qidFileRev_(arr), warnings: warnings };
  }

  /* qid paper */
  var byQid = {}, fileOrder = [];
  arr.forEach(function (q) { var id = qidPrimary_(q).qid; byQid[id] = { correct: qidCorrectOf_(q) }; fileOrder.push(id); });

  var frozen = (input.frozenQids || []).map(qidStr_).filter(function (x) { return !!x; });
  var paper = frozen.length ? frozen : fileOrder;
  var voided = [], active = [];
  paper.forEach(function (id) {
    var e = byQid[id];
    var k = e ? e.correct : undefined;
    if (!e || k === undefined || k === null || k === "") voided.push(id); else active.push(id);
  });
  if (!active.length) return weeklyScoreFail_("empty_paper", "No scorable questions remain on this weekly set. Contact the admin.");

  var answerMap = {};
  if (hasQidPayload) {
    var parsed = weeklyParseAnswersByQid_(input.answersByQid);
    if (!parsed.ok) return parsed;
    answerMap = parsed.map;
  } else {
    list = parseList();
    if (list === undefined && typeof input.answers === "string") return weeklyScoreFail_("malformed", "Malformed answers array.");
    if (!Array.isArray(list) || !list.length || list.length > 500) return weeklyScoreFail_("size", "Invalid answers array.");
    if (list.length !== arr.length) return weeklyScoreFail_("count_mismatch", "The number of answers does not match the number of questions in this set. Contact the admin.");
    var onFrozen = {};
    paper.forEach(function (id) { onFrozen[id] = true; });
    fileOrder.forEach(function (id, idx) { if (onFrozen[id]) answerMap[id] = weeklyScoreChoice_(list[idx]); });
    warnings.push("Positional answers were converted to question ids using the file order.");
  }

  var onPaper = {};
  paper.forEach(function (id) { onPaper[id] = true; });
  var unknown = Object.keys(answerMap).filter(function (k) { return !onPaper[k]; });
  if (unknown.length) return weeklyScoreFail_("unknown_qid", "These question ids are not on this weekly set: " + unknown.slice(0, 5).join(", ") + ".");

  var answersByQid = {}, correct = 0, skipped = 0;
  active.forEach(function (id) {
    var a = Object.prototype.hasOwnProperty.call(answerMap, id) ? answerMap[id] : null;
    answersByQid[id] = a;
    if (a === null) skipped++; else if (weeklyScoreIsRight_(byQid[id].correct, a)) correct++;
  });
  if (voided.length) warnings.push(voided.length + " question(s) on the frozen paper were voided (removed or no answer key).");
  return { ok: true, mode: "qid", total: active.length, correct: correct, skipped: skipped,
    qids: active, answersByQid: answersByQid, answers: active.map(function (id) { return answersByQid[id]; }),
    voided: voided, fileRev: qidFileRev_(arr), warnings: warnings };
}

/* ───────────────── per-question student state (pure rules) ─────────────────
   Port of supabase/functions/api/_shared/qstate-core.ts. Column names are
   camelCase here (sheet headers); the Postgres twin uses snake_case. */

var QSTATE_FUTURE_SKEW_MS_ = 5 * 60 * 1000;
var QSTATE_NOTE_MAX_ = 2000;

/* ISO string with ms from a ms number, numeric string or ISO string; "" if unusable. */
function qidIso_(v) {
  if (v === null || v === undefined || v === "") return "";
  var ms = NaN;
  if (typeof v === "number") ms = v;
  else if (/^\d{10,14}$/.test(String(v).trim())) ms = Number(v);
  else ms = new Date(String(v)).getTime();
  return isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : "";
}
function qidBoolText_(v) { return v === true || v === "true" || v === 1 || v === "1" ? "true" : "false"; }
function qidToBool_(v) { return v === true || v === "true"; }

var QSTATE_FIELDS_ = [
  { prop: "note", col: "note", at: "noteAt", atCol: "noteAt", text: true },
  { prop: "bookmarked", col: "bookmarked", at: "bookmarkedAt", atCol: "bookmarkedAt", text: false },
  { prop: "flagged", col: "flagged", at: "flaggedAt", atCol: "flaggedAt", text: false },
  { prop: "inMistakes", col: "inMistakes", at: "mistakesAt", atCol: "mistakesAt", text: false }
];

/* Per-field last-writer-wins. Returns the changed columns, or null (idempotent replay). */
function qstateMergeChange_(existing, change, nowIso) {
  var patch = {}, any = false;
  var nowMs = new Date(nowIso).getTime();
  QSTATE_FIELDS_.forEach(function (f) {
    if (change[f.prop] === undefined) return;
    var at = qidIso_(change[f.at]) || nowIso;
    if (new Date(at).getTime() > nowMs + QSTATE_FUTURE_SKEW_MS_) at = nowIso;
    var cur = String(existing && existing[f.atCol] ? existing[f.atCol] : "");
    if (cur && cur >= at) return;
    var raw = change[f.prop];
    var val = f.text ? String(raw === null || raw === undefined ? "" : raw).slice(0, QSTATE_NOTE_MAX_) : qidBoolText_(raw);
    var exVal = existing && existing[f.col] !== null && existing[f.col] !== undefined ? String(existing[f.col]) : "";
    if (existing && exVal === val && cur === at) return;
    patch[f.col] = val; patch[f.atCol] = at; any = true;
  });
  return any ? patch : null;
}

/* Fold new answer events for ONE qid into the student's state row (see qstate-core.ts). */
function qstateFoldAnswers_(ex, evsIn, nowIso) {
  var evs = evsIn.slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  var last = evs[evs.length - 1];
  var wrongN = evs.filter(function (e) { return !e.ok; }).length;
  var prevAttempts = Number(ex && ex.attempts ? ex.attempts : 0);
  var newer = !(ex && ex.lastAt) || last.at > String(ex.lastAt);
  var base = ex || { note: "", noteAt: "", bookmarked: "", bookmarkedAt: "", flagged: "", flaggedAt: "", inMistakes: "", mistakesAt: "" };
  var row = {};
  Object.keys(base).forEach(function (k) { row[k] = base[k]; });
  row.qid = last.qid;
  row.fileId = last.fileId || (ex && ex.fileId ? ex.fileId : "");
  row.attempts = String(prevAttempts + evs.length);
  row.wrong = String(Number(ex && ex.wrong ? ex.wrong : 0) + wrongN);
  row.lastResult = newer ? (last.ok ? "ok" : "wrong") : String(ex && ex.lastResult ? ex.lastResult : "");
  row.lastAt = newer ? last.at : String(ex && ex.lastAt ? ex.lastAt : "");
  row.updatedAt = nowIso;
  var lastWrong = null;
  for (var i = evs.length - 1; i >= 0; i--) if (!evs[i].ok) { lastWrong = evs[i]; break; }
  if (lastWrong && (!(ex && ex.mistakesAt) || lastWrong.at > String(ex.mistakesAt))) { row.inMistakes = "true"; row.mistakesAt = lastWrong.at; }
  return { row: row, wrongN: wrongN, prevAttempts: prevAttempts };
}
