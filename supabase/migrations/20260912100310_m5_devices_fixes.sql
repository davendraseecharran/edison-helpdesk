-- M5 device inventory: corrections to app_account_label, app_assign_device and
-- app_bulk_update_devices.
--
-- A separate migration rather than an edit to 20260912100300_m5_devices.sql,
-- because that one is already applied. The tables, the policies and the other
-- seven functions are untouched; the three functions that change are recreated
-- here with full bodies, and their grants and comments are restated so this file
-- is the whole statement of what they are.
--
-- Four things were wrong.
--
-- 1. app_account_label answered for accounts app_directory() deliberately hides.
--    app_directory() omits `pending_approval` and `denied` because "listing them
--    would leak the fact that a named person tried to sign in to every
--    technician in the building". app_account_label took no such care, so
--    feeding it uuids turned it into a name-for-uuid oracle over exactly the
--    accounts that were meant to stay invisible. The claim in the 100300 comment
--    that it "exposes no more than app_directory() already does" was therefore
--    false; it is true now.
--
-- 2. A bulk change that failed said WHAT went wrong and never WHICH machine went
--    wrong. "This device is not assigned to anyone." over a selection of 300
--    laptops is not something an operator can act on. Every iteration is now
--    wrapped so the failure is re-raised with the device's asset tag, serial or
--    device id in front of it, keeping the original SQLSTATE.
--
-- 3. Re-assigning a device to the person who already has it closed their loan
--    and opened an identical one, so a double-submitted form or a re-run import
--    left a trail of zero-length loans and an `assigned` event apiece. It is now
--    a no-op that returns the loan that already exists.
--
-- 4. Smaller ones, all in the bulk function: the ids were locked in whatever
--    order `unnest` produced rather than a total one, the pre-reads that decide
--    "did this actually change" took no row lock, and a patch carrying both
--    `person_id` and `status` silently applied only the first — the one
--    combination that was accepted in silence while every other contradiction
--    was refused.

-- The loan history of one device, newest first, is what app_device_detail and
-- app_person_detail both read; device_assignments_open_idx only covers the open
-- row and device_assignments_person_idx is keyed the other way round.
create index device_assignments_device_idx
  on public.device_assignments (device_id, assigned_at desc);

-- ---------------------------------------------------------------------------
-- app_account_label
-- ---------------------------------------------------------------------------

