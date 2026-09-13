-- M5 global lookup: one search box over tickets, people and devices.
--
-- SECURITY INVOKER (the default), and that is the whole security design. The
-- function runs with the CALLER'S privileges, so every row-level security policy
-- already in force decides what it can return:
--
--   * tickets    — tickets_select_visible: an admin sees all, a technician sees
--                  the Open Queue plus the tickets they own or collaborate on.
--                  A technician who types a colleague's ticket number gets no
--                  row, and learns nothing from the absence.
--   * people     — people_select_active: any ACTIVE account, nobody else.
--   * devices    — devices_select_active / device_assignments_select_active:
--                  likewise, because an assignment row names a student.
--
-- Nothing here is SECURITY DEFINER and nothing here is a view over privileged
-- data, so there is no second copy of the visibility rules to keep in step with
-- the first. An anonymous, inactive, setup_pending, pending_approval, denied,
-- credential-pending or stale-token caller reads nothing through any of those
-- policies, so the lookup answers them with no rows at all.
--
-- Two further rules.
--
-- What an operator types is TEXT. `%` is a percent sign and `_` is an
-- underscore, so both are escaped before the query reaches LIKE, exactly as
-- app_list_people and app_list_devices do. Without that, one keystroke would
-- return the whole inventory.
--
-- And a one-character query is not a search. The lookup fires on every keystroke
-- as somebody types, and "a" against 2,800 people and 7,500 devices is a
-- sequential scan producing a screenful of noise. Below two characters the
-- function returns nothing.

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------

