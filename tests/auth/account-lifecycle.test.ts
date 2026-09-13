/**
 * Account creation, setup, and the rules around activation.
 *
 * Acceptance focus: only a live admin can create accounts or issue links; a
 * pending account can reach nothing and cannot activate itself; and activation
 * requires BOTH a verified link and a successful password change.
 */

import { describe, expect, it } from 'vitest';
import {
  accountRow,
  anonClient,
  completeWithPassword,
  createAdmin,
  ephemeralPassword,
  exchangeLink,
  issueLink,
  provisionTechnician,
  serviceClient,
  signIn,
  syntheticEmail,
  trySignIn,
} from './support/harness';

describe('who may create accounts', () => {
  it('refuses anonymous, technician, and deactivated callers', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);
    const password = ephemeralPassword();
    const token = await issueLink(admin.session, tech.accountId, 'setup');
    const exchange = await exchangeLink(token);
    expect(exchange.ok).toBe(true);
    await completeWithPassword(exchange.client!, exchange.userId!, password);
    const technician = await signIn(tech.email, password);

    // Anonymous.
    const anonymous = await anonClient().rpc('app_admin_request_account', {
      p_email: syntheticEmail('intruder'),
      p_display_name: 'Intruder',
    });
    expect(anonymous.error?.message).toMatch(/permission denied|cannot access/i);

    // A real, active technician session.
    const asTechnician = await technician.client.rpc('app_admin_request_account', {
      p_email: syntheticEmail('intruder'),
      p_display_name: 'Intruder',
    });
    expect(asTechnician.error?.message).toMatch(/only an administrator/i);

    // A deactivated admin.
    const secondAdmin = await createAdmin('Second Admin');
    await admin.session.client.rpc('app_set_account_status', {
      p_account: secondAdmin.id,
      p_status: 'inactive',
    });
    const asDeactivated = await secondAdmin.session.client.rpc('app_admin_request_account', {
      p_email: syntheticEmail('intruder'),
      p_display_name: 'Intruder',
    });
    expect(asDeactivated.error?.message).toMatch(/cannot access helpdesk records/i);
  });

  it('refuses public self-registration', async () => {
    const { error } = await anonClient().auth.signUp({
      email: syntheticEmail('selfsignup'),
      password: ephemeralPassword(),
    });
    expect(error).not.toBeNull();
    // Refused by the before-user-created hook rather than by GoTrue's own
    // signup flag, which has to stay on for a first Google sign-in to work.
    // See tests/auth/signup-hook.test.ts.
    expect(error?.message).toMatch(/created by the administrator/i);
  });

  it('makes a duplicated or retried provision idempotent', async () => {
    const admin = await createAdmin();
    const email = syntheticEmail('retry');
    const service = serviceClient();

    const first = await admin.session.client.rpc('app_admin_request_account', {
      p_email: email,
      p_display_name: 'Retry Case',
    });
    expect(first.error).toBeNull();

    // A retry before the auth user exists returns the SAME reservation, so a
    // partial failure cannot produce two accounts for one person.
    const second = await admin.session.client.rpc('app_admin_request_account', {
      p_email: email,
      p_display_name: 'Retry Case',
    });
    expect(second.error).toBeNull();
    expect(second.data).toBe(first.data);

    const { data: created } = await service.auth.admin.createUser({ email, email_confirm: true });
    const userId = created?.user?.id;
    expect(userId).toBeTruthy();
    const finalizeOnce = await service.rpc('app_trusted_finalize_account', {
      p_provision: first.data,
      p_user: userId,
    });
    const finalizeTwice = await service.rpc('app_trusted_finalize_account', {
      p_provision: first.data,
      p_user: userId,
    });
    expect(finalizeOnce.error).toBeNull();
    expect(finalizeTwice.error).toBeNull();
    expect(finalizeTwice.data).toBe(finalizeOnce.data);

    const { count } = await service
      .from('app_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('email', email);
    expect(count).toBe(1);

    // Once completed, asking again is refused rather than silently reusing it.
    const third = await admin.session.client.rpc('app_admin_request_account', {
      p_email: email,
      p_display_name: 'Retry Case',
    });
    expect(third.error?.message).toMatch(/already uses that email/i);
  });
});

describe('a pending account', () => {
  it('starts restricted and can reach nothing', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);

    const row = await accountRow(tech.accountId);
    expect(row.status).toBe('setup_pending');

    // No password exists yet, so it cannot even sign in.
    const attempt = await trySignIn(tech.email, ephemeralPassword());
    expect(attempt.ok).toBe(false);
  });

  it('cannot be activated by the ordinary status RPC', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);

    for (const status of ['active', 'inactive']) {
      const { error } = await admin.session.client.rpc('app_set_account_status', {
        p_account: tech.accountId,
        p_status: status,
      });
      expect(error?.message).toMatch(/password setup must complete/i);
    }
    expect((await accountRow(tech.accountId)).status).toBe('setup_pending');
  });

  it('cannot be activated by a trusted completion without a verified link', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);

    // No link was ever issued, so there is no grant to satisfy.
    const { error } = await serviceClient().rpc('app_trusted_complete_credential_action', {
      p_account: tech.accountId,
    });
    expect(error?.message).toMatch(/no longer valid|function|schema cache/i);
    expect((await accountRow(tech.accountId)).status).toBe('setup_pending');
  });

  it('is still restricted after opening the link but before setting a password', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);
    const token = await issueLink(admin.session, tech.accountId, 'setup');

    const exchange = await exchangeLink(token);
    expect(exchange.ok).toBe(true);

    // The link produced a real session, but the account is not active yet.
    const { data: tickets } = await exchange.client!.from('tickets').select('id');
    expect(tickets ?? []).toHaveLength(0);

    const { error } = await exchange.client!.rpc('app_create_ticket', {
      p_title: 'Ticket from a restricted setup session',
      p_issue: 'Should be refused.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
    });
    expect(error?.message).toMatch(/cannot access helpdesk records|finish setting your password/i);
    expect((await accountRow(tech.accountId)).status).toBe('setup_pending');
  });

  it('activates only when the link and the password change both succeed', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);
    const password = ephemeralPassword();
    const token = await issueLink(admin.session, tech.accountId, 'setup');

    const exchange = await exchangeLink(token);
    const completion = await completeWithPassword(exchange.client!, exchange.userId!, password);
    expect(completion.ok).toBe(true);
    expect(completion.purpose).toBe('setup');

    const row = await accountRow(tech.accountId);
    expect(row.status).toBe('active');
    expect(row.credential_action_pending).toBe(false);

    // And the chosen password now works.
    const session = await signIn(tech.email, password);
    const { data } = await session.client.rpc('app_my_account');
    expect((data as Array<{ status: string }>)[0]?.status).toBe('active');
  });
});
