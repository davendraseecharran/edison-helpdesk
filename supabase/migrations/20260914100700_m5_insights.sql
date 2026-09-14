-- M5: the numbers behind the insights dashboard.
--
-- Read-only. This migration creates one function and changes no table, no
-- policy and no grant on anything that already exists.
--
-- ---------------------------------------------------------------------------
-- THE ONE DECISION WORTH ARGUING ABOUT: insights are TEAM-WIDE, and this
-- function therefore reads past row-level security on purpose.
--
-- Everywhere else in this schema a technician sees the tickets they own,
-- collaborate on, or could claim, and a read is SECURITY INVOKER precisely so
-- that the policies decide. That is right for a queue and wrong for a
-- dashboard: "how many requests came in this week", "how long are resolutions
-- taking", "who is carrying what" are questions about the helpdesk, and an
-- answer filtered to the asker's own tickets would not be a smaller truth, it
-- would be a misleading one. A technician looking at a median resolution time
-- computed from their own three tickets would draw conclusions from noise.
--
-- So: SECURITY DEFINER, and the gate is the one that matters. app_require_actor()
-- refuses an anonymous, inactive, setup_pending, pending_approval, denied,
-- credential-pending or stale-token caller, and there is no partial answer for
-- any of them. An active account sees the whole picture; everyone else sees
-- nothing at all.
--
-- What this function must therefore never do is hand back anything that is NOT
-- an aggregate. There is no ticket id, no title, no requester and no note
-- anywhere in the result — the one identifier it returns is an account id for a
-- colleague whose name is already visible through app_directory(). Adding a
-- "recent tickets" list here would quietly turn a dashboard into a way around
-- ticket visibility, and it must not happen. If a screen needs rows, it should
-- call the functions that apply the policies.
-- ---------------------------------------------------------------------------
--
-- Two smaller decisions.
--
-- Dates are SCHOOL-LOCAL (America/New_York) throughout, matching app_today() and
-- the submission-date rules. `submitted_on` is already a school-local date;
-- `resolved_at` and `recorded_at` are real instants and are converted before
-- they are compared or grouped, so a ticket resolved at 21:00 EDT counts on the
-- day the technician would say it was, not on tomorrow's UTC date.
--
-- The series is ZERO-FILLED. A day nothing happened on is a point with zeros,
-- not a missing row, so nothing downstream has to invent one to draw a chart.

