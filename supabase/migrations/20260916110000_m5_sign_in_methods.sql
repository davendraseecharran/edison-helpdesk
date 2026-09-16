-- M5: one account, two ways in.
--
-- Until now the two doors were owned by different people. Google sign-in was
-- everybody's, and a password was an administrator's break-glass path issued as
-- a one-time link. That left a real account in a state with no way out of it: a
-- colleague whose Google account is unavailable — a locked-out school tenant, a
-- phone with no signal on a lab machine — had to ask an administrator for a
-- recovery link before they could sign in at all.
--
-- The policy changes here, and only in one direction: ANY active account may
-- hold a password of its own, set from Settings while they are already signed
-- in. Nothing about public sign-up changes. `hook_before_user_created` still
-- refuses `POST /auth/v1/signup` with 403 (20260914101200_m5_signup_hook.sql),
-- so a password is still something an account ACQUIRES after an administrator
-- or an invite has let it in, never a way to create one.
--
-- Two functions and one widened vocabulary:
--
--   public.app_my_sign_in_methods()            — what the caller's own account
--                                                can sign in with, for Settings.
--   public.app_trusted_approve_own_credential() — approves the digest of a
--                                                password the person just set
--                                                on themselves, WITHOUT
--                                                invalidating their session.
--
-- The second is the whole substance of this migration; its comment explains why
-- it differs from the recovery path, which does invalidate other sessions.

-- ---------------------------------------------------------------------------
-- The account-event vocabulary, widened by one kind.
--
-- The constraint is a whole list rather than a diff, exactly as
-- 20260914120200_m5_account_event_kinds.sql wrote it, so it is restated in full
-- with 'password_set' added. Additive: a constraint is widened, never narrowed,
-- so no existing row can stop being valid.
-- ---------------------------------------------------------------------------

alter table public.account_events drop constraint account_events_kind_valid;

alter table public.account_events add constraint account_events_kind_valid check (
  kind in (
    'account_provisioned', 'setup_issued', 'setup_verified', 'setup_completed',
    'recovery_issued', 'recovery_verified', 'recovery_completed',
    'credential_action_cancelled', 'status_changed', 'sessions_invalidated',
    'identity_linked', 'invite_accepted', 'access_requested', 'access_approved',
    'access_denied', 'role_changed', 'password_set'
  )
);

-- ---------------------------------------------------------------------------
-- What the caller can sign in with.
--
-- Settings shows two rows and needs two facts, and neither can be read by a
-- client: `auth.identities` is not exposed through the API, and
-- `account_credential_state` is revoked from every client role. Both are read
-- here for the CALLER ALONE — `auth.uid()` is the only account this function
-- will ever describe, and it takes no parameter, so there is no other account
-- to ask about.
--
--   google_email — the address of the caller's `google` identity, which is what
--                  "Linked as name@address" is showing. Null when there is no
--                  such identity. An identity carries its OWN address, which is
--                  not necessarily auth.users.email, so it is read from the
--                  identity rather than from the user.
--   has_password — the caller holds a password THE HELPDESK KNOWS ABOUT: the
--                  provider's hash is non-empty AND it is still the one
--                  `account_credential_state` approved. A password changed
--                  directly at the provider fails that test, which is the same
--                  fail-closed rule `app_token_is_current` applies, so this
--                  answer never claims a way in that would not actually work.
-- ---------------------------------------------------------------------------

