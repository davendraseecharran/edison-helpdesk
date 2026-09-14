-- M5: the device inventory and who is holding each machine.
--
-- Roughly 7,500 laptops, tablets and panels, imported from the school's
-- AppSheet spreadsheet, plus the loan history that says which student or staff
-- member has each one. Task 10 links tickets to devices, Task 11 searches them,
-- Task 12 imports them and Task 18 renders them, all on the names and shapes
-- established here.
--
-- Additive only, and every earlier rule stays in force: identity is auth.uid()
-- only, clients get SELECT and nothing else, every write goes through a SECURITY
-- DEFINER RPC that re-derives the actor inside the database, and history is
-- append-only.
--
-- Three decisions shape everything below.
--
-- 1. A device is `deployed` if and only if somebody is currently holding it.
--    That is an INVARIANT, not a convention the application is trusted to keep.
--    `device_assignments_open_idx` makes "at most one open loan per device" a
--    rule the database enforces, and app_assign_device, app_return_device,
--    app_set_device_status and app_upsert_device all refuse the moves that would
--    break the other half of it. In particular `status` is an ordinary
--    upsertable field — it is operational, not an administrator's switch — but
--    sending it still goes through the same guard, so the guard on
--    app_set_device_status cannot be walked around by sending one more key to
--    the upsert.
--
-- 2. Identifiers are normalised on write. The source spreadsheet hands back
--    `doe-ln1221779`, `  DOE-LN1221779 ` and an empty cell for the same three
--    columns, so device_id, serial_number and asset_tag are trimmed and
--    upper-cased, an empty one becomes NULL, and the "a device must be
--    identifiable" check is applied AFTER that rather than before. A collision
--    is reported in words an operator can act on rather than as an index name.
--
-- 3. Devices are things, not children. Unlike person history, device history may
--    name values — a location, a status, an asset tag — because none of that is
--    a home address or a parent's phone number. What it must NOT do is leak the
--    directory it points at, so reading devices and assignments requires an
--    ACTIVE account for exactly the reason reading people does.

-- ---------------------------------------------------------------------------
-- The inventory
-- ---------------------------------------------------------------------------

create table public.devices (
  id uuid primary key default extensions.gen_random_uuid(),
  -- The AppSheet DeviceID, e.g. PW0FYJ9B-WIN. Present for managed Windows
  -- machines and absent for most of the rest, which is why all three
  -- identifiers are nullable and the check below asks only for one of them.
  device_id text,
  serial_number text,
  asset_tag text,
  type text not null default 'Laptop',
  manufacturer text,
  model text,
  os text,
  status text not null default 'in_stock',
  location text,
  notes text,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_status_valid check (
    status in ('in_stock', 'deployed', 'in_repair', 'retired', 'lost', 'surplus')
  ),
  constraint devices_source_valid check (source in ('manual', 'import')),
  -- Applied after normalisation, so a row whose only identifier was whitespace
  -- is refused rather than stored as an unidentifiable machine.
  constraint devices_has_identifier check (
    coalesce(device_id, serial_number, asset_tag) is not null
  )
);

comment on table public.devices is
  'Every machine the school lends out. Never writable from a session: app_upsert_device, app_assign_device, app_return_device, app_set_device_status, app_move_device and app_bulk_update_devices are the only ways in.';
comment on column public.devices.device_id is
  'The managed-device identifier from the source spreadsheet. Stored trimmed and upper-cased.';
comment on column public.devices.status is
  'One of in_stock, deployed, in_repair, retired, lost, surplus. `deployed` means, and only means, that an open row in device_assignments names its holder.';
comment on column public.devices.source is
  'Whether this row was typed in by a technician or came from an inventory import.';

-- Identifiers are unique WHERE PRESENT, and unique by VALUE rather than by
-- typing: the expression matches the upper-casing app_upsert_device does, so the
-- rule still holds for any row that reaches the table by another route.
create unique index devices_device_id_idx on public.devices (upper(device_id))
  where device_id is not null;
create unique index devices_serial_idx on public.devices (upper(serial_number))
  where serial_number is not null;
create unique index devices_asset_tag_idx on public.devices (upper(asset_tag))
  where asset_tag is not null;

-- DROPPED by 20260912100510_m5_search_fixes.sql, on the terms set here. This
-- index was created for Task 11's app_search, reachable only from a predicate
-- written over this identical expression, and was meant to let the lookup bar
-- find a machine from the middle of a serial. Task 11 measured that predicate
-- before adopting it and it does not do that: similarity() divides shared
-- trigrams by the union of both strings, so a short query against a long
-- concatenation scores far below the threshold and matches NOTHING, while two
-- long concatenations that share their shape — every asset tag starting `DOE-` —
-- match each other whatever the identifiers are. Read 100510 for the numbers and
-- for what the capability actually needs (word_similarity, `<%`). The statement
-- below is kept as applied; the index it creates no longer exists.
--
-- app_list_devices below cannot use it and does not try: its search is one OR
-- group whose first branch tests the search term rather than a column.
create index devices_search_trgm on public.devices using gin (
  (
    coalesce(device_id, '') || ' ' || coalesce(serial_number, '') || ' ' ||
    coalesce(asset_tag, '') || ' ' || coalesce(model, '')
  ) extensions.gin_trgm_ops
);

