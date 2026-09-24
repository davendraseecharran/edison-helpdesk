-- ---------------------------------------------------------------------------
-- Self check-in: a QR code on the door, and a phone in every pocket.
--
-- The register (`20260916130300_m5_group_events.sql`) is taken by somebody
-- holding a phone at the door, and the kiosk is a signed-in tablet on a table.
-- Both need an officer standing there. This is the third way in, for the
-- meeting where nobody is: a poster with a QR code, and each person checks
-- themselves in on their own phone.
--
-- ONE ROW PER EVENT. `event_checkins` exists once somebody turns self check-in
-- on for an event, and holds the public address (`/c/<slug>`), whether it is
-- taking check-ins, how a person proves who they are, and whether somebody who
-- is not on the roster may walk in. Turning it off closes it; the row and its
-- address stay, so a poster already on the wall starts working again when it
-- is turned back on.
--
-- WHO YOU ARE, per the event's setting:
--   osis    the OSIS (or staff id), and nothing else
--   name    first and last name, matched against the roster
--   either  the OSIS, or the name (the default: most people know their name,
--           and a name two people share is answered by asking for the OSIS)
--   both    the OSIS and the name, and they have to be the same person
-- A name is matched with case, spacing, punctuation and accents folded away
-- (`app_checkin_fold`): "José  O'Neil" is "jose oneil" whichever way it was
-- typed. It is compared with the directory's display name and with its first
-- and last name in either order, so a record kept as "Okonkwo, Nia" is found.
--
-- THE ROSTER FIRST. A name is looked for among the group's members before the
-- directory. With walk-ins allowed, somebody found in the directory but not in
-- the group is added to the group (noted "Walk-in") and marked present, which
-- keeps the rule every other path keeps: attendance is only ever taken against
-- the roster.
--
-- WHEN. A check-in is taken on the event's own day, school time. Before it the
-- link says when it opens; after it the link says it has ended. An officer's
-- switch closes it at any time.
--
-- WHAT THE PUBLIC LEARNS. The event's name, its group's name and its day —
-- what is printed on the poster anyway — and, on a successful check-in, the
-- first name of the person checked in. Never the roster, a count, an id or a
-- surname. Somebody who is in the directory but not on a roster that takes no
-- walk-ins gets exactly the answer somebody who is in neither gets, so the
-- link cannot be used to learn who is at the school.
--
-- ABUSE. The slug is the forms slug: 12 characters from a 31-letter alphabet,
-- drawn here. Misses are counted per caller and per link and past either
-- ceiling the link stops answering for fifteen minutes, exactly as a form's
-- identity step does; so are successful check-ins per caller, because one
-- phone checking in forty people is not self check-in. The caller key is the
-- forms one (`app_form_client_key`): a hash of what the application server
-- forwards, which for this page is the client address AND a random id the
-- page keeps in a cookie, so thirty students on the school's one public
-- address are thirty callers. A caller who drops the cookie only moves
-- between buckets; the per-link ceiling holds regardless.
--
-- NO DIRECT WRITES. Row-level security with SELECT policies for active
-- accounts on the settings, nothing on the throttle, nothing for `anon` on
-- either, and every change through a SECURITY DEFINER function.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.event_checkins (
  event_id uuid primary key references public.group_events (id) on delete cascade,
  -- Drawn by app_form_slug(), never typed.
  slug text not null unique check (slug ~ '^[a-z0-9]{12}$'),
  is_open boolean not null default true,
  identity text not null default 'either'
    check (identity in ('osis', 'name', 'either', 'both')),
  walk_ins boolean not null default false,
  created_by uuid references public.app_accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.event_checkins is
  'Self check-in for one event: the public /c/<slug> address, whether it is open, how a person identifies (osis, name, either, both) and whether walk-ins are added to the roster. Written only by app_set_event_checkin.';

/*
 * The throttle's memory, as for forms: 'miss' for a check-in that matched
 * nobody (or more than one person), 'hit' for one that checked somebody in.
 * Rows older than a day are pruned by the next attempt on the same event.
 */
create table if not exists public.event_checkin_attempts (
  event_id uuid not null references public.group_events (id) on delete cascade,
  client_key text not null,
  kind text not null check (kind in ('miss', 'hit')),
  at timestamptz not null default now()
);

comment on table public.event_checkin_attempts is
  'Recent self check-in attempts per event and per hashed caller, for the public throttle. Never readable by any client role.';

create index if not exists event_checkin_attempts_idx
  on public.event_checkin_attempts (event_id, kind, at);

-- ---------------------------------------------------------------------------
-- Internal helpers. Reachable by no client role.
-- ---------------------------------------------------------------------------

/*
 * A name with everything that is not the name taken out: lower case, accents
 * removed (NFD, then the combining marks dropped), apostrophes and full stops
 * removed outright ("O'Neil" is "oneil", "St. John" is "st john"), and every
 * other run of non-letters — hyphens, commas, spaces — one space.
 */
create or replace function public.app_checkin_fold(p_text text)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.btrim(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.normalize(coalesce(p_text, ''), 'NFD')),
          '[\u0300-\u036f]', '', 'g'
        ),
        '[''’`.]', '', 'g'
      ),
      '[^[:alnum:]]+', ' ', 'g'
    )
  );
