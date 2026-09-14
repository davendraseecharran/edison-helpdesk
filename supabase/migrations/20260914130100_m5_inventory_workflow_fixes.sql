-- M5 inventory workflow, fix round 1.
--
-- 20260914130000 wrote the four movements a help desk performs on the owner's
-- tables. The review of that file found four things wrong with them, and they
-- all have the same root: the guards were written against `app_accounts.role`,
-- the DERIVED column, at a moment when the roles had already become a set.
--
--   1. `role not in ('admin','technician')` is not "admin or NetRider".
--      `app_derive_role_from_roles` (20260914140000) writes `role = 'technician'`
--      for every account that is not an administrator, a skills officer
--      included, so a pure skills officer passed that gate and could restatus,
--      move or rewrite the notes of two hundred machines in one call. The gate
--      is now the same two `app_has_role` calls `app_save_inventory_device`
--      uses, and it says the same sentence.
--
--   2. `app_assign_inventory_device` and `app_return_inventory_device` asked
--      only for an active account. Handing a machine out and taking it back are
--      inventory writes; somebody refused the inventory editor must not reach
--      them through the movement RPCs instead. Both now carry the same guard.
--
--   3. `app_requester_devices` had no ceiling, where the owner's
--      `app_assigned_devices` caps at 100. A person page is not a place to
--      render an unbounded list, so it caps at 200.
--
--   4. The device-side sentence for a ticket link carried the ticket's number,
--      and `record_events` for an `inventory_device` is readable by every
--      active account (20260914100000:368). A skills officer refused every
--      ticket could still read ticket numbers off a device page. The number is
--      dropped; the link is still recorded, and the ticket's own history still
--      names both sides for the people who may read it.
--
-- Two smaller ones from the same review: the bulk summary said "notes
-- rewritten" when a bulk edit CLEARED the notes, because `coalesce` was given a
-- constant first argument; and `v_previous` was declared and selected into and
-- never read. Both are fixed below.
--
-- Additive. No table changes, no data changes, no policy changes. Every
-- function is restated verbatim from the file that last defined it apart from
-- the lines this header names, and the grants are restated after each one.

-- ---------------------------------------------------------------------------
-- Assign. Body from 20260914130000, with the role guard added and the unread
-- v_previous removed.
-- ---------------------------------------------------------------------------

