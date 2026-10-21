-- =========================================================================
--  SIGN-UP RULES: no throwaway emails, no look-alike names
--  -----------------------------------------------------------------------
--  21 Oct 2026. Fake accounts were being made with throwaway addresses
--  and with names a letter or a word away from a real member's
--  ("the demon" / "THE DEMON BRAIN", "Jack Phillips" / "Jack Phillips
--  Curve"). Email verification itself is a Supabase setting, not SQL:
--  Authentication > Sign In / Providers > Email > Confirm email.
--
--  * Throwaway email: a new login whose address is on a throwaway domain
--    (or a subdomain of one) is refused. The list is
--    blocked_email_domains.sql, loaded from the public
--    disposable-email-domains list plus the ones seen here; re-run it to
--    refresh.
--  * Look-alike names: a display name is compared with everybody else's
--    after lower-casing, dropping accents, digits, punctuation, repeated
--    letters and filler words (official, real, the, og, ...). It is
--    refused when it
--      - comes out the same as another member's ("Max Baker official"),
--      - contains a full name of two or more words ("Max Baker Jr"), or
--      - is one letter off a full name (two letters for long ones):
--        "Maxy Baker".
--    A first name on its own only clashes with the same first name on its
--    own, so "James" and "James Smart" can both exist. Checked when a
--    profile is created (sign-up) and when a name changes; changing only
--    the capitals of your own name is always fine, and admins can rename
--    anyone. Existing look-alikes are left as they are.
--  * signup_check (anyone) and name_check (signed in) let the app say why
--    before it tries, instead of a generic "Database error".
--  Safe to re-run.
-- =========================================================================
create extension if not exists unaccent with schema extensions;
create extension if not exists fuzzystrmatch with schema extensions;

create table if not exists public.blocked_email_domains (domain text primary key);
alter table public.blocked_email_domains enable row level security;
revoke all on public.blocked_email_domains from anon, authenticated;

create or replace function public.email_blocked(addr text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with d as (select lower(split_part(btrim(coalesce(addr, '')), '@', 2)) dom)
  select exists (
    select 1 from public.blocked_email_domains b, d
     where d.dom = b.domain or d.dom like '%.' || b.domain)
$$;

/* "Max  Baker OFFICIAL 2" -> "max baker" */
create or replace function public.name_norm(nm text)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(
           ' ' || regexp_replace(lower(extensions.unaccent(coalesce(nm, ''))), '[^a-z]+', ' ', 'g') || ' ',
           ' (the|official|offical|real|realest|og|actual|actually|legit|verified|mr|its|im|irl|acc|account|alt|main|fake|true|original|orig|da|tha|xx|x)(?= )',
           ' ', 'g'),
         '([a-z])\1+', '\1', 'g'),
         '\s+', ' ', 'g'))
$$;

/* The display name of somebody else that nm is too close to, or null.
   '' when nm has nothing left once the filler is gone. */
create or replace function public.name_clash(nm text, me uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  n  text := public.name_norm(nm);
  ns text := replace(public.name_norm(nm), ' ', '');
  full_name boolean := public.name_norm(nm) like '% %';
  hit text;
begin
  if n = '' then return ''; end if;
  select p.display_name into hit
    from public.profiles p, lateral (select public.name_norm(p.display_name) e) x
   where p.id is distinct from me and x.e <> ''
     and (x.e = n
          or (full_name and x.e like '% %' and
              ((' ' || x.e || ' ') like ('% ' || n || ' %') or (' ' || n || ' ') like ('% ' || x.e || ' %')))
          or (full_name and x.e like '% %'
              and n !~ '(^| )[a-z]( |$)' and x.e !~ '(^| )[a-z]( |$)'
              and extensions.levenshtein(ns, replace(x.e, ' ', ''))
                  <= case when length(ns) >= 12 then 2 else 1 end))
   limit 1;
  return hit;
end $$;

/* Before signing up: is this email and name going to be accepted? Says
   why not without naming anybody, since whoever asks is not signed in. */
create or replace function public.signup_check(email text, name text)
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
  c := public.name_clash(name, null);
  if c = '' then
    return jsonb_build_object('ok', false, 'why', 'Use your real name, so people know who you are.');
  elsif c is not null then
    return jsonb_build_object('ok', false, 'why',
      'That name is too close to someone already on Study Track. Use your full real name, or if it really is your name, ask an admin to set it for you.');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.signup_check(text, text) from public;
grant execute on function public.signup_check(text, text) to anon, authenticated;

/* Renaming yourself: the same rule, and here it is fine to say who. */
create or replace function public.name_check(name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare c text; mine text;
begin
  select display_name into mine from public.profiles where id = auth.uid();
  if public.name_norm(name) = public.name_norm(mine) then return jsonb_build_object('ok', true); end if;
  c := public.name_clash(name, auth.uid());
  if c = '' then
    return jsonb_build_object('ok', false, 'why', 'Use your real name, so people know who you are.');
  elsif c is not null then
    return jsonb_build_object('ok', false, 'why',
      format('That name is too close to %s, who is already here. Use your full real name, or if it really is your name, ask an admin to set it for you.', c));
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.name_check(text) from public;
grant execute on function public.name_check(text) to authenticated;

-- The rules themselves, whatever the app does.
create or replace function public.trg_auth_email_blocked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.email_blocked(new.email) then
    raise exception 'That looks like a throwaway email address. Sign up with your school or personal email.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists auth_email_blocked on auth.users;
create trigger auth_email_blocked before insert on auth.users
  for each row execute function public.trg_auth_email_blocked();

create or replace function public.trg_profiles_name_clash()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare c text;
begin
  if tg_op = 'UPDATE' then
    if new.display_name is not distinct from old.display_name then return new; end if;
    if public.name_norm(new.display_name) = public.name_norm(old.display_name) then return new; end if;
    if coalesce(public.is_admin(), false) then return new; end if;
  end if;
  c := public.name_clash(new.display_name, new.id);
  if c = '' then
    raise exception 'Use your real name, so people know who you are.' using errcode = 'check_violation';
  elsif c is not null then
    raise exception 'That name is too close to %, who is already here. Use your full real name, or ask an admin to set it for you.', c
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists profiles_name_clash on public.profiles;
create trigger profiles_name_clash before insert or update of display_name on public.profiles
  for each row execute function public.trg_profiles_name_clash();
