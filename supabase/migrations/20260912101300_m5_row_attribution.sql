-- ---------------------------------------------------------------------------
-- M5: attribution on the rows the timeline does not cover.
--
-- `activity_events` and `record_events` already say whether a change was made
-- by a person or by that person's AI assistant, so the ticket timeline and the
-- record histories read "Priya Raman's AI started work". The rows themselves did
-- not: a note card, a work-log line, a device observation, an attachment tile,
-- an import-run row and the "Resolved by" line all named the person even when
-- their assistant did the work. This migration gives those six rows the same two
-- facts the event tables carry, and stamps them the same way: from the request
-- headers through `public.app_request_via()` / `public.app_request_ai_model()`,
-- never from an argument, so declaring an AI can only ever ADD attribution and
-- never change who is responsible or what they are allowed to do.
--
-- Additive throughout. Every column has a default, so every existing row keeps
-- its meaning ("a person did this"), and every read that did not ask for the new
-- keys is unaffected.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Columns
--
-- Same pair, same names and same check as `activity_events`, so one rule is
-- learned once. `tickets` is the exception: it already carries `resolved_by`
-- and `resolved_at` for a resolution that is separate from ownership, so the
-- resolution's attribution is named after it rather than shadowing the ticket's
-- own creation.
-- ---------------------------------------------------------------------------

alter table public.notes
  add column performed_via text not null default 'user',
  add column ai_model text,
  add constraint notes_performed_via_valid check (performed_via in ('user', 'ai'));

comment on column public.notes.performed_via is
  'Whether a person wrote this note directly or an AI assistant wrote it on their behalf. The author is the responsible account either way.';
comment on column public.notes.ai_model is
  'Model declared by an AI-assisted request. NULL for an ordinary user action.';

alter table public.work_logs
  add column performed_via text not null default 'user',
  add column ai_model text,
  add constraint work_logs_performed_via_valid check (performed_via in ('user', 'ai'));

comment on column public.work_logs.performed_via is
  'Whether a person recorded this time directly or an AI assistant recorded it on their behalf. The contributor is the responsible account either way.';
comment on column public.work_logs.ai_model is
  'Model declared by an AI-assisted request. NULL for an ordinary user action.';

alter table public.device_observations
  add column performed_via text not null default 'user',
  add column ai_model text,
  add constraint device_observations_performed_via_valid check (performed_via in ('user', 'ai'));

comment on column public.device_observations.performed_via is
  'Whether a person wrote this observation down directly or an AI assistant did it on their behalf. The recorder is the responsible account either way.';
comment on column public.device_observations.ai_model is
  'Model declared by an AI-assisted request. NULL for an ordinary user action.';

alter table public.attachments
  add column performed_via text not null default 'user',
  add column ai_model text,
  add constraint attachments_performed_via_valid check (performed_via in ('user', 'ai'));

comment on column public.attachments.performed_via is
  'Whether a person attached this file directly or an AI assistant attached it on their behalf. The uploader is the responsible account either way.';
comment on column public.attachments.ai_model is
  'Model declared by an AI-assisted request. NULL for an ordinary user action.';

alter table public.import_runs
  add column performed_via text not null default 'user',
  add column ai_model text,
  add constraint import_runs_performed_via_valid check (performed_via in ('user', 'ai'));

comment on column public.import_runs.performed_via is
  'Whether the administrator ran this import directly or an AI assistant ran it on their behalf. The actor is the responsible account either way.';
comment on column public.import_runs.ai_model is
  'Model declared by an AI-assisted request. NULL for an ordinary user action.';

alter table public.tickets
  add column resolved_via text not null default 'user',
  add column resolved_ai_model text,
  add constraint tickets_resolved_via_valid check (resolved_via in ('user', 'ai'));

comment on column public.tickets.resolved_via is
  'Whether the resolver closed this ticket directly or an AI assistant closed it on their behalf. resolved_by is the responsible account either way. Cleared back to ''user'' by a reopen, like resolved_by itself.';
