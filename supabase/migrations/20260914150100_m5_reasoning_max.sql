-- ---------------------------------------------------------------------------
-- A fourth reasoning level: max.
--
-- The panel now offers exactly three: High, Extra high and Max. `low` and
-- `medium` stay in the vocabulary rather than being removed, because rows
-- written before this change hold them and a CHECK that refused them would
-- break every one of those accounts' settings the next time anything saved.
-- They are simply not offered any more.
--
-- The refusal names all five, because it is the DATABASE's answer about what
-- the column takes. Which three the interface puts in front of somebody is the
-- interface's own statement, and a refusal that named only those would be
-- refusing a value it had just accepted.
--
-- Two statements, both additive: the column's CHECK widens, and the one
-- function that writes the column widens with it. The function is replaced
-- whole rather than patched, because `create or replace` is the only way to
-- change a body and a partial copy is how a body and its comment drift apart.
-- ---------------------------------------------------------------------------

alter table public.account_preferences
  drop constraint if exists account_preferences_ai_reasoning_check;

alter table public.account_preferences
  add constraint account_preferences_ai_reasoning_check
  check (ai_reasoning in ('low', 'medium', 'high', 'xhigh', 'max'));

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

  -- Five keys, and only five. `account_id`, `updated_at` and anything else the
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

  v_row.ai_confirm_changes :=
    public.app_preference_flag(p_patch, 'ai_confirm_changes', v_row.ai_confirm_changes);
  v_row.ai_speak_replies :=
    public.app_preference_flag(p_patch, 'ai_speak_replies', v_row.ai_speak_replies);
  v_row.notify_in_app :=
    public.app_preference_flag(p_patch, 'notify_in_app', v_row.notify_in_app);

  update public.account_preferences p
  set theme = v_row.theme,
      ai_reasoning = v_row.ai_reasoning,
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
  'Changes the caller''s own settings. Only theme, ai_reasoning, ai_confirm_changes, ai_speak_replies and notify_in_app are read; unknown keys are ignored; a value outside its vocabulary is refused with a message saying what to choose. Returns the whole row.';
