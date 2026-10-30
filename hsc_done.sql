-- =========================================================================
--  HSC DONE: when each member's last paper ends, for everyone to see
--  -----------------------------------------------------------------------
--  30 Oct 2026. celebrate.js throws the party on your own screen when your
--  last paper ends. To put a "🎓 HSC done" tag beside you everywhere else
--  (the peloton, the today list, the live strip, your profile, chat), other
--  people's apps need to know that moment too, and they never load your
--  subjects. So it goes on your profile row, which everybody already reads.
--
--  profiles.hsc_done_at: when your last paper ends. Your own app writes it
--  whenever it works it out (celebrate.js, from the same exam list as the
--  countdown, which understands hand-typed names and dates of your own).
--  The backfill below fills it in for everybody now from hsc_last_paper
--  (exams_over.sql), matching course names exactly, so members who have
--  not opened the app since still get their tag; their app corrects it the
--  next time they do. It may be in the future: the tag shows once it has
--  passed. Run after exams_over.sql. Safe to re-run.
-- =========================================================================

alter table public.profiles add column if not exists hsc_done_at timestamptz;

-- A date in the 2026 HSC season or a little after, nothing else.
alter table public.profiles drop constraint if exists profiles_hsc_done_at_range;
alter table public.profiles add  constraint profiles_hsc_done_at_range
  check (hsc_done_at is null
         or hsc_done_at between '2026-10-01 00:00 Australia/Sydney' and '2027-03-01 00:00 Australia/Sydney');

-- The profile history (events, 'profile.edit') records what people change
-- about themselves. hsc_done_at is the app's bookkeeping, not an edit, so
-- like updated_at it is left out: otherwise the backfill below and every
-- correction from somebody's app would each log a whole profile.
create or replace function public.trg_profiles_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if to_jsonb(new) - 'updated_at' - 'hsc_done_at' is not distinct from to_jsonb(old) - 'updated_at' - 'hsc_done_at' then
    return null;
  end if;
  perform public.log_event('profile.edit', auth.uid(), new.id, new.id,
    jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new)));
  return null;
exception when others then return null;
end $fn$;

-- Backfill: the latest last paper among your subjects, or the end of the
-- whole HSC if none of them match a course. Only where nothing is set yet,
-- so it never overwrites what somebody's own app worked out.
update public.profiles p
   set hsc_done_at = coalesce(
         (select max(h.last_end)
            from public.subjects s
            join public.hsc_last_paper h on h.course = lower(btrim(s.name))
           where s.user_id = p.id),
         (select max(last_end) from public.hsc_last_paper))
 where p.hsc_done_at is null;

notify pgrst, 'reload schema';
