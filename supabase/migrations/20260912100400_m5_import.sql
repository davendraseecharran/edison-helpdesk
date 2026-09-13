-- M5: bringing the school's spreadsheets into the directory and the inventory.
--
-- The roster and the inventory live in AppSheet tabs today: roughly 2,800
-- people and 7,500 machines that nobody is going to retype. `src/lib/import`
-- parses a CSV and folds every cell to the one spelling the database stores;
-- this migration takes those rows and writes them.
--
-- Additive only, and every earlier rule stays in force: identity is auth.uid()
-- only, clients get SELECT and nothing else, every write goes through a SECURITY
-- DEFINER RPC that re-derives the actor inside the database, and history is
-- append-only.
--
-- Five decisions shape everything below.
--
-- 1. The dry run is the real thing, rolled back. An operator decides whether to
--    commit by reading counts, so those counts must come from the writes that
--    would actually happen rather than from a second implementation that can
--    drift from the first. The whole pass runs inside a nested block — a
--    savepoint — and a dry run ends by raising a private SQLSTATE that the
--    enclosing handler catches, which rolls the savepoint back. PL/pgSQL
--    variables are memory rather than database state, so the counts survive the
--    rollback and are returned; every row, event and assignment written on the
--    way is gone.
--
-- 2. One bad row must not lose the file. Each row is processed in its own
--    nested block, so a failure is caught, recorded against the row's 1-based
--    position in the file the operator is looking at, and the import carries on.
--    That is also why this function does NOT call app_upsert_person and
--    app_upsert_device row by row: those raise on the first bad row, and an
--    importer that stops at row 12 of 2,800 is not an importer. The writes here
--    are direct, and they repeat those functions' normalisation rules, their
--    validation messages and their duplicate-identifier wording deliberately, so
--    an operator sees the same sentence whichever door the data came through.
--
-- 3. An absent or blank cell means "leave this alone", not "clear this".
--    app_upsert_person treats a key sent empty as a field to clear, because a
--    person cleared a box on a form. A spreadsheet is the other way round: a
--    column the sheet does not carry is not an instruction to erase what the
--    helpdesk knows. So only the non-null values in a row are applied, and
--    `unchanged` means every value the row did supply already matched.
--
-- 4. The import cannot reach past what it is for.
--      * It never writes `active`. Archiving is app_set_person_active, an
--        administrator's decision from the person page, and a row carrying the
--        key is refused rather than ignored — the same answer app_upsert_person
--        gives.
--      * It never invents a deployment. A device is `deployed` if and only if
--        somebody holds it, so a row that says deployed with no holder the
--        directory recognises is stored in stock and its holder is reported back
--        in `unmatched_holders` for a human to resolve. That is not an error:
--        the machine is still inventory worth having.
--      * It never takes a machine back because a cell was blank. Deriving a
--        return from an empty holder column would close loans wholesale on the
--        first sheet that omits the column; an open loan is only ever closed to
--        hand the device to somebody the sheet names instead.
--      * It never moves an identifier between records. A row whose OSIS, email
--        or staff id already belongs to a different person — or whose device id,
--        serial or asset tag belongs to a different machine — is refused with
--        the identifier named.
--
-- 5. Only committed runs are recorded. `import_runs` is the answer to "what did
--    we import, when, and who pressed the button"; a dry run changed nothing, so
--    recording one would be recording a thing that did not happen.

-- ---------------------------------------------------------------------------
-- What was imported
-- ---------------------------------------------------------------------------

create table public.import_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  kind text not null check (kind in ('people', 'devices')),
  -- 'dry_run' is here for the shape rather than for use: only commits are
  -- written. The check keeps that from silently changing.
  mode text not null check (mode in ('dry_run', 'commit')),
  -- RESTRICT: the administrator who ran an import cannot be deleted out from
  -- under the record of it. Accounts are deactivated, never deleted.
  actor_id uuid not null references public.app_accounts (id) on delete restrict,
  at timestamptz not null default now(),
  row_count integer not null,
  inserted integer not null default 0,
  updated integer not null default 0,
  unchanged integer not null default 0,
  error_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb
);

comment on table public.import_runs is
  'One row per committed import. Dry runs are deliberately absent: they changed nothing. `summary` is the full result the RPC returned, including the per-row errors and the holders it could not match.';
comment on column public.import_runs.summary is
  'The result json: counts, errors [{row, message}] and unmatched_holders [{row, holder}]. Holds spreadsheet names, so it is readable by administrators only.';

