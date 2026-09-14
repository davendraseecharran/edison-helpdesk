-- M5 global lookup: one search box over tickets, requesters and inventory.
--
-- This file is the whole of app_search. It used to be four — 100500 wrote it,
-- 100510 made every arm indexable, 100520 split it into a trusted id-only half
-- and an RLS-governed half after measuring it under a policy, and 100530 bound
-- the ticket-number arms and capped the candidate set. Three of those files
-- recreated a function over `public.people` and `public.devices`, which this
-- milestone retires in favour of the district's own `public.requesters` and
-- `public.inventory_devices`; rewriting three superseded bodies that never run
-- on their own would be three more chances to get the new tables wrong. The
-- rulings all four reached are kept below, because they are why this function
-- is shaped the way it is.
--
-- ---------------------------------------------------------------------------
-- Ruling 1 (100510): one arm per predicate, not one OR group per kind
-- ---------------------------------------------------------------------------
-- An OR whose branches span different columns — and, for tickets, a joined
-- table — cannot be served by any single index, so the planner scanned every
-- table on every keystroke. Each kind is a UNION of one subquery per predicate,
-- deduplicated by id, and the row is fetched once by id afterwards. Every
-- branch is a single predicate over one column of one table, which is what a
-- planner can serve from an index.
--
-- ---------------------------------------------------------------------------
-- Ruling 2 (100520): find ids without RLS, fetch rows with it
-- ---------------------------------------------------------------------------
-- Measured as `authenticated` with a real session's claims, every trigram
-- predicate moved from `Index Cond:` to `Filter:` and the lookup took fourteen
-- seconds. PostgreSQL will not evaluate a NON-LEAKPROOF qual before a row-level
-- policy qual, an index condition is evaluated before any filter, and neither
-- `%` (pg_trgm) nor `~~*` (ILIKE) is leakproof — so once a policy is in force
-- the planner does not even consider those clauses as index conditions.
--
-- So app_search_candidates() is SECURITY DEFINER, has no policy quals inside
-- it, and every arm plans as a bitmap index scan again. It returns `(kind, id)`
-- and NOTHING ELSE. app_search stays SECURITY INVOKER and joins those ids back
-- through public.tickets and public.requesters, which are RLS-governed for the
-- caller: a candidate the caller may not read produces no row, so the policies
-- remain the authority over what is returned.
--
-- A bare id IS information, and the helper has to be granted to `authenticated`
-- (a SECURITY INVOKER caller runs with the caller's privileges and could not
-- otherwise call it), so it filters its own output too:
--
--   * requesters and inventory: `app_active_account_id() is not null`,
--     evaluated ONCE in the term CTE rather than per row. That is the whole of
--     requesters_select_active, and it is exactly what the owner's
--     app_list_inventory requires before it shows the same machine.
--   * tickets: `app_can_view_ticket(id)`, which is not a second copy of
--     tickets_select_visible but the shared predicate function M2 wrote for it —
--     the same one notes, work logs and device observations police themselves
--     with. It runs over the candidate ids, not over the table.
--
-- If those ever drifted from the policies, the outer RLS-governed join is what
-- decides, so the failure mode is a row going missing, never a row being shown.
--
-- ---------------------------------------------------------------------------
-- Ruling 3 (this milestone): the inventory has no policy to join back through
-- ---------------------------------------------------------------------------
-- `public.inventory_devices` has row-level security enabled and NO POLICIES AT
-- ALL: the owner's design routes every read of the inventory through a SECURITY
-- DEFINER function, and that design is not loosened here. So the device half of
-- the join-back cannot be a plain join — it would return nothing — and it is
-- app_search_inventory_rows() instead: a projection of at most 200 machines by
-- id, behind the same active-account gate app_list_inventory uses. Tickets and
-- requesters are unchanged and still join back under the caller's own policies.
--
-- ---------------------------------------------------------------------------
-- Ruling 4 (100530): bound the ticket-number arms and cap the candidate set
-- ---------------------------------------------------------------------------
-- Every ticket number is 'EDT-' || nextval, so `number ilike 'ED%'` was true of
-- all of them and typing the prefix put the whole ticket table through
-- app_can_view_ticket(). Both number arms now require the query to carry
-- DIGITS: `digits` is the query with a leading `edt-`/`edt`/`ed`/`e` removed,
-- kept only when what remains is all digits. 'EDT-1042' -> 1042, 'edt-10' -> 10,
-- '1042' -> 1042; 'EDT', 'ED' and 'EDT-' -> NULL. A bare 'EDT' is not a dead
-- query: the title, issue and requester arms still run.
--
-- And each kind is `limit 200`, ordered by id. That bounds app_can_view_ticket
-- to 200 calls, and stops a signed-in caller enumerating the id of every person
-- and machine in the district from one broad term. Ordered by id rather than by
-- rank because ranking needs the row and this half deliberately reads none: a
-- query matching more than 200 records is not a lookup, and the answer somebody
-- wants is never in the tail of a list that long.
--
-- ---------------------------------------------------------------------------
-- Two rules that were there from the start
-- ---------------------------------------------------------------------------
-- What an operator types is TEXT. `%` is a percent sign and `_` is an
-- underscore, so both are escaped before the query reaches LIKE. Without that,
-- one keystroke would return the whole inventory.
--
-- And a one-character query is not a search. The lookup fires on every keystroke
-- as somebody types, and "a" against 3,709 people and 4,278 machines is a
-- sequential scan producing a screenful of noise. Below two characters the
-- function returns nothing.
--
-- `meta` is rendered text for every kind, never a raw column value: a ticket
-- status label, an inventory status with its current holder, a person's OSIS or
-- staff id. One field that means one thing.

