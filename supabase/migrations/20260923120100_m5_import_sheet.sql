-- ---------------------------------------------------------------------------
-- The desk's sheet, from a screen as well as from the assistant.
--
-- 20260916100200 gave the assistant app_import_resolved_ticket: one finished
-- row, written at its historic times, refused unless it is a history. The
-- Resolved page now takes a pasted sheet too — up to two hundred rows, each
-- previewed before anything is written — and it must land through the SAME
-- rules, or the form and the assistant would disagree about which rows are a
-- history. So the rules move into one internal function and two doors call it:
--
--   app_import_resolved_ticket   one row, returns the ticket id (unchanged
--                                contract for the assistant; two optional
--                                arguments added).
--   app_import_resolved_tickets  up to 200 rows as jsonb, and answers every
--                                row: made, skipped (already in the helpdesk)
--                                or refused with the sentence that refused it.
--                                A refused row does not stop the rest — the
--                                screen has already shown the person what it
--                                thinks of each row, so a batch that stopped
--                                on row 3 would throw that preview away.
--
-- What changes about the rules themselves, and why:
--
--   * The oldest acceptable date is the start of 2020 (app_history_floor,
--     20260923120000), not three years ago. Intake may now log a ticket back
--     to 2020, and an import refusing a row the form would accept is a rule
--     nobody can explain at the desk.
--   * p_solution: a sheet with a "How it was fixed" column is the real
--     solution, not the placeholder sentence. Five characters is the table's
--     minimum; a shorter note ("ok", "done") is kept rather than refused, as
--     "The sheet says: done", because refusing a whole year of rows over a
--     one-word column is the import being pedantic about a record it can read.
--   * p_resolved_by_name: who the sheet says fixed it, as text. The resolver
--     is still an account (the caller, or for an administrator somebody named
--     by id); when the sheet names somebody the helpdesk has no account for,
--     their name goes into the history and the placeholder solution rather
--     than being lost or guessed at.
--   * logged_at is set: every imported row is, by definition, logged after it
--     was opened, and the created event says when.
--
-- Idempotency is unchanged: the same title, the same two moments, the same
-- resolver and the same requester is the same ticket. Sending a sheet twice
-- makes nothing the second time.
-- ---------------------------------------------------------------------------

drop function public.app_import_resolved_ticket(text, text, timestamptz, timestamptz, uuid, uuid, text, text, text);

-- ---------------------------------------------------------------------------
-- The rules, once. Internal: no client role may call it.
-- ---------------------------------------------------------------------------