create index import_runs_at_idx on public.import_runs (at desc, id desc);

-- ---------------------------------------------------------------------------
-- Shared helper
-- ---------------------------------------------------------------------------

-- One field of a row, trimmed, with a blank treated as absent.
--
-- `->>` already returns NULL for a key that is not there and for a JSON null, so
-- "the sheet had no such column", "the cell was empty" and "the cell was spaces"
-- all arrive here as the same answer: NULL, meaning leave the stored value
-- alone. That equivalence is the whole of decision 3 above.
create function public.app_import_value(p_row jsonb, p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(pg_catalog.btrim(coalesce(p_row ->> p_key, '')), '');
$$;

comment on function public.app_import_value(jsonb, text) is
  'Trusted internal helper: one trimmed field of an import row, NULL when the key is absent, JSON null, empty or whitespace. Never callable from a session.';

-- ---------------------------------------------------------------------------
-- The importer
-- ---------------------------------------------------------------------------

create function public.app_admin_import(
  p_kind text,
  p_rows jsonb,
  p_mode text default 'dry_run'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The columns each kind of row may set, in the order changes are reported in.
  -- `source` is absent from both on purpose: the importer decides it. `active`
  -- is absent for the reason app_upsert_person leaves it out.
  c_person_fields constant text[] := array[
    'kind', 'first_name', 'last_name', 'display_name', 'email', 'osis',
    'staff_id', 'school_dbn', 'department', 'role_title', 'official_class',
    'class_of', 'parent_name', 'parent_phone', 'home_phone', 'address', 'notes'
  ];
  c_device_fields constant text[] := array[
    'device_id', 'serial_number', 'asset_tag', 'type', 'manufacturer', 'model',
    'os', 'status', 'location', 'notes'
  ];
  c_max_rows constant integer := 5000;

  v_actor public.app_accounts;
  v_kind text;
  v_mode text;
  v_total integer;
  v_index integer;
  v_row jsonb;
  v_clean jsonb;
  v_key text;
  v_value text;
  v_message text;
  v_constraint text;

  -- Counts. Declared out here so they survive the dry run's rollback: an
  -- exception rolls back database work, not PL/pgSQL memory.
  v_inserts integer := 0;
  v_updates integer := 0;
  v_unchanged integer := 0;
  v_assignments integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_unmatched jsonb := '[]'::jsonb;

  v_run_id uuid;
  v_result jsonb;
  v_done integer;

  v_is_insert boolean;
  v_changed text[];

  v_person_before public.people;
  v_person_after public.people;
  v_osis text;
  v_email text;
  v_staff_id text;

  v_device_before public.devices;
  v_device_after public.devices;
  v_device_key text;
  v_serial text;
  v_asset_tag text;
  v_status text;
  v_label text;

  v_holder jsonb;
  v_holder_kind text;
  v_holder_osis text;
  v_holder_staff text;
  v_holder_name text;
  v_match uuid;
  v_match_name text;
  v_matches integer;
  v_held uuid;
  v_previous uuid;
  v_previous_name text;
  v_assigned boolean;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can import a roster or an inventory. Ask an administrator.'
      using errcode = 'insufficient_privilege';
  end if;

  v_kind := pg_catalog.lower(pg_catalog.btrim(coalesce(p_kind, '')));
  if v_kind not in ('people', 'devices') then
    raise exception 'Choose what this file holds: people or devices.'
      using errcode = 'check_violation';
  end if;

  v_mode := pg_catalog.lower(pg_catalog.btrim(coalesce(p_mode, 'dry_run')));
  if v_mode not in ('dry_run', 'commit') then
    raise exception 'An import is either a dry run or a commit.'
      using errcode = 'check_violation';
  end if;

  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Send the rows to import as a list of rows.'
      using errcode = 'check_violation';
  end if;

  v_total := pg_catalog.jsonb_array_length(p_rows);
  -- Checked before a single row is read, so an oversized file costs one message
  -- rather than a long transaction that is refused at the end.
  if v_total > c_max_rows then
    raise exception 'An import is at most 5000 rows at a time. Split the file and import it in parts.'
      using errcode = 'check_violation';
  end if;

  -- The savepoint. Everything below is undone when the dry run raises 'ED001'
  -- at the end of it; on a commit the block simply ends and the work stands.
  begin
    for v_index in 1 .. v_total loop
      v_row := p_rows -> (v_index - 1);

      -- One nested block per row: a row that cannot be written is rolled back on
      -- its own and reported, and the import carries on with the next one.
      begin
        if v_row is null or pg_catalog.jsonb_typeof(v_row) <> 'object' then
          raise exception 'This row is not a set of fields.' using errcode = 'check_violation';
        end if;

        if v_kind = 'people' then
          -- ---------------------------------------------------------------
          -- A person
          -- ---------------------------------------------------------------

          -- Refused, not ignored, exactly as app_upsert_person refuses it: a
          -- silent no-op would report success for a change that did not happen,
          -- and archiving is the one change on this table that belongs to an
          -- administrator on the person page.
          if v_row ? 'active' then
            raise exception 'Archiving or restoring a person is done by an administrator from the person page.'
              using errcode = 'check_violation';
          end if;

          -- Only the values the row actually supplied. An unknown key is
          -- ignored rather than refused: a sheet carrying a column the directory
          -- does not keep must not fail over it.
          v_clean := '{}'::jsonb;
          foreach v_key in array c_person_fields loop
            v_value := public.app_import_value(v_row, v_key);
            if v_value is not null then
              v_clean := v_clean || pg_catalog.jsonb_build_object(v_key, v_value);
            end if;
          end loop;

          -- Identifiers, folded to the one spelling the table stores, so the
          -- unique indexes are rules about people rather than about typing.
          if v_clean ? 'kind' then
            v_clean := v_clean || pg_catalog.jsonb_build_object(
              'kind', pg_catalog.lower(v_clean ->> 'kind'));
          end if;
          if v_clean ? 'email' then
            v_clean := v_clean || pg_catalog.jsonb_build_object(
              'email', pg_catalog.lower(v_clean ->> 'email'));
          end if;
          if v_clean ? 'staff_id' then
            v_clean := v_clean || pg_catalog.jsonb_build_object(
              'staff_id', pg_catalog.upper(v_clean ->> 'staff_id'));
          end if;
          if v_clean ? 'osis' then
            -- The source spreadsheet hands back "240,000,123" and "240 000 123".
            -- Separators are stripped; anything else left over is reported below
            -- rather than silently deleted.
            v_value := nullif(pg_catalog.regexp_replace(
              v_clean ->> 'osis', '[,[:space:]]', '', 'g'), '');
            if v_value is null then
              v_clean := v_clean - 'osis';
            else
              v_clean := v_clean || pg_catalog.jsonb_build_object('osis', v_value);
            end if;
          end if;

          v_osis := v_clean ->> 'osis';
          v_email := v_clean ->> 'email';
          v_staff_id := v_clean ->> 'staff_id';

          -- Validated before they are used as a key, so a typo is reported as a
          -- typo rather than as "no such person".
          if v_osis is not null and v_osis !~ '^[0-9]{6,12}$' then
            raise exception 'An OSIS number is 6 to 12 digits. Check "%" and enter it again.', v_osis
              using errcode = 'check_violation';
          end if;
          if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
            raise exception 'Enter a valid email address, or leave the address blank.'
              using errcode = 'check_violation';
          end if;

          -- The natural key, in the order the spreadsheets are reliable in:
          -- every student has an OSIS, staff have a staff id, and an address is
          -- the last resort. A row with none of the three cannot be matched to a
          -- record, and importing it anyway would add a second copy of the same
          -- person on every run.
          if v_osis is not null then
            select p.* into v_person_before from public.people p where p.osis = v_osis;
          elsif v_staff_id is not null then
            select p.* into v_person_before from public.people p where p.staff_id = v_staff_id;
          elsif v_email is not null then
            select p.* into v_person_before from public.people p where p.email = v_email;
          else
            raise exception 'This row has no OSIS, staff id or email address, so it cannot be matched to a directory record. Add one and import again.'
              using errcode = 'check_violation';
          end if;
          v_is_insert := v_person_before.id is null;

          -- An identifier never moves between records. The row matched one
          -- person by its key; if another of its identifiers is already on a
          -- different person, the sheet and the directory disagree about who
          -- somebody is, and that is for a human to settle.
          if v_osis is not null and exists (
            select 1 from public.people p
            where p.osis = v_osis and (v_is_insert or p.id <> v_person_before.id)
          ) then
            raise exception 'Another person already has OSIS %. Search for it to see whose record that is.',
              v_osis using errcode = 'unique_violation';
          end if;
          if v_email is not null and exists (
            select 1 from public.people p
            where p.email = v_email and (v_is_insert or p.id <> v_person_before.id)
          ) then
            raise exception 'Another person already has the address %. Search for it to see whose record that is.',
              v_email using errcode = 'unique_violation';
          end if;
          if v_staff_id is not null and exists (
            select 1 from public.people p
            where p.staff_id = v_staff_id and (v_is_insert or p.id <> v_person_before.id)
          ) then
            raise exception 'Another person already has staff id %. Search for it to see whose record that is.',
              v_staff_id using errcode = 'unique_violation';
          end if;

          if v_is_insert then
            -- The row a new person starts from: the table's own defaults, so the
            -- change list below reports what the sheet actually supplied.
            v_person_before.id := extensions.gen_random_uuid();
            v_person_before.first_name := '';
            v_person_before.last_name := '';
            v_person_before.display_name := '';
            v_person_before.active := true;
            v_person_before.source := 'import';
          end if;

          -- Merge: a value the row did not supply keeps what the directory has.
          v_person_after := pg_catalog.jsonb_populate_record(v_person_before, v_clean);

          -- A blank display name is rebuilt from the halves of the name, so the
          -- spreadsheet's two columns and the application's one column agree.
          if pg_catalog.btrim(coalesce(v_person_after.display_name, '')) = '' then
            v_person_after.display_name := pg_catalog.btrim(
              coalesce(v_person_after.first_name, '') || ' ' ||
              coalesce(v_person_after.last_name, ''));
          end if;

          if v_person_after.kind is null or v_person_after.kind not in ('student', 'staff') then
            raise exception 'Choose whether this person is a student or staff.'
              using errcode = 'check_violation';
          end if;
          if pg_catalog.btrim(v_person_after.display_name) = '' then
            raise exception 'Enter this person''s name.' using errcode = 'check_violation';
          end if;

          -- What actually changed, by FIELD NAME. Compared through jsonb so the
          -- list cannot drift out of step with c_person_fields.
          select coalesce(pg_catalog.array_agg(w.key order by w.ord), '{}'::text[])
          into v_changed
          from pg_catalog.unnest(c_person_fields) with ordinality as w(key, ord)
          where (pg_catalog.to_jsonb(v_person_before) ->> w.key)
            is distinct from (pg_catalog.to_jsonb(v_person_after) ->> w.key);

          if v_is_insert then
            insert into public.people (
              id, kind, first_name, last_name, display_name, email, osis,
              staff_id, school_dbn, department, role_title, official_class,
              class_of, parent_name, parent_phone, home_phone, address, notes,
              source
            ) values (
              v_person_before.id, v_person_after.kind, v_person_after.first_name,
              v_person_after.last_name, v_person_after.display_name,
              v_person_after.email, v_person_after.osis, v_person_after.staff_id,
              v_person_after.school_dbn, v_person_after.department,
              v_person_after.role_title, v_person_after.official_class,
              v_person_after.class_of, v_person_after.parent_name,
              v_person_after.parent_phone, v_person_after.home_phone,
              v_person_after.address, v_person_after.notes,
              -- Set here rather than taken from the row: the importer knows
              -- where this record came from, and the sheet does not get a say.
              'import'
            );
            v_inserts := v_inserts + 1;
          elsif pg_catalog.cardinality(v_changed) > 0 then
            -- `active` and `source` are absent on purpose. Re-importing must not
            -- restore somebody an administrator archived, and correcting a
            -- record a technician typed in does not make it an imported one.
            update public.people p set
              kind = v_person_after.kind,
              first_name = v_person_after.first_name,
              last_name = v_person_after.last_name,
              display_name = v_person_after.display_name,
              email = v_person_after.email,
              osis = v_person_after.osis,
              staff_id = v_person_after.staff_id,
              school_dbn = v_person_after.school_dbn,
              department = v_person_after.department,
              role_title = v_person_after.role_title,
              official_class = v_person_after.official_class,
              class_of = v_person_after.class_of,
              parent_name = v_person_after.parent_name,
              parent_phone = v_person_after.parent_phone,
              home_phone = v_person_after.home_phone,
              address = v_person_after.address,
              notes = v_person_after.notes,
              updated_at = pg_catalog.now()
            where p.id = v_person_before.id;
            v_updates := v_updates + 1;
          else
            v_unchanged := v_unchanged + 1;
          end if;

          if v_is_insert or pg_catalog.cardinality(v_changed) > 0 then
            perform public.app_log_record_event(
              'person',
              v_person_before.id,
              case when v_is_insert then 'created' else 'updated' end,
              v_actor.id,
              case
                when v_is_insert
                then 'Added ' || v_person_after.display_name || ' to the directory.'
                else 'Updated ' || v_person_after.display_name || '.'
              end,
              -- Field names, never values. This history is readable by every
              -- technician, and the fields include home addresses and parents'
              -- phone numbers.
              pg_catalog.array_to_string(v_changed, ', ')
            );
          end if;

        else
          -- ---------------------------------------------------------------
          -- A device
          -- ---------------------------------------------------------------

          v_clean := '{}'::jsonb;
          foreach v_key in array c_device_fields loop
            v_value := public.app_import_value(v_row, v_key);
            if v_value is not null then
              v_clean := v_clean || pg_catalog.jsonb_build_object(v_key, v_value);
            end if;
          end loop;

          -- Identifiers upper-cased to match the unique indexes, which are on
          -- upper(...); status folded so 'Deployed' is the status it names.
          foreach v_key in array array['device_id', 'serial_number', 'asset_tag'] loop
            if v_clean ? v_key then
              v_clean := v_clean || pg_catalog.jsonb_build_object(
                v_key, pg_catalog.upper(v_clean ->> v_key));
            end if;
          end loop;
          if v_clean ? 'status' then
            v_clean := v_clean || pg_catalog.jsonb_build_object(
              'status', pg_catalog.lower(v_clean ->> 'status'));
          end if;

          v_device_key := v_clean ->> 'device_id';
          v_serial := v_clean ->> 'serial_number';
          v_asset_tag := v_clean ->> 'asset_tag';
          v_status := v_clean ->> 'status';

          if v_status is not null and v_status not in
            ('in_stock', 'deployed', 'in_repair', 'retired', 'lost', 'surplus') then
            raise exception 'Choose a device status: in stock, deployed, in repair, retired, lost or surplus.'
              using errcode = 'check_violation';
          end if;

          -- FOR UPDATE: the deployment decisions below must not race a
          -- technician assigning the same machine from the inventory screen.
          if v_device_key is not null then
            select d.* into v_device_before from public.devices d
            where pg_catalog.upper(d.device_id) = v_device_key for update;
          elsif v_serial is not null then
            select d.* into v_device_before from public.devices d
            where pg_catalog.upper(d.serial_number) = v_serial for update;
          elsif v_asset_tag is not null then
            select d.* into v_device_before from public.devices d
            where pg_catalog.upper(d.asset_tag) = v_asset_tag for update;
          else
            raise exception 'Enter a device id, serial number or asset tag so this machine can be identified.'
              using errcode = 'check_violation';
          end if;
          v_is_insert := v_device_before.id is null;

          if v_device_key is not null and exists (
            select 1 from public.devices d
            where pg_catalog.upper(d.device_id) = v_device_key
              and (v_is_insert or d.id <> v_device_before.id)
          ) then
            raise exception 'Another device already has device id %. Search for it to see which machine that is.',
              v_device_key using errcode = 'unique_violation';
          end if;
          if v_serial is not null and exists (
            select 1 from public.devices d
            where pg_catalog.upper(d.serial_number) = v_serial
              and (v_is_insert or d.id <> v_device_before.id)
          ) then
            raise exception 'Another device already has serial number %. Search for it to see which machine that is.',
              v_serial using errcode = 'unique_violation';
          end if;
          if v_asset_tag is not null and exists (
            select 1 from public.devices d
            where pg_catalog.upper(d.asset_tag) = v_asset_tag
              and (v_is_insert or d.id <> v_device_before.id)
          ) then
            raise exception 'Another device already has asset tag %. Search for it to see which machine that is.',
              v_asset_tag using errcode = 'unique_violation';
          end if;

          -- Who the inventory sheet says is holding it.
          v_holder := v_row -> 'holder';
          if v_holder is null or pg_catalog.jsonb_typeof(v_holder) <> 'object' then
            v_holder := null;
          end if;
          v_holder_kind := pg_catalog.lower(public.app_import_value(v_holder, 'kind'));
          v_holder_osis := nullif(pg_catalog.regexp_replace(
            coalesce(public.app_import_value(v_holder, 'osis'), ''), '[,[:space:]]', '', 'g'), '');
          v_holder_staff := pg_catalog.upper(public.app_import_value(v_holder, 'staff_id'));
          v_holder_name := public.app_import_value(v_holder, 'name');

          -- An identifier decides on its own; a name is only trusted when it
          -- picks out exactly one person of the right kind, because two students
          -- can share a name and handing a laptop to the wrong one is worse than
          -- reporting that a human has to choose.
          --
          -- Only ACTIVE people can take delivery, matching app_assign_device:
          -- archiving is what decides who may still hold a machine. An archived
          -- match is therefore no match, and is reported back rather than
          -- failing the row.
          v_match := null;
          v_match_name := null;
          if v_holder_osis is not null and (v_holder_kind is null or v_holder_kind = 'student') then
            select p.id, p.display_name into v_match, v_match_name
            from public.people p where p.osis = v_holder_osis and p.active;
          elsif v_holder_staff is not null and (v_holder_kind is null or v_holder_kind = 'staff') then
            select p.id, p.display_name into v_match, v_match_name
            from public.people p where p.staff_id = v_holder_staff and p.active;
          elsif v_holder_name is not null then
            select pg_catalog.count(*) into v_matches
            from public.people p
            where p.active
              and pg_catalog.lower(p.display_name) = pg_catalog.lower(v_holder_name)
              and (v_holder_kind is null or p.kind = v_holder_kind);
            if v_matches = 1 then
              select p.id, p.display_name into v_match, v_match_name
              from public.people p
              where p.active
                and pg_catalog.lower(p.display_name) = pg_catalog.lower(v_holder_name)
                and (v_holder_kind is null or p.kind = v_holder_kind);
            end if;
          end if;

          if v_match is null
            and coalesce(v_holder_osis, v_holder_staff, v_holder_name) is not null then
            v_unmatched := v_unmatched || pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object('row', v_index, 'holder', v_holder));
          end if;

          v_held := null;
          if not v_is_insert then
            select a.person_id into v_held
            from public.device_assignments a
            where a.device_id = v_device_before.id and a.returned_at is null;
          end if;

          -- The deployment invariant, applied before the row is written rather
          -- than defended afterwards. A machine somebody holds stays deployed
          -- whatever the sheet says, and a sheet that says deployed without a
          -- holder the directory knows gets a machine in stock.
          if v_match is not null or v_held is not null then
            v_clean := v_clean || pg_catalog.jsonb_build_object('status', 'deployed');
          elsif v_status = 'deployed' then
            v_clean := v_clean || pg_catalog.jsonb_build_object('status', 'in_stock');
          end if;

          if v_is_insert then
            v_device_before.id := extensions.gen_random_uuid();
            v_device_before.type := 'Laptop';
            v_device_before.status := 'in_stock';
            v_device_before.source := 'import';
          end if;

          v_device_after := pg_catalog.jsonb_populate_record(v_device_before, v_clean);

          if coalesce(v_device_after.device_id, v_device_after.serial_number,
                      v_device_after.asset_tag) is null then
            raise exception 'Enter a device id, serial number or asset tag so this machine can be identified.'
              using errcode = 'check_violation';
          end if;

          select coalesce(pg_catalog.array_agg(w.key order by w.ord), '{}'::text[])
          into v_changed
          from pg_catalog.unnest(c_device_fields) with ordinality as w(key, ord)
          where (pg_catalog.to_jsonb(v_device_before) ->> w.key)
            is distinct from (pg_catalog.to_jsonb(v_device_after) ->> w.key);

          if v_is_insert then
            insert into public.devices (
              id, device_id, serial_number, asset_tag, type, manufacturer, model,
              os, status, location, notes, source
            ) values (
              v_device_before.id, v_device_after.device_id,
              v_device_after.serial_number, v_device_after.asset_tag,
              v_device_after.type, v_device_after.manufacturer,
              v_device_after.model, v_device_after.os, v_device_after.status,
              v_device_after.location, v_device_after.notes, 'import'
            );
          elsif pg_catalog.cardinality(v_changed) > 0 then
            update public.devices d set
              device_id = v_device_after.device_id,
              serial_number = v_device_after.serial_number,
              asset_tag = v_device_after.asset_tag,
              type = v_device_after.type,
              manufacturer = v_device_after.manufacturer,
              model = v_device_after.model,
              os = v_device_after.os,
              status = v_device_after.status,
              location = v_device_after.location,
              notes = v_device_after.notes,
              updated_at = pg_catalog.now()
            where d.id = v_device_before.id;
          end if;

          v_label := coalesce(v_device_after.asset_tag, v_device_after.serial_number,
                              v_device_after.device_id);

          if v_is_insert or pg_catalog.cardinality(v_changed) > 0 then
            perform public.app_log_record_event(
              'device',
              v_device_before.id,
              case when v_is_insert then 'created' else 'updated' end,
              v_actor.id,
              case
                when v_is_insert then 'Added ' || v_label || ' to the inventory.'
                else 'Updated ' || v_label || '.'
              end,
              pg_catalog.array_to_string(v_changed, ', ')
            );
          end if;

          -- The handover. Already held by the person the sheet names is not a
          -- handover, so re-importing the same file does not rewrite the loan
          -- history. The events written here are the ones app_assign_device
          -- writes, so device history reads the same whichever door it came
          -- through.
          v_assigned := false;
          if v_match is not null and v_match is distinct from v_held then
            v_previous := public.app_close_device_assignment(v_device_before.id, v_actor.id);
            v_previous_name := null;
            if v_previous is not null then
              select p.display_name into v_previous_name
              from public.people p where p.id = v_previous;
              perform public.app_log_record_event(
                'person', v_previous, 'device_returned', v_actor.id,
                v_label || ' returned.'
              );
            end if;

            insert into public.device_assignments (device_id, person_id, assigned_by, note)
            values (v_device_before.id, v_match, v_actor.id, 'Imported from spreadsheet');

            perform public.app_log_record_event(
              'device', v_device_before.id, 'assigned', v_actor.id,
              'Assigned to ' || v_match_name || '.',
              pg_catalog.concat_ws(
                ' ',
                case when v_previous_name is not null
                  then 'Taken back from ' || v_previous_name || '.' end,
                'Imported from spreadsheet'
              )
            );
            perform public.app_log_record_event(
              'person', v_match, 'device_assigned', v_actor.id,
              v_label || ' assigned.',
              'Imported from spreadsheet'
            );

            -- The row itself may not have changed a column — a machine already
            -- deployed, handed to somebody else — so the timestamp is bumped
            -- here rather than left at whatever the last edit set.
            if not v_is_insert and pg_catalog.cardinality(v_changed) = 0 then
              update public.devices d set updated_at = pg_catalog.now()
              where d.id = v_device_before.id;
            end if;

            v_assignments := v_assignments + 1;
            v_assigned := true;
          end if;

          -- A loan created or handed over is a change to the record even when no
          -- column of the device moved, so the counts add up to the row total.
          if v_is_insert then
            v_inserts := v_inserts + 1;
          elsif pg_catalog.cardinality(v_changed) > 0 or v_assigned then
            v_updates := v_updates + 1;
          else
            v_unchanged := v_unchanged + 1;
          end if;
        end if;

      exception
        -- Two imports running at once, or a technician editing the same record
        -- between the check above and the write, can still collide. The index
        -- name is not something an operator can act on, so it is translated.
        when unique_violation then
          get stacked diagnostics
            v_constraint = constraint_name,
            v_message = message_text;
          v_message := case v_constraint
            when 'people_osis_idx' then
              'Another person already has this OSIS. Search for it to see whose record that is.'
            when 'people_email_idx' then
              'Another person already has this email address. Search for it to see whose record that is.'
            when 'people_staff_id_idx' then
              'Another person already has this staff id. Search for it to see whose record that is.'
            when 'devices_device_id_idx' then
              'Another device already has this device id. Search for it to see which machine that is.'
            when 'devices_serial_idx' then
              'Another device already has this serial number. Search for it to see which machine that is.'
            when 'devices_asset_tag_idx' then
              'Another device already has this asset tag. Search for it to see which machine that is.'
            when 'device_assignments_open_idx' then
              'Somebody else was given this device while the import was running. Import it again.'
            else v_message
          end;
          v_errors := v_errors || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('row', v_index, 'message', v_message));
        when others then
          get stacked diagnostics v_message = message_text;
          v_errors := v_errors || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('row', v_index, 'message', v_message));
      end;
    end loop;

    if v_mode = 'dry_run' then
      -- Rolls this block back. The counts above are PL/pgSQL memory and survive
      -- it; every row, event and loan written inside it does not.
      raise exception 'Dry run: nothing was written.' using errcode = 'ED001';
    end if;
  exception
    when sqlstate 'ED001' then
      null;
  end;

  -- The id is minted before the result is built so `summary` is the whole of
  -- what the caller was told, run id included, rather than a copy missing one
  -- field.
  if v_mode = 'commit' then
    v_run_id := extensions.gen_random_uuid();
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'run_id', v_run_id,
    'kind', v_kind,
    'mode', v_mode,
    'total', v_total,
    'inserts', v_inserts,
    'updates', v_updates,
    'unchanged', v_unchanged,
    'errors', v_errors,
    'unmatched_holders', v_unmatched,
    'assignments_created', v_assignments
  );

  if v_mode = 'commit' then
    insert into public.import_runs (
      id, kind, mode, actor_id, row_count, inserted, updated, unchanged,
      error_count, summary
    ) values (
      v_run_id, v_kind, v_mode, v_actor.id, v_total, v_inserts, v_updates,
      v_unchanged, pg_catalog.jsonb_array_length(v_errors), v_result
    );

    v_done := v_inserts + v_updates + v_unchanged;
    perform public.app_log_record_event(
      'import', v_run_id, 'committed', v_actor.id,
      'Imported ' || v_done || ' ' ||
        case
          when v_kind = 'people' then case when v_done = 1 then 'person' else 'people' end
          else case when v_done = 1 then 'device' else 'devices' end
        end || '.',
      v_inserts || ' added, ' || v_updates || ' updated, ' ||
        v_unchanged || ' unchanged, ' ||
        pg_catalog.jsonb_array_length(v_errors) || ' with errors.'
    );
  end if;

  return v_result;
