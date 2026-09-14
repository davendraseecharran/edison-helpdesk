-- Minimal directory and inventory mirror. Source sheets remain unchanged.
-- Operator imports use stable external keys; no client can write these tables.
alter table public.requesters add column external_id text;
create unique index requesters_external_key on public.requesters(kind, external_id) where external_id is not null;
create table public.device_catalog (
  id uuid primary key default gen_random_uuid(),
  device_type text not null check(length(btrim(device_type)) > 0),
  manufacturer text not null check(length(btrim(manufacturer)) > 0),
  model text not null check(length(btrim(model)) > 0),
  unique(device_type, manufacturer, model)
);
create table public.inventory_devices (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  device_type text not null,
  manufacturer text not null,
  model text,
  os_version text,
  serial_number text,
  asset_tag text,
  status text,
  location text,
  assigned_requester_id uuid references public.requesters(id) on delete restrict,
  imported_at timestamptz not null default now()
);
create index inventory_assigned_requester on public.inventory_devices(assigned_requester_id);
alter table public.device_catalog enable row level security;
alter table public.inventory_devices enable row level security;
revoke all on public.device_catalog, public.inventory_devices from anon, authenticated;
grant all on public.device_catalog, public.inventory_devices to service_role;
-- Read access goes through bounded RPCs, with live credential/status checks.
alter table public.device_observations add column manufacturer text;
alter table public.device_observations add column inventory_device_id uuid references public.inventory_devices(id) on delete restrict;
create index device_observations_inventory on public.device_observations(inventory_device_id);
alter table public.tickets drop constraint tickets_issue_present;

create function public.app_search_requesters(p_kind text, p_query text)
returns table(id uuid, display_name text, external_id text)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.app_require_actor();
  if p_kind is null or p_kind not in ('staff','student') then
    raise exception 'Choose staff or student.' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_query,''))) < 2 then return; end if;
  if length(p_query) > 120 then raise exception 'Search is too long.'; end if;
  return query select r.id, r.display_name, r.external_id
    from public.requesters r
    where r.kind = p_kind and (
      strpos(lower(r.display_name),lower(btrim(p_query))) > 0
      or (p_kind = 'student' and strpos(coalesce(r.external_id,''), btrim(p_query)) > 0)
    ) order by r.display_name, r.id limit 20;
end;
$$;
create function public.app_assigned_devices(p_requester uuid)
returns setof public.inventory_devices
language plpgsql security definer set search_path = '' as $$
begin
  perform public.app_require_actor();
  return query select d.* from public.inventory_devices d
  where d.assigned_requester_id = p_requester order by d.device_type, d.model, d.id limit 100;
end;
$$;
create function public.app_device_catalog()
returns table(device_type text, manufacturer text, model text)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.app_require_actor();
  return query select c.device_type,c.manufacturer,c.model from public.device_catalog c
  order by c.device_type,c.manufacturer,c.model limit 1000;
end;
$$;
revoke all on function public.app_search_requesters(text,text), public.app_assigned_devices(uuid), public.app_device_catalog() from public, anon;
grant execute on function public.app_search_requesters(text,text), public.app_assigned_devices(uuid), public.app_device_catalog() to authenticated;

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
  p_devices jsonb default '[]'
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
  v_ticket_id uuid;
  v_collaborator uuid;
  v_collab_name text;
  v_device jsonb;
  v_device_type text;
  v_inventory public.inventory_devices;
  v_inventory_id uuid;
  v_seen_inventory uuid[] := '{}';
  v_seen uuid[] := '{}';
