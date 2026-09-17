-- ---------------------------------------------------------------------------
-- Getting a list of people OUT of the directory: into a mail client, onto the
-- clipboard, into a spreadsheet.
--
-- This is the thing a skills officer does all week and the application has
-- never helped with. A chapter mailing goes to forty students; a call list for
-- a competition is forty guardian phone numbers; a roster for an adviser is a
-- CSV. Until now every one of those was read off the screen by eye, fifty rows
-- at a time, and retyped.
--
-- Three things are added, and each one is deliberately narrow:
--
--   1. A PREFERENCE, `gmail_mode`. Composing to forty addresses is either a CC
--      (everyone sees who else is on it, which is right for a chapter) or a BCC
--      (nobody does, which is right for guardians). Whichever somebody picks is
--      almost always the one they want next time, so it is remembered rather
--      than asked again. It is the seventh key on the same patch every other
--      setting goes through: one door, one vocabulary check, one audit surface.
--
--   2. A READ, `app_people_addressees`. The list on screen is one page of
--      fifty, and the thing somebody wants to mail is the whole filter. This
--      answers the filter — the same kind and the same search the list ran —
--      with the few fields an address line, a clipboard line or a CSV row
--      needs, and NOTHING ELSE: no notes, no address, no home phone. It caps at
--      500 rows, which is both what a Gmail link can carry and what a person
--      can plausibly be about to write to.
--
--   3. A WRITE, `app_log_people_export`. A CSV of student names, OSIS numbers,
--      guardian names and guardian phone numbers leaving the building is the
--      most sensitive thing this application does, so it is recorded: who,
--      when, which list, how many. The CONTENT is never written to the log —
--      record_events is append-only and every administrator reads it, so
--      copying the export into it would make a second, permanent copy of the
--      thing the log exists to keep track of.
--
-- Only an administrator or a skills officer may export. A NetRider works
-- tickets and reads the directory to do it; carrying it out of the building is
-- somebody else's job, and the refusal says so rather than answering with an
-- empty file.
--
-- Additive. One column, three functions, and two existing functions restated
-- whole because `create or replace` is the only way to change a body and a
-- partial copy is how a body and its comment drift apart.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The preference
-- ---------------------------------------------------------------------------

alter table public.account_preferences
  add column if not exists gmail_mode text not null default 'cc';

alter table public.account_preferences
  drop constraint if exists account_preferences_gmail_mode_check;

alter table public.account_preferences
  add constraint account_preferences_gmail_mode_check
  check (gmail_mode in ('cc', 'bcc'));

comment on column public.account_preferences.gmail_mode is
  'Whether this account''s Gmail links put the addresses in CC or in BCC. ''cc'' or ''bcc''; CC is the default. Written only by app_update_preferences.';

-- ---------------------------------------------------------------------------
-- app_update_preferences gains a seventh key.
--
-- The rest of this is the definition from `20260916100000_m5_assistant_notes.sql`,
-- unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.app_update_preferences(p_patch jsonb)
returns public.account_preferences
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_row public.account_preferences;
  v_theme text;
  v_reasoning text;
  v_gmail text;
