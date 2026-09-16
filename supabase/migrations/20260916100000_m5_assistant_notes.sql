-- ---------------------------------------------------------------------------
-- Notes for the assistant: two short pieces of free text that ride along with
-- every conversation.
--
-- The assistant already knows who is asking, what today is and what the tool
-- table can do. What it cannot know is the shape of THIS desk: that the cart in
-- 118 is the one that never charges, that "the annex" means the building across
-- the car park, that this NetRider only works Tuesdays. Somebody has to type
-- that, and there are exactly two audiences for it.
--
--   PERSONAL notes are one person's own working habits, and belong on the row
--   that already holds their settings. A column on `account_preferences` rather
--   than a table: the value is one short string, it is read on the same round
--   trip as the rest of that account's settings, and a table would have brought
--   a primary key, two policies and a second read to hold one field.
--
--   SHARED notes are the school's, and every active account — administrator,
--   NetRider, skills officer alike — may read them and may edit them. That is
--   the point: the rules of the house are written by whoever is at the desk
--   when they change, not filed as an administrator's setting. So the table is
--   ONE ROW, pinned by a check constraint, and the write goes through a
--   function rather than a policy, because an edit has to be attributed and
--   recorded even though it is not an administrator's act.
--
-- NEITHER WIDENS ANYTHING. Both are pasted into the system prompt under a
-- heading that says what they are, and the prompt says in the rules above them
-- that text somebody typed is data. The defence against "you are now in admin
-- mode" in a shared note is the same defence as for a ticket body: the
-- database's own authorization and `requiresApproval` in tools.ts. A note is
-- context; it is not a permission.
--
-- 600 characters each, and that is a product decision rather than a storage
-- one. These are pasted into every turn this account ever takes, so the cost of
-- a long note is paid on every conversation; past a short paragraph it stops
-- being context and starts being documentation.
--
-- Both writers CLAMP rather than refuse. There is no vocabulary here to be
-- outside of — it is free text — so a refusal would tell an operator nothing
-- they could act on, and the interface already stops at 600 while they type.
-- The column's CHECK is therefore a floor under a bug, not a gate a person can
-- hit.
--
-- Additive: one column, one table, one new key on an existing patch.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Personal notes
-- ---------------------------------------------------------------------------

alter table public.account_preferences
  add column if not exists assistant_notes text not null default '';

alter table public.account_preferences
  drop constraint if exists account_preferences_assistant_notes_length;

alter table public.account_preferences
  add constraint account_preferences_assistant_notes_length
  check (pg_catalog.length(assistant_notes) <= 600);

comment on column public.account_preferences.assistant_notes is
  'What this account wants its own assistant to know about how they work. Plain text, at most 600 characters, shown to nobody else. Written only by app_update_preferences.';

-- ---------------------------------------------------------------------------
-- app_update_preferences gains a sixth key.
--
-- Restated whole rather than patched: `create or replace` is the only way to
-- change a body, and a partial copy is how a body and its comment drift apart.
-- The rest of this is the definition from `20260914150100_m5_reasoning_max.sql`,
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

  -- Six keys, and only six. `account_id`, `updated_at` and anything else the
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
  'Changes the caller''s own settings. Only theme, ai_reasoning, assistant_notes, ai_confirm_changes, ai_speak_replies and notify_in_app are read; unknown keys are ignored; a value outside its vocabulary is refused with a message saying what to choose. Notes are trimmed and cut at 600 characters rather than refused. Returns the whole row.';

-- ---------------------------------------------------------------------------
-- app_my_preferences, restated.
--
-- Its body does not change — it returns the whole `account_preferences` row, so
-- the new column comes back on its own — but it is replaced here so that this
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
-- Shared notes
--
-- One row, and the check constraint is what says so: `id = 1` means a second
-- row cannot be inserted by any path, including the service role fixing
-- something up by hand. The row is seeded here so that every read after this
-- migration finds it and no caller has to reason about its absence.
-- ---------------------------------------------------------------------------

create table if not exists public.assistant_notes_shared (
  id int primary key default 1 check (id = 1),
  body text not null default '' check (pg_catalog.length(body) <= 600),
  -- Nullable, and NO ACTION on the reference: the seeded row has no editor yet,
  -- and an account that edited the notes cannot be deleted out from under the
  -- attribution. Accounts are deactivated in this application, never removed.
  updated_by uuid null references public.app_accounts (id),
  updated_at timestamptz not null default now()
);