create or replace function public.app_assign_inventory_device(
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
  v_label text;
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
begin
  v_actor := public.app_require_actor();
  if not (public.app_has_role('admin') or public.app_has_role('netrider')) then
    raise exception 'Only a NetRider or an administrator can change inventory.'
      using errcode = 'insufficient_privilege';
  end if;

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
  'Hands one inventory machine to one staff or student record, sets its status to Assigned, and writes the movement to inventory_events and to both record histories. For a NetRider or an administrator only. Pass the version read from the device to be told when somebody else changed it first.';

-- ---------------------------------------------------------------------------
-- Return. Body from 20260914130000, with the role guard added.
-- ---------------------------------------------------------------------------

create or replace function public.app_return_inventory_device(
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
  if not (public.app_has_role('admin') or public.app_has_role('netrider')) then
    raise exception 'Only a NetRider or an administrator can change inventory.'
      using errcode = 'insufficient_privilege';
  end if;

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
  'Takes one inventory machine back from whoever holds it and records what state it came back in. For a NetRider or an administrator only. p_status defaults to Available, which is the owner''s own word for a machine on the shelf. Writes the movement to inventory_events and to both record histories.';

-- ---------------------------------------------------------------------------
-- Bulk restatus and move. Body from 20260914130000, with the derived-column
-- gate replaced by the role gate and the notes summary made a `case`.
-- ---------------------------------------------------------------------------

create or replace function public.app_bulk_update_inventory(p_ids uuid[], p_patch jsonb)
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
  -- Administrators and NetRiders, asked of the role SET. `role` is derived and
  -- says 'technician' for a skills officer too, so testing it here let an
  -- account that may not edit one machine restatus two hundred.
  if not (public.app_has_role('admin') or public.app_has_role('netrider')) then
    raise exception 'Only a NetRider or an administrator can change inventory.'
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

  -- A `case` rather than a coalesce: 'notes rewritten' is a constant, so
  -- coalescing it with 'notes cleared' could only ever say the first, and a
  -- bulk edit that emptied the notes reported the opposite of what it did.
  v_summary := pg_catalog.concat_ws(
    ', ',
    case when v_has_status then 'status to ' || v_status end,
    case when v_has_location then coalesce('location to ' || v_location, 'location cleared') end,
    case when v_has_notes then
      case when v_notes is null then 'notes cleared' else 'notes rewritten' end
    end
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
-- The machines one person holds. Body from 20260914130000, with the ceiling
-- the owner's app_assigned_devices already has.
-- ---------------------------------------------------------------------------

create or replace function public.app_requester_devices(p_requester uuid)
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
    -- The ceiling is applied by choosing the ids first, then aggregating the
    -- table rows themselves: app_inventory_device_json takes a
    -- public.inventory_devices, and a whole-row reference to a subquery would
    -- be an anonymous record no overload accepts.
    from public.inventory_devices d
    where d.assigned_requester_id = p_requester
      and public.app_active_account_id() is not null
      and d.id in (
        select i.id
        from public.inventory_devices i
        where i.assigned_requester_id = p_requester
        order by i.device_type, i.model, i.id
        limit 200
      )
  ), '[]'::jsonb);
$$;

comment on function public.app_requester_devices(uuid) is
  'Every inventory machine assigned to one person, up to 200, in the same JSON shape app_get_inventory_device returns. SECURITY DEFINER, gated on an active account, because inventory_devices has row-level security and no policies.';

revoke execute on function
  public.app_assign_inventory_device(uuid, uuid, text, integer),
  public.app_return_inventory_device(uuid, text, text, integer),
  public.app_bulk_update_inventory(uuid[], jsonb),
  public.app_requester_devices(uuid)
from public, anon;

grant execute on function
  public.app_assign_inventory_device(uuid, uuid, text, integer),
  public.app_return_inventory_device(uuid, text, text, integer),
  public.app_bulk_update_inventory(uuid[], jsonb),
  public.app_requester_devices(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- The device-side sentence for a ticket link.
--
-- Body from 20260914100350, with the ticket number taken out of the summary
-- written to the MACHINE's history. That history is readable by every active
-- account; ticket history is not. The number stays on the ticket's own event,
-- where only the people who may read the ticket can see it.
-- ---------------------------------------------------------------------------

create or replace function public.app_link_device(
  p_ticket public.tickets,
  p_device uuid,
  p_actor public.app_accounts
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.inventory_devices;
  v_label text;
begin
  if p_device is null then
    raise exception 'Choose a device from the inventory.' using errcode = 'check_violation';
  end if;

  -- SECURITY DEFINER, so this read is not under RLS. That is how the whole
  -- inventory is read: public.inventory_devices carries RLS with no policies,
  -- and the caller has already established an active account, which is what
  -- app_list_inventory asks for before showing the same row.
  select * into v_device from public.inventory_devices d where d.id = p_device;
  if not found then
    raise exception 'That device is not in the inventory. Search for it again.'
      using errcode = 'no_data_found';
  end if;
  v_label := public.app_device_label(v_device);

  if exists (
    select 1 from public.ticket_devices td
    where td.ticket_id = p_ticket.id and td.device_id = p_device
  ) then
    raise exception 'Device % is already linked to this ticket.', v_label
      using errcode = 'check_violation';
  end if;

  insert into public.ticket_devices (ticket_id, device_id, linked_by)
  values (p_ticket.id, p_device, p_actor.id);

  perform public.app_log_event(
    p_ticket.id, 'device_linked', p_actor.id,
    p_actor.display_name || ' linked device ' || v_label
  );
  -- And from the machine's side, so its page shows that it was named on a
  -- ticket without naming WHICH ticket: this row is readable by every active
  -- account, including one that may read no ticket at all.
  perform public.app_log_record_event(
    'inventory_device', p_device, 'ticket_linked', p_actor.id,
    'Linked to a ticket.'
  );
end;
$$;

revoke execute on function
  public.app_link_device(public.tickets, uuid, public.app_accounts)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Backups of the two tables that have no policies.
--
-- The Backups screen reads every table through the administrator's own session
-- client, so row-level security decides what comes back exactly as it does
-- everywhere else. Two of the district's tables cannot be read that way at all:
-- public.inventory_devices (20260912220000) and public.inventory_events
-- (20260913150000) have RLS enabled, no policies, and every privilege revoked
-- from authenticated. Read access to the inventory is by bounded RPC, and a
-- backup is one more bounded read.
--
-- So these two are SECURITY DEFINER with the gate in the body, and the gate is
-- the one the screen already states: an administrator, and nobody else. No
-- policy is added to the owner's tables and no grant on them changes.
--
-- The table name is matched against a fixed list and the matched CONSTANT is
-- what the query names, so no caller's string ever reaches a relation. A name
-- that is not on the list is refused rather than ignored.
-- ---------------------------------------------------------------------------

create function public.app_backup_count(p_table text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_total bigint;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can download a backup.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_table = 'inventory_devices' then
    select pg_catalog.count(*) into v_total from public.inventory_devices;
  elsif p_table = 'inventory_events' then
    select pg_catalog.count(*) into v_total from public.inventory_events;
  else
    raise exception 'That is not a table this screen can export.'
      using errcode = 'check_violation';
  end if;

  return v_total;
end;
$$;

comment on function public.app_backup_count(text) is
  'How many rows one of the two policy-less inventory tables holds, for the Backups screen. Administrators only.';

create function public.app_backup_rows(
  p_table text,
  p_limit integer default 1000,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  -- One PostgREST page is a thousand rows, and this read is paged by the same
  -- ceiling whatever the caller asks for.
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can download a backup.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Newest first with the primary key as the tiebreaker, which is what the
  -- screen asks of every other table, so paging is deterministic and a capped
  -- export keeps the most recent rows rather than an arbitrary thousand.
  if p_table = 'inventory_devices' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) order by d.imported_at desc, d.id desc), '[]'::jsonb)
      into v_rows
    from public.inventory_devices d
    where d.id in (
      select i.id from public.inventory_devices i
      order by i.imported_at desc, i.id desc
      limit v_limit offset v_offset
    );
  elsif p_table = 'inventory_events' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.at desc, e.id desc), '[]'::jsonb)
      into v_rows
    from public.inventory_events e
    where e.id in (
      select v.id from public.inventory_events v
      order by v.at desc, v.id desc
      limit v_limit offset v_offset
    );
  else
    raise exception 'That is not a table this screen can export.'
      using errcode = 'check_violation';
  end if;

  return v_rows;
