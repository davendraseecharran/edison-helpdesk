/**
 * One account, two ways in.
 *
 * Until M5 the two doors belonged to different people: Google was everybody's
 * and a password was an administrator's break-glass path, issued as a one-time
 * link. Any active account may now hold a password it set on itself, from
 * Settings, while it is signed in — and that is the whole difficulty. The
 * recovery flow ENDS by invalidating every session, because a link is exchanged
 * by whoever holds it. This one must not: the person is already signed in, in
 * the browser they are looking at, and signing them out would be a strange
 * answer to "set a password".
 *
 * So these tests follow the exact steps `setOwnPasswordAction` takes —
 * `updateUser` through the person's own session, then
 * `app_trusted_approve_own_credential` through the service role — and check the
 * three things that make it either right or dangerous:
 *
 *   * the session that made the change is still current afterwards, and the
 *     account's revocation cutoff has not moved;
 *   * the new password really is a way in, proved by signing in with it;
 *   * the approval function is reachable by the trusted server alone.
 *
 * Nothing is mocked. The one prop is the authentication method recorded against
 * a session: no OAuth provider can be configured on a local stack, so a real
 * `oauth` session cannot be obtained here, and — exactly as
 * tests/auth/oauth-session.test.ts does — an existing session's recorded method
 * is restated. Everything else about it is genuine.
 *
 * Manual identity linking (`enable_manual_linking`) is deliberately not
 * exercised: it needs a real provider round trip, which cannot run here.
 */

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  accountRow,
  anonClient,
  createAdmin,
  ephemeralPassword,
  serviceClient,
  signIn,
  syntheticEmail,
  type SignedIn,
} from './support/harness';

interface Methods {
  google_email: string | null;
  has_password: boolean;
}

interface Person {
  id: string;
  email: string;
  client: SupabaseClient;
}

async function signInMethods(client: SupabaseClient): Promise<Methods | undefined> {
  const { data, error } = await client.rpc('app_my_sign_in_methods');
  if (error) throw new Error(`app_my_sign_in_methods failed: ${error.message}`);
  return ((data ?? []) as Methods[])[0];
}

async function sessionIsCurrent(client: SupabaseClient): Promise<boolean | undefined> {
  const { data, error } = await client.rpc('app_my_account');
  if (error) throw new Error(`app_my_account failed: ${error.message}`);
  return ((data ?? []) as Array<{ session_is_current: boolean }>)[0]?.session_is_current;
}

async function eventKinds(accountId: string): Promise<string[]> {
  const { data, error } = await serviceClient()
    .from('account_events')
    .select('kind')
    .eq('account_id', accountId);
  if (error) throw new Error(`Could not read the audit trail: ${error.message}`);
  return ((data ?? []) as Array<{ kind: string }>).map((row) => row.kind);
}

/**
 * An account in the state this feature exists for: invited by an administrator,
 * signed in through Google, and holding no password at all.
 *
 * The auth user is created with no password, so `encrypted_password` is null and
 * the trigger that captures the initial credential records the digest of an
 * empty string — which is exactly what a Google-only account looks like in the
 * database. The identity is written directly because no provider can be
 * configured locally, and the account itself is created by the same trusted
 * function the OAuth callback calls.
 */
async function googleOnlyAccount(admin: SignedIn, displayName: string): Promise<Person> {
  const service = serviceClient();
  const email = syntheticEmail('google-only');

  const { error: inviteError } = await admin.client.rpc('app_admin_create_invite', {
    p_email: email,
    p_role: 'technician',
    p_display_name: displayName,
  });
  if (inviteError) throw new Error(`Invite failed: ${inviteError.message}`);

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: displayName },
    app_metadata: { provider: 'google', providers: ['google'] },
  });
  if (createError || !created.user) throw new Error(`Auth user failed: ${createError?.message}`);

  const { error: identityError } = await service.rpc('app_test_add_verified_identity', {
    p_user: created.user.id,
    p_email: email,
  });
  if (identityError) throw new Error(`Identity failed: ${identityError.message}`);

  const { data: linked, error: linkError } = await service.rpc('app_trusted_link_identity', {
    p_user: created.user.id,
  });
  if (linkError) throw new Error(`Linking failed: ${linkError.message}`);
  const outcome = (Array.isArray(linked) ? linked[0]?.outcome : undefined) as string | undefined;
  if (outcome !== 'invited') throw new Error(`Expected an invited account, got ${outcome}.`);

  return { id: created.user.id, email, client: await providerSession(email) };
}

/**
 * A signed-in session for an account that has no password.
 *
 * There is no password to sign in with, so a link is exchanged for a session
 * exactly as the rest of this suite does, and the method recorded against it is
 * then restated as `oauth` — what GoTrue records for a provider sign-in, and
 * what `app_token_is_current` accepts. Without that restatement the session
 * would read as a link exchange, which is restricted by design and would make
 * this a test of the wrong thing.
 */
