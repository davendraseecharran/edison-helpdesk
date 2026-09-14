-- M5: what a ticket is about and which machines it touches.
--
-- This is the migration that joins the ticketing core of M2/M3 to the district's
-- own inventory — `public.inventory_devices`, from the owner's
-- 20260912220000_directory_inventory.sql. Two joins, and each one carries a
-- decision worth stating.
--
-- 1. `category` is a small fixed vocabulary on the ticket, not free text. The
--    queue filter is therefore a real filter rather than a search over however
--    somebody happened to type "wifi", and the nine values are the nine kinds of
--    call this helpdesk actually takes. An unrecognised value is REFUSED rather
--    than folded to 'other': silently rewriting it would hide a broken caller
--    and file the ticket where nobody is looking for it. Existing rows take the
--    default, which is honest — nobody categorised them, and 'other' says so.
--
-- 2. `ticket_devices` is a link table between a ticket and real inventory, and
--    it is a CHILD OF THE TICKET for visibility: its row policy is
--    app_can_view_ticket, exactly like notes, work logs and device
--    observations. An account that cannot see the ticket cannot see which
--    machines it names. The inventory itself is read through SECURITY DEFINER
--    functions (the owner's tables carry RLS with no policies), and the
--    difference is deliberate: the inventory is available to the whole
--    helpdesk, but the fact that THIS laptop is attached to THAT ticket is part
--    of the ticket.
--
-- The requester stays the requester. `public.requesters` is the district's
-- directory now, so a ticket that names somebody on the roster names them
-- through `tickets.requester_id` directly — there is no second people table to
-- reconcile, and no `person_id` indirection.
--
-- Note what `ticket_devices` does not replace. `device_observations` records
-- what a technician SAW — a model, a serial they read off a sticker, or an
-- explicit "no identifiers" — and it must keep working for a machine that is
-- not in the inventory at all. A link is a claim that this row in the inventory
-- is involved. A ticket can have both, and most will have neither.
--
-- Additive only, and every earlier rule stays in force: identity is auth.uid()
-- only, clients get SELECT and nothing else, every write goes through a SECURITY
-- DEFINER RPC that re-derives the actor inside the database, the parent ticket
-- is locked before its children, and history is append-only.

-- ---------------------------------------------------------------------------
-- The category
-- ---------------------------------------------------------------------------

alter table public.tickets
  add column category text not null default 'other';

alter table public.tickets
  add constraint tickets_category_valid check (
    category in (
      'chromebook', 'laptop_desktop', 'projector_display', 'network',
      'printer', 'account', 'software', 'phone', 'other'
    )
  );

comment on column public.tickets.category is
  'What kind of problem this is, from a fixed vocabulary. Defaults to other, which is what an uncategorised ticket honestly is. Changed only by app_set_category.';

-- The queue filter sorts within a category the same way it sorts without one,
-- so the index carries the ordering columns rather than the category alone.
create index tickets_category_idx on public.tickets (category, priority, created_at);

-- ---------------------------------------------------------------------------
-- Linked inventory devices
-- ---------------------------------------------------------------------------

create table public.ticket_devices (
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  -- RESTRICT: a device that is named on a ticket cannot be deleted out from
  -- under it. A machine that has left the school is retired, not erased.
  device_id uuid not null references public.inventory_devices (id) on delete restrict,
  linked_by uuid not null references public.app_accounts (id) on delete restrict,
  linked_at timestamptz not null default now(),
  primary key (ticket_id, device_id)
);

comment on table public.ticket_devices is
  'Which inventory machines a ticket is about. A child of the ticket for visibility: only an account that can see the ticket can see what it names. Never writable from a session.';

-- The primary key serves the ticket-to-devices direction. The device page reads
-- the other one — every ticket that named this machine, newest first.
create index ticket_devices_device_idx on public.ticket_devices (device_id, linked_at desc);

-- ---------------------------------------------------------------------------
-- The activity vocabulary grows by three.
--
-- NOTE for whoever adds the next one: this constraint is a literal list, and
-- three migrations now drop and re-add it. Adding a kind means restating the
-- WHOLE list, including every kind added by a migration that sorts EARLIER than
-- yours — otherwise your re-add silently deletes theirs. The reconciliation for
-- this file and 20260914100800_m5_attachments.sql is
-- 20260914101010_m5_activity_kind_vocabulary.sql, which restates the union.
-- ---------------------------------------------------------------------------

alter table public.activity_events drop constraint activity_events_kind_valid;
alter table public.activity_events add constraint activity_events_kind_valid check (
  kind in (
    'created', 'claimed', 'assigned', 'returned_to_queue',
    'collaborator_added', 'collaborator_removed', 'note_added',
    'device_recorded', 'priority_changed', 'status_changed',
    'time_logged', 'resolved', 'reopened', 'cancelled',
    'category_changed', 'device_linked', 'device_unlinked'
  )
);

-- ---------------------------------------------------------------------------
-- Shared helpers. Not granted to any client role: called only by the functions
-- below, never from a session.
-- ---------------------------------------------------------------------------

-- How a machine is named in history. Asset tag first because that is the label
-- stuck on the lid and the thing an operator reads out loud; then the serial,
-- then the inventory's own external id. Every active account may look the whole
-- inventory up through app_list_inventory, so naming a device in ticket history
-- — which only an account that can see the ticket may read — exposes nothing it
-- could not already find.
create function public.app_device_label(p_device public.inventory_devices)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    nullif(pg_catalog.btrim(coalesce(p_device.asset_tag, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_device.serial_number, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_device.external_id, '')), ''),
    'an unlabelled device'
  );
