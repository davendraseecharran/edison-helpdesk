-- ---------------------------------------------------------------------------
-- Today: one read for the landing screen, and the views a person keeps.
--
-- Two things that both belong to "the application knows what you were doing".
--
-- `app_today_briefing()` is the whole Today screen in one round trip: the four
-- counts the greeting quotes and the top few rows under each of them. It exists
-- as one function rather than five queries because Today is the page every
-- session opens on, and five sequential RPCs from a server render is five
-- round trips before anything paints.
--
-- It is SECURITY INVOKER, which is the important part: every table it reads is
-- read as the caller, so row-level security decides the rows exactly as it does
-- on the queue. A NetRider's briefing cannot contain a ticket they could not
-- open, and the pending access requests are visible only because
-- `app_accounts_select_self_or_admin` lets an administrator see them — the
-- `app_is_admin()` test in the function is what keeps the work off everybody
-- else's query plan, not what keeps the rows off their screen.
--
-- `account_preferences.saved_views` is the filter set somebody named ("Room
-- 214", "Chromebook batteries"). It is the person's own row, already protected
-- by the preferences policies, and it is written through one RPC that bounds
-- what a browser may store there.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Saved views
-- ---------------------------------------------------------------------------

alter table public.account_preferences
  add column if not exists saved_views jsonb not null default '[]'::jsonb;

-- A JSON array, and small. The column is written by a browser, and a
-- preferences row is read on every authenticated page render, so an unbounded
-- blob here would be paid for on every page this account ever opens.
alter table public.account_preferences
  drop constraint if exists account_preferences_saved_views_shape;

alter table public.account_preferences
  add constraint account_preferences_saved_views_shape
  check (
    pg_catalog.jsonb_typeof(saved_views) = 'array'
    and pg_catalog.jsonb_array_length(saved_views) <= 24
    and pg_catalog.length(saved_views::text) <= 8000
  );

comment on column public.account_preferences.saved_views is
  'Filter sets this account named, newest first: [{"id","name","path","query"}]. Written only by app_set_saved_views.';

-- ---------------------------------------------------------------------------
-- app_set_saved_views: the one door to that column.
--
-- The whole list is replaced rather than patched. A saved view is a tiny
-- record and the browser already holds all of them, so a replace is one
-- statement with no merge to get wrong, and "delete the third one" needs no
-- second RPC.
--
-- Every element is rebuilt here from the four fields this application
-- understands. A browser that sends a fifth is not refused — it is a form
-- posting its own state back — but the fifth is dropped, so nothing a page
-- script invents can be stored and handed back to a later render.
-- ---------------------------------------------------------------------------
create or replace function public.app_set_saved_views(p_views jsonb)
returns public.account_preferences
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_row public.account_preferences;
  v_clean jsonb;
begin
  v_actor := public.app_require_actor();

  if p_views is null or pg_catalog.jsonb_typeof(p_views) <> 'array' then
    raise exception 'Send the saved views as a list.' using errcode = 'check_violation';
  end if;

  if pg_catalog.jsonb_array_length(p_views) > 24 then
    raise exception 'You can keep up to 24 saved views. Remove one and save again.'
      using errcode = 'check_violation';
  end if;

  select coalesce(pg_catalog.jsonb_agg(cleaned order by ordinality), '[]'::jsonb)
  into v_clean
  from pg_catalog.jsonb_array_elements(p_views) with ordinality as entry(value, ordinality)
  cross join lateral (
    select jsonb_build_object(
      'id', pg_catalog.left(coalesce(entry.value ->> 'id', ''), 64),
      'name', pg_catalog.left(pg_catalog.btrim(coalesce(entry.value ->> 'name', '')), 60),
      'path', pg_catalog.left(coalesce(entry.value ->> 'path', ''), 120),
      'query', pg_catalog.left(coalesce(entry.value ->> 'query', ''), 400)
    ) as cleaned
  ) as built
  where pg_catalog.jsonb_typeof(entry.value) = 'object'
    -- A view with no name is not a view; a path that is not in-app is not ours.
    and pg_catalog.btrim(coalesce(entry.value ->> 'name', '')) <> ''
    and coalesce(entry.value ->> 'path', '') like '/%'
    and coalesce(entry.value ->> 'path', '') not like '//%';

  insert into public.account_preferences (account_id)
  values (v_actor.id)
  on conflict (account_id) do nothing;

  update public.account_preferences p
  set saved_views = v_clean,
      updated_at = pg_catalog.now()
  where p.account_id = v_actor.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.app_set_saved_views(jsonb) is
  'Replaces the caller''s saved views, rebuilding every element from the four fields this application understands.';

revoke execute on function public.app_set_saved_views(jsonb) from public, anon;
grant execute on function public.app_set_saved_views(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- app_today_briefing: everything the landing screen needs, once.
--
-- SECURITY INVOKER and `stable`. Four sections, each capped, each ordered the
-- way the screen reads them:
--
--   waiting      tickets you own that are stopped on somebody else's reply.
--                Oldest first: the one that has been stuck longest is the one
--                worth a phone call.
--   unassigned   the open queue nobody has claimed. Worst and oldest first,
--                the same order the queue itself uses, so Today and the queue
--                never disagree about which one is next.
--   mine         your own live work, so an empty "needs you" list still has
--                somewhere to go next.
--   access       people waiting on an administrator to let them in.
--
-- The counts are counted over the whole set, not over the capped list, because
-- "three things need you" has to be true when only two fit on screen.
-- ---------------------------------------------------------------------------
create or replace function public.app_today_briefing()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with me as (
    select public.app_active_account_id() as account_id,
           public.app_is_admin() as is_admin
  ),
  live as (
    select t.*
    from public.tickets t
    where t.status in ('open', 'assigned', 'in_progress', 'waiting')
  ),
  waiting as (
    select t.*
    from live t, me
    where t.owner_id = me.account_id and t.status = 'waiting'
  ),
  unassigned as (
    select t.*
    from live t
    where t.owner_id is null and t.status = 'open'
  ),
  mine as (
    select t.*
    from live t, me
    where t.owner_id = me.account_id and t.status <> 'waiting'
  ),
  access as (
    select a.id, a.display_name, a.email, a.created_at
    from public.app_accounts a, me
    where me.is_admin and a.status = 'pending_approval'
  )
  select jsonb_build_object(
    'at', pg_catalog.now(),
    'counts', jsonb_build_object(
      'waiting', (select pg_catalog.count(*) from waiting),
      'unassigned', (select pg_catalog.count(*) from unassigned),
      'mine', (select pg_catalog.count(*) from mine),
      'access_requests', (select pg_catalog.count(*) from access)
    ),
    'waiting', coalesce((
      select pg_catalog.jsonb_agg(row)
      from (
        select jsonb_build_object(
          'id', t.id, 'number', t.number, 'title', t.title,
          'priority', t.priority, 'status', t.status,
          'waiting_reason', t.waiting_reason,
          'created_at', t.created_at,
          'since', coalesce(t.assigned_at, t.created_at),
          'requester_name', r.display_name
        ) as row
        from waiting t
        left join public.requesters r on r.id = t.requester_id
        order by coalesce(t.assigned_at, t.created_at) asc, t.id asc
        limit 5
      ) as picked
    ), '[]'::jsonb),
    'unassigned', coalesce((
      select pg_catalog.jsonb_agg(row)
      from (
        select jsonb_build_object(
          'id', t.id, 'number', t.number, 'title', t.title,
          'priority', t.priority, 'status', t.status,
          'created_at', t.created_at,
          'since', t.created_at,
          'requester_name', r.display_name
        ) as row
        from unassigned t
        left join public.requesters r on r.id = t.requester_id
        order by
          case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
          t.created_at asc,
          t.id asc
        limit 5
      ) as picked
    ), '[]'::jsonb),
    'mine', coalesce((
      select pg_catalog.jsonb_agg(row)
      from (
        select jsonb_build_object(
          'id', t.id, 'number', t.number, 'title', t.title,
          'priority', t.priority, 'status', t.status,
          'created_at', t.created_at,
          'since', coalesce(t.assigned_at, t.created_at),
          'requester_name', r.display_name
        ) as row
        from mine t
        left join public.requesters r on r.id = t.requester_id
        order by
          case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
          t.created_at asc,
          t.id asc
        limit 5
      ) as picked
    ), '[]'::jsonb),
    'access_requests', coalesce((
      select pg_catalog.jsonb_agg(row)
      from (
        select jsonb_build_object(
          'id', a.id, 'name', a.display_name, 'email', a.email, 'created_at', a.created_at
        ) as row
        from access a
        order by a.created_at asc, a.id asc
        limit 3
      ) as picked
    ), '[]'::jsonb)
  );
$$;

comment on function public.app_today_briefing() is
  'SECURITY INVOKER briefing for the Today screen: counts plus the top rows of what is waiting on you, what is unclaimed, what you own, and who is waiting for access.';

revoke execute on function public.app_today_briefing() from public, anon;
grant execute on function public.app_today_briefing() to authenticated;
