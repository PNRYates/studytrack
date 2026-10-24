-- =========================================================================
--  POMODORO — the cycle travels with the live timer (24 Oct 2026)
--  -----------------------------------------------------------------------
--  Pomodoro is a way of running the ordinary timer: the focus rounds are the
--  timer running and the breaks are the timer paused, so sessions, hours and
--  the six hour cap need nothing new. What the row lacks is where in the
--  cycle you are. Without it a reload forgets you were on a pomodoro, your
--  other devices never hear of it, and the strip can only call a break
--  "paused".
--
--  live_timers.pomo: null for an ordinary timer, otherwise a small object
--    { focus, brk, long, every, round, phase, base, ends, id }
--  written by the app alongside the rest of the row. Only ever read back by
--  the app; nothing on the server acts on it.
--
--  Run before the app that sends it, or every timer write is refused for an
--  unknown column. Safe to re-run.
-- =========================================================================

alter table public.live_timers add column if not exists pomo jsonb;

-- Bounded, so a browser cannot park something enormous on a row.
alter table public.live_timers drop constraint if exists live_timers_pomo_size;
alter table public.live_timers add  constraint live_timers_pomo_size
  check (pomo is null or (jsonb_typeof(pomo) = 'object' and pg_column_size(pomo) <= 600));

notify pgrst, 'reload schema';