-- The order app_list_devices always returns, and the two filters the inventory
-- screen offers beside it.
create index devices_updated_idx on public.devices (updated_at desc, id);
create index devices_status_idx on public.devices (status);
create index devices_location_idx on public.devices (location) where location is not null;

-- ---------------------------------------------------------------------------
-- Loans
-- ---------------------------------------------------------------------------

create table public.device_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  device_id uuid not null references public.devices (id) on delete cascade,
  -- RESTRICT: a person who has held a device cannot be deleted out from under
  -- the loan that names them. People are archived, never deleted.
  person_id uuid not null references public.people (id) on delete restrict,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references public.app_accounts (id) on delete restrict,
  returned_at timestamptz,
  returned_by uuid references public.app_accounts (id) on delete restrict,
  note text
);

comment on table public.device_assignments is
  'The loan history of every device. A row with returned_at NULL is a device somebody is holding right now; closed rows are kept forever.';

-- The invariant, enforced rather than assumed: at most one open loan per device.
-- Two technicians assigning the same laptop at the same instant cannot both
-- succeed, whatever the application does.
create unique index device_assignments_open_idx
  on public.device_assignments (device_id)
  where returned_at is null;

create index device_assignments_person_idx
  on public.device_assignments (person_id, assigned_at desc);

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- The name of an account, for rendering historical attribution ("Dev Okafor
-- assigned this laptop"). Needed because the reads below are SECURITY INVOKER
-- and app_accounts shows a technician only their own row, so a plain join would
-- render every other technician's action as if nobody had performed it.
--
-- The version below is WRONG and is superseded by
-- 20260912100310_m5_devices_fixes.sql. It claimed to expose no more than
-- app_directory() does, but app_directory() omits accounts whose status is
-- `pending_approval` or `denied` and this did not, so feeding it uuids turned it
-- into a name-for-uuid oracle over precisely the accounts that are meant to stay
-- invisible. Read that file for the current body.
create function public.app_account_label(p_account uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.display_name
  from public.app_accounts a
  where a.id = p_account
    and public.app_active_account_id() is not null;
$$;

comment on function public.app_account_label(uuid) is
  'One account''s display name, for attribution in device history. NULL for an unknown account or a caller who is not active.';

-- Closes whatever loan is open on a device and reports who had it. Returns NULL
-- when nobody did, which is how app_return_device distinguishes "returned" from
-- "there was nothing to return" without a second query racing the first.
create function public.app_close_device_assignment(p_device uuid, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid;
begin
  update public.device_assignments a
  set returned_at = pg_catalog.now(),
      returned_by = p_actor
  where a.device_id = p_device
    and a.returned_at is null
  returning a.person_id into v_person;

  return v_person;
end;
$$;

comment on function public.app_close_device_assignment(uuid, uuid) is
  'Trusted internal helper: closes the open loan on a device and returns the holder''s person id, or NULL when there was no open loan. Never callable from a session.';

-- ---------------------------------------------------------------------------
-- Reads. SECURITY INVOKER (the default) on purpose: they run with the caller's
-- privileges, so the row policies below decide which rows they can return and
-- nothing here can hand out a device, a loan or a holder the caller may not see.
-- ---------------------------------------------------------------------------

create function public.app_list_devices(
  p_query text default null,
  p_type text default null,
  p_status text default null,
  p_location text default null,
  p_holder_kind text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  device_id text,
  serial_number text,
  asset_tag text,
  type text,
  manufacturer text,
  model text,
  os text,
  status text,
  location text,
  holder_id uuid,
  holder_name text,
  holder_kind text,
  updated_at timestamptz,
  total_count bigint
)
language sql
stable
set search_path = ''
as $$
  with q as (
    select nullif(pg_catalog.btrim(coalesce(p_query, '')), '') as raw
  ),
  term as (
    select
      q.raw,
      -- What an operator typed into a search box is TEXT. Without this, `%`
      -- would match the whole inventory and an underscore in an asset tag would
      -- match any character. Backslash is escaped first, or it would escape the
      -- escapes added after it.
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(q.raw, '\', '\\'),
          '%', '\%'
        ),
        '_', '\_'
      ) as pattern
    from q
  ),
  held as (
    select a.device_id,
           a.person_id as holder_id,
           h.display_name as holder_name,
           h.kind as holder_kind
    from public.device_assignments a
    join public.people h on h.id = a.person_id
    where a.returned_at is null
  ),
  filtered as (
    select d.*, x.holder_id, x.holder_name, x.holder_kind
    from public.devices d
    left join held x on x.device_id = d.id
    cross join term t
    -- NULL means "every value of this field", not "no value": the inventory
    -- screen sends nothing for a filter it is not applying.
    where (p_type is null or d.type = p_type)
      and (p_status is null or d.status = p_status)
      and (p_location is null or d.location = p_location)
      -- Fails closed: a holder kind that is not one of the three matches
      -- nothing rather than silently meaning "no filter".
      and (
        p_holder_kind is null
        or (p_holder_kind = 'none' and x.holder_id is null)
        or (p_holder_kind in ('student', 'staff') and x.holder_kind = p_holder_kind)
      )
      and (
        t.raw is null
        -- An identifier is matched from its START, the way an operator reads one
        -- off a label; a model is matched anywhere in it, so "Flex" finds an
        -- IdeaPad Flex.
        or d.device_id ilike t.pattern || '%' escape '\'
        or d.serial_number ilike t.pattern || '%' escape '\'
        or d.asset_tag ilike t.pattern || '%' escape '\'
        or d.model ilike '%' || t.pattern || '%' escape '\'
      )
  )
  select f.id, f.device_id, f.serial_number, f.asset_tag, f.type, f.manufacturer,
         f.model, f.os, f.status, f.location,
         f.holder_id, f.holder_name, f.holder_kind, f.updated_at,
         -- Window count over the same filtered, RLS-limited set, so a page total
         -- can never reveal the existence of rows the caller cannot see.
         pg_catalog.count(*) over () as total_count
  from filtered f
  -- id breaks ties so paging is deterministic when two devices were touched in
  -- the same instant, which a bulk change makes routine.
  order by f.updated_at desc, f.id
  -- Floor of zero, not one: a screen that wants only the total says so by
  -- passing 0.
  limit greatest(0, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.app_list_devices(text, text, text, text, text, integer, integer) is
  'SECURITY INVOKER inventory reader: RLS decides the rows, SQL does the search, filtering, ordering, counting and pagination. Identifiers match from their start, models anywhere; LIKE metacharacters in the query are literal text. Returns nothing to an account that is not active.';

-- One device with its holder, its whole loan history and its events.
create function public.app_device_detail(p_device uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'device', pg_catalog.to_jsonb(d),
    'holder', (
      select pg_catalog.jsonb_build_object(
        'id', h.id,
        'display_name', h.display_name,
        'kind', h.kind,
        'assigned_at', a.assigned_at
      )
      from public.device_assignments a
      join public.people h on h.id = a.person_id
      where a.device_id = d.id and a.returned_at is null
    ),
    'assignments', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'person_id', a.person_id,
          'person_name', h.display_name,
          'person_kind', h.kind,
          'assigned_at', a.assigned_at,
          'assigned_by_name', public.app_account_label(a.assigned_by),
          'returned_at', a.returned_at,
          'returned_by_name', public.app_account_label(a.returned_by),
          'note', a.note
        )
        order by a.assigned_at desc, a.id desc
      )
      from public.device_assignments a
      left join public.people h on h.id = a.person_id
      where a.device_id = d.id
    ), '[]'::jsonb),
    -- Task 10 fills this in through the ticket/device link. Present and EMPTY
    -- rather than absent, so the application reads one shape throughout M5.
    'tickets', '[]'::jsonb,
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.at desc, e.id desc)
      from public.record_events e
      where e.entity_type = 'device' and e.entity_id = d.id
    ), '[]'::jsonb)
  )
  from public.devices d
  where d.id = p_device;