end;
$$;

comment on function public.app_admin_import(text, jsonb, text) is
  'Imports normalised roster or inventory rows. Administrator session only. A dry run performs the same writes inside a savepoint and rolls them back, so its counts are the commit''s counts. Each row is written in its own block: a bad row is reported by its 1-based position and the rest of the file still lands. Never writes `active`, never deploys a machine nobody holds, and never moves an identifier between records.';

-- ---------------------------------------------------------------------------
-- What has been imported before
-- ---------------------------------------------------------------------------

-- SECURITY INVOKER (the default): the row policy below is what decides which
-- rows come back, and the explicit check is there so a technician is told why
-- rather than handed an empty list they might read as "nothing has been
-- imported". app_account_label supplies the administrator's name, which the
-- app_accounts policy would otherwise withhold from a second administrator.
create function public.app_admin_import_runs(p_limit integer default 20)
returns table (
  id uuid,
  kind text,
  mode text,
  actor_id uuid,
  actor_name text,
  at timestamptz,
  row_count integer,
  inserted integer,
  updated integer,
  unchanged integer,
  error_count integer,
  summary jsonb
)
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.app_is_admin() then
    raise exception 'Only an administrator can see the import history. Ask an administrator.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select r.id, r.kind, r.mode, r.actor_id, public.app_account_label(r.actor_id),
           r.at, r.row_count, r.inserted, r.updated, r.unchanged, r.error_count,
           r.summary
    from public.import_runs r
    -- id breaks ties so paging is deterministic when two runs share an instant.
    order by r.at desc, r.id desc
    limit greatest(0, least(coalesce(p_limit, 20), 100));
