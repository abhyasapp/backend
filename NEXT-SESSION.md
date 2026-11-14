# Next-session handoff — 14 November 2026

Use this file when moving the work to a new chat or project. A chat itself cannot
be transferred, but this captures the exact state and the first commands.

## Repositories

- Backend: `D:\CODERSCODE\abhyas-backend` (Git repo, branch `main`)
- Frontend: `D:\CODERSCODE\abhyas-frontend\abhyas-frontend`
- Drive -> Neon pipeline: `D:\CODERSCODE\DRIVETONEONTODRIVE`

The backend worktree was already dirty before this work. Do **not** reset,
checkout, pull or delete unrelated files.

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

## Verification already run

Backend:

```bash
cd /d/CODERSCODE/abhyas-backend
npm run verify
```

Passed: 26 schema/sync/header tests, GAS harness, 12 owner/admin checks,
4 Student 360 checks, 7 report/correction checks.

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
