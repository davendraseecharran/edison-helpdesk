-- ---------------------------------------------------------------------------
-- Responses from a Google Sheet, taken into a form.
--
-- A chapter moving to these forms has a term of answers already sitting in
-- the Google Sheet behind its old Google Form. This takes those rows in: the
-- page reads the paste, maps each column to a question, and sends the rows
-- here two hundred at a time.
--
-- WHO ANSWERED. Each row may carry an email, an OSIS (or staff id) and a name,
-- from whichever columns the sheet had. They are tried in that order of
-- trust — the id, then the email, then the name — and the first that names
-- exactly one person in the directory decides. A name is folded exactly as
-- self check-in folds one (`app_checkin_fold`). A row that names nobody, or
-- more than one person, is still taken, unmatched, the way an answer to an
-- "anyone" form is.
--
-- THE SAME ROW TWICE IS ONE ROW. A matched person has one response per form
-- (`form_responses_one_per_person`), so a second import of the same sheet
-- finds theirs and skips it; a newer row for them replaces an older one, and
-- an older row never replaces a newer answer. An unmatched row is skipped
-- when a response with the same answers and the same time is already there.
--
-- WHAT A ROW DOES. The same as a response through the link: a matched person
-- joins the form's linked group and is marked present at its linked event
-- (`app_form_record_response`). The time on the sheet is kept as the time it
-- was sent. A question the form now requires is not required of a row sent
-- before the question existed, so requiredness is not enforced here; every
-- other check (a choice is one of the choices, a date is a real date) is.
--
-- `via` gains a third value, 'import', so the responses table can say where a
-- row came from.
-- ---------------------------------------------------------------------------

alter table public.form_responses
  drop constraint if exists form_responses_via_check;

alter table public.form_responses
  add constraint form_responses_via_check check (via in ('link', 'kiosk', 'import'));

-- ---------------------------------------------------------------------------
-- Internal: who a row names.
-- ---------------------------------------------------------------------------

/*
 * {state: 'match', id} | {state: 'none'} | {state: 'ambiguous'}
 *
 * The id first, then the email, then the name. An identifier that names more
 * than one person is ambiguous and stops there rather than falling through to
 * a weaker one.
 */