begin
  v_actor := public.app_require_actor();
  v_admin := v_actor.role = 'admin';

  if length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'An issue is required.' using errcode = 'check_violation';
  end if;
  if length(btrim(p_title)) > 120 then
    raise exception 'Keep the issue under 120 characters.' using errcode = 'check_violation';
  end if;
  if length(coalesce(p_issue,'')) > 6000 then
    raise exception 'Keep notes under 6000 characters.' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_requester_name,''))) > 0 then
    raise exception 'Select an existing requester or Requester Unknown.' using errcode = 'check_violation';
  end if;
  if coalesce(p_is_remote,false) then
    raise exception 'Use the location field for intake.' using errcode = 'check_violation';
  end if;
  if p_devices is null or jsonb_typeof(p_devices) <> 'array' or jsonb_array_length(p_devices) > 50 then
    raise exception 'Provide a device list with at most 50 devices.' using errcode = 'check_violation';
  end if;
  if v_submitted > public.app_today() then
    raise exception 'The submission date cannot be in the future.' using errcode = 'check_violation';
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

  -- Existing staff/student directory record or explicitly unknown; no inline creation.
  if coalesce(p_requester_unknown,false) then
    if p_requester_id is not null then
      raise exception 'Choose one requester option.' using errcode = 'check_violation';
    end if;
    v_requester := null;
  elsif v_requester is null or not exists (
    select 1 from public.requesters r where r.id = v_requester and r.kind in ('staff','student')
  ) then
    raise exception 'Select an existing requester or Requester Unknown.' using errcode = 'check_violation';
  end if;

  insert into public.tickets (
    title, issue, requester_id, requester_unknown, location, is_remote,
    channel, priority, status, submitted_on, created_by, owner_id, assigned_at
  )
  values (
    btrim(p_title),
    btrim(coalesce(p_issue,'')),
    v_requester,
    coalesce(p_requester_unknown,false),
    case when p_is_remote then null else nullif(btrim(coalesce(p_location, '')), '') end,
    coalesce(p_is_remote, false),
    v_channel,
    coalesce(nullif(btrim(coalesce(p_priority, '')), ''), 'normal'),
    case when v_owner is null then 'open' else 'assigned' end,
    v_submitted,
    v_actor.id,
    v_owner,
    case when v_owner is null then null else now() end
  )
  returning id into v_ticket_id;

  perform public.app_log_event(
    v_ticket_id, 'created', v_actor.id,
    v_actor.display_name || ' recorded a '
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

  for v_device in select * from jsonb_array_elements(coalesce(p_devices, '[]'::jsonb)) loop
    v_device_type := btrim(coalesce(v_device ->> 'deviceType', ''));
    if v_device_type = '' then
      raise exception 'Each device entry needs a device type.' using errcode = 'check_violation';
    end if;
    v_inventory_id := nullif(v_device ->> 'inventoryDeviceId','')::uuid;
    if v_inventory_id is not null then
      if v_inventory_id = any(v_seen_inventory) then
        raise exception 'That inventory device was already added.' using errcode = 'check_violation';
      end if;
      select * into v_inventory from public.inventory_devices d
        where d.id = v_inventory_id and d.assigned_requester_id = v_requester for share;
      if not found then
        raise exception 'That device is no longer assigned to the selected requester.' using errcode = 'check_violation';
      end if;
      v_seen_inventory := v_seen_inventory || v_inventory_id;
      -- Snapshot authoritative inventory fields, never forged browser details.
      v_device_type := v_inventory.device_type;
      v_device := jsonb_build_object('deviceType',v_inventory.device_type,
        'manufacturer',v_inventory.manufacturer,'model',v_inventory.model,
        'serialNumber',v_inventory.serial_number,'assetTag',v_inventory.asset_tag,
        'osVersion',v_inventory.os_version);
    end if;
    if length(btrim(coalesce(v_device->>'manufacturer',''))) = 0
      or length(btrim(coalesce(v_device->>'model',''))) = 0
      or length(btrim(coalesce(v_device->>'serialNumber',''))) = 0 then
      raise exception 'Each device requires a device type, manufacturer, model and serial number.' using errcode = 'check_violation';
    end if;
    if not exists(select 1 from public.device_catalog c where c.device_type = v_device_type
      and c.manufacturer = btrim(v_device->>'manufacturer') and c.model = btrim(v_device->>'model')) then
      raise exception 'Select a device type, manufacturer and model from inventory.' using errcode = 'check_violation';
    end if;
    insert into public.device_observations (
      ticket_id, device_type, manufacturer, inventory_device_id, model, os_version, serial_number, asset_tag,
      identifiers_not_applicable, recorded_by
    )
    values (
      v_ticket_id, v_device_type, btrim(v_device->>'manufacturer'), v_inventory_id,
      nullif(btrim(coalesce(v_device ->> 'model', '')), ''),
      nullif(btrim(coalesce(v_device ->> 'osVersion', '')), ''),
      nullif(btrim(coalesce(v_device ->> 'serialNumber', '')), ''),
      nullif(btrim(coalesce(v_device ->> 'assetTag', '')), ''),
      false,
      v_actor.id
    );
    perform public.app_log_event(
      v_ticket_id, 'device_recorded', v_actor.id,
      v_actor.display_name || ' recorded a device: ' || v_device_type
    );
  end loop;

  return v_ticket_id;
end;
$$;

