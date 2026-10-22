-- =========================================================================
--  signup_push: tell the admins' phones when someone new joins (22 Oct 2026)
--  -----------------------------------------------------------------------
--  Run after vetting.sql. The vetting popup only shows while an admin has
--  the app open, so a new account could sit out of chat for hours. Now the
--  moment a new account gets its profile (email confirmed) and starts out
--  of chat, every device an admin has turned notifications on for gets:
--
--      New sign-up: <name>
--      <email> · <country> · tap to vet them
--
--  The database writes the words and picks the admins; the nudge edge
--  function (mode "admins", same x-nudge-key as the cron) only delivers.
--  Best effort: a failed push never stops the sign-up. Safe to re-run.
-- =========================================================================
create or replace function public.trg_profiles_signup_push()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  secret text;
  em     text;
  ctry   text;
  admins uuid[];
begin
  if new.chat_approved then return new; end if;   /* not someone waiting on us */
  select email into em from auth.users where id = new.id;
  if public.admin_email(em) then return new; end if;

  select cron_secret into secret from public.notification_config where id = 1;
  select coalesce(array_agg(u.id), '{}') into admins from auth.users u where public.admin_email(u.email);
  if secret is null or cardinality(admins) = 0 then return new; end if;

  select s.country into ctry from public.signup_log s
   where lower(s.email) = lower(em) and s.ok order by s.at desc limit 1;

  begin
    perform net.http_post(
      url     := 'https://jebvozocpxhiplvvjobl.supabase.co/functions/v1/nudge',
      body    := jsonb_build_object(
                   'mode', 'admins',
                   'user_ids', to_jsonb(admins),
                   'title', 'New sign-up: ' || left(coalesce(new.display_name, 'someone'), 60),
                   'body', concat_ws(' · ', em, ctry, 'tap to vet them'),
                   'kind', 'signup-' || new.id,
                   'url', './'),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-nudge-key', secret),
      timeout_milliseconds := 20000
    );
  exception when others then null;
  end;
  return new;
end $$;
revoke execute on function public.trg_profiles_signup_push() from public, anon, authenticated;

drop trigger if exists profiles_signup_push on public.profiles;
create trigger profiles_signup_push after insert on public.profiles
  for each row execute function public.trg_profiles_signup_push();
