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

-- Body from 20260914101000_m5_audit_notifications.sql. The resolution markers
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

-- Body from 20260914101000_m5_audit_notifications.sql. Only the notification
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

  -- Fix round 1 (Ruling 30): unreachable while claiming requires an unowned ticket, so `v_previous` is always NULL here; kept for the day a previous-owner column exists.
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
-- Body from 20260914100810_m5_attachments_trusted.sql; only the registry insert
-- changes. The column is stamped from `app_request_via()`, exactly like every
-- other row this migration attributes: the function reads whatever headers the
-- request carried, and does not care that this call comes through
-- `adminClient()` rather than a signed-in session's client.
--
-- Fix round 1 (Ruling 30): no caller sets those headers on this path today.
-- `registerAttachment` (`src/lib/data/attachments.ts`) builds its service-role
-- client with `adminClient()`, which sends none, and the assistant has no
-- upload tool to send a write through in the first place. So an attachment
-- reads `performed_via = 'user'` in practice, always, whichever door the
-- upload came through. If an AI upload tool is ever added, forward
-- `x-edison-via` and `x-edison-ai-model` on the client `registerAttachment`
-- uses, the same way the ticket and record RPCs already do for a session.
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
  v_device public.inventory_devices;
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
    select * into v_device from public.inventory_devices d where d.id = p_device;
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
  -- the file themselves or their assistant did, read from `app_request_via()`
  -- and `app_request_ai_model()` like every other row this migration
  -- attributes. Attribution never arrives as an argument here either.
  --
  -- Fix round 1 (Ruling 30): today, always 'user'. The upload endpoint's
  -- service-role client (`adminClient()` in `src/lib/data/attachments.ts`)
  -- sends neither header, and the assistant has no upload tool that could ask
  -- it to. If one is added, forward `x-edison-via` and `x-edison-ai-model` on
  -- the client `registerAttachment` builds, and this row starts reading 'ai'
  -- exactly as a ticket event already does.
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
      'inventory_device', p_device, 'attachment_added', v_actor.id, 'Attached ' || v_filename || '.'
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
-- Deliberately absent: app_create_ticket, app_admin_import, app_admin_import_runs.
--
-- Intake used to be recreated here so that the device observations written at
-- the desk carried the same attribution pair as the ones added later. It is
-- written once now, in 20260914120000_m5_create_ticket_merged.sql, which sorts
-- after this file and carries the stamps itself — recreating it here would make
-- a second overload of a function two branches already fought over.
--
-- The in-app CSV importer is gone with the tables it wrote. The district's
-- directory and inventory arrive from the owner's own one-time preparation
-- scripts, and `public.requesters` / `public.inventory_devices` are edited
-- through app_save_person and app_save_inventory_device, which write their own
-- audit rows into public.inventory_events.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Grants
--
-- `create or replace` preserved the ACL on every function above, and they are
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
  public.app_claim_ticket(uuid)
from public, anon;

grant execute on function
  public.app_add_note(uuid, text),
  public.app_record_device(uuid, text, text, text, text, text, boolean),
  public.app_log_work(uuid, integer, date, text),
  public.app_resolve_ticket(uuid, text),
  public.app_reopen_ticket(uuid, text),
  public.app_claim_ticket(uuid)
to authenticated;

revoke execute on function
  public.app_trusted_register_attachment(uuid, uuid, uuid, text, text, text, integer)
from public, anon, authenticated;

grant execute on function
  public.app_trusted_register_attachment(uuid, uuid, uuid, text, text, text, integer)
to service_role;