end;
$$;

comment on function public.app_backup_rows(text, integer, integer) is
  'One page of one of the two policy-less inventory tables, newest first, as a JSON array of whole rows. Administrators only. The Backups screen reads every other table through its own session client; these two have row-level security with no policies, so this is their bounded read.';

revoke execute on function
  public.app_backup_count(text),
  public.app_backup_rows(text, integer, integer)
from public, anon;

grant execute on function
  public.app_backup_count(text),
  public.app_backup_rows(text, integer, integer)
to authenticated;

-- ---------------------------------------------------------------------------
-- An observation can name the machine it was made about.
--
-- public.device_observations has carried inventory_device_id since
-- 20260912220000 and src/lib/data/mapping.ts has mapped it since this
-- milestone, but no writer ever set it: app_record_device took seven arguments
-- and none of them was the inventory id, so a technician who picked the machine
-- out of the inventory and then described what they saw left two rows that
-- never referred to each other.
--
-- The parameter list changes, so the seven-argument signature is dropped first
-- rather than overloaded: PostgREST tells overloads apart by the argument NAMES
-- a call sends, and a call naming only the seven they share would match both.
-- Grants are restated after the create, because a dropped function takes its
-- grants with it.
--
-- Body from 20260914101300_m5_row_attribution.sql, with the new argument, its
-- existence check, and the column it fills. Nothing else changes.
-- ---------------------------------------------------------------------------

drop function if exists public.app_record_device(uuid, text, text, text, text, text, boolean);

create function public.app_record_device(
  p_ticket uuid,
  p_device_type text,
  p_model text default null,
  p_os_version text default null,
  p_serial_number text default null,
  p_asset_tag text default null,
  p_identifiers_not_applicable boolean default false,
  p_inventory_device_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_device_id uuid;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);
  perform public.app_require_contributor(v_ticket, v_actor);

  if pg_catalog.length(pg_catalog.btrim(coalesce(p_device_type, ''))) = 0 then
    raise exception 'Each device entry needs a device type.' using errcode = 'check_violation';
  end if;

  -- An id that names no machine is a caller that is wrong, and storing it would
  -- fail the foreign key with a message nobody can act on.
  if p_inventory_device_id is not null
     and not exists (
       select 1 from public.inventory_devices d where d.id = p_inventory_device_id
     ) then
    raise exception 'That device is not in the inventory. Search for it again.'
      using errcode = 'no_data_found';
  end if;

  -- Unknown serial and asset tag stay null; they never block the record.
  insert into public.device_observations (
    ticket_id, device_type, model, os_version, serial_number, asset_tag,
    identifiers_not_applicable, inventory_device_id, recorded_by,
    performed_via, ai_model
  )
  values (
    v_ticket.id, pg_catalog.btrim(p_device_type),
    nullif(pg_catalog.btrim(coalesce(p_model, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_os_version, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_serial_number, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_asset_tag, '')), ''),
    coalesce(p_identifiers_not_applicable, false),
    p_inventory_device_id,
    v_actor.id,
    public.app_request_via(), public.app_request_ai_model()
  )
  returning id into v_device_id;

  if v_ticket.status = 'assigned' then
    update public.tickets set status = 'in_progress' where id = v_ticket.id;
    perform public.app_log_event(
      v_ticket.id, 'status_changed', v_actor.id, v_actor.display_name || ' started work'
    );
  end if;

  perform public.app_log_event(
    v_ticket.id, 'device_recorded', v_actor.id,
    v_actor.display_name || ' recorded a device: ' || pg_catalog.btrim(p_device_type)
  );

  return v_device_id;
end;
$$;

comment on function public.app_record_device(uuid, text, text, text, text, text, boolean, uuid) is
  'Records what a technician saw about one machine on one ticket. p_inventory_device_id is optional and names the inventory record the observation was made about, when it was chosen from the picker rather than typed; an observation about a machine the district does not own still works without it.';

revoke execute on function
  public.app_record_device(uuid, text, text, text, text, text, boolean, uuid)
from public, anon;

grant execute on function
  public.app_record_device(uuid, text, text, text, text, text, boolean, uuid)
to authenticated;