$$;

comment on function public.app_device_detail(uuid) is
  'One device with its current holder, its loan history newest first, and its events newest first. NULL when there is no such device or the caller may not see it. tickets is empty until Task 10 recreates this function.';

-- The filter options the inventory screen offers. Types and locations come from
-- the rows themselves; the statuses are a fixed vocabulary in a fixed order, so
-- the screen shows the same six chips whether or not the school happens to own a
-- lost laptop today.
create function public.app_device_facets()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'types', coalesce((
      select pg_catalog.jsonb_agg(t.type order by t.type)
      from (select distinct d.type from public.devices d where d.type is not null) t
    ), '[]'::jsonb),
    'statuses', pg_catalog.jsonb_build_array(
      'in_stock', 'deployed', 'in_repair', 'retired', 'lost', 'surplus'
    ),
    'locations', coalesce((
      select pg_catalog.jsonb_agg(l.location order by l.location)
      from (select distinct d.location from public.devices d where d.location is not null) l
    ), '[]'::jsonb)
  );
$$;

comment on function public.app_device_facets() is
  'Sorted, distinct device types and locations across the inventory, plus the six statuses in their fixed order. Types and locations are empty for an account that is not active, because RLS hides every device from it.';

-- ---------------------------------------------------------------------------
-- app_person_detail, recreated with the device join.
--
-- Same signature, same grants, same everything else: only `devices` changes from
-- a hard-coded empty array to the person's loans, current ones first and newest
-- first within that. `tickets` stays empty until Task 10.
-- ---------------------------------------------------------------------------

create or replace function public.app_person_detail(p_person uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'person', pg_catalog.to_jsonb(p),
    'devices', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'assignment_id', a.id,
          'assigned_at', a.assigned_at,
          'returned_at', a.returned_at,
          'device', pg_catalog.jsonb_build_object(
            'id', d.id,
            'device_id', d.device_id,
            'serial_number', d.serial_number,
            'asset_tag', d.asset_tag,
            'type', d.type,
            'model', d.model,
            'status', d.status
          )
        )
        -- What they have now, then what they used to have, newest first within
        -- each group.
        order by (a.returned_at is not null), a.assigned_at desc, a.id desc
      )
      from public.device_assignments a
      join public.devices d on d.id = a.device_id
      where a.person_id = p.id
    ), '[]'::jsonb),
    'tickets', '[]'::jsonb,
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.at, e.id)
      from public.record_events e
      where e.entity_type = 'person' and e.entity_id = p.id
    ), '[]'::jsonb)
  )
  from public.people p
  where p.id = p_person;
