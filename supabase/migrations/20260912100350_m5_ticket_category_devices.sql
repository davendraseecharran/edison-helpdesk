-- M5: what a ticket is about, whose it is, and which machines it touches.
--
-- This is the migration that joins the ticketing core of M2/M3 to the two M5
-- records that landed beside it — the people directory and the device inventory.
-- Three joins, and each one carries a decision worth stating.
--
-- 1. `category` is a small fixed vocabulary on the ticket, not free text. The
--    queue filter is therefore a real filter rather than a search over however
--    somebody happened to type "wifi", and the nine values are the nine kinds of
--    call this helpdesk actually takes. An unrecognised value is REFUSED rather
--    than folded to 'other': silently rewriting it would hide a broken caller
--    and file the ticket where nobody is looking for it. Existing rows take the
--    default, which is honest — nobody categorised them, and 'other' says so.
--
-- 2. A requester may now BE somebody in the directory. `requesters.person_id` is
--    UNIQUE where present, so a person has one requester row no matter how many
--    tickets they open; the whole point of a directory is that a person has one
--    record. The requester table stays, rather than tickets pointing at people
--    directly, because a walk-in from somebody who is not on the roster — a
--    parent, a vendor, a visiting coach — still has to be recordable, and
--    because every ticket already written names a requester row.
--
-- 3. `ticket_devices` is a link table between a ticket and real inventory, and
--    it is a CHILD OF THE TICKET for visibility: its row policy is
--    app_can_view_ticket, exactly like notes, work logs and device
--    observations. An account that cannot see the ticket cannot see which
--    machines it names. That is the opposite direction from `devices` itself,
--    which every active account may read, and the difference is deliberate: the
--    inventory is public to the helpdesk, but the fact that THIS laptop is
--    attached to THAT ticket is part of the ticket.
--
-- Note what `ticket_devices` does not replace. `device_observations` records
-- what a technician SAW — a model, a serial they read off a sticker, or an
-- explicit "no identifiers" — and it must keep working for a machine that is not
-- in the inventory at all. A link is a claim that this row in the inventory is
-- involved. A ticket can have both, and most will have neither.
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
-- A requester who is somebody in the directory
-- ---------------------------------------------------------------------------

-- RESTRICT, not CASCADE: a person who has opened a ticket cannot be deleted out
-- from under the requester row that names them. People are archived, never
-- deleted, so this is a backstop rather than a routine path.
alter table public.requesters
  add column person_id uuid references public.people (id) on delete restrict;

-- One requester row per person, enforced rather than assumed. Two technicians
-- recording a walk-in for the same student at the same instant cannot both
-- create a second copy of them, whatever the application does.
create unique index requesters_person_idx
  on public.requesters (person_id)
  where person_id is not null;

comment on column public.requesters.person_id is
  'The directory record this requester is, when they are on the roster. NULL for a requester typed in by hand — a parent, a vendor, a visitor — which stays recordable.';

-- ---------------------------------------------------------------------------
-- Linked inventory devices
-- ---------------------------------------------------------------------------

create table public.ticket_devices (
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  -- RESTRICT: a device that is named on a ticket cannot be deleted out from
  -- under it. A machine that has left the school is retired, not erased.
  device_id uuid not null references public.devices (id) on delete restrict,
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
-- this file and 20260912100800_m5_attachments.sql is
-- 20260912101010_m5_activity_kind_vocabulary.sql, which restates the union.
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
-- then the managed-device id. Every active account may read the whole inventory
-- (devices_select_active), so naming a device in ticket history — which only an
-- account that can see the ticket may read — exposes nothing it could not
-- already look up.
create function public.app_device_label(p_device public.devices)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_device.asset_tag, p_device.serial_number, p_device.device_id, 'an unlabelled device'
  );
$$;

comment on function public.app_device_label(public.devices) is
  'How a machine is named in ticket and device history: asset tag, else serial, else managed-device id.';

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
  v_device public.devices;
  v_label text;
begin
  if p_device is null then
    raise exception 'Choose a device from the inventory.' using errcode = 'check_violation';
  end if;

  -- SECURITY DEFINER, so this read is not under RLS. That is deliberate and
  -- safe: the caller has already established an active account, and an active
  -- account may read every device anyway.
  select * into v_device from public.devices d where d.id = p_device;
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
    'device', p_device, 'ticket_linked', p_actor.id,
    'Linked to ticket ' || p_ticket.number || '.'
  );
end;
$$;

revoke execute on function
  public.app_device_label(public.devices),
  public.app_link_device(public.tickets, uuid, public.app_accounts)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Intake, recreated.
--
-- The parameter list changes, so the old signature is dropped first; the three
-- new parameters are appended and all have defaults, so every existing caller
-- is unchanged. Everything before the requester block and after the device
-- block is the M2 function verbatim.
-- ---------------------------------------------------------------------------

