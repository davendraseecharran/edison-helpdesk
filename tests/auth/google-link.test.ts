/**
 * Google sign-in: what the trusted server does the first time an identity
 * reaches the helpdesk, and every time afterwards.
 *
 * `app_trusted_link_identity` is the whole decision. It is called by the OAuth
 * callback with the id of a user the provider has just authenticated, and it
 * answers one of four things:
 *
 *   existing   — this auth user already has an account; nothing changes.
 *   invited    — an administrator invited this address, so the account is
 *                created active with the invited role and the invite is spent.
 *   requested  — nobody invited this address, so the account is created waiting
 *                for an administrator, and the administrators are told.
 *   unverified — the provider has not confirmed this address, so no account is
 *                created at all.
 *
 * Nothing is mocked: these are real Auth users created through the admin API and
 * a real database function called with the service role, exactly as the callback
 * route will call it.
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
  type SignedIn,
} from './support/harness';

interface LinkResult {
  outcome: string;
  account_id: string | null;
  status: string | null;
}

interface GoogleUser {
  id: string;
  email: string;
  password: string;
}

/**
 * An Auth user shaped the way a Google sign-in produces one: the provider is
 * recorded in app metadata and the name arrives in user metadata. A password is
 * set as well, purely so a test can later prove the account really works from a
 * signed-in session; the linking function never looks at it.
 */
async function createGoogleUser(options: {
  email: string;
  fullName?: string | null;
  verified?: boolean;
}): Promise<GoogleUser> {
  const password = ephemeralPassword();
  const { data, error } = await serviceClient().auth.admin.createUser({
    email: options.email,
    password,
    email_confirm: options.verified ?? true,
    user_metadata: options.fullName ? { full_name: options.fullName } : {},
    app_metadata: { provider: 'google', providers: ['google'] },
  });
  if (error || !data.user) {
    throw new Error(`Could not create the Google identity: ${error?.message}`);
  }
  return { id: data.user.id, email: options.email, password };
}

/** Exactly what /auth/callback does once the provider hands back a session. */
async function link(userId: string): Promise<LinkResult> {
  const { data, error } = await serviceClient().rpc('app_trusted_link_identity', {
    p_user: userId,
  });
  if (error) throw new Error(`Linking failed: ${error.message}`);
  const rows = (data ?? []) as LinkResult[];
  if (rows.length !== 1) throw new Error(`Expected one linking result, got ${rows.length}.`);
  return rows[0];
}

async function adminRpc<T>(
  admin: SignedIn,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin.client.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as T;
}

async function accountExists(userId: string): Promise<boolean> {
  const { data, error } = await serviceClient().from('app_accounts').select('id').eq('id', userId);
  if (error) throw new Error(`Could not look for an account: ${error.message}`);
  return (data ?? []).length > 0;
}

