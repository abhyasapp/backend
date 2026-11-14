-- Stable question ids on reports, plus a durable correction-event log consumed
-- by the Drive -> Neon pipeline. Both are additive and safe to re-run.

alter table public.question_reports
  add column if not exists qid text not null default '';

create index if not exists question_reports_qid_idx
  on public.question_reports (qid);

create index if not exists question_reports_user_time_idx
  on public.question_reports (reported_by, reported_at desc);

create table if not exists public.correction_events (
  id           bigserial primary key,
  dedupe_key   text not null,
  uid          text not null default '',
  qid          text not null default '',
  file_id      text not null default '',
  report_id    text not null default '',
  corrected_at text not null,
  before       text not null default '{}',
  after        text not null default '{}',
  note         text not null default '',
  admin_user   text not null default '',
  created_at   text not null default '',
  unique (dedupe_key, corrected_at)
);

create index if not exists correction_events_qid_idx
  on public.correction_events (qid);

create index if not exists correction_events_time_idx
  on public.correction_events (corrected_at);

alter table public.correction_events enable row level security;