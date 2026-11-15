# Abhyas Backend — Handover

**Updated:** 15 November 2026
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
- The qid migration has been applied to the linked Supabase project.
- A second hardening pass adds fail-closed access, paged PostgREST reads,
  exact Storage lookup, weekly answer hiding, atomic rate limiting and the
  `20261115000000_integrity_hardening.sql` migration. It is applied live and
  the API function's code is **1.67**; `?action=health` reports whatever version
  is actually deployed.

## Verify the live state

1. `GET ?action=health` returns the deployed `version` (`1.67` once the current code is deployed).
2. `supabase migration list --linked` shows `20261115000000` on both sides.
3. `GET ?action=getsettings` does not contain `adminEmail`.
4. An unauthenticated `synccorrectionssince` POST returns 401.

Set `WEEKLY_HIDE_ANSWERS=false` only if a client still needs answers during an
open weekly window. Do not set `REQUIRE_BASE_REVISION=true` until every client
sends `baseUpdatedAt`.

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

`main` is clean and pushed. The repository is private.

Do not force-push. Do not include a real `.env` or `supabase/.temp/` in Git.

## Known remaining work

- Import Drive file `1DpNL51689FyxVmvkA_CV1f81oyUXcyQK` into Neon; two legacy
  corrections are queued because that file has no Neon row yet.
- Deploy the updated Apps Script fallback (`gas/report.gs`) when the Apps Script
  deployment is next refreshed.
- No real question content was changed during deployment verification.
