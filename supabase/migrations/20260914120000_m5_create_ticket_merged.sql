-- ---------------------------------------------------------------------------
-- One app_create_ticket for both intake models.
--
-- The owner's `20260912220000_directory_inventory.sql` replaced
-- app_create_ticket with a FIFTEEN-argument signature; `20260912100350` (M5)
-- had already replaced it with an EIGHTEEN-argument one. Both survive on a
-- merged database, and PostgREST cannot choose between them: a call that names
-- only the fifteen shared parameters matches the M5 function too, because its
-- three extra parameters all have defaults. That is an "ambiguous function"
-- error at intake, not a preference.
--
-- So both signatures are dropped and ONE function is created with the union of
-- the two parameter lists. The union happens to equal the M5 list: the owner's
-- fifteen are its first fifteen, in the same order, and p_category,
-- p_person_id and p_device_ids follow.
--
-- Where the two bodies disagreed, the resolution is:
--
--   * Their `p_devices` bounds (an array, at most 50) -- ADOPTED. Purely a
--     bound; nothing that used to succeed stops succeeding.
--   * Their empty-issue allowance and 6000-character cap -- ADOPTED. Their
--     migration dropped `tickets_issue_present`, so the column permits it, and
--     a walk-in recorded at the desk genuinely has no notes yet.
--   * Their `inventoryDeviceId` snapshot, `manufacturer` column and
--     device_catalog check -- ADOPTED, but scoped: an entry that NAMES a
--     manufacturer is claiming to be a catalogued machine and is held to the
--     catalogue's standard (type, manufacturer, model and serial, all matching
--     a device_catalog row); an entry that names none is a free-text
--     observation of something the inventory does not hold, which is what the
--     M5 intake page records. This is the one rule where the two models can
--     coexist without either page losing a field.
--   * Their "one requester option only" check -- ADOPTED.
--   * M5's category, p_person_id directory lookup, p_device_ids inventory
--     links, attribution stamps (performed_via / ai_model) and event wording
--     -- KEPT. These are the M5 intake page, which this merge keeps.
--
-- MERGE-TODO: two of their rules are NOT adopted, because adopting them would
-- break fields the M5 intake page still shows and the merge brief says to keep
-- that page:
--
--   1. They refuse `p_requester_name` outright ("Select an existing requester
--      or Requester Unknown"), so that nothing can add a row to `requesters`
--      that has no external id from the source sheets. The M5 page's "someone
--      new" requester mode does exactly that, and so does its p_person_id
--      path. Their `tests/db/intake.test.ts` test "rejects an inline requester
--      name instead of creating a record" therefore FAILS against this
--      function. The rewire task that retires the M5 people/devices model
--      should adopt their rule and delete the M5 mode with it.
--   2. They refuse `p_is_remote` ("Use the location field for intake"),
--      because their intake is physical. The M5 page has a "no physical
--      location" toggle. Their test "rejects remote intake and requires the
--      location field instead" therefore FAILS. Same rewire task.
--
-- Additive: no table changes, no data changes.
-- ---------------------------------------------------------------------------

drop function public.app_create_ticket(
  text, text, text, text, date, uuid, text, text, text, boolean, text, boolean,
  uuid, uuid[], jsonb, text, uuid, uuid[]
);

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
  p_person_id uuid default null,
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
  v_person public.people;
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

  -- Requester: explicitly unknown, somebody in the directory, an existing
  -- requester record, or a new minimal record typed in by hand.
  if coalesce(p_requester_unknown, false) then
    -- Their check: "unknown" and a named requester in the same call is a caller
    -- that has not decided, not a request to prefer one of them.
    if p_requester_id is not null or p_person_id is not null then
      raise exception 'Choose one requester option.' using errcode = 'check_violation';
    end if;
    v_requester := null;
  elsif p_person_id is not null then
    -- SECURITY DEFINER, so this read is not under RLS. app_require_actor above
    -- has already established an active account, and an active account may read
    -- every person anyway.
    select * into v_person from public.people p where p.id = p_person_id;
    if not found then
      raise exception 'That person is not in the directory. Search for them again.'
        using errcode = 'no_data_found';
    end if;

    -- One requester row per person: found, or made once and reused forever --
    -- in ONE statement, so two technicians recording a walk-in for the same
    -- student at the same moment both succeed. The `do update` is a no-op that
    -- exists so RETURNING yields the existing row's id; `do nothing` would
    -- return no row at all. Nothing else on the existing requester is
    -- overwritten: that row is the authoritative one.
    insert into public.requesters (display_name, kind, descriptor, created_by, person_id)
    values (
      v_person.display_name,
      v_person.kind,
      nullif(btrim(coalesce(v_person.department, v_person.official_class, '')), ''),
      v_actor.id,
      p_person_id
    )
    on conflict (person_id) where person_id is not null
      do update set person_id = excluded.person_id
    returning id into v_requester;
  elsif v_requester is not null then
    if not exists (select 1 from public.requesters r where r.id = v_requester) then
      raise exception 'That requester record no longer exists.' using errcode = 'check_violation';
    end if;
  elsif length(btrim(coalesce(p_requester_name, ''))) > 0 then
    insert into public.requesters (display_name, kind, descriptor, created_by)
    values (
      btrim(p_requester_name),
      coalesce(nullif(btrim(coalesce(p_requester_kind, '')), ''), 'staff'),
      nullif(btrim(coalesce(p_requester_descriptor, '')), ''),
      v_actor.id
    )
    returning id into v_requester;
  else
    raise exception 'Select an existing requester, name one, or mark the requester as unknown.'
      using errcode = 'check_violation';
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

comment on function public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[]) is
  'Records one request, for both intake models. p_requester_id names a row in the owner''s directory; p_person_id names somebody in the M5 people table and finds or creates their single requester row in one statement, so two concurrent intakes for the same person both succeed. A device entry carrying inventoryDeviceId is snapshotted from inventory_devices; one carrying a manufacturer must match a device_catalog row and carry a serial; one carrying neither is a free-text observation. p_device_ids links M5 inventory machines. Rejects a forged channel, owner, date or category rather than correcting it.';

-- The drops above took the old ACLs with them, so the grants are made again
-- rather than merely restated.
revoke execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[])
from public, anon;

grant execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[])
to authenticated;
