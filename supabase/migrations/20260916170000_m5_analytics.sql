-- ---------------------------------------------------------------------------
-- The desk's analytics, in one call.
--
-- `app_resolved_stats` answers one question for an administrator: who closed
-- what. The analytics screen asks the rest — how much came in and went out,
-- when it arrives, what kind of work it is, how long it waits, who takes the
-- hard ones — and it asks on behalf of everybody who works tickets, not only
-- administrators. `app_analytics` is that whole screen as one JSON document,
-- so the page and the assistant's `desk_analytics` tool read the same numbers
-- and can never disagree about one. The shape is declared once, in
-- `src/lib/domain/analytics.ts`; the loader checks every field rather than
-- trusting this function, and this function fills every field rather than
-- leaving the loader to guess what a missing one means.
--
-- What is decided here, and why:
--
-- 1. WHO MAY READ IT. Anybody who works tickets: an administrator or a
--    NetRider. A skills officer is refused out loud, in the same words every
--    other ticket door uses for them. Almost everything here is an aggregate,
--    and an aggregate over tickets a NetRider cannot open individually is
--    still not a ticket they can open; the two places the document names a
--    person or a ticket are fenced separately. `people.rows`, the ranking of
--    every resolver, is the table the owner reserved for administrators, so
--    everybody else gets an empty list and their own row. `hardest` names a
--    ticket's number and title only when `app_can_view_ticket` says the
--    reader could open it; the row itself still counts, because the desk's
--    hardest ticket was hard whoever worked it.
--
-- 2. THE SAME ARITHMETIC AS app_resolved_stats. Resolved means `resolved_by`
--    is set and `resolved_at` is inside the span; a cancellation leaves both
--    empty and never counts. Hours run from `created_at` to `resolved_at`,
--    because that is what the requester experienced. Medians before means.
--    An open end is now, an open start is the five-year cap, and the span is
--    clamped rather than refused. Every calendar fact is school-local: which
--    day a ticket belongs to, which weekday and hour it arrived, which days
--    were school days.
--
-- 3. THE PREVIOUS SPAN. The screen's stat cards say "up 12% on the period
--    before", so the document carries the same three figures for the span of
--    equal length ending where this one begins. It is null when the start is
--    open: "all time" has nothing before it.
--
-- 4. THE SERIES IS ZERO-FILLED. A day nobody resolved anything is a day, and
--    a chart that skipped it would draw a lie. Buckets come from
--    generate_series over the span, so a quiet week is a run of zeros and not
--    a gap. A week's key is its Monday; a month's key is `YYYY-MM`. For the
--    open-ended span the series starts at the earliest ticket rather than at
--    the cap, since sixty months of nothing before the desk opened would be
--    most of the chart and none of the information; the pace figures
--    (`school_days`, `per_school_day`, `per_week`) start there too.
--
-- 5. THE BACKLOG IS A COUNT AT AN INSTANT. Tickets created before the end of
--    the bucket and not resolved by then, excluding cancelled ones, which
--    carry no instant of their own. A ticket that was resolved and later
--    reopened has no `resolved_at` any more and so reads as open throughout,
--    which is the truth about it now and an approximation about its past.
--
-- 6. FROM-CLAIM HOURS. How long the resolver actually had the ticket: from
--    `assigned_at` when the resolver is the owner, from their
--    `ticket_collaborators.added_at` when they joined it, and from
--    `created_at` when neither (an administrator closing a ticket from the
--    queue). This is the figure the fastest-on-urgent honour is measured on,
--    because "fastest" should not penalise somebody for the hours a ticket sat
--    unclaimed before they saw it.
--
-- 7. THE HARD SCORE. priority weight (urgent 4, high 3, normal 2, low 1)
--    times ln(1 + hours open), plus half a point for every extra pair of
--    hands, plus one for every reopen. Logarithmic in time so a machine that
--    sat over a holiday does not outrank every urgent ticket of the term. The
--    same formula is `hardScore` in the domain file, and the two are tested
--    against each other.
--
-- 8. WAITING SPELLS, AND WHAT THE HISTORY CAN SAY. A `status_changed` event
--    carries no structured status: `app_set_waiting` writes the summary
--    "<name> set the ticket to Waiting" with the reason in `detail`, and that
--    is the only record that a ticket went on hold. So a spell begins at a
--    `status_changed` event whose summary ends with " set the ticket to
--    Waiting", and ends at the next event on the same ticket that changes
--    status: another `status_changed` (resuming work), `resolved`, `cancelled`
--    or `returned_to_queue`. A reassignment leaves a waiting ticket waiting,
--    so an `assigned` event does not end a spell. This is a text match on a
--    summary the database itself wrote, which is honest but fragile: if the
--    wording of app_set_waiting ever changes, the waiting figures fall to zero
--    rather than to something wrong. The population is the period's resolved
--    tickets, so `tickets_waited`, `share`, `median_wait_hours` and `reasons`
--    all describe the same tickets; a ticket still on hold today is in
--    `waiting_now` and nowhere else.
--
-- 9. JOINING. "Most hands on deck" counts `ticket_collaborators` rows added
--    inside the span. The `collaborator_added` event names the person added
--    only in prose (its actor is whoever added them), so the collaborator
--    table is the record; a helper who was later promoted to owner or removed
--    no longer counts, which is a small loss and the honest one.
--
-- 10. HONOURS ARE WORDED HERE. Each carries the figure that earned it already
--     written ("2h 10m", "4 tickets joined") and one line saying what was
--     measured, so nothing downstream can misread a number. Ties go to the
--     alphabetical name so two renders of the same data agree. When nobody
--     qualifies, the name and value are null and the detail still says what
--     would have been measured.
--
-- Indexes: created_at had none (the queue index is partial on open tickets),
-- and the waiting and reopen lookups want the event kind beside the ticket.
-- ---------------------------------------------------------------------------