$$;

comment on function public.app_person_detail(uuid) is
  'One directory record with its devices and its history. Devices are the person''s loans, the ones they hold now first. NULL when there is no such person or the caller may not see them. tickets is empty until Task 10 recreates this function.';

-- ---------------------------------------------------------------------------
-- Writes. SECURITY DEFINER, actor re-derived inside the database.
-- ---------------------------------------------------------------------------

create function public.app_upsert_device(p_device jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Every column a caller may set, in the order changes are reported in.
  --
  -- `status` IS here: which shelf a machine is on is ordinary helpdesk work, not
  -- an administrator's decision, so there is no reason to make a technician
  -- reach for a second call to mark a laptop surplus. It still goes through the
  -- deployment guard below, so allowing it here does not weaken the invariant.
  -- `id` selects the row rather than being written, and created_at/updated_at
  -- belong to the database.
  c_writable constant text[] := array[
    'device_id', 'serial_number', 'asset_tag', 'type', 'manufacturer', 'model',
    'os', 'status', 'location', 'notes', 'source'
  ];
  v_actor public.app_accounts;
  v_key text;
  v_clean jsonb := '{}'::jsonb;
  v_before public.devices;
  v_after public.devices;
  v_changed text[] := '{}'::text[];
  v_is_insert boolean;
  v_id uuid;
  v_label text;
  v_held boolean;
  v_constraint text;
begin
  v_actor := public.app_require_actor();

  if p_device is null or pg_catalog.jsonb_typeof(p_device) <> 'object' then
    raise exception 'Send the device''s details as an object of fields.'
      using errcode = 'check_violation';
  end if;

  -- Known keys only, and an unknown one is IGNORED rather than refused: an
  -- import row carrying a warranty date the inventory does not keep must not
  -- fail over it. Every value is trimmed, and a value that is empty after
  -- trimming becomes a JSON null — a blank spreadsheet cell is an absent value,
  -- not the empty string. The key stays present either way, which is what lets
  -- an update distinguish "clear this field" from "leave it alone".
  foreach v_key in array c_writable loop
    if p_device ? v_key then
      v_clean := v_clean || pg_catalog.jsonb_build_object(
        v_key,
        nullif(pg_catalog.btrim(coalesce(p_device ->> v_key, '')), '')
      );
    end if;
  end loop;

  -- Identifiers, folded to the one spelling the table stores, so the unique
  -- indexes are rules about machines rather than about typing.
  foreach v_key in array array['device_id', 'serial_number', 'asset_tag'] loop
    if v_clean ? v_key then
      v_clean := v_clean || pg_catalog.jsonb_build_object(
        v_key,
        nullif(pg_catalog.upper(coalesce(v_clean ->> v_key, '')), '')
      );
    end if;
  end loop;
  foreach v_key in array array['status', 'source'] loop
    if v_clean ? v_key then
      v_clean := v_clean || pg_catalog.jsonb_build_object(
        v_key,
        nullif(pg_catalog.lower(coalesce(v_clean ->> v_key, '')), '')
      );
    end if;
  end loop;

  -- An id selects an existing device; its absence means a new one.
  if nullif(pg_catalog.btrim(coalesce(p_device ->> 'id', '')), '') is not null then
    if not pg_catalog.pg_input_is_valid(p_device ->> 'id', 'uuid') then
      raise exception 'That is not a device record id.' using errcode = 'check_violation';
    end if;
    v_id := (p_device ->> 'id')::uuid;
  end if;
  v_is_insert := v_id is null;

  if v_is_insert then
    -- The row a new device starts from: the table's own defaults, so the change
    -- list below reports what the caller actually supplied.
    v_before.id := extensions.gen_random_uuid();
    v_before.type := 'Laptop';
    v_before.status := 'in_stock';
    v_before.source := 'manual';
  else
    -- SECURITY DEFINER, so this read is not under RLS. That is deliberate and
    -- safe: app_require_actor above has already established an active account,
    -- and an active account may read every device anyway. FOR UPDATE so the
    -- deployment guard below cannot race a concurrent assignment.
    select * into v_before from public.devices d where d.id = v_id for update;
    if not found then
      raise exception 'That device is not in the inventory. Search for it again.'
        using errcode = 'no_data_found';
    end if;
  end if;

  -- Merge: a key that was not sent keeps the value it had.
  v_after := v_before;
  if v_clean ? 'device_id' then v_after.device_id := v_clean ->> 'device_id'; end if;
  if v_clean ? 'serial_number' then v_after.serial_number := v_clean ->> 'serial_number'; end if;
  if v_clean ? 'asset_tag' then v_after.asset_tag := v_clean ->> 'asset_tag'; end if;
  if v_clean ? 'manufacturer' then v_after.manufacturer := v_clean ->> 'manufacturer'; end if;
  if v_clean ? 'model' then v_after.model := v_clean ->> 'model'; end if;
  if v_clean ? 'os' then v_after.os := v_clean ->> 'os'; end if;
  if v_clean ? 'location' then v_after.location := v_clean ->> 'location'; end if;
  if v_clean ? 'notes' then v_after.notes := v_clean ->> 'notes'; end if;
  -- type, status and source are not nullable and have no blank meaning, so an
  -- empty one is left alone like every other field sent empty rather than
  -- resetting the row to a default nobody asked for.
  if v_clean ? 'type' and v_clean ->> 'type' is not null then
    v_after.type := v_clean ->> 'type';
  end if;
  if v_clean ? 'status' and v_clean ->> 'status' is not null then
    v_after.status := v_clean ->> 'status';
  end if;
  if v_clean ? 'source' and v_clean ->> 'source' is not null then
    v_after.source := v_clean ->> 'source';
  end if;

  -- Validation, in the order an operator would notice the problem. Each message
  -- says what is wrong and what to do; the column checks behind them are the
  -- backstop, not the thing the operator is meant to read.
  if coalesce(v_after.device_id, v_after.serial_number, v_after.asset_tag) is null then
    raise exception 'Enter a device id, serial number or asset tag so this machine can be identified.'
      using errcode = 'check_violation';
  end if;
  if v_after.status not in ('in_stock', 'deployed', 'in_repair', 'retired', 'lost', 'surplus') then
    raise exception 'Choose a device status: in stock, deployed, in repair, retired, lost or surplus.'
      using errcode = 'check_violation';
  end if;
  if v_after.source not in ('manual', 'import') then
    raise exception 'A device record is either entered by hand or imported.'
      using errcode = 'check_violation';
  end if;

  -- The deployment invariant, applied to a status CHANGE only: re-sending the
  -- status a device already has is not an attempt to change anything, so an edit
  -- form that posts every field back is not punished for it.
  if v_after.status is distinct from v_before.status then
    v_held := not v_is_insert and exists (
      select 1 from public.device_assignments a
      where a.device_id = v_id and a.returned_at is null
    );
    if v_after.status = 'deployed' and not v_held then
      raise exception 'A device is deployed once somebody is holding it. Assign it to a person instead.'
        using errcode = 'check_violation';
    end if;
    if v_after.status <> 'deployed' and v_held then
      raise exception 'This device is still assigned to someone. Return it first, and choose the status it came back in.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- What actually changed, by FIELD NAME. Compared through jsonb so the list
  -- cannot drift out of step with c_writable, and ordered by c_writable so the
  -- history reads the same way every time.
  select coalesce(pg_catalog.array_agg(w.key order by w.ord), '{}'::text[])
  into v_changed
  from pg_catalog.unnest(c_writable) with ordinality as w(key, ord)
  where (pg_catalog.to_jsonb(v_before) ->> w.key)
    is distinct from (pg_catalog.to_jsonb(v_after) ->> w.key);

  -- An update that changes nothing is a no-op: it neither touches the row nor
  -- writes a history entry saying that nothing happened.
  if not v_is_insert and pg_catalog.cardinality(v_changed) = 0 then
    return v_id;
  end if;

  if v_is_insert then
    insert into public.devices (
      id, device_id, serial_number, asset_tag, type, manufacturer, model, os,
      status, location, notes, source
    ) values (
      v_before.id, v_after.device_id, v_after.serial_number, v_after.asset_tag,
      v_after.type, v_after.manufacturer, v_after.model, v_after.os,
      v_after.status, v_after.location, v_after.notes, v_after.source
    );
    v_id := v_before.id;
  else
    update public.devices d set
      device_id = v_after.device_id,
      serial_number = v_after.serial_number,
      asset_tag = v_after.asset_tag,
      type = v_after.type,
      manufacturer = v_after.manufacturer,
      model = v_after.model,
      os = v_after.os,
      status = v_after.status,
      location = v_after.location,
      notes = v_after.notes,
      source = v_after.source,
      updated_at = pg_catalog.now()
    where d.id = v_id;
  end if;

  v_label := coalesce(v_after.asset_tag, v_after.serial_number, v_after.device_id);

  perform public.app_log_record_event(
    'device',
    v_id,
    case when v_is_insert then 'created' else 'updated' end,
    v_actor.id,
    case
      when v_is_insert then 'Added ' || v_label || ' to the inventory.'
      else 'Updated ' || v_label || '.'
    end,
    pg_catalog.array_to_string(v_changed, ', ')
  );

  return v_id;

exception
  -- The three identifier indexes are the ones an operator collides with, and
  -- "duplicate key value violates unique constraint devices_serial_idx" tells
  -- them nothing they can act on.
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'devices_device_id_idx' then
      raise exception 'Another device already has device id %. Search for it to see which machine that is.',
        v_after.device_id using errcode = 'unique_violation';
    elsif v_constraint = 'devices_serial_idx' then
      raise exception 'Another device already has serial number %. Search for it to see which machine that is.',
        v_after.serial_number using errcode = 'unique_violation';
    elsif v_constraint = 'devices_asset_tag_idx' then
      raise exception 'Another device already has asset tag %. Search for it to see which machine that is.',
        v_after.asset_tag using errcode = 'unique_violation';
    else
      raise;
    end if;
end;
$$;

comment on function public.app_upsert_device(jsonb) is
  'Adds or corrects one device. Keys are column names; unknown keys are ignored; an absent key is left alone and an empty one is cleared. Identifiers are trimmed and upper-cased. `status` may be sent, but a status change still has to agree with who is holding the device.';

-- Superseded by 20260912100310_m5_devices_fixes.sql, which recreates this
-- function so that re-assigning a device to the person who already has it is a
-- no-op returning the existing loan, instead of closing that loan and opening an
-- identical one. Read that file for the current body.
create function public.app_assign_device(
  p_device uuid,
  p_person uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_device public.devices;
  v_person public.people;
  v_previous uuid;
  v_previous_name text;
  v_label text;
  v_note text;
  v_assignment uuid;
begin
  v_actor := public.app_require_actor();

  -- FOR UPDATE first: two technicians handing out the same laptop at the same
  -- moment serialise here rather than racing to insert two open loans.
  select * into v_device from public.devices d where d.id = p_device for update;
  if not found then
    raise exception 'That device is not in the inventory. Search for it again.'
      using errcode = 'no_data_found';
  end if;

  select * into v_person from public.people p where p.id = p_person;
  if not found then
    raise exception 'That person is not in the directory. Search for them again.'
      using errcode = 'no_data_found';
  end if;
  -- Archiving is what decides who can still be chosen as a device holder, so an
  -- archived record cannot take delivery of a new machine.
  if not v_person.active then
    raise exception 'That directory record is archived. Restore it before assigning a device.'
      using errcode = 'check_violation';
  end if;

  v_note := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_label := coalesce(v_device.asset_tag, v_device.serial_number, v_device.device_id);

  -- Whoever had it gives it up first, so the unique open-loan index never has
  -- two rows to choose between.
  v_previous := public.app_close_device_assignment(p_device, v_actor.id);
  if v_previous is not null then
    select p.display_name into v_previous_name from public.people p where p.id = v_previous;
    -- The person losing the device is told so in their own history. The device
    -- gets ONE event for the handover rather than a return and an assignment
    -- sharing an instant, because two events written in the same transaction
    -- carry the same timestamp and could not be ordered against each other.
    perform public.app_log_record_event(
      'person', v_previous, 'device_returned', v_actor.id,
      v_label || ' returned.'
    );
  end if;

  insert into public.device_assignments (device_id, person_id, assigned_by, note)
  values (p_device, p_person, v_actor.id, v_note)
  returning id into v_assignment;

  update public.devices d
  set status = 'deployed', updated_at = pg_catalog.now()
  where d.id = p_device;

  perform public.app_log_record_event(
    'device', p_device, 'assigned', v_actor.id,
    'Assigned to ' || v_person.display_name || '.',
    pg_catalog.concat_ws(
      ' ',
      case when v_previous_name is not null then 'Taken back from ' || v_previous_name || '.' end,
      v_note
    )
  );
  perform public.app_log_record_event(
    'person', p_person, 'device_assigned', v_actor.id,
    v_label || ' assigned.',
    v_note
  );

  return v_assignment;
end;
$$;

comment on function public.app_assign_device(uuid, uuid, text) is
  'Hands a device to a person. Closes whatever loan was open on it first, marks the device deployed, and records the handover on the device and on everyone it passed between. Returns the new assignment id.';

create function public.app_return_device(
  p_device uuid,
  p_status text default 'in_stock',
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_device public.devices;
  v_status text;
  v_previous uuid;
  v_previous_name text;
  v_label text;
  v_note text;
begin
  v_actor := public.app_require_actor();

  v_status := coalesce(
    nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, ''))), ''),
    'in_stock'
  );
  if v_status not in ('in_stock', 'in_repair', 'retired', 'lost', 'surplus') then
    if v_status = 'deployed' then
      raise exception 'A device that has come back is not deployed. Choose in stock, in repair, retired, lost or surplus.'
        using errcode = 'check_violation';
    end if;
    raise exception 'Choose the status this device came back in: in stock, in repair, retired, lost or surplus.'
      using errcode = 'check_violation';
  end if;

  select * into v_device from public.devices d where d.id = p_device for update;
  if not found then
    raise exception 'That device is not in the inventory. Search for it again.'
      using errcode = 'no_data_found';
  end if;

  v_previous := public.app_close_device_assignment(p_device, v_actor.id);
  if v_previous is null then
    raise exception 'This device is not assigned to anyone.' using errcode = 'check_violation';
  end if;

  select p.display_name into v_previous_name from public.people p where p.id = v_previous;
  v_note := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_label := coalesce(v_device.asset_tag, v_device.serial_number, v_device.device_id);

  update public.devices d
  set status = v_status, updated_at = pg_catalog.now()
  where d.id = p_device;

  -- One event, carrying the status it came back in, for the same reason
  -- app_assign_device writes one: events written in the same transaction share a
  -- timestamp and cannot be ordered against each other afterwards.
  perform public.app_log_record_event(
    'device', p_device, 'returned', v_actor.id,
    case
      when v_status = 'in_stock' then 'Returned from ' || v_previous_name || '.'
      else 'Returned from ' || v_previous_name || ' and marked '
        || pg_catalog.replace(v_status, '_', ' ') || '.'
    end,
    v_note
  );
  perform public.app_log_record_event(
    'person', v_previous, 'device_returned', v_actor.id,
    v_label || ' returned.',
    v_note
  );
