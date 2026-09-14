-- ---------------------------------------------------------------------------
-- One app_create_ticket, on the district's own directory and inventory.
--
-- Two branches each replaced app_create_ticket and Postgres tells overloads
-- apart by their type signature, so both survived a merge and PostgREST could
-- not choose between them. This file is the reconciliation: the earlier M5
-- signature is no longer created at all (see 20260914100350), the owner's
-- fifteen-argument one is dropped here, and ONE function is created with the
-- union of the two parameter lists — their fifteen, in order, then
-- p_category and p_device_ids.
--
-- Where the two bodies disagreed, the resolution is:
--
--   * Their `p_devices` bounds (an array, at most 50) — ADOPTED.
--   * Their empty-notes allowance and 6000-character cap — ADOPTED. Their
--     migration dropped `tickets_issue_present`, so the column permits it, and
--     a walk-in recorded at the desk genuinely has no notes yet.
--   * Their `inventoryDeviceId` snapshot, `manufacturer` column and
--     device_catalog check — ADOPTED, but scoped: an entry that NAMES a
--     manufacturer is claiming to be a catalogued machine and is held to the
--     catalogue's standard (type, manufacturer, model and serial, all matching
--     a device_catalog row); an entry that names none is a free-text
--     observation of something the inventory does not hold — a projector in
--     a room, a cable, somebody's own laptop.
--   * Their requester rules — ADOPTED IN FULL, which is the change this
--     milestone makes. `public.requesters` is the district's real directory of
--     3,448 students and 261 staff, so a ticket names somebody who is already
--     in it, or says plainly that the requester is unknown. A free-text
--     `p_requester_name` is refused rather than quietly adding a row with no
--     source identifier beside 3,709 rows that have one, and `p_is_remote` is
--     refused because intake here is physical and the location field is where
--     a room goes. Both parameters stay in the signature so that a caller that
--     still sends them is TOLD, rather than having its value ignored.
--   * M5's category, its p_device_ids inventory links, its attribution stamps
--     (performed_via / ai_model) and its event wording — KEPT.
--
-- Gone with the M5 people table: `p_person_id`. A requester row was once a
-- shadow of a `public.people` row and had to be found or created for it; now
-- `public.requesters` IS the directory, and a ticket points at it directly.
--
-- Additive: no table changes, no data changes.
-- ---------------------------------------------------------------------------

