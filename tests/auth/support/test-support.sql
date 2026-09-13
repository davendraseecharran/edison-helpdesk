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

-- The helper is created after PostgREST starts, so make the function visible in
-- its schema cache before the first auth test calls it.
notify pgrst, 'reload schema';

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

notify pgrst, 'reload schema';
