-- M5: attachment registration becomes server-only.
--
-- Migration 20260912100800 gave `app_register_attachment` to `authenticated`,
-- which meant a session could write a registry row on its own. That is one
-- privilege too many, and the reason is the bytes.
--
-- An attachment row is a PROMISE that an object exists in the private bucket at
-- `path`, is one of five types, and is that many bytes. Nothing in the database
-- can check any of it: the bucket is unreachable from SQL, so the three fields
-- that describe the file were whatever the caller typed. A session could
-- therefore register a row for an object it never uploaded, or claim 24 KiB for
-- an 8 MiB file, or name a `image/png` that is really a PDF — and the registry
-- is the whole of attachment authorization, so a lie in it is a lie the
-- signed-URL endpoint will honour.
--
-- The fix is to move registration behind the one caller that CAN check: the
-- upload endpoint, which holds the service role, reads the stored object back
-- and registers it from what storage actually accepted rather than from what
-- the browser claimed. So:
--
--   * `app_trusted_register_attachment(p_actor, …)` is the new way in. It is
--     granted to `service_role` alone and takes the actor explicitly, because a
--     service-role connection has no `auth.uid()` to re-derive one from. The
--     server verifies the live session first and passes that account's id.
--   * `app_register_attachment` keeps its definition (nothing calls it, and
--     dropping a function another migration may reference buys nothing) but
--     loses its `authenticated` grant. It is superseded.
--
-- Passing the actor in is the dangerous part of this change, so the trusted
-- function re-derives EVERYTHING else from the database exactly as the session
-- version does: it reloads the account row and refuses it unless it is active
-- with no outstanding credential action, then applies the same contributor rule
-- to the same locked ticket, and logs the same events with that account as the
-- actor. The one check it cannot make is session currency — a service-role
-- connection has no token to compare — which is precisely why the upload
-- endpoint resolves the actor through `app_my_account()` in the user's own
-- session before it gets here.

set search_path = '';

-- ---------------------------------------------------------------------------
-- The contributor rule, for a named account
--
-- `app_can_attach` asked this question about the CALLER. The trusted path has
-- no caller to ask about, so the rule moves here, takes the account id as an
-- argument, and `app_can_attach` becomes the session-shaped wrapper over it.
-- One rule, two doors: the predicate a screen asks before it offers an upload
-- control and the predicate the server asserts before it writes the row can no
-- longer drift apart, because they are now the same function.
--
-- SECURITY DEFINER so it can read the ticket and its collaborators regardless
-- of what the caller may select, STABLE so a screen can ask it cheaply, and a
-- boolean rather than an exception so it stays usable from a read.
-- ---------------------------------------------------------------------------

create function public.app_account_can_attach(
  p_account uuid,
  p_ticket uuid,
  p_device uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
begin
  -- Exactly one parent. Both or neither is not a question about permission, it
  -- is a malformed question, and it fails closed.
  if (p_ticket is null) = (p_device is null) then
    return false;
  end if;

  if p_account is null then
    return false;
  end if;

  -- Active, and not suspended by an outstanding setup or recovery link. The
  -- same two gates `app_active_account_id()` applies, minus token currency,
  -- which belongs to a session and is checked where a session exists.
  select * into v_actor
  from public.app_accounts a
  where a.id = p_account
    and a.status = 'active'
    and a.credential_action_pending = false;
  if not found then
    return false;
  end if;

  -- Inventory is shared: any active account may attach a photograph of a
  -- cracked screen to the machine it belongs to.
  if p_device is not null then
    return exists (select 1 from public.devices d where d.id = p_device);
  end if;

  select * into v_ticket from public.tickets t where t.id = p_ticket;
  if not found then
    return false;
  end if;
  -- The contributor rule, in the same two halves app_require_contributor uses.
  if v_ticket.status in ('resolved', 'cancelled') then
    return false;
  end if;
  return v_actor.role = 'admin' or public.app_is_participant(v_ticket, v_actor.id);
end;
$$;

comment on function public.app_account_can_attach(uuid, uuid, uuid) is
  'Whether one named account may attach a file to this ticket or this device. Internal: the rule behind app_can_attach, shared with the trusted registration path so the two can never disagree.';

-- The session-shaped door onto the same rule. `create or replace` keeps the
-- existing grant to `authenticated`, and the behaviour is unchanged:
-- `app_active_account_id()` is NULL for an anonymous, inactive, setup_pending,
-- pending_approval, denied, credential-pending or stale-token caller, which the
-- helper above turns into false.
create or replace function public.app_can_attach(p_ticket uuid, p_device uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.app_account_can_attach(
    public.app_active_account_id(), p_ticket, p_device
  );
$$;

-- ---------------------------------------------------------------------------
-- Trusted registration
--
-- The body is `app_register_attachment`'s, with three differences and no
-- others: the actor arrives as an argument and is reloaded and re-checked here,
-- the permission assertion goes through `app_account_can_attach` for that
-- account, and nothing reads `auth.uid()`.
--
-- `performed_via` and `ai_model` are NOT arguments. They come from the request
-- headers through `app_log_event`/`app_log_record_event`, exactly as they do
-- for every other write, so an upload made through somebody's assistant is
-- recorded as theirs without attribution ever becoming a way to widen access.
-- ---------------------------------------------------------------------------

create function public.app_trusted_register_attachment(
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

  insert into public.attachments (
    ticket_id, device_id, path, filename, mime, bytes, uploaded_by
  ) values (
    p_ticket, p_device, v_path, v_filename, v_mime, p_bytes, v_actor.id
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

comment on function public.app_trusted_register_attachment(uuid, uuid, uuid, text, text, text, integer) is
  'Records one uploaded file against a ticket or a device on behalf of a named account. For the upload endpoint alone: it reads the stored object back and registers what storage actually accepted. Re-reads and re-judges the actor, then applies the same contributor, type, size and path rules as app_register_attachment.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- The trusted function is for the server and nobody else. `service_role` is NOT
-- in the revoke list: Supabase's default privileges grant EXECUTE to it
-- directly, and it is the only legitimate caller, so the grant below is the
-- explicit statement of that intent rather than a formality.
--
-- `app_account_can_attach` is internal. Nothing outside the database calls it;
-- `app_can_attach` is the door a session uses, and it keeps its own grant.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_account_can_attach(uuid, uuid, uuid),
  public.app_trusted_register_attachment(uuid, uuid, uuid, text, text, text, integer)
from public, anon, authenticated;

grant execute on function
  public.app_trusted_register_attachment(uuid, uuid, uuid, text, text, text, integer)
to service_role;

-- Superseded by the trusted function above. Kept so nothing that references it
-- breaks, but no session may call it: a registry row is now only ever written
-- by the endpoint that has seen the object it describes.
revoke execute on function
  public.app_register_attachment(uuid, uuid, text, text, text, integer)
from public, anon, authenticated;

comment on function public.app_register_attachment(uuid, uuid, text, text, text, integer) is
  'SUPERSEDED by app_trusted_register_attachment and no longer callable from a session. It trusted the caller''s own path, mime and byte count, none of which the database can verify; registration now happens in the upload endpoint, which reads the stored object back first.';
