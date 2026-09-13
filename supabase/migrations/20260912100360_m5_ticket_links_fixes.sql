-- M5 ticket links: corrections to app_create_ticket and app_category_labels.
--
-- A separate migration rather than an edit to
-- 20260912100350_m5_ticket_category_devices.sql, because that one is already
-- applied. The tables, the indexes, the policies and the other functions are
-- untouched; app_create_ticket is recreated here with a full body, and its
-- grants are restated so this file is the whole statement of what it is.
--
-- Two things were wrong.
--
-- 1. The requester find-or-create for a directory person was a SELECT followed
--    by an INSERT. Between the two, `requesters_person_idx` is exactly the rule
--    that stops a second copy of a person being made — and it did, by raising
--    `duplicate key value violates unique constraint "requesters_person_idx"`
--    at whichever technician pressed Create second. Two people recording a
--    walk-in for the same student at the same moment is not an exotic
--    scenario; it is a Monday morning at the help desk, and the second one
--    should not see an index name.
--
--    The fix is to let the database do the find-or-create in one statement.
--    `on conflict (person_id) where person_id is not null do update set
--    person_id = excluded.person_id returning id` inserts when there is no row
--    and returns the existing row's id when there is, with no window between
--    the two. The `do update` is a deliberate no-op on the one column it
--    touches: the point is RETURNING, which `do nothing` would leave empty.
--    Nothing else about the existing requester is overwritten, because that row
--    is the authoritative one — a descriptor somebody corrected by hand must
--    not be reset by the next ticket.
--
-- 2. app_category_labels() was described in 100350 as an internal helper "not
--    granted to any client role" and then granted to `authenticated` in the
--    same file. The comment was right and the grant was wrong: the labels are
--    in TICKET_CATEGORY_LABELS in src/lib/domain/types.ts, no client calls the
--    function, and the two callers that do are SECURITY DEFINER and so run as
--    the owner regardless.

-- ---------------------------------------------------------------------------
-- app_create_ticket
--
-- Same signature, so `create or replace` keeps the existing ACL; it is restated
-- at the foot of this file anyway. Everything outside the requester block is
-- the 100350 function verbatim.
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
  'Records one request. p_person_id names somebody in the directory and finds or creates their single requester row in one statement, so two concurrent intakes for the same person both succeed. p_device_ids links inventory machines. Rejects a forged channel, owner, date or category rather than correcting it.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- app_category_labels() joins the internal helpers it was always described as
-- one of. service_role is named explicitly: Supabase's default privileges grant
-- ALL ON FUNCTIONS to it directly, so it does not lose EXECUTE when the grant to
-- PUBLIC is revoked.
-- ---------------------------------------------------------------------------

revoke execute on function public.app_category_labels()
from public, anon, authenticated, service_role;

-- Restated rather than changed: `create or replace` preserved this ACL, and
-- this file should say in full who may call the function it recreated.
revoke execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[])
from public, anon;

grant execute on function
  public.app_create_ticket(text, text, text, text, date, uuid, text, text, text, boolean, text, boolean, uuid, uuid[], jsonb, text, uuid, uuid[])
to authenticated;