end;
$$;

comment on function public.app_return_device(uuid, text, text) is
  'Takes a device back from whoever is holding it and sets the status it came back in. Refuses when nobody is holding it, and refuses `deployed`, which is what having a holder means.';

create function public.app_set_device_status(
  p_device uuid,
  p_status text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_device public.devices;
  v_status text;
  v_held boolean;
begin
  v_actor := public.app_require_actor();

  v_status := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, ''))), '');
  if v_status is null
    or v_status not in ('in_stock', 'deployed', 'in_repair', 'retired', 'lost', 'surplus')
  then
    raise exception 'Choose a device status: in stock, deployed, in repair, retired, lost or surplus.'
      using errcode = 'check_violation';
  end if;

  select * into v_device from public.devices d where d.id = p_device for update;
  if not found then
    raise exception 'That device is not in the inventory. Search for it again.'
      using errcode = 'no_data_found';
  end if;

  -- Already there. Nothing changed, so nothing is recorded.
  if v_device.status = v_status then
    return;
  end if;

  v_held := exists (
    select 1 from public.device_assignments a
    where a.device_id = p_device and a.returned_at is null
  );
  if v_status = 'deployed' and not v_held then
    raise exception 'A device is deployed once somebody is holding it. Assign it to a person instead.'
      using errcode = 'check_violation';
  end if;
  if v_status <> 'deployed' and v_held then
    raise exception 'This device is still assigned to someone. Return it first, and choose the status it came back in.'
      using errcode = 'check_violation';
  end if;

  update public.devices d
  set status = v_status, updated_at = pg_catalog.now()
  where d.id = p_device;

  perform public.app_log_record_event(
    'device', p_device, 'status_changed', v_actor.id,
    'Status changed from ' || pg_catalog.replace(v_device.status, '_', ' ')
      || ' to ' || pg_catalog.replace(v_status, '_', ' ') || '.',
    p_reason
  );
