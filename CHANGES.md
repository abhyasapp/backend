# Changes (v1.67 Supabase · v1.45 Apps Script)

## 15 November 2026 — qid is a string end to end
- `qid` is the canonical lowercase **string** in every response (`qidString()`
  form: `48213` or `a-123-456-789012`). Report, question, correction-event,
  export and correction-sync payloads now agree.
- The remaining `Number(qid)` coercions turned every hyphenated id into `NaN`,
  which JSON writes as `null` — so a hyphenated correction reached the
  Drive → Neon pipeline with `qid: null`, and `adminGetQuestion` /
  `adminUpdateQuestion` echoed it the same way.
- Apps Script `report.gs` accepts and preserves hyphenated qids instead of
  dropping anything that is not numeric (`normalizeQReportQid_`), including in
  the sheet round-trip and the sibling-report comparisons.
- The handler and GAS contract tests assert the string form and cover a
  hyphenated qid through report → correction event → `syncCorrectionsSince`.
- `HANDOVER.md` / `NEXT-SESSION.md` version references follow
  `FUNCTION_VERSION` (1.67); their 1.64 live-state notes are history.
- Deployed: Edge Function `api` version 50 on 15 November 2026; `health`
  returns 1.67. Migrations unchanged (no schema change in this fix).

## 14 November 2026 — integrity and access hardening
- Fail-closed trial access, rejected-session enforcement, reserved-name checks and
  rate-limited password/upload/report actions.
- PostgREST paging via `selectAll()`; batch filters are chunked so the 1000-row cap
  no longer silently truncates admin lists, standings or correction exports.
- Exact Storage lookup for content files, published-only study docs, weekly sets
  withheld before release and answers/explanations removed during the exam window.
- Verified PDF uploads, one upload per submission, validated weekly/subjective JSON.
- Correction events are read after the watermark in ascending order, and batch edits
  write the event first and roll it back when the file save fails.
- Integrity migration `20261115000000_integrity_hardening.sql`: lookup/unique indexes,
  storage size limits, atomic `rl_hit()` and service-role-only housekeeping calls.
- CI gains the dependency-free Edge Function unit tests and an advisory `deno check`;
  scheduled backend-sync failures open one issue instead of failing silently.
- Apps Script: authenticated hard-question stats, gzip progress parsing, weekly answer
  hiding, fixed reset URL, hidden `adminEmail`, POST-only correction sync and an
  optional `LEGACY_API=off` rollout switch.

## 14 November 2026 — reports, corrections, Student 360
- `question_reports.qid` and `correction_events` migration (idempotent).
- `reportQuestion` stores qid and returns both `id` and `reportId`.
- `myQuestionReports` returns account-scoped reports with qid and correction data.
- `adminListQuestionReports` returns qid and groups open reporters by qid when present.
- `adminGetQuestion` / `adminUpdateQuestion` prefer qid, validate `expectedQ`, close
  every open report for the question, and write one correction event per edit.
- `adminApplyCorrections` applies a batch with per-item results, duplicate detection,
  stale-question conflicts, and one file refresh per affected file.
- `syncCorrectionsSince` reads the event log (with report fallback) and emits qid for
  the Drive-to-Neon pipeline.
- `syncCorrectionsSince` treats the pipeline watermark as exclusive, so a queued
  correction is not fetched and re-queued on every scheduled run.
- Student 360 `adminGetStudentOverview` endpoint.
- Handler test script fixed so all suites run, not just the first file argument.

## Removed (not needed in production)
`gas/debug.gs` (wipe/reset helpers), `gas/migrate-files.gs`, `gas/content-index.gs`,
`client/js/api-adapter.js` (unused second router), `scripts/verify.ps1` and the
stale fill-tracker `MANIFEST.md`.
Kept: `gas/private-files.gs` (its `CONTENT_FILE_IDS` is the Drive allow-list used by
`isContentFileAllowed_`; delete only the one-off `makeContentFilesPrivate()` after running it).
Lock-out recovery that lived in `debug.gs` is now `resetOwnerPasswordToDefault()` in `setup.gs`.

## Owner / admin model (Supabase)
- Default owner **`admin` / `abhyas`**, created on the first admin login when no owner exists
  (`DEFAULT_OWNER_USERNAME` / `DEFAULT_OWNER_PASSWORD` secrets override). Flagged `must_change_password`:
  every admin action except `adminchangepassword` answers `mustChangePassword: true`.
- Owner-only: create / promote / delete admins, set permissions, reset admin passwords
  (`adminresetadminpassword` → one-time `tempPassword`), promote / demote owners (`admindemoteowner` is new).
  `admins_view` / `admins_manage` are never grantable (`ownerOnlyFeatures`).
- A student becomes an admin only through `adminpromoteusertoadmin` (owner, optional permissions).
- Last-owner protection, reserved usernames (also blocked at student signup), password policy
  (8–256 chars, not common / default / containing the username), rate-limited change, audit-log entries.
- `adminchangepassword` needs no feature permission and returns a fresh token; the linked student
  password only follows if it was linked.
- `adminupdateuser` refuses password resets for admin accounts (use the owner reset instead).
- `adminlogin` / `adminswitchfromuser` return `isOwner` and the real `mustChangePassword`.

## Contract fixes (Supabase)
- `getfile` / `getfiles` return parsed `result` (+ `content` while `FILE_LEGACY_CONTENT` ≠ `false`).
- Unknown actions answer HTTP 200 with `migrationPending: true, unknownAction: true` so client fallback triggers.

## Sync (`scripts/sync.js`, rewritten)
Paginated + count-verified pulls · composite keys · full rename maps (admins, admin_permissions,
progress_backups added) · unknown-column filtering and type coercion · GAS-only columns preserved ·
changed-rows-only pushes · deletions propagated via `deleted_records` tombstones with a re-creation guard ·
revoked permissions never resurrected (`admin_permissions` is Supabase-authoritative) · verified e-mail
preserved · POST-only (key never in a URL) · refuses mass deletes without `--force` · `--dry-run` ·
non-zero exit on any failure · workflow every 6 h with concurrency lock and a dry-run manual mode.

## Apps Script
- New `supabase-bridge.gs`: password reset writes to Supabase **first** (reset code restored on failure),
  e-mail verification is mirrored, Supabase-created users/sessions/admin sessions are hydrated on demand.
- `sync.gs`: composite-key upserts, deletes, headers on pull, GAS-only columns kept, `must_change_password`
  carried for admins; table map is lazy so file load order cannot break it.
- `code.gs`: default owner `admin`/`abhyas` + forced change, hashes above 20 000 PBKDF2 rounds refused
  instantly (`backupLimit`), sync actions POST-only, `isOwner` in admin login.

## Database
`supabase/migrations/20261021000000_admin_enhancements.sql` — adds `admins.must_change_password`,
`deleted_records`, `prune_deleted_records()`. Idempotent. (No schema file shipped, so it only adds.)

## Verification
`npm test` → 16 sync tests, a mocked-sheet harness for `sync.gs`, and 12 behaviour checks that execute
the real TypeScript handlers against an in-memory database (first login, forced change, owner-only rules,
last-owner protection, temp-password reset, audit log, `getfile` contract). There is no `tsc`/`deno check` gate: the repo ships no `tsconfig.json` or `deno.json`, and CI's type-check job is `continue-on-error`, so it is advisory only.
**Not** verified: a live Supabase / Apps Script deployment — run the smoke test in `README.md`.
