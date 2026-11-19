# qid contract — what the app can rely on (both backends, identical JSON)

**A question is identified by its qid.** Position and file are derived, display-only facts: they
change when a file is reordered, split or merged; a qid does not. Anything stored *about* a question
(report, correction, answer, note, bookmark, mistake, statistic) is keyed by qid.

Feature-detect with `bootstrap().capabilities` (contains `qid-weekly`, `qstate`, `recordanswers`,
`qidpatches`, `resolveqids`, `rev-concurrency`). Everything below is **additive**: old clients keep working.

| Action | Auth | What it does |
|---|---|---|
| `bootstrap` | student | session + settings + corrections + weekly sets (+ qstate delta) in **one** request. Runs `checksession` first because it may rotate the token; use `session.token` afterwards. |
| `submitweeklyattempt` | student | send `answersByQid` = `{"<qid>": 0..9\|null}` (or `[{q,a}]`). Legacy `answers: [..]` still works. Response: `mode`, `attempt.{answersByQid,qids,voided,correct,total,skipped}`. |
| `syncqstate` | student | `changes:[{qid,fileId?,note?,noteAt?,bookmarked?,bookmarkedAt?,flagged?,flaggedAt?,inMistakes?,mistakesAt?}]` (≤200) + `since`. Merged **per field** by its own timestamp; returns rows changed at/after `since` and a `cursor`. |
| `recordanswers` | student | `events:[{qid,ok,chosen?,at?,mode?,fileId?,sessionId?}]` (≤200). Idempotent per (student, qid, `at`). A wrong answer puts the question on the mistake list; the app owns un-listing it (`syncqstate inMistakes:false`). |
| `getqidpatches` | student | `since`, `fileId?` → `patches:[{qid,fileId,correctedAt,baseRev,rev,question,options,correctIndex,explanation,canonicalQid}]`, latest per qid. Apply by qid to any cached file. |
| `resolveqids` | student | `qids:[…]` → `{canonicalQid,redirected,status,fileId,rev}` — remap saved state after a merge. |
| `gethardquestions` | student | `qidMap` from `qid_stats` (≥20 attempts by ≥5 **distinct** students). |
| `adminrescoreweeklyset` | admin | `weeklyId`, `dryRun` (default **true**). Re-scores by qid after a correction. |
| `admingetquestion` / `adminupdatequestion` / `adminapplycorrections` | admin | send `qid`; send `baseRev` (from `admingetquestion.rev`) to get `rev_conflict` instead of overwriting a concurrent edit. A write with no qid to a question that has a stable id → `code:"qid_required"`. |
| `adminqidcoverage` | admin | how identity-ready a file / the whole bank is (`stable`/`partial`/`positional`, duplicates, missing). |

## Rules the app should follow
* **Send the qid on everything.** Use `public_qn`/`qnid`/`qid`/`id` (first that parses) — the same order the
  backend uses (`_shared/qid.ts` ⇄ `gas/qid-core.gs`). An id of the form `<fileId>-<n>` is **position-derived**:
  accepted for legacy data but not reorder-safe; the pipeline should publish immutable ids.
* **Cursors are inclusive.** `syncqstate.cursor` / `syncreportssince.now` = newest change already delivered;
  the boundary row comes back again. Merge idempotently (by field timestamp / by id).
* **Never trust the clock for ordering across devices:** timestamps more than 5 minutes in the future are
  clamped to server time; answer events older than 30 days are rejected.
* **Adoption path:** (1) send `answersByQid` for weekly sets; (2) move notes/bookmarks/flags/mistakes from the
  progress blob to `syncqstate`; (3) post `recordanswers` instead of relying on blob scans for statistics;
  (4) apply `getqidpatches` instead of waiting for a content refresh. "Reset my progress" and account
  deletion now clear this data too.
