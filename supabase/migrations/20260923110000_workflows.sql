-- ---------------------------------------------------------------------------
-- Workflows: the repetitive device jobs, as a scan loop.
--
-- Loading a cart is thirty identical edits: open a machine, change its
-- location, save, next. The four movements in 20260914130000 already do each
-- edit correctly; what they do not do is take a CODE, say what the machine was
-- before, and say whether the change was needed at all. A NetRider walking a
-- cart with a scanner wants exactly that, one round trip per beep.
--
-- So this file adds, on the owner's tables and without loosening one of their
-- policies:
--
--   * app_workflow_scan             — one code, one job: resolve the machine,
--                                     skip it when it is already done, apply it
--                                     through the existing movement RPCs, and
--                                     answer with the state before and after
--   * app_workflow_undo             — put one machine back exactly as it was,
--                                     refused when somebody changed it since
--   * app_workflow_location_devices — what the inventory says is in one room
--                                     or cart, for an audit and for a cart's
--                                     count before anything is scanned
--   * app_workflow_find_person      — an ID card or an OSIS typed at the desk,
--                                     to exactly one person
--
-- plus two small tables of the desk's own:
--
--   * workflow_shortcuts — named, shared, one-tap runs: "Load Cart 3",
--                          "Collect into the returns bin". Shared exactly as
--                          ticket presets are (20260916130200): the carts are
--                          the school's, not one NetRider's.
--   * workflow_runs      — what was finished, by whom, with how many done,
--                          skipped and refused: the hub's "recent runs".
--
-- Four decisions are worth stating.
--
--   THE MOVEMENT RPCS ARE REUSED, NOT RESTATED. A scan that moves a machine
--   calls app_bulk_update_inventory for that one id; a hand-out calls
--   app_assign_inventory_device; a collection calls
--   app_return_inventory_device. Each of those already takes the row lock,
--   checks the role SET, writes the owner's inventory_events snapshot and the
--   sentence a person reads, and attributes an assistant's call as the
--   assistant's. A second copy of any of that here would be a copy that drifts.
--
--   UNDO COMPARES STATE, NOT VERSIONS. The bulk RPC returns a count, not a
--   version, and a version is the wrong question anyway: undo asks "is this
--   machine still where my scan put it?". If its location, status and holder
--   are what the scan left, it is put back; if any of them moved since, the
--   undo is refused with a sentence and nothing changes.
--
--   NETRIDERS AND ADMINISTRATORS ONLY, asked of the role set. A skills officer
--   reads the inventory and changes none of it, and every function here either
--   changes it or exists to feed something that does.
--
--   THE TABLES HAVE NO WRITE POLICIES. They are readable by the desk and
--   written only through the functions below, so the caps, the vocabularies
--   and the history entries cannot be walked around.
--
-- Additive: two tables, three expression indexes on the owner's inventory
-- (the lookup already asks those exact expressions), nine functions.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The lookup's own expressions, indexed.
--
-- app_lookup_inventory_code (20260914130000) and app_workflow_scan both fold
-- the three printed codes to upper case and compare exactly. On 4,278 machines
-- that is a sequential scan per beep; a scanner beeps once a second.
-- ---------------------------------------------------------------------------

create index if not exists inventory_devices_external_id_upper
  on public.inventory_devices (pg_catalog.upper(external_id));
create index if not exists inventory_devices_asset_tag_upper
  on public.inventory_devices (pg_catalog.upper(asset_tag));
create index if not exists inventory_devices_serial_upper
  on public.inventory_devices (pg_catalog.upper(serial_number));

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.workflow_shortcuts (
  id uuid primary key default extensions.gen_random_uuid(),
  -- What the tile says. Short, because it is a one-tap button on a phone.
  name text not null,
  -- move: load a cart or move to a location. status: set a status.
  -- collect: take machines back. audit: check a room against the inventory.
  -- Hand-outs are not here: the part of a hand-out that repeats is nothing,
  -- because the person is different every time.
  kind text not null,
  location text not null default '',
  status text not null default '',
  position integer not null default 0,
  -- Attribution, not ownership: any NetRider may edit or delete any row.
  created_by uuid references public.app_accounts (id),
  updated_at timestamptz not null default now(),
  constraint workflow_shortcuts_name_length
    check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 40),
  constraint workflow_shortcuts_kind_valid
    check (kind in ('move', 'status', 'collect', 'audit')),
  constraint workflow_shortcuts_location_length check (pg_catalog.length(location) <= 120),
  constraint workflow_shortcuts_status_length check (pg_catalog.length(status) <= 120)
);