$$;

comment on function public.app_device_label(public.inventory_devices) is
  'How a machine is named in ticket and device history: asset tag, else serial, else the inventory external id.';

-- The category labels, in one place, so the two functions that write history
-- and the one that validates cannot drift apart.
create function public.app_category_labels()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{
    "chromebook": "Chromebook",
    "laptop_desktop": "Laptop or desktop",
    "projector_display": "Projector or display",
    "network": "Network or Wi-Fi",
    "printer": "Printer",
    "account": "Account or password",
    "software": "Software",
    "phone": "Phone",
    "other": "Other"
  }'::jsonb;
$$;

comment on function public.app_category_labels() is
  'The ticket category vocabulary and its human labels. Mirrors TICKET_CATEGORY_LABELS in src/lib/domain/types.ts.';

-- Links one device to one ticket, writes both histories, and returns nothing.
-- The caller has already locked the ticket and proved the actor may contribute.
create function public.app_link_device(
  p_ticket public.tickets,
  p_device uuid,
  p_actor public.app_accounts
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.inventory_devices;
  v_label text;
begin
  if p_device is null then
    raise exception 'Choose a device from the inventory.' using errcode = 'check_violation';
  end if;

  -- SECURITY DEFINER, so this read is not under RLS. That is how the whole
  -- inventory is read: public.inventory_devices carries RLS with no policies,
  -- and the caller has already established an active account, which is what
  -- app_list_inventory asks for before showing the same row.
  select * into v_device from public.inventory_devices d where d.id = p_device;
  if not found then
    raise exception 'That device is not in the inventory. Search for it again.'
      using errcode = 'no_data_found';
  end if;
  v_label := public.app_device_label(v_device);

  if exists (
    select 1 from public.ticket_devices td
    where td.ticket_id = p_ticket.id and td.device_id = p_device
  ) then
    raise exception 'Device % is already linked to this ticket.', v_label
      using errcode = 'check_violation';
  end if;

  insert into public.ticket_devices (ticket_id, device_id, linked_by)
  values (p_ticket.id, p_device, p_actor.id);

  perform public.app_log_event(
    p_ticket.id, 'device_linked', p_actor.id,
    p_actor.display_name || ' linked device ' || v_label
  );
  -- And from the machine's side, so its page shows the whole story without
  -- reading ticket history it may not be allowed to read.
  perform public.app_log_record_event(
    'inventory_device', p_device, 'ticket_linked', p_actor.id,
    'Linked to ticket ' || p_ticket.number || '.'
  );
end;
$$;

revoke execute on function
  public.app_device_label(public.inventory_devices),
  public.app_link_device(public.tickets, uuid, public.app_accounts)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Intake is NOT recreated here.
--
-- Two branches each replaced app_create_ticket, and Postgres tells overloads
-- apart by their type signature, so a second create makes a second function
-- rather than replacing the first — and a PostgREST call naming only the
-- parameters they share then matches both. The reconciliation is one function
-- with one signature, and it is written once, in
-- 20260914120000_m5_create_ticket_merged.sql, after everything this file
-- creates exists for it to call. Until then the owner's function from
-- 20260912220000_directory_inventory.sql stands, untouched.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The category setter
-- ---------------------------------------------------------------------------

create function public.app_set_category(p_ticket uuid, p_category text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_labels jsonb := public.app_category_labels();
  v_category text := pg_catalog.btrim(coalesce(p_category, ''));
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);
  perform public.app_require_contributor(v_ticket, v_actor);

  if not (v_labels ? v_category) then
    raise exception 'Choose a category for this ticket.' using errcode = 'check_violation';
  end if;
  if v_ticket.category = v_category then
    raise exception 'The category is already %.', v_labels ->> v_category
      using errcode = 'check_violation';
  end if;

  update public.tickets set category = v_category where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'category_changed', v_actor.id,
    v_actor.display_name || ' changed the category from ' || (v_labels ->> v_ticket.category)
      || ' to ' || (v_labels ->> v_category)
  );
