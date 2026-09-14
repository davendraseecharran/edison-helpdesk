-- M5: account states, invites and access requests.
--
-- Additive only. Every earlier rule stays in force: identity is auth.uid() only,
-- clients get SELECT and nothing else, every write goes through a SECURITY
-- DEFINER RPC that re-derives the actor inside the database, history is
-- append-only, and migration 007's advisory-lock protocol (namespace
-- 1162103123 / 1) still governs authorization changes — shared lock for ordinary
-- mutations, EXCLUSIVE lock taken BEFORE authorization is read for anything that
-- changes an account's access.
--
-- Until now an account could only come into being one way: an administrator
-- reserved it, the server created the Auth user, and a privately delivered setup
-- link turned it on. Signing in with Google adds a second way in, and with it
-- two states an account can be in before it has any access at all:
--
--   pending_approval — the person authenticated successfully with a verified
--                      address that nobody invited. They have an account row so
--                      the request can be reviewed and answered, and they reach
--                      nothing whatsoever until an administrator decides.
--   denied           — an administrator answered no. The row is kept so the
--                      decision is recorded and the same person signing in again
--                      does not silently become a fresh request.
--
-- Neither state is `active`, so every existing gate (app_active_account_id,
-- app_is_admin, app_require_actor, and the RLS policies built on them) already
-- refuses them without changes. What this migration adds is the way IN
-- (app_trusted_link_identity), the way to pre-authorize someone (invites), and
-- the way OUT of the waiting state (app_admin_review_access_request).
--
-- Trust boundary for linking. app_trusted_link_identity is the only function
-- here that is not called from a session. There is no auth.uid() on that call:
-- the Next.js OAuth callback passes a user id it has just verified with the
-- provider, so the function is granted to service_role ONLY and revoked from
-- public, anon and authenticated. It never accepts an email, a name or a role
-- from the caller — every one of those is read from auth.users, auth.identities
-- or the invite record — so a forged request body can at most name a user id the
-- caller already knows, which buys nothing that signing in as that user would
-- not already give.

-- ---------------------------------------------------------------------------
-- The two new account states, and the account events that explain them.
-- ---------------------------------------------------------------------------

alter table public.app_accounts drop constraint app_accounts_status_valid;
alter table public.app_accounts add constraint app_accounts_status_valid
  check (status in ('active','inactive','setup_pending','pending_approval','denied'));

comment on column public.app_accounts.status is
  'active, inactive, setup_pending (password flow), pending_approval (signed in with no invite) or denied (an administrator said no). Only active has access.';

-- Queue for the administration screen: the rows waiting for a decision are a
-- small minority of the table, so a partial index keeps that list cheap.
create index app_accounts_access_review_idx
  on public.app_accounts (status)
  where status in ('pending_approval', 'denied');

alter table public.account_events drop constraint account_events_kind_valid;
alter table public.account_events add constraint account_events_kind_valid check (kind in (
  'account_provisioned','setup_issued','setup_verified','setup_completed','recovery_issued','recovery_verified','recovery_completed',
  'credential_action_cancelled','status_changed','sessions_invalidated',
  'identity_linked','invite_accepted','access_requested','access_approved','access_denied','role_changed'));

-- ---------------------------------------------------------------------------
-- Invites: an administrator pre-authorizing an address, before anyone signs in.
--
-- An invite is NOT a credential. It carries no token and no link, it cannot be
-- redeemed by presenting it, and knowing one changes nothing: the only thing
-- that spends it is a successful provider sign-in with a verified address that
-- matches. That is why the table can be plain data with no secret in it, and why
-- an expired or revoked invite simply falls back to "ask an administrator".
-- ---------------------------------------------------------------------------

