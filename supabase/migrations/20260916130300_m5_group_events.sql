-- ---------------------------------------------------------------------------
-- What a roster is FOR: taking attendance, and keeping track of who has done
-- the thing everybody has to do.
--
-- `20260916130100_m5_groups.sql` deliberately left the group row generic, and
-- this is what it left room for. Both halves hang off `group_id` and neither
-- changes anything already there.
--
--   ATTENDANCE is an EVENT and a set of people who were at it. A row in
--   `group_attendance` means present; no row means absent. That is the whole
--   model, and it is the right one: absence is not a fact somebody records, it
--   is what is left when the meeting ends, and a three-state column would have
--   had a screen asking "unmarked or absent?" about twenty-four people every
--   week.
--
--   A CHECKLIST is up to six named things per group — "Permission slip",
--   "Dues", "Polo ordered" — and a mark is again a row that exists or does
--   not. Six because it is a column each on the roster table and a phone is
--   390px wide; past that it is a form, and a form is a different screen.
--
-- The MEMBERSHIP is the authority in both. Attendance and marks are refused
-- for somebody who is not in the group, so a roster cannot quietly grow a
-- shadow membership of people who were only ever scanned at the door.
--
-- Every function is SECURITY DEFINER with `set search_path = ''` and begins by
-- asking `app_require_actor()`, so any active account may run the chapter's
-- own business and nobody else may. Deleting the GROUP is still the one
-- administrator act; deleting one of its events is not, because an event is a
-- Tuesday and can be taken again.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. Attendance
-- ---------------------------------------------------------------------------

create table if not exists public.group_events (
  id uuid primary key default extensions.gen_random_uuid(),
  group_id uuid not null references public.people_groups (id) on delete cascade,
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 80),
  -- A date, not an instant: "the meeting on the 17th" is what somebody is
  -- looking for, and what time it started is not a fact anybody has.
  held_on date not null default current_date,
  created_by uuid references public.app_accounts (id),
  created_at timestamptz not null default now()
);

comment on table public.group_events is
  'Something a group did on a day: a meeting, a practice, a competition. Attendance is taken against one of these. Written only by app_create_group_event and app_delete_group_event.';

create index if not exists group_events_group_idx
  on public.group_events (group_id, held_on desc);

create table if not exists public.group_attendance (
  event_id uuid not null references public.group_events (id) on delete cascade,
  requester_id uuid not null references public.requesters (id) on delete cascade,
  marked_by uuid references public.app_accounts (id),
  marked_at timestamptz not null default now(),
  primary key (event_id, requester_id)
);

comment on table public.group_attendance is
  'One row per person who was present. No row means absent: absence is what is left over when the meeting ends, not something somebody records. Written only by the app_mark_attendance* functions.';

create index if not exists group_attendance_requester_idx
  on public.group_attendance (requester_id);

-- ---------------------------------------------------------------------------
-- B. Checklists
-- ---------------------------------------------------------------------------

create table if not exists public.group_fields (
  id uuid primary key default extensions.gen_random_uuid(),
  group_id uuid not null references public.people_groups (id) on delete cascade,
  -- Short, because it is a column heading on a table a phone has to show.
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 40),
  position integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.group_fields is
  'The columns a group ticks off against its members: "Permission slip", "Dues", "Polo ordered". Six per group at most, enforced by app_save_group_field. Written only through that function.';

create unique index if not exists group_fields_name_unique
  on public.group_fields (group_id, pg_catalog.lower(name));

create table if not exists public.group_field_marks (
  field_id uuid not null references public.group_fields (id) on delete cascade,
  requester_id uuid not null references public.requesters (id) on delete cascade,
  marked_by uuid references public.app_accounts (id),
  marked_at timestamptz not null default now(),
  primary key (field_id, requester_id)
);

comment on table public.group_field_marks is
  'A row means ticked. No row means not yet, which is what a checklist is for. Written only by app_set_group_mark.';

create index if not exists group_field_marks_requester_idx
  on public.group_field_marks (requester_id);

