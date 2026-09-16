-- ---------------------------------------------------------------------------
-- The password floor is eight characters.
--
-- Twelve was the M3 setting. The desk asked for eight: a NetRider types this
-- on a Chromebook between calls, and the sign-up door is closed anyway (the
-- hook refuses public email-and-password sign-up), so a password here is
-- only ever a second way in for a person an administrator already let in.
-- The provider's own minimum is set to the same number in config.toml.
--
-- Additive. Restates app_trusted_complete_credential_action from
-- 20260916110000_m5_sign_in_methods.sql with the one number changed; the
-- Settings path validates in the application and is unchanged here.
-- ---------------------------------------------------------------------------
create or replace function public.app_trusted_complete_credential_action(
  p_account uuid, p_grant uuid, p_session uuid, p_password text
)
returns table(account_id uuid, purpose text, status text, sessions_valid_from timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_account public.app_accounts; v_grant public.account_credential_grants; v_hash text;
begin
  perform pg_advisory_xact_lock(1162103123, 1);
  select * into v_account from public.app_accounts a where a.id = p_account for update;
  select g.* into v_grant from public.account_credential_grants g
  join public.account_credential_bindings b on b.grant_id = g.id
  where g.id = p_grant and g.account_id = p_account and b.verified_session = p_session
    and b.completion_started_at is not null and b.completion_started_at > now() - interval '2 minutes'
    and g.consumed_at is null and g.superseded_at is null and g.expires_at > now()
  for update of g, b;
  if not found or v_account.id is null then
    raise exception 'This link is no longer valid.' using errcode = 'insufficient_privilege';
  end if;
  -- Lock provider state while approving its fingerprint. The provider generated
  -- this bcrypt hash; crypt only verifies the transient RPC password and never
  -- creates or persists an independent password store.
  select u.encrypted_password into v_hash from auth.users u where u.id = p_account for update;
  if p_password is null or length(p_password) < 8 or v_hash is null
    or extensions.crypt(p_password, v_hash) is distinct from v_hash then
    raise exception 'The password change could not be verified. Request a new link.' using errcode = 'insufficient_privilege';
  end if;
  if v_grant.purpose = 'setup' and v_account.status <> 'setup_pending' then
    raise exception 'That account is not awaiting setup.' using errcode = 'check_violation';
  end if;
  update public.account_credential_state set approved_digest = encode(extensions.digest(v_hash, 'sha256'), 'hex'),
    password_set_at = clock_timestamp()
  where account_credential_state.account_id = p_account;
  update public.app_accounts set
    status = case when v_grant.purpose = 'setup' then 'active' else app_accounts.status end,
    credential_action_pending = false, sessions_valid_from = clock_timestamp()
  where id = p_account;
  update public.account_credential_grants set consumed_at = now() where id = v_grant.id;
  insert into public.account_events(account_id, kind, detail) values
    (p_account, v_grant.purpose || '_completed', 'Password verified through the trusted flow; earlier sessions invalidated.'),
    (p_account, 'sessions_invalidated', 'Earlier sessions remain invalid after refresh.');
  return query select a.id, v_grant.purpose, a.status, a.sessions_valid_from from public.app_accounts a where a.id = p_account;
end;
$$;
