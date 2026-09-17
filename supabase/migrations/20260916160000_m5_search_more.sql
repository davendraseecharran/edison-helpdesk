-- M5 global lookup, widened: groups, group events, and a student by the phone
-- number on file for their guardian.
--
-- Restates app_search_candidates and app_search from
-- 20260914100500_m5_search.sql in full. Every ruling in that file still holds
-- and is not repeated here; what this file changes is listed, and everything
-- else in both bodies is carried over unaltered.
--
--   * Two new kinds, `group` and `event`. A roster is looked for by name the
--     way a person is — a trigram arm for what somebody heard, and a
--     case-insensitive prefix arm for what they started typing — and an event
--     the same way. Both are gated in the candidates half by the one
--     active-account test already spent in `escaped`, and joined back in the
--     hits half through public.people_groups and public.group_events, whose
--     own select policies are that same test. An inactive account gets no id
--     from the first half and no row from the second.
--
--   * A guardian's phone number finds the student. The number a parent gives
--     at the desk is the number in the spreadsheet with different punctuation,
--     so both sides are reduced to their digits before they are compared; an
--     exact run of digits ranks 1.0 and a prefix 0.9, the same as an OSIS. The
--     arm runs only when the query carries at least seven digits, which is the
--     shortest thing anybody dials, so a name or a ticket number never reaches
--     it. Nothing is normalised beyond stripping punctuation: a number pasted
--     with a country code matches a stored number only if that was stored with
--     one too.
--
--   * The email arm is unchanged and still there. It is named here because it
--     is easy to lose in a restatement, and losing it would be a regression a
--     test now catches.
--
-- The return types of both functions are what they were, so `create or
-- replace` is enough and no caller has to change.

-- ---------------------------------------------------------------------------
-- Indexes
--
-- One per new trigram arm, mirroring the directory's name indexes. Both tables
-- are small today and will stay in the tens or hundreds of rows, but an arm
-- the planner has to scan makes its whole branch a scan, and the point of the
-- candidates half is that every arm is served from an index. `if not exists`,
-- because both tables were created with it and a later migration may grow one
-- of the same name.
-- ---------------------------------------------------------------------------

create index if not exists people_groups_name_trgm
  on public.people_groups using gin (name extensions.gin_trgm_ops);

create index if not exists group_events_name_trgm
  on public.group_events using gin (name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- app_search_candidates: ids only, no RLS, every arm indexable
-- ---------------------------------------------------------------------------

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
    -- five tables: a query under two characters is not a search, and an
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
      end as digits,
      -- The query as a phone number: its digits and nothing else, kept only
      -- when there are at least seven of them. '(212) 555-0134', '212.555.0134'
      -- and '2125550134' all become the same string; a name, a ticket number
      -- and an asset tag become NULL and never reach the phone arm. Digits need
      -- no LIKE escaping.
      case
        when pg_catalog.length(pg_catalog.regexp_replace(e.raw, '\D', '', 'g')) >= 7
        then pg_catalog.regexp_replace(e.raw, '\D', '', 'g')
      end as phone_digits
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
      union
      -- A guardian's number is how a student is found when the parent is the
      -- one on the phone. Only students carry one, and the comparison is
      -- digits against digits so the punctuation in the spreadsheet does not
      -- have to be the punctuation somebody typed. This arm scans inside the
      -- helper, like the identifier arms: there is no index that can serve an
      -- expression over a stripped column, and the directory is not large
      -- enough for that to be the thing to fix first.
      select r.id from public.requesters r cross join term t
      where r.kind = 'student'
        and t.phone_digits is not null
        and pg_catalog.regexp_replace(coalesce(r.guardian_phone, ''), '\D', '', 'g')
              like t.phone_digits || '%'
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
  ),

  -- The rosters. A group is a name somebody chose, so it is found the way a
  -- person's name is: by similarity for what was heard, and by prefix for what
  -- was started. The prefix arm is ILIKE rather than upper() LIKE because the
  -- trigram index serves ILIKE directly and there is no other index to prefer.
  group_ids as (
    select u.id from (
      select g.id from public.people_groups g cross join term t
      where g.name operator(extensions.%) t.raw
      union
      select g.id from public.people_groups g cross join term t
      where g.name ilike t.pattern || '%' escape '\'
    ) u
    order by u.id
    limit 200
  ),

  -- What a roster did on a day, found by the same two arms over its name. The
  -- group's name is not searched here: "Officers" should find the group, and
  -- the group's page lists its events.
  event_ids as (
    select u.id from (
      select ev.id from public.group_events ev cross join term t
      where ev.name operator(extensions.%) t.raw
      union
      select ev.id from public.group_events ev cross join term t
      where ev.name ilike t.pattern || '%' escape '\'
    ) u
    order by u.id
    limit 200
  )

  -- The ticket candidates are cut down to what this caller may read before they
  -- leave the function, over at most 200 ids rather than over the table. The
  -- other four need no per-row test: their gate is the active-account one
  -- already spent in `escaped`, which is the whole of each table's select
  -- policy.
  select 'ticket'::text, i.id from ticket_ids i where public.app_can_view_ticket(i.id)
  union all
  select 'person'::text, i.id from person_ids i
  union all
  select 'device'::text, i.id from device_ids i
  union all
  select 'group'::text, i.id from group_ids i
  union all
  select 'event'::text, i.id from event_ids i;
$$;

