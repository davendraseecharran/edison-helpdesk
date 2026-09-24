-- The week in review: one read of what somebody did and what happened around
-- them, for the /summary page, a once-a-week notice, and (where mail is set
-- up) a Monday email.
--
-- A school week runs Monday to Sunday in the school's own time zone. What is
-- in it depends on who is asking:
--
--   * tickets and workflows — only for somebody who works tickets (an
--     administrator or a NetRider): their own resolutions and the desk's
--     totals, which Analytics already shows every ticket worker;
--   * groups — events held that week with how many were present, for every
--     active account (groups are open to all of them);
--   * forms — responses to the forms the account can see (shared, their own,
--     or every form for an administrator).
--
-- Counts only. No person, no ticket title, no answer leaves this function,
-- so the same document can go into a notice or an email safely.
--
-- One private core that takes an account id, and three doors:
--   app_weekly_summary(week)        — the caller's own, for the page;
--   app_weekly_summary_notify()     — the caller's notice for last week, once;
--   app_weekly_summary_recipients() — service role only, for the Monday mail.

alter table public.account_preferences
  add column weekly_summary_email boolean not null default true;

comment on column public.account_preferences.weekly_summary_email is
  'Whether the Monday email of the week in review is sent to this account (only where the deployment has mail). Default on; Settings turns it off.';

create function public.app_school_week_start(p_day date)
returns date
language sql
immutable
set search_path = ''
as $$
  select p_day - (extract(isodow from p_day)::integer - 1);
$$;

