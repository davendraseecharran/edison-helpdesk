-- ---------------------------------------------------------------------------
-- The welcome effect.
--
-- The assistant's welcome shows the provider's mark come apart into dots and
-- move, and the library it runs on has seven ways of moving. Which one a
-- person sees when the panel opens is now theirs to choose: the column holds
-- the set they ticked, in the library's own words, and the panel picks one of
-- them each time the welcome mounts. Two are ticked for everybody until they
-- say otherwise, the diamond (`generating`) and the wave (`listening`).
--
-- A set rather than a word: at least one, each at most once, every one from
-- the seven. The checklist refuses to untick the last box and the function
-- below refuses an empty list in the same sentence, so the column's own check
-- is the third statement of a rule nobody should reach.
--
-- Additive. Restates app_update_preferences from
-- 20260916140000_m5_gmail_direct.sql with the eighth key. app_my_preferences
-- returns the whole row and names no column, so it stands as it is.
-- ---------------------------------------------------------------------------

alter table public.account_preferences
  add column if not exists ai_welcome_states text[] not null
    default '{generating,listening}';

comment on column public.account_preferences.ai_welcome_states is
  'The welcome effects this account allows, in the animation library''s words: thinking, searching, working, solving, listening, waiting or generating. At least one, each once. The panel picks one at random each time the welcome opens.';

-- Whether a text array holds no element twice and no null. Immutable so a
-- check constraint may call it; callable by nobody, because nothing but the
-- constraint should. service_role is named for the reason app_preference_flag
-- names it: Supabase grants it EXECUTE directly, not through PUBLIC.
create or replace function public.app_text_array_is_set(p_values text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(pg_catalog.cardinality(p_values), 0)
    = (select pg_catalog.count(distinct t.v) from pg_catalog.unnest(p_values) as t(v));
$$;

comment on function public.app_text_array_is_set(text[]) is
  'Trusted internal helper: true when every element of the array is distinct and none is null.';

revoke execute on function public.app_text_array_is_set(text[])
from public, anon, authenticated, service_role;

alter table public.account_preferences
  drop constraint if exists account_preferences_ai_welcome_states_check;

alter table public.account_preferences
  add constraint account_preferences_ai_welcome_states_check
  check (
    pg_catalog.cardinality(ai_welcome_states) >= 1
    and ai_welcome_states <@ array[
      'thinking', 'searching', 'working', 'solving', 'listening', 'waiting', 'generating'
    ]::text[]
    and public.app_text_array_is_set(ai_welcome_states)
  );

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
  v_states text[];
  v_state text;
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

  -- Eight keys, and only eight. `account_id`, `updated_at` and anything else the
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

  -- A list, folded and made a set. A box ticked twice is one box and the order
  -- ticked is the order kept; a word the canvas cannot play is refused by
  -- naming the seven it can, and an empty list is refused in the sentence the
  -- checklist itself uses when the last box is unticked.
  if p_patch ? 'ai_welcome_states' then
    if pg_catalog.jsonb_typeof(p_patch -> 'ai_welcome_states') <> 'array' then
      raise exception 'Send the welcome effects as a list.' using errcode = 'check_violation';
    end if;
    v_states := '{}';
    for v_state in
      select pg_catalog.lower(pg_catalog.btrim(t.value))
      from pg_catalog.jsonb_array_elements_text(p_patch -> 'ai_welcome_states') as t(value)
    loop
      if v_state is null or v_state not in (
        'thinking', 'searching', 'working', 'solving', 'listening', 'waiting', 'generating'
      ) then
        raise exception 'A welcome effect is one of thinking, searching, working, solving, listening, waiting or generating.'
          using errcode = 'check_violation';
      end if;
      if not (v_state = any (v_states)) then
        v_states := v_states || v_state;
      end if;
    end loop;
    if pg_catalog.cardinality(v_states) = 0 then
      raise exception 'Keep at least one welcome animation.' using errcode = 'check_violation';
    end if;
    v_row.ai_welcome_states := v_states;
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
      ai_welcome_states = v_row.ai_welcome_states,
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
  'Changes the caller''s own settings. Only theme, ai_reasoning, assistant_notes, gmail_mode, ai_welcome_states, ai_confirm_changes, ai_speak_replies and notify_in_app are read; unknown keys are ignored; a value outside its vocabulary is refused with a message saying what to choose. Notes are trimmed and cut at 600 characters rather than refused; the welcome list is folded and made a set, and refused only when empty or naming an effect that does not exist. Returns the whole row.';

revoke execute on function public.app_update_preferences(jsonb) from public, anon;
grant execute on function public.app_update_preferences(jsonb) to authenticated;
