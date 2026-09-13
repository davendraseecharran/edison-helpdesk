-- Local auth-suite support only. This file is never applied by `supabase db
-- reset` or by a hosted deployment; tests/auth/globalSetup.ts installs it after
-- the local-only guard and reset have completed.
--
-- GoTrue decides a recovery token is expired by comparing recovery_sent_at with
-- its configured window. Ageing that timestamp makes expiry testable without
-- waiting an hour. The helper is service_role-only and can only make an
-- existing token look older, never newer or valid again.

create or replace function public.app_test_age_recovery_token(
  p_account uuid,
  p_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update auth.users
  set recovery_sent_at = recovery_sent_at - make_interval(secs => p_seconds)
  where id = p_account;
end;
$$;

revoke execute on function public.app_test_age_recovery_token(uuid, integer)
from public, anon, authenticated;

grant execute on function public.app_test_age_recovery_token(uuid, integer) to service_role;

-- Rewrites the authentication method recorded for one session.
--
-- A provider sign-in records `oauth` in auth.mfa_amr_claims where a password
-- sign-in records `password`, and a link exchange records `otp`. No OAuth
-- provider is configured on a local stack, so there is no way to obtain a real
-- `oauth` session here; this helper restates an existing session's method so the
-- database predicate that reads it can be exercised for what it is.
--
-- Deliberately narrow: it only ever moves an EXISTING claim between the three
-- methods the application recognises. It creates no session, grants nothing, and
-- cannot make an absent claim appear. service_role-only, and installed outside
-- the migration set so it can never reach a hosted deployment.
create or replace function public.app_test_set_session_amr(
  p_session uuid,
  p_method text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_method is null or p_method not in ('password', 'oauth', 'otp') then
    raise exception 'Choose password, oauth or otp.' using errcode = 'check_violation';
  end if;

  update auth.mfa_amr_claims
  set authentication_method = p_method, updated_at = now()
  where session_id = p_session;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.app_test_set_session_amr(uuid, text)
from public, anon, authenticated;

grant execute on function public.app_test_set_session_amr(uuid, text) to service_role;

-- Attaches a synthetic, already-verified provider identity to an existing user.
--
-- One auth user can carry several identities, and each identity records its own
-- address and its own verification. That is exactly the shape the email-binding
-- rule in app_trusted_link_identity has to defend against: a verified identity
-- for address A must never vouch for an account being minted on address B. No
-- OAuth provider is configured on a local stack, so an identity like this cannot
-- be produced by signing in; it is written directly here instead.
--
-- Deliberately narrow: it adds a row to auth.identities for a user that already
-- exists and does nothing else. It creates no user, no session and no account,
-- confirms no address on auth.users, and grants nothing. service_role-only, and
-- installed outside the migration set so it can never reach a deployment.
create or replace function public.app_test_add_verified_identity(
  p_user uuid,
  p_email text,
  p_provider text default 'google'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_identity uuid;
begin
  if v_email = '' or position('@' in v_email) < 2 then
    raise exception 'A synthetic identity needs an address.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'That user does not exist.' using errcode = 'check_violation';
  end if;

  insert into auth.identities (
    provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  )
  values (
    p_provider || ':' || v_email,
    p_user,
    jsonb_build_object('sub', p_user::text, 'email', v_email, 'email_verified', true),
    p_provider,
    now(), now(), now()
  )
  returning id into v_identity;

  return v_identity;
end;
$$;

revoke execute on function public.app_test_add_verified_identity(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.app_test_add_verified_identity(uuid, text, text) to service_role;

-- A readiness marker for the installer, defined LAST on purpose.
--
-- These helpers are created after PostgREST has already started and built its
-- schema cache, so the cache has to be refreshed before the first auth test
-- calls one — and that refresh is asynchronous. The installer polls this
-- function through the API and only returns once it answers, at which point
-- every helper above it is in the cache too. Without that wait, whichever test
-- file vitest happens to schedule first can race the reload.
create or replace function public.app_test_support_ready()
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke execute on function public.app_test_support_ready()
from public, anon, authenticated;

grant execute on function public.app_test_support_ready() to service_role;

notify pgrst, 'reload schema';
