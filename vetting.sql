-- =========================================================================
--  VETTING — anyone can join; chat waits for an admin
--  -----------------------------------------------------------------------
--  22 Oct 2026. Run after chat_approval.sql and approvals.sql. It replaces
--  approvals.sql's front-door hold with a gate at chat only, and keeps the
--  best of both:
--
--  * Signing up works as it always has: confirm the email, sign in, use
--    everything. The hold (banned login, no profile, pre-request gate,
--    restrictive policies) is removed, and anyone it was holding is let in.
--  * A new account starts with chat_approved = false (chat_approval.sql), so
--    it cannot post or react until an admin says so, and is told why.
--  * Admins get a popup in the app for each new account they have not
--    looked at yet, with what signup_log saw (IP, country, browser, device,
--    attempts, other members on the same IP), the roster match and the
--    admin note. The same accounts are listed in the console under
--    Awaiting vetting.
--  * Three decisions, all in admin_audit:
--      approve — they can chat;
--      wait    — leave them out of chat, stop the popup for them;
--      ban     — delete the account and everything it owns, and refuse
--                that email address at sign-up from then on.
--  * admin_notes gains reviewed_at (popup seen), and the roster match:
--    real_name, roster_code, name_match (confirmed / likely / guess / none).
--    school_roster holds the 2026 Year 12 list (code, surname, preferred
--    name, house). Admins only, both of them.
--  Safe to re-run.
-- =========================================================================

-- ---------- 1. take the front-door hold off ----------
drop trigger if exists auth_user_hold on auth.users;

-- signup_rules.sql's confirm trigger, as it was before the hold: confirming
-- the email makes the profile (which starts out of chat).
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

/* only undo approvals.sql's hook; kick.sql's kick_check uses the same slot */
do $$ begin
  if exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
              where r.rolname = 'authenticator'
                and 'pgrst.db_pre_request=public.gate_pending' = any(s.setconfig)) then
    alter role authenticator reset pgrst.db_pre_request;
  end if;
end $$;
notify pgrst, 'reload config';

do $$
declare t record;
begin
  for t in select schemaname, tablename from pg_policies where policyname = 'approved only' loop
    execute format('drop policy if exists "approved only" on %I.%I', t.schemaname, t.tablename);
  end loop;
end $$;

-- Anyone the hold was keeping out: let them in, out of chat.
do $$
declare r record;
begin
  if to_regclass('public.pending_accounts') is null then return; end if;
  for r in select * from public.pending_accounts loop
    update auth.users set banned_until = null where id = r.user_id;
    perform set_config('app.skip_name_check', 'on', true);
    insert into public.profiles (id, display_name)
      select u.id, public.signup_name(u) from auth.users u where u.id = r.user_id
      on conflict (id) do nothing;
    perform set_config('app.skip_name_check', 'off', true);
  end loop;
end $$;

drop function if exists public.gate_pending();
drop function if exists public.my_access();
drop function if exists public.admin_pending();
drop function if exists public.admin_review(uuid, boolean);
drop function if exists public.am_pending();
drop function if exists public.trg_auth_hold();
drop table if exists public.pending_accounts;

-- ---------- 2. banned addresses ----------
create table if not exists public.banned_emails (
  email     text primary key,
  banned_at timestamptz not null default now(),
  banned_by uuid,
  reason    text
);
alter table public.banned_emails enable row level security;
revoke all on public.banned_emails from anon, authenticated;

create or replace function public.trg_auth_email_blocked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.banned_emails b where b.email = lower(btrim(new.email))) then
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

-- ---------- 3. notes, roster match ----------
alter table public.admin_notes add column if not exists reviewed_at timestamptz;
alter table public.admin_notes add column if not exists real_name   text;
alter table public.admin_notes add column if not exists roster_code text;
alter table public.admin_notes add column if not exists name_match  text
  check (name_match in ('confirmed', 'likely', 'guess', 'none'));

create table if not exists public.school_roster (
  code      text primary key,
  surname   text not null,
  preferred text not null,
  house     text,
  cohort    text not null default '2026 Year 12'
);
alter table public.school_roster enable row level security;
drop policy if exists "admins only" on public.school_roster;
create policy "admins only" on public.school_roster for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.school_roster from anon;
grant select on public.school_roster to authenticated;

