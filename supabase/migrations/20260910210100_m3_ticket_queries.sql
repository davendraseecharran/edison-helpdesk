-- Queue reads for the application.
--
-- SECURITY INVOKER (the default) on purpose: these run with the CALLER'S
-- privileges, so every row-level security policy from M2 applies unchanged.
-- Nothing here is a view, and nothing bypasses RLS. That is what lets search,
-- filtering, ordering, counts and pagination all happen in SQL over exactly the
-- rows the caller is allowed to see — instead of fetching everything with a
-- privileged client and filtering in JavaScript.
--
-- The total is a window count over the same filtered, RLS-limited set, so a
-- paginated total can never reveal the existence of hidden tickets.

create or replace function public.app_list_tickets(
  p_scope text default 'open_queue',
  p_query text default null,
  p_status text default null,
  p_priority text default null,
  p_channel text default null,
  p_owner text default null,
  p_limit integer default 25,
  p_offset integer default 0
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
    left join public.app_accounts o on o.id = s.owner_id
    where (p_status is null or s.status = p_status)
      and (p_priority is null or s.priority = p_priority)
      and (p_channel is null or s.channel = p_channel)
      and (
        p_owner is null
        or (p_owner = 'unassigned' and s.owner_id is null)
        or (p_owner <> 'unassigned' and s.owner_id = p_owner::uuid)
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
         pg_catalog.count(*) over () as total_count
  from filtered f
  order by
    -- Closed history reads newest-first; live queues read worst-and-oldest first.
    case when p_scope = 'closed' then 0 else 1 end * 0
      + case when p_scope = 'closed' then 0 else
          case f.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end
        end,
    case when p_scope = 'closed' then coalesce(f.resolved_at, f.created_at) end desc,
    case when p_scope <> 'closed' then f.created_at end asc
  limit greatest(1, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.app_list_tickets(text, text, text, text, text, text, integer, integer) is
  'SECURITY INVOKER queue reader: RLS decides the rows, SQL does the search, ordering, counting and pagination.';

-- Counts for the navigation badges, over the same RLS-limited rows.
create or replace function public.app_queue_counts()
returns table (
  open_queue bigint,
  mine bigint,
  collaborating bigint,
  closed bigint,
  all_tickets bigint
)
language sql
stable
set search_path = ''
as $$
  with me as (
    select public.app_active_account_id() as account_id,
           public.app_is_admin() as is_admin
  )
  select
    pg_catalog.count(*) filter (where t.status = 'open' and t.owner_id is null),
    pg_catalog.count(*) filter (
      where t.owner_id = me.account_id
        and t.status in ('open', 'assigned', 'in_progress', 'waiting')
    ),
    pg_catalog.count(*) filter (
      where t.owner_id is distinct from me.account_id
        and t.status in ('open', 'assigned', 'in_progress', 'waiting')
        and exists (
          select 1 from public.ticket_collaborators tc
          where tc.ticket_id = t.id and tc.account_id = me.account_id
        )
    ),
    pg_catalog.count(*) filter (where t.status in ('resolved', 'cancelled')),
    -- count(t.id), not count(*): the LEFT JOIN yields one all-null row when
    -- there are no tickets, and count(*) would report that row as a ticket.
    case when me.is_admin then pg_catalog.count(t.id) else 0::bigint end
  from me left join public.tickets t on true
  group by me.is_admin;
$$;

-- One ticket with everything needed to render its detail view, still under RLS.
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
  left join public.app_accounts o on o.id = t.owner_id
  left join public.app_accounts c on c.id = t.created_by
  left join public.app_accounts rb on rb.id = t.resolved_by
  where t.id = p_ticket;
$$;

revoke execute on function
  public.app_list_tickets(text, text, text, text, text, text, integer, integer),
  public.app_queue_counts(),
  public.app_ticket_detail(uuid)
from public, anon;

grant execute on function
  public.app_list_tickets(text, text, text, text, text, text, integer, integer),
  public.app_queue_counts(),
  public.app_ticket_detail(uuid)
to authenticated;