create function public.app_insights(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The statuses a ticket can be in while it is still somebody's problem.
  -- `resolved` and `cancelled` are finished and are not part of any "open" count.
  c_active_statuses constant text[] := array['open', 'assigned', 'in_progress', 'waiting'];
  c_priorities constant text[] := array['low', 'normal', 'high', 'urgent'];
  -- public.inventory_devices.status is free text with no CHECK: the vocabulary
  -- is whatever the district has written, and app_inventory_statuses() is the
  -- authority on what to offer. The chart therefore reads its buckets from that
  -- function rather than from a list held here, so a status somebody adds in the
  -- inventory screen appears on the dashboard instead of being silently dropped.
  c_device_statuses text[];
  v_actor public.app_accounts;
  v_days integer;
  v_start date;
  v_end date;
  v_series jsonb;
  v_open_by_status jsonb;
  v_open_by_priority jsonb;
  v_by_category jsonb;
  v_resolution jsonb;
  v_technicians jsonb;
  v_device_types jsonb;
  v_inventory jsonb;
begin
  v_actor := public.app_require_actor();

  -- Clamped rather than refused: a window is a chart control, and a screen that
  -- sends 0 or 3650 has a bug the operator cannot act on and should not be shown
  -- an error about. One year is the ceiling because a longer series is 700 points
  -- nobody can read.
  -- GREATEST and LEAST are SQL constructs rather than functions, so they are
  -- written bare: there is no pg_catalog.least() to qualify.
  v_days := greatest(1, least(coalesce(p_days, 30), 365));
  v_end := public.app_today();
  -- Inclusive of both ends, so `p_days = 1` is today alone.
  v_start := v_end - (v_days - 1);

  -- ---------------------------------------------------------------------------
  -- The series: one point per school-local day, oldest first, today last.
  --
  -- Aggregated once per side and left-joined onto the calendar rather than
  -- counted per day: 365 days must not mean 730 scans of the ticket table.
  -- ---------------------------------------------------------------------------
  with days as (
    select g.day::date as day
    from pg_catalog.generate_series(v_start, v_end, interval '1 day') as g(day)
  ),
  opened as (
    select t.submitted_on as day, pg_catalog.count(*)::integer as n
    from public.tickets t
    where t.submitted_on between v_start and v_end
    group by t.submitted_on
  ),
  resolved as (
    -- `resolved_at` is non-null only on a resolved ticket (tickets_unresolved_-
    -- has_no_resolver), so this needs no status test of its own.
    select (t.resolved_at at time zone 'America/New_York')::date as day,
           pg_catalog.count(*)::integer as n
    from public.tickets t
    where t.resolved_at is not null
      and (t.resolved_at at time zone 'America/New_York')::date between v_start and v_end
    group by 1
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'date', pg_catalog.to_char(d.day, 'YYYY-MM-DD'),
        'opened', coalesce(o.n, 0),
        'resolved', coalesce(r.n, 0)
      )
      order by d.day
    ),
    '[]'::jsonb
  )
  into v_series
  from days d
  left join opened o on o.day = d.day
  left join resolved r on r.day = d.day;

  -- ---------------------------------------------------------------------------
  -- The live queue, right now. Deliberately NOT windowed: "how much is open"
  -- is a fact about this moment, not about the last thirty days, and a ticket
  -- raised in March that is still waiting belongs in it.
  --
  -- Every key is always present, at zero if need be, so a chart's legend does
  -- not change shape as the day goes on.
  -- ---------------------------------------------------------------------------
  select pg_catalog.jsonb_object_agg(s.status, coalesce(c.n, 0))
  into v_open_by_status
  from pg_catalog.unnest(c_active_statuses) as s(status)
  left join (
    select t.status, pg_catalog.count(*)::integer as n
    from public.tickets t
    where t.status = any (c_active_statuses)
    group by t.status
  ) c on c.status = s.status;

  select pg_catalog.jsonb_object_agg(p.priority, coalesce(c.n, 0))
  into v_open_by_priority
  from pg_catalog.unnest(c_priorities) as p(priority)
  left join (
    select t.priority, pg_catalog.count(*)::integer as n
    from public.tickets t
    where t.status = any (c_active_statuses)
    group by t.priority
  ) c on c.priority = p.priority;

  -- Only categories that actually have open work, biggest first. Unlike the two
  -- above this is a list rather than a fixed object: nine categories of which six
  -- are empty is a worse chart than three bars.
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('category', x.category, 'count', x.n)
      order by x.n desc, x.category
    ),
    '[]'::jsonb
  )
  into v_by_category
  from (
    select t.category, pg_catalog.count(*)::integer as n
    from public.tickets t
    where t.status = any (c_active_statuses)
    group by t.category
  ) x;

  -- ---------------------------------------------------------------------------
  -- How long resolutions took, over the tickets RESOLVED in the window.
  --
  -- Measured from created_at, the real creation instant, rather than from
  -- submitted_on: an administrator may backdate a submission date, and a
  -- backdated ticket would otherwise report a resolution time of several days
  -- for work that took an hour.
  --
  -- Median as well as mean because one ticket that sat over the summer holidays
  -- moves the mean and tells nobody anything. Both are NULL when nothing was
  -- resolved, which is honestly what the average of no numbers is.
  -- ---------------------------------------------------------------------------
  select pg_catalog.jsonb_build_object(
    'resolved_count', pg_catalog.count(*)::integer,
    'median_hours', pg_catalog.round(
      (percentile_cont(0.5) within group (
        order by (pg_catalog.date_part('epoch', t.resolved_at - t.created_at) / 3600.0)
      ))::numeric, 2
    ),
    'mean_hours', pg_catalog.round(
      (pg_catalog.avg(pg_catalog.date_part('epoch', t.resolved_at - t.created_at) / 3600.0))::numeric,
      2
    )
  )
  into v_resolution
  from public.tickets t
  where t.resolved_at is not null
    and (t.resolved_at at time zone 'America/New_York')::date between v_start and v_end;

  -- ---------------------------------------------------------------------------
  -- The team. One row per ACTIVE account, so somebody awaiting setup or whose
  -- request was denied is not listed as a technician with nothing to show for
  -- themselves.
  --
  -- `resolved` and `minutes` are windowed — they are work done in the period —
  -- while `open` is the live count, matching open_by_status above. Names come
  -- from app_account_label(), which is what the device history uses, rather than
  -- from a join: app_accounts shows a technician only their own row, and this
  -- function's result is read by every technician.
  --
  -- Correlated subqueries are deliberate here: this is one row per member of
  -- staff, not per ticket, so it is a handful of index lookups and it reads as
  -- the three separate questions it actually is.
  -- ---------------------------------------------------------------------------
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'account_id', a.id,
        'name', public.app_account_label(a.id),
        'resolved', a.resolved,
        'minutes', a.minutes,
        'open', a.open
      )
      order by a.resolved desc, a.sort_name, a.id
    ),
    '[]'::jsonb
  )
  into v_technicians
  from (
    select acc.id,
           acc.display_name as sort_name,
           (
             select pg_catalog.count(*)::integer
             from public.tickets t
             where t.resolved_by = acc.id
               and t.resolved_at is not null
               and (t.resolved_at at time zone 'America/New_York')::date
                   between v_start and v_end
           ) as resolved,
           coalesce((
             select pg_catalog.sum(w.minutes)::integer
             from public.work_logs w
             where w.contributor_id = acc.id
               and w.work_date between v_start and v_end
           ), 0) as minutes,
           (
             select pg_catalog.count(*)::integer
             from public.tickets t
             where t.owner_id = acc.id
               and t.status = any (c_active_statuses)
           ) as open
    from public.app_accounts acc
    where acc.status = 'active'
      and acc.role in ('admin', 'technician')
  ) a;

  -- The kinds of machine technicians recorded on tickets in the window, busiest
  -- first. Eight because that is what fits; this is a "what are we mostly
  -- fixing" list, not a census.
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('type', x.device_type, 'count', x.n)
      order by x.n desc, x.device_type
    ),
    '[]'::jsonb
  )
  into v_device_types
  from (
    select o.device_type, pg_catalog.count(*)::integer as n
    from public.device_observations o
    where (o.recorded_at at time zone 'America/New_York')::date between v_start and v_end
    group by o.device_type
    order by pg_catalog.count(*) desc, o.device_type
    limit 8
  ) x;

  -- The inventory as it stands. Not windowed for the same reason the live queue
  -- is not: a shelf of laptops is a fact about now.
  --
  -- The buckets are app_inventory_statuses(): every status in use, plus the five
  -- the owner's function seeds. A machine whose status is blank is counted under
  -- 'No status' rather than dropped, because a chart that silently loses rows is
  -- worse than one that names the gap.
  select coalesce(
    array(select pg_catalog.jsonb_array_elements_text(public.app_inventory_statuses())),
    '{}'::text[]
  )
  into c_device_statuses;

  select pg_catalog.jsonb_build_object(
    'by_status', (
      select pg_catalog.jsonb_object_agg(s.status, coalesce(c.n, 0))
      from (
        select pg_catalog.unnest(c_device_statuses) as status
        union
        select 'No status'
      ) s
      left join (
        select coalesce(nullif(pg_catalog.btrim(coalesce(d.status, '')), ''), 'No status') as status,
               pg_catalog.count(*)::integer as n
        from public.inventory_devices d
        group by 1
      ) c on c.status = s.status
    ),
    -- The types are the inventory's own device_type, which is also the first
    -- column of public.device_catalog: every machine carries one, and the
    -- catalogue is where the vocabulary comes from.
    'by_type', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('type', x.type, 'count', x.n)
        order by x.n desc, x.type
      )
      from (
        select d.device_type as type, pg_catalog.count(*)::integer as n
        from public.inventory_devices d
        group by d.device_type
        order by pg_catalog.count(*) desc, d.device_type
        limit 10
      ) x
    ), '[]'::jsonb),
    'total', (select pg_catalog.count(*)::integer from public.inventory_devices)
  )
  into v_inventory;

  return pg_catalog.jsonb_build_object(
    'days', v_days,
    'series', v_series,
    'open_by_status', v_open_by_status,
    'open_by_priority', v_open_by_priority,
    'by_category', v_by_category,
    'resolution', v_resolution,
    'technicians', v_technicians,
    'device_types_in_tickets', v_device_types,
    'inventory', v_inventory
  );
end;
$$;

comment on function public.app_insights(integer) is
  'Team-wide helpdesk aggregates for the last p_days school-local days (clamped to 1..365, today included). SECURITY DEFINER and deliberately unfiltered by ticket visibility, because a dashboard is a question about the helpdesk rather than about the asker; the gate is an active account and there is no partial answer. Returns only aggregates — never a ticket, a requester or a note.';

-- ---------------------------------------------------------------------------
-- Grants. Signed-in accounts only; anon gets nothing. The active-account check
-- inside the function is the real gate, and this is the door.
-- ---------------------------------------------------------------------------

revoke execute on function public.app_insights(integer) from public, anon;
grant execute on function public.app_insights(integer) to authenticated;
