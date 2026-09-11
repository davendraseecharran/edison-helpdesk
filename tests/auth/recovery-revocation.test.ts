/**
 * Recovery and session invalidation.
 *
 * The key assertions here use a captured ACCESS TOKEN, not a client that might
 * quietly refresh itself. Supabase access tokens are self-contained JWTs that
 * stay cryptographically valid until they expire, and the admin API in this
 * version can only revoke a session given that session's own JWT — so provider
 * revocation alone cannot cut off another browser. The database enforces the
 * invalidation, and that is what is measured.
 */

import { describe, expect, it } from 'vitest';
import {
  accountRow,
  clientWithToken,
  completeWithPassword,
  createAdmin,
  ephemeralPassword,
  exchangeLink,
  issueLink,
  provisionTechnician,
  serviceClient,
  signIn,
  trySignIn,
} from './support/harness';

async function activeTechnician(
  admin: Awaited<ReturnType<typeof createAdmin>>['session'],
  name = 'Priya Raman',
) {
  const tech = await provisionTechnician(admin, name);
  const password = ephemeralPassword();
  const token = await issueLink(admin, tech.accountId, 'setup');
  const exchange = await exchangeLink(token);
  await completeWithPassword(exchange.client!, exchange.userId!, password);
  return { ...tech, password };
}

describe('recovery', () => {
  it('changes the password, and the old one stops working', async () => {
    const admin = await createAdmin();
    const tech = await activeTechnician(admin.session);
    const newPassword = ephemeralPassword();

    const token = await issueLink(admin.session, tech.accountId, 'recovery');
    const exchange = await exchangeLink(token);
    const completion = await completeWithPassword(exchange.client!, exchange.userId!, newPassword);
    expect(completion.ok).toBe(true);
    expect(completion.purpose).toBe('recovery');

    const withOld = await trySignIn(tech.email, tech.password);
    expect(withOld.ok).toBe(false);

    const withNew = await signIn(tech.email, newPassword);
    const { data } = await withNew.client.rpc('app_my_account');
    expect((data as Array<{ status: string }>)[0]?.status).toBe('active');
  });

  it('refuses a token captured before recovery, even though the JWT is still valid', async () => {
    const admin = await createAdmin();
    const tech = await activeTechnician(admin.session);

    // A second browser, signed in before recovery starts.
    const otherBrowser = await signIn(tech.email, tech.password);
    const staleToken = otherBrowser.accessToken;
    const staleClient = clientWithToken(staleToken);

    // It works right now.
    const before = await staleClient.rpc('app_my_account');
    expect(before.error).toBeNull();

    const token = await issueLink(admin.session, tech.accountId, 'recovery');
    const exchange = await exchangeLink(token);
    await completeWithPassword(exchange.client!, exchange.userId!, ephemeralPassword());

    // The same raw token, presented directly: refused by the database.
    const { data: tickets } = await staleClient.from('tickets').select('id');
    expect(tickets ?? []).toHaveLength(0);

    const write = await staleClient.rpc('app_create_ticket', {
      p_title: 'From a stale session',
      p_issue: 'Should be refused.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
    });
    expect(write.error?.message).toMatch(/signed out|cannot access helpdesk records/i);

    // And the self-status lookup reports exactly why.
    const { data: self } = await staleClient.rpc('app_my_account');
    expect((self as Array<{ session_is_current: boolean }>)[0]?.session_is_current).toBe(false);
  });

  it('suspends ticket access from the moment a recovery link is issued', async () => {
    const admin = await createAdmin();
    const tech = await activeTechnician(admin.session);
    const working = await signIn(tech.email, tech.password);

    const beforeIssue = await working.client.rpc('app_my_account');
    expect(beforeIssue.error).toBeNull();

    await issueLink(admin.session, tech.accountId, 'recovery');

    // A stolen link cannot be used to browse tickets before the password is
    // actually changed: the account is suspended the moment the link exists.
    const { data: tickets } = await working.client.from('tickets').select('id');
    expect(tickets ?? []).toHaveLength(0);
    const write = await working.client.rpc('app_create_ticket', {
      p_title: 'During an outstanding recovery',
      p_issue: 'Should be refused.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
    });
    expect(write.error?.message).toMatch(/finish setting your password|cannot access/i);

    expect((await accountRow(tech.accountId)).credential_action_pending).toBe(true);
  });

  it('lets an admin cancel an outstanding link and restore access', async () => {
    const admin = await createAdmin();
    const tech = await activeTechnician(admin.session);
    await issueLink(admin.session, tech.accountId, 'recovery');

    const { error } = await admin.session.client.rpc('app_admin_cancel_credential_action', {
      p_account: tech.accountId,
    });
    expect(error).toBeNull();
    expect((await accountRow(tech.accountId)).credential_action_pending).toBe(false);

    // The original password still works, because nothing was changed.
    const session = await signIn(tech.email, tech.password);
    const { error: readError } = await session.client.from('tickets').select('id');
    expect(readError).toBeNull();
  });

  it('never promotes a role or reactivates a deactivated account', async () => {
    const admin = await createAdmin();
    const tech = await activeTechnician(admin.session);

    // Deactivate, then try to use recovery to get back in.
    await admin.session.client.rpc('app_set_account_status', {
      p_account: tech.accountId,
      p_status: 'inactive',
    });

    const blocked = await admin.session.client.rpc('app_admin_request_credential_grant', {
      p_account: tech.accountId,
      p_purpose: 'recovery',
      p_ttl_seconds: 3600,
    });
    expect(blocked.error?.message).toMatch(/reactivate the account/i);

    // An unbound grant cannot complete, even through the trusted entry point.
    const service = serviceClient();
    await service.from('account_credential_grants').insert({
      account_id: tech.accountId,
      purpose: 'recovery',
      issued_by: admin.id,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      verified_at: new Date().toISOString(),
    });
    const { error } = await service.rpc('app_trusted_complete_credential_action', {
      p_account: tech.accountId,
    });
    expect(error).not.toBeNull();

    const row = await accountRow(tech.accountId);
    expect(row.status).toBe('inactive');
    expect(row.role).toBe('technician');
  });
});

