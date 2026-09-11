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
