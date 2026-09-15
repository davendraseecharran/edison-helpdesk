-- A Google-only administrator can be demoted.
--
-- `app_set_account_roles` refuses to leave the helpdesk without a usable
-- administrator, and that is right. What it counted as usable was wrong: the
-- guard (inherited from `app_set_account_role`, and unchanged when the roles
-- became a set at 20260914140000) joined `account_credential_state` and
-- required `auth.users.encrypted_password` to be non-empty and to match the
-- digest the helpdesk approved. That is the break-glass password path, and by
-- M5 it is the exception rather than the way in: Google sign-in is the primary
-- door, and an administrator invited by email who has only ever pressed
-- "Continue with Google" has no password at all.
--
-- So with one password administrator and any number of Google-only ones, the
-- count was 1 and no Google-only administrator could ever be demoted —
-- including by themselves, and including when three others were sitting in the
-- room. The message they got ("The last active administrator cannot be
-- removed") was not true of the helpdesk they were looking at.
--
-- A usable administrator is now an active, unbanned, not-mid-credential-change
-- admin with EITHER of the two real ways in:
--
--   * a password that is the one the helpdesk approved — the original test,
--     unchanged and still exact; or
--   * a row in `auth.identities` for any provider that is not `email`, which
--     is what "they can sign in with Google" looks like in the database.
--
-- `email` is excluded from the second branch on purpose: an email identity is
-- the password path wearing its provider name, and counting it would let an
-- account with a digest the helpdesk never approved keep the door open.
--
-- Additive: same signature, same security context, same grants, same lock
-- order, same refusal and the same message. Only the definition of "usable"
-- widens, and it widens towards accounts that genuinely can sign in.

create or replace function public.app_set_account_roles(p_account uuid, p_roles text[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_target public.app_accounts;
  v_roles text[];
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

  v_roles := public.app_normalize_roles(p_roles);

  select * into v_target
    from public.app_accounts a
   where a.id = p_account
   for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  if v_target.roles = v_roles then
    raise exception 'That account already has these roles.' using errcode = 'check_violation';
  end if;

  -- A role edit never changes status: pending and inactive accounts remain
  -- restricted, even when an administrator prepares their future roles.
  if v_target.role = 'admin'
     and not ('admin' = any(v_roles))
     and v_target.status = 'active'
     and not v_target.credential_action_pending then
    select count(*) into v_usable_admins
      from public.app_accounts a
      join auth.users u on u.id = a.id
     where (u.banned_until is null or u.banned_until <= now())
       and a.role = 'admin'
       and a.status = 'active'
       and not a.credential_action_pending
       and (
         -- The break-glass password, and only the digest the helpdesk approved.
         exists (
           select 1
             from public.account_credential_state c
            where c.account_id = a.id
              and coalesce(u.encrypted_password, '') <> ''
              and c.approved_digest
                  = encode(extensions.digest(coalesce(u.encrypted_password, ''), 'sha256'), 'hex')
         )
         -- Or a way in that is not a password: Google, in practice. `email` is
         -- excluded because that identity IS the password path, and it must go
         -- through the digest test above rather than round it.
         or exists (
           select 1
             from auth.identities i
            where i.user_id = a.id
              and i.provider <> 'email'
         )
       );
    if v_usable_admins <= 1 then
      raise exception 'The last active administrator cannot be removed.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  update public.app_accounts
     set roles = v_roles,
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
    'Roles changed from ' || pg_catalog.array_to_string(v_target.roles, ', ')
      || ' to ' || pg_catalog.array_to_string(v_roles, ', ') || '.'
  );

  return v_target.id;
end;
$$;

comment on function public.app_set_account_roles(uuid, text[]) is
  'Sets an account''s full role set. Administrator session only. Refuses to leave the helpdesk without a usable administrator — one who can actually sign in, by the approved password or by any non-email identity — and invalidates the target''s older sessions.';

revoke execute on function public.app_set_account_roles(uuid, text[])
from public, anon, authenticated;
grant execute on function public.app_set_account_roles(uuid, text[]) to authenticated;
