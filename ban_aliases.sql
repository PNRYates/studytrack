-- =========================================================================
--  ban_aliases: a banned address stays banned under every alias (23 Oct 2026)
--  -----------------------------------------------------------------------
--  Run after vetting.sql. banned_emails used to match the exact address, so
--  banning name+abc@outlook.com let name+xyz@outlook.com straight back in.
--  Now both sides are reduced to their mailbox before comparing:
--    * everything from "+" up to "@" is dropped (every provider)
--    * dots are dropped for Gmail, which ignores them
--  so one row covers name@, name+anything@ and, for Gmail, n.a.m.e@.
--  Safe to re-run.
-- =========================================================================
create or replace function public.email_mailbox(addr text)
returns text
language sql
immutable
set search_path = public
as $$
  with a as (select lower(btrim(coalesce(addr, ''))) e),
       p as (select split_part(split_part(e, '@', 1), '+', 1) l, split_part(e, '@', 2) d from a)
  select case when d in ('gmail.com', 'googlemail.com')
              then replace(l, '.', '') || '@gmail.com'
              else l || '@' || d end
  from p
$$;

create or replace function public.email_banned(addr text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.banned_emails b
                  where public.email_mailbox(b.email) = public.email_mailbox(addr))
$$;
revoke all on function public.email_banned(text) from public, anon, authenticated;

create or replace function public.trg_auth_email_blocked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.email_banned(new.email) then
    raise exception 'That email address has been banned from Knox Study Track.'
      using errcode = 'check_violation';
  end if;
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
