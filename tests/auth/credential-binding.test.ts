import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountRow, anonClient, completeWithPassword, createAdmin, ephemeralPassword,
  exchangeLink, issueLink, provisionTechnician, serviceClient, sessionId, signIn } from './support/harness';

async function fixture() {
  const admin = await createAdmin();
  const tech = await provisionTechnician(admin.session);
  const password = ephemeralPassword();
  const exchange = await exchangeLink(await issueLink(admin.session, tech.accountId, 'setup'));
  expect((await completeWithPassword(exchange.client!, tech.accountId, password)).ok).toBe(true);
  return { admin, tech, password };
}

async function expectBlocked(client: ReturnType<typeof anonClient>) {
  const { data } = await client.rpc('app_my_account');
  expect(data?.[0]?.session_is_current).toBe(false);
  const write = await client.rpc('app_create_ticket', {
    p_title: 'Unauthorized mutation', p_issue: 'Must be denied', p_channel: 'walk_in', p_requester_unknown: true,
  });
  expect(write.error).not.toBeNull();
}

describe('credential and session binding', () => {
  it('keeps binding metadata and the new trusted contracts unavailable to clients', async () => {
    const { tech, password } = await fixture();
    const signedIn = await signIn(tech.email, password);
    for (const client of [anonClient(), signedIn.client]) {
      for (const table of ['account_credential_bindings', 'account_credential_state']) {
        expect((await client.from(table).select('*')).error).not.toBeNull();
      }
      const result = await client.rpc('app_trusted_begin_credential_action', {
        p_account: tech.accountId, p_session: await sessionId(signedIn.client),
      });
      expect(result.error?.message).toMatch(/permission denied/i);
    }
  });

  it('refuses an old browser before it can change a verified recovery password', async () => {
    const { admin, tech, password } = await fixture();
    const old = await signIn(tech.email, password);
    const exchanged = await exchangeLink(await issueLink(admin.session, tech.accountId, 'recovery'));
    const attack = await completeWithPassword(old.client, tech.accountId, ephemeralPassword());
    expect(attack.ok).toBe(false);
    expect((await completeWithPassword(exchanged.client!, tech.accountId, ephemeralPassword())).ok).toBe(true);
  });

  it('keeps a refreshed old session revoked after reactivation', async () => {
    const { admin, tech, password } = await fixture();
    const old = await signIn(tech.email, password);
    for (const status of ['inactive', 'active']) {
      expect((await admin.session.client.rpc('app_set_account_status', { p_account: tech.accountId, p_status: status })).error).toBeNull();
    }
    expect((await old.client.auth.refreshSession()).error).toBeNull();
    await expectBlocked(old.client);
    const fresh = await signIn(tech.email, password);
    expect((await fresh.client.rpc('app_my_account')).data?.[0]?.session_is_current).toBe(true);
  });

  it.each([false, true])('blocks cancelled link takeover, already exchanged = %s', async (alreadyExchanged) => {
    const { admin, tech, password } = await fixture();
    const token = await issueLink(admin.session, tech.accountId, 'recovery');
    const attacker = anonClient();
    if (alreadyExchanged) expect((await attacker.auth.verifyOtp({ type: 'recovery', token_hash: token })).error).toBeNull();
    expect((await admin.session.client.rpc('app_admin_cancel_credential_action', { p_account: tech.accountId })).error).toBeNull();
    if (!alreadyExchanged) expect((await attacker.auth.verifyOtp({ type: 'recovery', token_hash: token })).error).toBeNull();
    await expectBlocked(attacker);
    const malicious = ephemeralPassword();
    expect((await attacker.auth.updateUser({ password: malicious })).error).toBeNull();
    const newSession = await signIn(tech.email, malicious);
    await expectBlocked(newSession.client);
    // Administrative recovery still repairs an unapproved provider change.
    const repair = await exchangeLink(await issueLink(admin.session, tech.accountId, 'recovery'));
    expect((await completeWithPassword(repair.client!, tech.accountId, password)).ok).toBe(true);
    expect((await (await signIn(tech.email, password)).client.rpc('app_my_account')).data?.[0]?.session_is_current).toBe(true);
  });

  it('does not bind a superseded provider token to a replacement grant during issuance', async () => {
    const { admin, tech } = await fixture();
    const stale = await issueLink(admin.session, tech.accountId, 'recovery');
    const { data: replacement, error } = await admin.session.client.rpc('app_admin_request_credential_grant', {
      p_account: tech.accountId, p_purpose: 'recovery', p_ttl_seconds: 3600,
    });
    expect(error).toBeNull();
    // Replacement exists, but its provider token has not yet been generated.
    const attacker = anonClient();
    expect((await attacker.auth.verifyOtp({ type: 'recovery', token_hash: stale })).error).toBeNull();
    const verify = await serviceClient().rpc('app_trusted_verify_grant', {
      p_account: tech.accountId, p_digest: createHash('sha256').update(stale).digest('hex'), p_session: await sessionId(attacker),
    });
    expect(verify.error).not.toBeNull();
    expect((await serviceClient().from('account_credential_grants').select('verified_at').eq('id', replacement).single()).data?.verified_at).toBeNull();
  });

  it('admits only one completion and fails closed if cancellation races a provider update', async () => {
    const { admin, tech } = await fixture();
    const exchange = await exchangeLink(await issueLink(admin.session, tech.accountId, 'recovery'));
    const session = await sessionId(exchange.client!);
    const args = { p_account: tech.accountId, p_session: session };
    const attempts = await Promise.all([
      serviceClient().rpc('app_trusted_begin_credential_action', args),
      serviceClient().rpc('app_trusted_begin_credential_action', args),
    ]);
    expect(attempts.filter((a) => !a.error)).toHaveLength(1);
    const grant = attempts.find((a) => !a.error)!.data;
    await admin.session.client.rpc('app_admin_cancel_credential_action', { p_account: tech.accountId });
    const password = ephemeralPassword();
    expect((await exchange.client!.auth.updateUser({ password })).error).toBeNull();
    const completion = await serviceClient().rpc('app_trusted_complete_credential_action', {
      ...args, p_grant: grant, p_password: password,
    });
    expect(completion.error).not.toBeNull();
    await expectBlocked((await signIn(tech.email, password)).client);
    expect((await accountRow(tech.accountId)).credential_action_pending).toBe(false);
  });

  it('does not approve a different password overwritten between provider update and completion', async () => {
    const { admin, tech } = await fixture();
    const exchange = await exchangeLink(await issueLink(admin.session, tech.accountId, 'recovery'));
    const session = await sessionId(exchange.client!);
    const { data: grant } = await serviceClient().rpc('app_trusted_begin_credential_action', {
      p_account: tech.accountId, p_session: session,
    });
    const intended = ephemeralPassword();
    const overwritten = ephemeralPassword();
    expect((await exchange.client!.auth.updateUser({ password: intended })).error).toBeNull();
    expect((await exchange.client!.auth.updateUser({ password: overwritten })).error).toBeNull();
    const completion = await serviceClient().rpc('app_trusted_complete_credential_action', {
      p_account: tech.accountId, p_session: session, p_grant: grant, p_password: intended,
    });
    expect(completion.error).not.toBeNull();
    await expectBlocked((await signIn(tech.email, overwritten)).client);
  });
});
