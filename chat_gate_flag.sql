-- =========================================================================
--  CHAT GATE FLAG — one switch to open chat to everyone, or close it again
--  -----------------------------------------------------------------------
--  22 Oct 2026. chat_approval.sql / vetting.sql hold new (and flagged)
--  accounts out of chat until an admin approves them. Sometimes you want the
--  gate open for a while — to watch what a troublemaker does next without the
--  wall in the way — and then shut again, with every account that was waiting
--  going straight back to waiting. This makes that a single boolean.
--
--  * app_flags.chat_gate — true: gate on, unapproved accounts cannot chat
--    (the normal state). false: gate off, anyone who is not muted can chat,
--    without touching a single chat_approved value, so turning it back on
--    restores the exact state it was in.
--  * chat_gate_on() — what the gate and the app read. Missing flag reads as
--    on, so a half-run migration errs on the side of gated.
--  * chat_block() now asks chat_gate_on() before the approval check. Mute is
--    never affected: a muted account stays muted whatever the gate is doing.
--
--  Open the gate:  update public.app_flags set val = false where key = 'chat_gate';
--  Close it again: update public.app_flags set val = true  where key = 'chat_gate';
--  (The app re-reads it on every load, so no deploy is needed to flip it.)
--  Safe to re-run — re-running does not change the flag's current value.
-- =========================================================================

create table if not exists public.app_flags (
  key        text primary key,
  val        boolean not null,
  updated_at timestamptz not null default now()
);
alter table public.app_flags enable row level security;
revoke all on public.app_flags from anon, authenticated;

create or replace function public.chat_gate_on()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select val from public.app_flags where key = 'chat_gate'), true)
$$;
revoke all on function public.chat_gate_on() from public;
grant execute on function public.chat_gate_on() to anon, authenticated;

create or replace function public.chat_block(me uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p.id is null then 'You are not a member yet'
    when p.chat_muted then 'An administrator has muted you in chat'
    when public.chat_gate_on() and not p.chat_approved then
      'Await verification from the owner before you have permission to chat. New accounts are checked by hand, and you''ll be approved soon.'
  end
  from (select 1) one
  left join public.profiles p on p.id = me
$$;
revoke execute on function public.chat_block(uuid) from public, anon;
grant  execute on function public.chat_block(uuid) to authenticated;

-- Default the flag on if it has never been set; a re-run leaves it as it is.
insert into public.app_flags(key, val) values ('chat_gate', true)
  on conflict (key) do nothing;

notify pgrst, 'reload schema';
