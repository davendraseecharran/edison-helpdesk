-- M5: the people directory.
--
-- The roster of roughly 2,500 students and 300 staff, imported from the school's
-- AppSheet spreadsheet. Everything later in M5 hangs off it: a device is
-- assigned to a person, a ticket requester resolves to a person, the lookup bar
-- searches it, and the importer writes it.
--
-- Additive only, and every earlier rule stays in force: identity is auth.uid()
-- only, clients get SELECT and nothing else, every write goes through a SECURITY
-- DEFINER RPC that re-derives the actor inside the database, and history is
-- append-only.
--
-- Two things about this table are different in kind from the ticket tables, and
-- they shape the decisions below.
--
-- It is a list of children. Home addresses, parents' names and parents' phone
-- numbers live in these columns. So:
--   * reading it requires an ACTIVE account — an account awaiting setup,
--     awaiting an access decision, denied or deactivated sees an empty
--     directory, enforced by the row policy rather than by the application;
--   * record events name the FIELDS that changed and never the values. Person
--     history is readable by every technician, and writing "home_phone:
--     212-555-0143 -> 212-555-0198" into it would publish the very thing the
--     directory is careful about.
--
-- It is a mirror of a spreadsheet. Identifiers arrive with thousands
-- separators, stray padding and inconsistent case, and a cell that is visually
-- empty is the empty string rather than a missing value. app_upsert_person
-- therefore normalises before it validates, and a collision on an identifier is
-- reported in words an operator can act on rather than as an index name.
--
-- Who may do what. Keeping the roster right is ordinary helpdesk work, so ANY
-- active account may add or correct a person. Archiving a record is not: it
-- decides who can still be picked as a requester, so app_set_person_active is
-- administrators only — and `active` is deliberately absent from the set of
-- columns app_upsert_person will write, because accepting it there would hand
-- every technician the administrator's switch under another name. (As of
-- 20260912100210_m5_people_fixes.sql, sending the key is refused outright
-- rather than ignored: a silent no-op reports success for a change that did not
-- happen.)

-- Trigram support for the lookup bar Task 11 builds. Note what it is NOT for:
-- app_list_people below does not use a trigram index and cannot, because its
-- search is one OR group whose first branch tests the search term rather than a
-- column. That function sequential-scans by design (see the note on it), which
-- over roughly 2,800 rows is the right plan. The index-served search is Task
-- 11's app_search, which puts the term on one side of a trigram operator.
--
-- Supabase keeps extensions out of `public`, so both the extension and its
-- operator classes are schema-qualified.
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- The directory
-- ---------------------------------------------------------------------------