create function public.app_my_sign_in_methods()
returns table (google_email text, has_password boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (
      select pg_catalog.lower(pg_catalog.btrim(i.identity_data ->> 'email'))
      from auth.identities i
      where i.user_id = u.id
        and i.provider = 'google'
        and pg_catalog.btrim(coalesce(i.identity_data ->> 'email', '')) <> ''
      order by i.last_sign_in_at desc nulls last, i.created_at desc
      limit 1
    ),
    coalesce(u.encrypted_password, '') <> ''
      and exists (
        select 1
        from public.account_credential_state c
        where c.account_id = u.id
          and c.approved_digest
              = pg_catalog.encode(
                  extensions.digest(coalesce(u.encrypted_password, ''), 'sha256'), 'hex'
                )
      )
  from auth.users u
  where u.id = (select auth.uid());
$$;

comment on function public.app_my_sign_in_methods() is
  'The caller''s own ways in: the address of their Google identity, and whether they hold the password the helpdesk approved. Reads auth.identities and the credential state for auth.uid() alone and takes no parameter, so it can describe no other account.';

revoke execute on function public.app_my_sign_in_methods() from public, anon;
grant execute on function public.app_my_sign_in_methods() to authenticated;

-- ---------------------------------------------------------------------------
-- Approving a password somebody set on themselves.
--
-- WHY THIS IS NOT THE RECOVERY PATH. `app_trusted_complete_credential_action`
-- ends with `sessions_valid_from = clock_timestamp()`, which invalidates every
-- token minted before it. That is right there: a recovery link is exchanged by
-- WHOEVER HOLDS IT, and the point of the flow is that any session established
-- before the rightful owner proved themselves must stop working.
--
-- Here the opposite is true. The person is already signed in on a session the
-- database already accepts — they came from Settings, not from a link — and
-- they are adding or replacing their own password. Moving the cutoff would sign
-- them out of the browser they are looking at, which is a strange answer to
-- "set a password", and it would sign out their other machines for an action
-- that proved nothing new about who they are. So the cutoff is deliberately not
-- touched, and this function's ONLY effect on access is that the new hash
-- becomes the approved one.
--
-- That is safe precisely because it cannot be reached without a current
-- session: it is service_role-only, and the server action that calls it changes
-- the password through the CALLER'S OWN session first
-- (`supabase.auth.updateUser`), so the provider has already required the
-- session that is about to be kept.
--
-- Fail-closed conditions, all of them checked here rather than trusted from the
-- caller:
--
--   * the account exists, is active, and is not mid-credential-change. An
--     account with an outstanding setup or recovery link must finish THAT flow;
--     approving a digest underneath it would leave a live link that no longer
--     matches what the account signs in with.
--   * the provider hash is non-empty. Approving sha256('') would record "this
--     account's approved password is no password", which is the state a Google
--     -only account already has and must not be reached by this route.
--   * the row is locked FOR UPDATE while the digest is taken, so a password
--     change racing this call cannot have its hash approved by it.
--
-- The one thing NOT checked here is that `account_credential_state` holds a row
-- for the account, because an account without one cannot reach this function:
-- `app_token_is_current` joins that table, so its session is not current, the
-- actor is restricted, and the server action refuses before it asks. If it were
-- somehow reached the update would match nothing, which leaves that account
-- exactly as unable to sign in as it already was.
-- ---------------------------------------------------------------------------

create function public.app_trusted_approve_own_credential(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.app_accounts;
  v_hash text;
begin
  -- Exclusive, before anything is read: this changes what the account can sign
  -- in with. Same lock, same order, as every other credential mutation.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  if p_user is null then
    raise exception 'That password could not be saved.' using errcode = 'check_violation';
  end if;

  select * into v_account
    from public.app_accounts a
   where a.id = p_user
   for update;

  if not found or v_account.status <> 'active' or v_account.credential_action_pending then
    raise exception 'That account cannot set a password of its own.'
      using errcode = 'insufficient_privilege';
  end if;

  select u.encrypted_password into v_hash
    from auth.users u
   where u.id = p_user
   for update;

  if coalesce(v_hash, '') = '' then
    raise exception 'That password could not be saved.' using errcode = 'check_violation';
  end if;

  update public.account_credential_state
     set approved_digest = pg_catalog.encode(extensions.digest(v_hash, 'sha256'), 'hex')
   where account_credential_state.account_id = p_user;

  -- No actor: the account holder did this themselves, in their own session.
  -- The detail says what the HELPDESK did. The provider has its own rule — it
  -- ends the account's other sessions on a password change and keeps the one
  -- that made it — and claiming that as ours would be an audit trail that
  -- describes the wrong actor.
  insert into public.account_events (account_id, kind, detail)
  values (p_user, 'password_set', 'Password set from Settings; the helpdesk revoked no sessions.');
end;
$$;

comment on function public.app_trusted_approve_own_credential(uuid) is
  'Approves the digest of a password the account holder just set on themselves. Deliberately does NOT move sessions_valid_from: unlike the recovery flow, the person is already holding a session the database accepts, so signing them out would be the wrong answer. Active, non-pending accounts with a real provider hash only. Never granted to authenticated or anon.';

revoke execute on function public.app_trusted_approve_own_credential(uuid)
from public, anon, authenticated;
grant execute on function public.app_trusted_approve_own_credential(uuid) to service_role;
