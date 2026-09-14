-- ---------------------------------------------------------------------------
-- The M5 people list gets its own name until the rewire.
--
-- The owner's `20260913150000_inventory_management.sql` added
-- `app_list_people(p_kind text, p_query text, p_page integer)` over their
-- `requesters` directory. M5 already had
-- `app_list_people(p_query, p_kind, p_department, p_class_of, p_active,
-- p_limit, p_offset)` over `public.people`. Both are reachable, and PostgREST
-- picks an overload by the NAMES of the arguments sent, so the two do not
-- collide for a call that names every argument -- but a call naming only
-- p_kind and p_query is genuinely ambiguous, because the rest of both lists
-- have defaults, and no reader of the schema can tell which directory a call
-- means.
--
-- So the M5 one is renamed rather than left to luck. The owner's keeps the
-- plain name, because their `requesters` table is the source of truth for the
-- directory now; the M5 one becomes `app_list_people_m5` and is deleted
-- outright by the rewire task that retires `public.people`.
--
-- The body is `20260912100350_m5_ticket_category_devices.sql` verbatim. Still
-- SECURITY INVOKER: the row policy on `public.people` decides what a caller
-- sees, and that must not change just because the function changed name.
--
-- Additive: no table changes, no data changes.
-- ---------------------------------------------------------------------------

drop function public.app_list_people(text, text, text, text, boolean, integer, integer);

create function public.app_list_people_m5(
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


comment on function public.app_list_people_m5(text, text, text, text, boolean, integer, integer) is
  'SECURITY INVOKER directory reader over public.people. Renamed from app_list_people so it cannot be confused with the owner''s app_list_people(p_kind, p_query, p_page) over public.requesters; deleted when public.people is retired. device_count is what the person holds now; open_ticket_count is their live tickets THAT THE CALLER MAY SEE. LIKE metacharacters in the query are literal text. Returns nothing to an account that is not active.';

revoke execute on function
  public.app_list_people_m5(text, text, text, text, boolean, integer, integer)
from public, anon;

grant execute on function
  public.app_list_people_m5(text, text, text, text, boolean, integer, integer)
to authenticated;
