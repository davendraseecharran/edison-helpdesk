-- M5: attachments — the registry that says which uploaded file belongs to which
-- ticket or device, and who put it there.
--
-- Additive only, and every earlier rule stays in force: identity is auth.uid()
-- only, clients get SELECT and nothing else, every write goes through a SECURITY
-- DEFINER RPC that re-derives the actor inside the database, and history is
-- append-only.
--
-- Four decisions shape everything below.
--
-- 1. The BYTES are not here and are not reachable from a session. They live in a
--    private storage bucket with NO storage policies at all, which means no
--    client role can list, read or write an object in it. Every download is a
--    signed URL the server mints after it has decided the caller may have one,
--    and every upload is a server-side put. This table is therefore the whole of
--    attachment authorization: if a row should not exist, the file behind it can
--    never be handed out.
--
-- 2. A row names exactly ONE parent. `attachments_one_parent` makes that a rule
--    the database enforces rather than a convention, because the two parents
--    carry different authorization: a ticket attachment follows the CONTRIBUTOR
--    rule (owner, collaborator or administrator, and never a closed ticket)
--    while a device attachment follows the ACTIVE ACCOUNT rule, since inventory
--    is shared helpdesk property rather than one technician's work.
--
-- 3. The stored PATH has to live under the parent the row names. Without that, a
--    row pointing at `ticket/<some other ticket>/answer-key.pdf` would be a
--    perfectly ordinary registry entry that the signed-URL endpoint would
--    happily honour, and attaching a file to your own ticket would become a way
--    to read someone else's. `..` is refused for the same reason.
--
-- 4. Closing a ticket stops new uploads but never hides the ones already there.
--    The files are part of the record. Removing one from a closed ticket is an
--    administrator's decision, matching the rest of the closed-ticket rules.

-- ---------------------------------------------------------------------------
-- The private bucket
--
-- Guarded because `[storage] enabled = false` in supabase/config.toml, so a
-- local stack has no `storage` schema at all and an unguarded insert would make
-- every `supabase db reset` fail. A hosted project always has storage, so the
-- row is created there. `on conflict do nothing` keeps a re-apply harmless.
--
-- Deliberately absent: any policy on storage.objects. See decision 1 above.
-- ---------------------------------------------------------------------------

do $$
begin
  if pg_catalog.to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'attachments',
      'attachments',
      false,
      8388608,
      array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
    )
    on conflict (id) do nothing;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The registry
-- ---------------------------------------------------------------------------