-- ---------------------------------------------------------------------------
-- The trigram operators
--
-- Every fuzzy arm below is `column operator(extensions.%) query`, and every
-- index that serves one is a GIN index over extensions.gin_trgm_ops. Supabase
-- keeps extensions out of `public`, so both the extension and its operator
-- classes are schema-qualified everywhere they appear.
-- ---------------------------------------------------------------------------

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Indexes
--
-- One per trigram arm. Without these the shape above is pointless: an arm the
-- planner has to scan makes the whole branch a scan, and the indexed arms
-- beside it save nothing. `if not exists` on the owner's tables, because these
-- are additive and their migrations may grow one of the same name later.
-- ---------------------------------------------------------------------------

create index tickets_title_trgm
  on public.tickets using gin (title extensions.gin_trgm_ops);

-- The ticket-issue arm. Long free text and a bigger index than the titles, and
-- worth it anyway: once every other ticket arm is indexable, leaving this one to
-- a scan makes the whole branch a scan regardless.
create index tickets_issue_trgm
  on public.tickets using gin (issue extensions.gin_trgm_ops);

-- The requester-name arm reaches tickets by requester_id, and tickets had no
-- index on it: without this the arm hash-joins a full scan of the ticket table
-- to find the tickets of the requester it has just found. Partial because a
-- ticket recorded with an unknown requester is not reachable from a requester
-- and never matches this join.
create index tickets_requester_idx
  on public.tickets (requester_id)
  where requester_id is not null;

-- The three name arms over the directory. A person is looked for by the name
-- they are called, and by either half of it: the imported directory fills
-- first_name and last_name separately and display_name is not always the
-- concatenation somebody expects.
create index if not exists requesters_display_name_trgm
  on public.requesters using gin (display_name extensions.gin_trgm_ops);

create index if not exists requesters_first_name_trgm
  on public.requesters using gin (first_name extensions.gin_trgm_ops);

create index if not exists requesters_last_name_trgm
  on public.requesters using gin (last_name extensions.gin_trgm_ops);

-- The two fuzzy inventory arms. A model is not an identifier and neither is a
-- room, so none of the prefix arms sees either of them.
create index if not exists inventory_devices_model_trgm
  on public.inventory_devices using gin (model extensions.gin_trgm_ops);

create index if not exists inventory_devices_location_trgm
  on public.inventory_devices using gin (location extensions.gin_trgm_ops);

