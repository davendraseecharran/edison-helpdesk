-- M5: what each account prefers, the Codex connection it has linked, and the
-- assistant conversations it has had.
--
-- Additive only. Three kinds of private data land together because they all
-- belong to one person rather than to the helpdesk, and each needs a different
-- shape of protection.
--
-- 1. PREFERENCES are settings with a vocabulary. The row is created the first
--    time an account asks for one — no backfill, no trigger on sign-up, nothing
--    to keep in step — and the patch that changes it accepts only the five keys
--    it knows, IGNORING the rest, so a screen that posts its whole form back is
--    not punished for sending `account_id` along with it. The defaults are
--    product decisions: the application ships dark, and it does not interrupt
--    the operator to confirm every change the assistant proposes.
--
-- 2. The CODEX CONNECTION holds an OAuth refresh token. It arrives already
--    encrypted — the application does AES-256-GCM before it ever reaches the
--    database — and the ciphertext must never come back out through a client
--    role. So `ai_connections` has row-level security enabled and NO POLICIES AT
--    ALL, every privilege is revoked from anon and authenticated, and the only
--    thing a session can learn is what app_my_ai_connection() chooses to say:
--    whether a connection exists, which ChatGPT account it belongs to, and when
--    it was last used. Writing it is the server's job, with the service key.
--
-- 3. CONVERSATIONS are THE ONE PLACE in this schema where a signed-in session
--    writes a table directly, and that is deliberate. Everywhere else, a write
--    is a helpdesk record that has to be attributed, validated and recorded in
--    an append-only history, which is why it goes through a SECURITY DEFINER
--    RPC. A chat turn is none of those things: it is the user's own scratch
--    space, it is written many times a second while a response streams, and
--    wrapping each turn in an RPC would buy no invariant. The policies
--    therefore carry the whole weight, and they are written to bind rather than
--    to filter — `with check` pins `account_id` to the caller and
--    `conversation_id` to a conversation the caller owns, so no row can be
--    created in, or moved into, somebody else's chat.
--
--    Note that administrators get nothing here. A technician's conversation with
--    the assistant is personal; the helpdesk records it produced are already in
--    the ticket history where they belong.

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------

