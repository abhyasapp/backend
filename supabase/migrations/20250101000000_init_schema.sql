-- Abhyas schema (v1) - run with `supabase db push` (or paste into the SQL editor).
--
-- Design notes
--  * Every synced column is TEXT on purpose. The Google-Sheets fallback stores everything as
--    strings and scripts/sync.js round-trips empty strings, so typed columns (timestamptz,
--    boolean, integer) would reject the "" values the API and the nightly sync both write.
--    ISO-8601 timestamps sort correctly as text.
--  * Row-Level Security is ON with NO policies: the browser never talks to PostgREST directly,
--    only the `api` Edge Function does, using the service-role key (which bypasses RLS).
--    The public anon key therefore cannot read or write a single row.
--  * Primary keys mirror the app's semantics: weekly_starts / weekly_attempts are one row per
--    (user, set), which is what stops a student restarting or re-submitting a weekly test.
-- Idempotent: safe to run more than once.

create table if not exists public.users (
  username text not null default '',
  pass_hash text not null default '',
  name text not null default '',
  email text not null default '',
  mobile text not null default '',
  contact text not null default '',
  contact_type text not null default '',
  status text not null default '',
  created_at text not null default '',
  approved_at text not null default '',
  role text not null default '',
  trial_expires_at text not null default '',
  payment_status text not null default '',
  permanent_access text not null default '',
  access_type text not null default '',
  access_expires_at text not null default '',
  session_token text not null default '',
  session_token_expires_at text not null default '',
  email_verified text not null default '',
  primary key (username)
);

create index if not exists users_email_idx on public.users (email);
create index if not exists users_session_token_idx on public.users (session_token);

create table if not exists public.admins (
  username text not null default '',
  pass_hash text not null default '',
  created_at text not null default '',
  created_by text not null default '',
  token text not null default '',
  token_expires text not null default '',
  role text not null default '',
  primary key (username)
);

create index if not exists admins_token_idx on public.admins (token);

create table if not exists public.admin_permissions (
  username text not null default '',
  feature_key text not null default '',
  enabled text not null default '',
  updated_at text not null default '',
  updated_by text not null default '',
  primary key (username, feature_key)
);

create table if not exists public.settings (
  key text not null default '',
  value text not null default '',
  primary key (key)
);

create table if not exists public.payments (
  username text not null default '',
  name text not null default '',
  email text not null default '',
  mobile text not null default '',
  tx_id text not null default '',
  remarks text not null default '',
  status text not null default '',
  rejection_reason text not null default '',
  screenshot_url text not null default '',
  submitted_at text not null default '',
  reviewed_at text not null default '',
  primary key (username)
);

create index if not exists payments_status_idx on public.payments (status);

create table if not exists public.progress (
  username text not null default '',
  data text not null default '',
  updated_at text not null default '',
  primary key (username)
);

create table if not exists public.progress_history (
  username text not null default '',
  data1 text not null default '',
  saved_at1 text not null default '',
  data2 text not null default '',
  saved_at2 text not null default '',
  data3 text not null default '',
  saved_at3 text not null default '',
  primary key (username)
);

create table if not exists public.progress_backups (
  backup_id text not null default '',
  import_id text not null default '',
  username text not null default '',
  data text not null default '',
  created_at text not null default '',
  created_by text not null default '',
  primary key (backup_id)
);

create index if not exists progress_backups_username_idx on public.progress_backups (username);
create index if not exists progress_backups_import_id_idx on public.progress_backups (import_id);

create table if not exists public.progress_imports (
  import_id text not null default '',
  admin text not null default '',
  mode text not null default '',
  status text not null default '',
  records_received text not null default '',
  records_accepted text not null default '',
  records_skipped text not null default '',
  error_count text not null default '',
  created_at text not null default '',
  completed_at text not null default '',
  details text not null default '',
  primary key (import_id)
);

create table if not exists public.push_tokens (
  username text not null default '',
  fcm_token text not null default '',
  updated_at text not null default '',
  primary key (username)
);

create table if not exists public.weekly_sets (
  id text not null default '',
  title text not null default '',
  file_id text not null default '',
  chapter_label text not null default '',
  status text not null default '',
  uploaded_by text not null default '',
  uploaded_at text not null default '',
  release_at text not null default '',
  primary key (id)
);

