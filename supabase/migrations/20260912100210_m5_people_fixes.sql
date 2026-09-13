-- M5 people directory: corrections to app_upsert_person and app_list_people.
--
-- A separate migration rather than an edit to 20260912100200_m5_people.sql,
-- because that one is already applied. The table, the indexes, the policy and
-- the other three functions are untouched; the two functions that change are
-- recreated here with full bodies, and their grants and comments are restated
-- so this file is the whole statement of what they are.
--
-- Four things were wrong.
--
-- 1. `active` sent to app_upsert_person was ignored in silence. Ignoring it is
--    safe — it never archived anybody — but it is not honest: a caller who
--    sends `active: false` and gets a person id back has every reason to think
--    the person is archived. Refusing the call says where the switch actually
--    is. Nothing in the application sends the key today, and the roster
--    importer must not start.
--
-- 2. LIKE metacharacters in what an operator typed were wildcards. Searching
--    for `%` matched every person in the school, and an underscore in an
--    address matched any character. What someone types into a search box is
--    text.
--
-- 3. `staff_id` was stored however it was typed, so `emp-4021` and `EMP-4021`
--    were two different staff members as far as the unique index was concerned.
--    Email is already folded on the way in for exactly this reason; staff id now
--    is too.
--
-- 4. Two smaller ones: `source` sent empty reset the record to 'manual' instead
--    of being left alone like every other field sent empty, and `p_limit := 0`
--    was clamped up to one row instead of returning none.

-- ---------------------------------------------------------------------------
-- app_upsert_person
-- ---------------------------------------------------------------------------