create or replace function public.app_form_import_match(p_email text, p_external_id text, p_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id text := public.app_checkin_fold_id(p_external_id);
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_name text := public.app_checkin_fold(p_name);
  v_count integer;
  v_match uuid;
begin
  if v_id <> '' and pg_catalog.length(v_id) <= 80 then
    select pg_catalog.count(*)::integer, (pg_catalog.array_agg(r.id))[1]
    into v_count, v_match
    from public.requesters r
    where r.kind in ('student', 'staff')
      and public.app_checkin_fold_id(r.external_id) = v_id;
    if v_count = 1 then
      return pg_catalog.jsonb_build_object('state', 'match', 'id', v_match);
    elsif v_count > 1 then
      return pg_catalog.jsonb_build_object('state', 'ambiguous');
    end if;
  end if;

  if v_email <> '' and pg_catalog.length(v_email) <= 320 then
    select pg_catalog.count(*)::integer, (pg_catalog.array_agg(r.id))[1]
    into v_count, v_match
    from public.requesters r
    where r.kind in ('student', 'staff')
      and r.email is not null
      and pg_catalog.lower(r.email) = v_email;
    if v_count = 1 then
      return pg_catalog.jsonb_build_object('state', 'match', 'id', v_match);
    elsif v_count > 1 then
      return pg_catalog.jsonb_build_object('state', 'ambiguous');
    end if;
  end if;

  if v_name <> '' and pg_catalog.length(v_name) <= 160 and pg_catalog.strpos(v_name, ' ') > 0 then
    select pg_catalog.count(*)::integer, (pg_catalog.array_agg(r.id))[1]
    into v_count, v_match
    from public.requesters r
    where r.kind in ('student', 'staff')
      and (
        public.app_checkin_fold(r.display_name) = v_name
        or public.app_checkin_fold(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')) = v_name
        or public.app_checkin_fold(coalesce(r.last_name, '') || ' ' || coalesce(r.first_name, '')) = v_name
      );
    if v_count = 1 then
      return pg_catalog.jsonb_build_object('state', 'match', 'id', v_match);
    elsif v_count > 1 then
      return pg_catalog.jsonb_build_object('state', 'ambiguous');
    end if;
  end if;

  return pg_catalog.jsonb_build_object('state', 'none');
end;
$$;

-- ---------------------------------------------------------------------------
-- The preview's read: who each row names, before anything is written.
-- ---------------------------------------------------------------------------

create or replace function public.app_match_form_respondents(p_form uuid, p_rows jsonb)
returns table (
  row_index integer,
  state text,
  person_id uuid,
  display_name text,
  external_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_form public.forms;
  v_row jsonb;
  v_at integer := 0;
  v_match jsonb;
begin
  perform public.app_require_actor();

  select * into v_form from public.forms f where f.id = p_form;
  if not found or not public.app_form_can_see(v_form) then
    raise exception 'There is no form with that id.' using errcode = 'check_violation';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Send the rows as a list.' using errcode = 'check_violation';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 1000 then
    raise exception 'Look up at most 1,000 rows at once.' using errcode = 'check_violation';
  end if;

  for v_row in select e.value from pg_catalog.jsonb_array_elements(p_rows) e loop
    v_at := v_at + 1;
    if pg_catalog.jsonb_typeof(v_row) <> 'object' then
      v_match := pg_catalog.jsonb_build_object('state', 'none');
    else
      v_match := public.app_form_import_match(
        v_row ->> 'email', v_row ->> 'external_id', v_row ->> 'name'
      );
    end if;

    row_index := v_at;
    state := v_match ->> 'state';
    person_id := (v_match ->> 'id')::uuid;
    display_name := null;
    external_id := null;
    if person_id is not null then
      select r.display_name, r.external_id into display_name, external_id
      from public.requesters r where r.id = person_id;
    end if;
    return next;
  end loop;
end;
$$;

comment on function public.app_match_form_respondents(uuid, jsonb) is
  'For the import preview: which directory record each row''s email, OSIS or name names — match, none or ambiguous — in the order sent. At most 1,000 rows. Anybody who can see the form.';

-- ---------------------------------------------------------------------------
-- The import.
-- ---------------------------------------------------------------------------

/*
 * One batch of rows, each {submitted_at, email, external_id, name, answers}.
 * Answers one row per row sent, in order:
 *
 *   made      a new response
 *   updated   a newer row replaced this person's older response
 *   skipped   already here (the same row, or this person's answer is as new)
 *   refused   an answer did not fit its question; message says which
 *
 * A refused row takes nothing with it: each row is its own subtransaction.
 */
create or replace function public.app_import_form_responses(p_form uuid, p_rows jsonb)
returns table (
  row_index integer,
  outcome text,
  response_id uuid,
  person_id uuid,
  message text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_form public.forms;
  v_relaxed public.forms;
  v_row jsonb;
  v_at integer := 0;
  v_when timestamptz;
  v_match jsonb;
  v_person public.requesters;
  v_clean jsonb;
  v_existing public.form_responses;
  v_result jsonb;
  v_made integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_refused integer := 0;
begin
  v_actor := public.app_require_actor();

  -- Locked, so two imports of the same sheet at once cannot both decide a row
  -- is new.
  select * into v_form from public.forms f where f.id = p_form for update;
  if not found or not public.app_form_can_see(v_form) then
    raise exception 'There is no form with that id.' using errcode = 'check_violation';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Send the rows as a list.' using errcode = 'check_violation';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) = 0 then
    raise exception 'There are no rows to import.' using errcode = 'check_violation';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 200 then
    raise exception 'Import at most 200 rows at a time.' using errcode = 'check_violation';
  end if;

  -- The same questions with nothing required: a row sent before a question
  -- was made required is not refused for leaving it empty.
  v_relaxed := v_form;
  v_relaxed.fields := coalesce((
    select pg_catalog.jsonb_agg(e.value || '{"required": false}'::jsonb order by e.ordinality)
    from pg_catalog.jsonb_array_elements(v_form.fields) with ordinality as e(value, ordinality)
  ), '[]'::jsonb);

  for v_row in select e.value from pg_catalog.jsonb_array_elements(p_rows) e loop
    v_at := v_at + 1;
    row_index := v_at;
    response_id := null;
    person_id := null;
    message := null;

    begin
      if pg_catalog.jsonb_typeof(v_row) <> 'object' then
        raise exception 'This row is not a row.' using errcode = 'check_violation';
      end if;

      v_when := null;
      if nullif(pg_catalog.btrim(coalesce(v_row ->> 'submitted_at', '')), '') is not null then
        begin
          v_when := (v_row ->> 'submitted_at')::timestamptz;
        exception
          when others then
            raise exception 'The time it was sent is not a date and time.' using errcode = 'check_violation';
        end;
        if v_when > pg_catalog.now() + interval '5 minutes' then
          raise exception 'The time it was sent is in the future.' using errcode = 'check_violation';
        end if;
        if v_when < timestamptz '2000-01-01' then
          raise exception 'The time it was sent is before 2000.' using errcode = 'check_violation';
        end if;
      end if;

      v_match := public.app_form_import_match(
        v_row ->> 'email', v_row ->> 'external_id', v_row ->> 'name'
      );
      v_person := null;
      if v_match ->> 'state' = 'match' then
        select * into v_person from public.requesters r where r.id = (v_match ->> 'id')::uuid;
      end if;
      person_id := v_person.id;

      v_clean := public.app_form_clean_answers(
        v_relaxed,
        coalesce(v_row -> 'answers', '{}'::jsonb),
        v_person
      );

      if v_person.id is not null then
        select * into v_existing
        from public.form_responses r
        where r.form_id = v_form.id and r.requester_id = v_person.id;

        if v_existing.id is not null and (v_when is null or v_existing.submitted_at >= v_when) then
          outcome := 'skipped';
          response_id := v_existing.id;
          message := case
            when v_when is not null and v_existing.submitted_at = v_when
              and v_existing.answers = v_clean -> 'answers'
              then 'Already imported.'
            else 'This person already has a response as new as this one.'
          end;
          v_skipped := v_skipped + 1;
          return next;
          continue;
        end if;
      else
        select * into v_existing
        from public.form_responses r
        where r.form_id = v_form.id
          and r.requester_id is null
          and r.answers = v_clean -> 'answers'
          and (v_when is null or r.submitted_at = v_when)
        limit 1;

        if v_existing.id is not null then
          outcome := 'skipped';
          response_id := v_existing.id;
          message := 'Already imported.';
          v_skipped := v_skipped + 1;
          return next;
          continue;
        end if;
      end if;

      v_result := public.app_form_record_response(v_form, v_person.id, v_clean, 'import', v_actor.id);
      response_id := (v_result ->> 'id')::uuid;
      if v_when is not null then
        update public.form_responses r set submitted_at = v_when where r.id = response_id;
      end if;

      if (v_result ->> 'updated')::boolean then
        outcome := 'updated';
        v_updated := v_updated + 1;
      else
        outcome := 'made';
        v_made := v_made + 1;
      end if;
      return next;
    exception
      when check_violation then
        outcome := 'refused';
        response_id := null;
        message := sqlerrm;
        v_refused := v_refused + 1;
        return next;
    end;
  end loop;

  if v_made + v_updated > 0 then
    perform public.app_log_record_event(
      'form', v_form.id, 'form_import', v_actor.id,
      pg_catalog.format(
        'Imported %s %s into %s.',
        v_made + v_updated,
        case when v_made + v_updated = 1 then 'response' else 'responses' end,
        v_form.title
      ),
      pg_catalog.format('%s new, %s replaced, %s already here, %s refused.', v_made, v_updated, v_skipped, v_refused)
    );
  end if;
end;
$$;

comment on function public.app_import_form_responses(uuid, jsonb) is
  'Imports up to 200 rows from a sheet of responses into a form: matches each row to the directory by OSIS, email or name, keeps the sheet''s time, skips a row already here, replaces an older answer with a newer one, and does what the form is linked to for a matched person. One outcome per row. Anybody who can see the form. Records one history entry with the counts.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function public.app_form_import_match(text, text, text)
from public, anon, authenticated;

revoke execute on function
  public.app_match_form_respondents(uuid, jsonb),
  public.app_import_form_responses(uuid, jsonb)
from public, anon;

grant execute on function
  public.app_match_form_respondents(uuid, jsonb),
  public.app_import_form_responses(uuid, jsonb)
to authenticated;