create function public.app_weekly_summary_core(p_account uuid, p_week_start date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with acct as (
    select a.id, a.roles
    from public.app_accounts a
    where a.id = p_account and a.status = 'active'
  ),
  span as (
    select
      (p_week_start::timestamp at time zone 'America/New_York') as since,
      ((p_week_start + 7)::timestamp at time zone 'America/New_York') as until,
      ((p_week_start - 7)::timestamp at time zone 'America/New_York') as prev_since
  ),
  who as (
    select
      a.id,
      a.roles && array['admin', 'netrider']::text[] as worker,
      'admin' = any (a.roles) as admin
    from acct a
  ),
  tickets as (
    select pg_catalog.jsonb_build_object(
      'you_resolved', (
        select pg_catalog.count(*) from public.tickets t, span s
        where t.resolved_by = w.id and t.status = 'resolved'
          and t.resolved_at >= s.since and t.resolved_at < s.until),
      'you_resolved_prev', (
        select pg_catalog.count(*) from public.tickets t, span s
        where t.resolved_by = w.id and t.status = 'resolved'
          and t.resolved_at >= s.prev_since and t.resolved_at < s.since),
      'you_logged', (
        select pg_catalog.count(*) from public.tickets t, span s
        where t.created_by = w.id and t.created_at >= s.since and t.created_at < s.until),
      'you_own_open', (
        select pg_catalog.count(*) from public.tickets t
        where t.owner_id = w.id and t.status in ('assigned', 'in_progress', 'waiting')),
      'you_median_hours', (
        select pg_catalog.round(
          (pg_catalog.percentile_cont(0.5) within group (
            order by extract(epoch from t.resolved_at - t.created_at) / 3600.0
          ))::numeric, 1)
        from public.tickets t, span s
        where t.resolved_by = w.id and t.status = 'resolved'
          and t.resolved_at >= s.since and t.resolved_at < s.until),
      'desk_created', (
        select pg_catalog.count(*) from public.tickets t, span s
        where t.created_at >= s.since and t.created_at < s.until),
      'desk_resolved', (
        select pg_catalog.count(*) from public.tickets t, span s
        where t.status = 'resolved' and t.resolved_at >= s.since and t.resolved_at < s.until),
      'desk_resolved_prev', (
        select pg_catalog.count(*) from public.tickets t, span s
        where t.status = 'resolved' and t.resolved_at >= s.prev_since and t.resolved_at < s.since),
      'unassigned_now', (
        select pg_catalog.count(*) from public.tickets t
        where t.status = 'open' and t.owner_id is null),
      'busiest_day', (
        select pg_catalog.to_char(t.created_at at time zone 'America/New_York', 'FMDay')
        from public.tickets t, span s
        where t.created_at >= s.since and t.created_at < s.until
        group by 1 order by pg_catalog.count(*) desc, 1 limit 1),
      'top_category', (
        select t.category from public.tickets t, span s
        where t.created_at >= s.since and t.created_at < s.until and t.category is not null
        group by t.category order by pg_catalog.count(*) desc, t.category limit 1),
      'workflow_runs', (
        select pg_catalog.count(*) from public.workflow_runs r, span s
        where r.run_by = w.id and r.started_at >= s.since and r.started_at < s.until),
      'workflow_devices', (
        select coalesce(pg_catalog.sum(r.done), 0) from public.workflow_runs r, span s
        where r.run_by = w.id and r.started_at >= s.since and r.started_at < s.until)
    ) as doc
    from who w
    where w.worker
  ),
  events as (
    select coalesce(pg_catalog.jsonb_agg(e.doc order by e.held_on, e.name), '[]'::jsonb) as list,
           coalesce(pg_catalog.sum(e.present), 0) as checkins
    from (
      select
        ev.held_on,
        ev.name,
        (select pg_catalog.count(*) from public.group_attendance ga where ga.event_id = ev.id) as present,
        pg_catalog.jsonb_build_object(
          'id', ev.id,
          'name', ev.name,
          'group', g.name,
          'held_on', ev.held_on,
          'present', (select pg_catalog.count(*) from public.group_attendance ga where ga.event_id = ev.id),
          'members', (select pg_catalog.count(*) from public.people_group_members m where m.group_id = g.id)
        ) as doc
      from public.group_events ev
      join public.people_groups g on g.id = ev.group_id
      where ev.held_on >= p_week_start and ev.held_on < p_week_start + 7
        and exists (select 1 from acct)
      order by ev.held_on, ev.name
      limit 12
    ) e
  ),
  forms as (
    select
      coalesce(pg_catalog.sum(f.responses), 0) as total,
      coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('id', f.id, 'title', f.title, 'responses', f.responses)
          order by f.responses desc, f.title
        ) filter (where f.rank <= 5),
        '[]'::jsonb
      ) as top
    from (
      select fm.id, fm.title, pg_catalog.count(fr.id) as responses,
             pg_catalog.row_number() over (order by pg_catalog.count(fr.id) desc, fm.title) as rank
      from public.forms fm
      join public.form_responses fr on fr.form_id = fm.id
      cross join span s
      cross join who w
      where fr.submitted_at >= s.since and fr.submitted_at < s.until
        and (fm.shared or fm.created_by = w.id or w.admin)
      group by fm.id, fm.title
    ) f
  )
  select case when not exists (select 1 from acct) then null else
    pg_catalog.jsonb_build_object(
      'week_start', p_week_start,
      'week_end', p_week_start + 6,
      'tickets', (select doc from tickets),
      'events', (select list from events),
      'checkins', (select checkins from events),
      'form_responses', (select total from forms),
      'forms', (select top from forms)
    )
  end;
$$;

comment on function public.app_weekly_summary_core(uuid, date) is
  'The week in review for one active account: counts only (tickets and workflows for ticket workers, events with attendance, responses to forms the account can see). Private: called through app_weekly_summary, app_weekly_summary_notify and app_weekly_summary_recipients.';