create function public.app_import_resolved_core(
  p_title text,
  p_issue text,
  p_called_at timestamptz,
  p_resolved_at timestamptz,
  p_resolved_by uuid,
  p_requester_id uuid,
  p_location text,
  p_category text,
  p_priority text,
  p_solution text,
  p_resolved_by_name text,
  out o_ticket_id uuid,
  out o_created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_admin boolean;
  v_resolver uuid;
  v_resolver_name text;
  v_sheet_name text := nullif(pg_catalog.btrim(coalesce(p_resolved_by_name, '')), '');
  v_title text := pg_catalog.btrim(coalesce(p_title, ''));
  v_issue text := pg_catalog.btrim(coalesce(p_issue, ''));
  v_category text := coalesce(nullif(pg_catalog.btrim(coalesce(p_category, '')), ''), 'other');
  v_priority text := coalesce(nullif(pg_catalog.btrim(coalesce(p_priority, '')), ''), 'normal');
  v_location text := nullif(pg_catalog.btrim(coalesce(p_location, '')), '');
  v_given_solution text := nullif(pg_catalog.btrim(coalesce(p_solution, '')), '');
  v_resolved_on date;
  v_solution text;
  v_now timestamptz := pg_catalog.now();
  v_via text := public.app_request_via();
  v_model text := public.app_request_ai_model();
begin
  v_actor := public.app_require_actor();
  v_admin := v_actor.roles && array['admin']::text[];

  if not (v_actor.roles && array['admin', 'netrider']::text[]) then
    raise exception 'Only a NetRider or an administrator can import resolved tickets.'
      using errcode = 'insufficient_privilege';
  end if;

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
  if pg_catalog.length(v_title) > 120 then
    raise exception 'Keep the title under 120 characters.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_issue) > 6000 then
    raise exception 'Keep notes under 6000 characters.' using errcode = 'check_violation';
  end if;
  if v_issue = '' then
    v_issue := v_title;
  end if;
  if v_given_solution is not null and pg_catalog.length(v_given_solution) > 6000 then
    raise exception 'Keep the solution under 6000 characters.' using errcode = 'check_violation';
  end if;
  if v_sheet_name is not null and pg_catalog.length(v_sheet_name) > 120 then
    raise exception 'Keep the name of who fixed it under 120 characters.' using errcode = 'check_violation';
  end if;

  if p_called_at is null or p_resolved_at is null then
    raise exception 'Each row needs the date it came in and the date it was resolved.'
      using errcode = 'check_violation';
  end if;
  if p_called_at > p_resolved_at then
    raise exception 'A ticket cannot be resolved before it was called in.'
      using errcode = 'check_violation';
  end if;
  perform public.app_check_history_moment(p_resolved_at, 'A resolved date');
  perform public.app_check_history_moment(p_called_at, 'An opened date');

  if not (public.app_category_labels() ? v_category) then
    raise exception 'Choose a category for this ticket.' using errcode = 'check_violation';
  end if;
  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Choose low, normal, high or urgent.' using errcode = 'check_violation';
  end if;

  if p_requester_id is not null and not exists (
    select 1 from public.requesters r
    where r.id = p_requester_id and r.kind in ('staff', 'student')
  ) then
    raise exception 'Select an existing requester, or leave the requester unknown.'
      using errcode = 'check_violation';
  end if;

  v_resolved_on := (p_resolved_at at time zone 'America/New_York')::date;

  v_solution := case
    when v_given_solution is null then
      'Imported from the desk''s sheet: ' || coalesce(v_sheet_name, v_resolver_name)
        || ' resolved this on ' || v_resolved_on::text || '. The sheet did not record how.'
    when pg_catalog.length(v_given_solution) < 5 then
      'The sheet says: ' || v_given_solution
    else v_given_solution
  end;

  select t.id into o_ticket_id
  from public.tickets t
  where t.title = v_title
    and t.created_at = p_called_at
    and t.resolved_at = p_resolved_at
    and t.status = 'resolved'
    and t.resolved_by = v_resolver
    and t.requester_id is not distinct from p_requester_id
  limit 1;
  if o_ticket_id is not null then
    o_created := false;
    return;
  end if;

  insert into public.tickets (
    title, issue, requester_id, requester_unknown, location, is_remote,
    channel, priority, status, submitted_on, created_at, logged_at, created_by,
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
    (p_called_at at time zone 'America/New_York')::date,
    p_called_at,
    -- A row resolved "today" at a moment still ahead of the transaction start
    -- is impossible (refused above), so the sheet is always logged at or after
    -- it was opened.
    v_now,
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
  returning id into o_ticket_id;

  insert into public.activity_events (
    ticket_id, kind, actor_id, at, summary, detail, performed_via, ai_model
  )
  values
    (
      o_ticket_id, 'created', v_actor.id, p_called_at,
      'Imported from the desk''s sheet by ' || v_actor.display_name,
      public.app_logged_later_note(p_called_at, v_now),
      v_via, v_model
    ),
    (
      o_ticket_id,
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
      o_ticket_id, 'resolved', v_resolver, p_resolved_at,
      'Imported from the desk''s sheet: ' || v_resolver_name || ' resolved it',
      case
        when v_sheet_name is not null and pg_catalog.lower(v_sheet_name) <> pg_catalog.lower(v_resolver_name)
          then v_solution || E'\n\nThe sheet names ' || v_sheet_name || ' as the technician.'
        else v_solution
      end,
      v_via, v_model
    );

  o_created := true;
end;
$$;

comment on function public.app_import_resolved_core(text, text, timestamptz, timestamptz, uuid, uuid, text, text, text, text, text) is
  'The rules for one already-finished ticket from the desk''s sheet, shared by app_import_resolved_ticket and app_import_resolved_tickets. Returns the ticket and whether this call made it (false: the same row was already imported). Internal.';

revoke all on function
  public.app_import_resolved_core(text, text, timestamptz, timestamptz, uuid, uuid, text, text, text, text, text)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- One row: the assistant's door, same contract as before.
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
  p_priority text default null,
  p_solution text default null,
  p_resolved_by_name text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select c.o_ticket_id
  from public.app_import_resolved_core(
    p_title, p_issue, p_called_at, p_resolved_at, p_resolved_by, p_requester_id,
    p_location, p_category, p_priority, p_solution, p_resolved_by_name
  ) c;
$$;

comment on function public.app_import_resolved_ticket(text, text, timestamptz, timestamptz, uuid, uuid, text, text, text, text, text) is
  'Writes one already-finished ticket from the desk''s old spreadsheet: resolved, owned by whoever fixed it, opened and closed at the historic times, with the three activity events the ordinary path would have left. Admin or NetRider only; naming a resolver other than the caller is administrator-only. Refuses dates out of order, in the future, or before 2020. p_solution is the sheet''s own account of the fix; p_resolved_by_name is who the sheet says fixed it, kept in the history. The same row sent again returns the ticket already imported.';

revoke execute on function
  public.app_import_resolved_ticket(text, text, timestamptz, timestamptz, uuid, uuid, text, text, text, text, text)
from public, anon;

grant execute on function
  public.app_import_resolved_ticket(text, text, timestamptz, timestamptz, uuid, uuid, text, text, text, text, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Many rows: the screen's door.
--
-- p_rows is a jsonb array of objects with the keys title, issue, opened_at,
-- resolved_at, resolved_by (an account id), resolved_by_name, requester_id,
-- location, category, priority and solution. Each row runs inside its own
-- exception block — a savepoint — so a refused row is rolled back alone and
-- the answer names it; the rows around it still land.
--
-- A caller who may not import at all is refused ONCE, before any row, rather
-- than two hundred times.
-- ---------------------------------------------------------------------------

create function public.app_import_resolved_tickets(p_rows jsonb)
returns table (
  row_index integer,
  outcome text,
  ticket_id uuid,
  ticket_number text,
  message text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_row jsonb;
  v_at integer := 0;
  v_opened timestamptz;
  v_resolved timestamptz;
  v_resolved_by uuid;
  v_requester uuid;
  v_result record;
begin
  v_actor := public.app_require_actor();
  if not (v_actor.roles && array['admin', 'netrider']::text[]) then
    raise exception 'Only a NetRider or an administrator can import resolved tickets.'
      using errcode = 'insufficient_privilege';
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

  for v_row in select value from pg_catalog.jsonb_array_elements(p_rows) loop
    v_at := v_at + 1;
    row_index := v_at;
    ticket_id := null;
    ticket_number := null;
    message := null;

    begin
      if pg_catalog.jsonb_typeof(v_row) <> 'object' then
        raise exception 'This row is not a row.' using errcode = 'check_violation';
      end if;

      -- Read the loose values here, so a date or an id the sheet mangled is
      -- refused in words about the sheet rather than in Postgres's own.
      begin
        v_opened := nullif(pg_catalog.btrim(coalesce(v_row ->> 'opened_at', '')), '')::timestamptz;
        v_resolved := nullif(pg_catalog.btrim(coalesce(v_row ->> 'resolved_at', '')), '')::timestamptz;
      exception when invalid_datetime_format or datetime_field_overflow then
        raise exception 'The helpdesk could not read a date in this row.' using errcode = 'check_violation';
      end;
      begin
        v_resolved_by := nullif(pg_catalog.btrim(coalesce(v_row ->> 'resolved_by', '')), '')::uuid;
        v_requester := nullif(pg_catalog.btrim(coalesce(v_row ->> 'requester_id', '')), '')::uuid;
      exception when invalid_text_representation then
        raise exception 'This row names a person the helpdesk could not read.' using errcode = 'check_violation';
      end;

      select c.o_ticket_id, c.o_created into v_result
      from public.app_import_resolved_core(
        v_row ->> 'title',
        v_row ->> 'issue',
        v_opened,
        v_resolved,
        v_resolved_by,
        v_requester,
        v_row ->> 'location',
        v_row ->> 'category',
        v_row ->> 'priority',
        v_row ->> 'solution',
        v_row ->> 'resolved_by_name'
      ) c;

      ticket_id := v_result.o_ticket_id;
      outcome := case when v_result.o_created then 'made' else 'skipped' end;
      select t.number into ticket_number from public.tickets t where t.id = ticket_id;
    exception
      -- A refusal is an answer about this row. Anything the rules did not
      -- anticipate is reported the same way rather than losing the batch;
      -- the savepoint has already undone whatever the row began.
      when check_violation or insufficient_privilege or not_null_violation
        or foreign_key_violation or unique_violation or raise_exception then
        outcome := 'refused';
        ticket_id := null;
        ticket_number := null;
        message := sqlerrm;
    end;

    return next;
  end loop;
end;
$$;

comment on function public.app_import_resolved_tickets(jsonb) is
  'Imports up to 200 already-finished tickets from a pasted sheet through the same rules as app_import_resolved_ticket, one savepoint per row. Answers every row in order: made, skipped (the same row was already imported) or refused with the reason. Admin or NetRider only, refused once for anybody else.';

revoke execute on function public.app_import_resolved_tickets(jsonb) from public, anon;

grant execute on function public.app_import_resolved_tickets(jsonb) to authenticated;
