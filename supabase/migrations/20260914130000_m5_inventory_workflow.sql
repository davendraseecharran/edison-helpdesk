-- M5 inventory workflow: assignment, return, bulk edits, lookup.
--
-- The district's inventory (public.inventory_devices, 20260912220000 and
-- 20260913150000) records WHERE a machine is now: one assigned_requester_id, a
-- free-text status, a location, and a version the revision trigger bumps on
-- every update. What it has no way to say is that a machine MOVED, and by whose
-- hand. app_save_inventory_device can change the assignee like any other field,
-- and writes a before/after snapshot into inventory_events, but that log is
-- unreadable from a session by design and answers "who held this and when" only
-- by diffing JSON.
--
-- This file adds the four movements a help desk actually performs, on the
-- owner's tables and without loosening one of their policies:
--
--   * app_assign_inventory_device   — hand a machine to somebody
--   * app_return_inventory_device   — take it back, and say what state it is in
--   * app_bulk_update_inventory     — restatus or move a trayful at once
--   * app_lookup_inventory_code     — scan a barcode, get the machine
--
-- plus app_requester_devices, the read the person page needs.
--
-- Three rules they all obey.
--
-- 1. THE HISTORY IS WRITTEN TWICE, on purpose. inventory_events keeps the
--    owner's before/after snapshot, so an inventory audit is complete whichever
--    way a row was changed. record_events keeps the sentence a person reads —
--    "Assigned to Wren Calloway", "Returned by Priya Raman" — on both the
--    machine and the person, attributed through app_request_via() /
--    app_request_ai_model() like every other event in this application, so an
--    assistant acting on somebody's behalf is recorded as exactly that.
--
-- 2. THE VERSION IS RESPECTED, both ways. Every writer takes the row `for
--    update` and, when the caller passes the version it read, refuses a stale
--    one with the owner's own words and their own errcode, so the inventory
--    screen shows one message however the edit was made. Passing no version is
--    allowed and means "whatever it is now" — a scanner at a cart has not read
--    a form.
--
-- 3. RLS IS THEIRS, UNCHANGED. inventory_devices and requesters keep the
--    policies they wrote; every function here is SECURITY DEFINER with the gate
--    written in its own body, which is the pattern the whole inventory surface
--    already uses.

-- ---------------------------------------------------------------------------
-- Archiving a person
--
-- requesters.student_status already retires a STUDENT: 'graduated' and 'other'
-- are exactly that, and 1,257 of the 3,448 students carry 'graduated' today.
-- Staff have no equivalent — a member of staff who leaves has no column that
-- says so, and deleting the row is refused by the tickets and machines that
-- name them. archived_at is that column, for either kind.
--
-- Nothing in this milestone sets it. It is the honest place for "this person has
-- left" to live when the screens that offer it land, and it is here rather than
-- later so the column exists before anything is written against it.
-- ---------------------------------------------------------------------------

alter table public.requesters
  add column if not exists archived_at timestamptz;

comment on column public.requesters.archived_at is
  'When this person left the school, if they have. NULL for everybody currently here. Students also carry student_status, which says graduated or other; this is the one column that means the same thing for staff.';

-- ---------------------------------------------------------------------------
-- Shared helper: the optimistic-lock check, in one place so the two movement
-- RPCs cannot word it differently. Not granted to any client role.
-- ---------------------------------------------------------------------------

