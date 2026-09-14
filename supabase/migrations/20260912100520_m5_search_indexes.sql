-- M5 global lookup, review round 2: the requester index, and the restructure
-- that measuring the lookup UNDER ROW-LEVEL SECURITY forced.
--
-- Round 1 (20260912100510) split each kind into one indexable subquery per
-- predicate and proved, with `explain (analyze, buffers)`, that the people-name,
-- ticket-title, ticket-issue, requester-name and device-model arms all plan as
-- bitmap index scans. Those plans were measured as the table owner, with RLS
-- bypassed. That was the wrong experiment, and it flattered the result.
--
-- ---------------------------------------------------------------------------
-- What RLS does to those plans
-- ---------------------------------------------------------------------------
--
-- app_search is SECURITY INVOKER, so every table it reads carries a policy qual.
-- PostgreSQL assigns RLS policy quals a lower security level than the caller's
-- own quals and refuses to evaluate a NON-LEAKPROOF qual before them: an index
-- condition is evaluated inside the index AM, before any filter, so a
-- non-leakproof qual cannot become one. `%` (pg_trgm) and `~~*` (ILIKE) are not
-- leakproof. get_relation_info() drops exactly those clauses from
-- index->indrestrictinfo once baserestrict_min_security > 0, so the planner
-- never even considers them as index conditions.
--
-- Re-measured as `authenticated` with a real session's claims, against 70,089
-- people / 76,170 tickets / 76,159 requesters / 15,212 devices:
--
--   people.display_name  Seq Scan, 13,921 ms   Filter: … display_name % 'Ea4b96c2'
--   tickets.title        Seq Scan, 15,816 ms   Filter: … title % '69e4a46c2'
--   tickets.issue        Seq Scan, 15,880 ms   Filter: … issue % '68ddd…'
--   requesters.name      Hash Join, 30,085 ms  both sides Seq Scan
--
-- Every trigram predicate moved from `Index Cond:` to `Filter:`. Not one index
-- survived contact with a policy. The times are that bad because the policy qual
-- calls app_active_account_id() once PER ROW, so the scan is not merely a scan,
-- it is 70,000 security-definer function calls.
--
-- ---------------------------------------------------------------------------
-- The fix: find ids without RLS, fetch rows with it
-- ---------------------------------------------------------------------------
--
-- app_search_candidates() is SECURITY DEFINER, so inside it there are no policy
-- quals, the trigram and LIKE predicates are ordinary restriction clauses again,
-- and every arm plans as the bitmap index scan round 1 measured. It returns
-- `(kind, id)` and NOTHING ELSE — no title, no name, no status, no count.
--
-- app_search stays SECURITY INVOKER and joins those ids back through
-- public.tickets, public.people and public.devices, which are RLS-governed for
-- the caller. A candidate the caller may not read produces no row, so the
-- policies remain the authority over what is returned. The helper's own gates
-- (below) are an optimisation and a second lock, not the guarantee.
--
-- Why the helper is safe to call directly. It has to be granted to
-- `authenticated`, because a SECURITY INVOKER caller runs with the caller's
-- privileges and could not otherwise call it. A bare id IS information — a
-- technician who could ask "does a ticket matching EDT-1042 exist" and get a
-- uuid back would learn exactly what tickets_select_visible exists to hide — so
-- the helper filters its own output to what the caller may read:
--
--   * people and devices: `app_active_account_id() is not null`, evaluated ONCE
--     in the term CTE rather than per row. That is the whole of
--     people_select_active and devices_select_active: those policies are
--     row-independent, so an id from either table is either visible to this
--     caller or none of them are.
--   * tickets: `app_can_view_ticket(id)`, which is not a second copy of
--     tickets_select_visible but the shared predicate function M2 wrote for it —
--     the same one activity_events, notes, work_logs and device_observations
--     police themselves with. It is applied to the candidate ids, so it runs
--     over a handful of rows rather than the whole table.
--
-- If those two ever drifted apart, the outer RLS-governed join is what decides,
-- so the failure mode is a row going missing, never a row being shown. That is
-- the direction a disagreement between them has to fail in.

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------

