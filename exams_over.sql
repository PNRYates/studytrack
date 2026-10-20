-- =========================================================================
--  EXAMS OVER: no study logged for a course after its last paper
--  -----------------------------------------------------------------------
--  20 Oct 2026: people were still logging English after the last English
--  paper (Wed 14 Oct, 11:30am). Once a course's last HSC paper has
--  finished there is nothing left to study for it, so a session for that
--  subject has to have started before then.
--
--  hsc_last_paper is when each course's last paper ends, from the NESA
--  timetable in catalogue.js (44 courses). Change the timetable there and
--  here together. A subject matches by its exact course name, ignoring
--  case; app.js also catches subjects typed in by hand ("maths adv") with
--  the same matching it uses everywhere else.
--
--  Like sessions_guard.sql it only bites on writes that add time, move a
--  session or change its subject, and not on sessions with no times (they
--  can't gain time any more anyway). The database owner (SQL editor) and
--  admins fixing a session are exempt. Safe to re-run.
-- =========================================================================
create table if not exists public.hsc_last_paper (
  course   text primary key,
  last_end timestamptz not null
);
alter table public.hsc_last_paper enable row level security;
revoke all on public.hsc_last_paper from anon, authenticated;

insert into public.hsc_last_paper (course, last_end) values
  ('agriculture'                       , '2026-10-15 17:00 Australia/Sydney'),
  ('ancient history'                   , '2026-10-23 12:30 Australia/Sydney'),
  ('biology'                           , '2026-10-21 12:30 Australia/Sydney'),
  ('business studies'                  , '2026-10-26 12:30 Australia/Sydney'),
  ('chemistry'                         , '2026-10-30 12:30 Australia/Sydney'),
  ('chinese continuers'                , '2026-10-20 17:00 Australia/Sydney'),
  ('chinese extension'                 , '2026-10-22 16:00 Australia/Sydney'),
  ('chinese in context'                , '2026-10-15 16:40 Australia/Sydney'),
  ('design and technology'             , '2026-10-29 15:30 Australia/Sydney'),
  ('drama'                             , '2026-10-22 15:30 Australia/Sydney'),
  ('earth and environmental science'   , '2026-10-15 12:30 Australia/Sydney'),
  ('economics'                         , '2026-10-27 17:00 Australia/Sydney'),
  ('engineering studies'               , '2026-10-20 12:30 Australia/Sydney'),
  ('english advanced'                  , '2026-10-14 11:30 Australia/Sydney'),
  ('english eal/d'                     , '2026-10-14 11:10 Australia/Sydney'),
  ('english extension 1'               , '2026-10-28 16:00 Australia/Sydney'),
  ('english standard'                  , '2026-10-14 11:30 Australia/Sydney'),
  ('enterprise computing'              , '2026-10-29 12:20 Australia/Sydney'),
  ('french continuers'                 , '2026-11-03 17:00 Australia/Sydney'),
  ('geography'                         , '2026-11-02 17:00 Australia/Sydney'),
  ('german continuers'                 , '2026-10-13 17:00 Australia/Sydney'),
  ('german extension'                  , '2026-10-16 16:00 Australia/Sydney'),
  ('health and movement science'       , '2026-10-28 12:30 Australia/Sydney'),
  ('history extension'                 , '2026-10-21 16:00 Australia/Sydney'),
  ('industrial technology'             , '2026-11-04 15:30 Australia/Sydney'),
  ('investigating science'             , '2026-11-03 17:00 Australia/Sydney'),
  ('japanese beginners'                , '2026-10-13 16:40 Australia/Sydney'),
  ('japanese continuers'               , '2026-10-13 17:00 Australia/Sydney'),
  ('japanese extension'                , '2026-10-16 11:30 Australia/Sydney'),
  ('legal studies'                     , '2026-11-02 12:30 Australia/Sydney'),
  ('mathematics advanced'              , '2026-10-19 12:30 Australia/Sydney'),
  ('mathematics extension 1'           , '2026-10-23 16:00 Australia/Sydney'),
  ('mathematics extension 2'           , '2026-10-19 17:00 Australia/Sydney'),
  ('mathematics standard 1'            , '2026-10-19 11:30 Australia/Sydney'),
  ('mathematics standard 2'            , '2026-10-19 12:00 Australia/Sydney'),
  ('modern history'                    , '2026-10-16 12:30 Australia/Sydney'),
  ('music 1'                           , '2026-10-14 15:00 Australia/Sydney'),
  ('music 2'                           , '2026-10-14 17:00 Australia/Sydney'),
  ('physics'                           , '2026-11-05 12:30 Australia/Sydney'),
  ('science extension'                 , '2026-10-26 16:00 Australia/Sydney'),
  ('software engineering'              , '2026-10-27 12:20 Australia/Sydney'),
  ('studies of religion i'             , '2026-10-22 11:00 Australia/Sydney'),
  ('studies of religion ii'            , '2026-10-22 12:30 Australia/Sydney'),
  ('visual arts'                       , '2026-10-30 15:30 Australia/Sydney')
on conflict (course) do update set last_end = excluded.last_end;

create or replace function public.trg_sessions_exam_over()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  subj    text;
  fin     timestamptz;
  started timestamptz;
begin
  /* the database owner putting things back (SQL editor): no signed-in user */
  if auth.uid() is null then return new; end if;
  if tg_op = 'UPDATE' and coalesce(public.is_admin(), false) then return new; end if;
  /* trimming or re-noting is always fine */
  if tg_op = 'UPDATE' and new.day is not distinct from old.day and new.minutes <= old.minutes
     and new.subject_id is not distinct from old.subject_id then
    return new;
  end if;
  if jsonb_typeof(new.runs) is distinct from 'array' then return new; end if;

  select sj.name, lp.last_end into subj, fin
    from public.subjects sj join public.hsc_last_paper lp on lp.course = lower(trim(sj.name))
   where sj.id = new.subject_id;
  if fin is null then return new; end if;

  select min((r->>0)::timestamptz) into started from jsonb_array_elements(new.runs) r;
  if started >= fin then
    raise exception 'Your % exam finished on % at %. Log this under a subject you still have to sit',
      subj, to_char(fin at time zone 'Australia/Sydney', 'Dy DD Mon'),
      lower(to_char(fin at time zone 'Australia/Sydney', 'FMHH12:MIam'))
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists sessions_exam_over on public.sessions;
create trigger sessions_exam_over before insert or update on public.sessions
  for each row execute function public.trg_sessions_exam_over();