end;
$$;

comment on function public.app_set_category(uuid, text) is
  'Refiles one ticket under another category. Owner, collaborator or administrator, and not on a closed ticket.';

-- ---------------------------------------------------------------------------
-- Linking and unlinking inventory
-- ---------------------------------------------------------------------------

create function public.app_link_ticket_device(p_ticket uuid, p_device uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
begin
  v_actor := public.app_require_actor();
  -- Parent first, then its child: the lock order every ticket mutation uses.
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);
  perform public.app_require_contributor(v_ticket, v_actor);
  perform public.app_link_device(v_ticket, p_device, v_actor);
end;
$$;

comment on function public.app_link_ticket_device(uuid, uuid) is
  'Names one inventory machine on one ticket. Owner, collaborator or administrator, and not on a closed ticket. Writes both the ticket''s history and the device''s.';

create function public.app_unlink_ticket_device(p_ticket uuid, p_device uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_device public.inventory_devices;
  v_label text;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);
  perform public.app_require_contributor(v_ticket, v_actor);

  delete from public.ticket_devices td
  where td.ticket_id = v_ticket.id and td.device_id = p_device;

  if not found then
    raise exception 'That device is not linked to this ticket.' using errcode = 'check_violation';
  end if;

  select * into v_device from public.inventory_devices d where d.id = p_device;
  v_label := coalesce(public.app_device_label(v_device), 'a device');

  perform public.app_log_event(
    v_ticket.id, 'device_unlinked', v_actor.id,
    v_actor.display_name || ' removed device ' || v_label || ' from this ticket'
  );
  perform public.app_log_record_event(
    'inventory_device', p_device, 'ticket_unlinked', v_actor.id,
    'Removed from ticket ' || v_ticket.number || '.'
  );
end;
$$;

comment on function public.app_unlink_ticket_device(uuid, uuid) is
  'Removes one inventory machine from one ticket. The link is deleted; both histories keep the record that it was there.';