-- Deliberately NOT added: `text_pattern_ops` duplicates for the identifier arms
-- (a requester's OSIS, staff id and email; a machine's external id, serial and
-- asset tag). Those arms are prefix LIKE over `upper(column)`, and a btree in
-- the database's default collation cannot serve a LIKE prefix — only a
-- text_pattern_ops (or C-collation) index can — so they scan their table inside
-- the helper. Naming the fix without making it is deliberate: it is six more
-- indexes across the two largest tables the district owns, and it belongs with
-- the first measurement against the real 3,709-person directory and
-- 4,278-machine inventory rather than with a rewrite.

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
      --
      -- This is the SAME three replaces app_search does below, and the
      -- duplication is deliberate rather than missed. A shared SQL function
      -- would be a third object to grant, revoke and keep in step, and —
      -- because it would sit inside the predicate of every arm — one the
      -- planner has to inline for the trigram indexes to stay usable at all.
      -- If either copy is ever changed, change both: they have to produce the
      -- same pattern or app_search would rank rows its own predicates would not
      -- have matched.
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
      -- The ticket number the operator typed, if they typed one. NULL for
      -- 'EDT', for 'ED', and for every query that is not about a ticket number,
      -- which is what keeps the two number arms from matching the whole table.
      -- The alternation is longest-first so 'EDT-1042' loses 'EDT-' rather than
      -- just 'E'.
      case
        when pg_catalog.regexp_replace(e.raw, '^(edt-|edt|ed|e)', '', 'i') ~ '^[0-9]+$'
        then pg_catalog.regexp_replace(e.raw, '^(edt-|edt|ed|e)', '', 'i')
      end as digits
    from escaped e
  ),

  -- One arm per predicate, UNION (not UNION ALL) so a row matched by two of them
  -- is one candidate. Nothing selects a column other than the id.
  --
  -- MATERIALIZED is load-bearing, not decoration. app_can_view_ticket() is
  -- STABLE, so without the fence the planner pushes it down through the UNION
  -- into every arm and evaluates it per SCANNED row rather than per candidate.
  ticket_ids as materialized (
    select u.id from (
      -- The number as typed. Gated on digits so 'EDT' cannot reach it; still
      -- present beside the arm below because nothing in the schema FORCES a
      -- number to be 'EDT-' || digits, only the column default does.
      select tk.id from public.tickets tk cross join term t
      where t.digits is not null
        and tk.number ilike t.pattern || '%' escape '\'
      union
      -- The number rebuilt from the digits, which is what finds EDT-1042 from a
      -- bare "1042" read off a printout — and from "edt-1042" too, since the
      -- prefix was stripped to get here. Digits need no LIKE escaping.
      select tk.id from public.tickets tk cross join term t
      where t.digits is not null
        and tk.number ilike 'EDT-' || t.digits || '%'
      union
      select tk.id from public.tickets tk cross join term t
      where tk.title operator(extensions.%) t.raw
      union
      select tk.id from public.tickets tk cross join term t
      where tk.issue operator(extensions.%) t.raw
      union
      -- Driven from requesters, not through a join qual inside an OR, so
      -- requesters_display_name_trgm finds the requester and
      -- tickets_requester_idx finds their tickets.
      select tk.id
      from public.requesters r
      join public.tickets tk on tk.requester_id = r.id
      cross join term t
      where r.display_name operator(extensions.%) t.raw
    ) u
    -- By id, because ranking needs the row and this half reads none.
    order by u.id
    limit 200
  ),

  -- The directory. Only staff and students: 'role' and 'unknown' requester rows
  -- are the walk-in shorthand tickets are recorded against, not people somebody
  -- looks up by name.
  person_ids as (
    select u.id from (
      select r.id from public.requesters r cross join term t
      where r.kind in ('staff', 'student')
        and r.display_name operator(extensions.%) t.raw
      union
      select r.id from public.requesters r cross join term t
      where r.kind in ('staff', 'student')
        and r.first_name operator(extensions.%) t.raw
      union
      select r.id from public.requesters r cross join term t
      where r.kind in ('staff', 'student')
        and r.last_name operator(extensions.%) t.raw
      union
      -- An identifier is matched from its start, the way it is read off a card.
      -- source_external_id is the OSIS of a student and the staff id of a member
      -- of staff, and it is the one that never changes; external_id is the same
      -- thing for a student and a re-derived email prefix for staff, so both are
      -- searched.
      select r.id from public.requesters r cross join term t
      where r.kind in ('staff', 'student')
        and pg_catalog.upper(r.source_external_id) like t.folded_pattern || '%' escape '\'
      union
      select r.id from public.requesters r cross join term t
      where r.kind in ('staff', 'student')
        and pg_catalog.upper(r.external_id) like t.folded_pattern || '%' escape '\'
      union
      select r.id from public.requesters r cross join term t
      where r.kind in ('staff', 'student')
        and r.email ilike t.pattern || '%' escape '\'
      union
      -- An official class is how a student is found when nobody remembers the
      -- name: "who in 9R2 has a broken Chromebook".
      select r.id from public.requesters r cross join term t
      where r.kind = 'student'
        and pg_catalog.upper(r.official_class) like t.folded_pattern || '%' escape '\'
    ) u
    order by u.id
    limit 200
  ),

  device_ids as (
    select u.id from (
      -- Identifiers match from their start, folded on both sides so the rule is
      -- about machines rather than about typing.
      select d.id from public.inventory_devices d cross join term t
      where pg_catalog.upper(d.external_id) like t.folded_pattern || '%' escape '\'
      union
      select d.id from public.inventory_devices d cross join term t
      where pg_catalog.upper(d.serial_number) like t.folded_pattern || '%' escape '\'
      union
      select d.id from public.inventory_devices d cross join term t
      where pg_catalog.upper(d.asset_tag) like t.folded_pattern || '%' escape '\'
      union
      select d.id from public.inventory_devices d cross join term t
      where d.model operator(extensions.%) t.raw
      union
      select d.id from public.inventory_devices d cross join term t
      where d.location operator(extensions.%) t.raw
    ) u
    order by u.id
    limit 200
  )

  -- The ticket candidates are cut down to what this caller may read before they
  -- leave the function, over at most 200 ids rather than over the table. The
  -- other two need no per-row test: their gate is the active-account one
  -- already spent in `escaped`.
  select 'ticket'::text, i.id from ticket_ids i where public.app_can_view_ticket(i.id)
  union all
  select 'person'::text, i.id from person_ids i
  union all
  select 'device'::text, i.id from device_ids i;