-- ---------------------------------------------------------------------------
-- Attendance: reads
-- ---------------------------------------------------------------------------

/*
 * Every event a group has held, newest first, each with the two numbers the
 * line is read for: how many were there, out of how many are in the group.
 *
 * `member_count` is the membership as it is NOW rather than as it was on the
 * day. That is the honest number for the only question this list answers —
 * "have we taken this one yet, and does it look finished?" — and a roster that
 * grew since Tuesday genuinely does have more people who were not at Tuesday's
 * meeting.
 */
create or replace function public.app_list_group_events(p_group uuid)
returns table (
  id uuid,
  name text,
  held_on date,
  present_count integer,
  member_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();

  return query
    select
      e.id,
      e.name,
      e.held_on,
      (
        select pg_catalog.count(*)::integer
        from public.group_attendance a
        where a.event_id = e.id
      ),
      (
        select pg_catalog.count(*)::integer
        from public.people_group_members m
        where m.group_id = e.group_id
      )
    from public.group_events e
    where e.group_id = p_group
    -- The day first, then the order they were created, so two events on one
    -- day read the way they were added rather than at random.
    order by e.held_on desc, e.created_at desc;
end;
$$;

comment on function public.app_list_group_events(uuid) is
  'A group''s events, newest first, each with how many were present and how many are in the group now. Open to any active account.';

/*
 * The roll: every member of the event's group, present or not.
 *
 * Driven by the MEMBERSHIP rather than by the attendance rows, because the
 * screen is a list of people to tick rather than a list of ticks. Somebody who
 * left the group after being marked present simply stops appearing; their row
 * stays in the table and comes back if they rejoin, which is kinder than
 * deleting a fact because a roster changed.
 */
create or replace function public.app_event_roll(p_event uuid)
returns table (
  requester_id uuid,
  display_name text,
  kind text,
  external_id text,
  group_label text,
  present boolean,
  marked_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();

  return query
    select
      r.id,
      r.display_name,
      r.kind,
      r.external_id,
      nullif(pg_catalog.btrim(coalesce(
        case when r.kind = 'student' then r.official_class else r.department end, '')), ''),
      (a.event_id is not null),
      a.marked_at
    from public.group_events e
    join public.people_group_members m on m.group_id = e.group_id
    join public.requesters r on r.id = m.requester_id
    left join public.group_attendance a on a.event_id = e.id and a.requester_id = r.id
    where e.id = p_event
    order by pg_catalog.lower(r.display_name), r.id;
end;
$$;

comment on function public.app_event_roll(uuid) is
  'Every member of the event''s group with whether they were present and when they were marked, ordered by name. No rows for an event that does not exist.';

-- ---------------------------------------------------------------------------
-- Attendance: writes
-- ---------------------------------------------------------------------------

create or replace function public.app_create_group_event(
  p_group uuid,
  p_name text,
  p_held_on date default current_date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_group public.people_groups;
  v_name text;
  v_held date;
  v_id uuid;
begin
  v_actor := public.app_require_actor();

  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'Give the event a name.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_name) > 80 then
    raise exception 'An event name is 80 characters at most.' using errcode = 'check_violation';
  end if;

  -- A null date means today, which is what taking attendance usually is.
  v_held := coalesce(p_held_on, current_date);

  select * into v_group from public.people_groups g where g.id = p_group;
  if not found then
    raise exception 'There is no group with that id.' using errcode = 'check_violation';
  end if;

  insert into public.group_events (group_id, name, held_on, created_by)
  values (p_group, v_name, v_held, v_actor.id)
  returning id into v_id;

  -- Filed against the GROUP, so the audit screen can name and link it. The
  -- event's own name and day go in; nobody who was at it does.
  perform public.app_log_record_event(
    'group',
    p_group,
    'group_event_created',
    v_actor.id,
    'Event created: ' || v_name || ' on ' || v_held::text
  );

  return v_id;
end;
$$;

comment on function public.app_create_group_event(uuid, text, date) is
  'Adds a day the group did something, which attendance is then taken against. Any active account. Records one history entry against the group.';

create or replace function public.app_delete_group_event(p_event uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_event public.group_events;
  v_present integer;
begin
  v_actor := public.app_require_actor();

  select * into v_event from public.group_events e where e.id = p_event for update;
  if not found then
    raise exception 'There is no event with that id.' using errcode = 'check_violation';
  end if;

  select pg_catalog.count(*)::integer into v_present
  from public.group_attendance a
  where a.event_id = p_event;

  delete from public.group_events e where e.id = p_event;

  -- Not an administrator's act: an event is a Tuesday, and a Tuesday can be
  -- taken again. The count of what went with it is the whole record.
  perform public.app_log_record_event(
    'group',
    v_event.group_id,
    'group_event_deleted',
    v_actor.id,
    'Event deleted: ' || v_event.name || ' on ' || v_event.held_on::text,
    v_present || (case when v_present = 1 then ' attendance record' else ' attendance records' end)
      || ' went with it.'
  );
end;
$$;

comment on function public.app_delete_group_event(uuid) is
  'Deletes one event and the attendance taken at it. Any active account. Records one history entry with the count, never who was there.';

create or replace function public.app_mark_attendance(
  p_event uuid,
  p_requester uuid,
  p_present boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_group uuid;
  v_name text;
begin
  v_actor := public.app_require_actor();

  select e.group_id into v_group from public.group_events e where e.id = p_event;
  if v_group is null then
    raise exception 'There is no event with that id.' using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.people_group_members m
    where m.group_id = v_group and m.requester_id = p_requester
  ) then
    select g.name into v_name from public.people_groups g where g.id = v_group;
    -- Named rather than generic: somebody at the door with a scanner needs to
    -- know that the fix is to add this person to the group, not to try again.
    raise exception 'That person is not in %. Add them to the group first.', coalesce(v_name, 'this group')
      using errcode = 'check_violation';
  end if;

  if coalesce(p_present, false) then
    insert into public.group_attendance (event_id, requester_id, marked_by)
    values (p_event, p_requester, v_actor.id)
    on conflict (event_id, requester_id) do nothing;
  else
    delete from public.group_attendance a
    where a.event_id = p_event and a.requester_id = p_requester;
  end if;
end;
$$;

comment on function public.app_mark_attendance(uuid, uuid, boolean) is
  'Marks one member present or not present at one event. Refuses somebody who is not in the group, by name. Marking twice is not an error.';

/*
 * The scanner's own call: one code, one answer.
 *
 * The code on a student's card is their OSIS; a member of staff might be typed
 * in as a staff id, an address or a name. So the key is matched the way
 * `app_find_people` matches one: an identifier or an email exactly and
 * case-folded, a full name whole and case-folded, with the identifier winning
 * when both would match. A tie at the best rank is refused rather than guessed
 * at — two students called Nia Okonkwo is a real Tuesday, and marking the wrong
 * one present is worse than asking.
 *
 * Five outcomes, and the caller says all five out loud:
 *   present     — marked just now
 *   already     — was already marked, which is what a second scan means
 *   not_member  — a real person, not in this group
 *   no_match    — nothing in the directory reads like that
 *   ambiguous   — more than one person does
 */
create or replace function public.app_mark_attendance_by_key(p_event uuid, p_key text)
returns table (
  outcome text,
  requester_id uuid,
  display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_group uuid;
  v_key text;
  v_matches integer;
  v_id uuid;
  v_name text;
begin
  v_actor := public.app_require_actor();

  select e.group_id into v_group from public.group_events e where e.id = p_event;
  if v_group is null then
    raise exception 'There is no event with that id.' using errcode = 'check_violation';
  end if;

  v_key := pg_catalog.btrim(coalesce(p_key, ''));
  if v_key = '' then
    raise exception 'Scan a card, or type an OSIS, staff id or name.'
      using errcode = 'check_violation';
  end if;

  with hits as (
    select
      r.id,
      case
        when pg_catalog.lower(coalesce(r.external_id, '')) = pg_catalog.lower(v_key) then 1
        when r.email is not null and pg_catalog.lower(r.email) = pg_catalog.lower(v_key) then 1
        else 2
      end as rank
    from public.requesters r
    where r.kind in ('staff', 'student')
      and (
        pg_catalog.lower(coalesce(r.external_id, '')) = pg_catalog.lower(v_key)
        or (r.email is not null and pg_catalog.lower(r.email) = pg_catalog.lower(v_key))
        or pg_catalog.lower(r.display_name) = pg_catalog.lower(v_key)
      )
  ),
  best as (select pg_catalog.min(h.rank) as rank from hits h)
  select pg_catalog.count(*)::integer, (pg_catalog.array_agg(h.id))[1]
  into v_matches, v_id
  from hits h
  join best b on b.rank = h.rank;

  if coalesce(v_matches, 0) = 0 then
    outcome := 'no_match';
    requester_id := null;
    display_name := null;
    return next;
    return;
  end if;

  if v_matches > 1 then
    outcome := 'ambiguous';
    requester_id := null;
    display_name := null;
    return next;
    return;
  end if;

  select r.display_name into v_name from public.requesters r where r.id = v_id;

  if not exists (
    select 1 from public.people_group_members m
    where m.group_id = v_group and m.requester_id = v_id
  ) then
    -- A real person, and the caller is told who, because the next thing
    -- somebody does is decide whether to add them.
    outcome := 'not_member';
    requester_id := v_id;
    display_name := v_name;
    return next;
    return;
  end if;

  if exists (
    select 1 from public.group_attendance a
    where a.event_id = p_event and a.requester_id = v_id
  ) then
    outcome := 'already';
  else
    -- No conflict target named: `requester_id` is one of this function's own
    -- output columns, and Postgres cannot tell the column from the variable.
    insert into public.group_attendance (event_id, requester_id, marked_by)
    values (p_event, v_id, v_actor.id)
    on conflict do nothing;
    outcome := 'present';
  end if;

  requester_id := v_id;
  display_name := v_name;
  return next;
end;
$$;

comment on function public.app_mark_attendance_by_key(uuid, text) is
  'Marks somebody present from a scanned card or a typed OSIS, staff id, email or full name, using app_find_people''s matching rules. Answers one row: present, already, not_member, no_match or ambiguous.';

/*
 * A whole list at once, for the assistant.
 *
 * One row per id, in no particular order, saying what happened to it. The
 * classification is computed BEFORE the insert in the same statement, so
 * "already" means already before this call rather than already because of it.
 */
create or replace function public.app_mark_attendance_many(
  p_event uuid,
  p_requesters uuid[]
)
returns table (
  outcome text,
  requester_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_group uuid;
begin
  v_actor := public.app_require_actor();

  select e.group_id into v_group from public.group_events e where e.id = p_event;
  if v_group is null then
    raise exception 'There is no event with that id.' using errcode = 'check_violation';
  end if;

  if p_requesters is null or pg_catalog.array_length(p_requesters, 1) is null then
    raise exception 'Name at least one person to mark.' using errcode = 'check_violation';
  end if;
  if pg_catalog.array_length(p_requesters, 1) > 500 then
    raise exception 'Mark at most 500 people at once.' using errcode = 'check_violation';
  end if;

  return query
  with wanted as (
    select distinct pg_catalog.unnest(p_requesters) as id
  ),
  classified as (
    select
      w.id,
      case
        when not exists (
          select 1 from public.people_group_members m
          where m.group_id = v_group and m.requester_id = w.id
        ) then 'not_member'
        when exists (
          select 1 from public.group_attendance a
          where a.event_id = p_event and a.requester_id = w.id
        ) then 'already'
        else 'present'
      end as outcome
    from wanted w
  ),
  -- Always executed, whether or not the outer query reads it: that is what a
  -- data-modifying CTE does, and it is why the classification above is not
  -- looking at its own work.
  marked as (
    insert into public.group_attendance (event_id, requester_id, marked_by)
    select p_event, c.id, v_actor.id
    from classified c
    where c.outcome = 'present'
    -- No conflict target and nothing named in the RETURNING: `requester_id` is
    -- also this function's own output column, and naming it here would be
    -- ambiguous between the column and the variable.
    on conflict do nothing
    returning 1
  )
  select c.outcome, c.id from classified c;
end;
$$;

comment on function public.app_mark_attendance_many(uuid, uuid[]) is
  'Marks many people present at one event and answers one row per id: present, already or not_member. At most 500 at once. Nobody outside the group is ever marked.';

-- ---------------------------------------------------------------------------
-- Checklists
-- ---------------------------------------------------------------------------

create or replace function public.app_list_group_fields(p_group uuid)
returns table (
  id uuid,
  name text,
  -- Quoted because `position` is a keyword the function-signature parser will
  -- not take bare, and the column is called `position` on the table and in
  -- every caller. The alternative was a second name for one thing.
  "position" integer,
  checked_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();

  return query
    select
      f.id,
      f.name,
      f.position,
      (
        select pg_catalog.count(*)::integer
        from public.group_field_marks k
        where k.field_id = f.id
      )
    from public.group_fields f
    where f.group_id = p_group
    order by f.position, pg_catalog.lower(f.name);
end;
$$;

comment on function public.app_list_group_fields(uuid) is
  'A group''s checklist columns in the order they are shown, each with how many members are ticked. Open to any active account.';

/** How many columns one roster carries. Six is what a phone can show. */
create or replace function public.app_save_group_field(
  p_field uuid,
  p_group uuid,
  p_name text,
  p_position integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_name text;
  v_position integer;
  v_group uuid;
  v_count integer;
  v_id uuid;
begin
  v_actor := public.app_require_actor();

  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'Give the column a name.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_name) > 40 then
    raise exception 'A column name is 40 characters at most.' using errcode = 'check_violation';
  end if;
  v_position := greatest(0, least(coalesce(p_position, 0), 99));

  if p_field is null then
    select g.id into v_group from public.people_groups g where g.id = p_group for update;
    if v_group is null then
      raise exception 'There is no group with that id.' using errcode = 'check_violation';
    end if;

    select pg_catalog.count(*)::integer into v_count
    from public.group_fields f
    where f.group_id = v_group;

    -- Six, and the message says what to do about it. Past six the roster stops
    -- being a table somebody can read on a phone and becomes a form.
    if v_count >= 6 then
      raise exception 'A group has six columns at most. Delete one before adding another.'
        using errcode = 'check_violation';
    end if;

    begin
      insert into public.group_fields (group_id, name, position)
      values (v_group, v_name, v_position)
      returning id into v_id;
    exception
      when unique_violation then
        raise exception 'There is already a column called % on this group.', v_name
          using errcode = 'check_violation';
    end;

    return v_id;
  end if;

  -- An edit. The group is the field's own; a caller that names a different one
  -- is not moving a column between rosters, it is wrong, and the stored group
  -- is what the uniqueness rule is checked against anyway.
  select f.group_id into v_group from public.group_fields f where f.id = p_field for update;
  if v_group is null then
    raise exception 'There is no column with that id.' using errcode = 'check_violation';
  end if;

  begin
    update public.group_fields f
    set name = v_name,
        position = v_position
    where f.id = p_field;
  exception
    when unique_violation then
      raise exception 'There is already a column called % on this group.', v_name
        using errcode = 'check_violation';
  end;

  return p_field;
end;
$$;

comment on function public.app_save_group_field(uuid, uuid, text, integer) is
  'Adds or edits one checklist column. Six per group at most and one of each name, both refused with a sentence rather than an index name. Pass a null id to add.';

create or replace function public.app_delete_group_field(p_field uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
begin
  v_actor := public.app_require_actor();

  -- The marks go with it, by the cascade. A column nobody uses any more is the
  -- reason this exists, and keeping its ticks would keep the column in
  -- everything but name.
  delete from public.group_fields f where f.id = p_field;
end;
$$;

comment on function public.app_delete_group_field(uuid) is
  'Removes one checklist column and every tick on it. Any active account. Deleting one that is not there is not an error.';

create or replace function public.app_set_group_mark(
  p_field uuid,
  p_requester uuid,
  p_checked boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_group uuid;
begin
  v_actor := public.app_require_actor();

  select f.group_id into v_group from public.group_fields f where f.id = p_field;
  if v_group is null then
    raise exception 'There is no column with that id.' using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.people_group_members m
    where m.group_id = v_group and m.requester_id = p_requester
  ) then
    raise exception 'That person is not in this group.' using errcode = 'check_violation';
  end if;

  if coalesce(p_checked, false) then
    insert into public.group_field_marks (field_id, requester_id, marked_by)
    values (p_field, p_requester, v_actor.id)
    on conflict (field_id, requester_id) do nothing;
  else
    delete from public.group_field_marks k
    where k.field_id = p_field and k.requester_id = p_requester;
  end if;
end;
$$;

comment on function public.app_set_group_mark(uuid, uuid, boolean) is
  'Ticks or unticks one member against one checklist column. Refuses somebody who is not in the group.';

/*
 * Every tick on a group, as pairs.
 *
 * One read for the whole table rather than one per cell: the roster screen
 * holds every member and every column already, and what it is missing is which
 * of the up-to-144 boxes are ticked.
 */
create or replace function public.app_group_marks(p_group uuid)
returns table (
  requester_id uuid,
  field_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();

  return query
    select k.requester_id, k.field_id
    from public.group_field_marks k
    join public.group_fields f on f.id = k.field_id
    where f.group_id = p_group;
end;
$$;

comment on function public.app_group_marks(uuid) is
  'Every ticked (person, column) pair on one group, for a screen that already holds the members and the columns.';

-- ---------------------------------------------------------------------------
-- Exports
--
-- Both group exports are ordinary reads served as a file, so the gate is the
-- same active-account gate everything else here has. What is NOT ordinary is
-- that a copy of the roster leaves the building, so it is recorded before the
-- file is served — the count, and which of the two files it was. Never a name.
-- ---------------------------------------------------------------------------

create or replace function public.app_log_group_export(
  p_group uuid,
  p_what text,
  p_count integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_group public.people_groups;
  v_count integer;
begin
  v_actor := public.app_require_actor();

  if p_what is null or p_what not in ('roster', 'attendance') then
    raise exception 'Say which export: roster or attendance.' using errcode = 'check_violation';
  end if;

  select * into v_group from public.people_groups g where g.id = p_group;
  if not found then
    raise exception 'There is no group with that id.' using errcode = 'check_violation';
  end if;

  v_count := greatest(coalesce(p_count, 0), 0);

  perform public.app_log_record_event(
    'group',
    p_group,
    case when p_what = 'roster' then 'group_export' else 'group_attendance_export' end,
    v_actor.id,
    pg_catalog.format(
      'Exported %s %s from %s.',
      v_count,
      case when v_count = 1 then 'row' else 'rows' end,
      v_group.name
    )
  );
end;
$$;

comment on function public.app_log_group_export(uuid, text, integer) is
  'Records that the caller exported a group''s roster or one event''s attendance, with how many rows. The exported content is never written to the log.';

-- ---------------------------------------------------------------------------
-- The audit screen learns to name a group.
--
-- `20260916130100_m5_groups.sql` added 'group' to the record_events vocabulary
-- but not to this function's label CASE, so every group entry rendered as
-- "(deleted)" — which is what a null label means to the screen. The body below
-- is the definition from `20260914101000_m5_audit_notifications.sql`, restated
-- whole because `create or replace` replaces the whole body, with ONE branch
-- added.
-- ---------------------------------------------------------------------------

create or replace function public.app_audit_log(
  p_actor uuid default null,
  p_via text default null,
  p_kind text default null,
  p_entity text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  source text,
  id uuid,
  at timestamptz,
  actor_id uuid,
  actor_name text,
  performed_via text,
  ai_model text,
  kind text,
  entity_type text,
  entity_id uuid,
  entity_label text,
  summary text,
  detail text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Refused out loud. An administrator-only read that answered a technician with
  -- an empty page would look like a desk where nothing had happened.
  if not public.app_is_admin() then
    raise exception 'Only an administrator can read the audit log.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    with combined as (
      -- Ticket history. The label is the ticket number, because that is what a
      -- technician reads off a printout and types into the lookup bar.
      select
        'activity'::text as source,
        e.id,
        e.at,
        e.actor_id,
        e.performed_via,
        e.ai_model,
        e.kind,
        'ticket'::text as entity_type,
        e.ticket_id as entity_id,
        t.number as entity_label,
        e.summary,
        e.detail
      from public.activity_events e
      join public.tickets t on t.id = e.ticket_id

      union all

      -- Account history. This table predates M5 attribution and records no
      -- assistant action: every row in it is written by an administrator working
      -- directly or by a trusted credential flow, so `performed_via` answers
      -- 'user' rather than NULL and the column means the same thing everywhere.
      -- It also carries no summary line, so the kind is rendered as one.
      select
        'account'::text,
        e.id,
        e.at,
        e.actor_id,
        'user'::text,
        null::text,
        e.kind,
        'account'::text,
        e.account_id,
        a.display_name,
        pg_catalog.initcap(pg_catalog.replace(e.kind, '_', ' ')),
        e.detail
      from public.account_events e
      join public.app_accounts a on a.id = e.account_id

      union all

      -- Everything else. The label is whatever names the record to a person: a
      -- machine is known by the tag on its lid, somebody by their name, an
      -- invite by the address it was sent to. A label that comes back NULL means
      -- the record it named is gone, which the screen shows as such rather than
      -- inventing a name for it.
      select
        'record'::text,
        e.id,
        e.at,
        e.actor_id,
        e.performed_via,
        e.ai_model,
        e.kind,
        e.entity_type,
        e.entity_id,
        case e.entity_type
          when 'requester' then (
            select r.display_name from public.requesters r where r.id = e.entity_id
          )
          when 'inventory_device' then (
            select coalesce(
              nullif(pg_catalog.btrim(coalesce(d.asset_tag, '')), ''),
              nullif(pg_catalog.btrim(coalesce(d.serial_number, '')), ''),
              d.external_id
            )
            from public.inventory_devices d where d.id = e.entity_id
          )
          when 'invite' then (
            select i.email from public.account_invites i where i.id = e.entity_id
          )
          -- A roster is known by its name. An entry about a group that has since
          -- been deleted reads as "(deleted)" like any other, which is exactly
          -- what happened to it.
          when 'group' then (
            select g.name from public.people_groups g where g.id = e.entity_id
          )
          -- 'import' stays in the record_events vocabulary and has no label
          -- branch: the in-app importer that wrote those rows is gone with the
          -- tables it wrote, so there is no import to name. An old row would
          -- render the same way a deleted record does.
          when 'account' then (
            select a.display_name from public.app_accounts a where a.id = e.entity_id
          )
        end,
        e.summary,
        e.detail
      from public.record_events e
    ),
    filtered as (
      select c.*
      from combined c
      -- NULL means "every value of this field", not "no value": the audit screen
      -- sends nothing for a filter it is not applying.
      where (p_actor is null or c.actor_id = p_actor)
        and (p_via is null or c.performed_via = p_via)
        and (p_kind is null or c.kind = p_kind)
        and (p_entity is null or c.entity_type = p_entity)
        and (p_from is null or c.at >= p_from)
        and (p_to is null or c.at <= p_to)
    )
    select
      f.source, f.id, f.at, f.actor_id,
      -- Joined rather than rendered through a helper: the caller is an
      -- administrator, who may already read every account row, and an audit line
      -- whose actor rendered as nobody would be worse than useless.
      act.display_name,
      f.performed_via, f.ai_model, f.kind, f.entity_type, f.entity_id,
      f.entity_label, f.summary, f.detail,
      -- Window count over the same filtered set, computed before the page is cut,
      -- so a total never depends on which page is being read.
      pg_catalog.count(*) over () as total_count
    from filtered f
    -- LEFT: a record event written by a trusted server flow has no actor, and
    -- that row still belongs in the log.
    left join public.app_accounts act on act.id = f.actor_id
    -- id breaks ties so paging is deterministic: events written in one
    -- transaction share an instant, which resolving a ticket makes routine.
    order by f.at desc, f.id
    -- Floor of zero, not one: a screen that wants only the total says so by
    -- passing 0. The ceiling keeps one call from reading the whole history.
    limit greatest(0, least(coalesce(p_limit, 50), 200))
    offset greatest(0, coalesce(p_offset, 0));
end;
$$;

comment on function public.app_audit_log(uuid, text, text, text, timestamptz, timestamptz, integer, integer) is
  'Administrator-only audit read: ticket activity, account events and record events in one ordered, paged, filtered list, newest first. Every filter is optional and fails closed. Refuses a technician rather than returning an empty page.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants
--
-- The same shape as the groups themselves: SELECT for any active account, no
-- write policy at all, and the functions above as the one door.
-- ---------------------------------------------------------------------------

alter table public.group_events enable row level security;
alter table public.group_attendance enable row level security;
alter table public.group_fields enable row level security;
alter table public.group_field_marks enable row level security;

drop policy if exists group_events_select_active on public.group_events;
drop policy if exists group_attendance_select_active on public.group_attendance;
drop policy if exists group_fields_select_active on public.group_fields;
drop policy if exists group_field_marks_select_active on public.group_field_marks;

create policy group_events_select_active
  on public.group_events for select to authenticated
  using (public.app_active_account_id() is not null);

create policy group_attendance_select_active
  on public.group_attendance for select to authenticated
  using (public.app_active_account_id() is not null);

create policy group_fields_select_active
  on public.group_fields for select to authenticated
  using (public.app_active_account_id() is not null);

create policy group_field_marks_select_active
  on public.group_field_marks for select to authenticated
  using (public.app_active_account_id() is not null);

revoke all on table
  public.group_events,
  public.group_attendance,
  public.group_fields,
  public.group_field_marks
from anon, authenticated;

grant select on table
  public.group_events,
  public.group_attendance,
  public.group_fields,
  public.group_field_marks
to authenticated;

revoke execute on function
  public.app_list_group_events(uuid),
  public.app_event_roll(uuid),
  public.app_create_group_event(uuid, text, date),
  public.app_delete_group_event(uuid),
  public.app_mark_attendance(uuid, uuid, boolean),
  public.app_mark_attendance_by_key(uuid, text),
  public.app_mark_attendance_many(uuid, uuid[]),
  public.app_list_group_fields(uuid),
  public.app_save_group_field(uuid, uuid, text, integer),
  public.app_delete_group_field(uuid),
  public.app_set_group_mark(uuid, uuid, boolean),
  public.app_group_marks(uuid),
  public.app_log_group_export(uuid, text, integer)
from public, anon;

grant execute on function
  public.app_list_group_events(uuid),
  public.app_event_roll(uuid),
  public.app_create_group_event(uuid, text, date),
  public.app_delete_group_event(uuid),
  public.app_mark_attendance(uuid, uuid, boolean),
  public.app_mark_attendance_by_key(uuid, text),
  public.app_mark_attendance_many(uuid, uuid[]),
  public.app_list_group_fields(uuid),
  public.app_save_group_field(uuid, uuid, text, integer),
  public.app_delete_group_field(uuid),
  public.app_set_group_mark(uuid, uuid, boolean),
  public.app_group_marks(uuid),
  public.app_log_group_export(uuid, text, integer)
to authenticated;
