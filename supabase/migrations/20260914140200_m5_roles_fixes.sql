-- M5 roles fixes, round 1: one door to a role change, and intake speaks of
-- NetRiders.
--
-- Three follow-ups from the P2-3 review:
--
--   1. `app_admin_set_role(uuid, text)` (20260912100100_m5_account_states_
--      invites.sql:393) survived the move to a role set. It is still granted
--      to authenticated, carries no last-usable-admin guard, and the two-way
--      trigger (`app_derive_role_from_roles`) turns any `role` it writes into
--      a `roles` write too -- a second, weaker door to the same change
--      `app_set_account_roles` already guards properly. Dropped here.
--      `tests/db/m5-invites.test.ts` and `tests/db/m5-audit.test.ts` move to
--      `app_set_account_roles`.
--   2. `app_create_ticket`'s technician-only walk-in guard still spoke of
--      "Technicians"; those four messages move to "NetRiders" with the rest
--      of the person-facing copy. Restated verbatim otherwise, from
--      20260914120000_m5_create_ticket_merged.sql.
--   3. `app_has_role(text)`, added by 20260914140000, was granted and never
--      called -- a door left unlocked and unused. It is wired into the three
--      guards that test the CALLER's own roles, always reached only through
--      `app_require_actor()` reading `auth.uid()` into the variable the guard
--      then tests, in place of the inline `roles && array[...]` test:
--      `app_insights`, `app_save_inventory_device` and `app_claim_ticket`
--      (20260914140100_m5_roles_ticket_targets.sql).
--
--      `app_lock_ticket(p_ticket, p_actor)` looked like a fourth: every
--      SESSION-based caller passes it `v_actor` from its own
--      `app_require_actor()`, so `p_actor.id = auth.uid()` there too. But
--      `app_trusted_register_attachment` and its kin (20260912100810,
--      20260912101300) build `v_actor` from an explicit `p_actor uuid`
--      parameter instead -- a service-role path with no session and no
--      `auth.uid()` at all -- and call `app_lock_ticket` with THAT row.
--      `app_has_role` would ask about `auth.uid()` regardless, find no row,
--      and refuse every trusted attachment. Caught by this migration's own
--      `npm run test:db` (m5-row-attribution.test.ts). `app_lock_ticket` keeps
--      its inline form, for the same reason `app_reassign_ticket` and
--      `app_add_collaborator` keep theirs: the row under test is not
--      guaranteed to be the caller, and `app_has_role` only ever asks about
--      `auth.uid()`.
--
-- Additive: no table changes, no data changes.
-- ---------------------------------------------------------------------------

drop function public.app_admin_set_role(uuid, text);

-- ---------------------------------------------------------------------------
-- app_create_ticket, restated verbatim from 20260914120000 except the four
-- messages a walk-in submitter or an administrator choosing an owner can
-- actually read.
-- ---------------------------------------------------------------------------

create or replace function public.app_create_ticket(
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
      raise exception 'NetRiders can only record walk-in tickets.' using errcode = 'insufficient_privilege';
    end if;
    if v_owner is not null and v_owner <> v_actor.id then
      raise exception 'NetRiders must assign their walk-in tickets to themselves.'
        using errcode = 'insufficient_privilege';
    end if;
    if v_submitted <> public.app_today() then
      raise exception 'NetRiders cannot backdate a walk-in ticket.' using errcode = 'insufficient_privilege';
    end if;
    v_owner := v_actor.id;
  end if;

  if v_owner is not null and not exists (
    select 1 from public.app_accounts a where a.id = v_owner and a.status = 'active'
  ) then
    raise exception 'Choose an active NetRider as the owner.' using errcode = 'check_violation';
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
  'Records one request, for both intake models. p_requester_id names a row in the owner''s directory; p_person_id names somebody in the M5 people table and finds or creates their single requester row in one statement, so two concurrent intakes for the same person both succeed. A device entry carrying inventoryDeviceId is snapshotted from inventory_devices; one carrying a manufacturer must match a device_catalog row and carry a serial; one carrying neither is a free-text observation. p_device_ids links M5 inventory machines. Rejects a forged channel, owner, date or category rather than correcting it. The walk-in guard speaks of NetRiders.';

-- create or replace preserves the ACL, but restated for clarity, as the brief
-- for this fix asked.
revoke execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[])
from public, anon;

grant execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[])
to authenticated;

-- ---------------------------------------------------------------------------
-- app_has_role wired into the guards that test the caller's own roles.
-- Restated from 20260914140000 (app_insights, app_save_inventory_device) and
-- 20260914140100 (app_claim_ticket), each with exactly one line changed: the
-- inline `roles && array[...]` becomes the two app_has_role calls it is
-- equivalent to for these callers. Nothing else in any of the three bodies
-- changes. app_lock_ticket is NOT restated here: see the header comment for
-- why its inline form stays.
-- ---------------------------------------------------------------------------

