-- ---------------------------------------------------------------------------
-- Groups: the rosters a chapter and a helpdesk live by.
--
-- "SkillsUSA members", "Officers", "Regionals 2027 competitors", "Chromebook
-- cart 3". Every one of those is a list of people somebody keeps somewhere —
-- a spreadsheet, a group chat, the back of a notebook — and every one of them
-- goes stale the moment the directory changes under it. This is that list,
-- kept against `public.requesters` so a name that changes changes everywhere
-- and a person who leaves is one record rather than four lists.
--
-- WHO MAY DO WHAT. Reading a group and changing who is in it is open to every
-- active account: a skills officer, a NetRider and an administrator are all
-- looking at the same chapter, and a roster that only an administrator could
-- edit would be kept in a spreadsheet instead, which is the failure this is
-- meant to end. Deleting a group is the one administrator act, because it is
-- the only one that destroys work — the members go with it — and because a
-- group nobody needs any more can simply be left alone.
--
-- THE GROUP ROW IS DELIBERATELY GENERIC. Attendance and checklists are next,
-- and both hang off a group rather than living in it: a group is a name, a
-- sentence and a set of people, and anything that happens ON a date or TO an
-- item belongs in its own table keyed by `group_id`. Nothing here should have
-- to change to add them.
--
-- NO DIRECT WRITES. Both tables carry row-level security with a SELECT policy
-- and nothing else, `authenticated` holds SELECT and no more, and every change
-- goes through a SECURITY DEFINER function that re-derives the actor with
-- `app_require_actor()`. That is the same door every other write in this
-- schema uses, and it is what keeps the caps, the attribution and the history
-- entry from being walked around.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.people_groups (
  id uuid primary key default extensions.gen_random_uuid(),
  -- Trimmed length, so "   " is not a name. 80 characters is a heading on a
  -- page rather than a sentence; the sentence is the description.
  name text not null check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 80),
  description text not null default '' check (pg_catalog.length(description) <= 300),
  -- Nullable, and no ON DELETE action: accounts are deactivated in this
  -- application, never removed, and a group outlives whoever started it.
  created_by uuid references public.app_accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.people_groups is
  'A named roster of people from the district directory: a chapter, a committee, a competition team, a cart. Read and edited by every active account; deleted only by an administrator. Written only by the app_*_group functions.';
comment on column public.people_groups.description is
  'One line saying what the group is for. At most 300 characters; clamped rather than refused.';
comment on column public.people_groups.updated_at is
  'When the group last changed, the roster included: adding somebody, removing them or editing their note all move it, because "updated" on the list means "this roster is not the one you saw last week".';

-- One group called "Officers", however it is capitalised. A unique index on
-- lower(name) rather than a citext column: the stored name keeps the capitals
-- somebody typed, and only the comparison folds.
create unique index if not exists people_groups_name_unique
  on public.people_groups (pg_catalog.lower(name));

create table if not exists public.people_group_members (
  group_id uuid not null references public.people_groups (id) on delete cascade,
  -- CASCADE on both sides, and for the same reason: membership is a fact about
  -- a pair. A person who is removed from the directory is not in any roster,
  -- and a group that is gone has no members. Neither is history worth keeping
  -- a dangling row for; the history is in record_events.
  requester_id uuid not null references public.requesters (id) on delete cascade,
  -- "Treasurer", "drives the van", "regionals only". Short on purpose: it is a
  -- label in a table cell, not a place to write a paragraph about somebody.
  note text not null default '' check (pg_catalog.length(note) <= 80),
  added_by uuid references public.app_accounts (id),
  added_at timestamptz not null default now(),
  primary key (group_id, requester_id)
);

comment on table public.people_group_members is
  'Who is in a group, with a short note beside them. The primary key is the pair, so adding somebody twice is not an error anywhere: it is simply already true.';

-- The primary key already answers "who is in this group". This answers the
-- other direction — "which groups is this person in" — which is what a
-- person's record will want.
create index if not exists people_group_members_requester_idx
  on public.people_group_members (requester_id);

-- ---------------------------------------------------------------------------
-- Groups are a sixth thing the record history can be about.
--
-- record_events is the house history, and its entity vocabulary is a CHECK
-- rather than a lookup table, so a new kind of record has to be named here.
-- The entries themselves are written below: one per create, one per delete and
-- one per bulk add, carrying COUNTS and never the names of the people in them.
-- A roster is a list of children; a permanent, append-only, administrator-
-- readable copy of that list is not something to write as a side effect of
-- pressing "Add 31 matches".
-- ---------------------------------------------------------------------------