drop function public.app_create_ticket(
  text, text, text, text, date, uuid, text, text, text, boolean, text, boolean,
  uuid, uuid[], jsonb
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
  p_device_ids uuid[] default '{}'
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
  v_submitted date := coalesce(p_submitted_on, public.app_today());
  v_category text := coalesce(nullif(pg_catalog.btrim(coalesce(p_category, '')), ''), 'other');
  v_ticket public.tickets;
  v_ticket_id uuid;
  v_collaborator uuid;
  v_collab_name text;
  v_devices jsonb := coalesce(p_devices, '[]'::jsonb);
  v_device jsonb;
  v_device_type text;
  v_manufacturer text;
  v_model text;
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
  -- Their rule: notes may be empty (a walk-in recorded at the desk often has
  -- none yet) but not unbounded.
  if length(coalesce(p_issue, '')) > 6000 then
    raise exception 'Keep notes under 6000 characters.' using errcode = 'check_violation';
  end if;
  -- Their rule, adopted: the directory is the district's, and a requester is
  -- somebody already in it. Typing a name here would make a row with no source
  -- identifier beside 3,709 rows that have one.
  if length(btrim(coalesce(p_requester_name, ''))) > 0 then
    raise exception 'Select an existing requester or Requester Unknown.' using errcode = 'check_violation';
  end if;
  -- Their rule, adopted: intake here is physical, and a room goes in location.
  if coalesce(p_is_remote, false) then
    raise exception 'Use the location field for intake.' using errcode = 'check_violation';
  end if;
  -- Their bound, checked before any row is written so an oversized list costs
  -- one message rather than a long transaction.
  if pg_catalog.jsonb_typeof(v_devices) <> 'array' then
    raise exception 'Send the devices as a list.' using errcode = 'check_violation';
  end if;
  if pg_catalog.jsonb_array_length(v_devices) > 50 then
    raise exception 'Record at most 50 devices on one ticket.' using errcode = 'check_violation';
  end if;
  if v_submitted > public.app_today() then
    raise exception 'The submission date cannot be in the future.' using errcode = 'check_violation';
  end if;
  -- Refused rather than folded to 'other'. A category the database does not
  -- know is a caller that is wrong, and filing the ticket anyway would put it
  -- where nobody is looking for it.
  if not (public.app_category_labels() ? v_category) then
    raise exception 'Choose a category for this ticket.' using errcode = 'check_violation';
  end if;

  -- Technician intake is walk-in, self-owned and dated today. A forged channel,
  -- owner or date is REJECTED rather than silently corrected.
  if not v_admin then
    if v_channel is distinct from 'walk_in' then
      raise exception 'Technicians can only record walk-in tickets.' using errcode = 'insufficient_privilege';
    end if;
    if v_owner is not null and v_owner <> v_actor.id then
      raise exception 'Technicians must assign their walk-in tickets to themselves.'
        using errcode = 'insufficient_privilege';
    end if;
    if v_submitted <> public.app_today() then
      raise exception 'Technicians cannot backdate a walk-in ticket.' using errcode = 'insufficient_privilege';
    end if;
    v_owner := v_actor.id;
  end if;

  if v_owner is not null and not exists (
    select 1 from public.app_accounts a where a.id = v_owner and a.status = 'active'
  ) then
    raise exception 'Choose an active technician as the owner.' using errcode = 'check_violation';
  end if;

  -- Requester: explicitly unknown, or a staff or student row that already
  -- exists in the district's directory. Nothing else.
  if coalesce(p_requester_unknown, false) then
    -- Their check: "unknown" and a named requester in the same call is a caller
    -- that has not decided, not a request to prefer one of them.
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
    channel, priority, status, submitted_on, created_by, owner_id, assigned_at,
    category
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
    case when v_owner is null then 'open' else 'assigned' end,
    v_submitted,
    v_actor.id,
    v_owner,
    case when v_owner is null then null else now() end,
    v_category
  )
  returning * into v_ticket;
  v_ticket_id := v_ticket.id;

  perform public.app_log_event(
    v_ticket_id, 'created', v_actor.id,
    v_actor.display_name || ' recorded '
      || case v_channel when 'email' then 'an ' else 'a ' end
      || case v_channel when 'walk_in' then 'walk-in' when 'email' then 'email' else 'phone call' end
      || ' request',
    case when v_submitted <> public.app_today()
      then 'Submission date backdated to ' || v_submitted::text || '.'
      else null end
  );

  if v_owner is not null then
    perform public.app_log_event(
      v_ticket_id, 'assigned', v_actor.id,
      case when v_owner = v_actor.id
        then v_actor.display_name || ' took ownership at intake'
        else v_actor.display_name || ' assigned the ticket to '
             || (select a.display_name from public.app_accounts a where a.id = v_owner)
      end
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
      -- Their rule: a machine named from the inventory is READ from the
      -- inventory. Whatever the browser sent alongside the id is discarded, so
      -- a forged serial cannot be written against a real asset.
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
    v_model := nullif(btrim(coalesce(v_device ->> 'model', '')), '');
    v_serial := nullif(btrim(coalesce(v_device ->> 'serialNumber', '')), '');

    -- Naming a manufacturer is the claim that this is a machine the inventory
    -- knows, so it is held to the inventory's standard. An entry with no
    -- manufacturer is a free-text observation of something the inventory does
    -- not hold -- a projector in a room, a cable, somebody's own laptop -- and
    -- only needs a type.
    if v_manufacturer is not null then
      if v_model is null or v_serial is null then
        raise exception 'Each device requires a device type, manufacturer, model and serial number.'
          using errcode = 'check_violation';
      end if;
      if not exists (
        select 1 from public.device_catalog c
        where c.device_type = v_device_type
          and c.manufacturer = v_manufacturer
          and c.model = v_model
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
      v_model,
      nullif(btrim(coalesce(v_device ->> 'osVersion', '')), ''),
      v_serial,
      nullif(btrim(coalesce(v_device ->> 'assetTag', '')), ''),
      coalesce((v_device ->> 'identifiersNotApplicable')::boolean, false),
      v_actor.id,
      public.app_request_via(), public.app_request_ai_model()
    );
    perform public.app_log_event(
      v_ticket_id, 'device_recorded', v_actor.id,
      v_actor.display_name || ' recorded a device: ' || v_device_type
    );
  end loop;

  -- Inventory links named at intake. A repeated id is skipped rather than
  -- failing the whole ticket: a form that sent the same machine twice is not a
  -- reason to lose the request.
  foreach v_device_id in array coalesce(p_device_ids, '{}') loop
    continue when v_device_id is null or v_device_id = any (v_linked);
    perform public.app_link_device(v_ticket, v_device_id, v_actor);
    v_linked := v_linked || v_device_id;
  end loop;

  return v_ticket_id;
end;
$$;

comment on function public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid[]) is
  'Records one request. p_requester_id names a staff or student row in the district directory, or p_requester_unknown says there is nobody to name; a free-text requester name and remote intake are both refused. A device entry carrying inventoryDeviceId is snapshotted from inventory_devices; one carrying a manufacturer must match a device_catalog row and carry a serial; one carrying neither is a free-text observation. p_device_ids links inventory machines to the ticket. Rejects a forged channel, owner, date or category rather than correcting it.';

-- The drops above took the old ACLs with them, so the grants are made again
-- rather than merely restated.
revoke execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid[])
from public, anon;

grant execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid[])
to authenticated;
