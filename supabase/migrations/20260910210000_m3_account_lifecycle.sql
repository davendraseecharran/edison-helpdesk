-- M3: trusted account lifecycle, credential grants, and session invalidation.
--
-- Additive only. Every M2 rule stays in force, including the NULL-safe checks
-- from migration 006 and the advisory-lock protocol from migration 007
-- (namespace 1162103123 / 1): shared lock for mutations, exclusive lock for
-- anything that changes an account's access, taken BEFORE authorization is read.
--
-- Two new access gates on top of M2's `status = 'active'`:
--
--   1. credential_action_pending — an account with an outstanding setup or
--      recovery link cannot touch helpdesk records until that action completes.
--      This is what stops a stolen recovery link from granting ordinary ticket
--      access before the password is actually changed.
--
--   2. sessions_valid_from — access tokens issued before this instant are
--      refused. Supabase access tokens are self-contained JWTs that stay
--      cryptographically valid until they expire (jwt_expiry = 3600 locally), and
--      the admin API in @supabase/supabase-js 2.116 can only revoke a session
--      given that session's own JWT. So provider-side revocation alone cannot
--      invalidate another browser's outstanding access token, and the required
--      invalidation is enforced here instead.
--      Reference: https://supabase.com/docs/guides/auth/sessions

alter table public.app_accounts
  add column credential_action_pending boolean not null default false,
  -- Epoch default (not -infinity) keeps extract(epoch ...) a finite number.
  add column sessions_valid_from timestamptz not null default to_timestamp(0);

comment on column public.app_accounts.credential_action_pending is
  'True while a setup or recovery link is outstanding. Blocks all helpdesk access until the action completes or an admin cancels it.';
comment on column public.app_accounts.sessions_valid_from is
  'Access tokens with iat earlier than this instant are refused, giving database-enforced session invalidation.';

-- ---------------------------------------------------------------------------
-- Provisioning reservations: authorization happens in the admin's own session,
-- before any provider admin credential is used.
-- ---------------------------------------------------------------------------

create table public.account_provisions (
  id uuid primary key default extensions.gen_random_uuid(),
  email text not null,
  display_name text not null,
  requested_by uuid not null references public.app_accounts (id) on delete restrict,
  requested_at timestamptz not null default now(),
  -- 'reserved' until the auth user exists and the account row is written.
  state text not null default 'reserved',
  account_id uuid references public.app_accounts (id) on delete restrict,
  completed_at timestamptz,
  constraint account_provisions_email_unique unique (email),
  constraint account_provisions_email_shape check (email = lower(btrim(email))),
  constraint account_provisions_state_valid check (state in ('reserved', 'completed')),
  constraint account_provisions_completion check (
    (state = 'completed') = (account_id is not null and completed_at is not null)
  )
);

comment on table public.account_provisions is
  'One row per account an admin asked for. Unique email makes a retried or duplicated provision idempotent rather than creating a second account.';

-- ---------------------------------------------------------------------------
-- Credential grants: the app-side record of an issued setup/recovery link.
-- NO token, hash, or link is ever stored here. The provider holds the secret;
-- this table only tracks that a link exists, when it expires, whether it has
-- been exchanged, and whether it has been used or superseded.
-- ---------------------------------------------------------------------------

create table public.account_credential_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.app_accounts (id) on delete restrict,
  purpose text not null,
  issued_by uuid not null references public.app_accounts (id) on delete restrict,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Set when the link is exchanged for a session (proves link possession).
  verified_at timestamptz,
  -- Set when the password was actually changed and the action completed.
  consumed_at timestamptz,
  -- Set when a newer grant replaces this one.
  superseded_at timestamptz,
  constraint account_credential_grants_purpose_valid check (purpose in ('setup', 'recovery')),
  constraint account_credential_grants_expiry_future check (expires_at > issued_at),
  constraint account_credential_grants_consumed_after_verified check (
    consumed_at is null or verified_at is not null
  )
);

comment on table public.account_credential_grants is
  'Lifecycle of an admin-issued setup/recovery link. Never stores the link, its token, or its hash.';

-- At most ONE live grant per account, whatever its purpose. Both setup and
-- recovery ride on the provider's `recovery` token type (an `invite` link
-- cannot be generated for an already-registered user), so the app-level purpose
-- must be derived from this row rather than trusted from a callback URL. One
-- live grant per account makes that derivation unambiguous and removes any
-- "wrong purpose" confusion entirely.
create unique index account_credential_grants_live_idx
  on public.account_credential_grants (account_id)
  where consumed_at is null and superseded_at is null;