-- people and devices already carry their trigram indexes (20260912100200 and
-- 20260912100300). tickets carries none, and the lookup matches a title fuzzily,
-- so it brings its own. Usable ONLY by a predicate that puts the search term on
-- one side of a trigram operator against the bare column:
--   where t.title operator(extensions.%) p_query
-- which is how the ticket branch below is written.
--
-- `issue` deliberately gets no index. It is long free text, a trigram index over
-- it would be far larger than the one over the titles, and at 20-40 new tickets
-- a day the table is small enough that the extra branch costs a scan nobody
-- notices. If that stops being true, the fix is an index here, not a change to
-- the function.
create index tickets_title_trgm
  on public.tickets using gin (title extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- app_search
-- ---------------------------------------------------------------------------

create function public.app_search(p_query text, p_limit integer default 8)
returns table (
  kind text,
  id uuid,
  title text,
  subtitle text,
  meta text,
  rank real
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
      -- Backslash is escaped first, or it would escape the escapes added after
      -- it. The result is a LIKE pattern that matches the typed text literally.
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(q.raw, '\', '\\'),
          '%', '\%'
        ),
        '_', '\_'
      ) as pattern,
      pg_catalog.upper(q.raw) as folded,
      -- A bare number is how a technician reads a ticket number off a printout:
      -- "1042" has to find EDT-1042. NULL when the query is anything else.
      case when q.raw ~ '^[0-9]+$' then q.raw end as digits
    from q
    -- The whole lookup hangs off this one row. An empty or one-character query
    -- produces no row here, so every branch below is empty and the function
    -- returns nothing without touching a table.
    where pg_catalog.length(q.raw) >= 2
  ),

  -- --- Tickets -------------------------------------------------------------
  ticket_hits as (
    select
      'ticket'::text as kind,
      tk.id,
      tk.number || ' ' || tk.title as title,
      -- Never blank: a ticket recorded with an unknown requester says so.
      coalesce(r.display_name, 'Requester unknown') as subtitle,
      -- The raw status value, so the application badges it the way every other
      -- ticket screen does rather than parsing a sentence back apart.
      tk.status as meta,
      case
        -- The number as written ("EDT-1042", any casing) or as bare digits.
        when tk.number = 'EDT-' || t.digits or pg_catalog.upper(tk.number) = t.folded
          then 1.0::real
        when tk.number ilike t.pattern || '%' escape '\'
          or tk.number ilike 'EDT-' || t.pattern || '%' escape '\'
          then 0.9::real
        else greatest(
          extensions.similarity(tk.title, t.raw),
          extensions.similarity(tk.issue, t.raw),
          extensions.similarity(coalesce(r.display_name, ''), t.raw)
        )
      end as rank
    from public.tickets tk
    -- LEFT: a ticket whose requester is unknown still has to be findable.
    left join public.requesters r on r.id = tk.requester_id
    cross join term t
    where tk.number ilike t.pattern || '%' escape '\'
      -- 'EDT-' || pattern covers both the bare-digit case and a partial number.
      or tk.number ilike 'EDT-' || t.pattern || '%' escape '\'
      or tk.title operator(extensions.%) t.raw
      or tk.issue operator(extensions.%) t.raw
      or r.display_name operator(extensions.%) t.raw
  ),

  -- --- People --------------------------------------------------------------
  person_hits as (
    select
      'person'::text as kind,
      p.id,
      p.display_name as title,
      nullif(
        pg_catalog.concat_ws(
          ' — ',
          pg_catalog.initcap(p.kind),
          -- A member of staff is placed by their department, a student by their
          -- official class.
          coalesce(p.department, p.official_class)
        ),
        ''
      ) as subtitle,
      coalesce(p.osis, p.staff_id) as meta,
      case
        when p.osis = t.raw
          or p.staff_id = t.folded
          or p.email = pg_catalog.lower(t.raw)
          then 1.0::real
        when p.osis like t.pattern || '%' escape '\'
          or p.staff_id ilike t.pattern || '%' escape '\'
          or p.email ilike t.pattern || '%' escape '\'
          then 0.9::real
        else extensions.similarity(p.display_name, t.raw)
      end as rank
    from public.people p
    cross join term t
    -- Archived people are out, matching what the directory listing shows by
    -- default: somebody who has left the school is not who an operator means
    -- when they type a name into the lookup bar. Their record is still reachable
    -- from the tickets and devices that name them.
    where p.active
      and (
        -- Trigram against the bare column, so people_display_name_trgm serves it.
        p.display_name operator(extensions.%) t.raw
        -- An identifier is matched from its start, the way it is read off a
        -- card. `osis` is digits only, so a case-sensitive LIKE is exact.
        or p.osis like t.pattern || '%' escape '\'
        or p.staff_id ilike t.pattern || '%' escape '\'
        or p.email ilike t.pattern || '%' escape '\'
      )
  ),

  -- --- Devices -------------------------------------------------------------
  held as (
    select a.device_id, h.display_name as holder_name
    from public.device_assignments a
    join public.people h on h.id = a.person_id
    where a.returned_at is null
  ),
  device_hits as (
    select
      'device'::text as kind,
      d.id,
      -- The identifier a technician would read off the machine, in the order
      -- the rest of the schema prefers them.
      coalesce(d.asset_tag, d.serial_number, d.device_id) as title,
      nullif(pg_catalog.concat_ws(' ', d.model, d.type), '') as subtitle,
      -- Status, and who has it right now. An unheld machine is normally
      -- `in_stock`, which is why this reads "In stock" on its own; a retired or
      -- lost one says so instead of claiming to be on a shelf.
      case
        when x.holder_name is not null
          then pg_catalog.initcap(pg_catalog.replace(d.status, '_', ' '))
               || ' — ' || x.holder_name
        else pg_catalog.initcap(pg_catalog.replace(d.status, '_', ' '))
      end as meta,
      case
        when pg_catalog.upper(d.device_id) = t.folded
          or pg_catalog.upper(d.serial_number) = t.folded
          or pg_catalog.upper(d.asset_tag) = t.folded
          then 1.0::real
        when pg_catalog.upper(d.device_id) like pg_catalog.upper(t.pattern) || '%' escape '\'
          or pg_catalog.upper(d.serial_number) like pg_catalog.upper(t.pattern) || '%' escape '\'
          or pg_catalog.upper(d.asset_tag) like pg_catalog.upper(t.pattern) || '%' escape '\'
          then 0.9::real
        else extensions.similarity(coalesce(d.model, ''), t.raw)
      end as rank
    from public.devices d
    -- LEFT: an unassigned device is still findable, and the join can only ever
    -- add a name the caller is already allowed to read.
    left join held x on x.device_id = d.id
    cross join term t
    where
      -- Identifiers match from their start, folded on both sides so the rule is
      -- about machines rather than about typing.
      pg_catalog.upper(d.device_id) like pg_catalog.upper(t.pattern) || '%' escape '\'
      or pg_catalog.upper(d.serial_number) like pg_catalog.upper(t.pattern) || '%' escape '\'
      or pg_catalog.upper(d.asset_tag) like pg_catalog.upper(t.pattern) || '%' escape '\'
      -- Trigram against the bare column, so devices can be found by model too.
      or d.model operator(extensions.%) t.raw
  ),

  -- --- One page per kind ---------------------------------------------------
  -- Three separately limited subqueries rather than one limited union: a lookup
  -- bar shows a few of each, and a query that matches four hundred laptops must
  -- not push the one ticket the operator wanted off the end of the list.
  ranked as (
    (
      select * from ticket_hits th
      order by th.rank desc, th.title, th.id
      limit greatest(0, least(coalesce(p_limit, 8), 25))
    )
    union all
    (
      select * from person_hits ph
      order by ph.rank desc, ph.title, ph.id
      limit greatest(0, least(coalesce(p_limit, 8), 25))
    )
    union all
    (
      select * from device_hits dh
      order by dh.rank desc, dh.title, dh.id
      limit greatest(0, least(coalesce(p_limit, 8), 25))
    )
  )
  select ranked.kind, ranked.id, ranked.title, ranked.subtitle, ranked.meta, ranked.rank
  from ranked
  -- kind, title and id break ties so the list is stable between keystrokes
  -- rather than reshuffling rows that scored the same.
  order by ranked.rank desc, ranked.kind, ranked.title, ranked.id;
$$;

comment on function public.app_search(text, integer) is
  'SECURITY INVOKER global lookup over tickets, people and devices: RLS decides the rows, so it can only return what the caller could already read. Ranks an exact identifier at 1.0, a prefix at 0.9 and trigram similarity below that, and returns at most p_limit of each kind. LIKE metacharacters in the query are literal text. A query under two characters, and any account that is not active, get nothing.';

-- ---------------------------------------------------------------------------
-- Grants. Supabase's default privileges grant EXECUTE on a new public function
-- to PUBLIC, so it is revoked and then granted to signed-in accounts only. anon
-- gets nothing; RLS is what limits an authenticated caller.
-- ---------------------------------------------------------------------------

revoke execute on function public.app_search(text, integer) from public, anon;
grant execute on function public.app_search(text, integer) to authenticated;