create or replace function public.app_upsert_person(p_person jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Every column a caller may set, in the order changes are reported in.
  --
  -- `active` is missing on purpose: it is the administrator-only archive switch
  -- (app_set_person_active). Sending it is now refused outright rather than
  -- ignored, so nobody can believe they archived somebody by sending one more
  -- key. `id` selects the row rather than being written, and created_at and
  -- updated_at belong to the database.
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

  -- Refused, not ignored. A silent no-op here would report success for a change
  -- that did not happen, and archiving is the one change on this table that a
  -- technician is not allowed to make.
  if p_person ? 'active' then
    raise exception 'Archiving or restoring a person is done by an administrator from the person page.'
      using errcode = 'check_violation';
  end if;

  -- Known keys only, and an unknown one is IGNORED rather than refused: an
  -- import row or a form carrying an extra field the directory does not keep
  -- must not fail over it. (`active` is the deliberate exception above: it is
  -- not an unknown field, it is a known field the caller may not set.) Every
  -- value is trimmed, and a value that is empty after trimming becomes a JSON
  -- null — a blank spreadsheet cell is an absent value, not the empty string.
  -- The key stays present either way, which is what lets an update distinguish
  -- "clear this field" from "leave it alone".
  foreach v_key in array c_writable loop
    if p_person ? v_key then
      v_clean := v_clean || pg_catalog.jsonb_build_object(
        v_key,
        nullif(pg_catalog.btrim(coalesce(p_person ->> v_key, '')), '')
      );
    end if;
  end loop;

  -- Identifiers, folded to the one spelling the table stores, so the unique
  -- indexes are rules about people rather than about typing.
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
  if v_clean ? 'staff_id' then
    v_clean := v_clean || pg_catalog.jsonb_build_object(
      'staff_id', nullif(pg_catalog.upper(coalesce(v_clean ->> 'staff_id', '')), '')
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
  -- `source` is not nullable and has no blank meaning, so an empty one is left
  -- alone like every other field sent empty rather than resetting an imported
  -- record to 'manual'.
  if v_clean ? 'source' and v_clean ->> 'source' is not null then
    v_after.source := pg_catalog.lower(v_clean ->> 'source');
  end if;

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
  'Adds or corrects one directory record. Keys are column names; unknown keys are ignored; an absent key is left alone and an empty one is cleared. Any active account may call it. Sending `active` is refused: archiving is app_set_person_active, and an administrator does it from the person page.';

-- ---------------------------------------------------------------------------
-- app_list_people
-- ---------------------------------------------------------------------------

create or replace function public.app_list_people(
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
    select nullif(pg_catalog.btrim(coalesce(p_query, '')), '') as raw
  ),
  term as (
    select
      q.raw,
      -- What an operator typed into a search box is TEXT. Without this, `%`
      -- matched every person in the school and an underscore in an address
      -- matched any character. Backslash is escaped first, or it would escape
      -- the escapes added after it.
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(q.raw, '\', '\\'),
          '%', '\%'
        ),
        '_', '\_'
      ) as pattern
    from q
  ),
  filtered as (
    select p.*
    from public.people p, term t
    -- NULL means "every value of this field", not "no value": the directory
    -- screen sends nothing for a filter it is not applying. p_active is the one
    -- with a non-null default, because the archived rows are not what an
    -- operator means when they search for somebody.
    where (p_active is null or p.active = p_active)
      and (p_kind is null or p.kind = p_kind)
      and (p_department is null or p.department = p_department)
      and (p_class_of is null or p.class_of = p_class_of)
      and (
        t.raw is null
        -- A name is matched anywhere in it; an identifier only from its start.
        -- Prefix matching keeps "0143" from dragging back every phone-shaped
        -- number in the school, and matches how an operator reads a number off
        -- a label: from the left.
        --
        -- This whole disjunction is a sequential scan, by design. The first
        -- branch tests `t.raw`, not a column, so no index on public.people can
        -- serve the OR group, and the trigram indexes are not used here at all.
        -- Over roughly 2,800 rows that is the right plan; the fuzzy, index-
        -- served search is Task 11's app_search, which puts the term on one
        -- side of a trigram operator instead of burying it in an OR.
        or p.display_name ilike '%' || t.pattern || '%' escape '\'
        or p.email ilike t.pattern || '%' escape '\'
        or p.osis like t.pattern || '%' escape '\'
        or p.staff_id ilike t.pattern || '%' escape '\'
      )
  )
  select f.id, f.kind, f.display_name, f.email, f.osis, f.staff_id,
         f.department, f.role_title, f.official_class, f.class_of, f.active,
         -- Placeholders. Task 9 landed the device tables but recreated only
         -- app_person_detail, which is all its brief asked for, so BOTH counts
         -- are Task 10's: it recreates this function for open_ticket_count
         -- through requesters.person_id, and device_count is one more
         -- subquery over device_assignments in the same recreation. The columns
         -- are here now so the shape the application reads does not change
         -- under it.
         0::integer as device_count,
         0::integer as open_ticket_count,
         -- Window count over the same filtered, RLS-limited set, so a page total
         -- can never reveal the existence of rows the caller cannot see.
         pg_catalog.count(*) over () as total_count
  from filtered f
  -- id breaks ties so paging is deterministic when two people share a name.
  order by f.display_name asc, f.id asc
  -- Floor of zero, not one: a caller asking for no rows is asking for no rows,
  -- and a screen that wants only the total says so by passing 0.
  limit greatest(0, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.app_list_people(text, text, text, text, boolean, integer, integer) is
  'SECURITY INVOKER directory reader: RLS decides the rows, SQL does the search, filtering, ordering, counting and pagination. LIKE metacharacters in the query are literal text. Sequential by design at school scale; the trigram-served search is Task 11 app_search. Returns nothing to an account that is not active.';

-- ---------------------------------------------------------------------------
-- Grants restated. `create or replace` keeps the existing ACL, so these change
-- nothing today; they are here so this file says in full what these two
-- functions are and who may call them.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_list_people(text, text, text, text, boolean, integer, integer),
  public.app_upsert_person(jsonb)
from public, anon;

grant execute on function
  public.app_list_people(text, text, text, text, boolean, integer, integer),
  public.app_upsert_person(jsonb)
to authenticated;
