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

-- =========================================================================
--  21 Oct 2026, later: gibberish emails, and no member until confirmed
--  -----------------------------------------------------------------------
--  Four fake accounts in a day: efwoiefwiuweriowe@gmail.com,
--  aaaaaaaaaaaaaaaa@gmail.com, and two on throwaway domains (now in the
--  list). Email confirmation is on, so an address nobody owns can never
--  sign in, but the profile was made at sign-up, so the fake still showed
--  up as a member. Two changes:
--  * email_gibberish: the part before the @ (dots, dashes and a +tag
--    dropped) is refused when it is a key held down (5+ of one
--    character), 6+ letters made of only one or two ("ababab"), a random
--    code ("90978bf9dc45"), a run along the keyboard ("asdf", "qwer"), 6+
--    consonants with no vowel, or two or more letter pairs that English
--    names don't have ("fw", "sj", "kd": "efwoiefw..."). None of the 262
--    addresses here trips it.
--  * The profile is made when the email is confirmed (auth_user_confirmed),
--    not at sign-up. handle_new_user (schema.sql) is replaced here: an
--    unconfirmed sign-up gets no profile, only the name check. At
--    confirmation the name is not checked again (whoever confirms has
--    already passed it), so a confirmation can never fail.
-- =========================================================================
create or replace function public.email_gibberish(addr text)
returns boolean
language sql
immutable
as $$
  with p as (select regexp_replace(split_part(split_part(lower(btrim(coalesce(addr, ''))), '@', 1), '+', 1), '[._-]', '', 'g') l),
       q as (select l, regexp_replace(l, '[0-9]', '', 'g') letters from p)
  select l ~ '([a-z0-9])\1{4,}'
      or (length(letters) >= 6 and (select count(distinct c) from regexp_split_to_table(letters, '') c) <= 2)
      or (l ~ '^[a-z0-9]{8,}$' and length(regexp_replace(l, '[^0-9]', '', 'g')) >= 4 and l ~ '[0-9][a-z]+[0-9]')
      or l ~ '(qwer|wert|erty|rtyu|tyui|yuio|uiop|asdf|sdfg|dfgh|fghj|ghjk|hjkl|zxcv|xcvb|cvbn|vbnm)'
      or letters ~ '[bcdfghjklmnpqrstvwxz]{6,}'
      or (select count(*) from regexp_matches(l,
            '(?=(fw|wf|qw|wq|fj|jf|vw|wv|xz|zx|jq|qj|fq|qf|pq|gq|qg|kq|zq|jz|zj|vj|jv|vk|kv|fz|zf|bq|xj|jx|mq|wx|xw|fk|kf|hx|xh|vx|xv|pz|zp|dk|kd|sj|js|hk|kh|fh|jh|dj|jd|vf|fv))',
            'g')) >= 2
  from q
$$;

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
  if public.email_gibberish(email) then
    return jsonb_build_object('ok', false, 'why',
      'That email address doesn''t look real. Use the one you actually check: we''ll email you a link to confirm it.');
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
  if public.email_gibberish(new.email) then
    raise exception 'That email address doesn''t look real. Use the one you actually check.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

/* The display name a new login asked for, as handle_new_user always made it. */
create or replace function public.signup_name(u auth.users)
returns text
language plpgsql
stable
as $$
declare nm text;
begin
  nm := left(btrim(regexp_replace(coalesce(u.raw_user_meta_data->>'display_name', ''), '\s+', ' ', 'g')), 48);
  if nm = '' then nm := left(split_part(u.email, '@', 1), 48); end if;
  if nm = '' then nm := 'New member'; end if;
  return nm;
end $$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare nm text := public.signup_name(new); c text;
begin
  if new.email_confirmed_at is null then
    /* no member until the email is confirmed; the name rule holds now */
    c := public.name_clash(nm, new.id);
    if c = '' then
      raise exception 'Use your real name, so people know who you are.' using errcode = 'check_violation';
    elsif c is not null then
      raise exception 'That name is too close to someone already on Study Track. Use your full real name, or ask an admin to set it for you.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  insert into public.profiles (id, display_name) values (new.id, nm) on conflict (id) do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create or replace function public.trg_auth_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    perform set_config('app.skip_name_check', 'on', true);
    insert into public.profiles (id, display_name) values (new.id, public.signup_name(new)) on conflict (id) do nothing;
    perform set_config('app.skip_name_check', 'off', true);
  end if;
  return new;
end $$;
revoke execute on function public.trg_auth_confirmed() from public, anon, authenticated;
drop trigger if exists auth_user_confirmed on auth.users;
create trigger auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row execute function public.trg_auth_confirmed();

create or replace function public.trg_profiles_name_clash()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare c text;
begin
  /* the profile made at confirmation: checked at sign-up already */
  if current_setting('app.skip_name_check', true) = 'on' then return new; end if;
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

-- =========================================================================
--  22 Oct 2026: "temp Gmail" addresses
--  -----------------------------------------------------------------------
--  Gmail ignores dots, so a.b.c@gmail.com is the same inbox as
--  abc@gmail.com. "Temp Gmail" sites own one Gmail account, hand out
--  endless dotted copies of it and show the inbox on screen, so the
--  confirmation link works. Two fakes came in this way, both confirmed
--  within 20 seconds: melissawhee.ler.9263.2@gmail.com and
--  billyeyokoyamacapero.nu.0.o.pzv@gmail.com.
--  * email_gmail_dotted: a Gmail address (before any +tag) with 3+ dots,
--    or 2+ one-character pieces between dots, is refused. Real ones here
--    have at most two dots and one initial ("first.r.last").
--  * gmail_key: Gmail addresses compared without dots, +tags or the
--    googlemail spelling, so a second account on the same Gmail inbox is
--    refused as "already an account on that email".
-- =========================================================================
create or replace function public.gmail_key(addr text)
returns text
language sql
immutable
as $$
  select case when lower(split_part(btrim(coalesce(addr, '')), '@', 2)) in ('gmail.com', 'googlemail.com')
    then replace(split_part(split_part(lower(btrim(addr)), '@', 1), '+', 1), '.', '') || '@gmail.com'
  end
$$;

create or replace function public.email_gmail_dotted(addr text)
returns boolean
language sql
immutable
as $$
  with p as (select split_part(split_part(lower(btrim(coalesce(addr, ''))), '@', 1), '+', 1) l)
  select public.gmail_key(addr) is not null
     and (length(l) - length(replace(l, '.', '')) >= 3
          or (select count(*) from regexp_split_to_table(l, '\.') s where length(s) = 1) >= 2)
  from p
$$;

/* someone else already has this Gmail inbox, spelt differently */
create or replace function public.gmail_taken(addr text, me uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gmail_key(addr) is not null and exists (
    select 1 from auth.users u
     where u.id is distinct from me
       and lower(split_part(u.email, '@', 2)) in ('gmail.com', 'googlemail.com')
       and public.gmail_key(u.email) = public.gmail_key(addr))
$$;
revoke execute on function public.gmail_taken(text, uuid) from public, anon, authenticated;

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
revoke all on function public.signup_check(text, text) from public;
grant execute on function public.signup_check(text, text) to anon, authenticated;

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
  if public.email_gibberish(new.email) or public.email_gmail_dotted(new.email) then
    raise exception 'That email address doesn''t look real. Use the one you actually check.'
      using errcode = 'check_violation';
  end if;
  if public.gmail_taken(new.email, new.id) then
    raise exception 'There is already an account on that Gmail address (Gmail ignores dots). Sign in instead.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
