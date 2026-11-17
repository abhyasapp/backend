# Versioned content, immutable ids, correction overlay

One page. Ordered so the weekly-scoring and report fixes can follow without rework.

## Problem

A question is identified by three different things at once: `id: "<fileId>-<position>"` in
the published JSON, `stable_qn_id` (`70024.730011`) in Neon, and a bare numeric row id in
older files. Two of those move when a question is inserted or reordered.

Content is also served from a live branch (`jsdelivr …/content@main`) while corrections are
written to `correction_events`, so a fix is invisible until the Drive→Neon→GitHub pipeline
re-exports — and admin and student can be reading different text from two different caches
for hours. Weekly sets are scored by array position against whatever file exists at submit
time, which is the same defect with a score attached.

## Target model

| Concern | Rule |
|---|---|
| **Identity** | `qid` = the public qn id (`70024.730011`), assigned once by the pipeline, never reused, never derived from position. |
| **Position** | `"<fileId>-<position>"` is kept as `pos_ref`: routing/display only. Never used as a key. |
| **Artifact** | Content is published as a tag (`content@v<N>`), never a branch. Each file carries `content_version`. |
| **Corrections** | `correction_events` is the source of truth for edits. It is replayed as an overlay at read time and baked into the next artifact. |

A question object, after phase 1:

```json
{ "id": "70024.730011", "qid": "70024.730011", "pos_ref": "1-VeNF…-1",
  "q": "…", "options": ["…"], "correct": 2, "explain": "…" }
```

`id` and `qid` hold the same immutable value; both are accepted so a file that carries only
one is never split into two identities. Files served by the API return `contentVersion`.

## Phases (strictly in order)

**Phase 0 — correction overlay (this change).**
Every file the backend serves has the latest `correction_events` row per qid applied in
memory before it is returned (`_shared/corrections.ts`). No pipeline change, no schema
change. An admin's fix is visible to the next request, and a second edit records a `before`
that matches what the first edit produced. Chapter files the browser fetches straight from
the CDN are *not* covered until phase 1 or until they are read through `getfile`.

**Phase 1 — immutable ids upstream.**
Pipeline emits `id`/`qid` from the Neon `stable_qn_id` and a `content_version` per artifact;
`pos_ref` carries the old value. Publish `content@v<N>` and pin it (`CONTENT_CDN_BASE`),
with integrity check and rollback to `v<N-1>`. Nothing below is correct before this lands.

**Phase 2 — weekly scoring.**
Freeze the paper at `startweeklyattempt`: ordered qid list + `content_version` + file hash in
`weekly_set_questions`. `submitweeklyattempt` accepts `[{qid, a}]`, rejects unknown and
duplicate qids, scores by lookup, and stores qid-keyed results. Positional scoring remains
only for id-less legacy files, which are labelled as such.

**Phase 3 — reports and writes.**
Refuse qid-less writes once a file has ids; backfill `question_reports.qid`, then make it
NOT NULL and keep `uid` for display. Add `base_rev`/`new_rev` to `correction_events` so two
admins editing one qid conflict instead of last-write-wins. Turn on `REQUIRE_BASE_REVISION`
once every client sends `baseUpdatedAt`.

**Phase 4 — retire `@main`.**
Serve only pinned tags; delete the branch-ref fallback from `CONTENT_CDN_BASE`.

## Invariants to test

1. **Reorder**: shuffle a file, insert one question, delete one — weekly scores, report
   matching and correction targets do not change. (`tests/handlers` harness can do this;
   it is the test that prevents all four phases from regressing.)
2. **Overlay precedence**: newest `corrected_at` wins; a correction to a qid absent from the
   file changes nothing.
3. **Hidden answers**: overlays are applied before `stripAnswers`, so an open weekly window
   never leaks a corrected answer key.
4. **Unknown ids**: a qid that matches nothing returns `-1`/not-found rather than falling
   back to the position it used to occupy.

## Rollback

Phases 0–3 are additive. Phase 0 can be disabled by removing the overlay call; phase 2 by
keeping the positional branch for files whose `content_version` is below the cutover.
Phase 4 is the only irreversible step, so it goes last and only after a full release cycle
on pinned tags.