end;
$$;

comment on function public.app_set_device_status(uuid, text, text) is
  'Sets a device''s status. Refuses `deployed` unless somebody is holding it, and refuses to move it out of `deployed` while somebody still is: that is app_return_device''s job.';

create function public.app_move_device(p_device uuid, p_location text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_device public.devices;
  v_location text;
begin
  v_actor := public.app_require_actor();

  v_location := nullif(pg_catalog.btrim(coalesce(p_location, '')), '');

  select * into v_device from public.devices d where d.id = p_device for update;
  if not found then
    raise exception 'That device is not in the inventory. Search for it again.'
      using errcode = 'no_data_found';
  end if;

  -- Already there. Nothing changed, so nothing is recorded.
  if v_device.location is not distinct from v_location then
    return;
  end if;

  update public.devices d
  set location = v_location, updated_at = pg_catalog.now()
  where d.id = p_device;

  perform public.app_log_record_event(
    'device', p_device, 'moved', v_actor.id,
    case
      when v_location is null then 'Location cleared.'
      else 'Moved to ' || v_location || '.'
    end
  );
end;
$$;

comment on function public.app_move_device(uuid, text) is
  'Records where a device now lives. An empty location clears it. Changes and records nothing when the device is already there.';

-- One change applied to a selection from the inventory screen.
--
-- Superseded by 20260912100310_m5_devices_fixes.sql, which recreates this
-- function so a failure names the device that refused, the ids are locked in a
-- total order, the pre-reads take the row lock they decide from, and a patch
-- carrying both `person_id` and `status` is refused rather than half-applied.
-- Read that file for the current body.
--
-- All or nothing: this is one function, so one device that cannot take the
-- change rolls the whole selection back rather than leaving an operator to work
-- out which half of 300 machines was updated.
create function public.app_bulk_update_devices(p_ids uuid[], p_patch jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_id uuid;
  v_status text;
  v_location text;
  v_person uuid;
  v_return boolean := false;
  v_has_location boolean;
  v_changed integer := 0;
  v_touched boolean;
  v_device public.devices;
begin
  v_actor := public.app_require_actor();

  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Send the change as an object of fields.' using errcode = 'check_violation';
  end if;

  -- Checked before anything is looked up, so a runaway selection is refused
  -- cheaply rather than after 5,000 row locks.
  if pg_catalog.cardinality(coalesce(p_ids, '{}'::uuid[])) > 500 then
    raise exception 'Change 500 devices or fewer at a time. Narrow the selection and try again.'
      using errcode = 'check_violation';
  end if;

  v_status := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_patch ->> 'status', ''))), '');
  v_has_location := p_patch ? 'location';
  v_location := nullif(pg_catalog.btrim(coalesce(p_patch ->> 'location', '')), '');

  if p_patch ? 'person_id' then
    if not pg_catalog.pg_input_is_valid(coalesce(p_patch ->> 'person_id', ''), 'uuid') then
      raise exception 'That is not a directory record id.' using errcode = 'check_violation';
    end if;
    v_person := (p_patch ->> 'person_id')::uuid;
  end if;

  if p_patch ? 'return' then
    v_return := pg_catalog.lower(coalesce(p_patch ->> 'return', '')) in ('true', 't', 'yes', '1');
  end if;

  if v_return and v_person is not null then
    raise exception 'Choose either assigning these devices or returning them, not both.'
      using errcode = 'check_violation';
  end if;
  if not v_return and v_person is null and v_status is null and not v_has_location then
    raise exception 'Choose what to change for the selected devices.'
      using errcode = 'check_violation';
  end if;

  -- Distinct, so a selection that repeats an id is not applied to it twice, and
  -- NULLs are dropped rather than looked up.
  for v_id in
    select distinct x.id from pg_catalog.unnest(coalesce(p_ids, '{}'::uuid[])) as x(id)
    where x.id is not null
  loop
    v_touched := false;

    if v_return then
      perform public.app_return_device(v_id, coalesce(v_status, 'in_stock'), null);
      v_touched := true;
    elsif v_person is not null then
      perform public.app_assign_device(v_id, v_person, null);
      v_touched := true;
    elsif v_status is not null then
      select * into v_device from public.devices d where d.id = v_id;
      if not found then
        raise exception 'That device is not in the inventory. Search for it again.'
          using errcode = 'no_data_found';
      end if;
      if v_device.status is distinct from v_status then
        perform public.app_set_device_status(v_id, v_status, p_patch ->> 'reason');
        v_touched := true;
      end if;
    end if;

    if v_has_location then
      select * into v_device from public.devices d where d.id = v_id;
      if not found then
        raise exception 'That device is not in the inventory. Search for it again.'
          using errcode = 'no_data_found';
      end if;
      if v_device.location is distinct from v_location then
        perform public.app_move_device(v_id, v_location);
        v_touched := true;
      end if;
    end if;

    if v_touched then
      v_changed := v_changed + 1;
    end if;
  end loop;

  return v_changed;
