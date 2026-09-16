-- ---------------------------------------------------------------------------
-- The desk's sheet, and a batch lookup for the people on it.
--
-- Two functions, both of them about the same thing: the work the school did
-- before it had a helpdesk, and the students and staff it did that work for.
--
-- 1. app_import_resolved_ticket
--
-- For a year the desk kept a spreadsheet. One row per call: the date it came
-- in, who rang and from where, what was wrong, who fixed it, the day it was
-- closed. That sheet is the only record of that year, and the rows belong in
-- `public.tickets` with everything since — searchable, countable, attached to
-- the people they were about, and counted in the numbers the Today screen
-- shows.
--
-- The whole difficulty is that these tickets are ALREADY FINISHED, and every
-- ordinary path refuses that shape. app_create_ticket opens a ticket today and
-- refuses a backdated one from anybody but an administrator; app_claim_ticket
-- and app_resolve_ticket stamp now(); `tickets_guard` makes created_at
-- immutable the moment the row exists, so no sequence of ordinary calls can
-- ever land a ticket whose history is last October. One function that writes
-- the finished row in a single insert is the only honest way to do it, and
-- that is what this is.
--
-- What it is NOT is a second door into intake. It writes one shape and one
-- only — resolved, owned by whoever fixed it, dated when it happened — and it
-- refuses everything else:
--
--   * Only an admin or a NetRider may call it at all. A skills officer works
--     the directory, and the ticket trigger `tickets_require_worker` would
--     refuse the insert underneath anyway; being told plainly is better than
--     being told by a trigger.
--   * p_resolved_by other than the caller is ADMINISTRATOR ONLY. "Dev fixed
--     this one" is a claim about somebody else's work, and it is the one thing
--     in here that could quietly rewrite the record of who did what. A
--     NetRider importing the sheet imports their own rows.
--   * Whoever is named must be an active account that works tickets, because
--     owner_id and resolved_by are real accounts and the queue is theirs.
--   * The dates have to be a history: called before resolved, resolved no
--     later than now, and nothing older than three years. A sheet that goes
--     back further is a different conversation, and a typo'd year is the most
--     likely thing on a hand-kept sheet.
--   * The category is held to `app_category_labels()`, exactly as
--     app_create_ticket holds it, and defaults to 'other' the same way. A
--     category the database does not know is a caller that is wrong, and
--     filing the ticket anyway puts it where nobody is looking for it.
--
-- Two details worth saying out loud:
--
--   * channel is 'phone_call'. The sheet is a record of calls; walk_in would
--     be an invention and the column takes one of three words.
--   * `solution` is NOT NULL for a resolved ticket (tickets_resolved_complete
--     wants five characters of it), and the sheet does not carry one — it says
--     who fixed it, never how. So the row gets a sentence that says exactly
--     that, naming the resolver and the date, rather than a guess or a blank
--     nobody can tell from a real solution.
--
-- The history is written by hand rather than through app_log_event, which
-- takes no timestamp and would stamp all three events with now() — a ticket
-- whose events all happened this afternoon is not the record the sheet holds.
-- Three rows go in with their historic `at`: created and claimed (or assigned)
-- when the call came in, resolved when it was closed. Every summary says it
-- was imported, so nobody reading a ticket's history a year from now mistakes
-- a spreadsheet row for a ticket somebody worked here.
--
-- 2. app_find_people
--
-- A skills officer hands over a class list and wants all thirty at once. One
-- round trip per name is thirty round trips and thirty model turns; this takes
-- up to two hundred keys and answers them in one. Each key is answered
-- separately and in the order it arrived — matched, not found, or matched more
-- than once, which is a real answer and not a failure.
--
-- SECURITY DEFINER, for one concrete reason: `inventory_devices` is revoked
-- from `authenticated` entirely (the owner's 20260912220000 keeps the
-- inventory behind functions), so an invoker-rights version could not count a
-- person's machines at all. It is the same shape as app_list_people and
-- app_get_person, which is how every other directory read already works, and
-- it starts with app_require_actor() so an inactive or unlinked session gets
-- nothing.
--
-- Additive: two functions, no table touched, no grant widened.
-- ---------------------------------------------------------------------------