alter table public.record_events
  drop constraint if exists record_events_entity_type_valid;

alter table public.record_events
  add constraint record_events_entity_type_valid check (
    entity_type in ('requester', 'inventory_device', 'invite', 'import', 'account', 'group')
  );

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- Every group with how many people are in it. There are tens of these, not
-- thousands, so it is one unpaged list ordered the way a person reads it.
create or replace function public.app_list_groups()
returns table (
  id uuid,
  name text,
  description text,
  member_count integer,
  updated_at timestamptz
)
language plpgsql
-- Volatile, like every other directory read here: they all begin by asking
-- app_require_actor(), which takes an advisory lock to serialise against a
-- deactivation, and that is not a stable function's business.
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();

  return query
    select
      g.id,
      g.name,
      g.description,
      (
        select pg_catalog.count(*)::integer
        from public.people_group_members m
        where m.group_id = g.id
      ),
      g.updated_at
    from public.people_groups g
    order by pg_catalog.lower(g.name);
end;
$$;

comment on function public.app_list_groups() is
  'Every group, with its member count, ordered by name. Open to any active account.';

-- Who is in one group, as the table on the group''s page shows them.
--
-- `group_label` is a student''s official class and a member of staff''s
-- department: the same question — where in the school? — asked of two kinds of
-- record, which is exactly how app_find_people already answers it.
create or replace function public.app_group_members(p_group uuid)
returns table (
  requester_id uuid,
  display_name text,
  kind text,
  external_id text,
  email text,
  group_label text,
  note text,
  added_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();

  -- No rows for a group that is not there, rather than a refusal: the page
  -- above this has already decided what to say about a link that has gone
  -- stale, and a read of nothing is not an error.
  return query
    select
      r.id,
      r.display_name,
      r.kind,
      r.external_id,
      r.email,
      nullif(pg_catalog.btrim(coalesce(
        case when r.kind = 'student' then r.official_class else r.department end, '')), ''),
      m.note,
      m.added_at
    from public.people_group_members m
    join public.requesters r on r.id = m.requester_id
    where m.group_id = p_group
    order by pg_catalog.lower(r.display_name), r.id;
end;
$$;

comment on function public.app_group_members(uuid) is
  'The people in one group with their class or department, their note and when they were added, ordered by name. Answers with no rows for a group that does not exist. Open to any active account.';

-- ---------------------------------------------------------------------------
-- Writes
--
-- Shared shape: the actor is re-derived, the text is trimmed and clamped, the
-- group is locked while it is changed, and `updated_at` moves. A name that
-- collides is refused with a sentence rather than with an index name, because
-- "there is already a group called Officers" is something a person can act on
-- and `people_groups_name_unique` is not.
-- ---------------------------------------------------------------------------

create or replace function public.app_create_group(
  p_name text,
  p_description text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_name text;
  v_description text;
  v_id uuid;
begin
  v_actor := public.app_require_actor();

  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'Give the group a name.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_name) > 80 then
    raise exception 'A group name is 80 characters at most.' using errcode = 'check_violation';
  end if;

  -- Clamped rather than refused, like every other free-text field in this
  -- schema: the box stops at 300 while somebody types, so the ceiling here is
  -- a floor under a bug rather than a gate a person can hit.
  v_description := pg_catalog.left(pg_catalog.btrim(coalesce(p_description, '')), 300);

  begin
    insert into public.people_groups (name, description, created_by)
    values (v_name, v_description, v_actor.id)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'There is already a group called %.', v_name
        using errcode = 'check_violation';
  end;

  -- The group's own name, and nothing about anybody in it. There is no member
  -- yet, and there never is one in this entry.
  perform public.app_log_record_event(
    'group', v_id, 'group_created', v_actor.id, 'Group created: ' || v_name
  );

  return v_id;
end;
$$;

comment on function public.app_create_group(text, text) is
  'Starts a group. Any active account may. Refuses an empty name and a name another group already has, clamps the description at 300 characters, and records one history entry naming the group and nobody else.';

create or replace function public.app_update_group(
  p_group uuid,
  p_name text,
  p_description text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_group public.people_groups;
  v_name text;
  v_description text;
begin
  v_actor := public.app_require_actor();

  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'Give the group a name.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_name) > 80 then
    raise exception 'A group name is 80 characters at most.' using errcode = 'check_violation';
  end if;
  v_description := pg_catalog.left(pg_catalog.btrim(coalesce(p_description, '')), 300);

  select * into v_group
  from public.people_groups g
  where g.id = p_group
  for update;

  if not found then
    raise exception 'There is no group with that id.' using errcode = 'check_violation';
  end if;

  -- Saving what is already there is not a change: nothing is written and
  -- `updated_at` keeps naming when the roster last actually moved.
  if v_group.name = v_name and v_group.description = v_description then
    return;
  end if;

  begin
    update public.people_groups g
    set name = v_name,
        description = v_description,
        updated_at = pg_catalog.now()
    where g.id = p_group;
  exception
    when unique_violation then
      raise exception 'There is already a group called %.', v_name
        using errcode = 'check_violation';
  end;
end;
$$;

comment on function public.app_update_group(uuid, text, text) is
  'Renames a group or rewrites its description. Any active account may. Saving an unchanged group writes nothing and leaves updated_at alone.';

create or replace function public.app_delete_group(p_group uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_group public.people_groups;
  v_members integer;
begin
  v_actor := public.app_require_actor();

  -- The one administrator act here. Everything else about a group can be put
  -- back by whoever undid it; the members go with the row, and a roster
  -- somebody spent an afternoon pasting in is not something to lose to a
  -- mis-click on a shared screen.
  if not public.app_is_admin() then
    raise exception 'Only an administrator can delete a group.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_group
  from public.people_groups g
  where g.id = p_group
  for update;

  if not found then
    raise exception 'There is no group with that id.' using errcode = 'check_violation';
  end if;

  select pg_catalog.count(*)::integer into v_members
  from public.people_group_members m
  where m.group_id = p_group;

  delete from public.people_groups g where g.id = p_group;

  -- How many people went with it, never who. The entity is gone, so this entry
  -- is the only record that the group existed at all.
  perform public.app_log_record_event(
    'group',
    p_group,
    'group_deleted',
    v_actor.id,
    'Group deleted: ' || v_group.name,
    v_members || (case when v_members = 1 then ' member' else ' members' end) || ' removed with it.'
  );
end;
$$;

comment on function public.app_delete_group(uuid) is
  'Deletes a group and its membership rows. Administrators only. Records one history entry with the group name and how many people were in it, never who.';

-- ---------------------------------------------------------------------------
-- Membership
-- ---------------------------------------------------------------------------

/*
 * Many people, one round trip, and an honest number back.
 *
 * The screen resolves a pasted column of OSIS numbers, staff ids, emails and
 * names through app_find_people and sends the ids it got. So the arithmetic
 * that matters here is: how many of those were NOT already in the group. That
 * is the number returned, and it is the number the toast says — "Added 28 of
 * 31; the other three were already members" is a true sentence and "Added 31"
 * is not.
 *
 * An id that is not in the directory refuses the WHOLE call rather than being
 * skipped quietly. A caller that has invented an id is a caller whose list is
 * wrong, and half a roster is worse than none.
 */
create or replace function public.app_add_group_members(
  p_group uuid,
  p_requesters uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_group public.people_groups;
  v_unknown integer;
  v_added integer;
begin
  v_actor := public.app_require_actor();

  if p_requesters is null or pg_catalog.array_length(p_requesters, 1) is null then
    raise exception 'Name at least one person to add.' using errcode = 'check_violation';
  end if;
  -- Well above the 200 one app_find_people call answers, so a pasted class
  -- list never meets this, and low enough that one call cannot rewrite the
  -- whole directory into a group.
  if pg_catalog.array_length(p_requesters, 1) > 500 then
    raise exception 'Add at most 500 people at once.' using errcode = 'check_violation';
  end if;

  select * into v_group
  from public.people_groups g
  where g.id = p_group
  for update;

  if not found then
    raise exception 'There is no group with that id.' using errcode = 'check_violation';
  end if;

  select pg_catalog.count(*)::integer into v_unknown
  from (select distinct pg_catalog.unnest(p_requesters) as id) wanted
  where wanted.id is null
     or not exists (select 1 from public.requesters r where r.id = wanted.id);

  if v_unknown > 0 then
    raise exception 'Some of those people are not in the directory. Nothing was added.'
      using errcode = 'check_violation';
  end if;

  insert into public.people_group_members (group_id, requester_id, added_by)
  select p_group, wanted.id, v_actor.id
  from (select distinct pg_catalog.unnest(p_requesters) as id) wanted
  -- Already a member is not an error and not a change. The pair is the key, so
  -- the database says so rather than the caller checking first.
  on conflict (group_id, requester_id) do nothing;

  get diagnostics v_added = row_count;

  if v_added > 0 then
    update public.people_groups g
    set updated_at = pg_catalog.now()
    where g.id = p_group;

    perform public.app_log_record_event(
      'group',
      p_group,
      'group_members_added',
      v_actor.id,
      v_added || (case when v_added = 1 then ' person' else ' people' end)
        || ' added to ' || v_group.name
    );
  end if;

  return v_added;
end;
$$;

comment on function public.app_add_group_members(uuid, uuid[]) is
  'Adds people to a group and returns how many were actually added: people already in it are skipped, and an id that is not in the directory refuses the whole call. At most 500 at once. Records one history entry carrying the count and the group name, never who was added.';

create or replace function public.app_remove_group_member(
  p_group uuid,
  p_requester uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_removed integer;
begin
  v_actor := public.app_require_actor();

  delete from public.people_group_members m
  where m.group_id = p_group
    and m.requester_id = p_requester;

  get diagnostics v_removed = row_count;

  -- Removing somebody who is not in the group is not a failure: the roster
  -- ends up the way the person asked for, which is the whole question. It is
  -- simply not a change either, so nothing is stamped.
  if v_removed > 0 then
    update public.people_groups g
    set updated_at = pg_catalog.now()
    where g.id = p_group;
  end if;
end;
$$;

comment on function public.app_remove_group_member(uuid, uuid) is
  'Takes one person out of a group. Any active account may. Removing somebody who was not in it changes nothing and is not an error.';

create or replace function public.app_set_group_member_note(
  p_group uuid,
  p_requester uuid,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_note text;
  v_changed integer;
begin
  v_actor := public.app_require_actor();

  -- Clamped at the column's own 80, so a paste into the cell is cut rather
  -- than refused with a message about a constraint.
  v_note := pg_catalog.left(pg_catalog.btrim(coalesce(p_note, '')), 80);

  update public.people_group_members m
  set note = v_note
  where m.group_id = p_group
    and m.requester_id = p_requester
    and m.note is distinct from v_note;

  get diagnostics v_changed = row_count;

  if v_changed > 0 then
    update public.people_groups g
    set updated_at = pg_catalog.now()
    where g.id = p_group;
  end if;
end;
$$;

comment on function public.app_set_group_member_note(uuid, uuid, text) is
  'Writes the short note beside one member. Any active account may. Trims and cuts at 80 characters rather than refusing; writing the note that is already there changes nothing.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so both tables are revoked explicitly and then re-granted
-- SELECT only. INSERT, UPDATE and DELETE policies are deliberately absent: the
-- functions above are the one door, which is what keeps the administrator gate
-- on deletion, the name rule and the history entries from being walked around.
-- ---------------------------------------------------------------------------

alter table public.people_groups enable row level security;
alter table public.people_group_members enable row level security;

drop policy if exists people_groups_select_active on public.people_groups;
drop policy if exists people_group_members_select_active on public.people_group_members;

-- The directory is everybody's, and so are its rosters. app_active_account_id()
-- answers NULL for an anonymous, inactive, setup_pending, credential-pending or
-- stale-token caller, so this fails closed.
create policy people_groups_select_active
  on public.people_groups for select to authenticated
  using (public.app_active_account_id() is not null);

create policy people_group_members_select_active
  on public.people_group_members for select to authenticated
  using (public.app_active_account_id() is not null);

revoke all on table
  public.people_groups,
  public.people_group_members
from anon, authenticated;

grant select on table
  public.people_groups,
  public.people_group_members
to authenticated;

revoke execute on function
  public.app_list_groups(),
  public.app_group_members(uuid),
  public.app_create_group(text, text),
  public.app_update_group(uuid, text, text),
  public.app_delete_group(uuid),
  public.app_add_group_members(uuid, uuid[]),
  public.app_remove_group_member(uuid, uuid),
  public.app_set_group_member_note(uuid, uuid, text)
from public, anon;

grant execute on function
  public.app_list_groups(),
  public.app_group_members(uuid),
  public.app_create_group(text, text),
  public.app_update_group(uuid, text, text),
  public.app_delete_group(uuid),
  public.app_add_group_members(uuid, uuid[]),
  public.app_remove_group_member(uuid, uuid),
  public.app_set_group_member_note(uuid, uuid, text)
to authenticated;
