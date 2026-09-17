-- ---------------------------------------------------------------------------
-- Quick tickets: the calls that repeat all day, written down once.
--
-- Three of every ten walk-ins at this desk are the same three calls. A
-- projector that will not show, a Chromebook that will not charge, a room with
-- no Wi-Fi. Each one is typed out again every time: the same title, the same
-- sentence, the same category, the same priority. The only part that is new is
-- who is standing there.
--
-- So the repeated part becomes a row the desk writes once, and filing one of
-- those calls is a tap plus the requester.
--
-- Four decisions are worth stating.
--
--   SHARED, NOT PERSONAL. This is not a per-account convenience like a saved
--   view. The three calls are the school's, they are the same for everybody at
--   the desk, and a preset that each NetRider had to write for themselves would
--   be written by one of them and by nobody else. So the table has no owner
--   column that gates anything: `created_by` is attribution, and any ticket
--   worker may edit or delete any row. That is deliberate and it is the same
--   reasoning as `assistant_notes_shared` — the rules of the house are written
--   by whoever is at the desk when they change.
--
--   TICKET WORKERS ONLY. A skills officer never files a ticket, so a list of
--   ticket shortcuts is not theirs to read or to change. The SELECT policy and
--   both writers ask `app_can_work_tickets()`, which is the same gate the
--   tickets table itself carries.
--
--   THE FUNCTIONS ARE THE ONE DOOR. The table is readable and nothing more. A
--   direct write would walk around the cap, the vocabulary checks, the
--   attribution and the history entry, so there are no INSERT, UPDATE or
--   DELETE policies at all.
--
--   TWELVE. A quick-ticket menu is scanned, not searched: past a dozen rows the
--   fastest way to file the call is to type it, and the menu has become a
--   second queue to maintain. The cap is enforced on insert only, so an edit of
--   an existing row is never refused for a reason the operator cannot act on.
--
-- The history entry names the preset and NOTHING ELSE. `record_events` is
-- append-only and every administrator reads it; the issue text somebody typed
-- is one read away in the table and does not belong duplicated into a log
-- nobody can edit.
--
-- Additive: one table, three functions, three seeded rows.
-- ---------------------------------------------------------------------------

create table public.ticket_presets (
  id uuid primary key default extensions.gen_random_uuid(),
  -- What the menu row says. Short, because it is read in a dropdown beside a
  -- button, not in a table.
  name text not null,
  -- What the ticket's title becomes. The same 120 the intake form stops at.
  title text not null,
  issue text not null default '',
  category text not null,
  priority text not null default 'normal',
  location text not null default '',
  -- The desk's own order, lowest first. Ties break on the name so a list that
  -- has never been ordered is still stable.
  position integer not null default 0,
  -- Attribution, not ownership. NULL for the rows seeded below, which nobody
  -- wrote; NO ACTION on the reference, because an account that wrote a preset
  -- is deactivated in this application rather than deleted.
  created_by uuid references public.app_accounts (id),
  updated_at timestamptz not null default now(),
  constraint ticket_presets_name_length
    check (pg_catalog.length(pg_catalog.btrim(name)) between 1 and 40),
  constraint ticket_presets_title_length
    check (pg_catalog.length(pg_catalog.btrim(title)) between 1 and 120),
  constraint ticket_presets_issue_length check (pg_catalog.length(issue) <= 2000),
  constraint ticket_presets_location_length check (pg_catalog.length(location) <= 80),
  -- The ticket's own vocabularies, restated as the tickets table states them.
  -- A preset that could hold a category no ticket may carry would be a row that
  -- fails at the one moment it is used.
  constraint ticket_presets_category_valid check (
    category in (
      'chromebook', 'laptop_desktop', 'projector_display', 'network',
      'printer', 'account', 'software', 'phone', 'other'
    )
  ),
  constraint ticket_presets_priority_valid check (
    priority in ('low', 'normal', 'high', 'urgent')
  )
);

comment on table public.ticket_presets is
  'The calls that repeat all day, written down once. Shared by the whole desk: every ticket worker reads them and every ticket worker may change them. Written only by app_save_ticket_preset and app_delete_ticket_preset.';
comment on column public.ticket_presets.name is
  'What the quick-ticket menu row says. Unique without regard to case.';
comment on column public.ticket_presets.title is
  'What the new ticket''s title starts as.';
comment on column public.ticket_presets.issue is
  'What the new ticket''s issue starts as. Never copied into the record history.';
comment on column public.ticket_presets.position is
  'The desk''s own order, lowest first, name breaking a tie.';