comment on table public.workflow_shortcuts is
  'Named workflow runs the desk repeats: Load Cart 3, Collect into the returns bin. Shared by every NetRider and administrator. Written only by app_save_workflow_shortcut and app_delete_workflow_shortcut.';

create unique index workflow_shortcuts_name_unique
  on public.workflow_shortcuts (pg_catalog.lower(name));
create index workflow_shortcuts_order_idx on public.workflow_shortcuts (position, name);

create table public.workflow_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  kind text not null,
  -- What the run was aimed at, as the hub shows it: "Cart 3", "In repair",
  -- "Room 204". Never a person's name: a hand-out names several.
  label text not null default '',
  location text not null default '',
  status text not null default '',
  done integer not null default 0,
  skipped integer not null default 0,
  errors integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  run_by uuid not null references public.app_accounts (id),
  performed_via text not null default 'user',
  ai_model text,
  constraint workflow_runs_kind_valid
    check (kind in ('move', 'status', 'collect', 'audit', 'handout')),
  constraint workflow_runs_label_length check (pg_catalog.length(label) <= 120),
  constraint workflow_runs_location_length check (pg_catalog.length(location) <= 120),
  constraint workflow_runs_status_length check (pg_catalog.length(status) <= 120),
  constraint workflow_runs_counts_valid check (
    done between 0 and 100000 and skipped between 0 and 100000 and errors between 0 and 100000
  ),
  constraint workflow_runs_performed_via_valid check (performed_via in ('user', 'ai'))
);

comment on table public.workflow_runs is
  'One finished workflow run: what it was aimed at, who ran it and how many machines were done, skipped and refused. Every change to a machine is already in inventory_events and record_events; this is the summary the Workflows hub lists. Written only by app_record_workflow_run.';

create index workflow_runs_recent_idx on public.workflow_runs (finished_at desc);

alter table public.workflow_shortcuts enable row level security;
alter table public.workflow_runs enable row level security;

create policy workflow_shortcuts_select_desk
  on public.workflow_shortcuts for select to authenticated
  using (public.app_can_work_tickets());

create policy workflow_runs_select_desk
  on public.workflow_runs for select to authenticated
  using (public.app_can_work_tickets());

revoke all on table public.workflow_shortcuts, public.workflow_runs from public, anon, authenticated;
grant select on table public.workflow_shortcuts, public.workflow_runs to authenticated;
grant all on table public.workflow_shortcuts, public.workflow_runs to service_role;

-- ---------------------------------------------------------------------------
-- The gate, in one place.
--
-- app_can_work_tickets() asks the same question the inventory writers ask —
-- admin or netrider, of the role set, on an active account — and this raises
-- the inventory writers' own sentence when the answer is no. Not granted to
-- any client role.
-- ---------------------------------------------------------------------------

create function public.app_workflow_actor()
returns public.app_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
begin
  v_actor := public.app_require_actor();
  if not (public.app_has_role('admin') or public.app_has_role('netrider')) then
    raise exception 'Only a NetRider or an administrator can change inventory.'
      using errcode = 'insufficient_privilege';
  end if;
  return v_actor;
end;
$$;

revoke all on function public.app_workflow_actor() from public, anon, authenticated;

-- The state a scan reports and an undo compares: where the machine is, what
-- it is, and who has it. Raw columns, nulls kept, so "no location" and "an
-- empty location" never compare equal by accident.
create function public.app_workflow_state(d public.inventory_devices)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'location', d.location,
    'status', d.status,
    'holderId', d.assigned_requester_id,
    'holderName', (select r.display_name from public.requesters r where r.id = d.assigned_requester_id),
    'holderKind', (select r.kind from public.requesters r where r.id = d.assigned_requester_id)
  );
$$;

create function public.app_workflow_device(d public.inventory_devices)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', d.id,
    'label', public.app_device_label(d),
    'assetTag', coalesce(d.asset_tag, ''),
    'serialNumber', coalesce(d.serial_number, ''),
    'externalId', d.external_id,
    'deviceType', d.device_type,
    'manufacturer', d.manufacturer,
    'model', coalesce(d.model, '')
  );