create function public.app_import_resolved_ticket(
  p_title text,
  p_issue text,
  p_called_at timestamptz,
  p_resolved_at timestamptz,
  p_resolved_by uuid default null,
  p_requester_id uuid default null,
  p_location text default null,
  p_category text default null,
  p_priority text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_admin boolean;
  v_resolver uuid;
  v_resolver_name text;
  v_title text := pg_catalog.btrim(coalesce(p_title, ''));
  v_issue text := pg_catalog.btrim(coalesce(p_issue, ''));
  v_category text := coalesce(nullif(pg_catalog.btrim(coalesce(p_category, '')), ''), 'other');
  v_priority text := coalesce(nullif(pg_catalog.btrim(coalesce(p_priority, '')), ''), 'normal');
  v_location text := nullif(pg_catalog.btrim(coalesce(p_location, '')), '');
  v_called_on date;
  v_resolved_on date;
  v_solution text;
  v_ticket_id uuid;
  -- Read once, from the request rather than from any argument: an import run
  -- from the assistant panel is the operator's AI acting for them, and the row
  -- says so in the same two columns every other AI-assisted write uses.
  v_via text := public.app_request_via();
  v_model text := public.app_request_ai_model();
begin
  v_actor := public.app_require_actor();
  v_admin := v_actor.roles && array['admin']::text[];

  if not (v_actor.roles && array['admin', 'netrider']::text[]) then
    raise exception 'Only a NetRider or an administrator can import resolved tickets.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Who fixed it. Left out, it is whoever is importing; named as somebody
  -- else, it is a statement about a colleague's work and only an administrator
  -- may make one.
  v_resolver := coalesce(p_resolved_by, v_actor.id);
  if v_resolver <> v_actor.id and not v_admin then
    raise exception 'Only an administrator can import a ticket somebody else resolved.'
      using errcode = 'insufficient_privilege';
  end if;

  select a.display_name into v_resolver_name
  from public.app_accounts a
  where a.id = v_resolver
    and a.status = 'active'
    and a.roles && array['admin', 'netrider']::text[];
  if not found then
    raise exception 'Name an active NetRider or administrator as the person who fixed it.'
      using errcode = 'check_violation';
  end if;

  if pg_catalog.length(v_title) < 3 then
    raise exception 'Give each imported ticket a title of at least three characters.'
      using errcode = 'check_violation';
  end if;
  -- The table's own tickets_title_length stops at 120, and app_create_ticket
  -- refuses the same length in the same words. A sheet column that is really a
  -- paragraph belongs in the issue.
  if pg_catalog.length(v_title) > 120 then
    raise exception 'Keep the title under 120 characters.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_issue) > 6000 then
    raise exception 'Keep notes under 6000 characters.' using errcode = 'check_violation';
  end if;
  -- A sheet that only ever held one sentence per call held it once. Repeating
  -- the title as the issue is honest; an empty issue reads as a lost record.
  if v_issue = '' then
    v_issue := v_title;
  end if;

  if p_called_at is null or p_resolved_at is null then
    raise exception 'Each row needs the date it came in and the date it was resolved.'
      using errcode = 'check_violation';
  end if;
  if p_called_at > p_resolved_at then
    raise exception 'A ticket cannot be resolved before it was called in.'
      using errcode = 'check_violation';
  end if;
  if p_resolved_at > pg_catalog.now() then
    raise exception 'A resolved date cannot be in the future.' using errcode = 'check_violation';
  end if;
  if p_called_at < pg_catalog.now() - interval '3 years' then
    raise exception 'The desk''s sheet only goes back three years.' using errcode = 'check_violation';
  end if;

  if not (public.app_category_labels() ? v_category) then
    raise exception 'Choose a category for this ticket.' using errcode = 'check_violation';
  end if;
  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Choose low, normal, high or urgent.' using errcode = 'check_violation';
  end if;

  -- The directory is the district's, so a requester is somebody already in it
  -- or nobody at all. A sheet row naming somebody who has since left resolves
  -- to nobody, and the ticket says so rather than inventing a record.
  if p_requester_id is not null and not exists (
    select 1 from public.requesters r
    where r.id = p_requester_id and r.kind in ('staff', 'student')
  ) then
    raise exception 'Select an existing requester, or leave the requester unknown.'
      using errcode = 'check_violation';
  end if;

  v_called_on := (p_called_at at time zone 'America/New_York')::date;
  v_resolved_on := (p_resolved_at at time zone 'America/New_York')::date;

  -- The one field the sheet cannot fill. It says who, never how, and a
  -- sentence saying exactly that is better than a blank nobody can tell from a
  -- real solution.
  v_solution :=
    'Imported from the desk''s sheet: ' || v_resolver_name || ' resolved this on '
    || v_resolved_on::text || '. The sheet did not record how.';

  -- The same row sent twice is the same ticket. A sheet pasted again, or a
  -- batch resumed after one row stopped it, must not double the history:
  -- a resolved ticket with this title, these two moments, this resolver
  -- and this requester is returned as the one already imported. All five,
  -- because two calls about the same fault on the same day from different
  -- rooms are two tickets.
  select t.id into v_ticket_id
  from public.tickets t
  where t.title = v_title
    and t.created_at = p_called_at
    and t.resolved_at = p_resolved_at
    and t.status = 'resolved'
    and t.resolved_by = v_resolver
    and t.requester_id is not distinct from p_requester_id
  limit 1;
  if v_ticket_id is not null then
    return v_ticket_id;
  end if;

  insert into public.tickets (
    title, issue, requester_id, requester_unknown, location, is_remote,
    channel, priority, status, submitted_on, created_at, created_by,
    owner_id, assigned_at, category, solution, resolved_by, resolved_at,
    resolved_via, resolved_ai_model
  )
  values (
    v_title,
    v_issue,
    p_requester_id,
    p_requester_id is null,
    v_location,
    false,
    'phone_call',
    v_priority,
    'resolved',
    v_called_on,
    p_called_at,
    v_actor.id,
    v_resolver,
    p_called_at,
    v_category,
    v_solution,
    v_resolver,
    p_resolved_at,
    v_via,
    v_model
  )
  returning id into v_ticket_id;

  -- The three events the ordinary path would have left, at the times they
  -- actually happened. app_log_event takes no timestamp — it is written for
  -- work happening now — so these go in directly, with the same columns and
  -- the same attribution pair it would have stamped.
  insert into public.activity_events (
    ticket_id, kind, actor_id, at, summary, detail, performed_via, ai_model
  )
  values
    (
      v_ticket_id, 'created', v_actor.id, p_called_at,
      'Imported from the desk''s sheet by ' || v_actor.display_name,
      'Called in on ' || v_called_on::text || '.',
      v_via, v_model
    ),
    (
      v_ticket_id,
      case when v_resolver = v_actor.id then 'claimed' else 'assigned' end,
      v_actor.id,
      p_called_at,
      case when v_resolver = v_actor.id
        then 'Imported from the desk''s sheet: ' || v_resolver_name || ' took it on'
        else 'Imported from the desk''s sheet: ' || v_actor.display_name
             || ' recorded ' || v_resolver_name || ' as the technician'
      end,
      null,
      v_via, v_model
    ),
    (
      v_ticket_id, 'resolved', v_resolver, p_resolved_at,
      'Imported from the desk''s sheet: ' || v_resolver_name || ' resolved it',
      v_solution,
      v_via, v_model
    );

  return v_ticket_id;
end;
$$;

comment on function public.app_import_resolved_ticket(text, text, timestamptz, timestamptz, uuid, uuid, text, text, text) is
  'Writes one already-finished ticket from the desk''s old spreadsheet: resolved, owned by whoever fixed it, created and closed at the historic times, with the three activity events the ordinary path would have left. Admin or NetRider only; naming a resolver other than the caller is administrator-only. Refuses dates out of order, in the future, or more than three years old, and holds the category to app_category_labels(). Channel is always phone_call; the solution says the sheet did not record how.';

revoke execute on function
  public.app_import_resolved_ticket(text, text, timestamptz, timestamptz, uuid, uuid, text, text, text)
from public, anon;

grant execute on function
  public.app_import_resolved_ticket(text, text, timestamptz, timestamptz, uuid, uuid, text, text, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- app_find_people: many keys, one round trip.
-- ---------------------------------------------------------------------------

create function public.app_find_people(p_keys text[])
returns table (
  key text,
  found text,
  matches integer,
  id uuid,
  display_name text,
  kind text,
  group_label text,
  device_count integer,
  open_ticket_count integer
)
language plpgsql
-- Volatile, like app_list_people and every other directory read: they all begin
-- by asking app_require_actor(), which takes an advisory lock to serialise
-- against a deactivation, and that is not a stable function's business.
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();

  if p_keys is null or pg_catalog.array_length(p_keys, 1) is null then
    raise exception 'Give at least one name, OSIS, staff id or email.'
      using errcode = 'check_violation';
  end if;
  if pg_catalog.array_length(p_keys, 1) > 200 then
    raise exception 'Look up at most 200 people at once.' using errcode = 'check_violation';
  end if;

  return query
  with keys as (
    select k.ordinality as at, pg_catalog.btrim(coalesce(k.value, '')) as key
    from pg_catalog.unnest(p_keys) with ordinality as k(value, ordinality)
  ),
  -- An identifier is exact and a name is not, so they are ranked rather than
  -- unioned: somebody whose OSIS is typed gets that person even if another
  -- record happens to be called the same thing.
  --
  -- "Exact" means the whole value rather than a prefix or a substring; case is
  -- folded throughout. An OSIS is digits, and a staff id is the local part of a
  -- school address that somebody may well have typed in capitals — refusing
  -- that would be this function being pedantic about a key it understood.
  hits as (
    select
      ks.at,
      r.id,
      case
        when pg_catalog.lower(coalesce(r.external_id, '')) = pg_catalog.lower(ks.key) then 1
        when r.email is not null and pg_catalog.lower(r.email) = pg_catalog.lower(ks.key) then 1
        else 2
      end as rank
    from keys ks
    join public.requesters r
      on ks.key <> ''
     and r.kind in ('staff', 'student')
     and (
       pg_catalog.lower(coalesce(r.external_id, '')) = pg_catalog.lower(ks.key)
       or (r.email is not null and pg_catalog.lower(r.email) = pg_catalog.lower(ks.key))
       or pg_catalog.lower(r.display_name) = pg_catalog.lower(ks.key)
     )
  ),
  best as (
    select h.at, pg_catalog.min(h.rank) as rank
    from hits h
    group by h.at
  ),
  chosen as (
    select h.at, pg_catalog.count(*)::integer as matches, (pg_catalog.array_agg(h.id))[1] as id
    from hits h
    join best b on b.at = h.at and b.rank = h.rank
    group by h.at
  )
  select
    ks.key,
    case
      when c.matches is null then 'none'
      when c.matches = 1 then 'match'
      else 'ambiguous'
    end as found,
    coalesce(c.matches, 0) as matches,
    -- Only a single match names a person. "Ambiguous" that quietly returned
    -- the first of three would be the worst of both answers.
    case when c.matches = 1 then r.id end as id,
    case when c.matches = 1 then r.display_name end as display_name,
    case when c.matches = 1 then r.kind end as kind,
    case when c.matches = 1
      then nullif(pg_catalog.btrim(coalesce(
        case when r.kind = 'student' then r.official_class else r.department end, '')), '')
    end as group_label,
    case when c.matches = 1 then (
      select pg_catalog.count(*)::integer
      from public.inventory_devices d
      where d.assigned_requester_id = r.id
    ) end as device_count,
    -- Ticket work is not a skills officer's to see, counts included: for a
    -- caller who works no tickets this is null, never a number.
    case when c.matches = 1 and public.app_can_work_tickets() then (
      select pg_catalog.count(*)::integer
      from public.tickets t
      where t.requester_id = r.id
        and t.status not in ('resolved', 'cancelled')
    ) end as open_ticket_count
  from keys ks
  left join chosen c on c.at = ks.at
  left join public.requesters r on r.id = c.id and c.matches = 1
  order by ks.at;
end;
$$;

comment on function public.app_find_people(text[]) is
  'Looks up as many as 200 people at once and answers every key in the order it arrived: matched, not found, or matched more than once. An exact OSIS, staff id or email wins over a case-insensitive full-name match. SECURITY DEFINER because the machine count reads inventory_devices, which no client role may select; app_require_actor() gates it to an active account, like every other directory read.';

revoke execute on function public.app_find_people(text[]) from public, anon;

grant execute on function public.app_find_people(text[]) to authenticated;