-- ---------------------------------------------------------------------------
-- Queue reads, recreated.
--
-- The parameter list changes, so the old signature is dropped first. p_category
-- is APPENDED after p_offset rather than inserted before p_limit: PostgREST
-- calls by name, but a positional caller must not have its limit silently
-- reinterpreted as a category. Every existing caller is unchanged.
-- ---------------------------------------------------------------------------

drop function public.app_list_tickets(text, text, text, text, text, text, integer, integer);

create function public.app_list_tickets(
  p_scope text default 'open_queue',
  p_query text default null,
  p_status text default null,
  p_priority text default null,
  p_channel text default null,
  p_owner text default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_category text default null
)
returns table (
  id uuid,
  number text,
  title text,
  issue text,
  requester_id uuid,
  requester_unknown boolean,
  requester_name text,
  location text,
  is_remote boolean,
  channel text,
  priority text,
  status text,
  category text,
  submitted_on date,
  created_at timestamptz,
  created_by uuid,
  owner_id uuid,
  owner_name text,
  assigned_at timestamptz,
  waiting_reason text,
  solution text,
  resolved_by uuid,
  resolved_at timestamptz,
  cancel_reason text,
  collaborator_ids uuid[],
  device_count integer,
  total_count bigint
)
language sql
stable
set search_path = ''
as $$
  with me as (
    select public.app_active_account_id() as account_id,
           public.app_is_admin() as is_admin
  ),
  scoped as (
    select t.*
    from public.tickets t, me
    where me.account_id is not null
      and case p_scope
        when 'open_queue' then t.status = 'open' and t.owner_id is null
        when 'mine' then t.owner_id = me.account_id
          and t.status in ('open', 'assigned', 'in_progress', 'waiting')
        when 'collaborating' then t.owner_id is distinct from me.account_id
          and t.status in ('open', 'assigned', 'in_progress', 'waiting')
          and exists (
            select 1 from public.ticket_collaborators tc
            where tc.ticket_id = t.id and tc.account_id = me.account_id
          )
        when 'closed' then t.status in ('resolved', 'cancelled')
        when 'all' then me.is_admin
        else false
      end
  ),
  filtered as (
    select s.*,
           r.display_name as requester_name,
           o.display_name as owner_name
    from scoped s
    left join public.requesters r on r.id = s.requester_id
    left join public.app_directory() o on o.id = s.owner_id
    where (p_status is null or s.status = p_status)
      and (p_priority is null or s.priority = p_priority)
      and (p_channel is null or s.channel = p_channel)
      -- A category outside the vocabulary matches nothing, which is what it
      -- describes. It is not an error and it is not "no filter".
      and (p_category is null or s.category = p_category)
      and (
        p_owner is null
        or (p_owner = 'unassigned' and s.owner_id is null)
        or (s.owner_id = case when p_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_owner::uuid else null end)
      )
      and (
        p_query is null
        or pg_catalog.btrim(p_query) = ''
        or s.number ilike '%' || pg_catalog.btrim(p_query) || '%'
        or s.title ilike '%' || pg_catalog.btrim(p_query) || '%'
        or s.issue ilike '%' || pg_catalog.btrim(p_query) || '%'
        or coalesce(s.location, '') ilike '%' || pg_catalog.btrim(p_query) || '%'
        or coalesce(r.display_name, '') ilike '%' || pg_catalog.btrim(p_query) || '%'
        or coalesce(o.display_name, '') ilike '%' || pg_catalog.btrim(p_query) || '%'
        or exists (
          select 1 from public.device_observations d
          where d.ticket_id = s.id
            and (
              d.device_type ilike '%' || pg_catalog.btrim(p_query) || '%'
              or coalesce(d.model, '') ilike '%' || pg_catalog.btrim(p_query) || '%'
              or coalesce(d.serial_number, '') ilike '%' || pg_catalog.btrim(p_query) || '%'
              or coalesce(d.asset_tag, '') ilike '%' || pg_catalog.btrim(p_query) || '%'
            )
        )
      )
  )
  select f.id, f.number, f.title, f.issue, f.requester_id, f.requester_unknown,
         f.requester_name, f.location, f.is_remote, f.channel, f.priority, f.status,
         f.category,
         f.submitted_on, f.created_at, f.created_by, f.owner_id, f.owner_name,
         f.assigned_at, f.waiting_reason, f.solution, f.resolved_by, f.resolved_at,
         f.cancel_reason,
         coalesce(
           array(
             select tc.account_id from public.ticket_collaborators tc
             where tc.ticket_id = f.id order by tc.added_at
           ),
           '{}'::uuid[]
         ) as collaborator_ids,
         (
           select pg_catalog.count(*)
           from public.ticket_devices td
           where td.ticket_id = f.id
         )::integer as device_count,
         pg_catalog.count(*) over () as total_count
  from filtered f
  order by
    -- Closed history reads newest-first; live queues read worst-and-oldest first.
    case when p_scope = 'closed' then 0 else 1 end * 0
      + case when p_scope = 'closed' then 0 else
          case f.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end
        end,
    case when p_scope = 'closed' then coalesce(f.resolved_at, f.created_at) end desc,
    case when p_scope <> 'closed' then f.created_at end asc,
    f.id asc
  limit greatest(1, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.app_list_tickets(text, text, text, text, text, text, integer, integer, text) is
  'SECURITY INVOKER queue reader: RLS decides the rows, SQL does the search, filtering, ordering, counting and pagination. device_count is the number of inventory machines the ticket names.';

-- ---------------------------------------------------------------------------
-- The linked machines of one ticket.
--
-- SECURITY DEFINER because public.inventory_devices carries RLS with no
-- policies at all: in the owner's design every read of the inventory goes
-- through a definer function. A definer must therefore prove the visibility
-- rule for itself, and this one does, in its first line — app_can_view_ticket
-- is exactly the rule the ticket_devices policy applies, so an account that
-- cannot see the ticket gets an empty list rather than its machines.
-- ---------------------------------------------------------------------------

create function public.app_ticket_devices(p_ticket uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', dv.id,
        'device_id', dv.external_id,
        'external_id', dv.external_id,
        'serial_number', dv.serial_number,
        'asset_tag', dv.asset_tag,
        'type', dv.device_type,
        'manufacturer', dv.manufacturer,
        'model', dv.model,
        'status', dv.status,
        'location', dv.location,
        'assigned_requester_id', dv.assigned_requester_id,
        'linked_at', td.linked_at,
        'linked_by', td.linked_by
      )
      order by td.linked_at, dv.id
    )
    from public.ticket_devices td
    join public.inventory_devices dv on dv.id = td.device_id
    where td.ticket_id = p_ticket
      and public.app_can_view_ticket(p_ticket)
  ), '[]'::jsonb);
