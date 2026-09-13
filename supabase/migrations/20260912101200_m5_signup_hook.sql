-- M5: close public password sign-up (controller Ruling 24).
--
-- Additive. Adds one Auth hook function and nothing else.
--
-- The problem. Task 6b set `[auth] enable_signup = true`, which it had to: that
-- flag is the site-wide gate on GoTrue creating an auth user, and while it is
-- false a first EXTERNAL-PROVIDER sign-in is refused too — which would stop an
-- invited colleague exactly as firmly as an uninvited stranger. Turning it on
-- also reopens `POST /auth/v1/signup`, so anyone could create an email+password
-- auth user. `[auth.email] enable_signup = false` does not fix that: it disables
-- the whole email provider, password LOGINS included, which would break the
-- administrator-provisioned setup and recovery flows this system is built on.
--
-- What was actually at risk. An auth user with no `app_accounts` row reaches
-- nothing — every read and write is refused — so this was never a route to
-- helpdesk data. The real exposure is PRE-REGISTRATION: claim a colleague's
-- address with a password before they are invited, and the identity GoTrue later
-- links to that address carries a password the attacker chose.
--
-- Ruling 24: close it with GoTrue's Before User Created hook, which fires ONLY
-- in the public Signup endpoint. That precision is the whole point:
--
--   * public POST /auth/v1/signup with email+password → app_metadata.provider is
--     'email' → rejected here with 403.
--   * an external-provider first sign-in → provider is 'google' (or another
--     provider id) → passes straight through, so Task 6b's invite and access
--     request flows are untouched.
--   * auth.admin.createUser → the ADMIN API does not run this hook at all, so
--     administrator provisioning (app_admin_request_account →
--     app_trusted_finalize_account), the hosted bootstrap, and every test
--     fixture keep working unchanged.
--
-- The rejection shape (`error` with `http_code` and `message`) is the documented
-- contract for a Postgres auth hook; GoTrue surfaces the message to the caller,
-- so it is written for the person who sees it rather than for a log.
--
-- Returning an empty object means "no objection" and is the only other thing
-- this function ever does. It does not edit the user, so it can never be the
-- reason a legitimate sign-in is altered — only the reason a password sign-up is
-- refused.

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Null-safe and case-insensitive: a missing or oddly-cased provider must not
  -- throw inside GoTrue's signup path.
  if pg_catalog.lower(
       coalesce(event -> 'user' -> 'app_metadata' ->> 'provider', '')
     ) = 'email' then
    return jsonb_build_object(
      'error',
      jsonb_build_object(
        'http_code', 403,
        'message', 'Password accounts are created by the administrator. Sign in with Google instead.'
      )
    );
  end if;

  -- Every other provider, including every external one, is allowed through.
  return '{}'::jsonb;
end;
$$;

comment on function public.hook_before_user_created(jsonb) is
  'GoTrue Before User Created hook. Refuses public email+password sign-up with 403; external-provider sign-ins and admin-API creation pass through untouched.';

-- Grants for a Postgres auth hook, per the Supabase documentation: the Auth
-- service calls it as supabase_auth_admin, and no client role may reach it.
-- service_role is named explicitly because Supabase's default privileges grant
-- EXECUTE to it directly, so revoking from PUBLIC alone would leave it callable
-- with the server's secret key.
grant usage on schema public to supabase_auth_admin;

grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

revoke execute on function public.hook_before_user_created(jsonb)
from authenticated, anon, public, service_role;
