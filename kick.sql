-- =========================================================================
--  kick: sign someone out NOW, not when their token runs out (23 Oct 2026)
--  -----------------------------------------------------------------------
--  Deleting a row from auth.sessions stops the next token refresh, but the
--  access token the browser already holds keeps working for up to an hour.
--  This pre-request check turns every request that carries a kicked
--  session id into a 401, straight away. A fresh sign-in gets a new
--  session id, so it works normally (and its IP shows up in the logs).
--
--      insert into public.kicked_sessions(session_id) values ('<uuid>');
--
--  Owner-only table (RLS on, no policies). Safe to re-run.
-- =========================================================================
create table if not exists public.kicked_sessions (
  session_id uuid primary key,
  kicked_at  timestamptz not null default now()
);
alter table public.kicked_sessions enable row level security;

create or replace function public.kick_check()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sid text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
begin
  if sid is not null and exists (select 1 from public.kicked_sessions where session_id = sid::uuid) then
    raise sqlstate 'PT401' using message = 'Signed out', detail = 'This session was ended by an admin.';
  end if;
end $$;
grant execute on function public.kick_check() to anon, authenticated;

alter role authenticator set pgrst.db_pre_request = 'public.kick_check';
notify pgrst, 'reload config';