drop function public.app_create_ticket(
  text, text, text, text, date, uuid, text, text, text, boolean, text, boolean,
  uuid, uuid[], jsonb
);

create function public.app_create_ticket(
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

    -- One requester row per person: found, or made once and reused forever.
    select r.id into v_requester
    from public.requesters r
    where r.person_id = p_person_id;

    if v_requester is null then
      insert into public.requesters (display_name, kind, descriptor, created_by, person_id)
      values (
        v_person.display_name,
        v_person.kind,
        nullif(btrim(coalesce(v_person.department, v_person.official_class, '')), ''),
        v_actor.id,
        p_person_id
      )
      returning id into v_requester;
    end if;
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
  'Records one request. p_person_id names somebody in the directory and reuses their single requester row; p_device_ids links inventory machines. Rejects a forged channel, owner, date or category rather than correcting it.';

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
  v_device public.devices;
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

  select * into v_device from public.devices d where d.id = p_device;
  v_label := coalesce(public.app_device_label(v_device), 'a device');

  perform public.app_log_event(
    v_ticket.id, 'device_unlinked', v_actor.id,
    v_actor.display_name || ' removed device ' || v_label || ' from this ticket'
  );
  perform public.app_log_record_event(
    'device', p_device, 'ticket_unlinked', v_actor.id,
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
-- Ticket detail, recreated with the category, the requester's person and the
-- linked machines. Same signature, so the grant survives; restated below anyway.
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
      -- The directory record behind the requester, when there is one. NULL for
      -- a requester typed in by hand, which stays a normal case.
      'person_id', r.person_id,
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
    -- Inventory machines this ticket names. SECURITY INVOKER, so the join runs
    -- under the caller's own policies: ticket_devices is a child of the ticket
    -- and devices needs an active account, and both must hold.
    'linked_devices', coalesce((
      select jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', dv.id,
          'device_id', dv.device_id,
          'serial_number', dv.serial_number,
          'asset_tag', dv.asset_tag,
          'type', dv.type,
          'model', dv.model,
          'status', dv.status,
          'linked_at', td.linked_at,
          'linked_by', td.linked_by
        )
        order by td.linked_at, dv.id
      )
      from public.ticket_devices td
      join public.devices dv on dv.id = td.device_id
      where td.ticket_id = t.id
    ), '[]'::jsonb),
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
-- app_device_detail, recreated with its tickets.
--
-- SECURITY INVOKER, so the join to public.tickets is already filtered by the
-- ticket policy. app_can_view_ticket is named anyway, because a reader of this
-- function should not have to go and check that it is.
-- ---------------------------------------------------------------------------

create or replace function public.app_device_detail(p_device uuid)
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
    'tickets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', t.id,
          'number', t.number,
          'title', t.title,
          'status', t.status,
          'created_at', t.created_at
        )
        order by t.created_at desc, t.id desc
      )
      from public.ticket_devices td
      join public.tickets t on t.id = td.ticket_id
      where td.device_id = d.id
        and public.app_can_view_ticket(t.id)
    ), '[]'::jsonb),
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
  'One device with its current holder, its loan history newest first, the tickets that name it THAT THE CALLER MAY SEE, and its events newest first. NULL when there is no such device or the caller may not see it.';

-- ---------------------------------------------------------------------------
-- app_person_detail, recreated with its tickets.
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
    -- The tickets this person asked for, THAT THE CALLER MAY SEE. SECURITY
    -- INVOKER, so the ticket policy filters the join; a technician therefore
    -- sees the student's open work only where they are already entitled to.
    -- Showing a count or a row for a ticket they may not read would leak its
    -- existence, which is the one thing the queue reader is careful about too.
    'tickets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', t.id,
          'number', t.number,
          'title', t.title,
          'status', t.status,
          'created_at', t.created_at
        )
        order by t.created_at desc, t.id desc
      )
      from public.requesters r
      join public.tickets t on t.requester_id = r.id
      where r.person_id = p.id
    ), '[]'::jsonb),
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
  'One directory record with its devices, the tickets it asked for that the caller may see, and its history. NULL when there is no such person or the caller may not see them.';

-- ---------------------------------------------------------------------------
-- app_list_people, recreated with its two counts.
--
-- Task 9 landed the device tables and recreated app_person_detail, which is what
-- its brief asked for, so both placeholder counts are filled in here.
--
-- open_ticket_count is counted under the CALLER'S OWN RLS, so a technician sees
-- the open work they are entitled to see rather than a number that quietly
-- announces the existence of a ticket somebody else owns. That is the same rule
-- the queue's total obeys, and the alternative — a SECURITY DEFINER count — is a
-- one-number leak of every ticket in the school.
-- ---------------------------------------------------------------------------

