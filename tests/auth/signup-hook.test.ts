/**
 * Public password sign-up is closed, and nothing else is.
 *
 * `[auth] enable_signup` has to be TRUE: it is the site-wide gate on GoTrue
 * creating an auth user, and while it is false a first Google sign-in is refused
 * too — which would stop an invited colleague exactly as firmly as an uninvited
 * stranger. `[auth.email] enable_signup = false` is not an alternative either,
 * because it disables the whole email provider, password LOGINS included, and
 * the administrator-issued setup and recovery flows depend on those.
 *
 * So the gate is `public.hook_before_user_created`. GoTrue runs it on both
 * paths where it creates an auth user itself: the public signup endpoint AND a
 * first sign-in through an external provider. It is safe on the second because
 * it decides on `app_metadata.provider` rather than on the path — 'email' is
 * refused, 'google' passes through — and the admin API does not run it at all.
 * These tests pin that down from both sides: the one door it must close, and
 * the three it must leave open.
 *
 * What was at risk is worth being specific about. An auth user with no
 * app_accounts row reaches nothing at all, so this was never a route to
 * helpdesk data. It is pre-registration that matters: claiming a colleague's
 * address with a password before they are invited, so that the identity GoTrue
 * later links to that address carries a password somebody else chose.
 */

import { describe, expect, it } from 'vitest';
import {
  accountRow,
  anonClient,
  createAdmin,
  ephemeralPassword,
  serviceClient,
  signIn,
  syntheticEmail,
} from './support/harness';

/** Whether GoTrue holds an auth user for this address at all. */
async function authUserExists(email: string): Promise<boolean> {
  const { data, error } = await serviceClient().auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Could not list auth users: ${error.message}`);
  return (data?.users ?? []).some((user) => user.email === email);
}

describe('the door the hook closes', () => {
  it('refuses public email and password self-registration', async () => {
    const email = syntheticEmail('selfsignup');

    const { data, error } = await anonClient().auth.signUp({
      email,
      password: ephemeralPassword(),
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/created by the administrator/i);
    expect(error?.message).toMatch(/sign in with google/i);
    expect(error?.status).toBe(403);

    // Refused before the user is written, not cleaned up afterwards: no auth
    // user exists for that address, so the address is still free for the real
    // person to be invited to later. That is the whole point of the control.
    expect(data.user).toBeNull();
    expect(await authUserExists(email)).toBe(false);
  });

  it('refuses it however many times it is asked', async () => {
    const email = syntheticEmail('persistent');
    const anon = anonClient();

    for (const attempt of [1, 2, 3]) {
      const { error } = await anon.auth.signUp({ email, password: ephemeralPassword() });
      expect(error?.message, `attempt ${attempt}`).toMatch(/created by the administrator/i);
    }
    expect(await authUserExists(email)).toBe(false);
  });
});

describe('the doors the hook leaves open', () => {
  it('still lets the administrator API create a password account', async () => {
    // The admin API does not run this hook at all, which is what keeps
    // app_admin_request_account / app_trusted_finalize_account working.
    const email = syntheticEmail('provisioned');
    const password = ephemeralPassword();

    const { data, error } = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(error).toBeNull();
    expect(data.user?.email).toBe(email);
    expect(await authUserExists(email)).toBe(true);
  });

  it('still lets an administrator be bootstrapped and sign in with a password', async () => {
    // End to end through the harness the rest of the auth suite uses: create the
    // administrator, then really sign in. Password LOGIN is untouched, which is
    // exactly what [auth.email] enable_signup = false would have broken.
    const admin = await createAdmin('Morgan Ellis');
    const { data } = await admin.session.client.rpc('app_my_account');
    const self = (data as Array<{ status: string; role: string }>)[0];
    expect(self?.status).toBe('active');
    expect(self?.role).toBe('admin');

    const again = await signIn(admin.email, admin.password);
    expect(again.userId).toBe(admin.id);
  });

  it('still lets a provider identity reach the helpdesk and be approved', async () => {
    // A Google-shaped user, created the way the OAuth callback's user arrives,
    // and linked through the trusted entry point. The hook must be invisible to
    // this path: provider is not 'email', so it never objects.
    const email = syntheticEmail('google');
    const { data: created, error } = await serviceClient().auth.admin.createUser({
      email,
      password: ephemeralPassword(),
      email_confirm: true,
      user_metadata: { full_name: 'Rowan De Leon' },
      app_metadata: { provider: 'google', providers: ['google'] },
    });
    if (error || !created.user) throw new Error(`Could not create the identity: ${error?.message}`);

    const { data: linked, error: linkError } = await serviceClient().rpc(
      'app_trusted_link_identity',
      { p_user: created.user.id },
    );
    expect(linkError).toBeNull();
    const result = (linked as Array<{ outcome: string; status: string }>)[0];
    expect(result?.outcome).toBe('requested');
    expect(result?.status).toBe('pending_approval');

    const admin = await createAdmin();
    const { error: reviewError } = await admin.session.client.rpc(
      'app_admin_review_access_request',
      { p_account: created.user.id, p_decision: 'approve', p_role: 'technician' },
    );
    expect(reviewError).toBeNull();
    expect((await accountRow(created.user.id)).status).toBe('active');
  });
});
