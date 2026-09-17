-- ---------------------------------------------------------------------------
-- Writing to people is direct.
--
-- The Gmail link offered CC or BCC, with CC as the default. Emailing a person
-- is neither: it is To. The preference gains that third value and it becomes
-- the default; rows still on the old default move to it, because nobody has
-- chosen CC on purpose yet — the setting is hours old.
--
-- Also: a group's members carry their guardian name and phone, so a mailing
-- or a call list for a group needs no second read. `app_group_members` gains
-- two columns at the end of its row; a return type cannot change under
-- `create or replace`, so it is dropped and recreated with its original body.
--
-- Additive otherwise. Restates app_update_preferences from
-- 20260916130000_m5_people_actions.sql with the vocabulary widened.
-- ---------------------------------------------------------------------------

alter table public.account_preferences
  drop constraint if exists account_preferences_gmail_mode_check;

alter table public.account_preferences
  add constraint account_preferences_gmail_mode_check
  check (gmail_mode in ('to', 'cc', 'bcc'));

alter table public.account_preferences
  alter column gmail_mode set default 'to';

update public.account_preferences set gmail_mode = 'to' where gmail_mode = 'cc';

comment on column public.account_preferences.gmail_mode is
  'Where this account''s Gmail links put their addresses: to (direct, the default), cc or bcc.';

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

  -- Three words, and a refusal that names them. To is writing to people;
  -- CC and BCC are the two ways of copying them.
  if p_patch ? 'gmail_mode' then
    v_gmail := nullif(
      pg_catalog.lower(pg_catalog.btrim(coalesce(p_patch ->> 'gmail_mode', ''))), ''
    );
    if v_gmail is null or v_gmail not in ('to', 'cc', 'bcc') then
      raise exception 'Choose to, cc or bcc for a Gmail link.' using errcode = 'check_violation';
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

drop function if exists public.app_group_members(uuid);

create or replace function public.app_group_members(p_group uuid)
returns table (
  requester_id uuid,
  display_name text,
  kind text,
  external_id text,
  email text,
  group_label text,
  note text,
  added_at timestamptz,
  guardian_name text,
  guardian_phone text
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
      m.added_at,
      nullif(pg_catalog.btrim(coalesce(r.guardian_name, '')), ''),
      nullif(pg_catalog.btrim(coalesce(r.guardian_phone, '')), '')
    from public.people_group_members m
    join public.requesters r on r.id = m.requester_id
    where m.group_id = p_group
    order by pg_catalog.lower(r.display_name), r.id;
end;
$$;


comment on function public.app_group_members(uuid) is
  'Everybody in a group, ordered by name, with their identifier, address, class or department, note, and for students the guardian on file. Nothing for an unknown group.';

revoke execute on function public.app_group_members(uuid) from public, anon;
grant execute on function public.app_group_members(uuid) to authenticated;
