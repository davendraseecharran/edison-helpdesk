-- Account administration and the two narrow lookups technicians need.
--
-- NOT here, by design (M3 work): creating auth users, issuing setup or recovery
-- links, and completing password setup. M2 deliberately exposes no function that
-- would make the M1 mockup's simulated credential actions look like real
-- security operations. Synthetic accounts are provisioned by the local test
-- harness through the service-role admin API, never by a client RPC.

-- --- Self status -----------------------------------------------------------

-- Minimal self-status for future routing (M3 needs to send a setup_pending or
-- inactive account to the right screen). Returns the caller's own row only, and
-- no ticket information whatsoever. Available to any signed-in user, including
-- inactive and setup_pending ones, because that is precisely its purpose.
create or replace function public.app_my_account()
returns table (
  id uuid,
  display_name text,
  email text,
  role text,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.display_name, a.email, a.role, a.status
  from public.app_accounts a
  where a.id = (select auth.uid());
$$;

-- --- Directory lookup ------------------------------------------------------

-- Labels only: what an active technician needs to pick a collaborator and to
-- render historical attribution ("Dev Okafor added a work note"). Email,
-- created_at and the credential-action columns are NOT exposed here; a
-- technician selecting directly from app_accounts still sees only their own row.
-- This is not, and must not become, a student/staff directory.
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
    order by a.display_name;
end;
$$;

-- --- Account status administration -----------------------------------------

-- The protected admin boundary. Role changes and account creation are NOT
-- exposed: role is only settable by a privileged operator (service role) until
-- M3 defines the real onboarding flow.
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
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can change account status.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_status is null or p_status not in ('active', 'inactive', 'setup_pending') then
    raise exception 'Choose a valid account status.' using errcode = 'check_violation';
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

-- --- Grants ----------------------------------------------------------------

revoke execute on function
  public.app_my_account(),
  public.app_directory(),
  public.app_set_account_status(uuid, text)
from public, anon;

grant execute on function
  public.app_my_account(),
  public.app_directory(),
  public.app_set_account_status(uuid, text)
to authenticated;
