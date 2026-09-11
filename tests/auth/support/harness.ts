/**
 * Auth suite harness.
 *
 * These tests exercise the real local Supabase Auth service and the trusted
 * database flows that M3 adds. They use genuine sign-ins and genuine
 * admin-issued links; nothing is mocked.
 *
 * The service role is used only where a privileged operator legitimately acts:
 * bootstrapping the first admin, generating a link (exactly as the server
 * action does), and inspecting ground truth. Authorization itself is always
 * exercised through a real session.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import type { LocalStack } from '../../db/support/local-only';

export function stack(): LocalStack {
  return inject('stack');
}

export function anonClient(): SupabaseClient {
  const local = stack();
  return createClient(local.apiUrl, local.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function serviceClient(): SupabaseClient {
  const local = stack();
  return createClient(local.apiUrl, local.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Ephemeral, never written to a file and never logged. */
export function ephemeralPassword(): string {
  return `Ed-${randomUUID()}`;
}

export function syntheticEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@edison.example`;
}

export interface SignedIn {
  client: SupabaseClient;
  userId: string;
  accessToken: string;
}

export async function signIn(email: string, password: string): Promise<SignedIn> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`Could not sign in as ${email}: ${error?.message}`);
  }

  // Mirrors signInAction: a token minted inside an invalidation second is
  // refused by design, so mint a fresh one once the clock has moved on.
  const { data: account } = await client.rpc('app_my_account');
  const row = Array.isArray(account)
    ? (account[0] as { session_is_current?: boolean })
    : undefined;
  if (row && row.session_is_current === false) {
    await waitForNextSecond();
    const { data: refreshed } = await client.auth.refreshSession();
    if (refreshed.session) {
      return { client, userId: data.user.id, accessToken: refreshed.session.access_token };
    }
  }

  return { client, userId: data.user.id, accessToken: data.session.access_token };
}

export async function trySignIn(
  email: string,
  password: string,
): Promise<{ ok: boolean; message: string }> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  return { ok: !error, message: error?.message ?? '' };
}

/** Bootstraps an active administrator, the way the local bootstrap script does. */
export async function createAdmin(
  displayName = 'Morgan Ellis',
): Promise<{ email: string; password: string; id: string; session: SignedIn }> {
  const service = serviceClient();
  const email = syntheticEmail('admin');
  const password = ephemeralPassword();

  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Could not create admin: ${error?.message}`);

  const { error: accountError } = await service.from('app_accounts').insert({
    id: data.user.id,
    display_name: displayName,
    email,
    role: 'admin',
    status: 'active',
  });
  if (accountError) throw new Error(`Could not create admin account: ${accountError.message}`);

  return { email, password, id: data.user.id, session: await signIn(email, password) };
}

/**
 * Creates a technician exactly as the server action does: the admin's own
 * session authorizes and reserves, then the privileged step finalizes.
 */
export async function provisionTechnician(
  admin: SignedIn,
  displayName = 'Priya Raman',
): Promise<{ email: string; accountId: string }> {
  const email = syntheticEmail('tech');
  const service = serviceClient();

  const { data: provisionId, error: reserveError } = await admin.client.rpc(
    'app_admin_request_account',
    { p_email: email, p_display_name: displayName },
  );
  if (reserveError) throw new Error(`Reserve failed: ${reserveError.message}`);

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (createError || !created.user) throw new Error(`Auth user failed: ${createError?.message}`);

  const { data: accountId, error: finalizeError } = await service.rpc(
    'app_trusted_finalize_account',
    { p_provision: provisionId, p_user: created.user.id },
  );
  if (finalizeError) throw new Error(`Finalize failed: ${finalizeError.message}`);

  return { email, accountId: accountId as string };
}

/**
 * Issues a link the way the server action does, returning only the token hash —
 * which is what the app's /auth/confirm callback consumes.
 */
export async function issueLink(
  admin: SignedIn,
  accountId: string,
  purpose: 'setup' | 'recovery',
  ttlSeconds = 3600,
): Promise<string> {
  const { data: grantId, error: grantError } = await admin.client.rpc('app_admin_request_credential_grant', {
    p_account: accountId,
    p_purpose: purpose,
    p_ttl_seconds: ttlSeconds,
  });
  if (grantError) throw new Error(`Grant failed: ${grantError.message}`);

  const service = serviceClient();
  const { data: account } = await service
    .from('app_accounts')
    .select('email')
    .eq('id', accountId)
    .single();

  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: 'recovery',
    email: account?.email as string,
  });
  if (linkError || !link) throw new Error(`Link failed: ${linkError?.message}`);
  const { error: bindingError } = await service.rpc('app_trusted_bind_credential_link', {
    p_grant: grantId,
    p_digest: createHash('sha256').update(link.properties.hashed_token).digest('hex'),
  });
  if (bindingError) throw new Error('Link binding failed.');
  return link.properties.hashed_token;
}

/** Replays what /auth/confirm does: exchange the token, then record the grant. */
export async function exchangeLink(
  tokenHash: string,
): Promise<{ ok: boolean; message: string; client?: SupabaseClient; userId?: string }> {
  const client = anonClient();
  const { data, error } = await client.auth.verifyOtp({
    type: 'recovery',
    token_hash: tokenHash,
  });
  if (error || !data.user) {
    return { ok: false, message: error?.message ?? 'invalid link' };
  }

  const { error: verifyError } = await serviceClient().rpc('app_trusted_verify_grant', {
    p_account: data.user.id,
    p_digest: createHash('sha256').update(tokenHash).digest('hex'),
    p_session: await sessionId(client),
  });
  if (verifyError) {
    await client.auth.signOut();
    return { ok: false, message: verifyError.message };
  }
  return { ok: true, message: '', client, userId: data.user.id };
}

/** Replays the completion server action: set the password, then activate. */
export async function completeWithPassword(
  client: SupabaseClient,
  userId: string,
  password: string,
): Promise<{ ok: boolean; message: string; purpose?: string }> {
  const session = await sessionId(client);
  const { data: grant, error: beginError } = await serviceClient().rpc('app_trusted_begin_credential_action', {
    p_account: userId, p_session: session,
  });
  if (beginError) return { ok: false, message: beginError.message };
  const { error: passwordError } = await client.auth.updateUser({ password });
  if (passwordError) return { ok: false, message: passwordError.message };

  const { data, error } = await serviceClient().rpc('app_trusted_complete_credential_action', {
    p_account: userId,
    p_grant: grant,
    p_session: session,
    p_password: password,
  });
  if (error) return { ok: false, message: error.message };

  const row = Array.isArray(data) ? (data[0] as { purpose: string }) : undefined;
  await client.auth.signOut({ scope: 'global' });
  return { ok: true, message: '', purpose: row?.purpose };
}

export async function sessionId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getClaims();
  if (error || typeof data?.claims.session_id !== 'string') throw new Error('Missing verified session.');
  return data.claims.session_id;
}

export async function accountRow(accountId: string): Promise<Record<string, unknown>> {
  const { data, error } = await serviceClient()
    .from('app_accounts')
    .select('*')
    .eq('id', accountId)
    .single();
  if (error) throw new Error(`Could not read account: ${error.message}`);
  return data as Record<string, unknown>;
}

/** A client that carries a specific access token, to test a stale session. */
export function clientWithToken(accessToken: string): SupabaseClient {
  const local = stack();
  return createClient(local.apiUrl, local.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Whole seconds: the revocation cutoff compares against the JWT `iat` claim. */
export async function waitForNextSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 25));
}
