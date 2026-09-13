-- M5 foundation: notifications, record events, and AI attribution.
--
-- Additive only. Everything M2/M3 established stays in force: identity is
-- auth.uid() only, clients get SELECT and nothing else, every write goes through
-- a SECURITY DEFINER RPC that re-derives the actor inside the database, and
-- history is append-only.
--
-- Three pieces land here because the later people/device/invite/audit migrations
-- all build on them:
--
--   1. `notifications` — per-account, private, written only by trusted code.
--   2. `record_events` — the append-only history for non-ticket records
--      (people, devices, invites, imports, accounts), mirroring what
--      `activity_events` does for tickets.
--   3. Attribution — every event now records whether it was performed by a
--      person working directly or by an AI assistant acting on their behalf,
--      and which model that was.
--
-- Attribution trust model. The declaration arrives as a REQUEST HEADER
-- (`x-edison-via`, `x-edison-ai-model`), which PostgREST publishes to SQL as the
-- `request.headers` setting. It is deliberately NOT an RPC argument: a header is
-- set once per client, so every call an assistant makes is stamped without each
-- RPC having to grow a parameter that a caller could then forget or omit.
--
-- A header cannot be trusted to tell the truth, so it is never allowed to reduce
-- accountability. It can only ADD the "an assistant did this" mark: anything
-- other than the exact value `ai` records an ordinary user action, and the actor
-- id always remains the authenticated account. A forged header can therefore
-- claim an assistant did work a person did (a claim that gains the caller
-- nothing), but it can never hide that the account was responsible.

-- ---------------------------------------------------------------------------
-- Request attribution helpers
-- ---------------------------------------------------------------------------

-- The request headers as jsonb, or NULL when there are none.
--
-- `current_setting(..., true)` returns NULL outside a PostgREST request (a
-- migration, psql, a trigger running in a background job), so the helpers below
-- must be NULL-safe rather than assume a request context exists. The validity
-- check keeps a malformed setting from raising inside an unrelated mutation:
-- attribution is metadata, and failing to parse it must never abort the write it
-- describes. PostgREST always writes valid JSON here; this is the fail-safe.
create or replace function public.app_request_headers()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case
    when pg_catalog.pg_input_is_valid(
      nullif(pg_catalog.current_setting('request.headers', true), ''),
      'jsonb'
    )
    then nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb
  end;
$$;

comment on function public.app_request_headers() is
  'The current PostgREST request headers as jsonb, or NULL when absent or unparseable. Header names arrive lower-cased.';

-- 'ai' only for the exact declared value; everything else is a user action.
create or replace function public.app_request_via()
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(public.app_request_headers() ->> 'x-edison-via', '') = 'ai'
    then 'ai'
    else 'user'
  end;
$$;

comment on function public.app_request_via() is
  'Whether this request declared itself an AI-assisted action. Fails closed to ''user''; never changes who the actor is.';

-- Only meaningful for an AI request, and bounded so a long header cannot bloat
-- the history tables.
create or replace function public.app_request_ai_model()
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when public.app_request_via() = 'ai'
    then pg_catalog.left(public.app_request_headers() ->> 'x-edison-ai-model', 80)
  end;
$$;