end;
$$;

comment on function public.app_admin_import_runs(integer) is
  'Committed imports, newest first, with the name of the administrator who ran each one. Administrator session only.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.import_runs enable row level security;

-- Administrators only: `summary` carries spreadsheet rows, including the names
-- and identifiers of people the import could not match.
create policy import_runs_select_admin
  on public.import_runs for select to authenticated
  using (public.app_is_admin());

-- Deliberately absent: INSERT, UPDATE and DELETE policies. A run is recorded by
-- app_admin_import and by nothing else.

-- ---------------------------------------------------------------------------
-- Grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so the table is revoked explicitly and then re-granted
-- read-only. anon gets nothing at all.
-- ---------------------------------------------------------------------------

revoke all on table public.import_runs from anon, authenticated;
grant select on table public.import_runs to authenticated;

-- The helper is called only by the importer that owns it. service_role is named
-- explicitly: Supabase's default privileges grant it EXECUTE directly, so it
-- does not lose the privilege when the grant to PUBLIC is revoked.
revoke execute on function public.app_import_value(jsonb, text)
from public, anon, authenticated, service_role;

-- The two RPCs are granted to `authenticated` and refuse a non-administrator
-- inside the function, which is how every other admin-only RPC in this schema
-- is shaped: the answer is a sentence rather than a missing function.
revoke execute on function
  public.app_admin_import(text, jsonb, text),
  public.app_admin_import_runs(integer)
from public, anon;

grant execute on function
  public.app_admin_import(text, jsonb, text),
  public.app_admin_import_runs(integer)
to authenticated;