$$;

revoke all on function
  public.app_workflow_state(public.inventory_devices),
  public.app_workflow_device(public.inventory_devices)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A person from a card or a typed id
--
-- Exact, folded for case, over the directory's own identifier (an OSIS for a
-- student, the staff id for staff) and the email address. One match or none:
-- a card reader, like a barcode scanner, has nobody to ask which of two.
-- ---------------------------------------------------------------------------

create function public.app_workflow_find_person(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_code, '')), ''));
  v_ids uuid[];
  v_person public.requesters;
begin
  perform public.app_workflow_actor();
  if v_code is null or pg_catalog.length(v_code) > 254 then
    return null;
  end if;

  select pg_catalog.array_agg(m.id) into v_ids
  from (
    select r.id
    from public.requesters r
    where r.kind in ('student', 'staff')
      and (pg_catalog.lower(r.external_id) = v_code or pg_catalog.lower(r.email) = v_code)
    limit 2
  ) m;

  if pg_catalog.array_length(v_ids, 1) is distinct from 1 then
    return null;
  end if;

  select * into v_person from public.requesters r where r.id = v_ids[1];
  return pg_catalog.jsonb_build_object(
    'id', v_person.id,
    'displayName', v_person.display_name,
    'kind', v_person.kind,
    'externalId', coalesce(v_person.external_id, ''),
    'holding', (
      select pg_catalog.count(*) from public.inventory_devices d
      where d.assigned_requester_id = v_person.id
    )
  );
end;
$$;

comment on function public.app_workflow_find_person(text) is
  'One person from a scanned ID card or a typed OSIS, staff id or email address, matched exactly and folded for case. NULL for no match and for more than one. NetRiders and administrators only.';

-- ---------------------------------------------------------------------------
-- What the inventory says is in one place
-- ---------------------------------------------------------------------------

create function public.app_workflow_location_devices(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_location text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_location, '')), ''));
begin
  perform public.app_workflow_actor();
  if v_location is null then
    raise exception 'Choose a location.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_location) > 120 then
    raise exception 'Keep the location under 120 characters.' using errcode = 'check_violation';
  end if;

  -- Folded for case and trimmed, so "cart 3" and "Cart 3 " are the room the
  -- person meant. Capped at a thousand: no room in the building holds more,
  -- and an audit that did would be a stocktake, not a walk-through.
  return coalesce((
    select pg_catalog.jsonb_agg(
      public.app_workflow_device(d) || pg_catalog.jsonb_build_object('state', public.app_workflow_state(d))
      order by public.app_device_label(d), d.id
    )
    from public.inventory_devices d
    where d.id in (
      select i.id from public.inventory_devices i
      where pg_catalog.lower(pg_catalog.btrim(i.location)) = v_location
      order by i.id
      limit 1000
    )
  ), '[]'::jsonb);
end;
$$;

comment on function public.app_workflow_location_devices(text) is
  'Every machine the inventory records at one location, folded for case and trimmed, up to a thousand, with its state. For a room audit and for a cart''s count. NetRiders and administrators only.';

-- ---------------------------------------------------------------------------
-- One scan
-- ---------------------------------------------------------------------------

