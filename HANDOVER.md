# Abhyas Backend — Handover

**Updated:** 14 November 2026
**Canonical repo:** `D:\CODERSCODE\abhyas-backend`
**Remote:** `https://github.com/abhyasapp/backend.git`
**Live API:** `https://kdysjiiefvxnkrykgykz.supabase.co/functions/v1/api`
**Frontend:** `https://app.mku.name.np/`

> This file is a short orientation. The current session state, live checks and
> next steps are in `NEXT-SESSION.md`; behaviour changes are in `CHANGES.md`.

---

## Current state

- Student 360 (`adminGetStudentOverview`) is implemented and tested.
- Reports and corrections carry a stable `qid`.
- `correction_events` is the durable correction log; `question_reports` remains
  the per-user report history.
- `adminApplyCorrections` supports batch edits with per-item results, stale-text
  conflicts, duplicate protection, report closure and one file refresh per file.
- `syncCorrectionsSince` emits qid-bearing corrections and now treats `since` as
  exclusive, so the pipeline watermark does not re-fetch the newest queued row
  on every run.
- The qid migration has been applied to the linked Supabase project and the API
  function has been deployed as version 39.
- A second hardening pass adds fail-closed access, paged PostgREST reads,
  exact Storage lookup, weekly answer hiding, atomic rate limiting and the
  `20261115000000_integrity_hardening.sql` migration. The API version is now
  **1.64**; apply the new migration and redeploy the function when approved.

## Deploy the hardening pass

1. Review the pre-deploy queries in the supplied handover
   (`C:\\Users\\MANOJUPD\\Downloads\\abhyas-handover`).
2. Apply `20261115000000_integrity_hardening.sql`.
3. Deploy the `api` Edge Function.
4. Run the smoke checks; then set `WEEKLY_HIDE_ANSWERS=false` only if a client
   still needs answers during an open weekly window.
5. Do not set `REQUIRE_BASE_REVISION=true` until every client sends
   `baseUpdatedAt`.

## Verify

```bash
cd /d/CODERSCODE/abhyas-backend
npm install
npm run verify
```

`npm run verify` checks every `.ts`/`.gs`/`.js` source for syntax, applies all
migrations against PGlite, checks schema drift and RLS, runs the sync/GAS
contracts, and executes the owner/admin, Student 360 and report/correction
handler suites.

## Git

The backend worktree previously carried unrelated cleanup changes and a local
branch that was behind `origin/main`. Those cleanup changes are committed
separately, and the local qid work is rebased onto current `origin/main` before
pushing.

Do not force-push. Do not include a real `.env` or `supabase/.temp/` in Git.

## Known remaining work

- Import Drive file `1DpNL51689FyxVmvkA_CV1f81oyUXcyQK` into Neon; two legacy
  corrections are queued because that file has no Neon row yet.
- Deploy the updated Apps Script fallback (`gas/report.gs`) when the Apps Script
  deployment is next refreshed.
- No real question content was changed during deployment verification.