end;
$$;

comment on function public.app_bulk_update_devices(uuid[], jsonb) is
  'Applies one change to up to 500 devices: status, location, person_id (assign each) or return (take each back, in the status given by `status`). Returns how many devices actually changed, records an event per device, and applies nothing at all if any device refuses.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.devices enable row level security;
alter table public.device_assignments enable row level security;

-- An assignment row names a student, so the inventory is gated exactly as the
-- directory is. app_active_account_id() returns NULL for an anonymous,
-- inactive, setup_pending, pending_approval, denied, credential-pending or
-- stale-token caller, so the comparison fails closed rather than open.
create policy devices_select_active
  on public.devices for select to authenticated
  using (public.app_active_account_id() is not null);

create policy device_assignments_select_active
  on public.device_assignments for select to authenticated
  using (public.app_active_account_id() is not null);

-- Deliberately absent: INSERT, UPDATE and DELETE policies on both tables. Every
-- change goes through the RPCs above, so every change is attributed and
-- recorded, and a loan is closed rather than erased.

-- ---------------------------------------------------------------------------
-- Grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so both tables are revoked explicitly and then re-granted
-- read-only. anon gets nothing at all.
-- ---------------------------------------------------------------------------

revoke all on table public.devices, public.device_assignments from anon, authenticated;
grant select on table public.devices, public.device_assignments to authenticated;