create index if not exists weekly_sets_status_idx on public.weekly_sets (status);

create table if not exists public.weekly_starts (
  username text not null default '',
  weekly_id text not null default '',
  started_at text not null default '',
  primary key (username, weekly_id)
);

create table if not exists public.weekly_attempts (
  username text not null default '',
  weekly_id text not null default '',
  answers_json text not null default '',
  total_questions text not null default '',
  correct_claimed text not null default '',
  skipped_count text not null default '',
  started_at text not null default '',
  submitted_at text not null default '',
  duration_sec text not null default '',
  primary key (username, weekly_id)
);

create index if not exists weekly_attempts_weekly_id_idx on public.weekly_attempts (weekly_id);

create table if not exists public.question_reports (
  id text not null default '',
  uid text not null default '',
  file_id text not null default '',
  question_snapshot text not null default '',
  options_snapshot text not null default '',
  correct_index text not null default '',
  chosen_index text not null default '',
  reason text not null default '',
  note text not null default '',
  reported_by text not null default '',
  reported_at text not null default '',
  status text not null default '',
  resolved_at text not null default '',
  resolved_by text not null default '',
  corrected text not null default '',
  corrected_snapshot text not null default '',
  section text not null default '',
  app_version text not null default '',
  primary key (id)
);

create index if not exists question_reports_reported_by_idx on public.question_reports (reported_by);
create index if not exists question_reports_status_idx on public.question_reports (status);

create table if not exists public.subjective_submissions (
  id text not null default '',
  username text not null default '',
  kind text not null default '',
  question_id text not null default '',
  question_text text not null default '',
  question_marks text not null default '',
  chapter_id text not null default '',
  solve_sec text not null default '',
  started_at text not null default '',
  submitted_at text not null default '',
  pdf_file_id text not null default '',
  pdf_url text not null default '',
  status text not null default '',
  score text not null default '',
  feedback text not null default '',
  graded_by text not null default '',
  graded_at text not null default '',
  pdf_replaced_at text not null default '',
  pdf_replaced_by text not null default '',
  pdf_original_backup_id text not null default '',
  primary key (id)
);

create index if not exists subjective_submissions_username_idx on public.subjective_submissions (username);
create index if not exists subjective_submissions_status_idx on public.subjective_submissions (status);

create table if not exists public.study_docs (
  id text not null default '',
  title text not null default '',
  category text not null default '',
  chapter_id text not null default '',
  description text not null default '',
  file_id text not null default '',
  file_name text not null default '',
  size_bytes text not null default '',
  status text not null default '',
  sort_order text not null default '',
  uploaded_by text not null default '',
  uploaded_at text not null default '',
  updated_at text not null default '',
  primary key (id)
);

create index if not exists study_docs_status_idx on public.study_docs (status);

-- Admin activity log (append-only; the API orders by timestamp).
create table if not exists public.logs (
  id bigint generated always as identity primary key,
  timestamp text not null default '',
  admin text not null default '',
  action text not null default '',
  target text not null default '',
  details text not null default ''
);
create index if not exists logs_timestamp_idx on public.logs (timestamp desc);

-- Login / abuse rate limiting (Supabase-only, never synced). Numeric on purpose: compared as numbers.
create table if not exists public.rate_limits (
  key text primary key,
  count integer not null default 0,
  reset_at bigint not null default 0
);
create index if not exists rate_limits_reset_at_idx on public.rate_limits (reset_at);

-- Lock everything down: the Edge Function (service role) is the only door.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
    revoke all on all sequences in schema public from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from authenticated;
    revoke all on all sequences in schema public from authenticated;
  end if;
end $$;

-- Private storage buckets used by the Edge Function (skipped when storage is not installed).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values
      ('payments', 'payments', false),
      ('study-docs', 'study-docs', false),
      ('subjective', 'subjective', false),
      ('subjective-backups', 'subjective-backups', false),
      ('subjective-content', 'subjective-content', false),
      ('weekly-sets', 'weekly-sets', false)
    on conflict (id) do nothing;
  end if;
end $$;
