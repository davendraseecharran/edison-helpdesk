-- ---------------------------------------------------------------------------
-- When a ticket was opened, and when it was written down.
--
-- The desk does not always type a ticket in the moment it happens. A walk-in
-- at 8:05 with a line behind it gets logged at lunch; a week of calls taken on
-- a sticky note gets logged on Friday; a job somebody fixed in the corridor is
-- worth recording after the fact, already finished. Until now intake could only
-- say "now" (a NetRider) or move a calendar date (an administrator), and the
-- calendar date moved nothing that counts: the queue's age, the Today screen
-- and every analytics figure read `created_at`, which stayed the moment of
-- typing.
--
-- This migration makes the opened moment a first-class thing a person can set,
-- the way app_import_resolved_ticket (20260916100200) already sets it for the
-- desk's old sheet:
--
--   * `created_at` IS the opened moment. Analytics, Today and the queue's age
--     already treat it as "when the requester asked", and that is now true of
--     a ticket logged late as well.
--   * `logged_at` (new, nullable) is when the row was actually written, set
--     only when that differs from the opened moment. NULL means "logged when
--     it was opened", which is every ticket before this migration and almost
--     every ticket after it. It is immutable, like created_at.
--   * The bounds are one rule, checked in one function: a moment in the
--     ticket's history is never in the future and never before 2020. The old
--     three-year floor on imports moves to the same line, so the form and the
--     import cannot disagree about which sheet rows are a history.
--   * The history says it: the `created` event is written at the opened
--     moment, and its detail reads "Logged on Sep 23 for Sep 12 at 9:05 AM."
--
-- And a ticket can be created already resolved, in one call: a solution and a
-- resolved moment (not before it opened, not after now), resolved by and owned
-- by whoever logs it. That is the intake-form twin of a sheet import, and the
-- one shape app_resolve_ticket cannot reach, since it stamps now().
--
-- NetRider rules are unchanged in substance: a NetRider's own intake is a
-- walk-in owned by themselves. What changes is that they may say when it
-- happened, because the NetRider logging a walk-in at lunch is exactly who
-- this is for; the legacy `p_submitted_on` (a date with no time, which never
-- moved created_at) stays administrator-only, as before.
--
-- Additive: one nullable column, one immutability trigger, two internal
-- helpers, and app_create_ticket restated with three new trailing arguments.
-- ---------------------------------------------------------------------------

alter table public.tickets add column logged_at timestamptz;

alter table public.tickets
  add constraint tickets_logged_after_opened check (logged_at is null or logged_at >= created_at);

comment on column public.tickets.logged_at is
  'When the ticket was actually written, when that was later than when it was opened (created_at). NULL means it was logged as it was opened. Immutable.';

comment on column public.tickets.created_at is
  'When the request was opened. Usually the instant it was recorded; a ticket logged later (intake with an earlier opened time, or an import) carries the earlier moment here and the real one in logged_at. Immutable.';

-- ---------------------------------------------------------------------------
-- logged_at is part of the creation record, so it is frozen with it.
-- ---------------------------------------------------------------------------

create function public.app_tickets_logged_at_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.logged_at is distinct from old.logged_at then
    raise exception 'When a ticket was logged cannot be changed.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger tickets_logged_at_guard
before update on public.tickets
for each row execute function public.app_tickets_logged_at_guard();

revoke all on function public.app_tickets_logged_at_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- app_history_floor / app_check_history_moment: one rule for "a real moment".
-- ---------------------------------------------------------------------------

create function public.app_history_floor()
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select timestamptz '2020-01-01 00:00:00 America/New_York';
$$;

comment on function public.app_history_floor() is
  'The earliest moment a ticket may be opened or resolved: the start of 2020, school-local. Older than that is a typo on a hand-kept sheet, not a history.';

