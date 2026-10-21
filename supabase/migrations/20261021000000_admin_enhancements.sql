-- 20261021000000_admin_enhancements.sql
-- Owner/admin model + sync tombstones. Idempotent: safe to run more than once.
-- No schema file shipped with the repo, so this only ADDS what the new code
-- needs and never alters existing columns.

-- 1. Forced password change for the default owner / reset admins.
alter table public.admins
  add column if not exists must_change_password boolean not null default false;

-- 2. Exactly-one-row-per-username guarantee the lazy owner bootstrap relies on
--    (a concurrent first login loses harmlessly on this key).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.admins'::regclass and contype in ('p', 'u')
  ) then
    alter table public.admins add constraint admins_username_key unique (username);
  end if;
end $$;

-- 3. Deletion tombstones, read by scripts/sync.js so deleted rows are not
--    resurrected from the Apps Script side.
create table if not exists public.deleted_records (
  table_name text        not null,
  pk         text        not null,
  deleted_at timestamptz not null default now(),
  primary key (table_name, pk)
);

-- Service-role only: the Edge Function and the sync job use the service key.
alter table public.deleted_records enable row level security;

-- 4. Keep tombstones from growing forever (sync only needs recent ones).
create or replace function public.prune_deleted_records(keep_days int default 60)
returns void language sql as $$
  delete from public.deleted_records where deleted_at < now() - make_interval(days => keep_days);
$$;