create table public.attachments (
  id uuid primary key default extensions.gen_random_uuid(),
  ticket_id uuid references public.tickets (id) on delete cascade,
  device_id uuid references public.devices (id) on delete cascade,
  -- '<ticket|device>/<parent uuid>/<sanitised filename>', unique because it is
  -- the object key in the bucket and two rows may never claim the same file.
  path text not null unique,
  filename text not null,
  mime text not null,
  bytes integer not null check (bytes > 0 and bytes <= 8388608),
  -- RESTRICT: an account that attached a file cannot be deleted out from under
  -- the row that names them. Accounts are deactivated, never deleted.
  uploaded_by uuid not null references public.app_accounts (id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  constraint attachments_one_parent check ((ticket_id is null) <> (device_id is null))
);

comment on table public.attachments is
  'Which uploaded file belongs to which ticket or device. The bytes live in the private `attachments` bucket, reachable only through server-issued signed URLs. Never writable from a session: app_register_attachment and app_delete_attachment are the only ways in.';
comment on column public.attachments.path is
  'The object key in the private bucket. Always starts with ticket/<ticket id>/ or device/<device id>/ matching the parent this row names.';
comment on column public.attachments.bytes is
  'Size of the stored object. Capped at 8 MiB, the same limit the bucket enforces.';

create index attachments_ticket_idx on public.attachments (ticket_id, uploaded_at)
  where ticket_id is not null;
create index attachments_device_idx on public.attachments (device_id, uploaded_at)
  where device_id is not null;
create index attachments_uploader_idx on public.attachments (uploaded_by);

-- Attaching and removing are ticket history like any other change, so the
-- append-only vocabulary grows by two.
alter table public.activity_events drop constraint activity_events_kind_valid;
alter table public.activity_events add constraint activity_events_kind_valid check (
  kind in (
    'created', 'claimed', 'assigned', 'returned_to_queue',
    'collaborator_added', 'collaborator_removed', 'note_added',
    'device_recorded', 'priority_changed', 'status_changed',
    'time_logged', 'resolved', 'reopened', 'cancelled',
    'attachment_added', 'attachment_removed'
  )
);

-- ---------------------------------------------------------------------------
-- May this caller attach a file here?
--
-- SECURITY DEFINER so it can read the ticket and its collaborators regardless of
-- what the caller may select, and STABLE so a screen can ask it cheaply before
-- offering an upload control. It answers for the CALLER: the actor is re-derived
-- from auth.uid() inside the database, never passed in.
--
-- It returns a boolean rather than raising, which is what makes it usable from a
-- read. app_register_attachment therefore does NOT rely on it for the message an
-- operator sees — it reproduces the same decision through app_lock_ticket and
-- app_require_contributor, which say what is wrong and what to do — and then
-- checks this predicate as well, so the button the UI shows and the call the
-- server makes can never disagree.
-- ---------------------------------------------------------------------------

create function public.app_can_attach(p_ticket uuid, p_device uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_ticket public.tickets;
begin
  -- Exactly one parent. Both or neither is not a question about permission, it
  -- is a malformed question, and it fails closed.
  if (p_ticket is null) = (p_device is null) then
    return false;
  end if;

  -- NULL for an anonymous, inactive, setup_pending, pending_approval, denied,
  -- credential-pending or stale-token caller.
  v_account := public.app_active_account_id();
  if v_account is null then
    return false;
  end if;

  -- Inventory is shared: any active account may attach a photograph of a cracked
  -- screen to the machine it belongs to.
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
  return public.app_is_admin() or public.app_is_participant(v_ticket, v_account);
end;
$$;

comment on function public.app_can_attach(uuid, uuid) is
  'Whether the calling account may attach a file to this ticket or this device. Exactly one parent; fails closed for both, neither, an unknown record, a closed ticket, or a caller who is not an active contributor.';

-- ---------------------------------------------------------------------------
-- Writes. SECURITY DEFINER, actor re-derived inside the database.
-- ---------------------------------------------------------------------------

create function public.app_register_attachment(
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
  -- The same five types the bucket accepts. Kept beside the bucket definition
  -- above on purpose: storage refuses the upload and this refuses the row, so
  -- neither half can drift into accepting something the other would not.
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
  v_actor := public.app_require_actor();

  if (p_ticket is null) = (p_device is null) then
    if p_ticket is null then
      raise exception 'Attach the file to a ticket or to a device.'
        using errcode = 'check_violation';
    end if;
    raise exception 'Attach the file to a ticket or to a device, not both.'
      using errcode = 'check_violation';
  end if;

  -- Authorization first, so a caller who may not touch the record learns nothing
  -- about it from a validation message.
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

  -- The predicate the screen asked before it offered the upload control. It can
  -- only ever agree with the two checks above; asserting it here is what keeps
  -- that true if either side is ever changed.
  if not public.app_can_attach(p_ticket, p_device) then
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
  -- Checked before the prefix, so the message names the real problem rather than
  -- complaining about a prefix that is in fact present.
  if pg_catalog.strpos(v_path, '..') > 0 then
    raise exception 'A file path cannot contain "..". Upload the file again.'
      using errcode = 'check_violation';
  end if;

  v_prefix := case
    when p_ticket is not null then 'ticket/' || p_ticket::text || '/'
    else 'device/' || p_device::text || '/'
  end;
  -- Must start with the prefix AND have something after it: `ticket/<id>/` names
  -- a folder, not a file.
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

comment on function public.app_register_attachment(uuid, uuid, text, text, text, integer) is
  'Records one uploaded file against a ticket or a device. Refuses a closed ticket, a caller who is not a contributor, a type the bucket does not accept, an empty or over-sized file, and any path that does not live directly under the record it names.';

create function public.app_delete_attachment(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_row public.attachments;
  v_ticket public.tickets;
  v_admin boolean;
begin
  v_actor := public.app_require_actor();

  select * into v_row from public.attachments a where a.id = p_id for update;
  if not found then
    raise exception 'That attachment is no longer available.' using errcode = 'no_data_found';
  end if;

  v_admin := v_actor.role = 'admin';

  -- A caller who cannot see the record gets the same answer as one asking about
  -- an id that never existed, so the registry cannot be probed for the existence
  -- of a ticket's files.
  if v_row.ticket_id is not null and not public.app_can_view_ticket(v_row.ticket_id) then
    raise exception 'That attachment is no longer available.' using errcode = 'no_data_found';
  end if;

  -- Removing a file from a closed ticket is an administrator's decision, the
  -- same way every other change to a closed ticket is.
  if v_row.ticket_id is not null then
    select * into v_ticket from public.tickets t where t.id = v_row.ticket_id;
    if v_ticket.status in ('resolved', 'cancelled') and not v_admin then
      raise exception 'This ticket is closed. An administrator must reopen it first.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if not (v_admin or v_row.uploaded_by = v_actor.id) then
    raise exception 'Only the person who attached this file, or an administrator, can remove it.'
      using errcode = 'insufficient_privilege';
  end if;

  delete from public.attachments a where a.id = v_row.id;

  if v_row.ticket_id is not null then
    perform public.app_log_event(
      v_row.ticket_id, 'attachment_removed', v_actor.id, 'Removed ' || v_row.filename
    );
  else
    perform public.app_log_record_event(
      'device', v_row.device_id, 'attachment_removed', v_actor.id,
      'Removed ' || v_row.filename || '.'
    );
  end if;

  -- The caller is the server, which deletes the object from the bucket next. The
  -- row goes first: an orphaned object is an untidy bucket, whereas an orphaned
  -- row would be a broken download.
  return v_row.path;
end;
$$;

comment on function public.app_delete_attachment(uuid) is
  'Removes one attachment and returns its stored path so the server can delete the object. The uploader or an administrator; on a closed ticket, an administrator only. An attachment the caller cannot see is reported as unavailable rather than refused.';

-- ---------------------------------------------------------------------------
-- Reads. SECURITY INVOKER (the default) on purpose: this runs with the caller's
-- privileges, so the row policies below decide which rows come back and nothing
-- here can hand out a file belonging to a ticket the caller may not see.
-- ---------------------------------------------------------------------------

create function public.app_list_attachments(
  p_ticket uuid default null,
  p_device uuid default null
)
returns setof public.attachments
language sql
stable
set search_path = ''
as $$
  select a.*
  from public.attachments a
  -- Exactly one parent, like app_can_attach: both or neither returns nothing
  -- rather than quietly meaning "everything I can see".
  where (p_ticket is null) <> (p_device is null)
    and (p_ticket is null or a.ticket_id = p_ticket)
    and (p_device is null or a.device_id = p_device)
  -- Oldest first, so the list reads in the order the files were added, and id
  -- breaks ties when two arrive in the same instant.
  order by a.uploaded_at, a.id;
$$;

comment on function public.app_list_attachments(uuid, uuid) is
  'The attachments on one ticket or one device, oldest first. SECURITY INVOKER: RLS decides the rows, so a ticket''s files are visible exactly where the ticket is and a device''s to any active account. Returns nothing for both parents, neither parent, or a caller who may not see the record.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.attachments enable row level security;

-- Visibility follows the parent, which is why the row may only ever name one.
-- app_can_view_ticket is the same predicate the tickets, notes and device
-- observation policies use; app_active_account_id() returns NULL for an
-- anonymous, inactive, setup_pending, pending_approval, denied,
-- credential-pending or stale-token caller, so both branches fail closed.
create policy attachments_select_visible
  on public.attachments for select to authenticated
  using (
    case
      when ticket_id is not null then public.app_can_view_ticket(ticket_id)
      else public.app_active_account_id() is not null
    end
  );

-- Deliberately absent: INSERT, UPDATE and DELETE policies. Every change goes
-- through the RPCs above, so every attachment is attributed and recorded, and no
-- session can forge a path that points at another record's file.

-- ---------------------------------------------------------------------------
-- Grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so the table is revoked explicitly and then re-granted
-- read-only. anon gets nothing at all.
-- ---------------------------------------------------------------------------

revoke all on table public.attachments from anon, authenticated;
grant select on table public.attachments to authenticated;

revoke execute on function
  public.app_can_attach(uuid, uuid),
  public.app_register_attachment(uuid, uuid, text, text, text, integer),
  public.app_list_attachments(uuid, uuid),
  public.app_delete_attachment(uuid)
from public, anon;

grant execute on function
  public.app_can_attach(uuid, uuid),
  public.app_register_attachment(uuid, uuid, text, text, text, integer),
  public.app_list_attachments(uuid, uuid),
  public.app_delete_attachment(uuid)
to authenticated;
