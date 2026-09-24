-- Screens that notice a colleague's change.
--
-- One row per area of the desk — tickets, inventory, directory, groups, forms,
-- workflows — whose version moves on every statement that writes to a table in
-- that area. Open screens subscribe to updates of this small table over
-- Realtime (the same transport the phone scanner's relay uses) and refresh
-- themselves a moment after a version they care about moves; a slow poll of
-- the same rows covers a dropped socket.
--
-- What a subscriber learns is only that an area changed and when: no row,
-- no id, no name. The table is readable by any active account and writable by
-- nobody but the triggers below, which are SECURITY DEFINER for that reason.
-- Statement-level triggers, so a bulk import of two hundred rows moves the
-- version once, not two hundred times.
--
-- Realtime applies row-level security to UPDATE changes, which is the only
-- change this table ever has after its seed; nothing is ever deleted from it.

create table public.app_change_stamps (
  area text primary key,
  version bigint not null default 0,
  changed_at timestamptz not null default now(),
  constraint app_change_stamps_area_valid check (
    area in ('tickets', 'inventory', 'directory', 'groups', 'forms', 'workflows')
  )
);

comment on table public.app_change_stamps is
  'One row per area of the desk; the version moves on every write to that area (statement-level triggers). Open screens watch it over Realtime to refresh on a colleague''s change. Carries no record data.';

insert into public.app_change_stamps (area)
values ('tickets'), ('inventory'), ('directory'), ('groups'), ('forms'), ('workflows');

alter table public.app_change_stamps enable row level security;

create policy app_change_stamps_select_active on public.app_change_stamps
  for select to authenticated
  using (public.app_active_account_id() is not null);

revoke all on table public.app_change_stamps from public, anon, authenticated;
grant select on table public.app_change_stamps to authenticated;

create function public.app_touch_change_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- SKIP LOCKED: a writer never waits on, or deadlocks with, another writer
  -- in the same area. If the row is held, that transaction's own bump is
  -- about to announce the area anyway, and subscribers refresh a moment
  -- after the announcement, by which time this one has usually committed.
  update public.app_change_stamps s
  set version = s.version + 1,
      changed_at = now()
  where s.area = (
    select l.area
    from public.app_change_stamps l
    where l.area = tg_argv[0]
    for update skip locked
  );
  return null;
end;
$$;

comment on function public.app_touch_change_stamp() is
  'Statement-level trigger: moves the version of the area named in its argument, skipping a row another transaction holds (never waits, never deadlocks). SECURITY DEFINER so a writer needs no grant on app_change_stamps.';

revoke all on function public.app_touch_change_stamp() from public, anon, authenticated;

do $$
declare
  pair text[];
begin
  foreach pair slice 1 in array array[
    array['tickets', 'tickets'],
    array['ticket_collaborators', 'tickets'],
    array['ticket_devices', 'tickets'],
    array['notes', 'tickets'],
    array['work_logs', 'tickets'],
    array['inventory_devices', 'inventory'],
    array['requesters', 'directory'],
    array['people_groups', 'groups'],
    array['people_group_members', 'groups'],
    array['group_events', 'groups'],
    array['group_attendance', 'groups'],
    array['group_fields', 'groups'],
    array['group_field_marks', 'groups'],
    array['forms', 'forms'],
    array['form_responses', 'forms'],
    array['workflow_runs', 'workflows'],
    array['workflow_shortcuts', 'workflows']
  ]
  loop
    execute pg_catalog.format(
      'create trigger app_change_stamp after insert or update or delete on public.%I '
      'for each statement execute function public.app_touch_change_stamp(%L)',
      pair[1],
      pair[2]
    );
  end loop;
end;
$$;

-- Published for Realtime when the publication exists (a local stack with
-- Realtime off has none), and only once.
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_change_stamps'
  ) then
    execute 'alter publication supabase_realtime add table public.app_change_stamps';
  end if;
end;
$$;
