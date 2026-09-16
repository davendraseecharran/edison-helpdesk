-- ---------------------------------------------------------------------------
-- Who resolved what, and how long it took them.
--
-- The Resolved list already answers "which tickets are closed". It cannot
-- answer the question an administrator actually asks at the end of a term —
-- who is carrying the desk, what kind of work each person takes, and whether
-- anything is being closed twice. That is one aggregate over `tickets` and one
-- over `activity_events`, and it is worth a function of its own because every
-- part of it is a decision:
--
-- 1. THE RESOLVER, NOT THE OWNER. `resolved_by` is recorded separately from
--    `owner_id` precisely because a collaborator may close somebody else's
--    ticket, and the person who wrote the solution is the person this screen is
--    about. A ticket resolved by its owner counts once, for the owner.
--
-- 2. CANCELLATIONS ARE NOT RESOLUTIONS. `app_cancel_ticket` deliberately leaves
--    `resolved_by` and `resolved_at` empty, so `resolved_by is not null` is the
--    whole filter: a cancelled ticket can never reach these counts, and nobody
--    can raise their number by cancelling.
--
-- 3. THE CLOCK IS created_at → resolved_at. Not `submitted_on`, which an
--    administrator may backdate, and not `assigned_at`, which would measure the
--    part of the wait the desk was already working on and hide the part where
--    the requester sat in the queue. What a requester experiences is the whole
--    span, so that is what is measured.
--
-- 4. MEDIAN FIRST, MEAN BESIDE IT. One projector left on the bench over a
--    holiday moves a mean by days and a median not at all. The median is the
--    number the screen shows; the mean is returned too, because the gap between
--    them is itself the signal that a long tail exists.
--
-- 5. A REOPEN IS NOT IN THE TICKET ROW. `app_reopen_ticket` CLEARS `resolved_by`
--    and `resolved_at` — the constraint `tickets_unresolved_has_no_resolver`
--    requires it — so a ticket that was resolved and then reopened has no
--    resolver on it any more and is invisible to the first aggregate. The
--    history still has it: a `resolved` event with this actor, followed by a
--    `reopened` event on the same ticket. Resolves and reopens strictly
--    alternate (a resolved ticket cannot be resolved again, and only a reopen
--    unlocks it), so "is there any reopen after this resolve" needs no window
--    function and no BETWEEN — it is one EXISTS, and it is cheap on the
--    per-ticket history index.
--
--    The reopen itself is deliberately NOT bounded by the period. The question
--    is "of the work this person closed in this period, how much came back",
--    and a ticket that bounced the following week still came back.
--
-- THE SHAPE. One row per account that either resolved something in the period
-- or had something they resolved in the period come back, plus ONE TOTALS ROW
-- with `resolver_id` and `resolver_name` NULL, always last. The totals row is
-- computed over the whole period rather than summed from the rows above it,
-- because a median is not the median of medians and an average is not the
-- average of averages — the one number a footer must not get wrong is the one
-- a reader cannot check.
--
-- `by_priority` carries all four priorities the ticket table allows —
-- `urgent`, `high`, `normal`, `low` — with an explicit zero for each, so a
-- caller never has to decide what a missing key means. `by_category` carries
-- only the categories that actually occurred, from the nine in
-- `tickets_category_valid`; an absent key is zero. Nine keys of mostly zeros
-- per resolver would be most of the payload and none of the information.
--
-- Administrator only, and refused out loud. A NetRider's own numbers are not
-- withheld out of secrecy — they are on their own Resolved list — but a table
-- ranking the whole desk is a management artefact, and a page that answered a
-- NetRider with an empty table would read as a desk where nothing happened.
-- ---------------------------------------------------------------------------