create or replace function public.app_list_people(
  p_query text default null,
  p_kind text default null,
  p_department text default null,
  p_class_of text default null,
  p_active boolean default true,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  kind text,
  display_name text,
  email text,
  osis text,
  staff_id text,
  department text,
  role_title text,
  official_class text,
  class_of text,
  active boolean,
  device_count integer,
  open_ticket_count integer,
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
      -- matched every person in the school and an underscore in an address
      -- matched any character. Backslash is escaped first, or it would escape
      -- the escapes added after it.
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(q.raw, '\', '\\'),
          '%', '\%'
        ),
        '_', '\_'
      ) as pattern
    from q
  ),
  filtered as (
    select p.*
    from public.people p, term t
    -- NULL means "every value of this field", not "no value": the directory
    -- screen sends nothing for a filter it is not applying. p_active is the one
    -- with a non-null default, because the archived rows are not what an
    -- operator means when they search for somebody.
    where (p_active is null or p.active = p_active)
      and (p_kind is null or p.kind = p_kind)
      and (p_department is null or p.department = p_department)
      and (p_class_of is null or p.class_of = p_class_of)
      and (
        t.raw is null
        -- A name is matched anywhere in it; an identifier only from its start.
        -- Prefix matching keeps "0143" from dragging back every phone-shaped
        -- number in the school, and matches how an operator reads a number off
        -- a label: from the left.
        --
        -- This whole disjunction is a sequential scan, by design. The first
        -- branch tests `t.raw`, not a column, so no index on public.people can
        -- serve the OR group, and the trigram indexes are not used here at all.
        or p.display_name ilike '%' || t.pattern || '%' escape '\'
        or p.email ilike t.pattern || '%' escape '\'
        or p.osis like t.pattern || '%' escape '\'
        or p.staff_id ilike t.pattern || '%' escape '\'
      )
  )
  select f.id, f.kind, f.display_name, f.email, f.osis, f.staff_id,
         f.department, f.role_title, f.official_class, f.class_of, f.active,
         -- What they are holding right now, not what they have ever held.
         (
           select pg_catalog.count(*)
           from public.device_assignments a
           where a.person_id = f.id and a.returned_at is null
         )::integer as device_count,
         -- Live work only: resolved and cancelled tickets are history, and a
         -- directory row saying "3 open" about three closed tickets would send
         -- a technician looking for work that is finished.
         (
           select pg_catalog.count(*)
           from public.requesters r
           join public.tickets t on t.requester_id = r.id
           where r.person_id = f.id
             and t.status in ('open', 'assigned', 'in_progress', 'waiting')
         )::integer as open_ticket_count,
         -- Window count over the same filtered, RLS-limited set, so a page total
         -- can never reveal the existence of rows the caller cannot see.
         pg_catalog.count(*) over () as total_count
  from filtered f
  -- id breaks ties so paging is deterministic when two people share a name.
  order by f.display_name asc, f.id asc
  -- Floor of zero, not one: a caller asking for no rows is asking for no rows,
  -- and a screen that wants only the total says so by passing 0.
  limit greatest(0, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.app_list_people(text, text, text, text, boolean, integer, integer) is
  'SECURITY INVOKER directory reader. device_count is what the person holds now; open_ticket_count is their live tickets THAT THE CALLER MAY SEE. LIKE metacharacters in the query are literal text. Returns nothing to an account that is not active.';

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
-- app_create_ticket and app_list_tickets were DROPPED above, which takes their
-- ACL with them, so their grants are made again rather than merely restated.
-- ---------------------------------------------------------------------------

revoke all on table public.ticket_devices from anon, authenticated;
grant select on table public.ticket_devices to authenticated;

revoke execute on function
  public.app_category_labels(),
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[]),
  public.app_set_category(uuid, text),
  public.app_link_ticket_device(uuid, uuid),
  public.app_unlink_ticket_device(uuid, uuid),
  public.app_list_tickets(text, text, text, text, text, text, integer, integer, text),
  public.app_ticket_detail(uuid),
  public.app_device_detail(uuid),
  public.app_person_detail(uuid),
  public.app_list_people(text, text, text, text, boolean, integer, integer)
from public, anon;

grant execute on function
  public.app_category_labels(),
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[]),
  public.app_set_category(uuid, text),
  public.app_link_ticket_device(uuid, uuid),
  public.app_unlink_ticket_device(uuid, uuid),
  public.app_list_tickets(text, text, text, text, text, text, integer, integer, text),
  public.app_ticket_detail(uuid),
  public.app_device_detail(uuid),
  public.app_person_detail(uuid),
  public.app_list_people(text, text, text, text, boolean, integer, integer)
to authenticated;
