-- M5 import: corrections to app_admin_import, and the p_limit cap stated on
-- app_admin_import_runs.
--
-- A separate migration rather than an edit to 20260912100400_m5_import.sql,
-- because that one is already applied. The table, its index, its policy and its
-- grants are untouched; the two functions are recreated here with full bodies,
-- and their grants and comments are restated so this file is the whole statement
-- of what they are.
--
-- Three things were wrong.
--
-- 1. A file without a Type or a Status column flattened the inventory
--    (controller Ruling 15). The normaliser used to emit 'Laptop' and 'in_stock'
--    for a blank cell, so a sheet exported without those columns told the
--    database that every machine was an in-stock laptop — taking every machine
--    in for repair back out of repair and turning every Chromebook into a
--    laptop. `src/lib/import/normalize.ts` now emits null for both, and this
--    function states the other half of the rule explicitly: a null `type` or
--    `status` becomes the inventory's default ONLY when a machine is being
--    inserted, and never overwrites a machine the helpdesk already knows.
--
-- 2. Raw PostgreSQL text reached the operator. Anything the translation table
--    below does not recognise used to be reported as its `message_text` —
--    "invalid input syntax for type uuid", "null value in column ... violates
--    not-null constraint" — which is not a sentence anybody can act on in a
--    spreadsheet. An unrecognised failure now gets one plain sentence, and the
--    database's own words move to a separate `detail` field for whoever is
--    debugging the import rather than fixing the sheet. The result shape grows
--    accordingly: `errors: [{row, message, detail?}]`.
--
--    Telling our own messages apart from the database's is what the private
--    SQLSTATE P9002 is for: every refusal written for an operator is raised with
--    it, so the handler knows the message is already fit to show and needs no
--    detail beside it.
--
-- 3. The report's claim about timeouts was wrong, and the comment beside the
--    handler repeated it. `when others` does NOT catch QUERY_CANCELED (57014) or
--    ASSERT_FAILURE: PL/pgSQL never matches those, by design. A statement
--    timeout or a cancelled request therefore aborts the whole import instead of
--    being recorded as one row's problem — which is the behaviour we want, and
--    is now what the comment says.
--
-- The dry-run sentinel also moves from 'ED001' to 'P9001'. Both are outside the
-- codes PostgreSQL assigns, but P9001 is in the range conventionally left to
-- user-defined conditions, and 'ED' is not ours to claim.