create function public.app_require_inventory_version(
  p_device public.inventory_devices,
  p_version integer
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_version is not null and p_version is distinct from p_device.version then
    raise exception 'This device changed since you opened it. Reload it before saving.'
      using errcode = 'serialization_failure';
  end if;
end;
$$;

revoke execute on function
  public.app_require_inventory_version(public.inventory_devices, integer)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Assign
-- ---------------------------------------------------------------------------

create function public.app_assign_inventory_device(
  p_device uuid,
  p_requester uuid,
  p_note text default null,
  p_version integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_before public.inventory_devices;
  v_after public.inventory_devices;
  v_requester public.requesters;
  v_previous public.requesters;
  v_label text;
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
begin
  v_actor := public.app_require_actor();

  if p_device is null or p_requester is null then
    raise exception 'Choose a machine and the person taking it.' using errcode = 'check_violation';
  end if;
  if v_note is not null and pg_catalog.length(v_note) > 500 then
    raise exception 'Keep the note under 500 characters.' using errcode = 'check_violation';
  end if;

  select * into v_before from public.inventory_devices d where d.id = p_device for update;
  if not found then
    raise exception 'That device is not in the inventory. Search for it again.'
      using errcode = 'no_data_found';
  end if;
  perform public.app_require_inventory_version(v_before, p_version);

  select * into v_requester from public.requesters r
  where r.id = p_requester and r.kind in ('staff', 'student');
  if not found then
    raise exception 'That person is not in the directory. Search for them again.'
      using errcode = 'no_data_found';
  end if;

  if v_before.assigned_requester_id = p_requester then
    raise exception 'That device is already assigned to %.', v_requester.display_name
      using errcode = 'check_violation';
  end if;

  update public.inventory_devices d
  set assigned_requester_id = p_requester,
      -- The status the owner's own vocabulary uses for a machine somebody has.
      -- app_inventory_statuses() seeds it, so it is already on the list the
      -- inventory screen offers.
      status = 'Assigned'
  where d.id = p_device
  returning * into v_after;

  v_label := public.app_device_label(v_after);

  -- The owner's audit row, in the shape every other inventory write uses.
  insert into public.inventory_events (entity, entity_id, actor_id, before_record, after_record)
  values ('device', p_device, v_actor.id,
          pg_catalog.to_jsonb(v_before), pg_catalog.to_jsonb(v_after));

  -- Whoever had it before is told, on their own record, that they no longer do.
  if v_before.assigned_requester_id is not null then
    select * into v_previous from public.requesters r where r.id = v_before.assigned_requester_id;
    perform public.app_log_record_event(
      'requester', v_before.assigned_requester_id, 'device_returned', v_actor.id,
      'Device ' || v_label || ' reassigned to ' || v_requester.display_name || '.'
    );
  end if;

  perform public.app_log_record_event(
    'inventory_device', p_device, 'assigned', v_actor.id,
    v_actor.display_name || ' assigned ' || v_label || ' to ' || v_requester.display_name,
    v_note
  );
  perform public.app_log_record_event(
    'requester', p_requester, 'device_assigned', v_actor.id,
    'Assigned device ' || v_label || '.',
    v_note
  );

  return p_device;
end;
$$;

comment on function public.app_assign_inventory_device(uuid, uuid, text, integer) is
  'Hands one inventory machine to one staff or student record, sets its status to Assigned, and writes the movement to inventory_events and to both record histories. Pass the version read from the device to be told when somebody else changed it first.';

-- ---------------------------------------------------------------------------
-- Return
-- ---------------------------------------------------------------------------

create function public.app_return_inventory_device(
  p_device uuid,
  p_status text default 'Available',
  p_note text default null,
  p_version integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_before public.inventory_devices;
  v_after public.inventory_devices;
  v_holder public.requesters;
  v_label text;
  v_status text := nullif(pg_catalog.btrim(coalesce(p_status, '')), '');
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
begin
  v_actor := public.app_require_actor();

  if p_device is null then
    raise exception 'Choose a machine to take back.' using errcode = 'check_violation';
  end if;
  v_status := coalesce(v_status, 'Available');
  if pg_catalog.length(v_status) > 120 then
    raise exception 'Keep the status under 120 characters.' using errcode = 'check_violation';
  end if;
  if v_note is not null and pg_catalog.length(v_note) > 500 then
    raise exception 'Keep the note under 500 characters.' using errcode = 'check_violation';
  end if;

  select * into v_before from public.inventory_devices d where d.id = p_device for update;
  if not found then
    raise exception 'That device is not in the inventory. Search for it again.'
      using errcode = 'no_data_found';
  end if;
  perform public.app_require_inventory_version(v_before, p_version);

  if v_before.assigned_requester_id is null then
    raise exception 'That device is not assigned to anybody.' using errcode = 'check_violation';
  end if;
  select * into v_holder from public.requesters r where r.id = v_before.assigned_requester_id;

  update public.inventory_devices d
  set assigned_requester_id = null,
      status = v_status
  where d.id = p_device
  returning * into v_after;

  v_label := public.app_device_label(v_after);

  insert into public.inventory_events (entity, entity_id, actor_id, before_record, after_record)
  values ('device', p_device, v_actor.id,
          pg_catalog.to_jsonb(v_before), pg_catalog.to_jsonb(v_after));

  perform public.app_log_record_event(
    'inventory_device', p_device, 'returned', v_actor.id,
    v_actor.display_name || ' took ' || v_label || ' back from '
      || coalesce(v_holder.display_name, 'a former holder'),
    pg_catalog.concat_ws(' ', 'Status set to ' || v_status || '.', v_note)
  );
  perform public.app_log_record_event(
    'requester', v_before.assigned_requester_id, 'device_returned', v_actor.id,
    'Returned device ' || v_label || '.',
    v_note
  );

  return p_device;
end;
$$;

comment on function public.app_return_inventory_device(uuid, text, text, integer) is
  'Takes one inventory machine back from whoever holds it and records what state it came back in. p_status defaults to Available, which is the owner''s own word for a machine on the shelf. Writes the movement to inventory_events and to both record histories.';

-- ---------------------------------------------------------------------------
-- Bulk restatus and move
--
-- Three fields only. Status, location and notes are the ones a trayful of
-- machines genuinely share; a serial, an asset tag or an assignee is per
-- machine, and a bulk edit of one of those is a mistake with a hundred rows in
-- it. Assignment is deliberately not here either: it belongs to
-- app_assign_inventory_device, one machine and one person at a time, so that
-- every loan has its own note and its own history.
-- ---------------------------------------------------------------------------

create function public.app_bulk_update_inventory(p_ids uuid[], p_patch jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ids uuid[] := coalesce(p_ids, '{}'::uuid[]);
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_key text;
  v_status text;
  v_location text;
  v_notes text;
  v_has_status boolean := v_patch ? 'status';
  v_has_location boolean := v_patch ? 'location';
  v_has_notes boolean := v_patch ? 'notes';
  v_before public.inventory_devices;
  v_after public.inventory_devices;
  v_id uuid;
  v_done integer := 0;
  v_summary text;
begin
  v_actor := public.app_require_actor();
  -- Administrators and NetRiders. A role that only works the directory has no
  -- business restatusing a hundred machines in one call.
  if v_actor.role not in ('admin', 'technician') then
    raise exception 'Only administrators and NetRiders can update the inventory in bulk.'
      using errcode = 'insufficient_privilege';
  end if;

  if pg_catalog.array_length(v_ids, 1) is null then
    raise exception 'Choose the machines to update.' using errcode = 'check_violation';
  end if;
  if pg_catalog.array_length(v_ids, 1) > 200 then
    raise exception 'Update at most 200 machines at once.' using errcode = 'check_violation';
  end if;
  if pg_catalog.jsonb_typeof(v_patch) <> 'object' then
    raise exception 'Send the changes as an object.' using errcode = 'check_violation';
  end if;

  -- Named rather than filtered: a key this function does not understand is a
  -- caller that is wrong, and ignoring it would report a change that never
  -- happened.
  for v_key in select pg_catalog.jsonb_object_keys(v_patch) loop
    if v_key not in ('status', 'location', 'notes') then
      raise exception 'A bulk update can change the status, location or notes only.'
        using errcode = 'check_violation';
    end if;
  end loop;
  if not (v_has_status or v_has_location or v_has_notes) then
    raise exception 'Choose what to change.' using errcode = 'check_violation';
  end if;

  v_status := nullif(pg_catalog.btrim(coalesce(v_patch ->> 'status', '')), '');
  v_location := nullif(pg_catalog.btrim(coalesce(v_patch ->> 'location', '')), '');
  v_notes := nullif(pg_catalog.btrim(coalesce(v_patch ->> 'notes', '')), '');

  if v_has_status and v_status is null then
    raise exception 'Choose a status.' using errcode = 'check_violation';
  end if;
  if v_has_status and pg_catalog.length(v_status) > 120 then
    raise exception 'Keep the status under 120 characters.' using errcode = 'check_violation';
  end if;
  if v_has_location and v_location is not null and pg_catalog.length(v_location) > 120 then
    raise exception 'Keep the location under 120 characters.' using errcode = 'check_violation';
  end if;
  if v_has_notes and v_notes is not null and pg_catalog.length(v_notes) > 6000 then
    raise exception 'Keep the notes under 6000 characters.' using errcode = 'check_violation';
  end if;

  v_summary := pg_catalog.concat_ws(
    ', ',
    case when v_has_status then 'status to ' || v_status end,
    case when v_has_location then coalesce('location to ' || v_location, 'location cleared') end,
    case when v_has_notes then coalesce('notes rewritten', 'notes cleared') end
  );

  -- Ordered by id so two callers updating overlapping trays take their row
  -- locks in the same order and cannot deadlock against each other.
  foreach v_id in array (select array(select unnest(v_ids) order by 1)) loop
    select * into v_before from public.inventory_devices d where d.id = v_id for update;
    continue when not found;

    update public.inventory_devices d
    set status = case when v_has_status then v_status else d.status end,
        location = case when v_has_location then v_location else d.location end,
        notes = case when v_has_notes then v_notes else d.notes end
    where d.id = v_id
    returning * into v_after;

    insert into public.inventory_events (entity, entity_id, actor_id, before_record, after_record)
    values ('device', v_id, v_actor.id,
            pg_catalog.to_jsonb(v_before), pg_catalog.to_jsonb(v_after));

    perform public.app_log_record_event(
      'inventory_device', v_id, 'bulk_updated', v_actor.id,
      v_actor.display_name || ' updated ' || public.app_device_label(v_after) || ' in bulk',
      'Changed ' || v_summary || '.'
    );
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

comment on function public.app_bulk_update_inventory(uuid[], jsonb) is
  'Changes the status, location or notes of up to 200 inventory machines in one transaction, for an administrator or a NetRider. Returns how many rows were actually changed: an id that names no machine is skipped rather than failing the batch. Every machine gets its own inventory_events snapshot and its own record event.';

-- ---------------------------------------------------------------------------
-- The machines one person holds
-- ---------------------------------------------------------------------------

create function public.app_requester_devices(p_requester uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select pg_catalog.jsonb_agg(
      public.app_inventory_device_json(d)
      order by d.device_type, d.model, d.id
    )
    from public.inventory_devices d
    where d.assigned_requester_id = p_requester
      and public.app_active_account_id() is not null
  ), '[]'::jsonb);
$$;

comment on function public.app_requester_devices(uuid) is
  'Every inventory machine assigned to one person, in the same JSON shape app_get_inventory_device returns. SECURITY DEFINER, gated on an active account, because inventory_devices has row-level security and no policies.';

-- ---------------------------------------------------------------------------
-- Scanner lookup
--
-- One code, one machine. Exact matches only, folded for case, across the three
-- things printed on a machine: the inventory id, the asset tag and the serial.
-- A fuzzy match belongs in app_search, where a person chooses from a list; a
-- scanner has nobody to ask, so an ambiguous code returns nothing rather than
-- guessing which of two machines the operator is holding.
-- ---------------------------------------------------------------------------

create function public.app_lookup_inventory_code(p_code text)
returns table (id uuid, label text)
language sql
stable
security definer
set search_path = ''
as $$
  with code as (
    select pg_catalog.upper(nullif(pg_catalog.btrim(coalesce(p_code, '')), '')) as folded
  ),
  matched as (
    select d.id, public.app_device_label(d) as label
    from public.inventory_devices d, code c
    where c.folded is not null
      and public.app_active_account_id() is not null
      and (
        pg_catalog.upper(d.external_id) = c.folded
        or pg_catalog.upper(d.asset_tag) = c.folded
        or pg_catalog.upper(d.serial_number) = c.folded
      )
    limit 2
  )
  select m.id, m.label from matched m
  where (select pg_catalog.count(*) from matched) = 1;
$$;

comment on function public.app_lookup_inventory_code(text) is
  'One machine by the code printed on it: inventory id, asset tag or serial number, matched exactly and folded for case. Returns nothing for a code that names no machine, and nothing for one that names two.';

-- ---------------------------------------------------------------------------
-- Grants. Signed-in accounts only; anon gets nothing. The gate inside each
-- function is the real one, and this is the door.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_assign_inventory_device(uuid, uuid, text, integer),
  public.app_return_inventory_device(uuid, text, text, integer),
  public.app_bulk_update_inventory(uuid[], jsonb),
  public.app_requester_devices(uuid),
  public.app_lookup_inventory_code(text)
from public, anon;

grant execute on function
  public.app_assign_inventory_device(uuid, uuid, text, integer),
  public.app_return_inventory_device(uuid, text, text, integer),
  public.app_bulk_update_inventory(uuid[], jsonb),
  public.app_requester_devices(uuid),
  public.app_lookup_inventory_code(text)
to authenticated;