-- The requester-name arm reaches tickets by requester_id, and tickets had no
-- index on it: round 1's own ARM 4 plan hash-joined a full sequential scan of
-- 76,003 tickets to find the one ticket belonging to the requester it had just
-- found. Partial because a ticket recorded with an unknown requester is not
-- reachable from a requester and never matches this join.
create index tickets_requester_idx
  on public.tickets (requester_id)
  where requester_id is not null;

-- Still deliberately NOT added, and now for both tables rather than one: the
-- people identifier arms (osis, staff_id and email prefix) are in the same
-- position as the device identifier arms. `people_osis_idx`, `people_staff_id_idx`
-- and `people_email_idx`, like `devices_device_id_idx`, `devices_serial_idx` and
-- `devices_asset_tag_idx`, are plain btrees in the database's default collation,
-- and a default-collation btree cannot serve a LIKE prefix — only a
-- `text_pattern_ops` (or C-collation) index can. All six of those arms therefore
-- scan their table inside the helper. Six more indexes across the two largest
-- tables in the schema is a decision for the first measurement against a real
-- 2,800-person directory and 7,500-machine inventory, not for a review.

-- ---------------------------------------------------------------------------
-- app_search_candidates: ids only, no RLS, every arm indexable
-- ---------------------------------------------------------------------------

create function public.app_search_candidates(p_query text)
returns table (kind text, id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select nullif(pg_catalog.btrim(coalesce(p_query, '')), '') as raw
  ),
  escaped as (
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
      ) as pattern
    from q
    -- Two gates on one row, so both are evaluated ONCE rather than per row of
    -- three tables: a query under two characters is not a search, and an
    -- account that is not active reads nothing. With no row here every arm
    -- below is empty and the function returns without touching a table.
    where pg_catalog.length(q.raw) >= 2
      and public.app_active_account_id() is not null
  ),
  term as (
    select
      e.raw,
      e.pattern,
      pg_catalog.upper(e.raw) as folded,
      -- Upper-casing the escaped pattern is safe: the escapes it added are
      -- backslashes, which upper() leaves alone.
      pg_catalog.upper(e.pattern) as folded_pattern,
      -- A bare number is how a technician reads a ticket number off a printout:
      -- "1042" has to find EDT-1042. NULL when the query is anything else.
      case when e.raw ~ '^[0-9]+$' then e.raw end as digits
    from escaped e
  ),

  -- One arm per predicate, UNION (not UNION ALL) so a row matched by two of them
  -- is one candidate. Nothing selects a column other than the id.
  -- MATERIALIZED is load-bearing, not decoration. app_can_view_ticket() is
  -- STABLE, so without the fence the planner pushes it down through the UNION
  -- into every arm and evaluates it per SCANNED row rather than per candidate.
  -- Measured: 38.2 s and 3.2M buffer hits for a query with no ticket candidates
  -- at all, because the two unindexed `number ilike` arms scanned 76,004 tickets
  -- each and called a four-join SECURITY DEFINER function on every one of them.
  -- With the fence the same call is 0.15 s.
  ticket_ids as materialized (
    select tk.id from public.tickets tk cross join term t
    where tk.number ilike t.pattern || '%' escape '\'
    union
    select tk.id from public.tickets tk cross join term t
    where tk.number ilike 'EDT-' || t.pattern || '%' escape '\'
    union
    select tk.id from public.tickets tk cross join term t
    where tk.title operator(extensions.%) t.raw
    union
    select tk.id from public.tickets tk cross join term t
    where tk.issue operator(extensions.%) t.raw
    union
    -- Driven from requesters, not through a join qual inside an OR, so
    -- requesters_display_name_trgm finds the requester and tickets_requester_idx
    -- finds their tickets.
    select tk.id
    from public.requesters r
    join public.tickets tk on tk.requester_id = r.id
    cross join term t
    where r.display_name operator(extensions.%) t.raw
  ),
  person_ids as (
    select p.id from public.people p cross join term t
    where p.active and p.display_name operator(extensions.%) t.raw
    union
    select p.id from public.people p cross join term t
    where p.active and p.osis like t.pattern || '%' escape '\'
    union
    select p.id from public.people p cross join term t
    where p.active
      and pg_catalog.upper(p.staff_id) like t.folded_pattern || '%' escape '\'
    union
    select p.id from public.people p cross join term t
    where p.active and p.email ilike t.pattern || '%' escape '\'
  ),
  device_ids as (
    select d.id from public.devices d cross join term t
    where pg_catalog.upper(d.device_id) like t.folded_pattern || '%' escape '\'
    union
    select d.id from public.devices d cross join term t
    where pg_catalog.upper(d.serial_number) like t.folded_pattern || '%' escape '\'
    union
    select d.id from public.devices d cross join term t
    where pg_catalog.upper(d.asset_tag) like t.folded_pattern || '%' escape '\'
    union
    select d.id from public.devices d cross join term t
    where d.model operator(extensions.%) t.raw
  )

  -- The ticket candidates are cut down to what this caller may read before they
  -- leave the function, over the handful of ids the arms produced rather than
  -- over the table. People and devices need no per-row test: their policies are
  -- the active-account gate already spent in `escaped`.
  select 'ticket'::text, i.id from ticket_ids i where public.app_can_view_ticket(i.id)
  union all
  select 'person'::text, i.id from person_ids i
  union all
  select 'device'::text, i.id from device_ids i;