create function public.app_workflow_scan(
  p_code text,
  p_action text,
  p_target jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_code text := nullif(pg_catalog.btrim(coalesce(p_code, '')), '');
  v_action text := pg_catalog.btrim(coalesce(p_action, ''));
  v_target jsonb := coalesce(p_target, '{}'::jsonb);
  v_location text;
  v_status text;
  v_requester uuid;
  v_person public.requesters;
  v_ids uuid[];
  v_before public.inventory_devices;
  v_after public.inventory_devices;
  v_found jsonb;
  v_patch jsonb;
begin
  v_actor := public.app_workflow_actor();

  if v_code is null then
    raise exception 'Scan or type a code.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_code) > 200 then
    raise exception 'That code is too long to be a label.' using errcode = 'check_violation';
  end if;
  if v_action not in ('move', 'status', 'assign', 'collect', 'resolve') then
    raise exception 'Choose what the scan should do.' using errcode = 'check_violation';
  end if;
  if pg_catalog.jsonb_typeof(v_target) <> 'object' then
    raise exception 'Send the target as an object.' using errcode = 'check_violation';
  end if;

  v_location := nullif(pg_catalog.btrim(coalesce(v_target ->> 'location', '')), '');
  v_status := nullif(pg_catalog.btrim(coalesce(v_target ->> 'status', '')), '');

  -- The target is checked before anything is looked up, so a run that was set
  -- up wrong fails on its first beep with a sentence about the setup rather
  -- than thirty times with a sentence about each machine.
  if v_location is not null and pg_catalog.length(v_location) > 120 then
    raise exception 'Keep the location under 120 characters.' using errcode = 'check_violation';
  end if;
  if v_status is not null and pg_catalog.length(v_status) > 120 then
    raise exception 'Keep the status under 120 characters.' using errcode = 'check_violation';
  end if;
  if v_action = 'move' and v_location is null then
    raise exception 'Choose where the machines are going.' using errcode = 'check_violation';
  end if;
  if v_action = 'status' and v_status is null then
    raise exception 'Choose a status.' using errcode = 'check_violation';
  end if;
  if v_action = 'status' and v_status = 'Assigned' then
    raise exception 'Assigned means somebody has it. Hand the machines out instead.'
      using errcode = 'check_violation';
  end if;
  if v_action = 'collect' then
    v_status := coalesce(v_status, 'Available');
  end if;
  if v_action = 'assign' then
    begin
      v_requester := (v_target ->> 'requester')::uuid;
    exception when invalid_text_representation then
      v_requester := null;
    end;
    if v_requester is null then
      raise exception 'Choose who is taking the machines.' using errcode = 'check_violation';
    end if;
    select * into v_person from public.requesters r
    where r.id = v_requester and r.kind in ('staff', 'student');
    if not found then
      raise exception 'That person is not in the directory. Search for them again.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- One code, one machine: the scanner lookup's own rule.
  select pg_catalog.array_agg(m.id) into v_ids
  from (
    select d.id from public.inventory_devices d
    where pg_catalog.upper(d.external_id) = pg_catalog.upper(v_code)
       or pg_catalog.upper(d.asset_tag) = pg_catalog.upper(v_code)
       or pg_catalog.upper(d.serial_number) = pg_catalog.upper(v_code)
    limit 2
  ) m;

  if pg_catalog.array_length(v_ids, 1) is null then
    -- During a hand-out the next thing scanned is as likely to be the next
    -- student's card as a laptop, and saying so saves the NetRider a tap.
    if v_action = 'assign' then
      v_found := public.app_workflow_find_person(v_code);
      if v_found is not null then
        return pg_catalog.jsonb_build_object('outcome', 'person', 'code', v_code, 'person', v_found);
      end if;
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'unknown', 'code', v_code);
  end if;
  if pg_catalog.array_length(v_ids, 1) > 1 then
    return pg_catalog.jsonb_build_object('outcome', 'ambiguous', 'code', v_code);
  end if;

  if v_action = 'resolve' then
    select * into v_before from public.inventory_devices d where d.id = v_ids[1];
    return pg_catalog.jsonb_build_object(
      'outcome', 'found', 'code', v_code,
      'device', public.app_workflow_device(v_before),
      'before', public.app_workflow_state(v_before)
    );
  end if;

  select * into v_before from public.inventory_devices d where d.id = v_ids[1] for update;

  -- Already done: said, and nothing written. A second beep over the same
  -- machine must not put a second line in its history.
  if (v_action = 'move' and v_before.location is not distinct from v_location)
     or (v_action = 'status' and v_before.status is not distinct from v_status
         and v_before.assigned_requester_id is null)
     or (v_action = 'assign' and v_before.assigned_requester_id is not distinct from v_requester)
     or (v_action = 'collect' and v_before.assigned_requester_id is null
         and v_before.status is not distinct from v_status
         and (v_location is null or v_before.location is not distinct from v_location)) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'already', 'code', v_code,
      'device', public.app_workflow_device(v_before),
      'before', public.app_workflow_state(v_before)
    );
  end if;

  -- A status is not how a loan ends. A machine somebody holds is collected,
  -- which closes the loan on both records; restatusing it here would leave a
  -- student holding a machine the inventory calls In repair.
  if v_action = 'status' and v_before.assigned_requester_id is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'held', 'code', v_code,
      'device', public.app_workflow_device(v_before),
      'before', public.app_workflow_state(v_before)
    );
  end if;

  if v_action = 'move' then
    perform public.app_bulk_update_inventory(
      array[v_before.id], pg_catalog.jsonb_build_object('location', v_location)
    );
  elsif v_action = 'status' then
    perform public.app_bulk_update_inventory(
      array[v_before.id], pg_catalog.jsonb_build_object('status', v_status)
    );
  elsif v_action = 'assign' then
    perform public.app_assign_inventory_device(v_before.id, v_requester, null, null);
  elsif v_action = 'collect' then
    if v_before.assigned_requester_id is not null then
      perform public.app_return_inventory_device(v_before.id, v_status, null, null);
      if v_location is not null and v_before.location is distinct from v_location then
        perform public.app_bulk_update_inventory(
          array[v_before.id], pg_catalog.jsonb_build_object('location', v_location)
        );
      end if;
    else
      -- On the shelf already but in the wrong state or place: the collection
      -- still leaves it where the run says returned machines go.
      v_patch := pg_catalog.jsonb_build_object('status', v_status);
      if v_location is not null then
        v_patch := v_patch || pg_catalog.jsonb_build_object('location', v_location);
      end if;
      perform public.app_bulk_update_inventory(array[v_before.id], v_patch);
    end if;
  end if;

  select * into v_after from public.inventory_devices d where d.id = v_before.id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'done', 'code', v_code,
    'device', public.app_workflow_device(v_after),
    'before', public.app_workflow_state(v_before),
    'after', public.app_workflow_state(v_after)
  );
