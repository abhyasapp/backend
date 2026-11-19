# Abhyas Backend

Study-PWA backend for Nepal Lok Sewa preparation.

| Part | Role |
|---|---|
| `supabase/functions/api` | **Primary** — Edge Function (Deno/TypeScript) + Postgres + Storage |
| `gas/*.gs` | **Fallback** — Google Apps Script on Sheets/Drive; also hosts e-mail verify / password-reset |
| `scripts/sync.js` + `.github/workflows` | **Sync** — keeps both stores aligned every 6 h |

## Default admin login

On the first admin login of a fresh install the owner account `admin` is created
with the password held in the `DEFAULT_OWNER_PASSWORD` secret, and flagged
`must_change_password: true`. The Edge Function ships **no** default password: if
the secret is missing, owner creation is refused and the reason is logged. A
bootstrap password written into the source is a public credential.

    supabase secrets set DEFAULT_OWNER_PASSWORD=<private>   # before the first login

The password change is **forced**: until it is changed, every admin action except
"change password" is refused (`mustChangePassword: true`).

The Apps Script fallback keeps its own bootstrap constant in `code.gs` — set it to
a private value before deploying that path to a fresh install.

Owner-only: create / promote / delete admins, set permissions, reset admin
passwords, promote / demote owners. A student becomes an admin only when the
owner promotes them. The last owner can never be deleted or demoted.

## Deploy (order matters)

1. **Database** — for a fresh install apply all migrations in filename order
   (the base 18-table schema, the admin enhancements, then the report/correction
   qid + event log):
    `supabase/migrations/20250101000000_init_schema.sql` (all tables, TEXT columns,
   RLS on with no policies), then
    `supabase/migrations/20261021000000_admin_enhancements.sql`
   (adds `admins.must_change_password` and the `deleted_records` tombstone table),
   then `supabase/migrations/20261114000000_report_qid_corrections.sql`
   (adds `question_reports.qid` and the `correction_events` log).
   then `supabase/migrations/20261115000000_integrity_hardening.sql`
   (lookup/unique indexes, Storage limits and the atomic rate-limit helper).
   then `supabase/migrations/20261117000000_qid_core.sql`
   (adds `question_index`, `user_qstate`, `answer_events`, `qid_stats` and the
   per-question fact log).
   then `supabase/migrations/20261118000000_report_updated_at.sql`
   (server-stamped `question_reports.updated_at` + touch trigger, the cursor the
   pipeline reads).
   All are idempotent; an existing database only needs the newer ones
   (`supabase db push` applies just the pending pair).
2. **Edge Function**
   ```bash
   supabase secrets set DEFAULT_OWNER_PASSWORD=<private>   # required; no default
   supabase functions deploy api
   ```
   Optional, for correction push-back from `admincorrect`/`resolvereports`:
   `GITHUB_TOKEN`, `GITHUB_CORRECTIONS_WORKFLOW` (defaults to the corrections
   workflow file) and `GITHUB_CORRECTIONS_REF` (defaults to `main`).
3. **Apps Script** — the project holds `code.gs`, `sync.gs`, `supabase-bridge.gs`,
   `report.gs`, `qid-core.gs`, `qid.gs`, `admin-reports.gs`, `private-files.gs`,
   `setup.gs` (v1.70 adds `qid-core.gs`, `qid.gs`, `admin-reports.gs` and edits
   `code.gs`, `report.gs`, `sync.gs`, `supabase-bridge.gs`). Script Properties:
   `SYNC_KEY` (run `generateSyncKey()`), `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`; run `testSupabaseBridge()`; **Deploy → Manage
   deployments → new version** (keep the same `/exec` URL). `?action=ping`
   answers `version: "1.47"`.
4. **GitHub secrets**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GAS_URL`, `GAS_SYNC_KEY`.
5. **Sync** — run the workflow manually as a **dry run**, read the table, then run it for real.
6. **Question registry** (optional, seeds `question_index`):
   ```bash
   node scripts/push-question-index.mjs --content <dir> --supabase <url> --gas <url>
   ```

## Smoke test

- `admin` / `abhyas` → forced password change → console unlocks.
- Promote a test student with one permission; they only get that area.
- GAS password reset → log in on Supabase with the new password.
- Open one weekly set (quiz loads with questions).
- Dry-run sync prints sensible per-table counts.

## Tests

```bash
npm run verify    # syntax of every .ts/.gs/.js + schema/sync/GAS/owner-admin tests
```

`npm run verify` guarantees:
- every .ts/.gs/.js source parses (no deploy of a broken file),
- every table/column the Edge Function TypeScript touches exists in the
  migrations and cannot drift, tested against a real Postgres engine (pglite),
- all 24 tables have RLS enabled and zero policies (only the service role reads),
- every Apps Script sheet header maps onto a real Postgres column through
  `scripts/sync.js` renames, so the six-hourly sync cannot write unknown columns,
- a student cannot start or submit the same weekly test twice,
- the sync client retries the Apps Script dropped-POST-body quirk
  (`Unknown action: ''`) and never puts the key in a URL.

Computes in seconds, no database or network account needed.

## Known limits (by design)

- Supabase hashes (PBKDF2 600 000) cannot be verified inside the Apps Script
  time limit: login on the backup shows a "temporarily unavailable" message
  until the account is written by the GAS side.
- Storage files (weekly sets, study PDFs, payment screenshots) are not synced.
- `updateProfile`, `adminGetPermissions` and upload-URL actions exist only on Supabase.
- Sync semantics: users / admins / settings / weekly sets / study docs are
  **Supabase-wins**; progress / payments / subjective are **newer-wins**;
  question reports are **GAS-wins**; history / backups are **union**.
  Anything written on GAS during an outage to a Supabase-wins key is overwritten.

See `CHANGES.md` for the full change list and `FRONTEND_CHANGES.md` for the client work.