comment on function public.app_search_candidates(text) is
  'Trusted id-only half of app_search. SECURITY DEFINER so the trigram and LIKE predicates can be index conditions, which a row-level policy otherwise forbids because neither operator is leakproof. Returns (kind, id) and no row data, at most 200 of each kind, already filtered to what the caller may read: the active-account gate for requesters, inventory, groups and events, app_can_view_ticket for tickets. The two ticket-number arms run only when the query carries digits, so a bare ''EDT'' — a prefix every ticket number shares — matches no number. The guardian-phone arm runs only when the query carries at least seven digits.';

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
      case
        when pg_catalog.length(pg_catalog.regexp_replace(e.raw, '\D', '', 'g')) >= 7
        then pg_catalog.regexp_replace(e.raw, '\D', '', 'g')
      end as phone_digits
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
      -- An identifier that is the whole query, the email address included,
      -- ranks 1.0; one the query starts ranks 0.9; a name ranks by how close it
      -- is. The guardian's number is an identifier for this purpose: the parent
      -- on the phone has named exactly one student.
      case
        when pg_catalog.upper(r.source_external_id) = t.folded
          or pg_catalog.upper(r.external_id) = t.folded
          or pg_catalog.lower(r.email) = pg_catalog.lower(t.raw)
          or (
            t.phone_digits is not null
            and pg_catalog.regexp_replace(coalesce(r.guardian_phone, ''), '\D', '', 'g')
                  = t.phone_digits
          )
          then 1.0::real
        when pg_catalog.upper(r.source_external_id) like t.folded_pattern || '%' escape '\'
          or pg_catalog.upper(r.external_id) like t.folded_pattern || '%' escape '\'
          or r.email ilike t.pattern || '%' escape '\'
          or (
            t.phone_digits is not null
            and pg_catalog.regexp_replace(coalesce(r.guardian_phone, ''), '\D', '', 'g')
                  like t.phone_digits || '%'
          )
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

  -- --- Groups --------------------------------------------------------------
  -- people_groups_select_active is applied by the join, and the member count
  -- is read through people_group_members_select_active: the same gate twice,
  -- so an account the first refuses is never asked the second.
  group_hits as (
    select
      'group'::text as kind,
      g.id,
      g.name as title,
      -- The sentence somebody wrote about the group, or nothing: a subtitle
      -- that repeats the name would be one more line to read past.
      nullif(pg_catalog.btrim(g.description), '') as subtitle,
      -- How big the roster is, as the words the list page uses. There is no
      -- identifier to show on the right of a group; its size is what tells two
      -- similarly named groups apart.
      (
        select
          pg_catalog.count(*) || case when pg_catalog.count(*) = 1 then ' member' else ' members' end
        from public.people_group_members m
        where m.group_id = g.id
      ) as meta,
      -- The name as written ranks 1.0, a name the query starts 0.9, and
      -- anything else by how close it is: the same ladder an identifier climbs,
      -- because a group's name is the only handle it has.
      case
        when pg_catalog.lower(g.name) = pg_catalog.lower(t.raw) then 1.0::real
        when g.name ilike t.pattern || '%' escape '\' then 0.9::real
        else extensions.similarity(g.name, t.raw)
      end as rank
    from candidate c
    join public.people_groups g on g.id = c.id
    cross join term t
    where c.kind = 'group'
  ),

  -- --- Events --------------------------------------------------------------
  -- group_events_select_active is applied by the join to the event, and the
  -- group's name comes through people_groups_select_active. The join to the
  -- group is inner: an event cannot outlive its group (the foreign key
  -- cascades), so there is no row this would drop.
  event_hits as (
    select
      'event'::text as kind,
      ev.id,
      ev.name as title,
      -- Whose event it is. Two groups can each hold a "Weekly meeting", and
      -- the group is what tells them apart.
      g.name as subtitle,
      -- The day, as a person says it: "Sep 16", "Mar 5". FM drops the leading
      -- zero to_char would otherwise pad the day with.
      pg_catalog.to_char(ev.held_on, 'Mon FMDD') as meta,
      case
        when pg_catalog.lower(ev.name) = pg_catalog.lower(t.raw) then 1.0::real
        when ev.name ilike t.pattern || '%' escape '\' then 0.9::real
        else extensions.similarity(ev.name, t.raw)
      end as rank
    from candidate c
    join public.group_events ev on ev.id = c.id
    join public.people_groups g on g.id = ev.group_id
    cross join term t
    where c.kind = 'event'
  ),

  -- --- One page per kind ---------------------------------------------------
  -- Five separately limited subqueries rather than one limited union: a lookup
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
    union all
    (
      select * from group_hits gh
      order by gh.rank desc, gh.title, gh.id
      limit greatest(0, least(coalesce(p_limit, 8), 25))
    )
    union all
    (
      select * from event_hits eh
      order by eh.rank desc, eh.title, eh.id
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
  'SECURITY INVOKER global lookup over tickets, the district directory, the inventory, the rosters and their events. Candidate ids come from app_search_candidates(), which is SECURITY DEFINER so the trigram and LIKE predicates can use an index; tickets, requesters, groups and events are then fetched through their own policies, and machines through app_search_inventory_rows(), because inventory_devices has no policy to fetch them through. Ranks an exact identifier — an OSIS, a staff id, an email address, a guardian''s phone number by its digits, a group or event name — at 1.0, a prefix at 0.9 and trigram similarity below that, and returns at most p_limit of each kind, where p_limit is clamped to 0..25 and defaults to 8. Every kind returns `meta` as rendered text: a group''s member count, an event''s day. LIKE metacharacters in the query are literal text. A query under two characters, and any account that is not active, get nothing.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- Restated with the bodies, so a reader of this file sees the whole contract.
-- `create or replace` keeps the privileges a function already has; these lines
-- are what makes that true rather than something to check.
-- ---------------------------------------------------------------------------

revoke execute on function public.app_search_candidates(text) from public, anon;
grant execute on function public.app_search_candidates(text) to authenticated;

revoke execute on function public.app_search(text, integer) from public, anon;
grant execute on function public.app_search(text, integer) to authenticated;