create table public.people (
  id uuid primary key default extensions.gen_random_uuid(),
  kind text not null check (kind in ('student','staff')),
  -- Defaulted rather than nullable: the spreadsheet has one-name records, and a
  -- missing half of a name is an empty half, not an unknown one.
  first_name text not null default '',
  last_name text not null default '',
  display_name text not null,
  -- Stored already folded, so the unique index below is a real uniqueness rule
  -- and not one that two spellings of the same address can slip past.
  email text check (email is null or email = lower(btrim(email))),
  osis text check (osis is null or osis ~ '^[0-9]{6,12}$'),
  staff_id text,
  school_dbn text,
  department text,
  role_title text,
  official_class text,
  class_of text,
  parent_name text,
  parent_phone text,
  home_phone text,
  address text,
  notes text,
  -- Archived rather than deleted. A person who has left still appears on the
  -- tickets and device assignments that name them, so the row has to survive.
  active boolean not null default true,
  source text not null default 'manual' check (source in ('manual','import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.people is
  'The school directory: students and staff. Holds home addresses and parents'' contact details, so it is readable by active accounts only and never writable from a session.';
comment on column public.people.display_name is
  'The name shown everywhere. Derived from first and last name when the caller does not supply one.';
comment on column public.people.email is
  'Lower-cased and trimmed on the way in, so uniqueness is by address rather than by spelling.';
comment on column public.people.osis is
  'New York student identifier, digits only. Separators and padding from the source spreadsheet are stripped before this check applies.';
comment on column public.people.active is
  'False archives the record: it leaves the default directory listing but stays attached to its tickets and devices. Only app_set_person_active changes it.';
comment on column public.people.source is
  'Whether this row was typed in by a technician or came from a roster import.';

-- Identifiers are unique WHERE PRESENT: most staff have no OSIS and most
-- students have no staff id, and a partial unique index lets any number of rows
-- leave one blank while still refusing two rows that claim the same one.
create unique index people_osis_idx on public.people (osis) where osis is not null;
create unique index people_staff_id_idx on public.people (staff_id) where staff_id is not null;
create unique index people_email_idx on public.people (email) where email is not null;

-- For Task 11's app_search, not for app_list_people. Neither index below is
-- reachable from app_list_people's predicates, and saying otherwise would send
-- the next person looking for a plan that cannot exist.
--
--   people_display_name_trgm is usable by any predicate that puts the term on
--   one side of a trigram operator against the column itself:
--     where p.display_name % p_query
--     order by extensions.similarity(p.display_name, p_query) desc
--
--   people_search_trgm is kept on the same terms, and is usable ONLY by a
--   predicate written over the identical expression, verbatim:
--     where (coalesce(p.email,'') || ' ' || coalesce(p.osis,'') || ' ' ||
--            coalesce(p.staff_id,'')) % p_query
--   which is what lets the lookup bar find somebody from the middle of an OSIS
--   or a staff id rather than only from its start. If Task 11 does not write it
--   that way, this index serves nothing and should be dropped there.
create index people_display_name_trgm
  on public.people using gin (display_name extensions.gin_trgm_ops);
create index people_search_trgm
  on public.people using gin (
    (coalesce(email,'') || ' ' || coalesce(osis,'') || ' ' || coalesce(staff_id,''))
    extensions.gin_trgm_ops
  );

-- The two filters the directory screen offers, over the rows it shows by
-- default. Partial on `active` because the archived rows are never the ones
-- being filtered.
create index people_department_idx on public.people (department) where active;
create index people_class_of_idx on public.people (class_of) where active;

-- ---------------------------------------------------------------------------
-- Reads. SECURITY INVOKER (the default) on purpose: they run with the caller's
-- privileges, so the row policy below decides which rows they can return and
-- nothing here can hand out a person the caller is not allowed to see.
-- ---------------------------------------------------------------------------

-- Superseded by 20260912100210_m5_people_fixes.sql, which recreates this
-- function so LIKE metacharacters in the query are literal text and p_limit 0
-- returns no rows. Read that file for the current body.
create function public.app_list_people(
  p_query text default null,
  p_kind text default null,
  p_department text default null,
  p_class_of text default null,
  p_active boolean default true,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  kind text,
  display_name text,
  email text,
  osis text,
  staff_id text,
  department text,
  role_title text,
  official_class text,
  class_of text,
  active boolean,
  device_count integer,
  open_ticket_count integer,
  total_count bigint
)
language sql
stable
set search_path = ''
as $$
  with q as (
    select nullif(pg_catalog.btrim(coalesce(p_query, '')), '') as term
  ),
  filtered as (
    select p.*
    from public.people p, q
    -- NULL means "every value of this field", not "no value": the directory
    -- screen sends nothing for a filter it is not applying. p_active is the one
    -- with a non-null default, because the archived rows are not what an
    -- operator means when they search for somebody.
    where (p_active is null or p.active = p_active)
      and (p_kind is null or p.kind = p_kind)
      and (p_department is null or p.department = p_department)
      and (p_class_of is null or p.class_of = p_class_of)
      and (
        q.term is null
        -- A name is matched anywhere in it; an identifier only from its start.
        -- Prefix matching keeps "0143" from dragging back every phone-shaped
        -- number in the school, and matches how an operator reads a number off
        -- a label: from the left.
        or p.display_name ilike '%' || q.term || '%'
        or p.email ilike q.term || '%'
        or p.osis like q.term || '%'
        or p.staff_id ilike q.term || '%'
      )
  )
  select f.id, f.kind, f.display_name, f.email, f.osis, f.staff_id,
         f.department, f.role_title, f.official_class, f.class_of, f.active,
         -- Placeholders. Task 9 recreates this function counting device
         -- assignments, and Task 10 counts open tickets through
         -- requesters.person_id, which does not exist yet. The columns are here
         -- now so the shape the application reads does not change under it.
         0::integer as device_count,
         0::integer as open_ticket_count,
         -- Window count over the same filtered, RLS-limited set, so a page total
         -- can never reveal the existence of rows the caller cannot see.
         pg_catalog.count(*) over () as total_count
  from filtered f
  -- id breaks ties so paging is deterministic when two people share a name.
  order by f.display_name asc, f.id asc
  limit greatest(1, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.app_list_people(text, text, text, text, boolean, integer, integer) is
  'SECURITY INVOKER directory reader: RLS decides the rows, SQL does the search, filtering, ordering, counting and pagination. Returns nothing to an account that is not active.';

-- One person with everything the detail view renders, still under RLS.
--
-- Task 9 recreates this function with the device_assignments join, and Task 10
-- adds requesters.person_id and fills in the tickets list. Until then both are
-- present and EMPTY rather than absent, so the application reads one shape
-- throughout M5 and the later migrations change what is in the arrays rather
-- than whether they exist.
create function public.app_person_detail(p_person uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'person', pg_catalog.to_jsonb(p),
    'devices', '[]'::jsonb,
    'tickets', '[]'::jsonb,
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) order by e.at, e.id)
      from public.record_events e
      where e.entity_type = 'person' and e.entity_id = p.id
    ), '[]'::jsonb)
  )
  from public.people p
  where p.id = p_person;
