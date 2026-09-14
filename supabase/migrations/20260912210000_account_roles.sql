-- Account role administration.
--
-- `admin` is the super-admin role for this release. Role changes are made
-- through this RPC only; direct table writes remain denied to client roles.

alter table public.account_events
  drop constraint account_events_kind_valid;

alter table public.account_events
  add constraint account_events_kind_valid check (
    kind in (
      'account_provisioned', 'setup_issued', 'setup_verified', 'setup_completed',
      'recovery_issued', 'recovery_verified', 'recovery_completed',
      'credential_action_cancelled', 'status_changed', 'role_changed',
      'sessions_invalidated'
    )
  );

create function public.app_set_account_role(p_account uuid, p_role text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_target public.app_accounts;
  v_usable_admins bigint;
begin
  -- Take the exclusive lock before app_require_actor's shared lock. This is
  -- the account-access lock used by status and credential mutations, and keeps
  -- a role change from racing an authorization decision.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);
  v_actor := public.app_require_actor();

  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can change account roles.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_role is null or p_role not in ('admin', 'technician') then
    raise exception 'Choose administrator or technician.'
      using errcode = 'check_violation';
  end if;

  select * into v_target
    from public.app_accounts a
   where a.id = p_account
   for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  if v_target.role = p_role then
    raise exception 'That account already has this role.' using errcode = 'check_violation';
  end if;

  -- A role edit never changes status: pending and inactive accounts remain
  -- restricted, even when an administrator prepares their future role.
  if v_target.role = 'admin'
     and p_role = 'technician'
     and v_target.status = 'active'
     and not v_target.credential_action_pending then
    select count(*) into v_usable_admins
      from public.app_accounts a
      join public.account_credential_state c on c.account_id = a.id
      join auth.users u on u.id = a.id
     where c.approved_digest = encode(extensions.digest(coalesce(u.encrypted_password,''),'sha256'),'hex')
       and coalesce(u.encrypted_password,'') <> ''
       and (u.banned_until is null or u.banned_until <= now())
       and a.role = 'admin'
       and a.status = 'active'
       and not a.credential_action_pending;
    if v_usable_admins <= 1 then
      raise exception 'The last active administrator cannot be removed.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  update public.app_accounts
     set role = p_role,
         -- Role changes invalidate tokens issued before the committed change.
         -- clock_timestamp() records when the change actually takes effect,
         -- including time spent waiting for the access-state lock.
         sessions_valid_from = pg_catalog.clock_timestamp()
   where id = v_target.id;

  insert into public.account_events (account_id, kind, actor_id, detail)
  values (
    v_target.id,
    'role_changed',
    v_actor.id,
    'Role changed from ' || v_target.role || ' to ' || p_role || '.'
  );

  return v_target.id;
end;
$$;

revoke all on function public.app_set_account_role(uuid, text)
from public, anon, authenticated;
grant execute on function public.app_set_account_role(uuid, text)
to authenticated;