$$;

comment on function public.app_checkin_fold(text) is
  'Folds a name for matching: lower case, accents and apostrophes removed, every other run of punctuation or space one space.';

/* An OSIS or staff id as it is compared: no spaces, lower case. */
create or replace function public.app_checkin_fold_id(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.lower(pg_catalog.regexp_replace(coalesce(p_text, ''), '\s', '', 'g'));
$$;

/*
 * Whether a directory record carries the name somebody typed.
 *
 * The typed first and last name, folded, against three spellings of the
 * record: its display name read either way round, and its own first and last
 * name. A first name on file as "Nia Amara" is also found by "Nia".
 */
create or replace function public.app_checkin_name_matches(
  p_person public.requesters,
  p_first text,
  p_last text
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_first <> '' and p_last <> '' and (
    public.app_checkin_fold(p_person.display_name) in (p_first || ' ' || p_last, p_last || ' ' || p_first)
    or (
      public.app_checkin_fold(p_person.last_name) = p_last
      and (
        public.app_checkin_fold(p_person.first_name) = p_first
        or pg_catalog.split_part(public.app_checkin_fold(p_person.first_name), ' ', 1) = p_first
      )
    )
  );
$$;

/*
 * The one person a check-in names, looked for on the roster first.
 *
 *   {state: 'incomplete'}                 the event's setting asks for more
 *   {state: 'none'}                       nobody
 *   {state: 'ambiguous'}                  more than one person
 *   {state: 'match', id, member}          one person; member says whether
 *                                         they are on the roster already
 *
 * With `identity = 'either'` and both halves given, both have to name the
 * same person: that is the page's answer to an ambiguous name, and it must
 * not become a way to check in somebody else by their OSIS.
 */
create or replace function public.app_checkin_match(
  p_group uuid,
  p_walk_ins boolean,
  p_identity text,
  p_osis text,
  p_first text,
  p_last text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_osis text := public.app_checkin_fold_id(p_osis);
  v_first text := public.app_checkin_fold(p_first);
  v_last text := public.app_checkin_fold(p_last);
  v_has_osis boolean;
  v_has_name boolean;
  v_use_osis boolean;
  v_use_name boolean;
  v_count integer;
  v_id uuid;
begin
  if pg_catalog.length(v_osis) > 40 or pg_catalog.length(v_first) > 80 or pg_catalog.length(v_last) > 80 then
    return pg_catalog.jsonb_build_object('state', 'none');
  end if;

  v_has_osis := v_osis <> '';
  v_has_name := v_first <> '' and v_last <> '';

  if p_identity = 'osis' then
    if not v_has_osis then
      return pg_catalog.jsonb_build_object('state', 'incomplete');
    end if;
    v_use_osis := true;
    v_use_name := false;
  elsif p_identity = 'name' then
    if not v_has_name then
      return pg_catalog.jsonb_build_object('state', 'incomplete');
    end if;
    v_use_osis := false;
    v_use_name := true;
  elsif p_identity = 'both' then
    if not (v_has_osis and v_has_name) then
      return pg_catalog.jsonb_build_object('state', 'incomplete');
    end if;
    v_use_osis := true;
    v_use_name := true;
  else
    if not (v_has_osis or v_has_name) then
      return pg_catalog.jsonb_build_object('state', 'incomplete');
    end if;
    v_use_osis := v_has_osis;
    v_use_name := v_has_name;
  end if;

  -- The roster.
  select pg_catalog.count(*)::integer, (pg_catalog.array_agg(r.id))[1]
  into v_count, v_id
  from public.people_group_members m
  join public.requesters r on r.id = m.requester_id
  where m.group_id = p_group
    and r.kind in ('student', 'staff')
    and (not v_use_osis or public.app_checkin_fold_id(r.external_id) = v_osis)
    and (not v_use_name or public.app_checkin_name_matches(r, v_first, v_last));

  if v_count = 1 then
    return pg_catalog.jsonb_build_object('state', 'match', 'id', v_id, 'member', true);
  end if;
  if v_count > 1 then
    return pg_catalog.jsonb_build_object('state', 'ambiguous');
  end if;
  if not coalesce(p_walk_ins, false) then
    return pg_catalog.jsonb_build_object('state', 'none');
  end if;

  -- The directory, for a walk-in. Somebody who has left is not walking in.
  select pg_catalog.count(*)::integer, (pg_catalog.array_agg(r.id))[1]
  into v_count, v_id
  from public.requesters r
  where r.kind in ('student', 'staff')
    and r.archived_at is null
    and (not v_use_osis or public.app_checkin_fold_id(r.external_id) = v_osis)
    and (not v_use_name or public.app_checkin_name_matches(r, v_first, v_last));

  if v_count = 1 then
    return pg_catalog.jsonb_build_object('state', 'match', 'id', v_id, 'member', false);
  end if;
  if v_count > 1 then
    return pg_catalog.jsonb_build_object('state', 'ambiguous');
  end if;
  return pg_catalog.jsonb_build_object('state', 'none');
end;
$$;

/*
 * Whether a check-in is taken right now: 'open', 'closed' (the switch),
 * 'early' (before the event's day) or 'ended' (after it). Days are school
 * days: `app_today()` is New York's date.
 */
create or replace function public.app_checkin_state(p_open boolean, p_held_on date)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when not coalesce(p_open, false) then 'closed'
    when public.app_today() < p_held_on then 'early'
    when public.app_today() > p_held_on then 'ended'
    else 'open'
  end;
$$;

/*
 * Whether this caller, or this link as a whole, has run out of tries for the
 * next fifteen minutes. Ten misses per caller and two hundred per link;
 * twenty-five check-ins per caller.
 */
create or replace function public.app_checkin_throttled(p_event uuid, p_key text, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (
      select pg_catalog.count(*)
      from public.event_checkin_attempts a
      where a.event_id = p_event and a.kind = p_kind and a.client_key = p_key
        and a.at > pg_catalog.now() - interval '15 minutes'
    ) >= case when p_kind = 'miss' then 10 else 25 end
    or (
      p_kind = 'miss'
      and (
        select pg_catalog.count(*)
        from public.event_checkin_attempts a
        where a.event_id = p_event and a.kind = 'miss'
          and a.at > pg_catalog.now() - interval '15 minutes'
      ) >= 200
    );
$$;

/* The settings an officer's screen reads, with the counts beside them. */
create or replace function public.app_checkin_json(p_checkin public.event_checkins, p_event public.group_events)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'event_id', p_event.id,
    'slug', p_checkin.slug,
    'is_open', p_checkin.is_open,
    'identity', p_checkin.identity,
    'walk_ins', p_checkin.walk_ins,
    'state', public.app_checkin_state(p_checkin.is_open, p_event.held_on),
    'held_on', p_event.held_on,
    'present_count', (
      select pg_catalog.count(*)::integer
      from public.group_attendance a
      join public.people_group_members m on m.group_id = p_event.group_id and m.requester_id = a.requester_id
      where a.event_id = p_event.id
    ),
    -- Nobody signed in marked them: the link, or a form's own link.
    'self_count', (
      select pg_catalog.count(*)::integer
      from public.group_attendance a
      where a.event_id = p_event.id and a.marked_by is null
    ),
    'member_count', (
      select pg_catalog.count(*)::integer
      from public.people_group_members m
      where m.group_id = p_event.group_id
    ),
    'updated_at', p_checkin.updated_at
  );
$$;

-- ---------------------------------------------------------------------------
-- The public door: two functions, granted to anon.
-- ---------------------------------------------------------------------------

/*
 * What `/c/<slug>` renders. NULL for a slug that is not a check-in. The
 * event's and group's names and day are what the poster prints; the identity
 * setting is what the page asks for.
 */
create or replace function public.app_public_checkin(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_checkin public.event_checkins;
  v_event public.group_events;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9]{12}$' then
    return null;
  end if;

  select * into v_checkin from public.event_checkins c where c.slug = p_slug;
  if not found then
    return null;
  end if;
  select * into v_event from public.group_events e where e.id = v_checkin.event_id;

  return pg_catalog.jsonb_build_object(
    'slug', v_checkin.slug,
    'event_name', v_event.name,
    'group_name', (select g.name from public.people_groups g where g.id = v_event.group_id),
    'held_on', v_event.held_on,
    'identity', v_checkin.identity,
    'state', public.app_checkin_state(v_checkin.is_open, v_event.held_on)
  );
end;
$$;

comment on function public.app_public_checkin(text) is
  'Public: one self check-in by its slug, for /c/<slug>. The event, its group, its day, what the page asks for and whether it is open. NULL for an unknown slug. Never the roster, a count or who made it.';

/*
 * The public check-in. Answers a JSON object and never raises for a wrong
 * identity, because a raise would roll back the row that counts it.
 *
 *   {ok: true, outcome: 'present' | 'already', first_name}
 *   {ok: false, reason: 'missing' | 'closed' | 'early' | 'ended' | 'incomplete'
 *                       | 'no_match' | 'ambiguous' | 'throttled'}
 */
create or replace function public.app_public_checkin_submit(
  p_slug text,
  p_osis text,
  p_first text,
  p_last text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_checkin public.event_checkins;
  v_event public.group_events;
  v_state text;
  v_key text;
  v_match jsonb;
  v_person public.requesters;
  v_marked boolean;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9]{12}$' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  select * into v_checkin from public.event_checkins c where c.slug = p_slug;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  select * into v_event from public.group_events e where e.id = v_checkin.event_id;

  v_state := public.app_checkin_state(v_checkin.is_open, v_event.held_on);
  if v_state <> 'open' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', v_state);
  end if;

  v_key := public.app_form_client_key();

  -- A day of history is more than the fifteen minutes counted.
  delete from public.event_checkin_attempts a
  where a.event_id = v_event.id and a.at < pg_catalog.now() - interval '1 day';

  if public.app_checkin_throttled(v_event.id, v_key, 'miss') then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'throttled');
  end if;

  v_match := public.app_checkin_match(
    v_event.group_id, v_checkin.walk_ins, v_checkin.identity, p_osis, p_first, p_last
  );

  if v_match ->> 'state' = 'incomplete' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'incomplete');
  end if;
  if v_match ->> 'state' in ('none', 'ambiguous') then
    insert into public.event_checkin_attempts (event_id, client_key, kind)
    values (v_event.id, v_key, 'miss');
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', case when v_match ->> 'state' = 'none' then 'no_match' else 'ambiguous' end
    );
  end if;

  if public.app_checkin_throttled(v_event.id, v_key, 'hit') then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'throttled');
  end if;

  select * into v_person from public.requesters r where r.id = (v_match ->> 'id')::uuid;

  -- A walk-in joins the roster first: attendance is only ever taken against it.
  if not (v_match ->> 'member')::boolean then
    insert into public.people_group_members (group_id, requester_id, note, added_by)
    values (v_event.group_id, v_person.id, 'Walk-in', null)
    on conflict do nothing;
    update public.people_groups g set updated_at = pg_catalog.now() where g.id = v_event.group_id;
  end if;

  insert into public.group_attendance (event_id, requester_id, marked_by)
  values (v_event.id, v_person.id, null)
  on conflict do nothing;
  v_marked := found;

  insert into public.event_checkin_attempts (event_id, client_key, kind)
  values (v_event.id, v_key, 'hit');

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', case when v_marked then 'present' else 'already' end,
    'first_name', public.app_form_first_name(v_person)
  );
