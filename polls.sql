-- =========================================================================
--  POLLS IN CHAT
--  -----------------------------------------------------------------------
--  A poll hangs off one chat message (usually an announcement) and can ask
--  several questions, each with its own options and how many you may pick.
--  Votes are anonymous: the room sees counts, and you see your own picks.
--  Voting goes through vote_poll(), results through poll_results(). Polls
--  are posted by an admin (or straight from SQL). Safe to re-run.
-- =========================================================================
create table if not exists public.chat_polls (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.messages(id) on delete cascade,
  questions  jsonb not null,   -- [{"q": "...", "options": ["a", "b"], "max": 1}, ...]
  closes_at  timestamptz,
  created_at timestamptz not null default now(),
  constraint chat_polls_questions_ok check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) between 1 and 6)
);
alter table public.chat_polls enable row level security;
drop policy if exists "polls read" on public.chat_polls;
create policy "polls read" on public.chat_polls for select to authenticated using (true);
revoke insert, update, delete on public.chat_polls from anon, authenticated;
grant select on public.chat_polls to authenticated;

-- One row per person per question; voting again overwrites it, and an empty
-- list is no vote.
create table if not exists public.chat_poll_answers (
  poll_id    uuid not null references public.chat_polls(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  q          int  not null,
  opts       int[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (poll_id, user_id, q)
);
alter table public.chat_poll_answers enable row level security;
revoke all on public.chat_poll_answers from anon, authenticated;

-- Your answer to one question, replacing any earlier one. An empty list takes
-- your vote back.
create or replace function public.vote_poll(p_poll uuid, p_q int, p_opts int[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  p public.chat_polls;
  qq jsonb; nopts int; mx int; o int; clean int[];
begin
  if me is null then return jsonb_build_object('ok', false, 'why', 'You are not signed in'); end if;
  select * into p from public.chat_polls where id = p_poll;
  if p.id is null then return jsonb_build_object('ok', false, 'why', 'That poll is gone'); end if;
  if p.closes_at is not null and now() > p.closes_at then
    return jsonb_build_object('ok', false, 'why', 'Voting on this one has closed');
  end if;
  qq := p.questions -> p_q;
  if qq is null then return jsonb_build_object('ok', false, 'why', 'Not a question on this poll'); end if;
  nopts := jsonb_array_length(qq -> 'options');
  mx := greatest(1, coalesce((qq ->> 'max')::int, 1));
  select coalesce(array_agg(distinct x order by x), '{}') into clean from unnest(coalesce(p_opts, '{}')) x;
  if cardinality(clean) > mx then
    return jsonb_build_object('ok', false, 'why', 'Pick up to ' || mx);
  end if;
  foreach o in array clean loop
    if o < 0 or o >= nopts then return jsonb_build_object('ok', false, 'why', 'Not an option'); end if;
  end loop;
  insert into public.chat_poll_answers (poll_id, user_id, q, opts, updated_at)
  values (p_poll, me, p_q, clean, now())
  on conflict (poll_id, user_id, q) do update set opts = excluded.opts, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Counts for every option of every question, how many have answered each
-- question, and which options are yours.
create or replace function public.poll_results(p_polls uuid[])
returns table (poll_id uuid, q int, opt int, n bigint, mine boolean, voters bigint)
language sql
stable
security definer
set search_path = public
as $$
  with a as (select * from public.chat_poll_answers where poll_id = any (p_polls[1:60]) and cardinality(opts) > 0),
  t as (select a.poll_id, a.q, count(*) voters from a group by 1, 2),
  v as (select a.poll_id, a.q, unnest(a.opts) opt, a.user_id from a)
  select v.poll_id, v.q, v.opt, count(*), bool_or(v.user_id = auth.uid()), t.voters
    from v join t on t.poll_id = v.poll_id and t.q = v.q
   group by v.poll_id, v.q, v.opt, t.voters
$$;

revoke execute on function public.vote_poll(uuid, int, int[]) from public, anon;
revoke execute on function public.poll_results(uuid[])        from public, anon;
grant  execute on function public.vote_poll(uuid, int, int[]) to authenticated;
grant  execute on function public.poll_results(uuid[])        to authenticated;
notify pgrst, 'reload schema';
