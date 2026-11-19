# Pipeline contract — `syncreportssince`, `resolvereports`, `admincorrect`

One URL, `POST`, `Content-Type: text/plain`, JSON body `{"action":…, "key":SYNC_KEY, …}`.
The same three actions exist on **both** backends with the same JSON
(`gas/admin-reports.gs` ⇄ `supabase/functions/api/handlers/pipeline.ts`), pinned by
`tests/parity-handlers.test.mjs`. Apps Script cannot set HTTP codes, so errors are
`200 {"success":false,"error":…}`; the Edge Function sends `401` for `unauthorized`
with the same body. An unknown action says `Unknown action` (so "not deployed yet" is detectable).

## Secrets

| Purpose | Apps Script *Script property* (either name) | Edge Function env |
|---|---|---|
| Sync key (pipeline) | `ABHYAS_SYNC_KEY` or `SYNC_KEY` | `ABHYAS_SYNC_KEY` or `SYNC_KEY` |
| Admin key (**separate**) | `ABHYAS_ADMIN_KEY` | `ABHYAS_ADMIN_KEY` |
| Supabase (Apps Script → Supabase mirror) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY` | — |
| GitHub dispatch | `GITHUB_TOKEN` (fine-grained, this repo, Actions read+write); optional `GITHUB_REPO`, `GITHUB_WORKFLOW`, `GITHUB_REF` | same |

Keys are compared in constant time over the longer string (neither content nor length leaks), an
unset key never matches, and `admincorrect` refuses to run if the admin key equals the sync key.
Nothing secret is ever logged or echoed.

## `syncreportssince {key, since(ms), limit≤1000}` → `{success, reports, count, truncated, now}`

Reports **changed** since `since` — newly reported, resolved or **re-opened** — oldest change first.
Each report: `id, uid, qid|null, fileId, questionSnapshot, optionsSnapshot, correctIndex|null,
chosenIndex|null, reason, note, reportedBy, reportedAt, status, resolvedAt, resolvedBy, corrected(bool),
correctedSnapshot(text), section, appVersion` + `updatedAt`.

* "Changed" is a **server-stamped `updated_at`** (a Postgres trigger; stamped in-script on the sheet).
  `reported_at` never changes and `resolved_at` is supplied by the caller, so neither can be a cursor:
  a resolution stamped 10:00 arriving after the cursor passed 10:05 would be invisible, and a re-open
  (which clears `resolved_at`) leaves no trace.
* **`since` is inclusive.** The cursor is the newest change already delivered; equality must not skip a
  sibling sharing its millisecond. The boundary row is re-sent — upsert by `id`.
* **`now` is the newest change actually returned**, never the wall clock and never past rows cut off by
  `limit`. With nothing to send it stays at `since`. Use `now` as the next `since`.

## `resolvereports {key, items:[{id,status,resolvedAt,resolvedBy,corrected,correctedSnapshot}]}` → `{success, updated, missing, failed}`

≤ 200 items; `status` is `open` or `resolved`. `open` clears `resolvedAt/resolvedBy/corrected/snapshot`.
Idempotent: a repeat writes nothing (it does not even re-stamp `updatedAt`). Unknown id → `missing`;
a write error → `failed` (retry those). `resolved` with no `resolvedAt` keeps the existing time, else now.

* **Apps Script writes the sheet first** (what the app is served from and what sync reads), then mirrors
  to Supabase in one batched call when the bridge is configured. A mirror error → `failed`.
* Empty strings, never `null`: every `question_reports` column is `NOT NULL DEFAULT ''`.

## `admincorrect {adminKey, publish, items:[{qn,question,options,correctIndex,explanation,note}]}` → `{success, queued}`

Validates (1–50 items, unique `qn` `[A-Za-z0-9_.-]{1,40}`, question 1–2000, 2–10 options of 1–1000,
integer `correctIndex` inside the options, explanation ≤ 4000, serialized ≤ 60,000 chars) and starts
`apply_admin_corrections.yml` via `workflow_dispatch` with `corrections_json` and `publish`. It never
writes question data (only a rate-limit counter). **`publish` is `'true'` only for exactly `true`/`"true"`** — omitted or garbled
never publishes. Rate limited to 60 dispatches/hour. GitHub's `204` is success; otherwise
`GitHub dispatch failed (HTTP n)`.

## Differences from the supplied `AdminReports.gs` (and why)

1. It patched **only Supabase**. `question_reports` synced `gas-wins`, so the next sync would have
   reverted every resolution. Now the sheet is written first and the table syncs `newer-wins`.
2. It wrote `null` for re-open / missing `resolvedBy` → rejected by `NOT NULL` → `failed` forever.
3. It wrote JSON `false` → the string `'false'`, which the old `!!corrected` read as **true**.
4. "Changed since" there meant `reported_at`; now `updated_at` (see above).
5. `publish` defaulted to **true** when omitted; now false.
6. Secret names differ from this codebase's (`SYNC_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) — both accepted.
7. Routing is via `QID_ROUTES_` (doGet's default case), so no edit to `doPost` is needed. Pipeline
   actions are in `POST_ONLY_ACTIONS` and survive `LEGACY_API=off`.

## Answers to the questions in the brief

* **(a) Which URL is live?** I cannot tell from the repos. Both backends exist and both now implement
  the contract. `script.google.com/macros/s/…/exec` is Apps Script; `…/functions/v1/api` is the Edge
  Function. `?action=ping` returns the version (**1.47** Apps Script, **1.70** Edge Function): a lower
  number means the new code is not deployed.
* **(b) Table / columns?** Supabase table `question_reports`; columns `status, resolved_at, resolved_by,
  corrected, corrected_snapshot` as assumed, plus the new `updated_at`. Sheet `QuestionReports`
  (camelCase headers, new last column `updatedAt`).
* **(c) What is `now`?** For `syncreportssince`: the newest change returned (above). For the existing
  `synccorrectionssince`: Apps Script returns the newest `correctedAt` sent and the wall clock only when
  nothing matched; the Edge Function's `since` is exclusive, Apps Script's inclusive. Both are safe
  because the pipeline de-duplicates, but they differ.
* **(d) Filter by updated time?** Now yes, by `updated_at`. The previous Edge Function filtered
  `reported_at` only (and could miss reports past its row limit); **the Apps Script had no
  `syncreportssince` at all** — if your pipeline already calls it there, the deployed script differs
  from this repo.
* **(e) Quotas?** Apps Script: `UrlFetchApp` is capped per day (≈20,000 calls consumer / 100,000
  Workspace — check Google's current table) and one execution is limited to ~6 minutes. With the bridge
  on, `resolvereports` makes one fetch per item (batched with `fetchAll`, still counted each), so 200
  items = 200 calls. Keep batches ≤ 200 as you do. GitHub: `admincorrect` is capped here at 60/hour.

## Deploying (Apps Script) — keep the same /exec URL

1. Add `qid-core.gs`, `qid.gs`, `admin-reports.gs`; replace `code.gs`, `report.gs`, `sync.gs`, `supabase-bridge.gs`.
2. Project settings → Script properties: set the table above.
3. **Deploy → Manage deployments → ✏ edit the existing deployment → Version: New version → Deploy.**
   (A *new deployment* would change the URL and invalidate your secret.) Execute as *Me*, access *Anyone*.
4. Edge Function: run both migrations first, then `supabase functions deploy api`.

## Acceptance tests (replace `$URL`, keys)

```bash
post() { curl -sL -H 'Content-Type: text/plain' -d "$1" "$URL"; echo; }
post '{"action":"ping"}'                                                         # version 1.47 / 1.70
post '{"action":"resolvereports","key":"WRONG","items":[{"id":"x","status":"open"}]}'      # unauthorized
post '{"action":"resolvereports","key":"'$KEY'","items":[{"id":"REAL_ID","status":"resolved","resolvedBy":"console"}]}'   # updated:[REAL_ID]
post '{"action":"resolvereports","key":"'$KEY'","items":[{"id":"REAL_ID","status":"resolved","resolvedBy":"console"}]}'   # identical
post '{"action":"resolvereports","key":"'$KEY'","items":[{"id":"REAL_ID","status":"open"}]}'                              # row cleared
post '{"action":"resolvereports","key":"'$KEY'","items":[{"id":"made-up","status":"open"}]}'                              # missing:[made-up]
post '{"action":"admincorrect","adminKey":"WRONG","items":[]}'                                                           # unauthorized
post '{"action":"admincorrect","adminKey":"'$ADMIN'","publish":false,"items":[{"qn":"50011.110001","question":"Q?","options":["a","b"],"correctIndex":1}]}'   # queued:1 + a new Actions run
post '{"action":"definitely-not-real"}'                                                                                   # Unknown action
```

These exact scenarios run in `tests/parity-handlers.test.mjs` against both backends' real handlers; the
live-URL run (and the GitHub run appearing) can only be confirmed by you after deploying.

## Nightly sync

After `scripts/sync.js` (which now syncs `question_index`, `user_qstate`, `answer_events` and merges
`user_qstate` per field), call `rebuildqidstats` on **both** backends (`{"action":"rebuildqidstats","key":…}`):
`qid_stats` is derived data and is never merged. Push Neon-side merges/retirements with
`scripts/push-question-index.mjs`.