$$;

comment on function public.app_person_detail(uuid) is
  'One directory record with its history. NULL when there is no such person or the caller may not see them. devices and tickets are empty until Task 9 and Task 10 recreate this function.';

-- The filter options the directory screen offers. Taken from the ACTIVE rows
-- only: offering a department that exists solely on archived records is offering
-- a filter that returns nothing.
create function public.app_people_facets()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'departments', coalesce((
      select pg_catalog.jsonb_agg(d.department order by d.department)
      from (
        select distinct p.department
        from public.people p
        where p.active and p.department is not null
      ) d
    ), '[]'::jsonb),
    'class_years', coalesce((
      select pg_catalog.jsonb_agg(c.class_of order by c.class_of)
      from (
        select distinct p.class_of
        from public.people p
        where p.active and p.class_of is not null
      ) c
    ), '[]'::jsonb)
  );
$$;

comment on function public.app_people_facets() is
  'Sorted, distinct departments and class years across the active directory. Empty for an account that is not active, because RLS hides every row from it.';

-- ---------------------------------------------------------------------------
-- Writes. SECURITY DEFINER, actor re-derived inside the database.
-- ---------------------------------------------------------------------------

-- Superseded by 20260912100210_m5_people_fixes.sql, which recreates this
-- function so a sent `active` key is refused rather than ignored, staff_id is
-- upper-cased on the way in, and an empty `source` is left alone. Read that
-- file for the current body.
create function public.app_upsert_person(p_person jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Every column a caller may set, in the order changes are reported in.
  --
  -- `active` is missing on purpose: it is the administrator-only archive switch
  -- (app_set_person_active), and accepting it here would let any technician
  -- throw it by sending one more key. `id` selects the row rather than being
  -- written, and created_at/updated_at belong to the database.
  c_writable constant text[] := array[
    'kind', 'first_name', 'last_name', 'display_name', 'email', 'osis',
    'staff_id', 'school_dbn', 'department', 'role_title', 'official_class',
    'class_of', 'parent_name', 'parent_phone', 'home_phone', 'address',
    'notes', 'source'
  ];
  v_actor public.app_accounts;
  v_key text;
  v_clean jsonb := '{}'::jsonb;
  v_before public.people;
  v_after public.people;
  v_changed text[] := '{}'::text[];
  v_is_insert boolean;
  v_id uuid;
  v_constraint text;
begin
  v_actor := public.app_require_actor();

  if p_person is null or pg_catalog.jsonb_typeof(p_person) <> 'object' then
    raise exception 'Send the person''s details as an object of fields.'
      using errcode = 'check_violation';
  end if;

  -- Known keys only, and an unknown one is IGNORED rather than refused: an
  -- import row or a form carrying an extra field the directory does not keep
  -- must not fail over it. Every value is trimmed, and a value that is empty
  -- after trimming becomes a JSON null — a blank spreadsheet cell is an absent
  -- value, not the empty string. The key stays present either way, which is
  -- what lets an update distinguish "clear this field" from "leave it alone".
  foreach v_key in array c_writable loop
    if p_person ? v_key then
      v_clean := v_clean || pg_catalog.jsonb_build_object(
        v_key,
        nullif(pg_catalog.btrim(coalesce(p_person ->> v_key, '')), '')
      );
    end if;
  end loop;

  -- Identifiers, folded to the one spelling the table stores.
  if v_clean ? 'kind' then
    v_clean := v_clean || pg_catalog.jsonb_build_object(
      'kind', pg_catalog.lower(coalesce(v_clean ->> 'kind', ''))
    );
  end if;
  if v_clean ? 'email' then
    v_clean := v_clean || pg_catalog.jsonb_build_object(
      'email', nullif(pg_catalog.lower(coalesce(v_clean ->> 'email', '')), '')
    );
  end if;
  if v_clean ? 'osis' then
    -- The source spreadsheet hands back "240,000,123" and "240 000 123".
    -- Separators are stripped; anything else that is left over is rejected
    -- below with a message rather than silently deleted.
    v_clean := v_clean || pg_catalog.jsonb_build_object(
      'osis',
      nullif(pg_catalog.regexp_replace(coalesce(v_clean ->> 'osis', ''), '[,[:space:]]', '', 'g'), '')
    );
  end if;

  -- An id selects an existing record; its absence means a new one.
  if nullif(pg_catalog.btrim(coalesce(p_person ->> 'id', '')), '') is not null then
    if not pg_catalog.pg_input_is_valid(p_person ->> 'id', 'uuid') then
      raise exception 'That is not a directory record id.' using errcode = 'check_violation';
    end if;
    v_id := (p_person ->> 'id')::uuid;
  end if;
  v_is_insert := v_id is null;

  if v_is_insert then
    -- The row a new person starts from: the table's own defaults, so the
    -- change list below reports what the caller actually supplied.
    v_before.id := extensions.gen_random_uuid();
    v_before.first_name := '';
    v_before.last_name := '';
    v_before.display_name := '';
    v_before.active := true;
    v_before.source := 'manual';
  else
    -- SECURITY DEFINER, so this read is not under RLS. That is deliberate and
    -- safe: app_require_actor above has already established an active account,
    -- and an active account may read every person anyway.
    select * into v_before from public.people p where p.id = v_id;
    if not found then
      raise exception 'That person is not in the directory. Search for them again.'
        using errcode = 'no_data_found';
    end if;
  end if;

  -- Merge: a key that was not sent keeps the value it had.
  v_after := v_before;
  if v_clean ? 'kind' then v_after.kind := v_clean ->> 'kind'; end if;
  if v_clean ? 'first_name' then v_after.first_name := coalesce(v_clean ->> 'first_name', ''); end if;
  if v_clean ? 'last_name' then v_after.last_name := coalesce(v_clean ->> 'last_name', ''); end if;
  if v_clean ? 'display_name' then v_after.display_name := coalesce(v_clean ->> 'display_name', ''); end if;
  if v_clean ? 'email' then v_after.email := v_clean ->> 'email'; end if;
  if v_clean ? 'osis' then v_after.osis := v_clean ->> 'osis'; end if;
  if v_clean ? 'staff_id' then v_after.staff_id := v_clean ->> 'staff_id'; end if;
  if v_clean ? 'school_dbn' then v_after.school_dbn := v_clean ->> 'school_dbn'; end if;
  if v_clean ? 'department' then v_after.department := v_clean ->> 'department'; end if;
  if v_clean ? 'role_title' then v_after.role_title := v_clean ->> 'role_title'; end if;
  if v_clean ? 'official_class' then v_after.official_class := v_clean ->> 'official_class'; end if;
  if v_clean ? 'class_of' then v_after.class_of := v_clean ->> 'class_of'; end if;
  if v_clean ? 'parent_name' then v_after.parent_name := v_clean ->> 'parent_name'; end if;
  if v_clean ? 'parent_phone' then v_after.parent_phone := v_clean ->> 'parent_phone'; end if;
  if v_clean ? 'home_phone' then v_after.home_phone := v_clean ->> 'home_phone'; end if;
  if v_clean ? 'address' then v_after.address := v_clean ->> 'address'; end if;
  if v_clean ? 'notes' then v_after.notes := v_clean ->> 'notes'; end if;
  if v_clean ? 'source' then v_after.source := coalesce(v_clean ->> 'source', 'manual'); end if;

  -- A blank display name is rebuilt from the halves of the name, so the
  -- spreadsheet's two columns and the application's one column agree.
  if pg_catalog.btrim(coalesce(v_after.display_name, '')) = '' then
    v_after.display_name := pg_catalog.btrim(v_after.first_name || ' ' || v_after.last_name);
  end if;

  -- Validation, in the order an operator would notice the problem. Each message
  -- says what is wrong and what to do; the column checks behind them are the
  -- backstop, not the thing the operator is meant to read.
  if v_after.kind is null or v_after.kind not in ('student', 'staff') then
    raise exception 'Choose whether this person is a student or staff.'
      using errcode = 'check_violation';
  end if;
  if pg_catalog.btrim(v_after.display_name) = '' then
    raise exception 'Enter this person''s name.' using errcode = 'check_violation';
  end if;
  if v_after.osis is not null and v_after.osis !~ '^[0-9]{6,12}$' then
    raise exception 'An OSIS number is 6 to 12 digits. Check "%" and enter it again.', v_after.osis
      using errcode = 'check_violation';
  end if;
  if v_after.email is not null and v_after.email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Enter a valid email address, or leave the address blank.'
      using errcode = 'check_violation';
  end if;
  if v_after.source not in ('manual', 'import') then
    raise exception 'A directory record is either entered by hand or imported.'
      using errcode = 'check_violation';
  end if;

  -- What actually changed, by FIELD NAME. Compared through jsonb so the list
  -- cannot drift out of step with c_writable, and ordered by c_writable so the
  -- history reads the same way every time.
  select coalesce(pg_catalog.array_agg(w.key order by w.ord), '{}'::text[])
  into v_changed
  from pg_catalog.unnest(c_writable) with ordinality as w(key, ord)
  where (pg_catalog.to_jsonb(v_before) ->> w.key)
    is distinct from (pg_catalog.to_jsonb(v_after) ->> w.key);

  -- An update that changes nothing is a no-op: it neither touches the row nor
  -- writes a history entry saying that nothing happened.
  if not v_is_insert and pg_catalog.cardinality(v_changed) = 0 then
    return v_id;
  end if;

  if v_is_insert then
    insert into public.people (
      id, kind, first_name, last_name, display_name, email, osis, staff_id,
      school_dbn, department, role_title, official_class, class_of,
      parent_name, parent_phone, home_phone, address, notes, source
    ) values (
      v_before.id, v_after.kind, v_after.first_name, v_after.last_name,
      v_after.display_name, v_after.email, v_after.osis, v_after.staff_id,
      v_after.school_dbn, v_after.department, v_after.role_title,
      v_after.official_class, v_after.class_of, v_after.parent_name,
      v_after.parent_phone, v_after.home_phone, v_after.address, v_after.notes,
      v_after.source
    );
    v_id := v_before.id;
  else
    update public.people p set
      kind = v_after.kind,
      first_name = v_after.first_name,
      last_name = v_after.last_name,
      display_name = v_after.display_name,
      email = v_after.email,
      osis = v_after.osis,
      staff_id = v_after.staff_id,
      school_dbn = v_after.school_dbn,
      department = v_after.department,
      role_title = v_after.role_title,
      official_class = v_after.official_class,
      class_of = v_after.class_of,
      parent_name = v_after.parent_name,
      parent_phone = v_after.parent_phone,
      home_phone = v_after.home_phone,
      address = v_after.address,
      notes = v_after.notes,
      source = v_after.source,
      updated_at = pg_catalog.now()
    where p.id = v_id;
  end if;

  perform public.app_log_record_event(
    'person',
    v_id,
    case when v_is_insert then 'created' else 'updated' end,
    v_actor.id,
    case
      when v_is_insert then 'Added ' || v_after.display_name || ' to the directory.'
      else 'Updated ' || v_after.display_name || '.'
    end,
    -- Field names, never values. This history is readable by every technician,
    -- and the fields include home addresses and parents' phone numbers.
    pg_catalog.array_to_string(v_changed, ', ')
  );

  return v_id;

exception
  -- The three identifier indexes are the ones an operator collides with, and
  -- "duplicate key value violates unique constraint people_osis_idx" tells them
  -- nothing they can act on.
  when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'people_osis_idx' then
      raise exception 'Another person already has OSIS %. Search for it to see whose record that is.',
        v_after.osis using errcode = 'unique_violation';
    elsif v_constraint = 'people_email_idx' then
      raise exception 'Another person already has the address %. Search for it to see whose record that is.',
        v_after.email using errcode = 'unique_violation';
    elsif v_constraint = 'people_staff_id_idx' then
      raise exception 'Another person already has staff id %. Search for it to see whose record that is.',
        v_after.staff_id using errcode = 'unique_violation';
    else
      raise;
    end if;
end;
$$;

comment on function public.app_upsert_person(jsonb) is
  'Adds or corrects one directory record. Keys are column names; unknown keys are ignored; an absent key is left alone and an empty one is cleared. Any active account may call it. Never writes `active`: archiving is app_set_person_active.';

-- Archiving decides who can still be chosen as a requester or a device holder,
-- so it is an administrator's decision rather than part of ordinary upkeep.
create function public.app_set_person_active(p_person uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_person public.people;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can archive or restore a directory record. Ask an administrator.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_active is null then
    raise exception 'Say whether this person should be active.' using errcode = 'check_violation';
  end if;

  update public.people p
  set active = p_active, updated_at = pg_catalog.now()
  where p.id = p_person
    and p.active is distinct from p_active
  returning p.* into v_person;

  if not found then
    if not exists (select 1 from public.people p where p.id = p_person) then
      raise exception 'That person is not in the directory. Search for them again.'
        using errcode = 'no_data_found';
    end if;
    -- Already in the requested state. Nothing changed, so nothing is recorded.
    return;
  end if;

  perform public.app_log_record_event(
    'person',
    v_person.id,
    case when p_active then 'reactivated' else 'deactivated' end,
    v_actor.id,
    case
      when p_active then 'Restored ' || v_person.display_name || ' to the directory.'
      else 'Archived ' || v_person.display_name || ' in the directory.'
    end
  );
end;
$$;

comment on function public.app_set_person_active(uuid, boolean) is
  'Archives or restores one directory record. Administrator session only. The row is never deleted: it stays attached to the tickets and devices that name it.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.people enable row level security;

-- app_active_account_id() returns NULL for an anonymous, inactive,
-- setup_pending, pending_approval, denied, credential-pending or stale-token
-- caller, so the directory is invisible to all of them and the check fails
-- closed rather than open.
create policy people_select_active
  on public.people for select to authenticated
  using (public.app_active_account_id() is not null);

-- Deliberately absent: INSERT, UPDATE and DELETE policies. The directory is
-- written by the two RPCs above and by nothing else, so every change to it is
-- attributed and recorded. Deletion has no path at all: a person who has left
-- is archived, because their tickets and device assignments still name them.

-- ---------------------------------------------------------------------------
-- Grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so the table is revoked explicitly and then re-granted
-- read-only. anon gets nothing at all.
-- ---------------------------------------------------------------------------

revoke all on table public.people from anon, authenticated;
grant select on table public.people to authenticated;

revoke execute on function
  public.app_list_people(text, text, text, text, boolean, integer, integer),
  public.app_person_detail(uuid),
  public.app_people_facets(),
  public.app_upsert_person(jsonb),
  public.app_set_person_active(uuid, boolean)
from public, anon;

grant execute on function
  public.app_list_people(text, text, text, text, boolean, integer, integer),
  public.app_person_detail(uuid),
  public.app_people_facets(),
  public.app_upsert_person(jsonb),
  public.app_set_person_active(uuid, boolean)
to authenticated;
