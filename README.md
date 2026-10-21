# Abhyas Backend

Study-PWA backend for Nepal Lok Sewa preparation.

| Part | Role |
|---|---|
| `supabase/functions/api` | **Primary** — Edge Function (Deno/TypeScript) + Postgres + Storage |
| `gas/*.gs` | **Fallback** — Google Apps Script on Sheets/Drive; also hosts e-mail verify / password-reset |
| `scripts/sync.js` + `.github/workflows` | **Sync** — keeps both stores aligned every 6 h |

## Default admin login

On the first admin login of a fresh install the owner account is created:

    username: admin
    password: abhyas

The password change is **forced**: until it is changed, every admin action except
"change password" is refused (`mustChangePassword: true`).
`abhyas` is public — **log in and change it immediately**, or set a private
starting password first: `supabase secrets set DEFAULT_OWNER_PASSWORD=<private>`.

Owner-only: create / promote / delete admins, set permissions, reset admin
passwords, promote / demote owners. A student becomes an admin only when the
owner promotes them. The last owner can never be deleted or demoted.

## Deploy (order matters)

1. **Database** — review, then run `supabase/migrations/20261021000000_admin_enhancements.sql`
   (adds `admins.must_change_password` and the `deleted_records` tombstone table).
2. **Edge Function**
   ```bash
   supabase secrets set DEFAULT_OWNER_PASSWORD=abhyas      # or a private value
   supabase functions deploy api
   ```
3. **Apps Script** — paste `code.gs`, `sync.gs`, `supabase-bridge.gs`, `report.gs`,
   `private-files.gs`, `setup.gs`; add Script Properties `SYNC_KEY`
   (run `generateSyncKey()`) and `SUPABASE_SERVICE_ROLE_KEY`; run
   `testSupabaseBridge()`; **Deploy → Manage deployments → new version**.
4. **GitHub secrets**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GAS_URL`, `GAS_SYNC_KEY`.
5. **Sync** — run the workflow manually as a **dry run**, read the table, then run it for real.

## Smoke test

- `admin` / `abhyas` → forced password change → console unlocks.
- Promote a test student with one permission; they only get that area.
- GAS password reset → log in on Supabase with the new password.
- Open one weekly set (quiz loads with questions).
- Dry-run sync prints sensible per-table counts.

## Tests

```bash
npm test          # sync logic, GAS sync harness, owner/admin handler behaviour
```

Needs Node ≥ 22.18 (native TypeScript stripping for the handler tests).

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
