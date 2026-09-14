-- M5 global lookup, review round 3: bound the ticket-number arms and cap the
-- candidate set.
--
-- 20260912100520 is already applied, so app_search_candidates() is recreated
-- here with its full body and its grant restated. app_search itself is
-- unchanged, and so is the design round 2 settled: ids are found without RLS in
-- this SECURITY DEFINER helper so the trigram predicates can be index
-- conditions, and the rows are fetched back through the RLS-governed tables in
-- app_search, which remains the authority over what is returned.
--
-- Two things were still wrong, and they are the same thing seen twice: nothing
-- bounded how much work one keystroke could ask for.
--
-- 1. THE TICKET-NUMBER ARMS MATCHED EVERY TICKET. Every ticket number is
--    'EDT-' || nextval, so `number ilike 'ED%'` is true of all of them. Typing
--    the first letters of the prefix — 'ed', 'edt', 'EDT-' — put the WHOLE
--    ticket table into the candidate set, and app_can_view_ticket() then ran
--    once per row of it. At the calibration from round 2 (a four-join SECURITY
--    DEFINER predicate, ~0.25 ms a call, 76,004 rows) that is about 19 s for a
--    technician, and worse for an administrator, whose candidates all survive
--    the predicate and are handed to the outer join to be fetched and ranked.
--
--    Both arms now require the query to carry a ticket NUMBER, not a fragment of
--    the prefix every number shares. `digits` is the query with a leading
--    `edt-`/`edt`/`ed`/`e` removed, kept only when what remains is all digits,
--    so:
--
--      'EDT-1042' -> 1042     'edt-10' -> 10      '1042' -> 1042
--      'EDT'      -> NULL     'ED'     -> NULL    'EDT-' -> NULL
--
--    A bare 'EDT' therefore produces no ticket-number candidates at all. It is
--    not a dead query: the title, issue and requester arms still run, so typing
--    'EDT' still finds a ticket whose title happens to say EDT.
--
-- 2. NOTHING CAPPED THE CANDIDATE SET. Each kind is now `limit 200`, ordered by
--    id. Two reasons, and the second is the one that matters:
--
--      * app_can_view_ticket() gets a hard upper bound — 200 calls, not one per
--        row of the table, whatever a future arm turns out to match.
--      * the helper is callable directly (it must be: app_search is SECURITY
--        INVOKER and could not otherwise call it), so without a cap a signed-in
--        caller could ask for a broad term and enumerate the id of every person
--        and device in the school in one call. Those ids are already visible to
--        an active account through app_list_people and app_list_devices, which
--        page at 100, so this is a bound on bulk collection rather than a new
--        secret — but a lookup bar has no business handing out 7,500 ids at
--        once, and a cap is cheaper than explaining why it does not matter.
--
--    Ordered by id, not by rank: ranking needs the row and this half deliberately
--    reads no row data. So when a kind matches more than 200 records, app_search
--    ranks within those 200 and the rest are invisible to it. That is a real
--    behaviour change, and the honest description of it is that a query matching
--    more than 200 people is not a lookup — the answer a technician wants is
--    never in the tail of a list that long. The cap is far above anything a
--    two-character-minimum identifier or name search produces in a school of
--    2,800 people and 7,500 machines.

create or replace function public.app_search_candidates(p_query text)
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
      -- This is the SAME three replaces app_search does (20260912100520, the
      -- `escaped` CTE there), and the duplication is deliberate rather than
      -- missed. A shared SQL function would be a third object to grant, revoke
      -- and keep in step, and — because it would sit inside the predicate of
      -- every arm below — one the planner has to inline for the trigram and
      -- text_pattern_ops indexes to stay usable at all. Two copies of five
      -- lines are cheaper than that, and neither copy is reachable from a
      -- session except through the two functions that hold it. If either is
      -- ever changed, change both: they have to produce the same pattern or
      -- app_search would rank rows its own predicates would not have matched.
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
      -- The ticket number the operator typed, if they typed one: the query with
      -- a leading fragment of the shared 'EDT-' prefix removed, kept only when
      -- what is left is all digits. NULL for 'EDT', for 'ED', and for every
      -- query that is not about a ticket number, which is what keeps the two
      -- number arms below from matching the whole table. The alternation is
      -- longest-first so 'EDT-1042' loses 'EDT-' rather than just 'E'.
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
  -- Measured: 38.8 s and 3.2M buffer hits for a query with no ticket candidates
  -- at all, because the two unindexed `number ilike` arms scanned 76,004 tickets
  -- each and called a four-join SECURITY DEFINER function on every one of them.
  -- With the fence the same call is 0.13 s.
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
      -- requesters_display_name_trgm finds the requester and tickets_requester_idx
      -- finds their tickets.
      select tk.id
      from public.requesters r
      join public.tickets tk on tk.requester_id = r.id
      cross join term t
      where r.display_name operator(extensions.%) t.raw
    ) u
    -- By id, because ranking needs the row and this half reads none. See the
    -- header: app_search ranks within at most this many per kind.
    order by u.id
    limit 200
  ),
  person_ids as (
    select u.id from (
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
    ) u
    order by u.id
    limit 200
  ),
  device_ids as (
    select u.id from (
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
    ) u
    order by u.id
    limit 200
  )

  -- The ticket candidates are cut down to what this caller may read before they
  -- leave the function, over at most 200 ids rather than over the table. People
  -- and devices need no per-row test: their policies are the active-account gate
  -- already spent in `escaped`.
  select 'ticket'::text, i.id from ticket_ids i where public.app_can_view_ticket(i.id)
  union all
  select 'person'::text, i.id from person_ids i
  union all
  select 'device'::text, i.id from device_ids i;
$$;

comment on function public.app_search_candidates(text) is
  'Trusted id-only half of app_search. SECURITY DEFINER so the trigram and LIKE predicates can be index conditions, which a row-level policy otherwise forbids because neither operator is leakproof. Returns (kind, id) and no row data, at most 200 of each kind, already filtered to what the caller may read: the active-account gate for people and devices, app_can_view_ticket for tickets. The two ticket-number arms run only when the query carries digits, so a bare ''EDT'' — a prefix every ticket number shares — matches no number. app_search joins these ids back through the RLS-governed tables, which remain the authority over what is returned.';

-- ---------------------------------------------------------------------------
-- Grant restated. `create or replace` keeps the existing ACL, so this changes
-- nothing today; it is here so this file says in full who may call it. The
-- helper must be callable by `authenticated`, because app_search runs with the
-- caller's privileges and could not otherwise call it — which is why it filters
-- its own output rather than trusting the wrapper to do it. anon gets nothing.
-- ---------------------------------------------------------------------------

revoke execute on function public.app_search_candidates(text) from public, anon;
grant execute on function public.app_search_candidates(text) to authenticated;