comment on column public.ticket_presets.created_by is
  'Who first wrote this preset. Attribution only: any ticket worker may edit or delete it.';

-- Two presets whose names differ only in case are two rows nobody can tell
-- apart in a menu.
create unique index ticket_presets_name_unique on public.ticket_presets (pg_catalog.lower(name));

-- The one read there is: the whole list, in the desk's order.
create index ticket_presets_order_idx on public.ticket_presets (position, name);

-- ---------------------------------------------------------------------------
-- Reading them.
--
-- SECURITY INVOKER, so the row policy below is what decides: a skills officer
-- gets an empty list from the same call that gives a NetRider the desk's own.
-- ---------------------------------------------------------------------------

create function public.app_list_ticket_presets()
returns setof public.ticket_presets
language sql
stable
set search_path = ''
as $$
  select p.*
  from public.ticket_presets p
  order by p.position, pg_catalog.lower(p.name), p.id;
$$;

comment on function public.app_list_ticket_presets() is
  'Every quick ticket, in the desk''s order: position first, then name. Empty for an account that does not work tickets.';

-- ---------------------------------------------------------------------------
-- Writing them.
--
-- One function for both halves of the job: a null id inserts, an id updates.
-- A settings form that has to choose between two endpoints is a form with two
-- ways to be wrong, and the validation either one would do is identical.
-- ---------------------------------------------------------------------------

create function public.app_save_ticket_preset(
  p_id uuid default null,
  p_name text default null,
  p_title text default null,
  p_issue text default '',
  p_category text default null,
  p_priority text default 'normal',
  p_location text default '',
  p_position integer default null
)
returns public.ticket_presets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_labels jsonb := public.app_category_labels();
  v_existing public.ticket_presets;
  v_row public.ticket_presets;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_title text := pg_catalog.btrim(coalesce(p_title, ''));
  v_issue text := pg_catalog.btrim(coalesce(p_issue, ''));
  v_category text := pg_catalog.btrim(coalesce(p_category, ''));
  v_priority text := pg_catalog.btrim(pg_catalog.lower(coalesce(p_priority, 'normal')));
  v_location text := pg_catalog.btrim(coalesce(p_location, ''));
  v_position integer;
begin
  v_actor := public.app_require_actor();

  -- Refused out loud rather than answered with nothing: an account that cannot
  -- work tickets has asked for something it will never be given, and a silent
  -- success would leave a settings form claiming it had saved.
  if not public.app_can_work_tickets() then
    raise exception 'Quick tickets belong to the ticket desk. This account does not work tickets.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_name = '' then
    raise exception 'Give the quick ticket a name.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_name) > 40 then
    raise exception 'A quick ticket''s name is 40 characters at most.'
      using errcode = 'check_violation';
  end if;
  if v_title = '' then
    raise exception 'Give the quick ticket a title for the queue.'
      using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_title) > 120 then
    raise exception 'A quick ticket''s title is 120 characters at most.'
      using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_issue) > 2000 then
    raise exception 'A quick ticket''s issue is 2000 characters at most.'
      using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_location) > 80 then
    raise exception 'A quick ticket''s location is 80 characters at most.'
      using errcode = 'check_violation';
  end if;

  -- The ticket's own vocabularies, asked of the same helper app_set_category
  -- asks, so a category that exists here is a category a ticket may carry.
  if not (v_labels ? v_category) then
    raise exception 'Choose a category for this quick ticket.' using errcode = 'check_violation';
  end if;
  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Choose a priority: low, normal, high or urgent.'
      using errcode = 'check_violation';
  end if;

  if p_id is not null then
    select * into v_existing
    from public.ticket_presets p
    where p.id = p_id
    for update;

    if not found then
      raise exception 'That quick ticket is no longer there. The list has been reloaded.'
        using errcode = 'no_data_found';
    end if;
  end if;

  -- Checked here rather than left to the unique index, so the message names the
  -- preset instead of naming a constraint.
  if exists (
    select 1
    from public.ticket_presets p
    where pg_catalog.lower(p.name) = pg_catalog.lower(v_name)
      and (p_id is null or p.id <> p_id)
  ) then
    raise exception 'A quick ticket called % already exists.', v_name
      using errcode = 'unique_violation';
  end if;

  if p_id is null then
    -- The cap applies to adding, never to editing: an operator correcting a
    -- typo on the twelfth row must not be told the list is full.
    if (select pg_catalog.count(*) from public.ticket_presets) >= 12 then
      raise exception 'Twelve quick tickets is the limit. Delete one before adding another.'
        using errcode = 'check_violation';
    end if;

    -- No position given means the end of the list, which is where something
    -- just written belongs until somebody moves it.
    v_position := coalesce(
      p_position,
      (select coalesce(pg_catalog.max(p.position), -1) + 1 from public.ticket_presets p)
    );

    insert into public.ticket_presets (
      name, title, issue, category, priority, location, position, created_by
    )
    values (
      v_name, v_title, v_issue, v_category, v_priority, v_location,
      greatest(0, v_position), v_actor.id
    )
    returning * into v_row;
  else
    v_position := greatest(0, coalesce(p_position, v_existing.position));

    update public.ticket_presets p
    set name = v_name,
        title = v_title,
        issue = v_issue,
        category = v_category,
        priority = v_priority,
        location = v_location,
        position = v_position,
        updated_at = pg_catalog.now()
    where p.id = p_id
    returning * into v_row;
  end if;

  -- The name and nothing else. The issue text stays in the table.
  perform public.app_log_record_event(
    'account',
    v_actor.id,
    'ticket_preset',
    v_actor.id,
    case
      when p_id is null then 'Quick ticket added: ' || v_row.name || '.'
      else 'Quick ticket edited: ' || v_row.name || '.'
    end
  );

  return v_row;
