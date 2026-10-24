-- =========================================================================
--  device_watch: tell the admins when a watched browser turns up (23 Oct 2026)
--  -----------------------------------------------------------------------
--  Run after signup_push.sql (uses the nudge "admins" push). device_ping()
--  logs every (browser id, account) pair in device_log. The first time a
--  pair appears, this checks it against watched_devices and, on a match,
--  pushes to every admin device:
--
--      Watched device: <account name>
--      <email> · <why it matched> · tap to look
--
--  and records it in admin_audit. Two ways to match:
--    * device_id: the exact browser (its id lives in localStorage, so it
--      survives new accounts but not a cleared browser or another browser)
--    * fingerprint: same screen AND a browser language, for when the id
--      changes. Rows with kind = 'fingerprint' hold "screen|lang" in key.
--  Watching:   insert into public.watched_devices(kind, key, note) values (...);
--  Owner-only table. Best effort: a failed push never stops device_ping.
--  Safe to re-run.
-- =========================================================================
create table if not exists public.watched_devices (
  kind     text not null check (kind in ('device_id', 'fingerprint')),
  key      text not null,
  note     text,
  added_at timestamptz not null default now(),
  primary key (kind, key)
);
alter table public.watched_devices enable row level security;

create or replace function public.trg_device_watch()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  hit    text;
  secret text;
  em     text;
  nm     text;
  admins uuid[];
begin
  select coalesce(w.note, 'watched browser') into hit
    from public.watched_devices w
   where w.kind = 'device_id' and w.key = new.device_id;
  if hit is null then
    select 'same screen + language as ' || coalesce(w.note, 'a watched device') into hit
      from public.watched_devices w
     where w.kind = 'fingerprint'
       and new.screen like split_part(w.key, '|', 1) || '%'
       and (',' || coalesce(new.langs, '') || ',') like '%,' || split_part(w.key, '|', 2) || ',%'
     limit 1;
  end if;
  if hit is null then return new; end if;

  select email into em from auth.users where id = new.user_id;
  select display_name into nm from public.profiles where id = new.user_id;

  insert into public.admin_audit (actor_id, actor_name, action, target_user, target_name, summary)
  values (null, 'device watch', 'device.watch', new.user_id, nm,
          concat_ws(' · ', hit, em, new.device_id, new.screen, new.langs));

  select cron_secret into secret from public.notification_config where id = 1;
  select coalesce(array_agg(u.id), '{}') into admins from auth.users u where public.admin_email(u.email);
  if secret is null or cardinality(admins) = 0 then return new; end if;

  begin
    perform net.http_post(
      url     := 'https://jebvozocpxhiplvvjobl.supabase.co/functions/v1/nudge',
      body    := jsonb_build_object(
                   'mode', 'admins',
                   'user_ids', to_jsonb(admins),
                   'title', 'Watched device: ' || left(coalesce(nm, 'someone'), 60),
                   'body', concat_ws(' · ', em, hit, 'tap to look'),
                   'kind', 'devwatch-' || new.user_id,
                   'url', './'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-nudge-key', secret),
      timeout_milliseconds := 20000
    );
  exception when others then null;
  end;
  return new;
end $$;
revoke execute on function public.trg_device_watch() from public, anon, authenticated;

drop trigger if exists device_log_watch on public.device_log;
create trigger device_log_watch after insert on public.device_log
  for each row execute function public.trg_device_watch();

-- ---------- at the sign-up form (added 24 Oct) ----------
--  The device_log check only runs once the app has loaded in a new
--  account, so a fake that is banned quickly never trips it. Every sign-up
--  attempt already lands in signup_log with its screen, languages and IP,
--  so the same watch list is checked there too, on the first attempt,
--  blocked or not, before any account exists. A third kind, 'ip', matches
--  the attempt's address exactly (safe here: only sign-ups are checked, not
--  the members who already use that connection). One push per 10 minutes,
--  however many attempts; every attempt still gets its own audit row.
alter table public.watched_devices drop constraint if exists watched_devices_kind_check;
alter table public.watched_devices add constraint watched_devices_kind_check
  check (kind in ('device_id', 'fingerprint', 'ip'));

create or replace function public.trg_signup_watch()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  scr    text := coalesce(new.client->>'screen', '');
  hit    text;
  recent boolean;
  secret text;
  admins uuid[];
begin
  select string_agg(coalesce(w.note, w.kind), ' + ') into hit
    from public.watched_devices w
   where (w.kind = 'ip' and w.key = new.ip)
      or (w.kind = 'fingerprint'
          and scr like split_part(w.key, '|', 1) || '%'
          and coalesce(new.client->'langs', '[]'::jsonb) ? split_part(w.key, '|', 2));
  if hit is null then return new; end if;

  select exists (select 1 from public.admin_audit
                  where action = 'signup.watch' and created_at > now() - interval '10 minutes') into recent;

  insert into public.admin_audit (actor_id, actor_name, action, target_user, target_name, summary)
  values (null, 'device watch', 'signup.watch', null, new.name,
          concat_ws(' · ', hit, new.email, case when new.ok then 'allowed' else 'blocked: ' || new.why end, new.ip, scr));

  if recent then return new; end if;
  select cron_secret into secret from public.notification_config where id = 1;
  select coalesce(array_agg(u.id), '{}') into admins from auth.users u where public.admin_email(u.email);
  if secret is null or cardinality(admins) = 0 then return new; end if;

  begin
    perform net.http_post(
      url     := 'https://jebvozocpxhiplvvjobl.supabase.co/functions/v1/nudge',
      body    := jsonb_build_object(
                   'mode', 'admins',
                   'user_ids', to_jsonb(admins),
                   'title', 'Watched device signing up: ' || left(coalesce(new.name, '?'), 50),
                   'body', concat_ws(' · ', new.email, hit, case when new.ok then 'allowed through' else 'blocked' end),
                   'kind', 'signupwatch-' || new.id,
                   'url', './'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-nudge-key', secret),
      timeout_milliseconds := 20000
    );
  exception when others then null;
  end;
  return new;
end $$;
revoke execute on function public.trg_signup_watch() from public, anon, authenticated;

drop trigger if exists signup_log_watch on public.signup_log;
create trigger signup_log_watch after insert on public.signup_log
  for each row execute function public.trg_signup_watch();
