-- M5 global lookup: review fixes to app_search.
--
-- 20260912100500_m5_search.sql is already applied, so app_search is recreated
-- here with its full body and its grant restated; that file is left alone except
-- for comments pointing at this one. The security design is unchanged and is
-- still the whole point: SECURITY INVOKER, so tickets_select_visible,
-- people_select_active and devices_select_active decide every row.
--
-- Three things were wrong.
--
-- 1. NO INDEX COULD BE USED. Each kind was one OR group over a table, and an OR
--    whose branches span different columns — and, for tickets, a joined table —
--    cannot be served by any single index, so the planner scanned people,
--    devices and tickets on every keystroke. The trigram indexes that
--    20260912100200 and 20260912100300 created "for Task 11's app_search" were
--    dead weight, and so was the one 100500 added on tickets.title.
--
--    Each kind is now a UNION of one subquery per predicate, deduplicated by id,
--    and the row is fetched once by id afterwards. Every branch is a single
--    predicate over one column of one table, which is what a planner can serve
--    from an index. The requester-name branch is its own arm over
--    public.requesters rather than a join qual buried inside an OR, so it can be
--    driven from an index too.
--
-- 2. THE TWO CONCATENATED-EXPRESSION INDEXES WERE UNUSED, and are DROPPED here
--    rather than adopted. people_search_trgm and devices_search_trgm are written
--    over a concatenation of the identifier columns, reachable only from a
--    predicate spelled the same way, and 20260912100200 set the terms plainly:
--    "If Task 11 does not write it that way, this index serves nothing and
--    should be dropped there."
--
--    Writing it that way was measured first, against 70,001 people on this
--    schema, and the predicate those indexes exist for does not work:
--
--      -- the case they were created for: find somebody from the MIDDLE of an
--      -- identifier rather than only from its start
--      where (coalesce(email,'') || ' ' || coalesce(osis,'') || ' ' ||
--             coalesce(staff_id,'')) % '800004211'      -->  0 rows
--
--      -- and when it does fire, on a whole identifier typed with one digit wrong
--      ... % '94fc31bfff@edison.example 800004212'      -->  11,369 rows of 70,001
--
--    similarity() divides shared trigrams by the union of both strings, so a
--    short query against a long concatenation scores far below the 0.3 threshold
--    (the first result), while two long concatenations that share their shape —
--    every address ends `@edison.example`, every asset tag starts `DOE-` — score
--    above it whatever the identifiers are (the second). The arm is therefore
--    both too weak for the case it was built for and too broad when it fires: a
--    sixth of the directory is not a search result.
--
--    The capability those index comments describe needs word_similarity
--    (`<%`), which scores the query against the best-matching WINDOW of the
--    string rather than against the whole of it, and which the same expression
--    index serves: `'800004211' <% (…)` answers in 1 ms with 114 rows. It is not
--    adopted blind here, because the same probe over devices returned half the
--    inventory once every asset tag shared a prefix, and choosing a threshold for
--    that belongs with a real 7,500-machine inventory rather than with synthetic
--    fixtures. Dropping the two indexes now is the honest state: nothing uses
--    them, nothing is left claiming they are used, and the note above says
--    exactly what to build if the middle-of-an-identifier search is wanted.
--
-- 3. `meta` MIXED A RAW COLUMN VALUE WITH RENDERED TEXT. A ticket returned
--    `in_progress` while a device returned `Deployed — Wren Calloway`, so the one
--    field meant two different things and the lookup bar would have had to know
--    which. Every kind now returns text a person can read: the ticket status
--    labels mirror TICKET_STATUS_LABELS in src/lib/domain/types.ts, the device
--    ones are the same statuses in sentence case, and a person still returns
--    their OSIS or staff id, which is already the text it renders as.
--
-- Smaller: the 25-row ceiling on p_limit is now stated in the function comment
-- rather than only in the code, and `staff_id` is folded with upper() on both
-- sides of both comparisons, as the device identifiers already were.
--
-- CORRECTED by 20260912100520_m5_search_indexes.sql. This paragraph said that
-- `%DOE-SR12347%` would still find DOE-SR12347 through a trigram arm, and that
-- was written while the concatenated devices_search_trgm arm still existed. That
-- arm is dropped above, and no trigram arm covers a device IDENTIFIER any more:
-- the only device trigram arm is over `model`. So a metacharacter-laden query
-- for an asset tag matches nothing at all, and the test asserts exactly that.
-- The escaping rule itself is unchanged and is about LIKE: `%` and `_` are
-- literal text, and a query made only of metacharacters matches no row rather
-- than every row of three tables.

-- ---------------------------------------------------------------------------
-- Indexes
--
-- One per trigram arm that had none. Without these the restructuring above is
-- pointless: an arm the planner has to scan makes the whole branch a scan, and
-- the indexed arms beside it save nothing.
-- ---------------------------------------------------------------------------