end;
$$;

comment on function public.app_save_ticket_preset(uuid, text, text, text, text, text, text, integer) is
  'Writes one quick ticket, inserting when p_id is null and updating otherwise. Any ticket worker may call it; the list is the desk''s, not one account''s. Refuses a name or title that is empty or too long, a category or priority outside the ticket vocabularies, a duplicate name, and a thirteenth preset. Records the name in the history, never the issue.';

create function public.app_delete_ticket_preset(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_name text;
begin
  v_actor := public.app_require_actor();

  if not public.app_can_work_tickets() then
    raise exception 'Quick tickets belong to the ticket desk. This account does not work tickets.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Any ticket worker, including one who did not write it: it is the desk's
  -- shared list, and a preset nobody may remove but its author is a preset that
  -- outlives the person who left.
  delete from public.ticket_presets p
  where p.id = p_id
  returning p.name into v_name;

  if v_name is null then
    raise exception 'That quick ticket is no longer there. The list has been reloaded.'
      using errcode = 'no_data_found';
  end if;

  perform public.app_log_record_event(
    'account',
    v_actor.id,
    'ticket_preset',
    v_actor.id,
    'Quick ticket deleted: ' || v_name || '.'
  );
end;
$$;

comment on function public.app_delete_ticket_preset(uuid) is
  'Removes one quick ticket. Any ticket worker may call it, whoever wrote it. Records the name in the history.';

-- ---------------------------------------------------------------------------
-- Three to start with.
--
-- The menu exists to save typing, and an empty menu on the first morning saves
-- none: somebody has to guess what it is for before it can be useful. These are
-- the three calls this desk actually takes, and any of them can be edited or
-- deleted from the settings screen like any other.
--
-- `created_by` is NULL: nobody wrote them.
-- ---------------------------------------------------------------------------

insert into public.ticket_presets (name, title, issue, category, priority, location, position)
values
  (
    'Projector',
    'Projector will not display',
    'The projector is on and the screen stays blank.',
    'projector_display',
    'normal',
    '',
    0
  ),
  (
    'Chromebook will not charge',
    'Chromebook will not charge',
    'Plugged in, and the charging light does not come on.',
    'chromebook',
    'normal',
    '',
    1
  ),
  (
    'No Wi-Fi',
    'No Wi-Fi in the room',
    'Nothing in the room can reach the network.',
    'network',
    'normal',
    '',
    2
  );

-- ---------------------------------------------------------------------------
-- Row-level security and grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so the table is revoked explicitly and then re-granted SELECT
-- only. INSERT, UPDATE and DELETE policies are deliberately absent: the two
-- functions above are the one door.
-- ---------------------------------------------------------------------------

alter table public.ticket_presets enable row level security;

create policy ticket_presets_select_workers
  on public.ticket_presets for select to authenticated
  using (public.app_can_work_tickets());

revoke all on table public.ticket_presets from anon, authenticated;

grant select on table public.ticket_presets to authenticated;

revoke execute on function
  public.app_list_ticket_presets(),
  public.app_save_ticket_preset(uuid, text, text, text, text, text, text, integer),
  public.app_delete_ticket_preset(uuid)
from public, anon;

grant execute on function
  public.app_list_ticket_presets(),
  public.app_save_ticket_preset(uuid, text, text, text, text, text, text, integer),
  public.app_delete_ticket_preset(uuid)
to authenticated;
