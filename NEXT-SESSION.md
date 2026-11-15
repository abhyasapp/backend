# Next-session handoff — 14 November 2026

> The live-state section below was recorded against API **1.64**. `_shared/config.ts`
> is now `FUNCTION_VERSION = '1.67'`, so treat those 1.64 lines as history and
> re-check `?action=health` before trusting a deployed version number.

Use this file when moving the work to a new chat or project. A chat itself cannot
be transferred, but this captures the exact state and the first commands.

## Repositories

- Backend: `D:\CODERSCODE\abhyas-backend` (Git repo, branch `main`)
- Frontend: `D:\CODERSCODE\abhyas-frontend\abhyas-frontend`
- Drive -> Neon pipeline: `D:\CODERSCODE\DRIVETONEONTODRIVE`

`main` is clean and pushed. The repository is private.

## Implemented in this pass

### Student 360

- `adminGetStudentOverview` in `supabase/functions/api/handlers/admin.ts`
- Requires `users_view`, scoped to `targetUsername`
- Returns study, report, submission and risk data
- Handles normal JSON and `gz1:` compressed progress
- Tests: `tests/handlers/student-overview.test.mjs`

### Report / correction contract

- `supabase/migrations/20261114000000_report_qid_corrections.sql`
  - `question_reports.qid`
  - `correction_events`
- `reportQuestion` stores `qid`, derives `file_id` from `uid`, returns `reportId`
- `myQuestionReports` added (student-scoped)
- `adminListQuestionReports` returns `qid` and groups reporters by qid
- `adminGetQuestion` / `adminUpdateQuestion` prefer qid
- `adminApplyCorrections` added with per-item results, duplicate detection,
  stale-text conflicts, report closure and one file refresh per file
- `adminUpdateQuestionReportStatus` closes siblings by qid when available
- `syncCorrectionsSince` reads `correction_events` first, with report fallback,
  and emits `qid`
- Apps Script fallback stores/returns `qid`
- Tests: `tests/handlers/reports.test.mjs`, updated `tests/gas-sync.test.js`

### Drive -> Neon

`sync/apply_corrections.py` now resolves `qid` first and follows `canonical_id`
hops before falling back to the old text/identity matcher.

### Integrity and access hardening

- Added `20261115000000_integrity_hardening.sql` (lookup/unique indexes,
  Storage limits, atomic `rl_hit()`, service-role-only housekeeping).
- Fail-closed trial access and rejected-session enforcement.
- Paged PostgREST reads, exact Storage lookup, weekly answer hiding during the
  exam window, verified PDF uploads and report/upload rate limits.
- Apps Script fixes for gzip progress, authenticated hard-question stats,
  weekly answer hiding, reset URL, `adminEmail`, POST-only correction sync and
  the optional `LEGACY_API=off` switch.
- API **1.67** is deployed live (Edge Function `api` version 50, 15 November 2026); `?action=health` returns 1.67.
- Migration `20261115000000_integrity_hardening.sql` is applied live.
- Live checks (at the time): `action=health` returned 1.64; unique indexes exist; public
  `getsettings` omits `adminEmail`; unauthenticated correction sync returns 401.

## Verification already run

Backend:

```bash
cd /d/CODERSCODE/abhyas-backend
npm run verify
```

Passed: the schema/sync/header suites, the GAS harness, and the owner/admin,
Student 360 and report/correction handler suites.

Pipeline:

```bash
cd /d/CODERSCODE/DRIVETONEONTODRIVE
.venv/Scripts/python.exe -m py_compile sync/apply_corrections.py
.venv/Scripts/python.exe tests/smoke.py
```

Passed.

## Live state (14 November 2026)

- Migration `20261114000000_report_qid_corrections.sql` was applied to the
  linked Supabase project `kdysjiiefvxnkrykgykz`.
- `question_reports.qid` and `correction_events` exist; RLS is enabled.
- Migration history now records all three local migrations as applied.
- Edge Function `api` was deployed as version **39** and is `ACTIVE`.
- Live route checks passed for `adminGetStudentOverview`,
  `adminListQuestionReports`, `adminApplyCorrections` (validation path),
  `myQuestionReports` (with a temporary student session) and
  `syncCorrectionsSince`.
- The real Drive-to-Neon sync endpoint returned 3 existing corrections.
- Correction sync dry run and `--apply` both completed with exit 0.
- The current incremental correction (`corr_2423e622-3997-4859-b07e-b35f7b029526`)
  could not be matched: its Drive file
  `1DpNL51689FyxVmvkA_CV1f81oyUXcyQK` has no `files` row and 0 questions in
  Neon. It was queued; backlog is now 2. Run the main Drive -> Neon import
  before retrying these corrections.
- Watermark issue: the endpoint includes rows where `corrected_at == since`,
  and the sync stores the newest correction's timestamp as `since`. A queued
  correction is therefore fetched again on every run (its attempt count keeps
  increasing). Advance the watermark by 1 ms or change the backend comparison
  to exclusive before the next scheduled sync.

## Not done

- No Apps Script deployment was updated.
- No real question correction was written just to test the live write path.
- No push was made.

## Deploy order when approved

1. Apply `20261114000000_report_qid_corrections.sql` to Supabase.
2. Deploy the `api` Edge Function.
3. Update Apps Script files (`report.gs` changed) and redeploy the web app.
4. Confirm `SYNC_KEY` exists on the Edge Function and in the pipeline env.
5. Run the Neon pipeline with `python sync/apply_corrections.py` first as a
   dry run, then with `--apply`.

## First message for a new chat

> Read `HANDOVER.md`, `NEXT-SESSION.md`, `README.md` and `CHANGES.md` in
> `D:\CODERSCODE\abhyas-backend`, then run `npm run verify`. Continue from the
> uncommitted backend and Drive-to-Neon work described in `NEXT-SESSION.md`.
> Do not reset the dirty worktree.