-- ---------- 4. the admin's side ----------
/* Everyone out of chat, newest first, with what signup_log saw. */
create or replace function public.admin_vetting()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'not an administrator'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'created_at' desc)
    from (
      select jsonb_build_object(
        'id', p.id, 'email', u.email, 'name', p.display_name,
        'signup_name', public.signup_name(u),
        'created_at', u.created_at, 'confirmed_at', u.email_confirmed_at,
        'reviewed_at', n.reviewed_at, 'note', n.note,
        'real_name', n.real_name, 'roster_code', n.roster_code, 'name_match', n.name_match,
        'ip', l.ip, 'country', l.country, 'language', l.language,
        'user_agent', l.user_agent, 'device', l.client, 'logged_at', l.at,
        'tries', (select count(*) from public.signup_log t where lower(t.email) = lower(u.email)),
        'same_ip', case when l.ip is null then '[]'::jsonb else coalesce((
          select jsonb_agg(distinct coalesce(pr.display_name, o.email))
          from public.signup_log o
          join auth.users u2 on lower(u2.email) = lower(o.email) and u2.id <> u.id
          left join public.profiles pr on pr.id = u2.id
          where o.ip = l.ip and o.ok), '[]'::jsonb) end
      ) x
      from public.profiles p
      join auth.users u on u.id = p.id
      left join public.admin_notes n on n.user_id = p.id
      left join lateral (
        select * from public.signup_log s
        where lower(s.email) = lower(u.email) and s.ok
        order by s.at desc limit 1
      ) l on true
      where not p.chat_approved
    ) q
  ), '[]'::jsonb);
end $$;
revoke all on function public.admin_vetting() from public, anon;
grant execute on function public.admin_vetting() to authenticated;

/* approve: into chat. wait: stays out, popup stops. ban: gone, and the
   address is refused at sign-up from now on. */
create or replace function public.admin_vet(target uuid, decision text)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  me   uuid := auth.uid();
  my   text := (select display_name from public.profiles where id = auth.uid());
  nm   text;
  mail text;
begin
  if not public.is_admin() then raise exception 'not an administrator'; end if;
  if target = me then raise exception 'not on yourself'; end if;
  select p.display_name, lower(u.email) into nm, mail
    from auth.users u left join public.profiles p on p.id = u.id where u.id = target;
  if mail is null then return 'gone'; end if;

  if decision = 'approve' then
    update public.profiles set chat_approved = true where id = target;
    insert into public.admin_notes (user_id, reviewed_at, updated_by, updated_at)
    values (target, now(), me, now())
    on conflict (user_id) do update set reviewed_at = now();
    insert into public.admin_audit (actor_id, actor_name, action, target_user, target_name, summary)
    values (me, my, 'chat.approve', target, nm, 'approved to chat <' || mail || '>');
    return 'approved';
  elsif decision = 'wait' then
    insert into public.admin_notes (user_id, reviewed_at, updated_by, updated_at)
    values (target, now(), me, now())
    on conflict (user_id) do update set reviewed_at = now();
    insert into public.admin_audit (actor_id, actor_name, action, target_user, target_name, summary)
    values (me, my, 'chat.wait', target, nm, 'seen, left out of chat <' || mail || '>');
    return 'waiting';
  elsif decision = 'ban' then
    insert into public.admin_audit (actor_id, actor_name, action, target_user, target_name, summary, snapshot)
    values (me, my, 'member.ban', target, nm, 'banned and removed <' || mail || '>',
            (select to_jsonb(n) from public.admin_notes n where n.user_id = target));
    insert into public.banned_emails (email, banned_by, reason)
    values (mail, me, (select note from public.admin_notes where user_id = target))
    on conflict (email) do nothing;
    delete from auth.users where id = target;
    return 'banned';
  end if;
  raise exception 'approve, wait or ban';
end $$;
revoke all on function public.admin_vet(uuid, text) from public, anon;
grant execute on function public.admin_vet(uuid, text) to authenticated;

notify pgrst, 'reload schema';