end;
$$;

comment on function public.app_workflow_scan(text, text, jsonb) is
  'One scanned code, one job. Resolves the code to exactly one machine, reports a machine that is already done without writing anything, and otherwise applies the job through the existing movement RPCs: move (target.location), status (target.status), assign (target.requester), collect (target.status, default Available, and optional target.location), or resolve (read only). Answers with the outcome and the state before and after. During an assign, a code that is no machine but is exactly one person answers outcome person. NetRiders and administrators only.';

-- ---------------------------------------------------------------------------
-- Undo one scan
-- ---------------------------------------------------------------------------

create function public.app_workflow_undo(
  p_device uuid,
  p_expect jsonb,
  p_restore jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_before public.inventory_devices;
  v_after public.inventory_devices;
  v_expect jsonb := coalesce(p_expect, '{}'::jsonb);
  v_restore jsonb := coalesce(p_restore, '{}'::jsonb);
  v_location text;
  v_status text;
  v_holder uuid;
  v_expect_holder uuid;
  v_label text;
begin
  v_actor := public.app_workflow_actor();

  if p_device is null then
    raise exception 'Choose the machine to put back.' using errcode = 'check_violation';
  end if;
  if pg_catalog.jsonb_typeof(v_expect) <> 'object' or pg_catalog.jsonb_typeof(v_restore) <> 'object' then
    raise exception 'Send the states as objects.' using errcode = 'check_violation';
  end if;

  v_location := v_restore ->> 'location';
  v_status := v_restore ->> 'status';
  begin
    v_holder := (v_restore ->> 'holderId')::uuid;
    v_expect_holder := (v_expect ->> 'holderId')::uuid;
  exception when invalid_text_representation then
    raise exception 'That is not a person in the directory.' using errcode = 'check_violation';
  end;
  if pg_catalog.length(coalesce(v_location, '')) > 120 or pg_catalog.length(coalesce(v_status, '')) > 120 then
    raise exception 'Keep the location and status under 120 characters.' using errcode = 'check_violation';
  end if;

  select * into v_before from public.inventory_devices d where d.id = p_device for update;
  if not found then
    raise exception 'That device is not in the inventory any more.' using errcode = 'check_violation';
  end if;

  -- Still where the scan left it? Otherwise somebody has moved it since, and
  -- putting it "back" would undo their change rather than ours.
  if v_before.location is distinct from (v_expect ->> 'location')
     or v_before.status is distinct from (v_expect ->> 'status')
     or v_before.assigned_requester_id is distinct from v_expect_holder then
    raise exception '% changed after the scan. Nothing was undone.', public.app_device_label(v_before)
      using errcode = 'check_violation';
  end if;

  if v_holder is not null and not exists (
    select 1 from public.requesters r where r.id = v_holder and r.kind in ('staff', 'student')
  ) then
    raise exception 'That person is not in the directory any more. Nothing was undone.'
      using errcode = 'check_violation';
  end if;

  -- Nothing to put back: the scan changed nothing this undo would restore.
  if v_before.location is not distinct from v_location
     and v_before.status is not distinct from v_status
     and v_before.assigned_requester_id is not distinct from v_holder then
    return pg_catalog.jsonb_build_object(
      'device', public.app_workflow_device(v_before),
      'state', public.app_workflow_state(v_before)
    );
  end if;

  update public.inventory_devices d
  set location = v_location,
      status = v_status,
      assigned_requester_id = v_holder
  where d.id = p_device
  returning * into v_after;

  v_label := public.app_device_label(v_after);

  insert into public.inventory_events (entity, entity_id, actor_id, before_record, after_record)
  values ('device', p_device, v_actor.id, pg_catalog.to_jsonb(v_before), pg_catalog.to_jsonb(v_after));

  perform public.app_log_record_event(
    'inventory_device', p_device, 'workflow_undone', v_actor.id,
    v_actor.display_name || ' undid a scan on ' || v_label,
    nullif(pg_catalog.concat_ws(', ',
      case when v_before.location is distinct from v_after.location
        then coalesce('location back to ' || v_after.location, 'location cleared') end,
      case when v_before.status is distinct from v_after.status
        then coalesce('status back to ' || v_after.status, 'status cleared') end,
      case when v_before.assigned_requester_id is distinct from v_after.assigned_requester_id
        then 'holder restored' end
    ), '') || '.'
  );

  -- Both people hear about a loan that was put back, as they did when it moved.
  if v_before.assigned_requester_id is distinct from v_after.assigned_requester_id then
    if v_before.assigned_requester_id is not null then
      perform public.app_log_record_event(
        'requester', v_before.assigned_requester_id, 'device_returned', v_actor.id,
        'Returned device ' || v_label || '.', 'A scan was undone.'
      );
    end if;
    if v_after.assigned_requester_id is not null then
      perform public.app_log_record_event(
        'requester', v_after.assigned_requester_id, 'device_assigned', v_actor.id,
        'Assigned device ' || v_label || '.', 'A scan was undone.'
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'device', public.app_workflow_device(v_after),
    'state', public.app_workflow_state(v_after)
  );
end;
$$;

comment on function public.app_workflow_undo(uuid, jsonb, jsonb) is
  'Puts one machine back to the location, status and holder it had before a workflow scan (p_restore), provided it is still exactly as the scan left it (p_expect); otherwise refuses and changes nothing. Writes inventory_events and record_events like every other inventory write. NetRiders and administrators only.';

-- ---------------------------------------------------------------------------
-- Shortcuts
-- ---------------------------------------------------------------------------

create function public.app_list_workflow_shortcuts()
returns setof public.workflow_shortcuts
language sql
stable
set search_path = ''
as $$
  select s.* from public.workflow_shortcuts s
  order by s.position, pg_catalog.lower(s.name), s.id;
$$;

comment on function public.app_list_workflow_shortcuts() is
  'Every workflow shortcut, in the desk''s order. Empty for an account that is neither a NetRider nor an administrator, because the row policy answers.';

create function public.app_save_workflow_shortcut(
  p_id uuid default null,
  p_name text default null,
  p_kind text default null,
  p_location text default '',
  p_status text default '',
  p_position integer default null
)
returns public.workflow_shortcuts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_row public.workflow_shortcuts;
  v_existing public.workflow_shortcuts;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_kind text := pg_catalog.btrim(coalesce(p_kind, ''));
  v_location text := pg_catalog.btrim(coalesce(p_location, ''));
  v_status text := pg_catalog.btrim(coalesce(p_status, ''));
begin
  v_actor := public.app_workflow_actor();

  if v_name = '' then
    raise exception 'Give the shortcut a name.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_name) > 40 then
    raise exception 'A shortcut''s name is 40 characters at most.' using errcode = 'check_violation';
  end if;
  if v_kind not in ('move', 'status', 'collect', 'audit') then
    raise exception 'Choose which workflow the shortcut runs.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_location) > 120 or pg_catalog.length(v_status) > 120 then
    raise exception 'Keep the location and status under 120 characters.' using errcode = 'check_violation';
  end if;
  if v_kind in ('move', 'audit') and v_location = '' then
    raise exception 'Say which location the shortcut is for.' using errcode = 'check_violation';
  end if;
  if v_kind = 'status' and v_status = '' then
    raise exception 'Say which status the shortcut sets.' using errcode = 'check_violation';
  end if;
  if v_status = 'Assigned' then
    raise exception 'Assigned means somebody has it. Hand the machines out instead.'
      using errcode = 'check_violation';
  end if;
  -- Only what the workflow uses is kept, so a shortcut never carries a value
  -- that silently does nothing.
  if v_kind in ('move', 'audit') then v_status := ''; end if;
  if v_kind = 'status' then v_location := ''; end if;

  if p_id is not null then
    select * into v_existing from public.workflow_shortcuts s where s.id = p_id for update;
    if not found then
      raise exception 'That shortcut is no longer there. The list has been reloaded.'
        using errcode = 'check_violation';
    end if;
  end if;

  if exists (
    select 1 from public.workflow_shortcuts s
    where pg_catalog.lower(s.name) = pg_catalog.lower(v_name)
      and (p_id is null or s.id <> p_id)
  ) then
    raise exception 'A shortcut called % already exists.', v_name using errcode = 'check_violation';
  end if;

  if p_id is null then
    -- Twenty-four: a phone shows them as a grid, and past two dozen the tile
    -- somebody wants is faster to set up than to find.
    if (select pg_catalog.count(*) from public.workflow_shortcuts) >= 24 then
      raise exception 'Twenty-four shortcuts is the limit. Delete one before adding another.'
        using errcode = 'check_violation';
    end if;
    insert into public.workflow_shortcuts (name, kind, location, status, position, created_by)
    values (
      v_name, v_kind, v_location, v_status,
      greatest(0, coalesce(
        p_position,
        (select coalesce(pg_catalog.max(s.position), -1) + 1 from public.workflow_shortcuts s)
      )),
      v_actor.id
    )
    returning * into v_row;
  else
    update public.workflow_shortcuts s
    set name = v_name,
        kind = v_kind,
        location = v_location,
        status = v_status,
        position = greatest(0, coalesce(p_position, v_existing.position)),
        updated_at = pg_catalog.now()
    where s.id = p_id
    returning * into v_row;
  end if;

  perform public.app_log_record_event(
    'account', v_actor.id, 'workflow_shortcut', v_actor.id,
    case when p_id is null then 'Workflow shortcut added: ' else 'Workflow shortcut edited: ' end
      || v_row.name || '.'
  );

  return v_row;
end;
$$;

comment on function public.app_save_workflow_shortcut(uuid, text, text, text, text, integer) is
  'Writes one workflow shortcut, inserting when p_id is null and updating otherwise. Any NetRider or administrator may call it. Refuses an empty or long name, an unknown workflow, a move or audit with no location, a status run with no status, a duplicate name and a twenty-fifth shortcut.';

create function public.app_delete_workflow_shortcut(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_name text;
begin
  v_actor := public.app_workflow_actor();

  delete from public.workflow_shortcuts s where s.id = p_id returning s.name into v_name;
  if v_name is null then
    raise exception 'That shortcut is no longer there. The list has been reloaded.'
      using errcode = 'check_violation';
  end if;

  perform public.app_log_record_event(
    'account', v_actor.id, 'workflow_shortcut', v_actor.id,
    'Workflow shortcut deleted: ' || v_name || '.'
  );
end;
$$;

comment on function public.app_delete_workflow_shortcut(uuid) is
  'Removes one workflow shortcut, whoever wrote it. NetRiders and administrators only.';

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

create function public.app_record_workflow_run(
  p_kind text,
  p_label text default '',
  p_location text default '',
  p_status text default '',
  p_done integer default 0,
  p_skipped integer default 0,
  p_errors integer default 0,
  p_started_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_id uuid;
  v_kind text := pg_catalog.btrim(coalesce(p_kind, ''));
  v_label text := pg_catalog.btrim(coalesce(p_label, ''));
  v_started timestamptz := coalesce(p_started_at, pg_catalog.now());
begin
  v_actor := public.app_workflow_actor();

  if v_kind not in ('move', 'status', 'collect', 'audit', 'handout') then
    raise exception 'Choose which workflow ran.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_label) > 120
     or pg_catalog.length(pg_catalog.btrim(coalesce(p_location, ''))) > 120
     or pg_catalog.length(pg_catalog.btrim(coalesce(p_status, ''))) > 120 then
    raise exception 'Keep the run''s name under 120 characters.' using errcode = 'check_violation';
  end if;
  if coalesce(p_done, 0) not between 0 and 100000
     or coalesce(p_skipped, 0) not between 0 and 100000
     or coalesce(p_errors, 0) not between 0 and 100000 then
    raise exception 'Those counts are not possible.' using errcode = 'check_violation';
  end if;
  -- A run cannot have started in the future, nor before the school day it
  -- is reported on by more than a day: a clock that far off is a caller bug.
  if v_started > pg_catalog.now() + interval '5 minutes'
     or v_started < pg_catalog.now() - interval '1 day' then
    v_started := pg_catalog.now();
  end if;

  insert into public.workflow_runs (
    kind, label, location, status, done, skipped, errors,
    started_at, finished_at, run_by, performed_via, ai_model
  )
  values (
    v_kind, v_label,
    pg_catalog.btrim(coalesce(p_location, '')), pg_catalog.btrim(coalesce(p_status, '')),
    coalesce(p_done, 0), coalesce(p_skipped, 0), coalesce(p_errors, 0),
    v_started, pg_catalog.now(), v_actor.id,
    public.app_request_via(), public.app_request_ai_model()
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.app_record_workflow_run(text, text, text, text, integer, integer, integer, timestamptz) is
  'Records one finished workflow run for the Workflows hub: its kind, what it was aimed at and how many machines were done, skipped and refused. The machines themselves were already recorded by the scans. NetRiders and administrators only.';

create function public.app_list_workflow_runs(p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
begin
  perform public.app_workflow_actor();
  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', w.id, 'kind', w.kind, 'label', w.label,
        'location', w.location, 'status', w.status,
        'done', w.done, 'skipped', w.skipped, 'errors', w.errors,
        'startedAt', w.started_at, 'finishedAt', w.finished_at,
        'runBy', a.display_name, 'runById', w.run_by,
        'performedVia', w.performed_via
      )
      order by w.finished_at desc, w.id desc
    )
    from (
      select * from public.workflow_runs r
      order by r.finished_at desc, r.id desc
      limit v_limit
    ) w
    join public.app_accounts a on a.id = w.run_by
  ), '[]'::jsonb);
end;
$$;

comment on function public.app_list_workflow_runs(integer) is
  'The newest workflow runs, up to fifty, with who ran them. NetRiders and administrators only.';

-- ---------------------------------------------------------------------------
-- Grants. Signed-in accounts only; the gate inside each body is the real one.
-- ---------------------------------------------------------------------------

revoke all on function
  public.app_workflow_find_person(text),
  public.app_workflow_location_devices(text),
  public.app_workflow_scan(text, text, jsonb),
  public.app_workflow_undo(uuid, jsonb, jsonb),
  public.app_list_workflow_shortcuts(),
  public.app_save_workflow_shortcut(uuid, text, text, text, text, integer),
  public.app_delete_workflow_shortcut(uuid),
  public.app_record_workflow_run(text, text, text, text, integer, integer, integer, timestamptz),
  public.app_list_workflow_runs(integer)
from public, anon, authenticated;

grant execute on function
  public.app_workflow_find_person(text),
  public.app_workflow_location_devices(text),
  public.app_workflow_scan(text, text, jsonb),
  public.app_workflow_undo(uuid, jsonb, jsonb),
  public.app_list_workflow_shortcuts(),
  public.app_save_workflow_shortcut(uuid, text, text, text, text, integer),
  public.app_delete_workflow_shortcut(uuid),
  public.app_record_workflow_run(text, text, text, text, integer, integer, integer, timestamptz),
  public.app_list_workflow_runs(integer)
to authenticated;