revoke all on function public.app_weekly_summary_core(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.app_school_week_start(date) from public, anon;
grant execute on function public.app_school_week_start(date) to authenticated, service_role;

-- The caller's own week. Default: the week in progress.
create function public.app_weekly_summary(p_week_start date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account uuid := public.app_active_account_id();
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_week date := public.app_school_week_start(coalesce(p_week_start, v_today));
begin
  if v_account is null then
    raise exception 'The week in review is for signed-in, active accounts.' using errcode = '42501';
  end if;
  if v_week > v_today or v_week < date '2020-01-01' then
    raise exception 'Pick a week between 2020 and this one.' using errcode = '22023';
  end if;
  return public.app_weekly_summary_core(v_account, v_week);
end;
$$;

revoke all on function public.app_weekly_summary(date) from public, anon, authenticated;
grant execute on function public.app_weekly_summary(date) to authenticated;

-- One notice per account per week, about the week that just ended, written
-- the first time the account opens the app on or after Monday. Nothing is
-- written for a week in which nothing happened. Answers whether it wrote one.
create function public.app_weekly_summary_notify()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid := public.app_active_account_id();
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_this_week date := public.app_school_week_start(v_today);
  v_last_week date := v_this_week - 7;
  v_doc jsonb;
  v_parts text[] := '{}';
  v_resolved bigint;
  v_events integer;
  v_checkins bigint;
  v_responses bigint;
begin
  if v_account is null then
    return false;
  end if;
  if exists (
    select 1 from public.notifications n
    where n.account_id = v_account and n.kind = 'weekly_summary'
      and n.created_at >= (v_this_week::timestamp at time zone 'America/New_York')
  ) then
    return false;
  end if;

  v_doc := public.app_weekly_summary_core(v_account, v_last_week);
  if v_doc is null then
    return false;
  end if;

  v_resolved := coalesce((v_doc -> 'tickets' ->> 'you_resolved')::bigint, 0);
  v_events := pg_catalog.jsonb_array_length(coalesce(v_doc -> 'events', '[]'::jsonb));
  v_checkins := coalesce((v_doc ->> 'checkins')::bigint, 0);
  v_responses := coalesce((v_doc ->> 'form_responses')::bigint, 0);

  if v_doc -> 'tickets' is not null then
    v_parts := v_parts || pg_catalog.format(
      'You resolved %s %s; the desk closed %s.',
      v_resolved,
      case when v_resolved = 1 then 'ticket' else 'tickets' end,
      coalesce(v_doc -> 'tickets' ->> 'desk_resolved', '0')
    );
  end if;
  if v_events > 0 then
    v_parts := v_parts || pg_catalog.format(
      '%s %s, %s check-ins.',
      v_events, case when v_events = 1 then 'event' else 'events' end, v_checkins
    );
  end if;
  if v_responses > 0 then
    v_parts := v_parts || pg_catalog.format(
      '%s form %s.', v_responses, case when v_responses = 1 then 'response' else 'responses' end
    );
  end if;

  if v_resolved = 0 and v_events = 0 and v_responses = 0
     and coalesce((v_doc -> 'tickets' ->> 'desk_resolved')::bigint, 0) = 0 then
    return false;
  end if;

  perform public.app_notify(
    v_account,
    'weekly_summary',
    'Your week in review',
    pg_catalog.array_to_string(v_parts, ' '),
    '/summary?week=' || v_last_week::text
  );
  return true;
end;
$$;

revoke all on function public.app_weekly_summary_notify() from public, anon, authenticated;
grant execute on function public.app_weekly_summary_notify() to authenticated;

-- Everybody the Monday email goes to, with their document. Service role only:
-- the cron route runs with the service key and nothing else may enumerate
-- accounts and their addresses.
create function public.app_weekly_summary_recipients(p_week_start date)
returns table (account_id uuid, email text, display_name text, summary jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.email, a.display_name,
         public.app_weekly_summary_core(a.id, public.app_school_week_start(p_week_start))
  from public.app_accounts a
  left join public.account_preferences p on p.account_id = a.id
  where a.status = 'active'
    and coalesce(p.weekly_summary_email, true)
    and nullif(pg_catalog.btrim(coalesce(a.email, '')), '') is not null;
$$;

revoke all on function public.app_weekly_summary_recipients(date) from public, anon, authenticated;
grant execute on function public.app_weekly_summary_recipients(date) to service_role;

-- The Settings switch.
create function public.app_set_weekly_summary_email(p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid := public.app_active_account_id();
begin
  if v_account is null then
    raise exception 'Settings are for signed-in, active accounts.' using errcode = '42501';
  end if;
  insert into public.account_preferences (account_id, weekly_summary_email)
  values (v_account, coalesce(p_on, true))
  on conflict (account_id) do update
    set weekly_summary_email = excluded.weekly_summary_email,
        updated_at = pg_catalog.now();
end;
$$;

revoke all on function public.app_set_weekly_summary_email(boolean) from public, anon, authenticated;
grant execute on function public.app_set_weekly_summary_email(boolean) to authenticated;
