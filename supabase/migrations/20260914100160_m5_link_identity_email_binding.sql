-- M5 review fix: bind the verification to the address actually being claimed.
--
-- Additive. Recreates public.app_trusted_link_identity with the body from
-- 20260914100100_m5_account_states_invites.sql, changing two things and nothing
-- else. The earlier migration is already applied locally and may be applied
-- elsewhere, so the fix arrives as a new migration rather than an edit.
--
-- 1. THE VULNERABILITY (important). The verified-email test read:
--
--      v_verified := v_user.email_confirmed_at is not null
--        or exists (select 1 from auth.identities i
--                   where i.user_id = p_user
--                     and i.identity_data ->> 'email_verified' = 'true');
--
--    One auth user can carry several identities, and each identity records its
--    OWN address and its OWN verification. That predicate scanned every identity
--    on the user and never compared the identity's address to the address the
--    account was about to be created on, so a verification of address A vouched
--    for an account minted on address B.
--
--    Concretely: create a user whose primary address is an invited colleague's
--    and leave it unconfirmed, then attach any verified identity for an address
--    you really do control. The old predicate said "verified", the invite for
--    the primary address was then found and spent, and the result was an ACTIVE
--    ADMINISTRATOR account on an address that was never proven. The regression
--    test in tests/auth/google-link.test.ts reproduces exactly that and asserts
--    `unverified` with no account row and the invite still waiting.
--
--    Both proofs are now bound to v_email — the address the account would be
--    created on:
--
--      * auth.users.email_confirmed_at counts only when auth.users.email IS that
--        address. v_email is derived from auth.users.email today, so this is
--        currently a tautology; it is written out anyway so the binding survives
--        any future change to where v_email comes from, and so the rule reads as
--        one rule rather than two unrelated ones.
--      * an identity counts only when its own identity_data ->> 'email' is that
--        address AND it carries email_verified = true. Compared lower/trimmed,
--        the same normalisation v_email already went through.
--
--    This can only ever REFUSE sign-ins the old version accepted. An identity
--    that genuinely verifies the address being claimed still satisfies it, which
--    is the ordinary Google case and is covered by its own test.
--
-- 2. Honest audit trail (minor). `identity_linked` was written on every path,
--    including for an account that has no provider identity at all — for example
--    a password account that the trusted server asks about, which takes the
--    `existing` branch. The event now requires a real provider identity on the
--    user (auth.identities.provider <> 'email'), computed once and applied at
--    all three sites, so the trail never claims a link that does not exist.
--    Nothing else about any branch changes: an account is still created, an
--    invite is still spent, and administrators are still notified exactly as
--    before.
--
-- Not changed: the advisory lock is still the first statement, the outcomes are
-- still the same four values, the function is still trusted-server-only.

create or replace function public.app_trusted_link_identity(p_user uuid)
returns table (outcome text, account_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users;
  v_email text;
  v_verified boolean;
  v_has_provider_identity boolean;
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

  -- Both proofs are bound to v_email: a verification only ever speaks for the
  -- address it was issued for. See the note at the top of this migration.
  v_verified := (
      v_user.email_confirmed_at is not null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(v_user.email, ''))) = v_email
    )
    or exists (
      select 1
      from auth.identities i
      where i.user_id = p_user
        and i.identity_data ->> 'email_verified' = 'true'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(i.identity_data ->> 'email', ''))) = v_email
    );

  -- Fails closed. A malformed address is treated the same as an unconfirmed one
  -- rather than being pushed at the account table's shape constraint.
  if not v_verified or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    return query select 'unverified'::text, null::uuid, null::text;
    return;
  end if;

  -- 'email' is the provider GoTrue records for a password account, so anything
  -- else is a real external identity. Read once and used at all three sites.
  v_has_provider_identity := exists (
    select 1
    from auth.identities i
    where i.user_id = p_user
      and i.provider <> 'email'
  );

  select * into v_account
  from public.app_accounts a
  where a.id = p_user
  for update;

  if found then
    -- Recorded once, and only when there is genuinely a provider identity to
    -- record, so a returning user neither fills their own audit trail with one
    -- row per sign-in nor gains an event describing a link they do not have.
    if v_has_provider_identity and not exists (
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

    if v_has_provider_identity then
      insert into public.account_events (account_id, kind, detail)
      values (v_new.id, 'identity_linked', 'Provider identity linked to this account.');
    end if;
    insert into public.account_events (account_id, kind, detail)
    values (v_new.id, 'invite_accepted', 'Invite accepted as ' || v_invite.role || '.');

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

  if v_has_provider_identity then
    insert into public.account_events (account_id, kind, detail)
    values (v_new.id, 'identity_linked', 'Provider identity linked to this account.');
  end if;
  insert into public.account_events (account_id, kind, detail)
  values (v_new.id, 'access_requested', 'Signed in without an invite and is waiting for a decision.');

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
  'Trusted server entry point for a provider sign-in. Returns existing, invited, requested or unverified. A verification counts only for the address it was issued for. Never granted to authenticated or anon.';

-- CREATE OR REPLACE preserves the existing EXECUTE ACLs. These are the grants
-- the M5 migration applied to this function, restated so this migration
-- describes the whole access state of the object it redefines. service_role is
-- deliberately absent from the revoke list: it is the only legitimate caller.
revoke execute on function public.app_trusted_link_identity(uuid)
from public, anon, authenticated;

grant execute on function public.app_trusted_link_identity(uuid) to service_role;