comment on column public.tickets.resolved_ai_model is
  'Model declared by an AI-assisted resolution. NULL for an ordinary user action, and NULL once the ticket is reopened.';

-- ---------------------------------------------------------------------------
-- Writers
--
-- Each function below is its previous body with the attribution pair added to
-- the row it writes, read from the request exactly as `app_log_event` reads it.
-- Signatures are unchanged, so `create or replace` keeps every EXECUTE grant and
-- every caller; the grants are restated at the end of this file anyway.
-- ---------------------------------------------------------------------------

-- Body from 20260910200300_ticket_rpcs.sql. Only the note row changes.
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

  -- The note card names the author; these two say whether they typed it or
  -- their assistant did. Taken from the request, never from an argument.
  insert into public.notes (ticket_id, author_id, body, performed_via, ai_model)
  values (
    v_ticket.id, v_actor.id, btrim(p_body),
    public.app_request_via(), public.app_request_ai_model()
  )
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

-- Body from 20260910200300_ticket_rpcs.sql. Only the observation row changes.
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
    identifiers_not_applicable, recorded_by, performed_via, ai_model
  )
  values (
    v_ticket.id, btrim(p_device_type),
    nullif(btrim(coalesce(p_model, '')), ''),
    nullif(btrim(coalesce(p_os_version, '')), ''),
    nullif(btrim(coalesce(p_serial_number, '')), ''),
    nullif(btrim(coalesce(p_asset_tag, '')), ''),
    coalesce(p_identifiers_not_applicable, false),
    v_actor.id,
    public.app_request_via(), public.app_request_ai_model()
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

-- Body from 20260910200300_ticket_rpcs.sql. Only the work-log row changes.
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

  insert into public.work_logs (
    ticket_id, contributor_id, work_date, minutes, description, performed_via, ai_model
  )
  values (
    v_ticket.id, v_actor.id, v_date, p_minutes,
    nullif(btrim(coalesce(p_description, '')), ''),
    public.app_request_via(), public.app_request_ai_model()
  )
  returning id into v_log_id;

  perform public.app_log_event(
    v_ticket.id, 'time_logged', v_actor.id,
    v_actor.display_name || ' logged ' || p_minutes || ' minutes',
    nullif(btrim(coalesce(p_description, '')), '')
  );

  return v_log_id;
end;
$$;

-- Body from 20260910200300_ticket_rpcs.sql. Only the resolution markers change:
-- the resolver is still the account, and now the row also says whether they
-- closed the ticket themselves or their assistant did it for them.
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
      resolved_via = public.app_request_via(),
      resolved_ai_model = public.app_request_ai_model(),
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

-- Body from 20260912101000_m5_audit_notifications.sql. The resolution markers
-- now include the two new columns, for the same reason the others are cleared:
-- a reopened ticket has no resolver, so it cannot have a resolver's assistant.
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
      resolved_via = 'user',
      resolved_ai_model = null,
      cancel_reason = null
  where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'reopened', v_actor.id,
    v_actor.display_name || ' reopened the ticket', btrim(p_reason)
  );

  -- Work the owner thought was finished is theirs again. A ticket reopened while
  -- it sits in the Open Queue has nobody to tell.
  if v_ticket.owner_id is not null and v_ticket.owner_id <> v_actor.id then
    perform public.app_notify(
      v_ticket.owner_id,
      'ticket_reopened',
      v_ticket.number || ' was reopened',
      v_ticket.title,
      '/tickets/' || v_ticket.id
    );
  end if;

  return v_ticket.id;
end;
$$;

-- Body from 20260912101000_m5_audit_notifications.sql. Only the notification
-- title changes: it is the one notice in this schema that names the actor, and a
-- claim made through somebody's assistant has to say so in the same words the
-- timeline uses. The possessive is built here rather than in the reader, because
-- a notification title is stored text that nothing re-renders later.
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

