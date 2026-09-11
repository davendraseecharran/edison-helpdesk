-- Ticket mutation RPCs.
--
-- Contract for every function here:
--   * SECURITY DEFINER with a fixed empty search_path and fully qualified names.
--   * Identity is re-derived from auth.uid() inside the function. No actor id,
--     role, author, or timestamp is ever accepted from the caller.
--   * The parent ticket row is locked FIRST (consistent lock order: ticket, then
--     its children), then current state is re-checked, then the mutation and its
--     activity event are written in the same transaction.
--   * Authorization failures and invisible/missing ids raise the SAME message, so
--     a caller cannot probe for the existence of tickets it may not see.
--   * Errors are raised, never returned, so a failed call leaves no partial write.
--
-- These mirror src/lib/domain/operations.ts. Where the two differ deliberately it
-- is noted in docs/M2-DATABASE.md.

-- --- Internal helpers (not granted to any client role) ----------------------

create or replace function public.app_require_actor()
returns public.app_accounts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
begin
  select * into v_actor
  from public.app_accounts a
  where a.id = (select auth.uid());

  if not found or v_actor.status <> 'active' then
    -- Anonymous, unlinked, inactive and setup_pending are all refused here, so
    -- deactivation applies to the next statement of an existing session.
    raise exception 'This account cannot access helpdesk records.'
      using errcode = 'insufficient_privilege';
  end if;

  return v_actor;
end;
$$;

-- Locks the ticket and enforces read visibility. Raises an identical error for
-- "does not exist" and "not yours".
create or replace function public.app_lock_ticket(p_ticket uuid, p_actor public.app_accounts)
returns public.tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.tickets;
begin
  if p_ticket is null then
    raise exception 'That ticket is not available to this account.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_ticket
  from public.tickets t
  where t.id = p_ticket
  for update;

  if not found
    or not (
      p_actor.role = 'admin'
      or (v_ticket.status = 'open' and v_ticket.owner_id is null)
      or v_ticket.owner_id = p_actor.id
      or exists (
        select 1
        from public.ticket_collaborators tc
        where tc.ticket_id = v_ticket.id
          and tc.account_id = p_actor.id
      )
    )
  then
    raise exception 'That ticket is not available to this account.'
      using errcode = 'insufficient_privilege';
  end if;

  return v_ticket;
end;
$$;