describe('deactivation', () => {
  it('refuses a token captured before deactivation, and reactivation does not revive it', async () => {
    const admin = await createAdmin();
    const tech = await activeTechnician(admin.session);
    const session = await signIn(tech.email, tech.password);
    const staleClient = clientWithToken(session.accessToken);

    expect((await staleClient.rpc('app_my_account')).error).toBeNull();

    await admin.session.client.rpc('app_set_account_status', {
      p_account: tech.accountId,
      p_status: 'inactive',
    });

    const { data: duringDeactivation } = await staleClient.from('tickets').select('id');
    expect(duringDeactivation ?? []).toHaveLength(0);

    await admin.session.client.rpc('app_set_account_status', {
      p_account: tech.accountId,
      p_status: 'active',
    });

    // Reactivation restores the ACCOUNT, not the captured token.
    const { data: afterReactivation } = await staleClient.from('tickets').select('id');
    expect(afterReactivation ?? []).toHaveLength(0);
    const write = await staleClient.rpc('app_create_ticket', {
      p_title: 'With a token from before deactivation',
      p_issue: 'Should be refused.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
    });
    expect(write.error?.message).toMatch(/signed out|cannot access/i);

    // A genuinely new sign-in works.
    const reborn = await signIn(tech.email, tech.password);
    expect((await reborn.client.from('tickets').select('id')).error).toBeNull();
  });
});

describe('login responses', () => {
  it('gives one message for wrong password, unknown address, and restricted accounts', async () => {
    const admin = await createAdmin();
    const active = await activeTechnician(admin.session, 'Active Person');
    const pending = await provisionTechnician(admin.session, 'Pending Person');

    const wrongPassword = await trySignIn(active.email, ephemeralPassword());
    const unknownAddress = await trySignIn('nobody-at-all@edison.example', ephemeralPassword());
    const pendingAccount = await trySignIn(pending.email, ephemeralPassword());

    expect(wrongPassword.ok).toBe(false);
    expect(unknownAddress.ok).toBe(false);
    expect(pendingAccount.ok).toBe(false);

    // The provider's own message is identical in all three cases, so nothing
    // discloses whether an address exists or what state it is in.
    expect(unknownAddress.message).toBe(wrongPassword.message);
    expect(pendingAccount.message).toBe(wrongPassword.message);
  });
});