end;
$$;

comment on function public.app_public_checkin_submit(text, text, text, text) is
  'Public: checks somebody in to an open self check-in by OSIS, name, either or both, as the event asks. Looks on the roster first and, with walk-ins allowed, in the directory, adding a walk-in to the roster. Answers present or already with the first name only; a miss, an ambiguous name and somebody not on a roster without walk-ins are counted against the caller and the link.';

-- ---------------------------------------------------------------------------
-- Signed-in reads and the one write
-- ---------------------------------------------------------------------------

create or replace function public.app_event_checkin(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.group_events;
  v_checkin public.event_checkins;
begin
  perform public.app_require_actor();

  select * into v_event from public.group_events e where e.id = p_event;
  if not found then
    return null;
  end if;
  select * into v_checkin from public.event_checkins c where c.event_id = p_event;
  if not found then
    return null;
  end if;
  return public.app_checkin_json(v_checkin, v_event);
end;
$$;

comment on function public.app_event_checkin(uuid) is
  'One event''s self check-in: its slug, whether it is open, the identity setting, walk-ins, its state today and the counts. NULL when it was never turned on.';

create or replace function public.app_group_event_checkins(p_group uuid)
returns table (
  event_id uuid,
  is_open boolean,
  state text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();

  return query
    select c.event_id, c.is_open, public.app_checkin_state(c.is_open, e.held_on)
    from public.event_checkins c
    join public.group_events e on e.id = c.event_id
    where e.group_id = p_group;
end;
$$;

comment on function public.app_group_event_checkins(uuid) is
  'Which of a group''s events have self check-in, and whether each is taking check-ins today.';

/*
 * Turns self check-in on, off, or changes how it asks. The first call for an
 * event draws its address; later calls keep it, so a printed poster keeps
 * working. NULL for a setting means "leave it as it is".
 */
create or replace function public.app_set_event_checkin(
  p_event uuid,
  p_open boolean default null,
  p_identity text default null,
  p_walk_ins boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_event public.group_events;
  v_before public.event_checkins;
  v_after public.event_checkins;
  v_try integer := 0;
  v_group_name text;
begin
  v_actor := public.app_require_actor();

  select * into v_event from public.group_events e where e.id = p_event for update;
  if not found then
    raise exception 'There is no event with that id.' using errcode = 'check_violation';
  end if;
  if p_identity is not null and p_identity not in ('osis', 'name', 'either', 'both') then
    raise exception 'Choose how people check in: osis, name, either or both.' using errcode = 'check_violation';
  end if;

  select * into v_before from public.event_checkins c where c.event_id = p_event for update;

  if v_before.event_id is null then
    loop
      v_try := v_try + 1;
      begin
        insert into public.event_checkins (event_id, slug, is_open, identity, walk_ins, created_by)
        values (
          p_event,
          public.app_form_slug(),
          coalesce(p_open, true),
          coalesce(p_identity, 'either'),
          coalesce(p_walk_ins, false),
          v_actor.id
        )
        returning * into v_after;
        exit;
      exception
        when unique_violation then
          if v_try >= 5 then
            raise;
          end if;
      end;
    end loop;
  else
    update public.event_checkins c
    set is_open = coalesce(p_open, c.is_open),
        identity = coalesce(p_identity, c.identity),
        walk_ins = coalesce(p_walk_ins, c.walk_ins),
        updated_at = pg_catalog.now()
    where c.event_id = p_event
    returning * into v_after;
  end if;

  select g.name into v_group_name from public.people_groups g where g.id = v_event.group_id;

  -- Filed against the group, like the event itself. Opening and closing are
  -- the two acts worth a line; a changed setting is said in the detail.
  if v_before.event_id is null or v_before.is_open <> v_after.is_open then
    perform public.app_log_record_event(
      'group',
      v_event.group_id,
      case when v_after.is_open then 'group_checkin_opened' else 'group_checkin_closed' end,
      v_actor.id,
      case when v_after.is_open then 'Self check-in opened: ' else 'Self check-in closed: ' end
        || v_event.name || ' on ' || v_event.held_on::text,
      pg_catalog.format(
        'Asks for %s%s.',
        case v_after.identity
          when 'osis' then 'the OSIS'
          when 'name' then 'the name'
          when 'both' then 'the OSIS and the name'
          else 'the OSIS or the name'
        end,
        case when v_after.walk_ins then ', and adds walk-ins to ' || coalesce(v_group_name, 'the group') else '' end
      )
    );
  elsif v_before.identity <> v_after.identity or v_before.walk_ins <> v_after.walk_ins then
    perform public.app_log_record_event(
      'group',
      v_event.group_id,
      'group_checkin_changed',
      v_actor.id,
      'Self check-in changed: ' || v_event.name || ' on ' || v_event.held_on::text,
      pg_catalog.format(
        'Asks for %s%s.',
        case v_after.identity
          when 'osis' then 'the OSIS'
          when 'name' then 'the name'
          when 'both' then 'the OSIS and the name'
          else 'the OSIS or the name'
        end,
        case when v_after.walk_ins then ', and adds walk-ins to ' || coalesce(v_group_name, 'the group') else '' end
      )
    );
  end if;

  return public.app_checkin_json(v_after, v_event);
end;
$$;

comment on function public.app_set_event_checkin(uuid, boolean, text, boolean) is
  'Turns an event''s self check-in on or off and sets how people identify and whether walk-ins join the roster. Any active account. The first call draws the /c/ address; later ones keep it. A null argument leaves that setting alone. Opening, closing and a changed setting each record one history entry against the group.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.event_checkins enable row level security;
alter table public.event_checkin_attempts enable row level security;

drop policy if exists event_checkins_select_active on public.event_checkins;

create policy event_checkins_select_active
  on public.event_checkins for select to authenticated
  using (public.app_active_account_id() is not null);

-- event_checkin_attempts carries no policy at all: RLS on and nothing
-- granted, so no client role can read or write it.

revoke all on table public.event_checkins, public.event_checkin_attempts
from public, anon, authenticated;

grant select on table public.event_checkins to authenticated;

revoke execute on function
  public.app_checkin_fold(text),
  public.app_checkin_fold_id(text),
  public.app_checkin_name_matches(public.requesters, text, text),
  public.app_checkin_match(uuid, boolean, text, text, text, text),
  public.app_checkin_state(boolean, date),
  public.app_checkin_throttled(uuid, text, text),
  public.app_checkin_json(public.event_checkins, public.group_events)
from public, anon, authenticated;

revoke execute on function
  public.app_public_checkin(text),
  public.app_public_checkin_submit(text, text, text, text),
  public.app_event_checkin(uuid),
  public.app_group_event_checkins(uuid),
  public.app_set_event_checkin(uuid, boolean, text, boolean)
from public, anon;

-- The public door. These two and nothing else.
grant execute on function
  public.app_public_checkin(text),
  public.app_public_checkin_submit(text, text, text, text)
to anon, authenticated;

grant execute on function
  public.app_event_checkin(uuid),
  public.app_group_event_checkins(uuid),
  public.app_set_event_checkin(uuid, boolean, text, boolean)
to authenticated;