$$;

comment on function public.app_search_candidates(text) is
  'Trusted id-only half of app_search. SECURITY DEFINER so the trigram and LIKE predicates can be index conditions, which a row-level policy otherwise forbids because neither operator is leakproof. Returns (kind, id) and no row data, already filtered to what the caller may read: the active-account gate for people and devices, app_can_view_ticket for tickets. app_search joins these ids back through the RLS-governed tables, which remain the authority over what is returned.';

-- ---------------------------------------------------------------------------
-- app_search: unchanged in behaviour, RLS-governed as before, now fed by the
-- helper instead of scanning the tables itself.
-- ---------------------------------------------------------------------------

create or replace function public.app_search(p_query text, p_limit integer default 8)
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
  escaped as (
    select
      q.raw,
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(q.raw, '\', '\\'),
          '%', '\%'
        ),
        '_', '\_'
      ) as pattern
    from q
    where pg_catalog.length(q.raw) >= 2
  ),
  -- The same term the helper derived, recomputed here because this half ranks
  -- the rows and ranking needs the query. Identical by construction: a query
  -- under two characters produces no row in either, so both halves agree.
  term as (
    select
      e.raw,
      e.pattern,
      pg_catalog.upper(e.raw) as folded,
      pg_catalog.upper(e.pattern) as folded_pattern,
      case when e.raw ~ '^[0-9]+$' then e.raw end as digits
    from escaped e
  ),
  candidate as (
    select c.kind, c.id from public.app_search_candidates(p_query) c
  ),

  -- --- Tickets -------------------------------------------------------------
  -- The join to public.tickets is where row-level security is applied: a
  -- candidate id this caller cannot read matches no row and produces no output.
  ticket_hits as (
    select
      'ticket'::text as kind,
      tk.id,
      tk.number || ' ' || tk.title as title,
      -- Never blank: a ticket recorded with an unknown requester says so.
      coalesce(r.display_name, 'Requester unknown') as subtitle,
      -- Mirrors TICKET_STATUS_LABELS in src/lib/domain/types.ts. The `else` is
      -- unreachable while tickets_status_valid holds; it is there so a status
      -- added without updating this list renders as itself rather than as NULL.
      case tk.status
        when 'open' then 'Open'
        when 'assigned' then 'Assigned'
        when 'in_progress' then 'In progress'
        when 'waiting' then 'Waiting'
        when 'resolved' then 'Resolved'
        when 'cancelled' then 'Cancelled'
        else tk.status
      end as meta,
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
    from candidate c
    join public.tickets tk on tk.id = c.id
    -- LEFT: a ticket whose requester is unknown still has to be findable.
    left join public.requesters r on r.id = tk.requester_id
    cross join term t
    where c.kind = 'ticket'
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
      -- Already the text it renders as: an identifier has no label form.
      coalesce(p.osis, p.staff_id) as meta,
      case
        when p.osis = t.raw
          or pg_catalog.upper(p.staff_id) = t.folded
          or p.email = pg_catalog.lower(t.raw)
          then 1.0::real
        when p.osis like t.pattern || '%' escape '\'
          or pg_catalog.upper(p.staff_id) like t.folded_pattern || '%' escape '\'
          or p.email ilike t.pattern || '%' escape '\'
          then 0.9::real
        else extensions.similarity(p.display_name, t.raw)
      end as rank
    from candidate c
    join public.people p on p.id = c.id
    cross join term t
    where c.kind = 'person'
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
      -- The identifier a technician would read off the machine, in the order the
      -- rest of the schema prefers them.
      coalesce(d.asset_tag, d.serial_number, d.device_id) as title,
      nullif(pg_catalog.concat_ws(' ', d.model, d.type), '') as subtitle,
      -- The status in sentence case, and who has it right now. An unheld machine
      -- is normally in stock, which is why this reads "In stock" on its own; a
      -- retired or lost one says so instead of claiming to be on a shelf.
      case d.status
        when 'in_stock' then 'In stock'
        when 'deployed' then 'Deployed'
        when 'in_repair' then 'In repair'
        when 'retired' then 'Retired'
        when 'lost' then 'Lost'
        when 'surplus' then 'Surplus'
        else d.status
      end
      || case when x.holder_name is not null then ' — ' || x.holder_name else '' end as meta,
      case
        when pg_catalog.upper(d.device_id) = t.folded
          or pg_catalog.upper(d.serial_number) = t.folded
          or pg_catalog.upper(d.asset_tag) = t.folded
          then 1.0::real
        when pg_catalog.upper(d.device_id) like t.folded_pattern || '%' escape '\'
          or pg_catalog.upper(d.serial_number) like t.folded_pattern || '%' escape '\'
          or pg_catalog.upper(d.asset_tag) like t.folded_pattern || '%' escape '\'
          then 0.9::real
        else extensions.similarity(coalesce(d.model, ''), t.raw)
      end as rank
    from candidate c
    join public.devices d on d.id = c.id
    -- LEFT: an unassigned device is still findable, and the join can only ever
    -- add a name the caller is already allowed to read.
    left join held x on x.device_id = d.id
    cross join term t
    where c.kind = 'device'
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
  'SECURITY INVOKER global lookup over tickets, people and devices. Candidate ids come from app_search_candidates(), which is SECURITY DEFINER so the trigram and LIKE predicates can use an index; the rows themselves are fetched through the RLS-governed tables here, so the policies decide what is returned and it can only ever be what the caller could already read. Ranks an exact identifier at 1.0, a prefix at 0.9 and trigram similarity below that, and returns at most p_limit of each kind, where p_limit is clamped to 0..25 and defaults to 8. Every kind returns `meta` as rendered text: a ticket status label, a device status label with its current holder, a person''s OSIS or staff id. LIKE metacharacters in the query are literal text. A query under two characters, and any account that is not active, get nothing.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- The helper must be callable by `authenticated`: app_search runs with the
-- caller's privileges and could not otherwise call it. That is why the helper
-- filters its own output rather than trusting the wrapper to do it. anon gets
-- nothing from either.
-- ---------------------------------------------------------------------------

revoke execute on function public.app_search_candidates(text) from public, anon;
grant execute on function public.app_search_candidates(text) to authenticated;

revoke execute on function public.app_search(text, integer) from public, anon;
grant execute on function public.app_search(text, integer) to authenticated;