create function public.app_check_history_moment(p_at timestamptz, p_what text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_at is null then
    return;
  end if;
  if p_at > pg_catalog.now() then
    raise exception '% cannot be in the future.', p_what using errcode = 'check_violation';
  end if;
  if p_at < public.app_history_floor() then
    raise exception '% cannot be before 2020.', p_what using errcode = 'check_violation';
  end if;
end;
$$;

comment on function public.app_check_history_moment(timestamptz, text) is
  'Refuses a moment in a ticket''s history that is in the future or before 2020, in words that name which moment. Internal: called by the intake and import functions.';

revoke all on function public.app_history_floor() from public, anon, authenticated;
revoke all on function public.app_check_history_moment(timestamptz, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- app_logged_later_note: the sentence the history carries.
--
-- "Logged on Sep 23 for Sep 12 at 9:05 AM." — or, logged later the same day,
-- "Logged at 2:40 PM for 9:05 AM." A year is named only when it differs from
-- the year it was logged in. School-local throughout.
-- ---------------------------------------------------------------------------

create function public.app_logged_later_note(p_opened timestamptz, p_logged timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  with local as (
    select
      p_opened at time zone 'America/New_York' as opened,
      p_logged at time zone 'America/New_York' as logged
  )
  select case
    when l.opened::date = l.logged::date then
      'Logged at ' || pg_catalog.to_char(l.logged, 'FMHH12:MI AM')
        || ' for ' || pg_catalog.to_char(l.opened, 'FMHH12:MI AM') || '.'
    else
      'Logged on ' || pg_catalog.to_char(l.logged, 'Mon FMDD')
        || ' for ' || pg_catalog.to_char(l.opened, 'Mon FMDD')
        || case
             when pg_catalog.date_part('year', l.opened) <> pg_catalog.date_part('year', l.logged)
               then ', ' || pg_catalog.to_char(l.opened, 'YYYY')
             else ''
           end
        || ' at ' || pg_catalog.to_char(l.opened, 'FMHH12:MI AM') || '.'
  end
  from local l;
$$;

comment on function public.app_logged_later_note(timestamptz, timestamptz) is
  'The history line for a ticket logged after it was opened, school-local: "Logged on Sep 23 for Sep 12 at 9:05 AM." Internal.';

revoke all on function public.app_logged_later_note(timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- app_create_ticket, restated from 20260914140200_m5_roles_fixes.sql with three
-- trailing arguments:
--
--   p_opened_at    when the request was opened. NULL, or anything within a
--                  minute of now either side (a browser clock a few seconds
--                  ahead is not a future ticket), is now. Earlier than that is
--                  a ticket logged later: created_at takes the moment,
--                  submitted_on its school day, logged_at the real now, and
--                  the created event is written at the moment with the
--                  "Logged on ..." line. Anybody who may create a ticket may
--                  set it; the bounds are app_check_history_moment's.
--   p_solution     when given, the ticket is created resolved, by the caller,
--                  owned by the caller. An administrator naming another owner
--                  in the same call is refused rather than overridden.
--   p_resolved_at  when it was resolved. Needs p_solution; defaults to now;
--                  never before the opened moment and never in the future.
--
-- The old signature is dropped rather than overloaded: two functions that
-- both take seventeen named arguments with defaults would make every existing
-- call ambiguous. Every body line not about those three is unchanged.
-- ---------------------------------------------------------------------------

drop function public.app_create_ticket(
  text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid[]
);

create function public.app_create_ticket(
  p_title text,
  p_issue text,
  p_channel text,
  p_priority text default 'normal',
  p_submitted_on date default null,
  p_requester_id uuid default null,
  p_requester_name text default null,
  p_requester_kind text default 'staff',
  p_requester_descriptor text default null,
  p_requester_unknown boolean default false,
  p_location text default null,
  p_is_remote boolean default false,
  p_owner_id uuid default null,
  p_collaborator_ids uuid[] default '{}',
  p_devices jsonb default '[]',
  p_category text default 'other',
  p_device_ids uuid[] default '{}',
  p_opened_at timestamptz default null,
  p_solution text default null,
  p_resolved_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_admin boolean;
  v_channel text := p_channel;
  v_owner uuid := p_owner_id;
  v_requester uuid := p_requester_id;
  v_submitted date;
  v_category text := coalesce(nullif(pg_catalog.btrim(coalesce(p_category, '')), ''), 'other');
  v_now timestamptz := pg_catalog.now();
  v_opened timestamptz;
  v_backdated boolean := false;
  v_solution text := nullif(pg_catalog.btrim(coalesce(p_solution, '')), '');
  v_resolved timestamptz;
  v_via text := public.app_request_via();
  v_model text := public.app_request_ai_model();
  v_owner_name text;
  v_ticket public.tickets;
  v_ticket_id uuid;
  v_collaborator uuid;
  v_collab_name text;
  v_devices jsonb := coalesce(p_devices, '[]'::jsonb);
  v_device jsonb;
  v_device_type text;
  v_manufacturer text;
  v_model_name text;
  v_serial text;
  v_inventory public.inventory_devices;
  v_inventory_id uuid;
  v_seen_inventory uuid[] := '{}';
  v_device_id uuid;
  v_seen uuid[] := '{}';
  v_linked uuid[] := '{}';
begin
  v_actor := public.app_require_actor();
  v_admin := v_actor.role = 'admin';

  if length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'A short title is required.' using errcode = 'check_violation';
  end if;
  if length(btrim(p_title)) > 120 then
    raise exception 'Keep the title under 120 characters.' using errcode = 'check_violation';
  end if;
  if length(coalesce(p_issue, '')) > 6000 then
    raise exception 'Keep notes under 6000 characters.' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_requester_name, ''))) > 0 then
    raise exception 'Select an existing requester or Requester Unknown.' using errcode = 'check_violation';
  end if;
  if coalesce(p_is_remote, false) then
    raise exception 'Use the location field for intake.' using errcode = 'check_violation';
  end if;
  if pg_catalog.jsonb_typeof(v_devices) <> 'array' then
    raise exception 'Send the devices as a list.' using errcode = 'check_violation';
  end if;
  if pg_catalog.jsonb_array_length(v_devices) > 50 then
    raise exception 'Record at most 50 devices on one ticket.' using errcode = 'check_violation';
  end if;
  if not (public.app_category_labels() ? v_category) then
    raise exception 'Choose a category for this ticket.' using errcode = 'check_violation';
  end if;

  -- When it was opened. Two ways to say it would be two answers to one
  -- question, so a caller sends one or neither.
  if p_opened_at is not null and p_submitted_on is not null then
    raise exception 'Give the opened time or the submission date, not both.'
      using errcode = 'check_violation';
  end if;
  if p_opened_at is null or p_opened_at >= v_now - interval '1 minute' then
    -- Now, or close enough to it that a difference is a clock and not a
    -- history. A moment more than a minute ahead is still refused below.
    if p_opened_at is not null and p_opened_at > v_now + interval '1 minute' then
      perform public.app_check_history_moment(p_opened_at, 'The opened time');
    end if;
    v_opened := v_now;
  else
    perform public.app_check_history_moment(p_opened_at, 'The opened time');
    v_opened := p_opened_at;
    v_backdated := true;
  end if;

  v_submitted := case
    when v_backdated then (v_opened at time zone 'America/New_York')::date
    else coalesce(p_submitted_on, public.app_today())
  end;
  if v_submitted > public.app_today() then
    raise exception 'The submission date cannot be in the future.' using errcode = 'check_violation';
  end if;

  -- Resolved at intake: a solution, and when. Checked before anything is
  -- written, so a refusal costs nothing.
  if v_solution is null and p_resolved_at is not null then
    raise exception 'Write what fixed it to record the ticket as resolved.'
      using errcode = 'check_violation';
  end if;
  if v_solution is not null then
    if length(v_solution) < 5 then
      raise exception 'Describe the solution so the history stays useful.' using errcode = 'check_violation';
    end if;
    if length(v_solution) > 6000 then
      raise exception 'Keep the solution under 6000 characters.' using errcode = 'check_violation';
    end if;
    if p_resolved_at is null or p_resolved_at >= v_now - interval '1 minute' then
      if p_resolved_at is not null and p_resolved_at > v_now + interval '1 minute' then
        perform public.app_check_history_moment(p_resolved_at, 'The resolved time');
      end if;
      v_resolved := v_now;
    else
      perform public.app_check_history_moment(p_resolved_at, 'The resolved time');
      v_resolved := p_resolved_at;
    end if;
    if v_resolved < v_opened then
      raise exception 'A ticket cannot be resolved before it was opened.' using errcode = 'check_violation';
    end if;
    -- Whoever resolves it at intake did the work, so it is theirs. Naming
    -- somebody else here would put a colleague's name on a fix they never
    -- touched; that is the import's administrator-only path, not intake's.
    if v_owner is not null and v_owner <> v_actor.id then
      raise exception 'A ticket resolved at intake belongs to whoever logs it. Leave the owner as yourself.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- NetRider intake is a walk-in they own. A forged channel or owner is
  -- REJECTED rather than silently corrected. When it happened is theirs to
  -- say through p_opened_at; the legacy date-only p_submitted_on stays an
  -- administrator's.
  if not v_admin then
    if v_channel is distinct from 'walk_in' then
      raise exception 'NetRiders can only record walk-in tickets.' using errcode = 'insufficient_privilege';
    end if;
    if v_owner is not null and v_owner <> v_actor.id then
      raise exception 'NetRiders must assign their walk-in tickets to themselves.'
        using errcode = 'insufficient_privilege';
    end if;
    if p_submitted_on is not null and p_submitted_on <> public.app_today() then
      raise exception 'NetRiders cannot backdate a walk-in ticket.' using errcode = 'insufficient_privilege';
    end if;
    v_owner := v_actor.id;
  end if;
  if v_solution is not null then
    v_owner := v_actor.id;
  end if;

  if v_owner is not null and not exists (
    select 1 from public.app_accounts a where a.id = v_owner and a.status = 'active'
  ) then
    raise exception 'Choose an active NetRider as the owner.' using errcode = 'check_violation';
  end if;

  if coalesce(p_requester_unknown, false) then
    if p_requester_id is not null then
      raise exception 'Choose one requester option.' using errcode = 'check_violation';
    end if;
    v_requester := null;
  elsif v_requester is null or not exists (
    select 1 from public.requesters r
    where r.id = v_requester and r.kind in ('staff', 'student')
  ) then
    raise exception 'Select an existing requester or Requester Unknown.' using errcode = 'check_violation';
  end if;

  insert into public.tickets (
    title, issue, requester_id, requester_unknown, location, is_remote,
    channel, priority, status, submitted_on, created_at, logged_at, created_by,
    owner_id, assigned_at, category, solution, resolved_by, resolved_at,
    resolved_via, resolved_ai_model
  )
  values (
    btrim(p_title),
    btrim(coalesce(p_issue, '')),
    v_requester,
    coalesce(p_requester_unknown, false),
    case when p_is_remote then null else nullif(btrim(coalesce(p_location, '')), '') end,
    coalesce(p_is_remote, false),
    v_channel,
    coalesce(nullif(btrim(coalesce(p_priority, '')), ''), 'normal'),
    case
      when v_solution is not null then 'resolved'
      when v_owner is null then 'open'
      else 'assigned'
    end,
    v_submitted,
    v_opened,
    case when v_backdated then v_now end,
    v_actor.id,
    v_owner,
    -- Taken on when it came in, for somebody who took it on themselves; an
    -- administrator handing it to a colleague did that now.
    case
      when v_owner is null then null
      when v_owner = v_actor.id then v_opened
      else v_now
    end,
    v_category,
    v_solution,
    case when v_solution is not null then v_actor.id end,
    v_resolved,
    case when v_solution is not null then v_via else 'user' end,
    case when v_solution is not null then v_model end
  )
  returning * into v_ticket;
  v_ticket_id := v_ticket.id;

  -- The events the ordinary path leaves, at the moments they happened.
  -- app_log_event takes no timestamp, so these are written directly with the
  -- same columns and the same attribution pair it stamps.
  insert into public.activity_events (
    ticket_id, kind, actor_id, at, summary, detail, performed_via, ai_model
  )
  values (
    v_ticket_id, 'created', v_actor.id, v_opened,
    v_actor.display_name || ' recorded '
      || case v_channel when 'email' then 'an ' else 'a ' end
      || case v_channel when 'walk_in' then 'walk-in' when 'email' then 'email' else 'phone call' end
      || ' request',
    case
      when v_backdated then public.app_logged_later_note(v_opened, v_now)
      when v_submitted <> public.app_today() then 'Submission date backdated to ' || v_submitted::text || '.'
      else null
    end,
    v_via, v_model
  );

  if v_owner is not null then
    if v_owner <> v_actor.id then
      select a.display_name into v_owner_name from public.app_accounts a where a.id = v_owner;
    end if;
    insert into public.activity_events (
      ticket_id, kind, actor_id, at, summary, detail, performed_via, ai_model
    )
    values (
      v_ticket_id, 'assigned', v_actor.id,
      case when v_owner = v_actor.id then v_opened else v_now end,
      case when v_owner = v_actor.id
        then v_actor.display_name || ' took ownership at intake'
        else v_actor.display_name || ' assigned the ticket to ' || v_owner_name
      end,
      null,
      v_via, v_model
    );
  end if;

  if v_solution is not null then
    insert into public.activity_events (
      ticket_id, kind, actor_id, at, summary, detail, performed_via, ai_model
    )
    values (
      v_ticket_id, 'resolved', v_actor.id, v_resolved,
      v_actor.display_name || ' resolved the ticket at intake',
      v_solution,
      v_via, v_model
    );
  end if;

  foreach v_collaborator in array coalesce(p_collaborator_ids, '{}') loop
    continue when v_collaborator = v_owner or v_collaborator = any (v_seen);
    select a.display_name into v_collab_name
    from public.app_accounts a
    where a.id = v_collaborator and a.status = 'active';
    if not found then
      raise exception 'Collaborators must be active accounts.' using errcode = 'check_violation';
    end if;
    insert into public.ticket_collaborators (ticket_id, account_id, added_by)
    values (v_ticket_id, v_collaborator, v_actor.id);
    v_seen := v_seen || v_collaborator;
    perform public.app_log_event(
      v_ticket_id, 'collaborator_added', v_actor.id,
      v_actor.display_name || ' added ' || v_collab_name || ' as a collaborator'
    );
  end loop;

  for v_device in select * from pg_catalog.jsonb_array_elements(v_devices) loop
    v_device_type := btrim(coalesce(v_device ->> 'deviceType', ''));
    v_inventory_id := nullif(btrim(coalesce(v_device ->> 'inventoryDeviceId', '')), '')::uuid;

    if v_inventory_id is not null then
      if v_inventory_id = any (v_seen_inventory) then
        raise exception 'That inventory device was already added.' using errcode = 'check_violation';
      end if;
      select * into v_inventory
      from public.inventory_devices d
      where d.id = v_inventory_id and d.assigned_requester_id = v_requester
      for share;
      if not found then
        raise exception 'That device is no longer assigned to the selected requester.'
          using errcode = 'check_violation';
      end if;
      v_seen_inventory := v_seen_inventory || v_inventory_id;
      v_device := pg_catalog.jsonb_build_object(
        'deviceType', v_inventory.device_type,
        'manufacturer', v_inventory.manufacturer,
        'model', v_inventory.model,
        'serialNumber', v_inventory.serial_number,
        'assetTag', v_inventory.asset_tag,
        'osVersion', v_inventory.os_version
      );
      v_device_type := v_inventory.device_type;
    end if;

    if v_device_type = '' then
      raise exception 'Each device entry needs a device type.' using errcode = 'check_violation';
    end if;

    v_manufacturer := nullif(btrim(coalesce(v_device ->> 'manufacturer', '')), '');
    v_model_name := nullif(btrim(coalesce(v_device ->> 'model', '')), '');
    v_serial := nullif(btrim(coalesce(v_device ->> 'serialNumber', '')), '');

    if v_manufacturer is not null then
      if v_model_name is null or v_serial is null then
        raise exception 'Each device requires a device type, manufacturer, model and serial number.'
          using errcode = 'check_violation';
      end if;
      if not exists (
        select 1 from public.device_catalog c
        where c.device_type = v_device_type
          and c.manufacturer = v_manufacturer
          and c.model = v_model_name
      ) then
        raise exception 'Select a device type, manufacturer and model from inventory.'
          using errcode = 'check_violation';
      end if;
    end if;

    insert into public.device_observations (
      ticket_id, device_type, manufacturer, inventory_device_id, model, os_version,
      serial_number, asset_tag, identifiers_not_applicable, recorded_by,
      performed_via, ai_model
    )
    values (
      v_ticket_id, v_device_type, v_manufacturer, v_inventory_id,
      v_model_name,
      nullif(btrim(coalesce(v_device ->> 'osVersion', '')), ''),
      v_serial,
      nullif(btrim(coalesce(v_device ->> 'assetTag', '')), ''),
      coalesce((v_device ->> 'identifiersNotApplicable')::boolean, false),
      v_actor.id,
      v_via, v_model
    );
    perform public.app_log_event(
      v_ticket_id, 'device_recorded', v_actor.id,
      v_actor.display_name || ' recorded a device: ' || v_device_type
    );
  end loop;

  foreach v_device_id in array coalesce(p_device_ids, '{}') loop
    continue when v_device_id is null or v_device_id = any (v_linked);
    perform public.app_link_device(v_ticket, v_device_id, v_actor);
    v_linked := v_linked || v_device_id;
  end loop;

  return v_ticket_id;
end;
$$;

comment on function public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid[], timestamptz, text, timestamptz) is
  'Records one request. p_requester_id names a staff or student row in the district directory, or p_requester_unknown says there is nobody to name. p_opened_at sets when it was opened (never in the future, never before 2020; within a minute of now is now): created_at takes it, logged_at keeps the real moment, and the history says it was logged later. p_solution (with an optional p_resolved_at) creates it already resolved, by and owned by the caller. A NetRider''s intake is a walk-in they own; a forged channel, owner or date is rejected rather than corrected.';

revoke execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid[], timestamptz, text, timestamptz)
from public, anon;

grant execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid[], timestamptz, text, timestamptz)
to authenticated;
