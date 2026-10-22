-- =========================================================================
--  signup_log: who tried to make an account, and from where (22 Oct 2026)
--  -----------------------------------------------------------------------
--  Run after signup_rules.sql. Fake accounts kept coming from temp-Gmail
--  addresses; Supabase's own logs have the IP and browser but only for a
--  few days. Every sign-up attempt now leaves a row: the email and name
--  typed, whether it was let through (and why not), the IP, browser and
--  country from the request, and a few device details the page sends
--  (screen, time zone, language, touch).
--
--  signup_check gains an optional third argument (the device details) and
--  becomes volatile so it can write. Its verdict moves, unchanged, into
--  signup_verdict. Old tabs still calling it with two arguments get the
--  same answer, and a row without device details.
--
--  Only the database owner reads the table (RLS on, no grants): look in
--  the SQL editor, e.g.
--    select at, email, name, ok, ip, country, user_agent, client
--      from signup_log order by at desc limit 50;
--  Rows older than 180 days are cleared on each new sign-up.
-- =========================================================================
create table if not exists public.signup_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  email      text,
  name       text,
  ok         boolean,
  why        text,
  ip         text,
  user_agent text,
  country    text,
  language   text,
  headers    jsonb,
  client     jsonb
);
create index if not exists signup_log_at on public.signup_log (at desc);
create index if not exists signup_log_ip on public.signup_log (ip);
alter table public.signup_log enable row level security;
revoke all on public.signup_log from anon, authenticated;

/* signup_check's answer, unchanged from signup_rules.sql */
create or replace function public.signup_verdict(email text, name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare c text;
begin
  if public.email_blocked(email) then
    return jsonb_build_object('ok', false, 'why',
      'That looks like a throwaway email address. Sign up with your school or personal email.');
  end if;
  if public.email_gibberish(email) or public.email_gmail_dotted(email) then
    return jsonb_build_object('ok', false, 'why',
      'That email address doesn''t look real. Use the one you actually check: we''ll email you a link to confirm it.');
  end if;
  if public.gmail_taken(email, null) then
    return jsonb_build_object('ok', false, 'why',
      'There is already an account on that Gmail address (Gmail ignores dots). Sign in instead.');
  end if;
  c := public.name_clash(name, null);
  if c = '' then
    return jsonb_build_object('ok', false, 'why', 'Use your real name, so people know who you are.');
  elsif c is not null then
    return jsonb_build_object('ok', false, 'why',
      'That name is too close to someone already on Study Track. Use your full real name, or if it really is your name, ask an admin to set it for you.');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.signup_verdict(text, text) from public, anon, authenticated;

drop function if exists public.signup_check(text, text);
create or replace function public.signup_check(email text, name text, info jsonb default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v jsonb := public.signup_verdict(email, name);
  h jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
begin
  delete from public.signup_log where at < now() - interval '180 days';
  insert into public.signup_log (email, name, ok, why, ip, user_agent, country, language, headers, client)
  values (left(email, 320), left(name, 100), (v->>'ok')::boolean, v->>'why',
          coalesce(h->>'cf-connecting-ip', btrim(split_part(h->>'x-forwarded-for', ',', 1)), h->>'x-real-ip'),
          left(h->>'user-agent', 500), h->>'cf-ipcountry', left(h->>'accept-language', 200),
          h - 'authorization' - 'apikey' - 'cookie',
          case when info is not null and pg_column_size(info) <= 4000 then info end);
  return v;
end $$;
revoke all on function public.signup_check(text, text, jsonb) from public;
grant execute on function public.signup_check(text, text, jsonb) to anon, authenticated;
