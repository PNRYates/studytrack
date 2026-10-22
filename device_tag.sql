-- =========================================================================
--  DEVICE TAG — tie accounts that share a browser together
--  -----------------------------------------------------------------------
--  22 Oct 2026. Fake accounts keep arriving from one person who makes a new
--  throwaway login each time an old one is deleted. Signup_log already keeps
--  the IP and a device picture per sign-up, but an IP is shared across a
--  house and a fingerprint is not unique. This adds the missing piece: a
--  random id the browser keeps in localStorage and sends on every sign-in.
--  It is not cleared by making a new account, so two accounts used from the
--  same browser show up under the same id, and the console can say so.
--
--  * device_log: one row per (device_id, account), with when it was first and
--    last seen and the browser it reported. Nobody but an administrator can
--    read it; writes only ever go through device_ping as the signed-in user.
--  * device_ping(id, info): the signed-in account records that this browser
--    was here. Silent — the person is told nothing and nothing about their
--    account changes. Server-side only decides whose row it is (auth.uid()),
--    so one account cannot write a sighting under another.
--  * admin_devices(): for the console. Every browser that more than one
--    account has signed in from, newest first, with those accounts.
--  Safe to re-run.
-- =========================================================================

create table if not exists public.device_log (
  device_id  text not null check (char_length(device_id) between 8 and 64),
  user_id    uuid not null references auth.users(id) on delete cascade,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  hits       int not null default 1,
  ua         text,
  screen     text,
  platform   text,
  langs      text,
  primary key (device_id, user_id)
);
create index if not exists device_log_device_idx on public.device_log (device_id);
create index if not exists device_log_user_idx   on public.device_log (user_id);

alter table public.device_log enable row level security;
revoke all on public.device_log from anon, authenticated;

-- The signed-in account says "this browser was here". Only ever touches that
-- account's own row for the id, so it cannot forge a sighting for anyone else.
create or replace function public.device_ping(id text, info jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then return; end if;
  if id is null or char_length(id) < 8 or char_length(id) > 64 then return; end if;
  insert into public.device_log (device_id, user_id, ua, screen, platform, langs)
  values (id, me,
          nullif(info->>'ua', ''), nullif(info->>'screen', ''),
          nullif(info->>'platform', ''), nullif(info->>'langs', ''))
  on conflict (device_id, user_id) do update
    set last_seen = now(),
        hits      = public.device_log.hits + 1,
        ua        = coalesce(nullif(excluded.ua, ''),       public.device_log.ua),
        screen    = coalesce(nullif(excluded.screen, ''),   public.device_log.screen),
        platform  = coalesce(nullif(excluded.platform, ''), public.device_log.platform),
        langs     = coalesce(nullif(excluded.langs, ''),    public.device_log.langs);
end $$;
revoke all on function public.device_ping(text, jsonb) from public, anon;
grant execute on function public.device_ping(text, jsonb) to authenticated;

-- Every browser more than one account has used, newest first, with the
-- accounts on it. For the console.
create or replace function public.admin_devices()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'not an administrator'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'last_seen' desc)
    from (
      select jsonb_build_object(
        'device_id', d.device_id,
        'accounts', count(*),
        'ua', max(d.ua), 'screen', max(d.screen),
        'platform', max(d.platform), 'langs', max(d.langs),
        'last_seen', max(d.last_seen),
        'who', jsonb_agg(jsonb_build_object(
          'id', d.user_id, 'name', p.display_name, 'email', u.email,
          'real_name', n.real_name,
          'first_seen', d.first_seen, 'last_seen', d.last_seen, 'hits', d.hits
        ) order by d.first_seen)
      ) x
      from public.device_log d
      join auth.users u on u.id = d.user_id
      left join public.profiles p on p.id = d.user_id
      left join public.admin_notes n on n.user_id = d.user_id
      group by d.device_id
      having count(*) > 1
    ) q
  ), '[]'::jsonb);
end $$;
revoke all on function public.admin_devices() from public, anon;
grant execute on function public.admin_devices() to authenticated;

notify pgrst, 'reload schema';