$$;

comment on function public.app_ticket_devices(uuid) is
  'The inventory machines one ticket names, newest link last. Empty for a ticket the caller may not see.';

-- ---------------------------------------------------------------------------
-- Ticket detail, recreated with the category and the linked machines. Same
-- signature, so the grant survives; restated below anyway.
-- ---------------------------------------------------------------------------

create or replace function public.app_ticket_detail(p_ticket uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ticket', pg_catalog.to_jsonb(t) || jsonb_build_object(
      'requester_name', r.display_name,
      'requester_kind', r.kind,
      'requester_descriptor', r.descriptor,
      -- Who they are on the roster, when they are on it. NULL for a requester
      -- typed in by hand, which stays a normal case.
      'requester_external_id', r.external_id,
      'owner_name', o.display_name,
      'creator_name', c.display_name,
      'resolver_name', rb.display_name,
      'collaborator_ids', coalesce(
        array(
          select tc.account_id from public.ticket_collaborators tc
          where tc.ticket_id = t.id order by tc.added_at
        ),
        '{}'::uuid[]
      )
    ),
    'devices', coalesce((
      select jsonb_agg(pg_catalog.to_jsonb(d) order by d.recorded_at)
      from public.device_observations d where d.ticket_id = t.id
    ), '[]'::jsonb),
    -- Inventory machines this ticket names, through the helper above: this
    -- function is SECURITY INVOKER and public.inventory_devices has no client
    -- policy, so the join cannot be written here.
    'linked_devices', public.app_ticket_devices(t.id),
    'notes', coalesce((
      select jsonb_agg(pg_catalog.to_jsonb(n) order by n.created_at)
      from public.notes n where n.ticket_id = t.id
    ), '[]'::jsonb),
    'work_logs', coalesce((
      select jsonb_agg(pg_catalog.to_jsonb(w) order by w.work_date, w.created_at)
      from public.work_logs w where w.ticket_id = t.id
    ), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(pg_catalog.to_jsonb(e) order by e.at)
      from public.activity_events e where e.ticket_id = t.id
    ), '[]'::jsonb)
  )
  from public.tickets t
  left join public.requesters r on r.id = t.requester_id
  left join public.app_directory() o on o.id = t.owner_id
  left join public.app_directory() c on c.id = t.created_by
  left join public.app_directory() rb on rb.id = t.resolved_by
  where t.id = p_ticket;
