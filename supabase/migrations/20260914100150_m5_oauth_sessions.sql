-- M5: admit a provider sign-in as a real authentication.
--
-- Additive and surgical. This migration changes exactly one predicate inside
-- app_token_is_current and nothing else.
--
-- Why. M3 (20260910210300_m3_credential_binding.sql) added an AMR requirement to
-- app_token_is_current so that a session established only by EXCHANGING A LINK
-- cannot reach helpdesk records. The provider records how a session was
-- authenticated in auth.mfa_amr_claims, and at the time the only two methods
-- this application could produce were:
--
--   password — an address and a password were presented.
--   otp      — a one-time setup or recovery link was exchanged.
--
-- Requiring `password` was therefore the same statement as "not a link
-- exchange". Google sign-in adds a third method: GoTrue records an external
-- provider sign-in as `oauth`. That is a genuine authentication — the provider
-- verified the person and the address — but under the M3 predicate it fails,
-- which would leave a Google account that has been linked, invited and approved
-- still unable to read a single ticket. The predicate is widened to name both
-- real authentications instead of only one.
--
-- What is deliberately NOT widened:
--
--   * `otp` stays excluded. A setup or recovery link still buys a restricted
--     session and nothing more, which is the whole point of the M3 control, and
--     it is why this is an allow-list of two methods rather than a rule like
--     "anything except otp" that a future provider feature could quietly widen.
--   * app_trusted_verify_grant is untouched. Its `otp` requirement is the
--     mirror image of this one — it insists the link flow really was a link
--     exchange — and it is correct as written.
--   * Every other condition in the predicate is unchanged: the session must be
--     the one named by the request's `session_id` claim, must belong to this
--     account, must have been created after the account's invalidation cutoff,
--     must not have expired, and must still match the approved password digest.
--     Widening HOW a session may have been authenticated does not widen WHO may
--     use one: status, role, credential_action_pending and the revocation cutoff
--     all still apply exactly as before.
--
-- On the password digest for a Google-only account. The M3 binding compares
-- account_credential_state.approved_digest against
-- sha256(coalesce(auth.users.encrypted_password, '')). An account created by
-- app_trusted_link_identity has no password, so the app_accounts_initial_credential
-- trigger captures sha256('') at insert time and the comparison holds. It keeps
-- holding for as long as the account has no password. If such an account is ever
-- given one through the trusted setup/recovery flow, that flow re-approves the
-- new digest in the same transaction as the password change, so the binding stays
-- consistent through the transition rather than silently invalidating the
-- account's own sessions.

create or replace function public.app_token_is_current(p_account public.app_accounts)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.sessions s
    join auth.users u on u.id = s.user_id
    join public.account_credential_state c on c.account_id = u.id
    where s.id::text = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id')
      and s.user_id = p_account.id
      and s.created_at > p_account.sessions_valid_from
      and (s.not_after is null or s.not_after > now())
      and c.approved_digest = encode(extensions.digest(coalesce(u.encrypted_password, ''), 'sha256'), 'hex')
      -- The only change from M3: a provider sign-in counts as an authentication.
      -- `otp` remains absent, so a link exchange is still restricted.
      and exists (select 1 from auth.mfa_amr_claims m
                  where m.session_id = s.id and m.authentication_method in ('password', 'oauth'))
  );
$$;

comment on function public.app_token_is_current(public.app_accounts) is
  'False unless the caller presents the session named by its own JWT, authenticated by password or by an external provider, created after the account''s revocation cutoff, unexpired, and still matching the approved password digest. A link-exchange (otp) session is always false.';

-- CREATE OR REPLACE preserves the existing EXECUTE ACLs. These are the grants
-- M3 applied to this function, restated so this migration describes the whole
-- access state of the object it redefines rather than only the diff. The helper
-- is consulted from inside RLS policies, so the calling role needs EXECUTE;
-- anon never does.
revoke execute on function public.app_token_is_current(public.app_accounts)
from public, anon, authenticated;

grant execute on function public.app_token_is_current(public.app_accounts) to authenticated;
