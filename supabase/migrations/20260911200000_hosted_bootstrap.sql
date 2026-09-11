-- M4 hosted first-administrator bootstrap.
--
-- This is intentionally a service-role-only bridge. There is no active app
-- administrator yet, so the normal admin-authorized grant RPC cannot issue the
-- first setup grant. The operator must first create a passwordless Auth user
-- carrying the one-time bootstrap marker, then call this function with that
-- user's id and the exact account details. The returned grant id is bound to
-- the provider recovery token by the operator process through
-- app_trusted_bind_credential_link.

create function public.app_trusted_bootstrap_admin(
  p_user uuid,
  p_email text,
  p_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_display_name text := pg_catalog.btrim(coalesce(p_display_name, ''));
  v_auth_email text;
  v_bootstrap_marker text;
  v_account public.app_accounts;
  v_has_account boolean;
  v_grant uuid;
begin
  -- Serialize with every other account-access mutation. This is the same
  -- exclusive lock used by M3's trusted account functions.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  if p_user is null then
    raise exception 'A bootstrap Auth user is required.' using errcode = 'check_violation';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'A valid bootstrap email is required.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_display_name) = 0 or pg_catalog.length(v_display_name) > 120 then
    raise exception 'A valid bootstrap display name is required.' using errcode = 'check_violation';
  end if;

  -- The operator process, rather than this SQL function, creates the Auth
  -- user. The marker makes an existing unrelated Auth identity ineligible,
  -- and only the exact pending account may resume. The provider may populate
  -- an opaque password hash even when createUser receives no password.
  select pg_catalog.lower(pg_catalog.btrim(u.email)),
         u.raw_app_meta_data ->> 'edison_bootstrap'
    into v_auth_email, v_bootstrap_marker
    from auth.users u
   where u.id = p_user;

  if not found
     or v_auth_email is distinct from v_email
     or v_bootstrap_marker is distinct from 'first-admin-v1' then
    raise exception 'The Auth user is not an eligible operator bootstrap identity.'
      using errcode = 'insufficient_privilege';
  end if;

  -- There must be one exact bootstrap account. In particular, an existing
  -- technician is never promoted, even if an operator supplies that user's id.
  select * into v_account
    from public.app_accounts a
   where a.id = p_user
   for update;
  v_has_account := found;

  if exists (
    select 1 from public.app_accounts a
     where a.role = 'admin'
       and a.id <> p_user
  ) then
    raise exception 'Another administrator account already exists.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_has_account then
    if v_account.role <> 'admin' then
      raise exception 'The existing account is not an administrator; it will not be promoted.'
        using errcode = 'insufficient_privilege';
    end if;
    if v_account.email is distinct from v_email
       or v_account.display_name is distinct from v_display_name then
      raise exception 'The existing administrator does not match this bootstrap identity.'
        using errcode = 'check_violation';
    end if;
    if v_account.status <> 'setup_pending' then
      raise exception 'The bootstrap administrator already exists and is not setup pending.'
        using errcode = 'check_violation';
    end if;
  else
    if exists (
      select 1 from public.app_accounts a
       where a.email = v_email
    ) then
      raise exception 'An existing account already uses this bootstrap email.'
        using errcode = 'check_violation';
    end if;

    insert into public.app_accounts (
      id, display_name, email, role, status, credential_action_pending
    )
    values (
      p_user, v_display_name, v_email, 'admin', 'setup_pending', true
    )
    returning * into v_account;
  end if;

  -- The partial unique index permits only one live grant. Reissuing after an
  -- interrupted run invalidates the prior app grant before inserting a new
  -- one; the provider token is bound by the caller after this function returns.
  update public.account_credential_grants
     set superseded_at = pg_catalog.now()
   where account_id = p_user
     and consumed_at is null
     and superseded_at is null;

  insert into public.account_credential_grants (
    account_id, purpose, issued_by, expires_at
  )
  values (
    p_user, 'setup', p_user, pg_catalog.now() + pg_catalog.make_interval(hours => 1)
  )
  returning id into v_grant;

  update public.app_accounts
     set credential_action_pending = true,
         last_credential_action_at = pg_catalog.now(),
         last_credential_action_kind = 'setup_issued'
   where id = p_user;

  -- There is no active app actor during first bootstrap. Keep the audit actor
  -- null and identify the trusted operator path in detail; the grant's
  -- required issuer FK points to the exact bootstrap account itself.
  insert into public.account_events (account_id, kind, actor_id, detail)
  values (
    p_user,
    'setup_issued',
    null,
    'Initial administrator setup grant issued by a trusted operator for private delivery; expires in 3600 seconds.'
  );

  return v_grant;
end;
$$;

revoke all on function public.app_trusted_bootstrap_admin(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.app_trusted_bootstrap_admin(uuid, text, text)
to service_role;