create table public.account_invites (
  id uuid primary key default extensions.gen_random_uuid(),
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  role text not null check (role in ('admin','technician')),
  display_name text,
  invited_by uuid not null references public.app_accounts (id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_account_id uuid references public.app_accounts (id) on delete restrict,
  revoked_at timestamptz
);

comment on table public.account_invites is
  'Addresses an administrator has pre-authorized. Holds no token or link: an invite is spent only by a verified provider sign-in with the same address.';
comment on column public.account_invites.role is
  'The role the invited person gets when they first sign in. Changing it afterwards goes through app_admin_set_role.';
comment on column public.account_invites.accepted_account_id is
  'The account created when this invite was spent. RESTRICT: an account that consumed an invite cannot be deleted out from under the record.';

-- At most one live invite per address, so "who invited this person, and as
-- what?" has exactly one answer at the moment they sign in. Accepted and revoked
-- rows stay for the history and are excluded from the constraint.
create unique index account_invites_live_email_idx
  on public.account_invites (email)
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- Administrator-authorized invite management. These run in the administrator's
-- OWN session, so the authorization decision is made from auth.uid() inside the
-- database rather than from anything the server passes in.
-- ---------------------------------------------------------------------------

create function public.app_admin_create_invite(
  p_email text,
  p_role text,
  p_display_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_name text := nullif(pg_catalog.btrim(coalesce(p_display_name, '')), '');
  v_superseded uuid;
  v_invite uuid;
begin
  -- Exclusive BEFORE app_require_actor takes shared, matching migration 007:
  -- never upgrade a shared lock. An invite decides what access the next sign-in
  -- gets, so it is serialized against linking and against status changes.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can invite someone.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Enter a valid school email address.' using errcode = 'check_violation';
  end if;
  if p_role is null or p_role not in ('admin', 'technician') then
    raise exception 'Choose administrator or technician.' using errcode = 'check_violation';
  end if;
  if v_name is not null and pg_catalog.length(v_name) > 120 then
    raise exception 'Enter a shorter name.' using errcode = 'check_violation';
  end if;

  -- Somebody who already has an account does not need an invite. If they are
  -- waiting for a decision, the answer is to review that request, not to add a
  -- second, contradictory record of what role they should have.
  if exists (select 1 from public.app_accounts a where a.email = v_email) then
    raise exception 'That address already has an account. Review the account instead.'
      using errcode = 'check_violation';
  end if;

  -- Re-inviting the same address supersedes the earlier invite rather than
  -- colliding with the live-invite index, so an administrator can correct a role
  -- or a name without first hunting down the old row.
  for v_superseded in
    with replaced as (
      update public.account_invites
      set revoked_at = pg_catalog.now()
      where email = v_email
        and accepted_at is null
        and revoked_at is null
      returning id
    )
    select id from replaced
  loop
    perform public.app_log_record_event(
      'invite', v_superseded, 'revoked', v_actor.id, 'Replaced by a newer invite.'
    );
  end loop;

  insert into public.account_invites (email, role, display_name, invited_by)
  values (v_email, p_role, v_name, v_actor.id)
  returning id into v_invite;

  perform public.app_log_record_event(
    'invite', v_invite, 'invited', v_actor.id, 'Invited ' || v_email || ' as ' || p_role || '.'
  );

  return v_invite;
end;
$$;

comment on function public.app_admin_create_invite(text, text, text) is
  'Pre-authorizes an address for one role. Supersedes any live invite for the same address. Administrator session only.';

create function public.app_admin_revoke_invite(p_invite uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_invite public.account_invites;
begin
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can withdraw an invite.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_invite
  from public.account_invites i
  where i.id = p_invite
  for update;

  if not found then
    raise exception 'That invite no longer exists.' using errcode = 'check_violation';
  end if;
  -- Withdrawing an accepted invite would misrepresent history: the account it
  -- created still exists. Deactivating that account is the right action.
  if v_invite.accepted_at is not null then
    raise exception 'That invite has already been accepted. Change the account instead.'
      using errcode = 'check_violation';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'That invite has already been withdrawn.' using errcode = 'check_violation';
  end if;

  update public.account_invites
  set revoked_at = pg_catalog.now()
  where id = v_invite.id;

  perform public.app_log_record_event(
    'invite', v_invite.id, 'revoked', v_actor.id, 'Invite withdrawn by an administrator.'
  );
end;
$$;

comment on function public.app_admin_revoke_invite(uuid) is
  'Withdraws a live invite so the address no longer gains access on sign-in. Administrator session only.';

-- Reading the invite list means reading a list of people's email addresses, so
-- it is administrator-only and says so explicitly rather than quietly returning
-- an empty set. `state` is derived, never stored: an invite becomes expired by
-- the clock moving, and nothing writes that transition.
create function public.app_admin_list_invites()
returns table (
  id uuid,
  email text,
  role text,
  display_name text,
  invited_by uuid,
  invited_by_name text,
  created_at timestamptz,
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.app_is_admin() then
    raise exception 'Only an administrator can review invites.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select i.id, i.email, i.role, i.display_name, i.invited_by, b.display_name,
           i.created_at, i.expires_at, i.accepted_at, i.revoked_at,
           case
             when i.accepted_at is not null then 'accepted'
             when i.revoked_at is not null then 'revoked'
             when i.expires_at <= pg_catalog.now() then 'expired'
             else 'pending'
           end
    from public.account_invites i
    join public.app_accounts b on b.id = i.invited_by
    order by i.created_at desc;
end;
$$;

comment on function public.app_admin_list_invites() is
  'Every invite with its derived state (pending, accepted, expired, revoked). Administrator session only.';

-- ---------------------------------------------------------------------------
-- Reviewing an access request.
--
-- This is the only path that turns a pending_approval or denied account on, and
-- it is the only place a role is chosen for such an account. app_set_account_status
-- is deliberately closed to these states below, so an administrator cannot
-- activate someone without recording a decision and choosing what they may do.
-- ---------------------------------------------------------------------------

create function public.app_admin_review_access_request(
  p_account uuid,
  p_decision text,
  p_role text default 'technician'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_target public.app_accounts;
begin
  -- Exclusive first: this changes an account's access (migration 007 protocol).
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can review an access request.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_decision is null or p_decision not in ('approve', 'deny') then
    raise exception 'Choose approve or deny.' using errcode = 'check_violation';
  end if;
  if p_decision = 'approve' and (p_role is null or p_role not in ('admin', 'technician')) then
    raise exception 'Choose administrator or technician.' using errcode = 'check_violation';
  end if;

  select * into v_target
  from public.app_accounts a
  where a.id = p_account
  for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  -- Nobody approves themselves, so a request can never become access without a
  -- second person deciding.
  if v_target.id = v_actor.id then
    raise exception 'You cannot review your own access request.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_target.status not in ('pending_approval', 'denied') then
    raise exception 'That account is not waiting for an access decision.'
      using errcode = 'check_violation';
  end if;

  if p_decision = 'approve' then
    -- Role and status move together: approving IS the moment the role is set.
    update public.app_accounts
    set status = 'active', role = p_role
    where id = v_target.id;

    insert into public.account_events (account_id, kind, actor_id, detail)
    values (v_target.id, 'access_approved', v_actor.id, 'Access approved as ' || p_role || '.');

    if v_target.role is distinct from p_role then
      insert into public.account_events (account_id, kind, actor_id, detail)
      values (v_target.id, 'role_changed', v_actor.id, 'Role set to ' || p_role || '.');
    end if;

    perform public.app_notify(
      v_target.id,
      'access_approved',
      'Your access request was approved',
      'You can start working on tickets.',
      '/queue'
    );
  else
    if v_target.status = 'denied' then
      raise exception 'That account has already been denied.' using errcode = 'check_violation';
    end if;

    -- Denied is not deactivation: the account never had access to revoke. The
    -- row is kept so the decision is recorded and the next sign-in is answered
    -- the same way instead of quietly opening a new request.
    update public.app_accounts
    set status = 'denied'
    where id = v_target.id;

    insert into public.account_events (account_id, kind, actor_id, detail)
    values (v_target.id, 'access_denied', v_actor.id, 'Access request denied.');

    perform public.app_notify(
      v_target.id,
      'access_denied',
      'Your access request was declined',
      'Contact the helpdesk administrator if you think this is a mistake.',
      '/restricted'
    );
  end if;
end;
$$;

comment on function public.app_admin_review_access_request(uuid, text, text) is
  'Approves (with a role) or denies an account waiting for access. Administrator session only, and never the reviewer''s own account.';

-- ---------------------------------------------------------------------------
-- Role changes for accounts that already have access.
-- ---------------------------------------------------------------------------

create function public.app_admin_set_role(p_account uuid, p_role text)
returns void
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
    raise exception 'Only an administrator can change a role.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_role is null or p_role not in ('admin', 'technician') then
    raise exception 'Choose administrator or technician.' using errcode = 'check_violation';
  end if;

  select * into v_target
  from public.app_accounts a
  where a.id = p_account
  for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  -- An administrator cannot demote themselves into a state they cannot undo,
  -- and cannot use this as a step towards self-elevation either.
  if v_target.id = v_actor.id then
    raise exception 'You cannot change your own role.' using errcode = 'insufficient_privilege';
  end if;
  if v_target.status in ('pending_approval', 'denied') then
    raise exception 'Approve the access request to give this account a role.'
      using errcode = 'check_violation';
  end if;
  if v_target.role = p_role then
    raise exception 'That account already has this role.' using errcode = 'check_violation';
  end if;

  update public.app_accounts
  set role = p_role
  where id = v_target.id;

  insert into public.account_events (account_id, kind, actor_id, detail)
  values (v_target.id, 'role_changed', v_actor.id, 'Role set to ' || p_role || '.');
end;
$$;

comment on function public.app_admin_set_role(uuid, text) is
  'Sets another account''s role. Never the caller''s own, and never an account still waiting for an access decision.';

-- ---------------------------------------------------------------------------
-- The ordinary status RPC must not become a way around the review.
--
-- Re-stated in full (CREATE OR REPLACE preserves the existing EXECUTE ACLs) with
-- one new guard: an account in pending_approval or denied is answered by
-- app_admin_review_access_request, which records a decision and chooses a role.
-- Everything else is exactly the M3 behaviour.
-- ---------------------------------------------------------------------------

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
  if v_target.status in ('pending_approval', 'denied') then
    raise exception 'Answer the access request instead of changing this account''s status.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_target.status = p_status then
    raise exception 'That account already has this status.' using errcode = 'check_violation';
  end if;

  update public.app_accounts
  set status = p_status,
      sessions_valid_from = case when p_status = 'inactive' then now() else sessions_valid_from end
  where id = v_target.id;

  insert into public.account_events (account_id, kind, actor_id, detail)
  values (v_target.id, 'status_changed', v_actor.id, 'Status set to ' || p_status || '.');

  return v_target.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The directory omits accounts that have never had access.
--
-- A deactivated colleague stays listed: their name appears on historical work
-- and has to render. Someone waiting for, or refused, a decision has no work to
-- attribute and is not a colleague yet, so listing them would leak the fact that
-- a named person tried to sign in to every technician in the building.
-- ---------------------------------------------------------------------------

create or replace function public.app_directory()
returns table (
  id uuid,
  display_name text,
  role text,
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.app_active_account_id() is null then
    raise exception 'This account cannot access helpdesk records.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select a.id, a.display_name, a.role, a.status
    from public.app_accounts a
    where a.status not in ('pending_approval', 'denied')
    order by a.display_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- The trusted entry point for a provider sign-in.
--
-- Called by the OAuth callback with a user id the provider has just
-- authenticated. Everything it decides comes from the database:
--
--   * the address and whether it is verified — auth.users / auth.identities
--   * the role                               — the invite, or 'technician'
--   * the display name                       — the invite, then the provider's
--                                              metadata, then the local part of
--                                              the address
--
-- Verified means the provider confirmed the address: email_confirmed_at is set,
-- or some identity on the user carries email_verified = true. An unverified
-- address creates NOTHING and spends no invite, because otherwise anyone who
-- could register an unconfirmed address at the provider could claim an invited
-- colleague's role.
--
-- Idempotent: the second call finds the account the first one made and reports
-- it, so a retried callback, a refresh, or two tabs racing cannot produce two
-- accounts or spend two invites.
-- ---------------------------------------------------------------------------

create function public.app_trusted_link_identity(p_user uuid)
returns table (outcome text, account_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users;
  v_email text;
  v_verified boolean;
  v_account public.app_accounts;
  v_invite public.account_invites;
  v_has_invite boolean;
  v_name text;
  v_new public.app_accounts;
begin
  -- Exclusive, before anything is read: this creates access.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  if p_user is null then
    raise exception 'That sign-in could not be completed.' using errcode = 'check_violation';
  end if;

  select * into v_user from auth.users u where u.id = p_user;
  if not found then
    raise exception 'That sign-in could not be completed.' using errcode = 'check_violation';
  end if;

  v_email := pg_catalog.lower(pg_catalog.btrim(coalesce(v_user.email, '')));

  v_verified := v_user.email_confirmed_at is not null
    or exists (
      select 1
      from auth.identities i
      where i.user_id = p_user
        and i.identity_data ->> 'email_verified' = 'true'
    );

  -- Fails closed. A malformed address is treated the same as an unconfirmed one
  -- rather than being pushed at the account table's shape constraint.
  if not v_verified or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    return query select 'unverified'::text, null::uuid, null::text;
    return;
  end if;

  select * into v_account
  from public.app_accounts a
  where a.id = p_user
  for update;

  if found then
    -- Recorded once, so a returning user does not fill their own audit trail
    -- with one row per sign-in.
    if not exists (
      select 1
      from public.account_events e
      where e.account_id = v_account.id
        and e.kind = 'identity_linked'
    ) then
      insert into public.account_events (account_id, kind, detail)
      values (v_account.id, 'identity_linked', 'Provider identity linked to this account.');
    end if;

    return query select 'existing'::text, v_account.id, v_account.status;
    return;
  end if;

  -- A different Auth user already holds this address. The provider normally
  -- links the identities itself rather than creating a second user, so this is
  -- the fail-closed branch: refuse rather than silently create an account that
  -- would collide with the unique address, or worse, attach to the wrong person.
  if exists (select 1 from public.app_accounts a where a.email = v_email) then
    raise exception 'That email address already belongs to another account.'
      using errcode = 'check_violation';
  end if;

  select * into v_invite
  from public.account_invites i
  where i.email = v_email
    and i.accepted_at is null
    and i.revoked_at is null
    and i.expires_at > pg_catalog.now()
  for update;
  v_has_invite := found;

  if v_has_invite then
    v_name := nullif(pg_catalog.btrim(coalesce(v_invite.display_name, '')), '');
  end if;
  if v_name is null then
    v_name := nullif(pg_catalog.btrim(coalesce(v_user.raw_user_meta_data ->> 'full_name', '')), '');
  end if;
  if v_name is null then
    v_name := nullif(pg_catalog.btrim(coalesce(v_user.raw_user_meta_data ->> 'name', '')), '');
  end if;
  if v_name is null then
    v_name := nullif(pg_catalog.btrim(pg_catalog.split_part(v_email, '@', 1)), '');
  end if;
  -- The account table allows 1 to 120 characters; a provider name is untrusted
  -- input, so it is bounded here rather than raising on a long one.
  v_name := pg_catalog.left(coalesce(v_name, 'Helpdesk user'), 120);

  if v_has_invite then
    insert into public.app_accounts (id, display_name, email, role, status)
    values (p_user, v_name, v_email, v_invite.role, 'active')
    returning * into v_new;

    update public.account_invites
    set accepted_at = pg_catalog.now(), accepted_account_id = v_new.id
    where id = v_invite.id;

    insert into public.account_events (account_id, kind, detail)
    values (v_new.id, 'identity_linked', 'Provider identity linked to this account.'),
           (v_new.id, 'invite_accepted', 'Invite accepted as ' || v_invite.role || '.');

    -- No actor: the person accepted it themselves through a trusted flow.
    perform public.app_log_record_event(
      'invite', v_invite.id, 'accepted', null, 'Invite accepted by ' || v_email || '.'
    );

    return query select 'invited'::text, v_new.id, v_new.status;
    return;
  end if;

  -- Nobody invited them. The account exists only so the request can be answered;
  -- pending_approval reaches nothing until an administrator decides.
  insert into public.app_accounts (id, display_name, email, role, status)
  values (p_user, v_name, v_email, 'technician', 'pending_approval')
  returning * into v_new;

  insert into public.account_events (account_id, kind, detail)
  values (v_new.id, 'identity_linked', 'Provider identity linked to this account.'),
         (v_new.id, 'access_requested', 'Signed in without an invite and is waiting for a decision.');

  perform public.app_notify_admins(
    'access_requested',
    'Someone requested helpdesk access',
    v_name || ' (' || v_email || ') signed in without an invite.',
    '/admin'
  );

  return query select 'requested'::text, v_new.id, v_new.status;
end;
$$;

comment on function public.app_trusted_link_identity(uuid) is
  'Trusted server entry point for a provider sign-in. Returns existing, invited, requested or unverified. Never granted to authenticated or anon.';

-- ---------------------------------------------------------------------------
-- Row-level security and grants.
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so the invite table is revoked explicitly and then re-granted
-- read-only behind an administrator-only policy. anon gets nothing at all.
-- ---------------------------------------------------------------------------

alter table public.account_invites enable row level security;

create policy account_invites_admin_read
  on public.account_invites for select to authenticated
  using (public.app_is_admin());

-- Deliberately absent: INSERT, UPDATE and DELETE policies. Invites are written
-- by the RPCs above and by nothing else.

revoke all on table public.account_invites from anon, authenticated;
grant select on table public.account_invites to authenticated;

-- Administrator-authorized calls run in the administrator's own session, so
-- they are granted to authenticated and refuse a non-admin from inside.
revoke execute on function
  public.app_admin_create_invite(text, text, text),
  public.app_admin_revoke_invite(uuid),
  public.app_admin_list_invites(),
  public.app_admin_review_access_request(uuid, text, text),
  public.app_admin_set_role(uuid, text)
from public, anon;

grant execute on function
  public.app_admin_create_invite(text, text, text),
  public.app_admin_revoke_invite(uuid),
  public.app_admin_list_invites(),
  public.app_admin_review_access_request(uuid, text, text),
  public.app_admin_set_role(uuid, text)
to authenticated;

-- The trusted linker is for the server and nobody else. service_role is NOT in
-- the revoke list: Supabase's default privileges grant EXECUTE to service_role
-- directly, and it is the only legitimate caller, so the grant below is the
-- explicit statement of that intent rather than a formality.
revoke execute on function public.app_trusted_link_identity(uuid)
from public, anon, authenticated;

grant execute on function public.app_trusted_link_identity(uuid) to service_role;
