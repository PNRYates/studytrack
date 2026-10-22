-- =========================================================================
--  CHAT APPROVAL — new accounts wait to be vetted before they can chat
--  -----------------------------------------------------------------------
--  22 Oct 2026. Fake accounts kept arriving mid-HSC (impersonations, slurs
--  from throwaway logins) faster than anyone wanted to moderate them. Sign-up
--  rules (signup_rules.sql) slow them down; this stops them at the door of
--  the room. A new account can do everything else from the moment it exists:
--  log, time, plan, see the boards. It cannot post or react in chat until an
--  administrator approves it from the console ("Awaiting vetting").
--
--  * profiles.chat_approved. Everyone who was already a member on 22 Oct is
--    approved (the column is added with a default of true, then the default
--    becomes false), so this only touches accounts made from now on.
--  * profiles_guard: only an administrator can change chat_approved or
--    chat_muted. Until now chat_muted was an ordinary column of your own row,
--    so a muted member could unmute themselves with one request. A profile a
--    member inserts for themselves (after deleting their own, say) always
--    starts unapproved, so deleting and re-joining is no way round a mute.
--    Server-side writes (auth.uid() is null: the sign-up triggers, the SQL
--    editor) pass through unchanged.
--  * chat_block(me): the one place that says why someone may not chat.
--    send_message and react_message both ask it.
--  Safe to re-run.
-- =========================================================================
alter table public.profiles add column if not exists chat_approved boolean not null default true;
alter table public.profiles alter column chat_approved set default false;

create or replace function public.trg_profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.chat_approved := false;
    new.chat_muted := false;
  else
    new.chat_approved := old.chat_approved;
    new.chat_muted := old.chat_muted;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function public.trg_profiles_guard();

/* Why this person may not chat, or null if they may. */
create or replace function public.chat_block(me uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p.id is null then 'You are not a member yet'
    when p.chat_muted then 'An administrator has muted you in chat'
    when not p.chat_approved then
      'Await verification from the owner before you have permission to chat. New accounts are checked by hand, and you''ll be approved soon.'
  end
  from (select 1) one
  left join public.profiles p on p.id = me
$$;
revoke execute on function public.chat_block(uuid) from public, anon;
grant  execute on function public.chat_block(uuid) to authenticated;

create or replace function public.send_message(
  body text,
  image_path text default null,
  mentions uuid[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me     uuid := auth.uid();
  txt    text := btrim(body);
  img    text := nullif(btrim(coalesce(image_path, '')), '');
  who    uuid[];
  recent int;
  why    text;
  new_id uuid;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'why', 'You are not signed in');
  end if;
  if txt = '' and img is null then
    return jsonb_build_object('ok', false, 'why', 'Nothing to send');
  end if;
  if length(txt) > 500 then
    return jsonb_build_object('ok', false, 'why', 'That is longer than 500 characters');
  end if;

  -- A picture has to be one this person just uploaded into their own folder.
  -- Without this the column would take any string, and a message could point
  -- at somebody else's file or at some other site entirely.
  if img is not null and split_part(img, '/', 1) <> me::text then
    return jsonb_build_object('ok', false, 'why', 'That picture is not yours to post');
  end if;

  why := public.chat_block(me);
  if why is not null then
    return jsonb_build_object('ok', false, 'why', why);
  end if;

  select count(*) into recent
    from public.messages
   where user_id = me and created_at > now() - interval '60 seconds';
  if recent >= 10 then
    return jsonb_build_object('ok', false, 'why', 'Slow down a moment — ten a minute is the limit');
  end if;

  -- Only real members, never yourself, and never the same person twice.
  select coalesce(array_agg(distinct p.id), '{}')
    into who
    from public.profiles p
   where p.id = any(mentions) and p.id <> me;

  insert into public.messages (user_id, body, image_path, mentions)
  values (me, txt, img, who)
  returning id into new_id;

  return jsonb_build_object('ok', true, 'id', new_id);
end $fn$;

create or replace function public.react_message(message_id uuid, emoji text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  mid   uuid := react_message.message_id;
  e     text := react_message.emoji;
  me    uuid := auth.uid();
  why   text;
  mine  int;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'why', 'You are not signed in');
  end if;
  if not public.is_reaction_emoji(e) then
    return jsonb_build_object('ok', false, 'why', 'Reactions have to be a single emoji');
  end if;
  if not exists (select 1 from public.messages m where m.id = mid) then
    return jsonb_build_object('ok', false, 'why', 'That message is gone');
  end if;

  why := public.chat_block(me);
  if why is not null then
    return jsonb_build_object('ok', false, 'why', why);
  end if;

  if exists (select 1 from public.message_reactions r
              where r.message_id = mid and r.user_id = me and r.emoji = e) then
    delete from public.message_reactions r
     where r.message_id = mid and r.user_id = me and r.emoji = e;
    return jsonb_build_object('ok', true, 'on', false);
  end if;

  select count(*) into mine from public.message_reactions r
   where r.message_id = mid and r.user_id = me;
  if mine >= 3 then
    return jsonb_build_object('ok', false, 'why', 'Three reactions each per message is the limit');
  end if;

  insert into public.message_reactions (message_id, user_id, emoji)
  values (mid, me, e)
  on conflict on constraint message_reactions_pkey do nothing;

  return jsonb_build_object('ok', true, 'on', true);
end $fn$;

notify pgrst, 'reload schema';