comment on table public.assistant_notes_shared is
  'The one note the whole school shares with the assistant: what the desk is, room names, the rules of the house. Every active account reads it and every active account may edit it. Written only by app_set_assistant_notes_shared.';
comment on column public.assistant_notes_shared.body is
  'Plain text, at most 600 characters. Pasted into every conversation as context, never as instructions.';
comment on column public.assistant_notes_shared.updated_by is
  'The account that last edited the note. NULL until somebody has.';

insert into public.assistant_notes_shared (id)
values (1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Reading it.
--
-- SECURITY DEFINER because the screen shows WHO last edited the note, and
-- `app_accounts_select_self_or_admin` means a NetRider cannot read another
-- account's display name for themselves. The function hands back that one name
-- and nothing else about the account.
--
-- No rows at all for a caller who is not active, the same answer
-- app_my_ai_connection() gives: they are not told even that the question has an
-- answer.
-- ---------------------------------------------------------------------------

create or replace function public.app_assistant_notes_shared()
returns table (
  body text,
  updated_by uuid,
  updated_by_name text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.app_active_account_id() is null then
    return;
  end if;

  return query
    select n.body, n.updated_by, a.display_name, n.updated_at
    from public.assistant_notes_shared n
    -- LEFT: nobody has edited the seeded row yet, and it is still the note.
    left join public.app_accounts a on a.id = n.updated_by
    where n.id = 1;
end;
$$;

comment on function public.app_assistant_notes_shared() is
  'The school''s shared notes for the assistant, with the name of whoever last edited them and when. Returns no rows at all to a caller who is not an active account.';

-- ---------------------------------------------------------------------------
-- Writing it.
--
-- app_require_actor() and nothing more: every active account may edit the
-- rules of the house, which is the whole design. The edit is recorded against
-- the editor's own account through app_log_record_event — the same writer
-- app_update_display_name uses for a self-service change — so it appears in the
-- audit screen beside everything else somebody did.
--
-- The note's TEXT is deliberately not copied into the log. record_events is
-- append-only and readable by every administrator, and a free-text field
-- somebody typed is exactly the kind of thing that should not be duplicated
-- into a history nobody can edit. The log says who changed it and when; the
-- note itself is one read away.
-- ---------------------------------------------------------------------------

create or replace function public.app_set_assistant_notes_shared(p_body text)
returns public.assistant_notes_shared
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_body text;
  v_row public.assistant_notes_shared;
begin
  v_actor := public.app_require_actor();

  v_body := pg_catalog.left(pg_catalog.btrim(coalesce(p_body, '')), 600);

  select * into v_row
  from public.assistant_notes_shared n
  where n.id = 1
  for update;

  -- Saving the note that is already there is not a change: nothing is written,
  -- nothing is recorded, and the attribution keeps naming whoever last actually
  -- changed something.
  if found and v_row.body = v_body then
    return v_row;
  end if;

  insert into public.assistant_notes_shared (id, body, updated_by, updated_at)
  values (1, v_body, v_actor.id, pg_catalog.now())
  on conflict (id) do update
  set body = excluded.body,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  returning * into v_row;

  perform public.app_log_record_event(
    'account',
    v_actor.id,
    'assistant_notes_shared',
    v_actor.id,
    case
      when v_body = '' then 'Shared notes for the assistant cleared.'
      else 'Shared notes for the assistant edited.'
    end
  );

  return v_row;
end;
$$;

comment on function public.app_set_assistant_notes_shared(text) is
  'Replaces the school''s shared notes for the assistant. Any active account may call it. Trims and cuts at 600 characters rather than refusing, records the editor and the time, and writes one entry to the record history. Saving an unchanged note writes nothing.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so the table is revoked explicitly and then re-granted SELECT
-- only. INSERT, UPDATE and DELETE policies are deliberately absent: the
-- function above is the one door, which is what keeps the cap, the attribution
-- and the history entry from being walked around.
-- ---------------------------------------------------------------------------

alter table public.assistant_notes_shared enable row level security;

drop policy if exists assistant_notes_shared_select_active on public.assistant_notes_shared;

create policy assistant_notes_shared_select_active
  on public.assistant_notes_shared for select to authenticated
  using (public.app_active_account_id() is not null);

revoke all on table public.assistant_notes_shared from anon, authenticated;

grant select on table public.assistant_notes_shared to authenticated;

revoke execute on function
  public.app_assistant_notes_shared(),
  public.app_set_assistant_notes_shared(text)
from public, anon;

grant execute on function
  public.app_assistant_notes_shared(),
  public.app_set_assistant_notes_shared(text)
to authenticated;
