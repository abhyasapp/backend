-- 20261117000000_qid_core.sql
-- The question id (qid) becomes the key for every per-question fact. Position
-- and file are derived, display-only attributes.  Idempotent: safe to re-run.
--
-- Convention kept from the base schema: every column is TEXT with default ''
-- (the Apps Script mirror stores sheets of strings and sync.js compares text).

-- ── 1. Question registry ────────────────────────────────────────────────
-- One row per question. `ord` (position) is informational and rewritten each
-- time a file is (re)indexed; nothing may key on it.  `canonical_qid` is the
-- redirect written when two questions are merged or one is retired: state that
-- was saved against the old qid resolves to the canonical one.
create table if not exists public.question_index (
  qid           text not null default '',
  file_id       text not null default '',
  ord           text not null default '',
  rev           text not null default '',
  kind          text not null default '',          -- stable | positional
  status        text not null default 'active',    -- active | retired | merged
  canonical_qid text not null default '',
  updated_at    text not null default '',
  primary key (qid)
);
create index if not exists question_index_file_idx on public.question_index (file_id);
create index if not exists question_index_canon_idx on public.question_index (canonical_qid);

-- ── 2. Per-student, per-question state: notes, bookmarks, flags, mistakes ──
-- Replaces "arrays of positions/uids inside the progress blob". Merged per
-- field by the *_at timestamps (last writer wins per field, not per row), so
-- a note edited on a phone and a bookmark toggled on a laptop both survive.
create table if not exists public.user_qstate (
  username       text not null default '',
  qid            text not null default '',
  file_id        text not null default '',
  note           text not null default '',
  note_at        text not null default '',
  bookmarked     text not null default '',   -- 'true' | 'false'
  bookmarked_at  text not null default '',
  flagged        text not null default '',
  flagged_at     text not null default '',
  in_mistakes    text not null default '',   -- 'true' while on the mistake list
  mistakes_at    text not null default '',
  attempts       text not null default '0',
  wrong          text not null default '0',
  last_result    text not null default '',   -- ok | wrong
  last_at        text not null default '',
  updated_at     text not null default '',   -- server time of the last change (delta-sync cursor)
  primary key (username, qid)
);
create index if not exists user_qstate_user_updated_idx on public.user_qstate (username, updated_at);

-- ── 3. Answer events (idempotent: one per student × qid × instant) ──────
create table if not exists public.answer_events (
  username    text not null default '',
  qid         text not null default '',
  at          text not null default '',
  file_id     text not null default '',
  ok          text not null default '',
  chosen      text not null default '',
  mode        text not null default '',
  session_id  text not null default '',
  primary key (username, qid, at)
);
create index if not exists answer_events_qid_idx on public.answer_events (qid);

-- ── 4. Aggregate per-question statistics ───────────────────────────────
create table if not exists public.qid_stats (
  qid        text not null default '',
  attempts   text not null default '0',
  wrong      text not null default '0',
  students   text not null default '0',    -- distinct students who ever answered it
  updated_at text not null default '',
  primary key (qid)
);

-- Atomic, so concurrent submissions never lose an increment.
create or replace function public.bump_qid_stats(p_qid text, p_attempts int, p_wrong int, p_students int)
returns void language plpgsql as $$
begin
  insert into public.qid_stats as s (qid, attempts, wrong, students, updated_at)
  values (p_qid, p_attempts::text, p_wrong::text, p_students::text,
          to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  on conflict (qid) do update set
    attempts   = ((case when s.attempts ~ '^[0-9]+$' then s.attempts::int else 0 end) + p_attempts)::text,
    wrong      = ((case when s.wrong    ~ '^[0-9]+$' then s.wrong::int    else 0 end) + p_wrong)::text,
    students   = ((case when s.students ~ '^[0-9]+$' then s.students::int else 0 end) + p_students)::text,
    updated_at = to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
end $$;

-- ── 5. Weekly papers are frozen by qid ─────────────────────────────────
-- weekly_sets.qids: JSON array of the qids on the paper when it was created.
-- weekly_attempts.answers_by_qid: JSON {qid: chosenIndex}; qids / file_rev: the
-- paper this student actually saw, so an attempt can always be re-scored.
-- `voided`: qids dropped from the paper after the fact (removed question).
alter table public.weekly_sets     add column if not exists qids    text not null default '';
alter table public.weekly_sets     add column if not exists file_rev text not null default '';
alter table public.weekly_attempts add column if not exists answers_by_qid text not null default '';
alter table public.weekly_attempts add column if not exists qids     text not null default '';
alter table public.weekly_attempts add column if not exists file_rev text not null default '';
alter table public.weekly_attempts add column if not exists voided   text not null default '';

-- ── 6. Corrections carry the question revision they were based on / made ──
alter table public.correction_events add column if not exists base_rev text not null default '';
alter table public.correction_events add column if not exists new_rev  text not null default '';
create index if not exists correction_events_file_idx on public.correction_events (file_id);

-- ── 7. RLS: only the service role touches data ─────────────────────────
alter table public.question_index  enable row level security;
alter table public.user_qstate     enable row level security;
alter table public.answer_events   enable row level security;
alter table public.qid_stats       enable row level security;

revoke execute on function public.bump_qid_stats(text, int, int, int) from public;
do $$
declare role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke execute on function public.bump_qid_stats(text, int, int, int) from %I', role_name);
    end if;
  end loop;
end $$;