begin
  v_actor := public.app_require_actor();

  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Send the settings you want to change as an object of fields.'
      using errcode = 'check_violation';
  end if;

  -- An account may patch before it has ever read, so the row is ensured here
  -- too rather than assumed.
  insert into public.account_preferences (account_id)
  values (v_actor.id)
  on conflict (account_id) do nothing;

  select * into v_row
  from public.account_preferences p
  where p.account_id = v_actor.id
  for update;

  -- Seven keys, and only seven. `account_id`, `updated_at` and anything else the
  -- caller sends is IGNORED rather than refused: a settings form posts its whole
  -- state back, and failing over a field the database owns would be a bug the
  -- operator could not act on.
  if p_patch ? 'theme' then
    v_theme := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_patch ->> 'theme', ''))), '');
    if v_theme is null or v_theme not in ('system', 'light', 'dark') then
      raise exception 'Choose a theme: system, light or dark.' using errcode = 'check_violation';
    end if;
    v_row.theme := v_theme;
  end if;

  if p_patch ? 'ai_reasoning' then
    v_reasoning := nullif(
      pg_catalog.lower(pg_catalog.btrim(coalesce(p_patch ->> 'ai_reasoning', ''))), ''
    );
    if v_reasoning is null or v_reasoning not in ('low', 'medium', 'high', 'xhigh', 'max') then
      raise exception 'Choose a reasoning level: low, medium, high, xhigh or max.'
        using errcode = 'check_violation';
    end if;
    v_row.ai_reasoning := v_reasoning;
  end if;

  -- Free text, so there is nothing to be outside of: it is trimmed, cut at the
  -- 600 characters the interface also stops at, and stored. A JSON null clears
  -- the note, which is how somebody takes theirs back off. Anything that is not
  -- a string IS refused, because `{"assistant_notes": {...}}` is a caller
  -- sending the wrong shape rather than a person writing a note.
  if p_patch ? 'assistant_notes' then
    if pg_catalog.jsonb_typeof(p_patch -> 'assistant_notes') not in ('string', 'null') then
      raise exception 'Send your notes for the assistant as text.'
        using errcode = 'check_violation';
    end if;
    v_row.assistant_notes := pg_catalog.left(
      pg_catalog.btrim(coalesce(p_patch ->> 'assistant_notes', '')), 600
    );
  end if;

  -- Two words, and a refusal that names both. A mailing either shows who else
  -- is on it or it does not, and there is no third answer to fall back to.
  if p_patch ? 'gmail_mode' then
    v_gmail := nullif(
      pg_catalog.lower(pg_catalog.btrim(coalesce(p_patch ->> 'gmail_mode', ''))), ''
    );
    if v_gmail is null or v_gmail not in ('cc', 'bcc') then
      raise exception 'Choose cc or bcc for a Gmail link.' using errcode = 'check_violation';
    end if;
    v_row.gmail_mode := v_gmail;
  end if;

  v_row.ai_confirm_changes :=
    public.app_preference_flag(p_patch, 'ai_confirm_changes', v_row.ai_confirm_changes);
  v_row.ai_speak_replies :=
    public.app_preference_flag(p_patch, 'ai_speak_replies', v_row.ai_speak_replies);
  v_row.notify_in_app :=
    public.app_preference_flag(p_patch, 'notify_in_app', v_row.notify_in_app);

  update public.account_preferences p
  set theme = v_row.theme,
      ai_reasoning = v_row.ai_reasoning,
      assistant_notes = v_row.assistant_notes,
      gmail_mode = v_row.gmail_mode,
      ai_confirm_changes = v_row.ai_confirm_changes,
      ai_speak_replies = v_row.ai_speak_replies,
      notify_in_app = v_row.notify_in_app,
      updated_at = pg_catalog.now()
  where p.account_id = v_actor.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.app_update_preferences(jsonb) is
  'Changes the caller''s own settings. Only theme, ai_reasoning, assistant_notes, gmail_mode, ai_confirm_changes, ai_speak_replies and notify_in_app are read; unknown keys are ignored; a value outside its vocabulary is refused with a message saying what to choose. Notes are trimmed and cut at 600 characters rather than refused. Returns the whole row.';

-- ---------------------------------------------------------------------------
-- app_my_preferences, restated.
--
-- Its body does not change — it returns the whole `account_preferences` row, so
-- `gmail_mode` comes back on its own — but it is replaced here so that this
-- file, read on its own, shows the definition that is live after it runs.
-- ---------------------------------------------------------------------------

create or replace function public.app_my_preferences()
returns public.account_preferences
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_row public.account_preferences;
begin
  v_actor := public.app_require_actor();

  -- `do nothing` rather than an upsert on purpose: reading your settings must
  -- not move updated_at, or every page load would look like a change.
  insert into public.account_preferences (account_id)
  values (v_actor.id)
  on conflict (account_id) do nothing;

  select * into v_row
  from public.account_preferences p
  where p.account_id = v_actor.id;

  return v_row;
end;
$$;

comment on function public.app_my_preferences() is
  'The caller''s own settings, creating the default row the first time it is asked for. Reading never changes updated_at.';

-- ---------------------------------------------------------------------------
-- The addressee projection.
--
-- Narrower than `app_person_json` on purpose. This one crosses the wire five
-- hundred rows at a time so that somebody can write to a class, and the fields
-- it carries are exactly the ones an address line, a clipboard line or a CSV
-- row is made of. A person's home address, home phone and notes are on their
-- page, one click away, for the one person somebody actually needs them for.
--
-- Internal helper: invoked by app_people_addressees, reachable by no client, so
-- it keeps the same revoke-from-all ACL the other projections have.
-- ---------------------------------------------------------------------------

create or replace function public.app_person_addressee_json(r public.requesters)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'kind', r.kind,
    'displayName', r.display_name,
    'email', coalesce(r.email, ''),
    'externalId', coalesce(r.external_id, ''),
    -- A student's class and a member of staff's department: the one column a
    -- roster is sorted or split by, and the only placement field a CSV carries.
    'officialClass', coalesce(r.official_class, ''),
    'department', coalesce(r.department, ''),
    'guardianName', coalesce(r.guardian_name, ''),
    'guardianPhone', coalesce(r.guardian_phone, ''));
$$;

