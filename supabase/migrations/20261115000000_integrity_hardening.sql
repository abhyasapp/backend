-- 20261115000000_integrity_hardening.sql
-- Additive and safe to re-run. Unique indexes are only created when existing data has no
-- duplicates; otherwise a NOTICE explains what to clean up first (re-run afterwards).
--
-- NOTE for the Supabase <-> Apps Script sync: once these unique indexes exist, a sync insert that
-- carries a duplicate email / mobile / QOTD submission will fail with 23505 instead of silently
-- creating a second row. That is the intent, but check the sync log after the first run.

-- 1. Lookup indexes ---------------------------------------------------------------------
create index if not exists users_mobile_idx on public.users (mobile) where mobile <> '';
create index if not exists payments_tx_id_lower_idx on public.payments (lower(tx_id));
create index if not exists subjective_submissions_pdf_file_id_idx on public.subjective_submissions (pdf_file_id);

-- 2. Uniqueness the app previously only "checked" (check-then-insert races) -------------------
do $$
begin
  if exists (select 1 from public.users where email <> '' group by lower(email) having count(*) > 1) then
    raise notice 'Skipped UNIQUE on users.email: duplicate emails exist. Resolve them, then re-run this migration.';
    create index if not exists users_email_lower_idx on public.users (lower(email)) where email <> '';
  else
    create unique index if not exists users_email_unique on public.users (lower(email)) where email <> '';
  end if;

  if exists (select 1 from public.users where mobile <> '' group by mobile having count(*) > 1) then
    raise notice 'Skipped UNIQUE on users.mobile: duplicate mobile numbers exist. Resolve them, then re-run this migration.';
  else
    create unique index if not exists users_mobile_unique on public.users (mobile) where mobile <> '';
  end if;

  if exists (
    select 1 from public.subjective_submissions where kind = 'qotd'
    group by username, question_id having count(*) > 1
  ) then
    raise notice 'Skipped UNIQUE on QOTD submissions: duplicates exist. Resolve them, then re-run this migration.';
  else
    create unique index if not exists subjective_qotd_unique
      on public.subjective_submissions (username, question_id) where kind = 'qotd';
  end if;
end $$;

-- 3. Storage guard-rails -------------------------------------------------------------------
-- Size limits everywhere. MIME allow-lists only on buckets that ONLY the Edge Function writes
-- (signed uploads from browsers send whatever Content-Type the client picks, so a MIME list on
-- those buckets could reject legitimate uploads; the function checks magic bytes instead).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets set file_size_limit = 6 * 1024 * 1024  where id = 'payments';
    update storage.buckets set file_size_limit = 10 * 1024 * 1024 where id in ('subjective', 'subjective-backups');
    update storage.buckets set file_size_limit = 50 * 1024 * 1024 where id = 'study-docs';
    update storage.buckets set file_size_limit = 5 * 1024 * 1024, allowed_mime_types = array['application/json']
      where id in ('weekly-sets', 'subjective-content');
  end if;
end $$;

-- 4. Housekeeping functions: callable by the service role only ------------------------------
create or replace function public.prune_rate_limits()
returns void language sql as $$
  delete from public.rate_limits where reset_at < (extract(epoch from now()) * 1000)::bigint;
$$;

-- Atomic rate-limit counter used by _shared/rate-limit.ts (one statement, no read-then-write race).
create or replace function public.rl_hit(p_key text, p_window_ms bigint)
returns integer language plpgsql as $$
declare
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  new_count integer;
begin
  insert into public.rate_limits as r (key, count, reset_at)
  values (p_key, 1, now_ms + p_window_ms)
  on conflict (key) do update set
    count    = case when r.reset_at <= now_ms then 1 else r.count + 1 end,
    reset_at = case when r.reset_at <= now_ms then now_ms + p_window_ms else r.reset_at end
  returning r.count into new_count;
  return new_count;
end $$;

revoke execute on function public.rl_hit(text, bigint) from public;
revoke execute on function public.prune_deleted_records(int) from public;
revoke execute on function public.prune_rate_limits() from public;

-- Supabase always has these roles; plain Postgres/PGlite may not. Keep the
-- migration runnable in the offline schema gate as well as in production.
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke execute on function public.rl_hit(text, bigint) from %I', role_name);
      execute format('revoke execute on function public.prune_deleted_records(int) from %I', role_name);
      execute format('revoke execute on function public.prune_rate_limits() from %I', role_name);
    end if;
  end loop;
end $$;

-- Schedule (enable pg_cron in the dashboard first), e.g.:
--   select cron.schedule('prune-tombstones', '17 3 * * *', $$select public.prune_deleted_records(60)$$);
--   select cron.schedule('prune-rate-limits', '*/30 * * * *', $$select public.prune_rate_limits()$$);