-- ---------------------------------------------------------------------------
-- Account audit trail. Append-only, no credentials, admin-readable.
-- ---------------------------------------------------------------------------

create table public.account_events (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.app_accounts (id) on delete restrict,
  kind text not null,
  -- Null actor means the action was completed by the account holder themselves
  -- through a trusted flow rather than by an administrator.
  actor_id uuid references public.app_accounts (id) on delete restrict,
  at timestamptz not null default now(),
  detail text,
  constraint account_events_kind_valid check (
    kind in (
      'account_provisioned', 'setup_issued', 'setup_verified', 'setup_completed',
      'recovery_issued', 'recovery_verified', 'recovery_completed',
      'credential_action_cancelled', 'status_changed', 'sessions_invalidated'
    )
  )
);

create index account_events_account_idx on public.account_events (account_id, at);

comment on table public.account_events is
  'Append-only account audit. Detail text must never contain a link, token, or password.';

create trigger account_events_append_only
before update or delete on public.account_events
for each row execute function public.app_append_only();

create trigger account_credential_grants_no_delete
before delete on public.account_credential_grants
for each row execute function public.app_append_only();

-- ---------------------------------------------------------------------------
-- Access gates: add the two new conditions to every identity helper.
-- ---------------------------------------------------------------------------

-- Rejects an access token minted before the account's invalidation cutoff.
--
-- The JWT `iat` claim has one-second granularity, so the comparison is STRICTLY
-- greater than the cutoff second. A token minted in the same second as the
-- cutoff is refused rather than accepted: the control fails closed, and the
-- result does not depend on sub-second timing. The cost is that a session
-- created in the cutoff second is also refused, which is why completing a setup
-- or recovery signs the account out and asks it to sign in again.
create or replace function public.app_token_is_current(p_account public.app_accounts)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    -- No cutoff has ever been set for this account, so there is nothing to
    -- revoke. This is a revocation control, not an authentication one:
    -- authentication already happened before auth.uid() was populated, and a
    -- caller whose claims carry no `iat` must not be refused on that basis alone.
    when p_account.sessions_valid_from <= pg_catalog.to_timestamp(0) then true
    else coalesce(
      (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'iat')::bigint,
      0
    ) > pg_catalog.floor(pg_catalog.date_part('epoch', p_account.sessions_valid_from))
  end;
$$;

comment on function public.app_token_is_current(public.app_accounts) is
  'False when the caller presents an access token issued before the account''s sessions_valid_from cutoff.';

create or replace function public.app_active_account_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id
  from public.app_accounts a
  where a.id = (select auth.uid())
    and a.status = 'active'
    -- An outstanding setup/recovery link suspends ordinary access.
    and a.credential_action_pending = false
    and public.app_token_is_current(a);
$$;

create or replace function public.app_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_accounts a
    where a.id = (select auth.uid())
      and a.status = 'active'
      and a.role = 'admin'
      and a.credential_action_pending = false
      and public.app_token_is_current(a)
  );
$$;

-- Keeps migration 007's advisory-lock protocol and adds the two new gates.
create or replace function public.app_require_actor()
returns public.app_accounts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
begin
  -- Serialize against account-status and credential changes before reading
  -- authorization. Shared lock: ticket writes still run in parallel.
  perform pg_catalog.pg_advisory_xact_lock_shared(1162103123, 1);

  select * into v_actor
  from public.app_accounts a
  where a.id = (select auth.uid());

  if not found or v_actor.status <> 'active' then
    raise exception 'This account cannot access helpdesk records.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_actor.credential_action_pending then
    raise exception 'Finish setting your password before using the helpdesk.'
      using errcode = 'insufficient_privilege';
  end if;

  if not public.app_token_is_current(v_actor) then
    raise exception 'This session has been signed out. Sign in again.'
      using errcode = 'insufficient_privilege';
  end if;

  return v_actor;
end;
$$;

-- ---------------------------------------------------------------------------
-- Self status: extended so a restricted account can be routed correctly.
-- Still the caller's own row only, and still no ticket information.
-- ---------------------------------------------------------------------------

-- Adding OUT columns changes the row type, so the M2 signature is dropped
-- first. The grant is re-applied below with the other M3 grants.
drop function if exists public.app_my_account();