create or replace function public.app_resolved_stats(
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns table (
  resolver_id uuid,
  resolver_name text,
  resolved_count bigint,
  by_priority jsonb,
  by_category jsonb,
  median_hours numeric,
  mean_hours numeric,
  reopened_count bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_since timestamptz;
  v_until timestamptz;
begin
  v_actor := public.app_require_actor();

  if not (v_actor.roles && array['admin']::text[]) then
    raise exception 'Only an administrator can read resolution statistics.'
      using errcode = 'insufficient_privilege';
  end if;

  -- An open end means now. An open start means as far back as the cap allows,
  -- which is the same answer the 'all' period gives and keeps the two from
  -- disagreeing.
  v_until := coalesce(p_until, pg_catalog.now());
  v_since := coalesce(p_since, v_until - interval '5 years');

  if v_since > v_until then
    raise exception 'That period ends before it begins.'
      using errcode = 'check_violation';
  end if;

  -- Capped rather than refused. Five years is longer than any student is at
  -- this school, so a wider range is a mistake or a probe, and neither is worth
  -- a sequential scan of every ticket the desk has ever closed. Clamping says
  -- what was measured; the screen names the period it asked for.
  v_since := greatest(v_since, v_until - interval '5 years');

  return query
  with closed as (
    select
      t.resolved_by as account_id,
      t.priority as priority,
      t.category as category,
      -- Hours, as a number rather than an interval: a median of intervals is
      -- not something a caller can average, compare or draw a bar from.
      (pg_catalog.date_part('epoch', t.resolved_at - t.created_at) / 3600.0)::numeric as hours
    from public.tickets t
    where t.resolved_by is not null
      and t.resolved_at >= v_since
      and t.resolved_at <= v_until
  ),
  by_person as (
    select
      c.account_id as account_id,
      pg_catalog.count(*) as n_resolved,
      pg_catalog.jsonb_build_object(
        'urgent', pg_catalog.count(*) filter (where c.priority = 'urgent'),
        'high', pg_catalog.count(*) filter (where c.priority = 'high'),
        'normal', pg_catalog.count(*) filter (where c.priority = 'normal'),
        'low', pg_catalog.count(*) filter (where c.priority = 'low')
      ) as priorities,
      pg_catalog.round(
        (pg_catalog.percentile_cont(0.5) within group (order by c.hours))::numeric, 2
      ) as median_h,
      pg_catalog.round(pg_catalog.avg(c.hours), 2) as mean_h
    from closed c
    group by c.account_id
  ),
  category_counts as (
    select c.account_id as account_id, c.category as category, pg_catalog.count(*) as n
    from closed c
    group by c.account_id, c.category
  ),
  categories_by_person as (
    select k.account_id as account_id, pg_catalog.jsonb_object_agg(k.category, k.n) as categories
    from category_counts k
    group by k.account_id
  ),
  -- A resolve inside the period that the history says came back afterwards.
  came_back as (
    select e.actor_id as account_id, pg_catalog.count(*) as n_reopened
    from public.activity_events e
    where e.kind = 'resolved'
      and e.at >= v_since
      and e.at <= v_until
      and exists (
        select 1
        from public.activity_events r
        where r.ticket_id = e.ticket_id
          and r.kind = 'reopened'
          and r.at > e.at
      )
    group by e.actor_id
  ),
  -- Everyone the period has something to say about. A resolver whose only
  -- resolution was reopened has no row in `by_person` at all — the ticket no
  -- longer carries their name — and leaving them out would report a desk where
  -- that hour of work never happened.
  people as (
    select p.account_id as account_id from by_person p
    union
    select b.account_id as account_id from came_back b
  ),
  rows_out as (
    select
      a.id as account_id,
      a.display_name as display_name,
      coalesce(p.n_resolved, 0)::bigint as n_resolved,
      coalesce(
        p.priorities,
        pg_catalog.jsonb_build_object('urgent', 0, 'high', 0, 'normal', 0, 'low', 0)
      ) as priorities,
      coalesce(c.categories, '{}'::jsonb) as categories,
      p.median_h as median_h,
      p.mean_h as mean_h,
      coalesce(b.n_reopened, 0)::bigint as n_reopened
    from people k
    join public.app_accounts a on a.id = k.account_id
    left join by_person p on p.account_id = k.account_id
    left join categories_by_person c on c.account_id = k.account_id
    left join came_back b on b.account_id = k.account_id

    union all

    -- The totals row. Computed over the period, not summed from the rows above.
    select
      null::uuid,
      null::text,
      (select pg_catalog.count(*) from closed)::bigint,
      (
        select pg_catalog.jsonb_build_object(
          'urgent', pg_catalog.count(*) filter (where c.priority = 'urgent'),
          'high', pg_catalog.count(*) filter (where c.priority = 'high'),
          'normal', pg_catalog.count(*) filter (where c.priority = 'normal'),
          'low', pg_catalog.count(*) filter (where c.priority = 'low')
        )
        from closed c
      ),
      coalesce(
        (
          select pg_catalog.jsonb_object_agg(g.category, g.n)
          from (
            select c.category as category, pg_catalog.count(*) as n
            from closed c
            group by c.category
          ) g
        ),
        '{}'::jsonb
      ),
      (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.5) within group (order by c.hours))::numeric, 2
        )
        from closed c
      ),
      (select pg_catalog.round(pg_catalog.avg(c.hours), 2) from closed c),
      (select pg_catalog.count(*) from came_back b)::bigint
  )
  select
    o.account_id,
    o.display_name,
    o.n_resolved,
    o.priorities,
    o.categories,
    o.median_h,
    o.mean_h,
    o.n_reopened
  from rows_out o
  -- Busiest first, the totals row last whatever its count.
  order by (o.account_id is null), o.n_resolved desc, o.display_name asc;
end;
$$;

comment on function public.app_resolved_stats(timestamptz, timestamptz) is
  'Resolution statistics for a period, one row per resolver plus a trailing totals row whose resolver_id and resolver_name are NULL. Counts only tickets whose resolved_at falls in the period and whose resolved_by is set, so cancellations never count. by_priority always carries urgent/high/normal/low; by_category carries only the categories that occurred. median_hours and mean_hours measure created_at to resolved_at and are NULL when nothing was resolved. reopened_count comes from the history — a resolve by this account inside the period that a later reopen undid — because a reopen clears the resolver off the ticket row. NULL p_until means now, NULL p_since means the cap, and the range is clamped to five years. Administrator only.';

revoke execute on function public.app_resolved_stats(timestamptz, timestamptz) from public, anon;
grant execute on function public.app_resolved_stats(timestamptz, timestamptz) to authenticated;