-- The internal helper is callable only by the functions that own it. service_role
-- is named explicitly: Supabase's default privileges grant ALL ON FUNCTIONS to
-- it directly, so it does not lose EXECUTE when the grant to PUBLIC is revoked.
revoke execute on function
  public.app_close_device_assignment(uuid, uuid)
from public, anon, authenticated, service_role;

revoke execute on function
  public.app_account_label(uuid),
  public.app_list_devices(text, text, text, text, text, integer, integer),
  public.app_device_detail(uuid),
  public.app_device_facets(),
  public.app_upsert_device(jsonb),
  public.app_assign_device(uuid, uuid, text),
  public.app_return_device(uuid, text, text),
  public.app_set_device_status(uuid, text, text),
  public.app_move_device(uuid, text),
  public.app_bulk_update_devices(uuid[], jsonb)
from public, anon;

grant execute on function
  public.app_account_label(uuid),
  public.app_list_devices(text, text, text, text, text, integer, integer),
  public.app_device_detail(uuid),
  public.app_device_facets(),
  public.app_upsert_device(jsonb),
  public.app_assign_device(uuid, uuid, text),
  public.app_return_device(uuid, text, text),
  public.app_set_device_status(uuid, text, text),
  public.app_move_device(uuid, text),
  public.app_bulk_update_devices(uuid[], jsonb)
to authenticated;

-- app_person_detail keeps the ACL `create or replace` preserved; restated so
-- this file says in full who may call the function it recreated.
revoke execute on function public.app_person_detail(uuid) from public, anon;
grant execute on function public.app_person_detail(uuid) to authenticated;
