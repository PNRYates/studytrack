-- =========================================================================
--  approvals: an admin lets each new account in (22 Oct 2026)
--  -----------------------------------------------------------------------
--  Run after signup_log.sql. Fake accounts kept getting past the sign-up
--  rules, so a new account now waits for an admin once its email is
--  confirmed:
--
--    * Confirming the email puts the account on hold: a row in
--      pending_accounts, and the login banned (banned_until = infinity),
--      so Supabase will not sign it in or refresh its token. It gets no
--      profile, so it shows up nowhere in the app.
--    * Confirming hands back one session before the ban can bite (the
--      ban is checked before the confirm, not after). That token lasts an
--      hour, so it is shut out here as well: gate_pending() refuses every
--      API call from a held account except my_access(), and a restrictive
--      policy on every table hides all rows from it (that is what covers
--      realtime, which does not go through the API).
--    * Admins open the app and get a popup per held account, with what
--      signup_log saw (IP, country, browser, device). Approve unbans it
--      and makes the profile; Deny deletes the login. Both go in
--      admin_audit.
--
--  Admins' own addresses (is_admin's list) are never held. Accounts that
--  existed before this file are untouched. Safe to re-run.
-- =========================================================================

create table if not exists public.pending_accounts (
  user_id      uuid primary key references auth.users on delete cascade,
  email        text,
  name         text,
  signed_up_at timestamptz,
  confirmed_at timestamptz not null default now()
);
alter table public.pending_accounts enable row level security;
revoke all on public.pending_accounts from anon, authenticated;

/* is_admin's list, by address, for the trigger (which has no auth.uid()) */
create or replace function public.admin_email(addr text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select lower(coalesce(addr, '')) = any (array[
    'lchristie26@knox.nsw.edu.au',
    'akhannaboyle26@knox.nsw.edu.au'
  ]);
$$;
revoke execute on function public.admin_email(text) from public, anon, authenticated;

create or replace function public.am_pending()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (select 1 from public.pending_accounts where user_id = auth.uid());
$$;
revoke all on function public.am_pending() from public, anon;
grant execute on function public.am_pending() to authenticated;

/* ---------- hold the account the moment its email is confirmed ---------- */
create or replace function public.trg_auth_hold()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null
     and not public.admin_email(new.email)
     and not exists (select 1 from public.profiles where id = new.id) then
    insert into public.pending_accounts (user_id, email, name, signed_up_at)
    values (new.id, new.email, public.signup_name(new), new.created_at)
    on conflict (user_id) do nothing;
    new.banned_until := 'infinity';
  end if;
  return new;
end $$;
revoke execute on function public.trg_auth_hold() from public, anon, authenticated;

drop trigger if exists auth_user_hold on auth.users;
create trigger auth_user_hold
  before update of email_confirmed_at on auth.users
  for each row execute function public.trg_auth_hold();

/* signup_rules.sql's confirm trigger, now leaving held accounts without a
   profile; approving makes it */
create or replace function public.trg_auth_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null
     and not exists (select 1 from public.pending_accounts where user_id = new.id) then
    perform set_config('app.skip_name_check', 'on', true);
    insert into public.profiles (id, display_name) values (new.id, public.signup_name(new)) on conflict (id) do nothing;
    perform set_config('app.skip_name_check', 'off', true);
  end if;
  return new;
end $$;

/* ---------- a held account can ask where it stands, and nothing else ---------- */
create or replace function public.my_access()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when public.am_pending() then 'pending' else 'ok' end;
$$;
revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;

create or replace function public.gate_pending()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.am_pending()
     and coalesce(current_setting('request.path', true), '') not like '%/rpc/my_access' then
    raise exception 'Your account is waiting for an admin to approve it.'
      using errcode = '42501';
  end if;
end $$;
/* runs before every API request, signed in or not, as that request's role */
revoke all on function public.gate_pending() from public;
grant execute on function public.gate_pending() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request = 'public.gate_pending';
notify pgrst, 'reload config';

do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format('drop policy if exists "approved only" on public.%I', t);
    execute format('create policy "approved only" on public.%I as restrictive for all to authenticated
                      using (not (select public.am_pending())) with check (not (select public.am_pending()))', t);
  end loop;
end $$;

drop policy if exists "approved only" on storage.objects;
create policy "approved only" on storage.objects as restrictive for all to authenticated
  using (not (select public.am_pending())) with check (not (select public.am_pending()));

/* ---------- the admin's side ---------- */
create or replace function public.admin_pending()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'not an administrator'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'confirmed_at')
    from (
      select jsonb_build_object(
        'id', p.user_id, 'email', p.email, 'name', p.name,
        'signed_up_at', p.signed_up_at, 'confirmed_at', p.confirmed_at,
        'ip', l.ip, 'country', l.country, 'language', l.language,
        'user_agent', l.user_agent, 'device', l.client, 'logged_at', l.at,
        'tries', (select count(*) from public.signup_log t where lower(t.email) = lower(p.email)),
        'same_ip', case when l.ip is null then '[]'::jsonb else coalesce((
          select jsonb_agg(distinct coalesce(pr.display_name, o.email))
          from public.signup_log o
          join auth.users u on lower(u.email) = lower(o.email) and u.id <> p.user_id
          left join public.profiles pr on pr.id = u.id
          where o.ip = l.ip and o.ok), '[]'::jsonb) end
      ) x
      from public.pending_accounts p
      left join lateral (
        select * from public.signup_log s
        where lower(s.email) = lower(p.email) and s.ok
        order by s.at desc limit 1
      ) l on true
    ) q
  ), '[]'::jsonb);
end $$;
revoke all on function public.admin_pending() from public, anon;
grant execute on function public.admin_pending() to authenticated;

create or replace function public.admin_review(target uuid, approve boolean)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  p public.pending_accounts;
  me text := (select display_name from public.profiles where id = auth.uid());
begin
  if not public.is_admin() then raise exception 'not an administrator'; end if;
  select * into p from public.pending_accounts where user_id = target;
  if not found then return 'gone'; end if;   /* the other admin got there first */

  insert into public.admin_audit (actor_id, actor_name, action, target_user, target_name, summary, snapshot)
  values (auth.uid(), me, case when approve then 'approve_account' else 'deny_account' end,
          target, p.name, (case when approve then 'Approved ' else 'Denied ' end) || coalesce(p.name, '') || ' <' || coalesce(p.email, '') || '>',
          to_jsonb(p));

  if approve then
    delete from public.pending_accounts where user_id = target;
    update auth.users set banned_until = null where id = target;
    perform set_config('app.skip_name_check', 'on', true);
    insert into public.profiles (id, display_name)
      select u.id, public.signup_name(u) from auth.users u where u.id = target
      on conflict (id) do nothing;
    perform set_config('app.skip_name_check', 'off', true);
    return 'approved';
  end if;
  delete from auth.users where id = target;
  return 'denied';
end $$;
revoke all on function public.admin_review(uuid, boolean) from public, anon;
grant execute on function public.admin_review(uuid, boolean) to authenticated;
