-- =========================================================================
--  SESSIONS GUARD: what the database will not take, whoever is asking
--  -----------------------------------------------------------------------
--  On 6 Oct 2026 one account scripted ~7,000 sessions of 24 hours each in
--  forty minutes, putting 167,000 fake hours in the totals. These rules stop
--  that at the door, whatever the client does:
--    * no session on a day that hasn't happened yet (a day of slack for
--      clocks and time zones);
--    * no day over 20 hours for one person (the busiest real day logged
--      so far was 17.8 h);
--    * no more than 60 sessions logged by one person in an hour (the most
--      anyone real has done is 13).
--
--  13 Oct 2026, the house rules (63 sessions over 8 h quarantined that day):
--    * one session is 8 hours at most;
--    * a day is 16 hours at most (replaces the 20);
--    * study can only be logged for the last 7 days. Admins can still fix
--      older sessions, and anyone can shorten or re-note an old one.
--  Each rule only bites when a write adds time or moves a session, so
--  trimming a session or fixing its note always works. The database owner
--  (SQL editor, no signed-in user) is exempt, so quarantined sessions can be
--  put back. app.js checks the same numbers first and says so plainly.
--  Safe to re-run.
-- =========================================================================
create index if not exists sessions_user_created_idx on public.sessions (user_id, created_at);

create or replace function public.trg_sessions_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  day_total int;
  grows boolean;
begin
  /* true when this write adds time or moves the session */
  grows := tg_op = 'INSERT' or new.day is distinct from old.day
           or new.user_id is distinct from old.user_id or new.minutes > old.minutes;
  /* the database owner putting things back (SQL editor): no signed-in user */
  if auth.uid() is null then return new; end if;

  if new.day > today + 1 then
    raise exception 'You can''t log study on a day that hasn''t happened yet' using errcode = 'check_violation';
  end if;

  if grows and new.minutes > 480 then
    raise exception 'One session can be 8 hours at most' using errcode = 'check_violation';
  end if;

  if grows and new.day < today - 7 and not coalesce(public.is_admin(), false) then
    raise exception 'Study can only be logged for the last 7 days (back to %)', to_char(today - 7, 'Dy DD Mon')
      using errcode = 'check_violation';
  end if;

  if grows then
    select coalesce(sum(minutes), 0) into day_total
      from public.sessions
     where user_id = new.user_id and day = new.day
       and (tg_op = 'INSERT' or id <> new.id);
    if day_total + new.minutes > 960 then
      raise exception 'That would put % over 16 hours, the most one day can have', to_char(new.day, 'Dy DD Mon')
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'INSERT' and (select count(*) from public.sessions
                            where user_id = new.user_id and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many sessions logged in the last hour' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists sessions_guard on public.sessions;
create trigger sessions_guard before insert or update on public.sessions
  for each row execute function public.trg_sessions_guard();

-- What was taken out, kept where only the database owner can see it.
create table if not exists public.sessions_quarantine as
  select s.*, now() as quarantined_at, ''::text as why from public.sessions s where false;
alter table public.sessions_quarantine enable row level security;
revoke all on public.sessions_quarantine from anon, authenticated;