create or replace function public.app_insights(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
begin
  v_actor := public.app_require_actor();
  if not (public.app_has_role('admin') or public.app_has_role('netrider')) then
    raise exception 'Only a NetRider or an administrator can read insights.'
      using errcode = 'insufficient_privilege';
  end if;
  return public.app_insights_report(p_days);
end;
$$;

create or replace function public.app_save_inventory_device(p_id uuid, p_version integer, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare a public.app_accounts; d public.inventory_devices; v_before jsonb; v_key text; v_serial text; v_assignee uuid;
begin
  a := public.app_require_actor();
  if not (public.app_has_role('admin') or public.app_has_role('netrider')) then
    raise exception 'Only a NetRider or an administrator can change inventory.'
      using errcode = 'insufficient_privilege';
  end if;
  perform public.app_validate_profile(p_data);
  foreach v_key in array array['deviceType','manufacturer','model','serialNumber'] loop
    if length(btrim(coalesce(p_data->>v_key,'')))=0 then raise exception 'Device type, manufacturer, model and serial number are required.'; end if;
  end loop;
  v_serial:=btrim(p_data->>'serialNumber');
  v_assignee:=nullif(p_data->>'assignedRequesterId','')::uuid;
  if v_assignee is not null and not exists(select 1 from public.requesters r where r.id=v_assignee and r.kind in ('staff','student')) then
    raise exception 'Select an existing student or staff member for the assignment.';
  end if;
  if p_id is not null then
    select * into d from public.inventory_devices where id=p_id for update;
    if not found then raise exception 'That device no longer exists.'; end if;
    if p_version is distinct from d.version then raise exception 'This device changed since you opened it. Reload it before saving.' using errcode='serialization_failure'; end if;
    v_before:=to_jsonb(d);
  end if;
  -- Serialize competing new serials; legacy duplicates remain editable unless
  -- their serial is changed. No old rows are deleted or silently merged.
  perform pg_advisory_xact_lock(hashtextextended(lower(v_serial),1162103124));
  if (p_id is null or lower(v_serial) is distinct from lower(d.serial_number)) and exists(
    select 1 from public.inventory_devices i where lower(i.serial_number)=lower(v_serial) and i.id is distinct from p_id
  ) then raise exception 'That serial number is already recorded in inventory.' using errcode='unique_violation'; end if;
  if p_id is null then
    insert into public.inventory_devices(external_id,device_type,manufacturer,model,serial_number)
      values('DEV-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),btrim(p_data->>'deviceType'),btrim(p_data->>'manufacturer'),btrim(p_data->>'model'),v_serial)
      returning * into d;
  end if;
  update public.inventory_devices set device_type=btrim(p_data->>'deviceType'),manufacturer=btrim(p_data->>'manufacturer'),model=btrim(p_data->>'model'),
    serial_number=v_serial,os_version=nullif(btrim(p_data->>'osVersion'),''),asset_tag=nullif(btrim(p_data->>'assetTag'),''),
    status=nullif(btrim(p_data->>'status'),''),location=nullif(btrim(p_data->>'location'),''),notes=nullif(btrim(p_data->>'notes'),''),assigned_requester_id=v_assignee
    where id=d.id returning * into d;
  insert into public.device_catalog(device_type,manufacturer,model) values(d.device_type,d.manufacturer,d.model) on conflict do nothing;
  insert into public.inventory_events(entity,entity_id,actor_id,before_record,after_record) values('device',d.id,a.id,v_before,to_jsonb(d));
  return d.id;
end;
$$;

create or replace function public.app_claim_ticket(p_ticket uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_previous uuid;
begin
  v_actor := public.app_require_actor();

  -- Claiming is ticket work. Answered with the same sentence as every other
  -- unavailable ticket, so this endpoint still says nothing about what exists.
  if not (public.app_has_role('admin') or public.app_has_role('netrider')) then
    raise exception 'That ticket is not available to claim.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Deliberate M2 change from the M1 demo: the loser of a claim race is NOT told
  -- who won. Missing, invisible, already-owned and non-open tickets all produce
  -- this one message, so the claim endpoint cannot be used to probe ownership by
  -- ticket id. Documented in docs/M2-DATABASE.md.
  select * into v_ticket
  from public.tickets t
  where t.id = p_ticket
  for update;

  if not found or v_ticket.status <> 'open' or v_ticket.owner_id is not null then
    raise exception 'That ticket is not available to claim.'
      using errcode = 'insufficient_privilege';
  end if;

  v_previous := v_ticket.owner_id;

  update public.tickets
  set owner_id = v_actor.id,
      assigned_at = now(),
      status = 'assigned'
  where id = v_ticket.id;

  -- Someone cannot be both primary owner and collaborator.
  delete from public.ticket_collaborators
  where ticket_id = v_ticket.id and account_id = v_actor.id;

  perform public.app_log_event(
    v_ticket.id, 'claimed', v_actor.id, v_actor.display_name || ' claimed the ticket'
  );

  -- Unreachable while claiming requires an unowned ticket, so `v_previous` is
  -- always NULL here; kept for the day a previous-owner column exists.
  if v_previous is not null and v_previous <> v_actor.id then
    perform public.app_notify(
      v_previous,
      'ticket_claimed',
      v_ticket.number || ' was claimed by ' ||
        case when public.app_request_via() = 'ai'
          then v_actor.display_name || '''s AI'
          else v_actor.display_name
        end,
      v_ticket.title,
      '/tickets/' || v_ticket.id
    );
  end if;

  return v_ticket.id;
end;
$$;