create or replace function public.app_is_participant(p_ticket public.tickets, p_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_ticket.owner_id = p_actor_id
    or exists (
      select 1
      from public.ticket_collaborators tc
      where tc.ticket_id = p_ticket.id
        and tc.account_id = p_actor_id
    );
$$;

create or replace function public.app_log_event(
  p_ticket uuid,
  p_kind text,
  p_actor uuid,
  p_summary text,
  p_detail text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.activity_events (ticket_id, kind, actor_id, summary, detail)
  values (p_ticket, p_kind, p_actor, p_summary, nullif(btrim(p_detail), ''));
$$;

-- Contribution rule shared by notes, devices, priority and progress: an active
-- participant (or an admin) on a ticket that is not closed.
create or replace function public.app_require_contributor(
  p_ticket public.tickets,
  p_actor public.app_accounts
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_ticket.status in ('resolved', 'cancelled') then
    raise exception 'This ticket is closed. An administrator must reopen it first.'
      using errcode = 'insufficient_privilege';
  end if;
  if not (p_actor.role = 'admin' or public.app_is_participant(p_ticket, p_actor.id)) then
    raise exception 'Only the primary owner, a collaborator, or an administrator can change this ticket.'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke execute on function
  public.app_require_actor(),
  public.app_lock_ticket(uuid, public.app_accounts),
  public.app_is_participant(public.tickets, uuid),
  public.app_log_event(uuid, text, uuid, text, text),
  public.app_require_contributor(public.tickets, public.app_accounts)
from public, anon, authenticated;

-- --- Intake ----------------------------------------------------------------

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
  v_seen uuid[] := '{}';
begin
  v_actor := public.app_require_actor();
  v_admin := v_actor.role = 'admin';

  if length(btrim(coalesce(p_title, ''))) = 0 then
    raise exception 'A short title is required.' using errcode = 'check_violation';
  end if;
  if length(btrim(p_title)) > 120 then
    raise exception 'Keep the title under 120 characters.' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_issue, ''))) = 0 then
    raise exception 'Describe the issue before saving.' using errcode = 'check_violation';
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

  -- Requester: a known record, a new minimal record, or explicitly unknown.
  if p_requester_unknown then
    v_requester := null;
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
    raise exception 'Name the requester, or mark the requester as unknown.' using errcode = 'check_violation';
  end if;

  insert into public.tickets (
    title, issue, requester_id, requester_unknown, location, is_remote,
    channel, priority, status, submitted_on, created_by, owner_id, assigned_at
  )
  values (
    btrim(p_title),
    btrim(p_issue),
    v_requester,
    p_requester_unknown,
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
    insert into public.device_observations (
      ticket_id, device_type, model, os_version, serial_number, asset_tag,
      identifiers_not_applicable, recorded_by
    )
    values (
      v_ticket_id, v_device_type,
      nullif(btrim(coalesce(v_device ->> 'model', '')), ''),
      nullif(btrim(coalesce(v_device ->> 'osVersion', '')), ''),
      nullif(btrim(coalesce(v_device ->> 'serialNumber', '')), ''),
      nullif(btrim(coalesce(v_device ->> 'assetTag', '')), ''),
      coalesce((v_device ->> 'identifiersNotApplicable')::boolean, false),
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

-- --- Queue movement --------------------------------------------------------

create or replace function public.app_claim_ticket(p_ticket uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
begin
  v_actor := public.app_require_actor();

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

  return v_ticket.id;
end;
$$;

-- Admin-only: hand a ticket to a different technician.
create or replace function public.app_reassign_ticket(p_ticket uuid, p_new_owner uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_new_owner public.app_accounts;
  v_previous text;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can reassign a ticket.'
      using errcode = 'insufficient_privilege';
  end if;

  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if p_new_owner is null then
    raise exception 'Choose an active technician, or return the ticket to the Open Queue.'
      using errcode = 'check_violation';
  end if;
  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'Reopen the ticket before reassigning it.' using errcode = 'insufficient_privilege';
  end if;
  if v_ticket.owner_id is not distinct from p_new_owner then
    raise exception 'That technician already owns this ticket.' using errcode = 'check_violation';
  end if;

  select * into v_new_owner
  from public.app_accounts a
  where a.id = p_new_owner and a.status = 'active';
  if not found then
    raise exception 'Choose an active technician.' using errcode = 'check_violation';
  end if;

  select a.display_name into v_previous
  from public.app_accounts a where a.id = v_ticket.owner_id;

  update public.tickets
  set owner_id = v_new_owner.id,
      assigned_at = now(),
      status = case when status = 'open' then 'assigned' else status end
  where id = v_ticket.id;

  delete from public.ticket_collaborators
  where ticket_id = v_ticket.id and account_id = v_new_owner.id;

  perform public.app_log_event(
    v_ticket.id, 'assigned', v_actor.id,
    case when v_previous is null
      then v_actor.display_name || ' assigned the ticket to ' || v_new_owner.display_name
      else v_actor.display_name || ' reassigned the ticket from ' || v_previous
           || ' to ' || v_new_owner.display_name
    end
  );

  return v_ticket.id;
end;
$$;

-- The primary owner (or an admin) releases unfinished work. Every contribution,
-- collaborator, note, device, work log and prior solution is preserved.
create or replace function public.app_return_ticket_to_queue(p_ticket uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_previous text;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'A closed ticket cannot be returned to the Open Queue.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_ticket.owner_id is null then
    raise exception 'This ticket is already in the Open Queue.' using errcode = 'check_violation';
  end if;
  -- Collaborators cannot release someone else's ticket.
  if not (v_actor.role = 'admin' or v_ticket.owner_id = v_actor.id) then
    raise exception 'Only the primary owner or an administrator can return this ticket to the queue.'
      using errcode = 'insufficient_privilege';
  end if;

  select a.display_name into v_previous
  from public.app_accounts a where a.id = v_ticket.owner_id;

  update public.tickets
  set owner_id = null,
      assigned_at = null,
      status = 'open',
      waiting_reason = null
  where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'returned_to_queue', v_actor.id,
    case when v_ticket.owner_id = v_actor.id
      then v_actor.display_name || ' returned the ticket to the Open Queue'
      else v_actor.display_name || ' returned the ticket to the Open Queue from ' || v_previous
    end
  );

  return v_ticket.id;
end;
$$;

-- --- Collaborators ---------------------------------------------------------

create or replace function public.app_add_collaborator(p_ticket uuid, p_account uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_target public.app_accounts;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'This ticket is closed. An administrator must reopen it first.'
      using errcode = 'insufficient_privilege';
  end if;
  -- Owner or admin only; a collaborator cannot recruit further collaborators.
  if not (v_actor.role = 'admin' or v_ticket.owner_id = v_actor.id) then
    raise exception 'Only the primary owner or an administrator can change collaborators.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_target
  from public.app_accounts a
  where a.id = p_account and a.status = 'active';
  if not found then
    raise exception 'Choose an active account to collaborate.' using errcode = 'check_violation';
  end if;
  if v_ticket.owner_id = v_target.id then
    raise exception 'That account is already the primary owner.' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.ticket_collaborators tc
    where tc.ticket_id = v_ticket.id and tc.account_id = v_target.id
  ) then
    raise exception 'That account is already collaborating.' using errcode = 'check_violation';
  end if;

  insert into public.ticket_collaborators (ticket_id, account_id, added_by)
  values (v_ticket.id, v_target.id, v_actor.id);

  perform public.app_log_event(
    v_ticket.id, 'collaborator_added', v_actor.id,
    v_actor.display_name || ' added ' || v_target.display_name || ' as a collaborator'
  );

  return v_ticket.id;
end;
$$;

create or replace function public.app_remove_collaborator(p_ticket uuid, p_account uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_name text;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'This ticket is closed. An administrator must reopen it first.'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_actor.role = 'admin' or v_ticket.owner_id = v_actor.id) then
    raise exception 'Only the primary owner or an administrator can change collaborators.'
      using errcode = 'insufficient_privilege';
  end if;

  select a.display_name into v_name from public.app_accounts a where a.id = p_account;

  delete from public.ticket_collaborators
  where ticket_id = v_ticket.id and account_id = p_account;
  if not found then
    raise exception 'That account is not collaborating on this ticket.' using errcode = 'check_violation';
  end if;

  -- Access ends now; everything they already authored keeps their name.
  perform public.app_log_event(
    v_ticket.id, 'collaborator_removed', v_actor.id,
    v_actor.display_name || ' removed ' || coalesce(v_name, 'a collaborator') || ' from the ticket'
  );

  return v_ticket.id;
end;
$$;

-- --- Contributions ---------------------------------------------------------

create or replace function public.app_add_note(p_ticket uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_note_id uuid;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);
  perform public.app_require_contributor(v_ticket, v_actor);

  if length(btrim(coalesce(p_body, ''))) = 0 then
    raise exception 'Write the note before saving.' using errcode = 'check_violation';
  end if;

  insert into public.notes (ticket_id, author_id, body)
  values (v_ticket.id, v_actor.id, btrim(p_body))
  returning id into v_note_id;

  -- First recorded work moves an untouched assignment to In progress.
  if v_ticket.status = 'assigned' then
    update public.tickets set status = 'in_progress' where id = v_ticket.id;
    perform public.app_log_event(
      v_ticket.id, 'status_changed', v_actor.id, v_actor.display_name || ' started work'
    );
  end if;

  perform public.app_log_event(
    v_ticket.id, 'note_added', v_actor.id,
    v_actor.display_name || ' added a work note', btrim(p_body)
  );

  return v_note_id;
end;
$$;

create or replace function public.app_record_device(
  p_ticket uuid,
  p_device_type text,
  p_model text default null,
  p_os_version text default null,
  p_serial_number text default null,
  p_asset_tag text default null,
  p_identifiers_not_applicable boolean default false
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

  if length(btrim(coalesce(p_device_type, ''))) = 0 then
    raise exception 'Each device entry needs a device type.' using errcode = 'check_violation';
  end if;

  -- Unknown serial and asset tag stay null; they never block the record.
  insert into public.device_observations (
    ticket_id, device_type, model, os_version, serial_number, asset_tag,
    identifiers_not_applicable, recorded_by
  )
  values (
    v_ticket.id, btrim(p_device_type),
    nullif(btrim(coalesce(p_model, '')), ''),
    nullif(btrim(coalesce(p_os_version, '')), ''),
    nullif(btrim(coalesce(p_serial_number, '')), ''),
    nullif(btrim(coalesce(p_asset_tag, '')), ''),
    coalesce(p_identifiers_not_applicable, false),
    v_actor.id
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
    v_actor.display_name || ' recorded a device: ' || btrim(p_device_type)
  );

  return v_device_id;
end;
$$;

create or replace function public.app_set_priority(p_ticket uuid, p_priority text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_labels jsonb := '{"low":"Low","normal":"Normal","high":"High","urgent":"Urgent"}'::jsonb;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);
  perform public.app_require_contributor(v_ticket, v_actor);

  if p_priority is null or not (v_labels ? p_priority) then
    raise exception 'Choose a valid priority.' using errcode = 'check_violation';
  end if;
  if v_ticket.priority = p_priority then
    raise exception 'Priority is already %.', v_labels ->> p_priority using errcode = 'check_violation';
  end if;

  update public.tickets set priority = p_priority where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'priority_changed', v_actor.id,
    v_actor.display_name || ' changed priority from ' || (v_labels ->> v_ticket.priority)
      || ' to ' || (v_labels ->> p_priority)
  );

  return v_ticket.id;
end;
$$;

create or replace function public.app_set_waiting(p_ticket uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);
  perform public.app_require_contributor(v_ticket, v_actor);

  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Waiting needs a reason.' using errcode = 'check_violation';
  end if;
  if v_ticket.owner_id is null then
    raise exception 'Claim the ticket before putting it on hold.' using errcode = 'check_violation';
  end if;

  update public.tickets
  set status = 'waiting', waiting_reason = btrim(p_reason)
  where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'status_changed', v_actor.id,
    v_actor.display_name || ' set the ticket to Waiting', btrim(p_reason)
  );

  return v_ticket.id;
end;
$$;

create or replace function public.app_resume_work(p_ticket uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);
  perform public.app_require_contributor(v_ticket, v_actor);

  if v_ticket.status <> 'waiting' then
    raise exception 'This ticket is not waiting.' using errcode = 'check_violation';
  end if;

  update public.tickets
  set status = 'in_progress', waiting_reason = null
  where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'status_changed', v_actor.id, v_actor.display_name || ' resumed work'
  );

  return v_ticket.id;
end;
$$;

-- Optional time. Still allowed after resolution so contributors can record work
-- they already did; never allowed on a cancelled ticket. Always logged against
-- the caller, never an arbitrary contributor id.
create or replace function public.app_log_work(
  p_ticket uuid,
  p_minutes integer,
  p_work_date date default null,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_date date := coalesce(p_work_date, public.app_today());
  v_log_id uuid;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status = 'cancelled' then
    raise exception 'Time cannot be recorded on a cancelled ticket.' using errcode = 'insufficient_privilege';
  end if;
  if not (v_actor.role = 'admin' or public.app_is_participant(v_ticket, v_actor.id)) then
    raise exception 'Only participants can record time on this ticket.' using errcode = 'insufficient_privilege';
  end if;
  if p_minutes is null or p_minutes <= 0 then
    raise exception 'Enter whole minutes greater than zero.' using errcode = 'check_violation';
  end if;
  if p_minutes > 1440 then
    raise exception 'Split entries longer than 24 hours.' using errcode = 'check_violation';
  end if;
  if v_date > public.app_today() then
    raise exception 'The work date cannot be in the future.' using errcode = 'check_violation';
  end if;

  insert into public.work_logs (ticket_id, contributor_id, work_date, minutes, description)
  values (v_ticket.id, v_actor.id, v_date, p_minutes, nullif(btrim(coalesce(p_description, '')), ''))
  returning id into v_log_id;

  perform public.app_log_event(
    v_ticket.id, 'time_logged', v_actor.id,
    v_actor.display_name || ' logged ' || p_minutes || ' minutes',
    nullif(btrim(coalesce(p_description, '')), '')
  );

  return v_log_id;
end;
$$;

-- --- Completion ------------------------------------------------------------

create or replace function public.app_resolve_ticket(p_ticket uuid, p_solution text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_owner_name text;
  v_solution text := btrim(coalesce(p_solution, ''));
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  -- One completion per resolution cycle: the row lock means the second of two
  -- concurrent resolutions sees 'resolved' here.
  if v_ticket.status = 'resolved' then
    raise exception 'This ticket has already been resolved.' using errcode = 'check_violation';
  end if;
  if v_ticket.status = 'cancelled' then
    raise exception 'Cancelled tickets cannot be resolved. An administrator can reopen it.'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_actor.role = 'admin' or public.app_is_participant(v_ticket, v_actor.id)) then
    raise exception 'Only the primary owner, a collaborator, or an administrator can resolve this ticket.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_solution = '' then
    raise exception 'A solution is required to resolve a ticket.' using errcode = 'check_violation';
  end if;
  if length(v_solution) < 5 then
    raise exception 'Describe the solution so the history stays useful.' using errcode = 'check_violation';
  end if;

  -- owner_id is deliberately untouched: the resolver is recorded separately.
  update public.tickets
  set status = 'resolved',
      solution = v_solution,
      resolved_by = v_actor.id,
      resolved_at = now(),
      waiting_reason = null
  where id = v_ticket.id;

  select a.display_name into v_owner_name
  from public.app_accounts a where a.id = v_ticket.owner_id;

  perform public.app_log_event(
    v_ticket.id, 'resolved', v_actor.id,
    case when v_ticket.owner_id is not null and v_ticket.owner_id <> v_actor.id
      then v_actor.display_name || ' resolved the ticket (owner ' || v_owner_name || ')'
      else v_actor.display_name || ' resolved the ticket'
    end,
    v_solution
  );

  return v_ticket.id;
end;
$$;

create or replace function public.app_reopen_ticket(p_ticket uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can reopen a ticket.' using errcode = 'insufficient_privilege';
  end if;
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status not in ('resolved', 'cancelled') then
    raise exception 'Only resolved or cancelled tickets can be reopened.' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Reopening needs a reason.' using errcode = 'check_violation';
  end if;

  -- The stored solution stays as the previous solution; only the resolution
  -- markers are cleared. Every prior event, note, device and log survives.
  update public.tickets
  set status = case when owner_id is null then 'open' else 'assigned' end,
      resolved_by = null,
      resolved_at = null,
      cancel_reason = null
  where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'reopened', v_actor.id,
    v_actor.display_name || ' reopened the ticket', btrim(p_reason)
  );

  return v_ticket.id;
end;
$$;

create or replace function public.app_cancel_ticket(p_ticket uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can cancel a ticket.' using errcode = 'insufficient_privilege';
  end if;
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'This ticket is already closed.' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Cancelling needs a reason.' using errcode = 'check_violation';
  end if;

  -- Cancelling is not a resolution: resolved_by/resolved_at stay empty.
  update public.tickets
  set status = 'cancelled', cancel_reason = btrim(p_reason), waiting_reason = null
  where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'cancelled', v_actor.id,
    v_actor.display_name || ' cancelled the ticket', btrim(p_reason)
  );

  return v_ticket.id;
end;
$$;

-- --- Grants ----------------------------------------------------------------
-- Mutations are for signed-in helpdesk accounts only; anon gets nothing.

revoke execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb),
  public.app_claim_ticket(uuid),
  public.app_reassign_ticket(uuid, uuid),
  public.app_return_ticket_to_queue(uuid),
  public.app_add_collaborator(uuid, uuid),
  public.app_remove_collaborator(uuid, uuid),
  public.app_add_note(uuid, text),
  public.app_record_device(uuid, text, text, text, text, text, boolean),
  public.app_set_priority(uuid, text),
  public.app_set_waiting(uuid, text),
  public.app_resume_work(uuid),
  public.app_log_work(uuid, integer, date, text),
  public.app_resolve_ticket(uuid, text),
  public.app_reopen_ticket(uuid, text),
  public.app_cancel_ticket(uuid, text)
from public, anon;

grant execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb),
  public.app_claim_ticket(uuid),
  public.app_reassign_ticket(uuid, uuid),
  public.app_return_ticket_to_queue(uuid),
  public.app_add_collaborator(uuid, uuid),
  public.app_remove_collaborator(uuid, uuid),
  public.app_add_note(uuid, text),
  public.app_record_device(uuid, text, text, text, text, text, boolean),
  public.app_set_priority(uuid, text),
  public.app_set_waiting(uuid, text),
  public.app_resume_work(uuid),
  public.app_log_work(uuid, integer, date, text),
  public.app_resolve_ticket(uuid, text),
  public.app_reopen_ticket(uuid, text),
  public.app_cancel_ticket(uuid, text)
to authenticated;