-- The requester-name arm. Small table (one row per named requester), but the arm
-- is a nested loop driven from `term`, so an index turns it from a scan per
-- keystroke into a lookup.
create index requesters_display_name_trgm
  on public.requesters using gin (display_name extensions.gin_trgm_ops);

-- The ticket-issue arm. 100500 argued this one was not worth its size and that
-- "the fix is an index here, not a change to the function" if that stopped being
-- true. It stopped being true the moment the branch became indexable everywhere
-- else: leaving `issue` unindexed would have seq-scanned tickets on every
-- keystroke regardless of what the other arms did.
create index tickets_issue_trgm
  on public.tickets using gin (issue extensions.gin_trgm_ops);

-- The device-model arm. Nothing else covers it: a model is not an identifier, so
-- none of the prefix arms sees it.
create index devices_model_trgm
  on public.devices using gin (model extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Indexes dropped
--
-- See point 2 of the header for the measurement. Neither index has another
-- caller: app_list_people and app_list_devices cannot reach either expression
-- and say so, and grep finds no other predicate written over them.
-- ---------------------------------------------------------------------------

drop index if exists public.people_search_trgm;
drop index if exists public.devices_search_trgm;

-- Deliberately NOT added: `text_pattern_ops` duplicates of devices_device_id_idx,
-- devices_serial_idx and devices_asset_tag_idx. The identifier arms are prefix
-- LIKE over `upper(column)`, and a btree in the database's default collation
-- cannot serve a LIKE prefix — only a text_pattern_ops (or C-collation) index
-- can. Those three arms therefore still scan public.devices. Naming the fix
-- without making it is deliberate: it is three more indexes on the largest table
-- in the schema, and it belongs with the first measurement of the lookup against
-- a real 7,500-row inventory rather than with this review.

-- ---------------------------------------------------------------------------
-- app_search
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
    -- The whole lookup hangs off this one row. An empty or one-character query
    -- produces no row here, so every arm below is empty and the function returns
    -- nothing without touching a table.
    where pg_catalog.length(q.raw) >= 2
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

  -- --- Tickets -------------------------------------------------------------
  -- One arm per predicate, UNION (not UNION ALL) so a ticket matched by two of
  -- them is still one hit. Nothing here selects a column other than the id: the
  -- row is fetched once, below, after the candidate set is known.
  ticket_ids as (
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
    -- The requester name, reached from requesters rather than through a join
    -- qual inside an OR, so requesters_display_name_trgm can drive it.
    select tk.id
    from public.requesters r
    join public.tickets tk on tk.requester_id = r.id
    cross join term t
    where r.display_name operator(extensions.%) t.raw
  ),
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
    from ticket_ids i
    join public.tickets tk on tk.id = i.id
    -- LEFT: a ticket whose requester is unknown still has to be findable.
    left join public.requesters r on r.id = tk.requester_id
    cross join term t
  ),

  -- --- People --------------------------------------------------------------
  -- Archived people are out of every arm, matching what the directory listing
  -- shows by default: somebody who has left the school is not who an operator
  -- means when they type a name into the lookup bar. Their record is still
  -- reachable from the tickets and devices that name them.
  person_ids as (
    -- Trigram against the bare column, so people_display_name_trgm serves it.
    select p.id from public.people p cross join term t
    where p.active and p.display_name operator(extensions.%) t.raw
    union
    -- An identifier is matched from its start, the way it is read off a card.
    -- `osis` is digits only, so a case-sensitive LIKE is already exact.
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
    from person_ids i
    join public.people p on p.id = i.id
    cross join term t
  ),

  -- --- Devices -------------------------------------------------------------
  device_ids as (
    -- Identifiers match from their start, folded on both sides so the rule is
    -- about machines rather than about typing. These three arms scan; see the
    -- note beside the indexes above for why, and for what would fix it.
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
  ),
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
    from device_ids i
    join public.devices d on d.id = i.id
    -- LEFT: an unassigned device is still findable, and the join can only ever
    -- add a name the caller is already allowed to read.
    left join held x on x.device_id = d.id
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
  'SECURITY INVOKER global lookup over tickets, people and devices: RLS decides the rows, so it can only return what the caller could already read. Each kind is a union of separately indexable predicates. Ranks an exact identifier at 1.0, a prefix at 0.9 and trigram similarity below that, and returns at most p_limit of each kind, where p_limit is clamped to 0..25 and defaults to 8. Every kind returns `meta` as rendered text: a ticket status label, a device status label with its current holder, a person''s OSIS or staff id. LIKE metacharacters in the query are literal text. A query under two characters, and any account that is not active, get nothing.';

-- ---------------------------------------------------------------------------
-- Grants restated. `create or replace` keeps the existing ACL, so these change
-- nothing today; they are here so this file says in full who may call it.
-- ---------------------------------------------------------------------------

revoke execute on function public.app_search(text, integer) from public, anon;
grant execute on function public.app_search(text, integer) to authenticated;