create function public.app_my_account()
returns table (
  id uuid,
  display_name text,
  email text,
  role text,
  status text,
  credential_action_pending boolean,
  session_is_current boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.display_name, a.email, a.role, a.status,
         a.credential_action_pending,
         public.app_token_is_current(a)
  from public.app_accounts a
  where a.id = (select auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Admin-authorized requests. These run in the ADMIN'S OWN SESSION so the
-- authorization decision is made from auth.uid() inside the database, before
-- any provider admin credential is used by the server.
-- ---------------------------------------------------------------------------

create or replace function public.app_admin_request_account(
  p_email text,
  p_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_display_name, ''));
  v_provision public.account_provisions;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can create accounts.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Enter a valid school email address.' using errcode = 'check_violation';
  end if;
  if length(v_name) = 0 then
    raise exception 'Enter the technician name.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.app_accounts a where a.email = v_email) then
    raise exception 'An account already uses that email address.' using errcode = 'check_violation';
  end if;

  -- Retrying a half-finished provision returns the same reservation instead of
  -- creating a second one.
  select * into v_provision
  from public.account_provisions p
  where p.email = v_email
  for update;

  if found then
    if v_provision.state = 'completed' then
      raise exception 'An account already uses that email address.' using errcode = 'check_violation';
    end if;
    update public.account_provisions
    set display_name = v_name, requested_by = v_actor.id, requested_at = now()
    where id = v_provision.id;
    return v_provision.id;
  end if;

  insert into public.account_provisions (email, display_name, requested_by)
  values (v_email, v_name, v_actor.id)
  returning id into v_provision.id;

  return v_provision.id;
end;
$$;

create or replace function public.app_admin_request_credential_grant(
  p_account uuid,
  p_purpose text,
  p_ttl_seconds integer default 3600
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_target public.app_accounts;
  v_grant_id uuid;
begin
  -- Exclusive first, matching migration 007: this changes account access state.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can issue setup or recovery links.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_purpose is null or p_purpose not in ('setup', 'recovery') then
    raise exception 'Choose setup or recovery.' using errcode = 'check_violation';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'Link lifetime must be between 1 minute and 24 hours.' using errcode = 'check_violation';
  end if;

  select * into v_target
  from public.app_accounts a
  where a.id = p_account
  for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  if v_target.id = v_actor.id then
    raise exception 'Ask another administrator to issue your own link.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_purpose = 'setup' and v_target.status <> 'setup_pending' then
    raise exception 'That account has already completed setup. Issue a recovery link instead.'
      using errcode = 'check_violation';
  end if;
  if p_purpose = 'recovery' and v_target.status = 'setup_pending' then
    raise exception 'That account has not completed setup. Issue a setup link instead.'
      using errcode = 'check_violation';
  end if;
  if p_purpose = 'recovery' and v_target.status = 'inactive' then
    raise exception 'Reactivate the account before issuing a recovery link.'
      using errcode = 'check_violation';
  end if;

  -- Issuing a new link supersedes every earlier unconsumed one for this
  -- account. Verified against the provider: generating a new link invalidates
  -- the previous token, so the app record and the provider agree.
  update public.account_credential_grants
  set superseded_at = now()
  where account_id = v_target.id
    and consumed_at is null
    and superseded_at is null;

  insert into public.account_credential_grants (account_id, purpose, issued_by, expires_at)
  values (v_target.id, p_purpose, v_actor.id, now() + make_interval(secs => p_ttl_seconds))
  returning id into v_grant_id;

  -- Suspend ordinary access until the action completes. For a setup_pending
  -- account this changes nothing (it had no access); for recovery it is what
  -- stops a stolen link from reaching tickets before the password changes.
  update public.app_accounts
  set credential_action_pending = true,
      last_credential_action_at = now(),
      last_credential_action_kind = case when p_purpose = 'setup' then 'setup_issued' else 'recovery_issued' end
  where id = v_target.id;

  insert into public.account_events (account_id, kind, actor_id, detail)
  values (
    v_target.id,
    case when p_purpose = 'setup' then 'setup_issued' else 'recovery_issued' end,
    v_actor.id,
    'Link issued for private delivery; expires in ' || p_ttl_seconds || ' seconds.'
  );

  return v_grant_id;
end;
$$;

-- Lets an admin undo an accidental link without waiting for it to expire.
create or replace function public.app_admin_cancel_credential_action(p_account uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_target public.app_accounts;
begin
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can cancel a credential action.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_target
  from public.app_accounts a
  where a.id = p_account
  for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  if not v_target.credential_action_pending then
    raise exception 'That account has no outstanding link.' using errcode = 'check_violation';
  end if;
  -- A pending account has no password yet; cancelling would strand it.
  if v_target.status = 'setup_pending' then
    raise exception 'A pending account needs a setup link. Issue a replacement instead.'
      using errcode = 'check_violation';
  end if;

  update public.account_credential_grants
  set superseded_at = now()
  where account_id = v_target.id and consumed_at is null and superseded_at is null;

  update public.app_accounts
  set credential_action_pending = false
  where id = v_target.id;

  insert into public.account_events (account_id, kind, actor_id, detail)
  values (v_target.id, 'credential_action_cancelled', v_actor.id, 'Outstanding link cancelled by an administrator.');

  return v_target.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trusted server operations. Granted to service_role ONLY: there is no
-- auth.uid() on these calls, so the Next.js server passes ids it has already
-- verified from a session. They are never exposed to `authenticated`, so a
-- browser cannot reach them even with a forged body.
-- ---------------------------------------------------------------------------

create or replace function public.app_trusted_finalize_account(
  p_provision uuid,
  p_user uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provision public.account_provisions;
begin
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  select * into v_provision
  from public.account_provisions p
  where p.id = p_provision
  for update;

  if not found then
    raise exception 'That provisioning request no longer exists.' using errcode = 'check_violation';
  end if;

  -- Idempotent: a retry after a partial failure returns the same account.
  if v_provision.state = 'completed' then
    return v_provision.account_id;
  end if;

  insert into public.app_accounts (id, display_name, email, role, status)
  values (p_user, v_provision.display_name, v_provision.email, 'technician', 'setup_pending')
  on conflict (id) do update
    set display_name = excluded.display_name
  returning id into p_user;

  update public.account_provisions
  set state = 'completed', account_id = p_user, completed_at = now()
  where id = v_provision.id;

  insert into public.account_events (account_id, kind, actor_id, detail)
  values (p_user, 'account_provisioned', v_provision.requested_by, 'Account created with setup pending.');

  return p_user;
end;
$$;

-- Records that a link was successfully exchanged for a session. The account id
-- comes from the server's verified session, never from a request body.
create or replace function public.app_trusted_verify_grant(p_account uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant public.account_credential_grants;
begin
  -- The purpose is read from the stored grant, never from the caller, so a
  -- forged `type` in the callback URL cannot select a different flow.
  select * into v_grant
  from public.account_credential_grants g
  where g.account_id = p_account
    and g.consumed_at is null
    and g.superseded_at is null
  for update;

  if not found then
    raise exception 'This link is no longer valid. Ask an administrator for a new one.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_grant.expires_at <= now() then
    raise exception 'This link has expired. Ask an administrator for a new one.'
      using errcode = 'insufficient_privilege';
  end if;

  update public.account_credential_grants
  set verified_at = coalesce(verified_at, now())
  where id = v_grant.id;

  insert into public.account_events (account_id, kind, detail)
  values (
    p_account,
    case when v_grant.purpose = 'setup' then 'setup_verified' else 'recovery_verified' end,
    'Link exchanged for a restricted session.'
  );

  return v_grant.purpose;
end;
$$;

-- The only path that can activate a setup_pending account. It requires a
-- verified, unexpired, unconsumed grant AND is called only after the provider
-- reported a successful password change, so authentication alone, a submitted
-- account id, or an ordinary status change can never activate an account.
create or replace function public.app_trusted_complete_credential_action(
  p_account uuid
)
returns table (account_id uuid, purpose text, status text, sessions_valid_from timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.app_accounts;
  v_grant public.account_credential_grants;
  v_cutoff timestamptz := now();
begin
  -- Exclusive: this changes account access state (migration 007 protocol).
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  select * into v_account
  from public.app_accounts a
  where a.id = p_account
  for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;

  select * into v_grant
  from public.account_credential_grants g
  where g.account_id = p_account
    and g.consumed_at is null
    and g.superseded_at is null
    and g.verified_at is not null
  for update;

  -- Fails closed: no verified grant means no activation, whatever else happened.
  if not found then
    raise exception 'This link is no longer valid. Ask an administrator for a new one.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_grant.expires_at <= now() then
    raise exception 'This link has expired. Ask an administrator for a new one.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_grant.purpose = 'setup' then
    if v_account.status <> 'setup_pending' then
      raise exception 'That account is not awaiting setup.' using errcode = 'check_violation';
    end if;
    update public.app_accounts
    set status = 'active',
        credential_action_pending = false,
        sessions_valid_from = v_cutoff
    where id = v_account.id;
  else
    -- Recovery changes the password only. It never promotes a role and never
    -- reactivates a deactivated account.
    update public.app_accounts
    set credential_action_pending = false,
        sessions_valid_from = v_cutoff
    where id = v_account.id;
  end if;

  update public.account_credential_grants
  set consumed_at = now()
  where id = v_grant.id;

  insert into public.account_events (account_id, kind, detail)
  values (
    p_account,
    case when v_grant.purpose = 'setup' then 'setup_completed' else 'recovery_completed' end,
    'Password set through the trusted flow; earlier sessions invalidated.'
  );
  insert into public.account_events (account_id, kind, detail)
  values (p_account, 'sessions_invalidated', 'Access tokens issued before completion are refused.');

  return query
    select a.id, v_grant.purpose, a.status, a.sessions_valid_from
    from public.app_accounts a
    where a.id = p_account;
end;
$$;

-- Deactivation must also cut existing sessions immediately.
create or replace function public.app_set_account_status(p_account uuid, p_status text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_target public.app_accounts;
begin
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can change account status.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_status is null or p_status not in ('active', 'inactive') then
    raise exception 'Choose active or inactive; password setup uses a separate trusted flow.'
      using errcode = 'check_violation';
  end if;

  select * into v_target
  from public.app_accounts a
  where a.id = p_account
  for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  if v_target.id = v_actor.id then
    raise exception 'You cannot change your own account status.' using errcode = 'insufficient_privilege';
  end if;
  if v_target.status = 'setup_pending' then
    raise exception 'Password setup must complete before this account status can be changed.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_target.status = p_status then
    raise exception 'That account already has this status.' using errcode = 'check_violation';
  end if;

  update public.app_accounts
  set status = p_status,
      -- Deactivation invalidates outstanding access tokens, not just future
      -- sign-ins. Reactivation leaves the cutoff alone.
      sessions_valid_from = case when p_status = 'inactive' then now() else sessions_valid_from end
  where id = v_target.id;

  insert into public.account_events (account_id, kind, actor_id, detail)
  values (v_target.id, 'status_changed', v_actor.id, 'Status set to ' || p_status || '.');

  return v_target.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants for the new tables.
-- ---------------------------------------------------------------------------

alter table public.account_provisions enable row level security;
alter table public.account_credential_grants enable row level security;
alter table public.account_events enable row level security;

-- Admins may read the audit trail and outstanding grant metadata. Nobody reads
-- provisioning rows through the API; the server uses them with the service role.
create policy account_credential_grants_admin_read
  on public.account_credential_grants for select to authenticated
  using (public.app_is_admin());

create policy account_events_admin_read
  on public.account_events for select to authenticated
  using (public.app_is_admin());

revoke all on table
  public.account_provisions,
  public.account_credential_grants,
  public.account_events
from anon, authenticated;

grant select on table
  public.account_credential_grants,
  public.account_events
to authenticated;

revoke execute on function
  public.app_token_is_current(public.app_accounts),
  public.app_admin_request_account(text, text),
  public.app_admin_request_credential_grant(uuid, text, integer),
  public.app_admin_cancel_credential_action(uuid),
  public.app_trusted_finalize_account(uuid, uuid),
  public.app_trusted_verify_grant(uuid),
  public.app_trusted_complete_credential_action(uuid)
from public, anon, authenticated;

-- Admin-authorized calls run in the admin's own session.
grant execute on function
  public.app_admin_request_account(text, text),
  public.app_admin_request_credential_grant(uuid, text, integer),
  public.app_admin_cancel_credential_action(uuid)
to authenticated;

-- Helper used inside policies, so the calling role needs EXECUTE.
grant execute on function public.app_token_is_current(public.app_accounts) to authenticated;

-- Recreated above, so its M2 grants must be restored.
revoke execute on function public.app_my_account() from public, anon;
grant execute on function public.app_my_account() to authenticated;

-- Trusted server-only operations. Never granted to `authenticated`.
grant execute on function
  public.app_trusted_finalize_account(uuid, uuid),
  public.app_trusted_verify_grant(uuid),
  public.app_trusted_complete_credential_action(uuid)
to service_role;