create index if not exists tickets_created_at_idx
  on public.tickets (created_at);

create index if not exists activity_events_ticket_kind_at_idx
  on public.activity_events (ticket_id, kind, at);

-- ---------------------------------------------------------------------------
-- app_hours_label: a span of hours the way the queue writes an age.
--
-- The same rule as `formatHours` in src/lib/domain/resolved-stats.ts, so an
-- honour worded in SQL reads exactly like a median worded on the page:
-- rounded to the minute, never more than two units. "18m", "2h 10m", "1d 4h".
-- ---------------------------------------------------------------------------

create or replace function public.app_hours_label(p_hours numeric)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_minutes bigint;
  v_hours bigint;
  v_rest bigint;
begin
  if p_hours is null then
    return null;
  end if;

  v_minutes := greatest(0, pg_catalog.round(p_hours * 60))::bigint;
  if v_minutes < 60 then
    return v_minutes || 'm';
  end if;

  v_hours := v_minutes / 60;
  if v_hours < 24 then
    v_rest := v_minutes % 60;
    return v_hours || 'h' || case when v_rest > 0 then ' ' || v_rest || 'm' else '' end;
  end if;

  v_rest := v_hours % 24;
  return (v_hours / 24) || 'd' || case when v_rest > 0 then ' ' || v_rest || 'h' else '' end;
end;
$$;

comment on function public.app_hours_label(numeric) is
  'A span of hours written the way the queue writes an age: minutes under an hour, then "Xh Ym", then "Xd Yh". Rounded to the minute, never more than two units. NULL in, NULL out. Mirrors formatHours in the domain code.';

