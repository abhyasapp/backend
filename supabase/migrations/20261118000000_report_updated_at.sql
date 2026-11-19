-- 20261118000000_report_updated_at.sql
-- A SERVER-STAMPED "last changed" time for question reports.
--
-- Why: the pipeline asks "which reports changed since X?". reported_at never changes and
-- resolved_at is supplied by the caller (the pipeline sends it), so a resolution stamped 10:00
-- arriving after the cursor passed 10:05 would be invisible forever, and a re-open (which
-- clears resolved_at) leaves no trace at all. updated_at is set by the database on every
-- meaningful write, so the cursor can never run past a change.
-- Idempotent: safe to re-run.

alter table public.question_reports add column if not exists updated_at text not null default '';

-- Backfill BEFORE the trigger exists so history keeps its real times: the later of
-- reported_at / resolved_at (ISO strings compare correctly; '' sorts first).
update public.question_reports
   set updated_at = case when resolved_at > reported_at then resolved_at else reported_at end
 where updated_at = '';

create or replace function public.question_reports_touch() returns trigger language plpgsql as $$
begin
  -- A write that changes nothing (the nightly sync re-upserting an identical row, a retried
  -- resolvereports) must NOT move the cursor, or every synced row would look "changed" forever.
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    new.updated_at := old.updated_at;
    return new;
  end if;
  new.updated_at := to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  return new;
end $$;

drop trigger if exists question_reports_touch on public.question_reports;
create trigger question_reports_touch before insert or update on public.question_reports
  for each row execute function public.question_reports_touch();

create index if not exists question_reports_updated_idx on public.question_reports (updated_at, id);
