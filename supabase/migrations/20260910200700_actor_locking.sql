-- Account-status changes are rare; ticket writes should remain parallel.
-- A shared transaction advisory lock gates every mutation before it reads its
-- actor. Status changes take the matching exclusive lock FIRST, then validate
-- the admin and update the account. Whichever wins runs to commit before the
-- other reads authorization. This also protects owner/collaborator validation
-- from concurrent deactivation without per-account lock ordering cycles.
-- Namespace 1162103123 / 1 is reserved for helpdesk authorization changes.
-- Privileged service-role writes remain an operator responsibility.

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
  -- Serialize against account-status changes before reading authorization.
  perform pg_catalog.pg_advisory_xact_lock_shared(1162103123, 1);

  select * into v_actor
  from public.app_accounts a
  where a.id = (select auth.uid());

  if not found or v_actor.status <> 'active' then
    -- Anonymous, unlinked, inactive and setup_pending are all refused here, so
    -- deactivation applies to the next statement of an existing session.
    raise exception 'This account cannot access helpdesk records.'
      using errcode = 'insufficient_privilege';
  end if;

  return v_actor;
end;
$$;

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
  -- Take exclusive BEFORE app_require_actor takes shared: never upgrade a
  -- shared lock, which would deadlock two concurrent administrators.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can change account status.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_status is null or p_status not in ('active', 'inactive') then
    raise exception 'Choose active or inactive; password setup uses a separate trusted flow.' using errcode = 'check_violation';
  end if;

  select * into v_target
  from public.app_accounts a
  where a.id = p_account
  for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  -- An admin cannot lock themselves out or quietly self-elevate later.
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

  -- Status only. Role, email and display name are untouched, and ticket history
  -- is never rewritten: deactivation revokes access, it does not erase work.
  update public.app_accounts
  set status = p_status
  where id = v_target.id;

  return v_target.id;
end;
$$;

-- CREATE OR REPLACE preserves existing EXECUTE ACLs.