async function providerSession(email: string): Promise<SupabaseClient> {
  const service = serviceClient();
  const { data: link, error: linkError } = await service.auth.admin.generateLink({
    type: 'recovery',
    email,
  });
  if (linkError || !link) throw new Error(`Link failed: ${linkError?.message}`);

  const client = anonClient();
  const { data, error } = await client.auth.verifyOtp({
    type: 'recovery',
    token_hash: link.properties.hashed_token,
  });
  if (error || !data.session) throw new Error(`Could not establish a session: ${error?.message}`);

  const { data: claims } = await client.auth.getClaims();
  const session = claims?.claims.session_id;
  if (typeof session !== 'string') throw new Error('Missing verified session.');

  const { data: rows, error: amrError } = await service.rpc('app_test_set_session_amr', {
    p_session: session,
    p_method: 'oauth',
  });
  if (amrError || rows !== 1) throw new Error(`Could not restate the session method: ${amrError?.message}`);

  return client;
}

describe('setting a password on yourself', () => {
  it('keeps the session that made the change, and makes the password a real way in', async () => {
    const admin = await createAdmin();
    const person = await googleOnlyAccount(admin.session, 'Alex Moreau');
    const before = await accountRow(person.id);

    expect(await sessionIsCurrent(person.client)).toBe(true);
    expect(await signInMethods(person.client)).toEqual({
      google_email: person.email,
      has_password: false,
    });

    const password = ephemeralPassword();

    // Step one of the server action: the provider's own primitive, through the
    // person's own session. The application never hashes a password.
    expect((await person.client.auth.updateUser({ password })).error).toBeNull();

    // Between the two steps the helpdesk has not approved the new hash, so the
    // session is deliberately NOT current: a password changed at the provider
    // and nowhere else fails closed. The approval is what repairs it.
    expect(await sessionIsCurrent(person.client)).toBe(false);

    // Step two: the trusted approval, which moves nothing but the digest.
    const { error } = await serviceClient().rpc('app_trusted_approve_own_credential', {
      p_user: person.id,
    });
    expect(error).toBeNull();

    expect(
      await sessionIsCurrent(person.client),
      'the person changed their own password while signed in; the session stays',
    ).toBe(true);
    expect(await signInMethods(person.client)).toEqual({
      google_email: person.email,
      has_password: true,
    });

    const after = await accountRow(person.id);
    expect(
      after.sessions_valid_from,
      'unlike the recovery path, this must not revoke anything',
    ).toBe(before.sessions_valid_from);

    // And it is a way in, not just a row: the password signs them in for real.
    const signedIn = await signIn(person.email, password);
    expect((await signedIn.client.rpc('app_my_account')).data?.[0]?.session_is_current).toBe(true);

    // The trail says what happened, and says it once.
    const kinds = await eventKinds(person.id);
    expect(kinds).toContain('password_set');
    expect(kinds).not.toContain('sessions_invalidated');
  });

  it('refuses an account that is not active', async () => {
    // Nobody invited this one, so it is waiting for an administrator and can
    // reach nothing. A password would be a way into an account that has not
    // been let in yet.
    const email = syntheticEmail('waiting');
    const service = serviceClient();
    const { data: created, error: createError } = await service.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { provider: 'google', providers: ['google'] },
    });
    if (createError || !created.user) throw new Error(`Auth user failed: ${createError?.message}`);
    await service.rpc('app_test_add_verified_identity', { p_user: created.user.id, p_email: email });

    const { data: linked } = await service.rpc('app_trusted_link_identity', {
      p_user: created.user.id,
    });
    expect((Array.isArray(linked) ? linked[0]?.status : undefined)).toBe('pending_approval');

    const { error } = await service.rpc('app_trusted_approve_own_credential', {
      p_user: created.user.id,
    });
    expect(error?.message).toMatch(/cannot set a password of its own/i);
  });
});

describe('what the account can sign in with', () => {
  it('answers for the caller alone, and for nobody else', async () => {
    const admin = await createAdmin();
    const person = await googleOnlyAccount(admin.session, 'Priya Raman');

    // The harness administrator was created with a password through the admin
    // API, which is not one of the helpdesk's two password paths (a link, or
    // Settings), so the helpdesk does not count it: the provider stores a hash
    // for every user, usable or not, and only its own paths stamp
    // password_set_at. A real first administrator arrives through the setup
    // link and is counted.
    expect(await signInMethods(admin.session.client)).toEqual({
      google_email: null,
      has_password: false,
    });
    expect(await signInMethods(person.client)).toEqual({
      google_email: person.email,
      has_password: false,
    });

    // It takes no parameter, so there is no other account to ask about.
    const { error } = await anonClient().rpc('app_my_sign_in_methods');
    expect(error?.message).toMatch(/permission denied/i);
  });
});

describe('who may approve a credential', () => {
  it('refuses the approval function to every client role', async () => {
    const admin = await createAdmin();

    // Including on their own account: this is the trusted server's to call,
    // after it has changed the password through the caller's own session.
    const asAdmin = await admin.session.client.rpc('app_trusted_approve_own_credential', {
      p_user: admin.id,
    });
    expect(asAdmin.error?.message).toMatch(/permission denied/i);

    const asAnon = await anonClient().rpc('app_trusted_approve_own_credential', {
      p_user: admin.id,
    });
    expect(asAnon.error?.message).toMatch(/permission denied/i);
  });
});