revoke all on function public.app_person_addressee_json(public.requesters)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The filter, as addressees.
--
-- Same gate, same kind and the same search expression `app_list_people` runs,
-- so "everybody this list is showing" means exactly what it says rather than
-- approximately. `p_ids` narrows it further to a selection somebody ticked;
-- the kind still applies, because the directory is two lists and a selection is
-- always made inside one of them.
--
-- Five hundred is the cap and the envelope says so, because a caller has to be
-- able to tell "these are all of them" from "these are the first five hundred".
-- It is not a page size: there is no second page, and the answer to a filter
-- bigger than the cap is to narrow the filter or take the CSV.
-- ---------------------------------------------------------------------------

create or replace function public.app_people_addressees(
  p_kind text,
  p_query text default '',
  p_ids uuid[] default null
)
returns jsonb
language plpgsql
-- Volatile, like app_list_people and every other directory read: they all begin
-- by asking app_require_actor(), which takes an advisory lock to serialise
-- against a deactivation, and that is not a stable function's business.
security definer
set search_path = ''
as $$
declare
  v_query text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
  v_cap constant integer := 500;
  v_total bigint;
  v_result jsonb;
begin
  perform public.app_require_actor();

  if p_kind is null or p_kind not in ('student', 'staff') then
    raise exception 'Choose students or staff.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_query) > 120 then
    raise exception 'Invalid search or page.' using errcode = 'check_violation';
  end if;
  -- A selection is one page of a list. Ten thousand ids is not a selection, it
  -- is a caller trying to read the directory sideways.
  if p_ids is not null and pg_catalog.array_length(p_ids, 1) > 1000 then
    raise exception 'Too many people were selected at once.' using errcode = 'check_violation';
  end if;

  with matches as materialized (
    select r.*
    from public.requesters r
    where r.kind = p_kind
      and (p_ids is null or r.id = any(p_ids))
      and (
        v_query = ''
        or pg_catalog.strpos(
          pg_catalog.lower(
            pg_catalog.concat_ws(' ',
              r.display_name, r.external_id, r.email, r.first_name, r.last_name,
              r.school_dbn, r.department, r.staff_role, r.class_of, r.student_status,
              r.official_class, r.guardian_name, r.guardian_phone, r.home_phone,
              r.address, r.notes)),
          v_query) > 0
      )
  ), taken as (
    select * from matches order by display_name, id limit v_cap
  )
  select
    jsonb_build_object(
      'rows', coalesce(
        (select jsonb_agg(public.app_person_addressee_json(t::public.requesters)
                order by t.display_name, t.id)
         from taken t),
        '[]'::jsonb),
      'total', (select count(*) from matches),
      'cap', v_cap),
    (select count(*) from matches)
  into v_result, v_total;

  return v_result || jsonb_build_object('capped', v_total > v_cap);
end;
$$;

comment on function public.app_people_addressees(text, text, uuid[]) is
  'Everybody one directory filter matches, as addressees: name, address, identifier, class or department and guardian. At most 500 rows, with the filter''s full total and whether it was cut beside them. Any active account may call it.';

-- ---------------------------------------------------------------------------
-- Recording an export.
--
-- The one writer here, and it writes to the history rather than to the
-- directory. app_log_record_event is callable by no client — the revoke in
-- `20260914100000_m5_foundation.sql` names authenticated and service_role — so
-- this is the door, and the door checks the role. The entry is filed against
-- the exporter's own account, which is where app_set_assistant_notes_shared
-- files an edit to something shared and where the audit screen already looks.
--
-- The COUNT goes in. Nothing else does.
-- ---------------------------------------------------------------------------

create or replace function public.app_log_people_export(p_kind text, p_count integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_count integer;
begin
  v_actor := public.app_require_actor();

  if not (public.app_has_role('admin') or public.app_has_role('skills_officer')) then
    raise exception 'Only an administrator or a skills officer can export the directory.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_kind is null or p_kind not in ('student', 'staff') then
    raise exception 'Choose students or staff.' using errcode = 'check_violation';
  end if;

  v_count := greatest(coalesce(p_count, 0), 0);

  perform public.app_log_record_event(
    'account',
    v_actor.id,
    'people_export',
    v_actor.id,
    pg_catalog.format(
      'Exported %s %s from the directory.',
      v_count,
      case when p_kind = 'staff' then 'staff records' else 'student records' end
    )
  );
end;
$$;

comment on function public.app_log_people_export(text, integer) is
  'Records that the caller exported a directory list, with how many rows and which list. Refuses anybody who is not an administrator or a skills officer. The exported content is never written to the log.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_people_addressees(text, text, uuid[]),
  public.app_log_people_export(text, integer)
from public, anon;

grant execute on function
  public.app_people_addressees(text, text, uuid[]),
  public.app_log_people_export(text, integer)
to authenticated;