-- ---------------------------------------------------------------------------
-- Trusted attachment registration.
--
-- Body from 20260912100810_m5_attachments_trusted.sql; only the registry insert
-- changes. That file already said attribution would arrive in the request
-- headers rather than as arguments, and it does: the upload endpoint builds its
-- service-role client with `x-edison-via` / `x-edison-ai-model` when the write
-- came through somebody's assistant, so `app_request_via()` reads them here
-- exactly as it does in a signed-in session.
-- ---------------------------------------------------------------------------

create or replace function public.app_trusted_register_attachment(
  p_actor uuid,
  p_ticket uuid,
  p_device uuid,
  p_path text,
  p_filename text,
  p_mime text,
  p_bytes integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The same five types the bucket accepts, kept in step with the bucket
  -- definition and with app_register_attachment.
  c_allowed_mime constant text[] := array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'
  ];
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_device public.devices;
  v_path text;
  v_filename text;
  v_mime text;
  v_prefix text;
  v_id uuid;
begin
  -- Migration 007's protocol: serialize against account-status and credential
  -- changes before reading authorization, with a shared lock so ordinary ticket
  -- writes still run in parallel.
  perform pg_catalog.pg_advisory_xact_lock_shared(1162103123, 1);

  -- The actor is re-read from the database and re-judged here. What the server
  -- sent is an id, never a role, a status or a name. A missing id and an id
  -- that names nobody give the same answer as a deactivated account, so the
  -- function cannot be used to find out which accounts exist.
  if p_actor is null then
    raise exception 'This account cannot access helpdesk records.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_actor from public.app_accounts a where a.id = p_actor;

  if not found or v_actor.status <> 'active' then
    raise exception 'This account cannot access helpdesk records.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_actor.credential_action_pending then
    raise exception 'Finish setting your password before using the helpdesk.'
      using errcode = 'insufficient_privilege';
  end if;

  if (p_ticket is null) = (p_device is null) then
    if p_ticket is null then
      raise exception 'Attach the file to a ticket or to a device.'
        using errcode = 'check_violation';
    end if;
    raise exception 'Attach the file to a ticket or to a device, not both.'
      using errcode = 'check_violation';
  end if;

  -- Authorization first, so a caller who may not touch the record learns
  -- nothing about it from a validation message.
  if p_ticket is not null then
    -- Missing and invisible give the same answer, and the row is locked so a
    -- concurrent resolution cannot slip a file onto a ticket as it closes.
    v_ticket := public.app_lock_ticket(p_ticket, v_actor);
    -- Closed, or not a contributor. Says which, and what to do about it.
    perform public.app_require_contributor(v_ticket, v_actor);
  else
    select * into v_device from public.devices d where d.id = p_device;
    if not found then
      raise exception 'That device is not in the inventory. Search for it again.'
        using errcode = 'no_data_found';
    end if;
  end if;

  -- The predicate the screen asked before it offered the upload control, asked
  -- again about the same account. It can only ever agree with the two checks
  -- above; asserting it here is what keeps that true if either side is changed.
  if not public.app_account_can_attach(v_actor.id, p_ticket, p_device) then
    raise exception 'You cannot attach a file to that record.'
      using errcode = 'insufficient_privilege';
  end if;

  v_filename := nullif(pg_catalog.btrim(coalesce(p_filename, '')), '');
  if v_filename is null then
    raise exception 'Give the file a name before attaching it.'
      using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_filename) > 255 then
    raise exception 'Shorten the file name to 255 characters or fewer.'
      using errcode = 'check_violation';
  end if;

  v_mime := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_mime, ''))), '');
  if v_mime is null or not (v_mime = any (c_allowed_mime)) then
    raise exception 'Attach a JPEG, PNG, WebP, GIF or PDF.'
      using errcode = 'check_violation';
  end if;

  if p_bytes is null or p_bytes <= 0 then
    raise exception 'That file is empty. Choose a file with contents and try again.'
      using errcode = 'check_violation';
  end if;
  if p_bytes > 8388608 then
    raise exception 'Attachments are limited to 8 MB. Compress the file and try again.'
      using errcode = 'check_violation';
  end if;

  v_path := nullif(pg_catalog.btrim(coalesce(p_path, '')), '');
  if v_path is null then
    raise exception 'Give the stored file a path.' using errcode = 'check_violation';
  end if;
  -- Checked before the prefix, so the message names the real problem rather
  -- than complaining about a prefix that is in fact present.
  if pg_catalog.strpos(v_path, '..') > 0 then
    raise exception 'A file path cannot contain "..". Upload the file again.'
      using errcode = 'check_violation';
  end if;

  v_prefix := case
    when p_ticket is not null then 'ticket/' || p_ticket::text || '/'
    else 'device/' || p_device::text || '/'
  end;
  -- Must start with the prefix AND have something after it: `ticket/<id>/`
  -- names a folder, not a file.
  if pg_catalog.left(v_path, pg_catalog.length(v_prefix)) <> v_prefix
    or pg_catalog.length(v_path) <= pg_catalog.length(v_prefix)
  then
    raise exception 'Store this file under %, so it stays with the record it belongs to.',
      v_prefix using errcode = 'check_violation';
  end if;

  -- The attachment tile names the uploader; these two say whether they chose
  -- the file themselves or their assistant did. The upload endpoint forwards
  -- `x-edison-via` and `x-edison-ai-model` on the service-role client it builds
  -- for this call (src/lib/data/attachments.ts), so the same request headers
  -- that attribute the history row attribute the registry row, and attribution
  -- still never arrives as an argument.
  insert into public.attachments (
    ticket_id, device_id, path, filename, mime, bytes, uploaded_by,
    performed_via, ai_model
  ) values (
    p_ticket, p_device, v_path, v_filename, v_mime, p_bytes, v_actor.id,
    public.app_request_via(), public.app_request_ai_model()
  )
  returning id into v_id;

  if p_ticket is not null then
    perform public.app_log_event(
      p_ticket, 'attachment_added', v_actor.id, 'Attached ' || v_filename
    );
  else
    perform public.app_log_record_event(
      'device', p_device, 'attachment_added', v_actor.id, 'Attached ' || v_filename || '.'
    );
  end if;

  return v_id;