$$;

comment on function public.app_search_candidates(text) is
  'Trusted id-only half of app_search. SECURITY DEFINER so the trigram and LIKE predicates can be index conditions, which a row-level policy otherwise forbids because neither operator is leakproof. Returns (kind, id) and no row data, at most 200 of each kind, already filtered to what the caller may read: the active-account gate for requesters and inventory, app_can_view_ticket for tickets. The two ticket-number arms run only when the query carries digits, so a bare ''EDT'' — a prefix every ticket number shares — matches no number.';

-- ---------------------------------------------------------------------------
-- app_search_inventory_rows: the inventory half of the join-back
--
-- public.inventory_devices carries row-level security with no policies at all,
-- so there is nothing for a SECURITY INVOKER join to join back THROUGH. This is
-- that join instead: a projection of named machines behind the same
-- active-account gate the owner's app_list_inventory applies before it shows
-- the same row, capped so it can never be used to page the inventory out.
-- ---------------------------------------------------------------------------

create function public.app_search_inventory_rows(p_ids uuid[])
returns table (
  id uuid,
  external_id text,
  device_type text,
  manufacturer text,
  model text,
  serial_number text,
  asset_tag text,
  status text,
  location text,
  holder_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.external_id, d.device_type, d.manufacturer, d.model,
         d.serial_number, d.asset_tag, d.status, d.location, h.display_name
  from public.inventory_devices d
  -- LEFT: an unassigned machine is still findable, and the join can only ever
  -- add a name the caller is already allowed to read.
  left join public.requesters h on h.id = d.assigned_requester_id
  where d.id = any (coalesce(p_ids, '{}'::uuid[]))
    and public.app_active_account_id() is not null
  order by d.id
  limit 200;
$$;

comment on function public.app_search_inventory_rows(uuid[]) is
  'The named inventory machines, for an active account, at most 200 of them. SECURITY DEFINER because public.inventory_devices has row-level security and no policies: in the owner''s design every read of the inventory goes through a definer function, and this is the one app_search uses.';

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
      pg_catalog.upper(e.pattern) as folded_pattern
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
        -- The number as written ("EDT-1042", any casing).
        when pg_catalog.upper(tk.number) = t.folded then 1.0::real
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
  -- requesters_select_active is applied by this join, the same way the ticket
  -- policy is applied by the one above.
  person_hits as (
    select
      'person'::text as kind,
      r.id,
      r.display_name as title,
      nullif(
        pg_catalog.concat_ws(
          ' — ',
          pg_catalog.initcap(r.kind),
          -- A member of staff is placed by their department, a student by their
          -- official class.
          coalesce(
            nullif(pg_catalog.btrim(coalesce(r.department, '')), ''),
            nullif(pg_catalog.btrim(coalesce(r.official_class, '')), '')
          )
        ),
        ''
      ) as subtitle,
      -- Already the text it renders as: an identifier has no label form.
      coalesce(
        nullif(pg_catalog.btrim(coalesce(r.source_external_id, '')), ''),
        nullif(pg_catalog.btrim(coalesce(r.external_id, '')), '')
      ) as meta,
      case
        when pg_catalog.upper(r.source_external_id) = t.folded
          or pg_catalog.upper(r.external_id) = t.folded
          or pg_catalog.lower(r.email) = pg_catalog.lower(t.raw)
          then 1.0::real
        when pg_catalog.upper(r.source_external_id) like t.folded_pattern || '%' escape '\'
          or pg_catalog.upper(r.external_id) like t.folded_pattern || '%' escape '\'
          or r.email ilike t.pattern || '%' escape '\'
          then 0.9::real
        else greatest(
          extensions.similarity(r.display_name, t.raw),
          extensions.similarity(coalesce(r.first_name, ''), t.raw),
          extensions.similarity(coalesce(r.last_name, ''), t.raw)
        )
      end as rank
    from candidate c
    join public.requesters r on r.id = c.id
    cross join term t
    where c.kind = 'person'
  ),

  -- --- Devices -------------------------------------------------------------
  device_hits as (
    select
      'device'::text as kind,
      d.id,
      -- The identifier a technician would read off the machine, in the order the
      -- rest of the schema prefers them.
      coalesce(
        nullif(pg_catalog.btrim(coalesce(d.asset_tag, '')), ''),
        nullif(pg_catalog.btrim(coalesce(d.serial_number, '')), ''),
        d.external_id
      ) as title,
      nullif(pg_catalog.concat_ws(' ', d.manufacturer, d.model, d.device_type), '') as subtitle,
      -- The status the inventory records, which is already the label
      -- app_inventory_statuses() offers — Available, Assigned, In repair,
      -- Retired, Lost, or whatever else the district has written — and who is
      -- holding the machine right now.
      coalesce(nullif(pg_catalog.btrim(coalesce(d.status, '')), ''), 'No status')
        || case when d.holder_name is not null then ' — ' || d.holder_name else '' end as meta,
      case
        when pg_catalog.upper(d.external_id) = t.folded
          or pg_catalog.upper(d.serial_number) = t.folded
          or pg_catalog.upper(d.asset_tag) = t.folded
          then 1.0::real
        when pg_catalog.upper(d.external_id) like t.folded_pattern || '%' escape '\'
          or pg_catalog.upper(d.serial_number) like t.folded_pattern || '%' escape '\'
          or pg_catalog.upper(d.asset_tag) like t.folded_pattern || '%' escape '\'
          then 0.9::real
        else greatest(
          extensions.similarity(coalesce(d.model, ''), t.raw),
          extensions.similarity(coalesce(d.location, ''), t.raw)
        )
      end as rank
    from public.app_search_inventory_rows(
      array(select c.id from candidate c where c.kind = 'device')
    ) d
    cross join term t
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
  'SECURITY INVOKER global lookup over tickets, the district directory and the inventory. Candidate ids come from app_search_candidates(), which is SECURITY DEFINER so the trigram and LIKE predicates can use an index; tickets and requesters are then fetched through their own policies, and machines through app_search_inventory_rows(), because inventory_devices has no policy to fetch them through. Ranks an exact identifier at 1.0, a prefix at 0.9 and trigram similarity below that, and returns at most p_limit of each kind, where p_limit is clamped to 0..25 and defaults to 8. Every kind returns `meta` as rendered text. LIKE metacharacters in the query are literal text. A query under two characters, and any account that is not active, get nothing.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- Both helpers must be callable by `authenticated`: app_search runs with the
-- caller's privileges and could not otherwise call them. That is why each one
-- gates its own output rather than trusting the wrapper to do it. anon gets
-- nothing from any of the three; RLS and those gates are what limit an
-- authenticated caller.
-- ---------------------------------------------------------------------------

revoke execute on function public.app_search_candidates(text) from public, anon;
grant execute on function public.app_search_candidates(text) to authenticated;

revoke execute on function public.app_search_inventory_rows(uuid[]) from public, anon;
grant execute on function public.app_search_inventory_rows(uuid[]) to authenticated;

revoke execute on function public.app_search(text, integer) from public, anon;
grant execute on function public.app_search(text, integer) to authenticated;