create or replace function public.app_admin_import(
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
  -- What an operator is told when the failure has no sentence of its own. The
  -- database's words go to `detail` instead of into this.
  c_unknown_error constant text :=
    'This row could not be saved. Fix it in the sheet and import again.';

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
  v_detail text;
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
  -- rather than a long transaction that is refused at the end. 5000 exactly is
  -- accepted; the cap is a ceiling, not a boundary to fall off.
  if v_total > c_max_rows then
    raise exception 'An import is at most 5000 rows at a time. Split the file and import it in parts.'
      using errcode = 'check_violation';
  end if;

  -- The savepoint. Everything below is undone when the dry run raises 'P9001'
  -- at the end of it; on a commit the block simply ends and the work stands.
  begin
    for v_index in 1 .. v_total loop
      v_row := p_rows -> (v_index - 1);

      -- One nested block per row: a row that cannot be written is rolled back on
      -- its own and reported, and the import carries on with the next one.
      begin
        if v_row is null or pg_catalog.jsonb_typeof(v_row) <> 'object' then
          raise exception 'This row is not a set of fields.' using errcode = 'P9002';
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
              using errcode = 'P9002';
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
              using errcode = 'P9002';
          end if;
          if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
            raise exception 'Enter a valid email address, or leave the address blank.'
              using errcode = 'P9002';
          end if;

          -- The natural key, in the order the spreadsheets are reliable in:
          -- every student has an OSIS, staff have a staff id, and an address is
          -- the last resort. A row with none of the three cannot be matched to a
          -- record, and importing it anyway would add a second copy of the same
          -- person on every run.
          --
          -- FOR UPDATE, like the device read below: the row is about to be
          -- rewritten from a sheet, and a technician correcting the same record
          -- from the person page in the same instant should queue behind that
          -- rather than have one of the two writes vanish.
          if v_osis is not null then
            select p.* into v_person_before from public.people p
            where p.osis = v_osis for update;
          elsif v_staff_id is not null then
            select p.* into v_person_before from public.people p
            where p.staff_id = v_staff_id for update;
          elsif v_email is not null then
            select p.* into v_person_before from public.people p
            where p.email = v_email for update;
          else
            raise exception 'This row has no OSIS, staff id or email address, so it cannot be matched to a directory record. Add one and import again.'
              using errcode = 'P9002';
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
              v_osis using errcode = 'P9002';
          end if;
          if v_email is not null and exists (
            select 1 from public.people p
            where p.email = v_email and (v_is_insert or p.id <> v_person_before.id)
          ) then
            raise exception 'Another person already has the address %. Search for it to see whose record that is.',
              v_email using errcode = 'P9002';
          end if;
          if v_staff_id is not null and exists (
            select 1 from public.people p
            where p.staff_id = v_staff_id and (v_is_insert or p.id <> v_person_before.id)
          ) then
            raise exception 'Another person already has staff id %. Search for it to see whose record that is.',
              v_staff_id using errcode = 'P9002';
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
          -- v_clean holds only the values that were actually present, so this is
          -- also what makes a blank cell mean "leave this alone".
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
              using errcode = 'P9002';
          end if;
          if pg_catalog.btrim(v_person_after.display_name) = '' then
            raise exception 'Enter this person''s name.' using errcode = 'P9002';
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
              using errcode = 'P9002';
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
              using errcode = 'P9002';
          end if;
          v_is_insert := v_device_before.id is null;

          if v_device_key is not null and exists (
            select 1 from public.devices d
            where pg_catalog.upper(d.device_id) = v_device_key
              and (v_is_insert or d.id <> v_device_before.id)
          ) then
            raise exception 'Another device already has device id %. Search for it to see which machine that is.',
              v_device_key using errcode = 'P9002';
          end if;
          if v_serial is not null and exists (
            select 1 from public.devices d
            where pg_catalog.upper(d.serial_number) = v_serial
              and (v_is_insert or d.id <> v_device_before.id)
          ) then
            raise exception 'Another device already has serial number %. Search for it to see which machine that is.',
              v_serial using errcode = 'P9002';
          end if;
          if v_asset_tag is not null and exists (
            select 1 from public.devices d
            where pg_catalog.upper(d.asset_tag) = v_asset_tag
              and (v_is_insert or d.id <> v_device_before.id)
          ) then
            raise exception 'Another device already has asset tag %. Search for it to see which machine that is.',
              v_asset_tag using errcode = 'P9002';
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
            -- Ruling 15, the database half of it. `type` and `status` are the
            -- inventory's defaults for a machine the sheet is INTRODUCING, and
            -- nothing at all for a machine it already knows. A null from the
            -- normaliser — a blank cell, or a sheet with no such column — never
            -- reaches v_clean, so these two lines are the only place a default
            -- comes from, and they are only reachable on an insert. An
            -- `in_repair` Chromebook re-imported from a file that mentions
            -- neither column stays an `in_repair` Chromebook.
            v_device_before.type := 'Laptop';
            v_device_before.status := 'in_stock';
            v_device_before.source := 'import';
          end if;

          v_device_after := pg_catalog.jsonb_populate_record(v_device_before, v_clean);

          if coalesce(v_device_after.device_id, v_device_after.serial_number,
                      v_device_after.asset_tag) is null then
            raise exception 'Enter a device id, serial number or asset tag so this machine can be identified.'
              using errcode = 'P9002';
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
        -- P9002 is this function's own: every refusal above was written for the
        -- person looking at the spreadsheet, so it is shown as it stands and
        -- carries no `detail`.
        when sqlstate 'P9002' then
          get stacked diagnostics v_message = message_text;
          v_detail := null;
          v_errors := v_errors || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('row', v_index, 'message', v_message));

        -- Two imports running at once, or a technician editing the same record
        -- between the check above and the write, can still collide. The index
        -- name is not something an operator can act on, so it is translated —
        -- and the database's own sentence is kept beside it as `detail` for
        -- whoever is debugging the import rather than fixing the sheet.
        when unique_violation then
          get stacked diagnostics
            v_constraint = constraint_name,
            v_detail = message_text;
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
            else c_unknown_error
          end;
          v_errors := v_errors || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'row', v_index, 'message', v_message,
              'detail', pg_catalog.left(v_detail, 500)));

        -- What `others` actually covers, stated precisely because the first
        -- version of this comment got it wrong: every condition PL/pgSQL can
        -- trap — a constraint violation, a deadlock, a serialization failure, a
        -- bad cast — becomes this row's error and the import carries on. What it
        -- does NOT cover is QUERY_CANCELED (57014) or ASSERT_FAILURE: PL/pgSQL
        -- never matches those against `others`, by design. So a statement
        -- timeout or a cancelled request ABORTS the whole import rather than
        -- being recorded 5,000 times, which is the behaviour we want: a timeout
        -- is a fact about the server, not about the row that happened to be
        -- running when it fired.
        --
        -- The database's words never reach the operator here. They are not a
        -- sentence anybody can act on in a spreadsheet, so the message is one
        -- plain instruction and the raw text goes to `detail`.
        when others then
          get stacked diagnostics v_detail = message_text;
          v_errors := v_errors || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'row', v_index, 'message', c_unknown_error,
              'detail', pg_catalog.left(v_detail, 500)));
      end;
    end loop;

    if v_mode = 'dry_run' then
      -- Rolls this block back. The counts above are PL/pgSQL memory and survive
      -- it; every row, event and loan written inside it does not.
      raise exception 'Dry run: nothing was written.' using errcode = 'P9001';
    end if;
  exception
    when sqlstate 'P9001' then
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
  'Imports normalised roster or inventory rows. Administrator session only. Returns {run_id, kind, mode, total, inserts, updates, unchanged, errors: [{row, message, detail?}], unmatched_holders: [{row, holder}], assignments_created}; `message` is always a sentence for the operator and `detail` carries the database''s own words when there were any. A dry run performs the same writes inside a savepoint and rolls them back, so its counts are the commit''s counts. Each row is written in its own block: a row that fails is reported by its 1-based position and the rest of the file still lands, except that a cancelled request or a statement timeout aborts the whole import. Never writes `active`, never deploys a machine nobody holds, never moves an identifier between records, and applies a default `type` or `status` only when inserting a machine the inventory has never seen.';

-- ---------------------------------------------------------------------------
-- app_admin_import_runs: unchanged behaviour, with the cap on p_limit stated
-- rather than left to be discovered.
-- ---------------------------------------------------------------------------

create or replace function public.app_admin_import_runs(p_limit integer default 20)
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
    -- Clamped to 0..100, like every other list in this schema: `summary` holds a
    -- whole file's worth of errors, so an unbounded limit is an unbounded
    -- response. A caller asking for no rows gets none.
    limit greatest(0, least(coalesce(p_limit, 20), 100));
end;
$$;

comment on function public.app_admin_import_runs(integer) is
  'Committed imports, newest first, with the name of the administrator who ran each one. Administrator session only. p_limit is clamped to 0..100; NULL means 20.';

-- ---------------------------------------------------------------------------
-- Grants restated. `create or replace` keeps the existing ACL, so these change
-- nothing today; they are here so this file says in full what these two
-- functions are and who may call them.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_admin_import(text, jsonb, text),
  public.app_admin_import_runs(integer)
from public, anon;

grant execute on function
  public.app_admin_import(text, jsonb, text),
  public.app_admin_import_runs(integer)
to authenticated;