$$;

comment on function public.app_ticket_detail(uuid) is
  'One ticket with everything the detail view renders, under the caller''s own RLS. linked_devices are the inventory machines it names; devices are the observations a technician wrote down.';

-- ---------------------------------------------------------------------------
-- Deliberately absent: app_device_detail, app_person_detail, app_list_people.
--
-- All three read public.people and public.devices, which this milestone
-- retires. The district's own directory and inventory already have readers,
-- written by the owner and now the only ones: app_get_person, app_list_people
-- (kind, query, page), app_get_inventory_device and app_list_inventory, with
-- app_requester_devices and app_lookup_inventory_code added in
-- 20260914130000_m5_inventory_workflow.sql. A person's tickets and a machine's
-- tickets are read from public.tickets and public.ticket_devices under the
-- caller's own policies, and their history from public.record_events, so no
-- function has to decide again who may see a ticket.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- ticket_devices inherits the parent ticket's visibility exactly, like every
-- other child table since 20260910200200_identity_rls.sql.
-- ---------------------------------------------------------------------------

alter table public.ticket_devices enable row level security;

create policy ticket_devices_select_visible
  on public.ticket_devices for select to authenticated
  using (public.app_can_view_ticket(ticket_id));

-- Deliberately absent: INSERT, UPDATE and DELETE policies. The two RPCs above
-- are the only way a link is made or removed, so every one of them is attributed
-- and recorded on both histories.

-- ---------------------------------------------------------------------------
-- Grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so the table is revoked explicitly and then re-granted
-- read-only. anon gets nothing at all.
--
-- app_list_tickets was DROPPED above, which takes its ACL with it, so its grant
-- is made again rather than merely restated.
-- ---------------------------------------------------------------------------

revoke all on table public.ticket_devices from anon, authenticated;
grant select on table public.ticket_devices to authenticated;

revoke execute on function
  public.app_category_labels(),
  public.app_set_category(uuid, text),
  public.app_link_ticket_device(uuid, uuid),
  public.app_unlink_ticket_device(uuid, uuid),
  public.app_list_tickets(text, text, text, text, text, text, integer, integer, text),
  public.app_ticket_devices(uuid),
  public.app_ticket_detail(uuid)
from public, anon;

grant execute on function
  public.app_category_labels(),
  public.app_set_category(uuid, text),
  public.app_link_ticket_device(uuid, uuid),
  public.app_unlink_ticket_device(uuid, uuid),
  public.app_list_tickets(text, text, text, text, text, text, integer, integer, text),
  public.app_ticket_devices(uuid),
  public.app_ticket_detail(uuid)
to authenticated;