async function noticesFor(accountId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await serviceClient()
    .from('notifications')
    .select('kind, title, body, href')
    .eq('account_id', accountId);
  if (error) throw new Error(`Could not read notifications: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

describe('signing in without an invite', () => {
  it('creates an account that waits for an administrator', async () => {
    const user = await createGoogleUser({
      email: syntheticEmail('casey'),
      fullName: 'Casey Lindqvist',
    });

    const result = await link(user.id);
    expect(result.outcome).toBe('requested');
    expect(result.account_id).toBe(user.id);
    expect(result.status).toBe('pending_approval');

    const row = await accountRow(user.id);
    expect(row.display_name).toBe('Casey Lindqvist');
    expect(row.email).toBe(user.email);
    expect(row.role).toBe('technician');
    expect(row.status).toBe('pending_approval');
  });

  it('tells the administrators that someone is waiting', async () => {
    const admin = await createAdmin('Morgan Ellis');
    const user = await createGoogleUser({
      email: syntheticEmail('rowan'),
      fullName: 'Rowan De Leon',
    });

    await link(user.id);

    const notice = (await noticesFor(admin.id)).find((row) => row.kind === 'access_requested');
    expect(notice, 'every active administrator is told about a new request').toBeTruthy();
    expect(notice?.href).toBe('/admin');
    expect(String(notice?.body)).toContain('Rowan De Leon');
  });

  it('falls back to the local part of the address when no name is offered', async () => {
    const email = syntheticEmail('nameless');
    const user = await createGoogleUser({ email, fullName: null });

    expect((await link(user.id)).outcome).toBe('requested');
    expect((await accountRow(user.id)).display_name).toBe(email.split('@')[0]);
  });

  it('lets an administrator approve the request, after which the account works', async () => {
    const admin = await createAdmin();
    const user = await createGoogleUser({
      email: syntheticEmail('approved'),
      fullName: 'Blair Okonkwo',
    });
    expect((await link(user.id)).status).toBe('pending_approval');

    await adminRpc(admin.session, 'app_admin_review_access_request', {
      p_account: user.id,
      p_decision: 'approve',
      p_role: 'technician',
    });

    const row = await accountRow(user.id);
    expect(row.status).toBe('active');
    expect(row.role).toBe('technician');

    const approved = await signIn(user.email, user.password);
    const { data } = await approved.client.rpc('app_my_account');
    const self = (data as Array<{ status: string }>)[0];
    expect(self?.status).toBe('active');
    // The approval reached them as a notice they can act on.
    expect((await noticesFor(user.id)).map((notice) => notice.kind)).toContain('access_approved');
  });
});

describe('signing in with a live invite', () => {
  it('activates the account with the invited role and spends the invite', async () => {
    const admin = await createAdmin();
    const email = syntheticEmail('invited');
    const inviteId = await adminRpc<string>(admin.session, 'app_admin_create_invite', {
      p_email: email,
      p_role: 'admin',
      p_display_name: 'Priya Raman',
    });

    const user = await createGoogleUser({ email, fullName: 'Name From Google' });
    const result = await link(user.id);

    expect(result.outcome).toBe('invited');
    expect(result.account_id).toBe(user.id);
    expect(result.status).toBe('active');

    const row = await accountRow(user.id);
    expect(row.role).toBe('admin');
    // The name the administrator typed wins over the one the provider supplied.
    expect(row.display_name).toBe('Priya Raman');

    const { data: invite } = await serviceClient()
      .from('account_invites')
      .select('accepted_at, accepted_account_id, revoked_at')
      .eq('id', inviteId)
      .single();
    expect(invite?.accepted_at).not.toBeNull();
    expect(invite?.accepted_account_id).toBe(user.id);
    expect(invite?.revoked_at).toBeNull();
  });

  it('reports the same account, unchanged, on every later sign-in', async () => {
    const admin = await createAdmin();
    const email = syntheticEmail('returning');
    await adminRpc(admin.session, 'app_admin_create_invite', {
      p_email: email,
      p_role: 'technician',
    });
    const user = await createGoogleUser({ email, fullName: 'Dev Okafor' });

    expect((await link(user.id)).outcome).toBe('invited');

    const second = await link(user.id);
    expect(second.outcome).toBe('existing');
    expect(second.account_id).toBe(user.id);
    expect(second.status).toBe('active');

    const third = await link(user.id);
    expect(third.outcome).toBe('existing');
    expect((await accountRow(user.id)).role).toBe('technician');
  });

  it('ignores an expired invite and one that was withdrawn', async () => {
    const admin = await createAdmin();

    const expiredEmail = syntheticEmail('expired');
    const expiredInvite = await adminRpc<string>(admin.session, 'app_admin_create_invite', {
      p_email: expiredEmail,
      p_role: 'admin',
    });
    const { error: ageError } = await serviceClient()
      .from('account_invites')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', expiredInvite);
    if (ageError) throw new Error(`Could not age the invite: ${ageError.message}`);

    const lateArrival = await createGoogleUser({ email: expiredEmail, fullName: 'Late Arrival' });
    const expired = await link(lateArrival.id);
    expect(expired.outcome).toBe('requested');
    expect(expired.status).toBe('pending_approval');
    expect((await accountRow(lateArrival.id)).role).toBe('technician');

    const revokedEmail = syntheticEmail('revoked');
    const revokedInvite = await adminRpc<string>(admin.session, 'app_admin_create_invite', {
      p_email: revokedEmail,
      p_role: 'admin',
    });
    await adminRpc(admin.session, 'app_admin_revoke_invite', { p_invite: revokedInvite });

    const withdrawn = await createGoogleUser({ email: revokedEmail, fullName: 'Withdrawn Invite' });
    expect((await link(withdrawn.id)).outcome).toBe('requested');
  });
});

describe('an address the provider has not confirmed', () => {
  it('is refused, and leaves no account behind', async () => {
    const user = await createGoogleUser({
      email: syntheticEmail('unconfirmed'),
      fullName: 'Unconfirmed Person',
      verified: false,
    });

    const result = await link(user.id);
    expect(result.outcome).toBe('unverified');
    expect(result.account_id).toBeNull();
    expect(result.status).toBeNull();
    expect(await accountExists(user.id)).toBe(false);

    // Calling again still creates nothing: the answer depends on the provider's
    // confirmation, not on how many times the callback runs.
    expect((await link(user.id)).outcome).toBe('unverified');
    expect(await accountExists(user.id)).toBe(false);
  });

  it('is refused even when an invite is waiting for that address', async () => {
    const admin = await createAdmin();
    const email = syntheticEmail('unconfirmed-invited');
    const inviteId = await adminRpc<string>(admin.session, 'app_admin_create_invite', {
      p_email: email,
      p_role: 'admin',
    });

    const user = await createGoogleUser({ email, fullName: 'Unconfirmed Invitee', verified: false });
    expect((await link(user.id)).outcome).toBe('unverified');
    expect(await accountExists(user.id)).toBe(false);

    const { data: invite } = await serviceClient()
      .from('account_invites')
      .select('accepted_at')
      .eq('id', inviteId)
      .single();
    expect(invite?.accepted_at, 'an unconfirmed address must not spend an invite').toBeNull();
  });
});

describe('who may ask', () => {
  it('refuses the linking function to a signed-in administrator', async () => {
    const admin = await createAdmin();
    const { error } = await admin.session.client.rpc('app_trusted_link_identity', {
      p_user: admin.id,
    });
    expect(error?.message).toMatch(/permission denied/i);
  });

  it('refuses it to an anonymous caller', async () => {
    const { error } = await anonClient().rpc('app_trusted_link_identity', {
      p_user: '00000000-0000-0000-0000-000000000000',
    });
    expect(error?.message).toMatch(/permission denied|schema cache|function/i);
  });
});