create or replace function public.app_account_label(p_account uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.display_name
  from public.app_accounts a
  where a.id = p_account
    -- Exactly app_directory()'s rule, for exactly app_directory()'s reason.
    -- A deactivated colleague stays nameable: their name is on historical work
    -- and has to render. Someone waiting for, or refused, an access decision has
    -- no history to attribute, so naming them would tell any technician holding
    -- a uuid that a named person tried to sign in.
    and a.status not in ('pending_approval', 'denied')
    and public.app_active_account_id() is not null;
$$;

comment on function public.app_account_label(uuid) is
  'One account''s display name, for attribution in device and import history. NULL for an unknown account, an account awaiting or refused an access decision, or a caller who is not active. Exposes no more than app_directory() does.';

-- ---------------------------------------------------------------------------
-- app_assign_device
-- ---------------------------------------------------------------------------

create or replace function public.app_assign_device(
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
  v_open public.device_assignments;
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
  -- archived record cannot take delivery of a new machine. Checked before the
  -- no-op below, so the rule holds whoever is currently holding the device.
  if not v_person.active then
    raise exception 'That directory record is archived. Restore it before assigning a device.'
      using errcode = 'check_violation';
  end if;

  select * into v_open
  from public.device_assignments a
  where a.device_id = p_device and a.returned_at is null;

  -- Already theirs. Closing their loan and opening an identical one would leave
  -- a zero-length loan in the history and an `assigned` event for a handover
  -- that did not happen, which is what a double-submitted form and a re-run
  -- import both produce. A note sent with a no-op is not recorded, because
  -- nothing happened for it to describe.
  if found and v_open.person_id = p_person then
    return v_open.id;
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
  'Hands a device to a person. Closes whatever loan was open on it first, marks the device deployed, and records the handover on the device and on everyone it passed between. Returns the new assignment id, or the existing one unchanged when that person already has the device.';

-- ---------------------------------------------------------------------------
-- app_bulk_update_devices
-- ---------------------------------------------------------------------------

create or replace function public.app_bulk_update_devices(p_ids uuid[], p_patch jsonb)
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
  v_open uuid;
  v_assignment uuid;
  v_label text;
  v_message text;
  v_state text;
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

  -- Every contradiction is refused rather than silently resolved by precedence.
  -- `return` with `status` is the one pairing that is NOT a contradiction: the
  -- status says what the machines came back in.
  if v_return and v_person is not null then
    raise exception 'Choose either assigning these devices or returning them, not both.'
      using errcode = 'check_violation';
  end if;
  if v_person is not null and v_status is not null then
    raise exception 'Assigning these devices already sets their status to deployed. Send one or the other.'
      using errcode = 'check_violation';
  end if;
  if not v_return and v_person is null and v_status is null and not v_has_location then
    raise exception 'Choose what to change for the selected devices.'
      using errcode = 'check_violation';
  end if;

  -- Distinct so a selection that repeats an id is not applied to it twice,
  -- NULLs dropped rather than looked up, and ORDERED so two bulk changes over
  -- overlapping selections take their row locks in the same sequence and cannot
  -- deadlock each other.
  for v_id in
    select distinct x.id
    from pg_catalog.unnest(coalesce(p_ids, '{}'::uuid[])) as x(id)
    where x.id is not null
    order by 1
  loop
    -- One iteration, one all-or-nothing unit, and one place to attach the
    -- device's identifier to whatever it refuses. The re-raise aborts the whole
    -- function exactly as an unhandled error would, so the selection is still
    -- applied in full or not at all.
    begin
      v_touched := false;

      -- The row lock the whole iteration works under, taken before anything is
      -- decided from the row's contents.
      select * into v_device from public.devices d where d.id = v_id for update;
      if not found then
        raise exception 'That device is not in the inventory. Search for it again.'
          using errcode = 'no_data_found';
      end if;

      if v_return then
        perform public.app_return_device(v_id, coalesce(v_status, 'in_stock'), null);
        v_touched := true;
      elsif v_person is not null then
        -- app_assign_device returns the loan that already exists when the person
        -- already has the device, so comparing the ids is how this counts a
        -- genuine handover without repeating the check it just made.
        select a.id into v_open
        from public.device_assignments a
        where a.device_id = v_id and a.returned_at is null and a.person_id = v_person;

        v_assignment := public.app_assign_device(v_id, v_person, null);
        v_touched := v_open is distinct from v_assignment;
      elsif v_status is not null and v_device.status is distinct from v_status then
        perform public.app_set_device_status(v_id, v_status, p_patch ->> 'reason');
        v_touched := true;
      end if;

      -- Read from the same locked row: nothing above changes a location.
      if v_has_location and v_device.location is distinct from v_location then
        perform public.app_move_device(v_id, v_location);
        v_touched := true;
      end if;

      if v_touched then
        v_changed := v_changed + 1;
      end if;

    exception
      when others then
        get stacked diagnostics
          v_message = message_text,
          v_state = returned_sqlstate;
        -- Read after the failed iteration rolled back, which is why it cannot
        -- reuse v_device. A device that does not exist has no label, so the id
        -- the caller sent stands in for one.
        select coalesce(d.asset_tag, d.serial_number, d.device_id)
        into v_label
        from public.devices d
        where d.id = v_id;

        raise exception '%: %', coalesce(v_label, v_id::text), v_message
          using errcode = v_state;
    end;
  end loop;

  return v_changed;
end;
$$;

comment on function public.app_bulk_update_devices(uuid[], jsonb) is
  'Applies one change to up to 500 devices: status, location, person_id (assign each) or return (take each back, in the status given by `status`). Returns how many devices actually changed, records an event per device, applies nothing at all if any device refuses, and names the offending device in the message when one does.';

-- ---------------------------------------------------------------------------
-- Grants restated. `create or replace` keeps the existing ACL, so these change
-- nothing today; they are here so this file says in full what these three
-- functions are and who may call them.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_account_label(uuid),
  public.app_assign_device(uuid, uuid, text),
  public.app_bulk_update_devices(uuid[], jsonb)
from public, anon;

grant execute on function
  public.app_account_label(uuid),
  public.app_assign_device(uuid, uuid, text),
  public.app_bulk_update_devices(uuid[], jsonb)
to authenticated;