comment on function public.app_request_ai_model() is
  'The model name declared by an AI-assisted request, truncated to 80 characters. NULL for an ordinary user action.';

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.app_accounts (id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  href text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

comment on table public.notifications is
  'Per-account in-app notices. Private to their account, written only by trusted server-side code, and never a place for a credential or a link token.';
comment on column public.notifications.href is
  'Relative in-app path the notice points at. Never an external or credential-bearing URL.';

-- The unread badge is the hottest read, so it gets a partial index; the full
-- list is served newest-first from the second one.
create index notifications_account_unread_idx
  on public.notifications (account_id, created_at desc)
  where read_at is null;

create index notifications_account_idx
  on public.notifications (account_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Record events: append-only history for non-ticket records
-- ---------------------------------------------------------------------------

create table public.record_events (
  id uuid primary key default extensions.gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  kind text not null,
  -- Null actor means the change came from a trusted server flow rather than an
  -- administrator acting in their own session.
  actor_id uuid references public.app_accounts (id) on delete restrict,
  performed_via text not null default 'user',
  ai_model text,
  at timestamptz not null default now(),
  summary text not null,
  detail text,
  constraint record_events_entity_type_valid check (
    entity_type in ('person', 'device', 'invite', 'import', 'account')
  ),
  constraint record_events_performed_via_valid check (performed_via in ('user', 'ai'))
);

comment on table public.record_events is
  'Append-only history for people, devices, invites, imports and accounts. Detail text must never contain a link, token, or password.';

create index record_events_entity_idx on public.record_events (entity_type, entity_id, at);

-- Applies to every role including the definer used by the RPCs, so no code path
-- can quietly rewrite or erase history.
create trigger record_events_append_only
before update or delete on public.record_events
for each row execute function public.app_append_only();

-- ---------------------------------------------------------------------------
-- Attribution on ticket activity
-- ---------------------------------------------------------------------------

alter table public.activity_events
  add column performed_via text not null default 'user',
  add column ai_model text,
  add constraint activity_events_performed_via_valid check (performed_via in ('user', 'ai'));

comment on column public.activity_events.performed_via is
  'Whether a person performed this directly or an AI assistant did it on their behalf. The actor is the responsible account either way.';
comment on column public.activity_events.ai_model is
  'Model declared by an AI-assisted request. NULL for an ordinary user action.';

-- ---------------------------------------------------------------------------
-- Writers. All SECURITY DEFINER, all revoked from every client role: they are
-- called only from other trusted functions, never from a session.
-- ---------------------------------------------------------------------------

-- Same signature as M2 (so every existing caller is untouched), now stamping
-- attribution read from the request rather than from any argument.
create or replace function public.app_log_event(
  p_ticket uuid,
  p_kind text,
  p_actor uuid,
  p_summary text,
  p_detail text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.activity_events (
    ticket_id, kind, actor_id, summary, detail, performed_via, ai_model
  )
  values (
    p_ticket, p_kind, p_actor, p_summary, nullif(pg_catalog.btrim(p_detail), ''),
    public.app_request_via(), public.app_request_ai_model()
  );
$$;

create or replace function public.app_log_record_event(
  p_entity_type text,
  p_entity_id uuid,
  p_kind text,
  p_actor uuid,
  p_summary text,
  p_detail text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.record_events (
    entity_type, entity_id, kind, actor_id, summary, detail, performed_via, ai_model
  )
  values (
    p_entity_type, p_entity_id, p_kind, p_actor, p_summary,
    nullif(pg_catalog.btrim(p_detail), ''),
    public.app_request_via(), public.app_request_ai_model()
  );
$$;

create or replace function public.app_notify(
  p_account uuid,
  p_kind text,
  p_title text,
  p_body text default null,
  p_href text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (account_id, kind, title, body, href)
  values (
    p_account, p_kind, p_title,
    nullif(pg_catalog.btrim(p_body), ''),
    nullif(pg_catalog.btrim(p_href), '')
  );
$$;

-- Active administrators only: a deactivated or setup_pending account must not
-- accumulate notices it has no way to read.
create or replace function public.app_notify_admins(
  p_kind text,
  p_title text,
  p_body text default null,
  p_href text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (account_id, kind, title, body, href)
  select a.id, p_kind, p_title,
         nullif(pg_catalog.btrim(p_body), ''),
         nullif(pg_catalog.btrim(p_href), '')
  from public.app_accounts a
  where a.role = 'admin'
    and a.status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- Reads. SECURITY INVOKER (the default) on purpose: they run with the caller's
-- privileges, so the row-level security policies below apply to every row they
-- return, and the account filter is a second, independent gate.
-- ---------------------------------------------------------------------------

create or replace function public.app_notifications(
  p_limit integer default 20,
  p_unread_only boolean default false
)
returns setof public.notifications
language sql
stable
set search_path = ''
as $$
  select n.*
  from public.notifications n
  where n.account_id = public.app_active_account_id()
    and (not coalesce(p_unread_only, false) or n.read_at is null)
  -- id breaks ties so paging is deterministic when two notices share an instant.
  order by n.created_at desc, n.id desc
  limit greatest(0, least(coalesce(p_limit, 20), 100));
$$;

comment on function public.app_notifications(integer, boolean) is
  'The caller''s own notifications, newest first. Returns no rows for an anonymous, inactive or setup_pending account.';

create or replace function public.app_unread_notification_count()
returns integer
language sql
stable
set search_path = ''
as $$
  select pg_catalog.count(*)::integer
  from public.notifications n
  where n.account_id = public.app_active_account_id()
    and n.read_at is null;
$$;

-- Mutating, so it follows the M2/M3 contract: the actor is re-derived inside the
-- database by app_require_actor(), which also takes the shared advisory lock and
-- refuses an inactive, setup_pending, credential-pending or stale-token session.
create or replace function public.app_mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_count integer;
begin
  v_actor := public.app_require_actor();

  -- A NULL id array marks everything; ids belonging to another account simply do
  -- not match, so a caller learns nothing from the returned count.
  update public.notifications n
  set read_at = now()
  where n.account_id = v_actor.id
    and n.read_at is null
    and (p_ids is null or n.id = any (p_ids));

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.app_mark_notifications_read(uuid[]) is
  'Marks the caller''s own unread notifications read. NULL marks all of them. Returns how many rows changed.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.notifications enable row level security;
alter table public.record_events enable row level security;

-- Own rows only. app_active_account_id() returns NULL for an anonymous,
-- inactive, setup_pending, credential-pending or stale-token caller, and
-- `account_id = NULL` is NULL rather than true, so the comparison fails closed.
create policy notifications_select_own
  on public.notifications for select to authenticated
  using (account_id = public.app_active_account_id());

-- Defence in depth. `authenticated` holds no UPDATE privilege on this table (see
-- the grants below): read state is changed through app_mark_notifications_read()
-- like every other write in this schema. The policy exists so that if a future
-- grant were ever added, it could still only touch the caller's own rows and
-- could never move a row to another account.
create policy notifications_update_own
  on public.notifications for update to authenticated
  using (account_id = public.app_active_account_id())
  with check (account_id = public.app_active_account_id());

-- Deliberately absent: INSERT and DELETE policies. Notices are created by
-- trusted code and are never erased from a session.

-- People and devices are shared helpdesk records, so their history is readable
-- by any active account. Account history stays with administrators, matching the
-- account_events policy from M3.
create policy record_events_select_visible
  on public.record_events for select to authenticated
  using (
    public.app_active_account_id() is not null
    and (entity_type in ('person', 'device') or public.app_is_admin())
  );

-- ---------------------------------------------------------------------------
-- Grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so both tables are revoked explicitly and then re-granted
-- read-only. anon gets nothing at all.
-- ---------------------------------------------------------------------------

revoke all on table
  public.notifications,
  public.record_events
from anon, authenticated;

grant select on table
  public.notifications,
  public.record_events
to authenticated;

-- app_log_event keeps its M2 revoke list unchanged: the signature and every
-- caller are the same, only the row it writes has grown two columns.
revoke execute on function
  public.app_log_event(uuid, text, uuid, text, text)
from public, anon, authenticated;

-- The new writers and the request helpers they use are callable only by the
-- functions that own them, never over the API by any role.
--
-- service_role is named explicitly. Supabase's default privileges GRANT ALL ON
-- FUNCTIONS to service_role directly, so it does not lose EXECUTE when the
-- grant to PUBLIC is revoked, and a revoke that omits it leaves these callable
-- with the server's secret key.
revoke execute on function
  public.app_request_headers(),
  public.app_request_via(),
  public.app_request_ai_model(),
  public.app_log_record_event(text, uuid, text, uuid, text, text),
  public.app_notify(uuid, text, text, text, text),
  public.app_notify_admins(text, text, text, text)
from public, anon, authenticated, service_role;

-- Reads and the one notification mutation are for signed-in accounts; anon gets
-- nothing.
revoke execute on function
  public.app_notifications(integer, boolean),
  public.app_unread_notification_count(),
  public.app_mark_notifications_read(uuid[])
from public, anon;

grant execute on function
  public.app_notifications(integer, boolean),
  public.app_unread_notification_count(),
  public.app_mark_notifications_read(uuid[])
to authenticated;