create table public.account_preferences (
  account_id uuid primary key references public.app_accounts (id) on delete cascade,
  theme text not null default 'dark' check (theme in ('system', 'light', 'dark')),
  ai_reasoning text not null default 'high'
    check (ai_reasoning in ('low', 'medium', 'high', 'xhigh')),
  ai_confirm_changes boolean not null default false,
  ai_speak_replies boolean not null default false,
  notify_in_app boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.account_preferences is
  'One row per account, created the first time that account asks for it. Private to its owner: not even an administrator reads somebody else''s settings.';
comment on column public.account_preferences.theme is
  'system, light or dark. Dark is what the application ships with.';
comment on column public.account_preferences.ai_confirm_changes is
  'Whether the assistant stops to ask before it applies a change. Off by default: the confirmation step is opt-in.';

-- ---------------------------------------------------------------------------
-- Internal helper. Revoked from every role including service_role: it is called
-- only by app_update_preferences, never over the API.
-- ---------------------------------------------------------------------------

-- One switch out of a patch. A key that is absent keeps the value it had; a key
-- that is present has to be an actual JSON boolean, because `"false"` and `0`
-- are the two ways a form silently turns a setting on.
create function public.app_preference_flag(p_patch jsonb, p_key text, p_current boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if not (p_patch ? p_key) then
    return p_current;
  end if;
  if pg_catalog.jsonb_typeof(p_patch -> p_key) <> 'boolean' then
    raise exception 'Send true or false for %.', pg_catalog.replace(p_key, '_', ' ')
      using errcode = 'check_violation';
  end if;
  return (p_patch ->> p_key)::boolean;
end;
$$;

comment on function public.app_preference_flag(jsonb, text, boolean) is
  'Trusted internal helper: reads one boolean preference out of a patch, keeping the current value when the key is absent and refusing anything that is not a JSON boolean.';

-- ---------------------------------------------------------------------------
-- Preference RPCs. Both mutate, so both re-derive the actor inside the database
-- through app_require_actor(), which refuses an inactive, setup_pending,
-- pending_approval, denied, credential-pending or stale-token session.
-- ---------------------------------------------------------------------------

create function public.app_my_preferences()
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

create function public.app_update_preferences(p_patch jsonb)
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
    if v_reasoning is null or v_reasoning not in ('low', 'medium', 'high', 'xhigh') then
      raise exception 'Choose a reasoning level: low, medium, high or xhigh.'
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

-- The one piece of an account a technician may change about themselves. It is
-- not a preference — it is the name every history entry renders — so it lives in
-- app_accounts and the change is recorded.
create function public.app_update_display_name(p_name text)
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

  v_name := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  if v_name is null
    or pg_catalog.length(v_name) < 2
    or pg_catalog.length(v_name) > 80
  then
    raise exception 'A display name has to be between 2 and 80 characters.'
      using errcode = 'check_violation';
  end if;

  -- Re-saving the name you already have is not a change, so nothing is written
  -- and nothing is recorded.
  if v_name = v_actor.display_name then
    return;
  end if;

  update public.app_accounts a
  set display_name = v_name
  where a.id = v_actor.id;

  -- The NEW name only. Account history is readable by administrators, and there
  -- is no reason for the name somebody used to go by to follow them through it.
  perform public.app_log_record_event(
    'account', v_actor.id, 'renamed', v_actor.id,
    'Display name changed to ' || v_name || '.'
  );
end;
$$;

comment on function public.app_update_display_name(text) is
  'Changes the caller''s own display name, trimmed, between 2 and 80 characters. Records the change against the account with the new name only.';

-- ---------------------------------------------------------------------------
-- The Codex connection
--
-- Row-level security is enabled and NO policy is created, which with the revokes
-- below means anon and authenticated cannot read, write or even learn that a row
-- exists. The application writes this table with the service key, having already
-- encrypted the token payload.
-- ---------------------------------------------------------------------------

create table public.ai_connections (
  account_id uuid primary key references public.app_accounts (id) on delete cascade,
  provider text not null default 'codex' check (provider = 'codex'),
  -- base64 AES-256-GCM of { access_token, refresh_token, id_token, expires_at }.
  -- Encrypted before it arrives; the database never sees the plaintext and never
  -- hands this column back to a session.
  ciphertext text not null,
  chatgpt_account_id text,
  account_email text,
  plan_type text,
  connected_at timestamptz not null default now(),
  last_refreshed_at timestamptz,
  last_used_at timestamptz
);

comment on table public.ai_connections is
  'One linked ChatGPT account per helpdesk account, holding an encrypted OAuth token. Service role only: RLS is on and there are deliberately no policies, so no client role can reach a row. app_my_ai_connection() is the whole of what a session may learn.';
comment on column public.ai_connections.ciphertext is
  'Encrypted token payload. Never returned to a session by any function in this schema.';

-- SECURITY DEFINER so it can read a table no client role may touch, and written
-- so the ciphertext is not in its result type at all — it cannot be leaked by a
-- later edit that forgets to exclude a column.
create function public.app_my_ai_connection()
returns table (
  connected boolean,
  account_email text,
  plan_type text,
  connected_at timestamptz,
  last_used_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account uuid;
begin
  v_account := public.app_active_account_id();
  -- No rows at all for an anonymous, inactive, setup_pending, pending_approval,
  -- denied, credential-pending or stale-token caller: they are not told even
  -- that the question has an answer.
  if v_account is null then
    return;
  end if;

  return query
    select true, c.account_email, c.plan_type, c.connected_at, c.last_used_at
    from public.ai_connections c
    where c.account_id = v_account;

  -- RETURN QUERY sets FOUND, so "no connection" is one row saying so rather than
  -- an empty result the caller would have to interpret.
  if not found then
    return query
      select false, null::text, null::text, null::timestamptz, null::timestamptz;
  end if;
end;
$$;

comment on function public.app_my_ai_connection() is
  'Whether the caller has linked a ChatGPT account, and the harmless details of it. Never returns the ciphertext. Returns no rows at all for an account that is not active.';

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create table public.ai_conversations (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.app_accounts (id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ai_conversations is
  'One assistant conversation, belonging to one account. Written directly by the signed-in session; the policies below are what keep it private.';

create index ai_conversations_account_idx
  on public.ai_conversations (account_id, updated_at desc, id);

create table public.ai_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  role text not null,
  -- The Responses API input item(s) for this turn, stored as sent.
  content jsonb not null,
  created_at timestamptz not null default now(),
  constraint ai_messages_role_valid check (role in ('user', 'assistant', 'tool', 'system'))
);

comment on table public.ai_messages is
  'The turns of one conversation. Reachable only through the conversation that owns them, and deleted with it.';

create index ai_messages_conversation_idx
  on public.ai_messages (conversation_id, created_at, id);

-- A conversation's `updated_at` is what orders the sidebar, so it has to follow
-- the last turn rather than the last time somebody renamed the thread. SECURITY
-- DEFINER because the row being touched is the parent named by the message, and
-- the message may equally have been written by the server with the service key.
create function public.app_touch_ai_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_conversations c
  set updated_at = pg_catalog.now()
  where c.id = new.conversation_id;
  return new;
end;
$$;

create trigger ai_conversations_touch
after insert on public.ai_messages
for each row execute function public.app_touch_ai_conversation();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.account_preferences enable row level security;
alter table public.ai_connections enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;

-- Own row only, and no administrator exception: settings are personal.
-- app_active_account_id() returns NULL for every restricted caller, and
-- `account_id = NULL` is NULL rather than true, so this fails closed.
create policy account_preferences_select_own
  on public.account_preferences for select to authenticated
  using (account_id = public.app_active_account_id());

-- Deliberately absent: INSERT, UPDATE and DELETE policies on
-- account_preferences. app_my_preferences and app_update_preferences are the
-- only ways in, so the vocabulary checks above cannot be walked around.

-- Deliberately absent: EVERY policy on ai_connections. See the table comment.

-- Conversations and messages are the exception documented in the header: the
-- session writes them itself, so each policy binds rather than filters.
create policy ai_conversations_select_own
  on public.ai_conversations for select to authenticated
  using (account_id = public.app_active_account_id());

-- `with check` pins the new row to the caller, so a conversation cannot be
-- opened in somebody else's name.
create policy ai_conversations_insert_own
  on public.ai_conversations for insert to authenticated
  with check (account_id = public.app_active_account_id());

-- Both halves: `using` decides which rows may be changed, `with check` decides
-- what they may become, which is what stops a conversation being moved to
-- another account.
create policy ai_conversations_update_own
  on public.ai_conversations for update to authenticated
  using (account_id = public.app_active_account_id())
  with check (account_id = public.app_active_account_id());

create policy ai_conversations_delete_own
  on public.ai_conversations for delete to authenticated
  using (account_id = public.app_active_account_id());

-- A message has no account of its own: it belongs to whoever owns the
-- conversation, and this predicate is the only place that is decided.
create policy ai_messages_select_own
  on public.ai_messages for select to authenticated
  using (
    exists (
      select 1
      from public.ai_conversations c
      where c.id = conversation_id
        and c.account_id = public.app_active_account_id()
    )
  );

create policy ai_messages_insert_own
  on public.ai_messages for insert to authenticated
  with check (
    exists (
      select 1
      from public.ai_conversations c
      where c.id = conversation_id
        and c.account_id = public.app_active_account_id()
    )
  );

create policy ai_messages_update_own
  on public.ai_messages for update to authenticated
  using (
    exists (
      select 1
      from public.ai_conversations c
      where c.id = conversation_id
        and c.account_id = public.app_active_account_id()
    )
  )
  with check (
    exists (
      select 1
      from public.ai_conversations c
      where c.id = conversation_id
        and c.account_id = public.app_active_account_id()
    )
  );

create policy ai_messages_delete_own
  on public.ai_messages for delete to authenticated
  using (
    exists (
      select 1
      from public.ai_conversations c
      where c.id = conversation_id
        and c.account_id = public.app_active_account_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so every table is revoked explicitly and then re-granted.
-- anon gets nothing at all, anywhere.
-- ---------------------------------------------------------------------------

revoke all on table
  public.account_preferences,
  public.ai_connections,
  public.ai_conversations,
  public.ai_messages
from anon, authenticated;

grant select on table public.account_preferences to authenticated;

-- ai_connections is granted to nobody. service_role keeps the access Supabase
-- gives it by default, which is how the server writes a linked connection.

-- The direct-write exception, and the only one in this schema.
grant select, insert, update, delete on table
  public.ai_conversations,
  public.ai_messages
to authenticated;

-- The patch helper and the trigger function are callable only by the code that
-- owns them. service_role is named explicitly: Supabase's default privileges
-- GRANT ALL ON FUNCTIONS to it directly, so it does not lose EXECUTE when the
-- grant to PUBLIC is revoked.
revoke execute on function
  public.app_preference_flag(jsonb, text, boolean),
  public.app_touch_ai_conversation()
from public, anon, authenticated, service_role;

revoke execute on function
  public.app_my_preferences(),
  public.app_update_preferences(jsonb),
  public.app_update_display_name(text),
  public.app_my_ai_connection()
from public, anon;

grant execute on function
  public.app_my_preferences(),
  public.app_update_preferences(jsonb),
  public.app_update_display_name(text),
  public.app_my_ai_connection()
to authenticated;