revoke execute on function public.app_hours_label(numeric) from public, anon;
grant execute on function public.app_hours_label(numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- app_analytics
-- ---------------------------------------------------------------------------

create or replace function public.app_analytics(
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_bucket text default 'day'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_admin boolean;
  v_zone constant text := 'America/New_York';
  v_now timestamptz := pg_catalog.now();
  -- The filter bounds: an open end is now, an open start is the cap.
  v_since timestamptz;
  v_until timestamptz;
  -- Where the series and the pace figures begin: the start, or the earliest
  -- ticket when the start is open. Never later than the end.
  v_start timestamptz;
  -- Where the pace figures stop: the end, or now if the end is still ahead.
  v_end timestamptz;
  v_prev_since timestamptz;
  v_prev_until timestamptz;
  v_step interval;
  v_document jsonb;
begin
  v_actor := public.app_require_actor();

  if not (v_actor.roles && array['admin', 'netrider']::text[]) then
    raise exception 'Only somebody who works tickets can read the desk''s analytics.'
      using errcode = 'insufficient_privilege';
  end if;
  v_admin := v_actor.roles && array['admin']::text[];

  if p_bucket is null or p_bucket not in ('day', 'week', 'month') then
    raise exception 'Choose day, week or month.' using errcode = 'check_violation';
  end if;
  v_step := case p_bucket
    when 'day' then interval '1 day'
    when 'week' then interval '1 week'
    else interval '1 month'
  end;

  v_until := coalesce(p_until, v_now);
  v_since := coalesce(p_since, v_until - interval '5 years');

  if v_since > v_until then
    raise exception 'That period ends before it begins.'
      using errcode = 'check_violation';
  end if;

  -- Capped rather than refused, for the reason app_resolved_stats gives.
  v_since := greatest(v_since, v_until - interval '5 years');

  if p_since is not null then
    v_prev_until := v_since;
    v_prev_since := v_since - (v_until - v_since);
  end if;

  if p_since is null then
    select least(greatest(coalesce(pg_catalog.min(t.created_at), v_until), v_since), v_until)
      into v_start
    from public.tickets t;
  else
    v_start := v_since;
  end if;
  v_end := least(v_until, v_now);

  with
  -- Every ticket resolved in the span, with the per-ticket figures the rest
  -- of the document is built from. One row per ticket; a ticket resolved,
  -- reopened and resolved again carries its latest resolution and counts
  -- once.
  closed as (
    select
      t.id,
      t.number,
      t.title,
      t.category,
      t.priority,
      t.resolved_by,
      a.display_name as resolver_name,
      t.created_at,
      t.resolved_at,
      pg_catalog.round(
        (pg_catalog.date_part('epoch', t.resolved_at - t.created_at) / 3600.0)::numeric, 2
      ) as hours,
      pg_catalog.round(
        (greatest(0, pg_catalog.date_part('epoch', t.resolved_at - coalesce(
          case when t.owner_id = t.resolved_by then t.assigned_at end,
          (
            select tc.added_at
            from public.ticket_collaborators tc
            where tc.ticket_id = t.id and tc.account_id = t.resolved_by
          ),
          t.created_at
        ))) / 3600.0)::numeric, 2
      ) as from_claim_hours,
      1 + (
        select pg_catalog.count(*)
        from public.ticket_collaborators tc
        where tc.ticket_id = t.id
      )::int as hands,
      (
        select pg_catalog.count(*)
        from public.activity_events e
        where e.ticket_id = t.id
          and e.kind = 'reopened'
          and e.at < t.resolved_at
      )::int as reopens,
      (pg_catalog.timezone(v_zone, t.resolved_at))::date as resolved_on,
      pg_catalog.date_trunc(p_bucket, pg_catalog.timezone(v_zone, t.resolved_at)) as bucket_start
    from public.tickets t
    join public.app_accounts a on a.id = t.resolved_by
    where t.resolved_by is not null
      and t.resolved_at >= v_since
      and t.resolved_at <= v_until
  ),
  scored as (
    select
      c.*,
      pg_catalog.round(
        (case c.priority when 'urgent' then 4 when 'high' then 3 when 'normal' then 2 else 1 end)
          * pg_catalog.ln(1 + greatest(c.hours, 0))
          + 0.5 * (c.hands - 1)
          + c.reopens,
        2
      ) as score
    from closed c
  ),
  -- Every ticket created in the span, with its school-local clock.
  made as (
    select
      t.id,
      t.category,
      t.channel,
      t.location,
      t.is_remote,
      t.requester_id,
      pg_catalog.timezone(v_zone, t.created_at) as local_at
    from public.tickets t
    where t.created_at >= v_since
      and t.created_at <= v_until
  ),
  totals as (
    select
      (select pg_catalog.count(*) from closed) as resolved,
      (select pg_catalog.count(*) from made) as created
  ),
  -- The series. Truncation happens on the school-local clock, so a bucket is
  -- a local day, a local Monday-to-Sunday week, or a local month.
  buckets as (
    select
      s.start_local,
      pg_catalog.timezone(v_zone, s.start_local + v_step) as end_at,
      case when p_bucket = 'month'
        then pg_catalog.to_char(s.start_local, 'YYYY-MM')
        else pg_catalog.to_char(s.start_local, 'YYYY-MM-DD')
      end as key,
      pg_catalog.row_number() over (order by s.start_local) as ordinal
    from pg_catalog.generate_series(
      pg_catalog.date_trunc(p_bucket, pg_catalog.timezone(v_zone, v_start)),
      pg_catalog.date_trunc(p_bucket, pg_catalog.timezone(v_zone, v_until)),
      v_step
    ) as s(start_local)
  ),
  made_by_bucket as (
    select pg_catalog.date_trunc(p_bucket, m.local_at) as start_local, pg_catalog.count(*) as n
    from made m
    group by 1
  ),
  closed_by_bucket as (
    select c.bucket_start as start_local, pg_catalog.count(*) as n
    from closed c
    group by 1
  ),
  throughput as (
    select
      b.ordinal,
      b.key,
      coalesce(mb.n, 0) as created,
      coalesce(cb.n, 0) as resolved,
      (
        select pg_catalog.count(*)
        from public.tickets t
        where t.created_at < b.end_at
          and (t.resolved_at is null or t.resolved_at >= b.end_at)
          and t.status <> 'cancelled'
      ) as backlog
    from buckets b
    left join made_by_bucket mb on mb.start_local = b.start_local
    left join closed_by_bucket cb on cb.start_local = b.start_local
  ),
  -- Categories: only the ones the span has something to say about.
  category_keys as (
    select m.category from made m
    union
    select c.category from closed c
  ),
  category_trend as (
    select
      k.category,
      pg_catalog.jsonb_agg(coalesce(r.n, 0) order by b.ordinal) as trend
    from category_keys k
    cross join buckets b
    left join (
      select c.category, c.bucket_start, pg_catalog.count(*) as n
      from closed c
      group by 1, 2
    ) r on r.category = k.category and r.bucket_start = b.start_local
    group by k.category
  ),
  categories as (
    select
      k.category,
      (select pg_catalog.count(*) from closed c where c.category = k.category) as resolved,
      (select pg_catalog.count(*) from made m where m.category = k.category) as created,
      (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.5) within group (order by c.hours))::numeric, 2
        )
        from closed c
        where c.category = k.category
      ) as median_hours,
      coalesce(ct.trend, '[]'::jsonb) as trend
    from category_keys k
    left join category_trend ct on ct.category = k.category
  ),
  priorities as (
    select
      p.priority,
      p.ordinal,
      (select pg_catalog.count(*) from closed c where c.priority = p.priority) as resolved,
      (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.5) within group (order by c.hours))::numeric, 2
        )
        from closed c where c.priority = p.priority
      ) as median_hours,
      (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.9) within group (order by c.hours))::numeric, 2
        )
        from closed c where c.priority = p.priority
      ) as p90_hours,
      (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.5) within group (order by c.from_claim_hours))::numeric, 2
        )
        from closed c where c.priority = p.priority
      ) as median_from_claim_hours
    from (values ('urgent', 1), ('high', 2), ('normal', 3), ('low', 4)) as p(priority, ordinal)
  ),
  channels as (
    select
      v.channel,
      v.ordinal,
      (select pg_catalog.count(*) from made m where m.channel = v.channel) as n
    from (values ('walk_in', 1), ('email', 2), ('phone_call', 3)) as v(channel, ordinal)
  ),
  -- Waiting spells of the span's resolved tickets. See note 8 above.
  waits as (
    select
      e.ticket_id,
      e.at as started_at,
      nullif(pg_catalog.btrim(coalesce(e.detail, '')), '') as reason,
      (
        select pg_catalog.min(n.at)
        from public.activity_events n
        where n.ticket_id = e.ticket_id
          and n.at > e.at
          and n.kind in ('status_changed', 'resolved', 'cancelled', 'returned_to_queue')
      ) as ended_at
    from public.activity_events e
    join closed c on c.id = e.ticket_id
    where e.kind = 'status_changed'
      and e.summary like '% set the ticket to Waiting'
      and e.at <= c.resolved_at
  ),
  -- Tickets joined as a collaborator inside the span, per account.
  joined as (
    select tc.account_id, pg_catalog.count(*) as n
    from public.ticket_collaborators tc
    where tc.added_at >= v_since
      and tc.added_at <= v_until
    group by tc.account_id
  ),
  person_rows as (
    select
      s.resolved_by as account_id,
      s.resolver_name as name,
      pg_catalog.count(*) as resolved,
      pg_catalog.round(
        (pg_catalog.percentile_cont(0.5) within group (order by s.hours))::numeric, 2
      ) as median_hours,
      pg_catalog.round(
        (pg_catalog.percentile_cont(0.5) within group (order by s.from_claim_hours))::numeric, 2
      ) as median_from_claim_hours,
      pg_catalog.count(*) filter (where s.priority in ('urgent', 'high')) as urgent_high,
      pg_catalog.round(
        (pg_catalog.percentile_cont(0.5) within group (order by s.from_claim_hours)
          filter (where s.priority in ('urgent', 'high')))::numeric, 2
      ) as urgent_from_claim,
      pg_catalog.round(pg_catalog.avg(s.score), 2) as hard_score,
      coalesce((select j.n from joined j where j.account_id = s.resolved_by), 0) as joined,
      pg_catalog.count(*) filter (where s.reopens > 0) as reopened,
      pg_catalog.count(distinct s.resolved_on)
        filter (where extract(isodow from s.resolved_on) between 1 and 5) as steady_days
    from scored s
    group by s.resolved_by, s.resolver_name
  ),
  person_json as (
    select
      r.*,
      pg_catalog.jsonb_build_object(
        'account_id', r.account_id,
        'name', r.name,
        'resolved', r.resolved,
        'median_hours', r.median_hours,
        'median_from_claim_hours', r.median_from_claim_hours,
        'urgent_high', r.urgent_high,
        'hard_score', r.hard_score,
        'joined', r.joined,
        'reopened', r.reopened
      ) as row_json
    from person_rows r
  ),
  honour_fastest as (
    select r.account_id, r.name, r.urgent_from_claim as figure, r.urgent_high as n
    from person_rows r
    where r.urgent_high >= 3
    order by r.urgent_from_claim asc, r.name asc
    limit 1
  ),
  honour_hardest as (
    select r.account_id, r.name, r.hard_score as figure, r.resolved as n
    from person_rows r
    where r.resolved >= 3
    order by r.hard_score desc, r.name asc
    limit 1
  ),
  honour_hands as (
    select a.id as account_id, a.display_name as name, j.n
    from joined j
    join public.app_accounts a on a.id = j.account_id
    where j.n >= 1
    order by j.n desc, a.display_name asc
    limit 1
  ),
  honour_steady as (
    select r.account_id, r.name, r.steady_days as n
    from person_rows r
    where r.steady_days >= 3
    order by r.steady_days desc, r.name asc
    limit 1
  ),
  -- Monday-to-Friday dates from the start to the end or today, school-local.
  school as (
    select pg_catalog.count(*) as days
    from pg_catalog.generate_series(
      (pg_catalog.timezone(v_zone, v_start))::date,
      (pg_catalog.timezone(v_zone, v_end))::date,
      interval '1 day'
    ) as d(day)
    where extract(isodow from d.day) between 1 and 5
  ),
  -- The span of equal length just before this one. Every column is null
  -- when there is no such span, and the document says null rather than zero.
  previous as (
    select
      (
        select pg_catalog.count(*)
        from public.tickets t
        where t.resolved_by is not null
          and t.resolved_at >= v_prev_since
          and t.resolved_at < v_prev_until
      ) as resolved,
      (
        select pg_catalog.count(*)
        from public.tickets t
        where t.created_at >= v_prev_since
          and t.created_at < v_prev_until
      ) as created,
      (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.5) within group (
            order by pg_catalog.date_part('epoch', t.resolved_at - t.created_at) / 3600.0
          ))::numeric, 2
        )
        from public.tickets t
        where t.resolved_by is not null
          and t.resolved_at >= v_prev_since
          and t.resolved_at < v_prev_until
      ) as median_hours
  ),
  -- Snapshots of now, not of the span.
  live as (
    select t.id, t.owner_id, t.status, t.created_at
    from public.tickets t
    where t.status not in ('resolved', 'cancelled')
  ),
  -- The eight hardest, chosen before anybody's visibility is consulted so a
  -- NetRider's list is the desk's list with some names withheld, not a
  -- different list.
  hard as (
    select s.*
    from scored s
    order by s.score desc, s.resolved_at desc, s.id asc
    limit 8
  )
  select pg_catalog.jsonb_build_object(
    'period_since', p_since,
    'until', v_until,
    'bucket', p_bucket,
    'overview', pg_catalog.jsonb_build_object(
      'resolved', tt.resolved,
      'resolved_previous', case when p_since is null then null else pv.resolved end,
      'created', tt.created,
      'created_previous', case when p_since is null then null else pv.created end,
      'cancelled', (
        select pg_catalog.count(*)
        from public.tickets t
        where t.status = 'cancelled'
          and t.created_at >= v_since
          and t.created_at <= v_until
      ),
      'reopened', (select pg_catalog.count(*) from closed c where c.reopens > 0),
      'median_hours', (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.5) within group (order by c.hours))::numeric, 2
        )
        from closed c
      ),
      'median_hours_previous', case when p_since is null then null else pv.median_hours end,
      'p90_hours', (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.9) within group (order by c.hours))::numeric, 2
        )
        from closed c
      ),
      'same_day_share', (
        select pg_catalog.round(pg_catalog.avg(case when c.hours <= 24 then 1 else 0 end)::numeric, 4)
        from closed c
      ),
      'school_days', sc.days,
      'per_school_day', case
        when sc.days > 0 then pg_catalog.round(tt.resolved::numeric / sc.days, 2)
        else null
      end,
      'per_week', case
        when v_end > v_start then pg_catalog.round(
          tt.resolved::numeric / (pg_catalog.date_part('epoch', v_end - v_start) / 604800.0)::numeric, 2
        )
        else null
      end,
      'open_now', (select pg_catalog.count(*) from live),
      'unassigned_now', (select pg_catalog.count(*) from live l where l.owner_id is null),
      'waiting_now', (select pg_catalog.count(*) from live l where l.status = 'waiting'),
      'oldest_open_hours', (
        select pg_catalog.round(
          (pg_catalog.date_part('epoch', v_now - pg_catalog.min(l.created_at)) / 3600.0)::numeric, 2
        )
        from live l
      )
    ),
    'throughput', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'key', x.key, 'created', x.created, 'resolved', x.resolved, 'backlog', x.backlog
        )
        order by x.ordinal
      )
      from throughput x
    ), '[]'::jsonb),
    'arrivals', pg_catalog.jsonb_build_object(
      'by_weekday', (
        select pg_catalog.jsonb_agg(coalesce(x.n, 0) order by d.i)
        from pg_catalog.generate_series(0, 6) as d(i)
        left join (
          select extract(isodow from m.local_at)::int - 1 as i, pg_catalog.count(*) as n
          from made m
          group by 1
        ) x on x.i = d.i
      ),
      'by_hour', (
        select pg_catalog.jsonb_agg(coalesce(x.n, 0) order by h.i)
        from pg_catalog.generate_series(0, 23) as h(i)
        left join (
          select extract(hour from m.local_at)::int as i, pg_catalog.count(*) as n
          from made m
          group by 1
        ) x on x.i = h.i
      ),
      'heat', (
        select pg_catalog.jsonb_agg(row.hours order by row.i)
        from (
          select
            d.i,
            (
              select pg_catalog.jsonb_agg(coalesce(x.n, 0) order by h.i)
              from pg_catalog.generate_series(0, 23) as h(i)
              left join (
                select extract(hour from m.local_at)::int as i, pg_catalog.count(*) as n
                from made m
                where extract(isodow from m.local_at)::int - 1 = d.i
                group by 1
              ) x on x.i = h.i
            ) as hours
          from pg_catalog.generate_series(0, 6) as d(i)
        ) row
      )
    ),
    'categories', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'category', k.category,
          'resolved', k.resolved,
          'created', k.created,
          'share', case
            when tt.resolved > 0 then pg_catalog.round(k.resolved::numeric / tt.resolved, 4)
            else 0
          end,
          'median_hours', k.median_hours,
          'trend', k.trend
        )
        order by k.resolved desc, k.created desc, k.category asc
      )
      from categories k
    ), '[]'::jsonb),
    'priorities', (
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'priority', p.priority,
          'resolved', p.resolved,
          'share', case
            when tt.resolved > 0 then pg_catalog.round(p.resolved::numeric / tt.resolved, 4)
            else 0
          end,
          'median_hours', p.median_hours,
          'p90_hours', p.p90_hours,
          'median_from_claim_hours', p.median_from_claim_hours
        )
        order by p.ordinal
      )
      from priorities p
    ),
    'channels', (
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'channel', ch.channel,
          'count', ch.n,
          'share', case
            when tt.created > 0 then pg_catalog.round(ch.n::numeric / tt.created, 4)
            else 0
          end
        )
        order by ch.ordinal
      )
      from channels ch
    ),
    'locations', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('location', l.location, 'count', l.n)
        order by l.n desc, l.location asc
      )
      from (
        select pg_catalog.btrim(m.location) as location, pg_catalog.count(*) as n
        from made m
        where m.location is not null
          and pg_catalog.btrim(m.location) <> ''
        group by 1
        order by 2 desc, 1 asc
        limit 8
      ) l
    ), '[]'::jsonb),
    'remote', (select pg_catalog.count(*) from made m where m.is_remote),
    'requesters', pg_catalog.jsonb_build_object(
      'staff', (
        select pg_catalog.count(*)
        from made m
        join public.requesters r on r.id = m.requester_id
        where r.kind = 'staff'
      ),
      'student', (
        select pg_catalog.count(*)
        from made m
        join public.requesters r on r.id = m.requester_id
        where r.kind = 'student'
      ),
      'other', (
        select pg_catalog.count(*)
        from made m
        left join public.requesters r on r.id = m.requester_id
        where r.kind is null or r.kind not in ('staff', 'student')
      ),
      'repeat', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('name', q.name, 'kind', q.kind, 'count', q.n)
          order by q.n desc, q.name asc
        )
        from (
          select r.display_name as name, r.kind, pg_catalog.count(*) as n
          from made m
          join public.requesters r on r.id = m.requester_id
          group by r.id, r.display_name, r.kind
          order by 3 desc, 1 asc
          limit 5
        ) q
      ), '[]'::jsonb)
    ),
    'waiting', pg_catalog.jsonb_build_object(
      'tickets_waited', (select pg_catalog.count(distinct w.ticket_id) from waits w),
      'share', case
        when tt.resolved > 0 then pg_catalog.round(
          (select pg_catalog.count(distinct w.ticket_id) from waits w)::numeric / tt.resolved, 4
        )
        else 0
      end,
      'median_wait_hours', (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.5) within group (
            order by pg_catalog.date_part('epoch', w.ended_at - w.started_at) / 3600.0
          ))::numeric, 2
        )
        from waits w
        where w.ended_at is not null
      ),
      'reasons', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('reason', q.reason, 'count', q.n)
          order by q.n desc, q.reason asc
        )
        from (
          select w.reason, pg_catalog.count(*) as n
          from waits w
          where w.reason is not null
          group by 1
          order by 2 desc, 1 asc
          limit 6
        ) q
      ), '[]'::jsonb)
    ),
    'people', pg_catalog.jsonb_build_object(
      'honours', pg_catalog.jsonb_build_array(
        coalesce(
          (
            select pg_catalog.jsonb_build_object(
              'key', 'fastest_urgent',
              'account_id', f.account_id,
              'name', f.name,
              'value', public.app_hours_label(f.figure),
              'detail', 'Median time from taking an urgent or high ticket to resolving it, over '
                || f.n || ' of them'
            )
            from honour_fastest f
          ),
          pg_catalog.jsonb_build_object(
            'key', 'fastest_urgent', 'account_id', null, 'name', null, 'value', null,
            'detail', 'Median time from taking an urgent or high ticket to resolving it; nobody has three of them in this period yet'
          )
        ),
        coalesce(
          (
            select pg_catalog.jsonb_build_object(
              'key', 'hardest',
              'account_id', f.account_id,
              'name', f.name,
              'value', 'score ' || pg_catalog.round(f.figure, 1),
              'detail', 'Mean difficulty score over ' || f.n
                || ' resolutions: priority, time open, hands and reopens'
            )
            from honour_hardest f
          ),
          pg_catalog.jsonb_build_object(
            'key', 'hardest', 'account_id', null, 'name', null, 'value', null,
            'detail', 'Mean difficulty score over their resolutions; nobody has three in this period yet'
          )
        ),
        coalesce(
          (
            select pg_catalog.jsonb_build_object(
              'key', 'most_hands',
              'account_id', f.account_id,
              'name', f.name,
              'value', f.n || case when f.n = 1 then ' ticket joined' else ' tickets joined' end,
              'detail', 'Tickets joined as a collaborator in this period'
            )
            from honour_hands f
          ),
          pg_catalog.jsonb_build_object(
            'key', 'most_hands', 'account_id', null, 'name', null, 'value', null,
            'detail', 'Tickets joined as a collaborator; nobody joined one in this period'
          )
        ),
        coalesce(
          (
            select pg_catalog.jsonb_build_object(
              'key', 'steadiest',
              'account_id', f.account_id,
              'name', f.name,
              'value', f.n || ' of ' || sc.days || ' school days',
              'detail', 'School days with at least one resolution, of the ' || sc.days
                || ' in this period'
            )
            from honour_steady f
          ),
          pg_catalog.jsonb_build_object(
            'key', 'steadiest', 'account_id', null, 'name', null, 'value', null,
            'detail', 'School days with at least one resolution; nobody has three in this period yet'
          )
        )
      ),
      'rows', case
        when v_admin then coalesce((
          select pg_catalog.jsonb_agg(pj.row_json order by pj.resolved desc, pj.name asc)
          from person_json pj
        ), '[]'::jsonb)
        else '[]'::jsonb
      end,
      'me', (select pj.row_json from person_json pj where pj.account_id = v_actor.id)
    ),
    'hardest', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'ticket_id', h.id,
          'number', case when v_admin or public.app_can_view_ticket(h.id) then h.number end,
          'title', case when v_admin or public.app_can_view_ticket(h.id) then h.title end,
          'category', h.category,
          'priority', h.priority,
          'hours', h.hours,
          'from_claim_hours', h.from_claim_hours,
          'resolver_name', h.resolver_name,
          'hands', h.hands,
          'score', h.score
        )
        order by h.score desc, h.resolved_at desc, h.id asc
      )
      from hard h
    ), '[]'::jsonb)
  )
  into v_document
  from totals tt, school sc, previous pv;

  return v_document;
end;
$$;

comment on function public.app_analytics(timestamptz, timestamptz, text) is
  'The analytics screen as one JSON document: overview counts with the previous span beside them, a zero-filled throughput series (day, week or month buckets, school-local), arrivals by weekday and hour, categories, priorities, channels, locations, requesters, waiting spells, the four honours, per-person rows (administrators only; everybody gets their own row) and the eight hardest tickets (number and title only where the reader could open the ticket). Resolved means resolved_by is set and resolved_at is in the span, so cancellations never count. NULL p_until means now, NULL p_since means the cap, and the span is clamped to five years. Anybody who works tickets.';

revoke execute on function public.app_analytics(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.app_analytics(timestamptz, timestamptz, text) to authenticated;
