-- M3 review: exact link/session binding and refresh-safe credential revocation.
-- Digests are non-bearer evidence, never the provider token or password hash.
create table public.account_credential_state (
  account_id uuid primary key references public.app_accounts(id),
  approved_digest text not null
);
alter table public.account_credential_state enable row level security;
revoke all on public.account_credential_state from public, anon, authenticated;

create function public.app_capture_initial_credential() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.account_credential_state(account_id, approved_digest)
  select new.id, encode(extensions.digest(coalesce(u.encrypted_password, ''), 'sha256'), 'hex')
  from auth.users u where u.id = new.id;
  return new;
end;
$$;
revoke all on function public.app_capture_initial_credential() from public, anon, authenticated;
create trigger app_accounts_initial_credential after insert on public.app_accounts
for each row execute function public.app_capture_initial_credential();
insert into public.account_credential_state(account_id, approved_digest)
select a.id, encode(extensions.digest(coalesce(u.encrypted_password, ''), 'sha256'), 'hex')
from public.app_accounts a join auth.users u on u.id = a.id;

-- Transaction now() can predate time spent waiting for the access-state lock.
-- Revoke every session that exists when deactivation actually takes effect.
create function public.app_stamp_deactivation_cutoff() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'inactive' and old.status is distinct from new.status then
    new.sessions_valid_from := clock_timestamp();
  end if;
  return new;
end;
$$;
revoke all on function public.app_stamp_deactivation_cutoff() from public, anon, authenticated;
create trigger app_accounts_deactivation_cutoff before update on public.app_accounts
for each row execute function public.app_stamp_deactivation_cutoff();

-- Private binding data is separate from admin-readable grant metadata.
create table public.account_credential_bindings (
  grant_id uuid primary key references public.account_credential_grants(id),
  link_digest text not null unique check (link_digest ~ '^[0-9a-f]{64}$'),
  verified_session uuid,
  completion_started_at timestamptz
);
alter table public.account_credential_bindings enable row level security;
revoke all on public.account_credential_bindings from public, anon, authenticated;

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
      and exists (select 1 from auth.mfa_amr_claims m
                  where m.session_id = s.id and m.authentication_method = 'password')
  );
$$;

create function public.app_trusted_bind_credential_link(p_grant uuid, p_digest text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(1162103123, 1);
  if not exists (select 1 from public.account_credential_grants g where g.id = p_grant
    and g.consumed_at is null and g.superseded_at is null and g.expires_at > now()) then
    raise exception 'This link is no longer valid.' using errcode = 'insufficient_privilege';
  end if;
  insert into public.account_credential_bindings(grant_id, link_digest) values (p_grant, p_digest);
end;
$$;

-- The legacy account-only entry points must not remain callable by the server.
drop function public.app_trusted_verify_grant(uuid);
drop function public.app_trusted_complete_credential_action(uuid);

create function public.app_trusted_verify_grant(p_account uuid, p_digest text, p_session uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_grant public.account_credential_grants;
begin
  perform pg_advisory_xact_lock(1162103123, 1);
  select g.* into v_grant from public.account_credential_grants g
  join public.account_credential_bindings b on b.grant_id = g.id
  where g.account_id = p_account and b.link_digest = p_digest
    and g.consumed_at is null and g.superseded_at is null and g.expires_at > now()
    and b.verified_session is null
  for update of g, b;
  if not found or not exists (select 1 from auth.sessions s
    where s.id = p_session and s.user_id = p_account and s.created_at >= v_grant.issued_at
      and exists (select 1 from auth.mfa_amr_claims m where m.session_id = s.id and m.authentication_method = 'otp')) then
    raise exception 'This link is no longer valid.' using errcode = 'insufficient_privilege';
  end if;
  update public.account_credential_bindings set verified_session = p_session where grant_id = v_grant.id;
  update public.account_credential_grants set verified_at = now() where id = v_grant.id;
  insert into public.account_events(account_id, kind, detail)
  values (p_account, v_grant.purpose || '_verified', 'Link exchanged for a restricted session.');
  return v_grant.purpose;
end;
$$;

-- A one-winner lease prevents two server actions mutating the provider password.
-- An uncertain/failed attempt can be retried after the lease, or replaced by admin.
create function public.app_trusted_begin_credential_action(p_account uuid, p_session uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_grant uuid;
begin
  perform pg_advisory_xact_lock(1162103123, 1);
  select g.id into v_grant from public.account_credential_grants g
  join public.account_credential_bindings b on b.grant_id = g.id
  where g.account_id = p_account and b.verified_session = p_session
    and g.consumed_at is null and g.superseded_at is null and g.expires_at > now()
    and (b.completion_started_at is null or b.completion_started_at < now() - interval '2 minutes')
    and exists (select 1 from auth.sessions s where s.id = p_session and s.user_id = p_account)
  for update of g, b;
  if not found then
    raise exception 'This link is no longer valid, or a password change is already in progress.' using errcode = 'insufficient_privilege';
  end if;
  update public.account_credential_bindings set completion_started_at = now() where grant_id = v_grant;
  return v_grant;
end;
$$;

create function public.app_trusted_complete_credential_action(
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
  if p_password is null or length(p_password) < 12 or v_hash is null
    or extensions.crypt(p_password, v_hash) is distinct from v_hash then
    raise exception 'The password change could not be verified. Request a new link.' using errcode = 'insufficient_privilege';
  end if;
  if v_grant.purpose = 'setup' and v_account.status <> 'setup_pending' then
    raise exception 'That account is not awaiting setup.' using errcode = 'check_violation';
  end if;
  update public.account_credential_state set approved_digest = encode(extensions.digest(v_hash, 'sha256'), 'hex')
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

revoke all on function public.app_trusted_bind_credential_link(uuid,text),
  public.app_trusted_verify_grant(uuid,text,uuid),
  public.app_trusted_begin_credential_action(uuid,uuid),
  public.app_trusted_complete_credential_action(uuid,uuid,uuid,text)
from public, anon, authenticated;
grant execute on function public.app_trusted_bind_credential_link(uuid,text),
  public.app_trusted_verify_grant(uuid,text,uuid),
  public.app_trusted_begin_credential_action(uuid,uuid),
  public.app_trusted_complete_credential_action(uuid,uuid,uuid,text)
to service_role;