exception
  -- "duplicate key value violates unique constraint attachments_path_key" tells
  -- an operator nothing they can act on.
  when unique_violation then
    raise exception 'That file has already been attached.' using errcode = 'unique_violation';
end;
$$;

-- ---------------------------------------------------------------------------
-- Intake.
--
-- Body from 20260912100360_m5_ticket_links_fixes.sql; only the device
-- observations written at intake change. A ticket raised through somebody's
-- assistant carries the machines it described, and those rows have to say so for
-- the same reason the ones added later do.
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
  v_device jsonb;
  v_device_type text;
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
  if length(btrim(coalesce(p_issue, ''))) = 0 then
    raise exception 'Describe the issue before saving.' using errcode = 'check_violation';
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
  if p_requester_unknown then
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

    -- One requester row per person: found, or made once and reused forever —
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
    raise exception 'Name the requester, or mark the requester as unknown.' using errcode = 'check_violation';
  end if;

  insert into public.tickets (
    title, issue, requester_id, requester_unknown, location, is_remote,
    channel, priority, status, submitted_on, created_by, owner_id, assigned_at,
    category
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
    case when v_owner is null then null else now() end,
    v_category
  )
  returning * into v_ticket;
  v_ticket_id := v_ticket.id;

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
      identifiers_not_applicable, recorded_by, performed_via, ai_model
    )
    values (
      v_ticket_id, v_device_type,
      nullif(btrim(coalesce(v_device ->> 'model', '')), ''),
      nullif(btrim(coalesce(v_device ->> 'osVersion', '')), ''),
      nullif(btrim(coalesce(v_device ->> 'serialNumber', '')), ''),
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
  'Records one request. p_person_id names somebody in the directory and finds or creates their single requester row in one statement, so two concurrent intakes for the same person both succeed. p_device_ids links inventory machines. Rejects a forged channel, owner, date or category rather than correcting it.';

-- ---------------------------------------------------------------------------
-- Imports.
--
-- Body from 20260912100410_m5_import_fixes.sql; only the committed run row
-- changes. The import history is the one place an operator can see what a whole
-- file did, so it has to say whether an administrator ran it or their assistant
-- ran it for them.
-- ---------------------------------------------------------------------------

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
      error_count, summary, performed_via, ai_model
    ) values (
      v_run_id, v_kind, v_mode, v_actor.id, v_total, v_inserts, v_updates,
      v_unchanged, pg_catalog.jsonb_array_length(v_errors), v_result,
      public.app_request_via(), public.app_request_ai_model()
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
-- Reads
--
-- Two of the three readers need no change at all, which is why they are named
-- here rather than left to be rediscovered:
--
--   * `app_ticket_detail` builds its `notes`, `work_logs` and `devices` entries
--     with `to_jsonb(row)` and its `ticket` object from `to_jsonb(t)`, so the new
--     columns appear as `performed_via` / `ai_model` on every note, work log and
--     device observation, and as `resolved_via` / `resolved_ai_model` on the
--     ticket, the moment they exist. Every existing key is untouched.
--   * `app_list_attachments` returns `setof public.attachments`, so it returns
--     the table's columns, new ones included. The device list is the same
--     function called with `p_device`.
--
-- `app_admin_import_runs` names its columns one by one, so it is the one reader
-- that has to be recreated. Its return type changes, which means dropping the
-- old function first and restating its grants below.
-- ---------------------------------------------------------------------------

drop function public.app_admin_import_runs(integer);

create function public.app_admin_import_runs(p_limit integer default 20)
returns table (
  id uuid,
  kind text,
  mode text,
  actor_id uuid,
  actor_name text,
  -- Next to the actor they qualify: the import history row says "Priya Raman"
  -- or "Priya Raman's AI", and never a different person either way.
  performed_via text,
  ai_model text,
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
           r.performed_via, r.ai_model,
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
  'Committed imports, newest first, with the name of the administrator who ran each one and whether they ran it themselves or their AI assistant did. Administrator session only. p_limit is clamped to 0..100; NULL means 20.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- `create or replace` preserved the ACL on every function above except
-- `app_admin_import_runs`, which was dropped and so starts again with the
-- EXECUTE that Supabase's default privileges grant to PUBLIC. All of them are
-- restated so this file says in full who may call what it recreated.
--
-- `app_trusted_register_attachment` keeps its own shape: the upload endpoint is
-- its only legitimate caller, so it is revoked from `authenticated` as well and
-- granted to `service_role` alone.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_add_note(uuid, text),
  public.app_record_device(uuid, text, text, text, text, text, boolean),
  public.app_log_work(uuid, integer, date, text),
  public.app_resolve_ticket(uuid, text),
  public.app_reopen_ticket(uuid, text),
  public.app_claim_ticket(uuid),
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[]),
  public.app_admin_import(text, jsonb, text),
  public.app_admin_import_runs(integer)
from public, anon;

grant execute on function
  public.app_add_note(uuid, text),
  public.app_record_device(uuid, text, text, text, text, text, boolean),
  public.app_log_work(uuid, integer, date, text),
  public.app_resolve_ticket(uuid, text),
  public.app_reopen_ticket(uuid, text),
  public.app_claim_ticket(uuid),
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[]),
  public.app_admin_import(text, jsonb, text),
  public.app_admin_import_runs(integer)
to authenticated;

revoke execute on function
  public.app_trusted_register_attachment(uuid, uuid, uuid, text, text, text, integer)
from public, anon, authenticated;

grant execute on function
  public.app_trusted_register_attachment(uuid, uuid, uuid, text, text, text, integer)
to service_role;
