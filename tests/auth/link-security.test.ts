/**
 * Setup/recovery link security: expiry, replay, supersession, malformed input,
 * and the fact that a link for one account cannot act on another.
 *
 * Both flows ride on the provider's `recovery` token type, because an `invite`
 * link cannot be generated for an already-registered user. The app-level
 * purpose therefore comes from the stored grant, never from the callback URL.
 */

import { describe, expect, it } from 'vitest';
import {
  accountRow,
  completeWithPassword,
  createAdmin,
  ephemeralPassword,
  exchangeLink,
  issueLink,
  provisionTechnician,
  serviceClient,
  signIn,
} from './support/harness';

async function activeTechnician(admin: Awaited<ReturnType<typeof createAdmin>>['session']) {
  const tech = await provisionTechnician(admin);
  const password = ephemeralPassword();
  const token = await issueLink(admin, tech.accountId, 'setup');
  const exchange = await exchangeLink(token);
  await completeWithPassword(exchange.client!, exchange.userId!, password);
  return { ...tech, password };
}

describe('link lifecycle', () => {
  it('rejects a replayed link', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);
    const token = await issueLink(admin.session, tech.accountId, 'setup');

    const first = await exchangeLink(token);
    expect(first.ok).toBe(true);
    await completeWithPassword(first.client!, first.userId!, ephemeralPassword());

    // The same token again: the provider refuses it outright.
    const replay = await exchangeLink(token);
    expect(replay.ok).toBe(false);
    expect(replay.message).toMatch(/invalid|expired/i);
  });

  it('rejects a superseded link once a newer one is issued', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);

    const firstToken = await issueLink(admin.session, tech.accountId, 'setup');
    const secondToken = await issueLink(admin.session, tech.accountId, 'setup');

    const stale = await exchangeLink(firstToken);
    expect(stale.ok).toBe(false);

    const fresh = await exchangeLink(secondToken);
    expect(fresh.ok).toBe(true);

    // The app's own record agrees with the provider: one live grant only.
    const { data: grants } = await serviceClient()
      .from('account_credential_grants')
      .select('id, superseded_at')
      .eq('account_id', tech.accountId);
    expect((grants ?? []).filter((g) => g.superseded_at !== null)).toHaveLength(1);
  });

  it('rejects an expired link at both the provider and the app record', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);
    const token = await issueLink(admin.session, tech.accountId, 'setup', 60);
    const service = serviceClient();

    // Age the provider's token past its expiry window, and the app grant past
    // its own. Ageing the stored timestamps is how expiry is made testable
    // without waiting an hour.
    await service.rpc('app_test_age_recovery_token', {
      p_account: tech.accountId,
      p_seconds: 7200,
    });
    await service
      .from('account_credential_grants')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('account_id', tech.accountId);

    const expired = await exchangeLink(token);
    expect(expired.ok).toBe(false);
    expect((await accountRow(tech.accountId)).status).toBe('setup_pending');
  });

  it('rejects malformed and unknown tokens', async () => {
    for (const token of ['', 'short', 'x'.repeat(600), 'not-a-real-token-but-long-enough-abc123']) {
      const attempt = await exchangeLink(token);
      expect(attempt.ok, `token "${token.slice(0, 12)}" must be refused`).toBe(false);
    }
  });

  it('cannot complete an account that has no verified grant', async () => {
    const admin = await createAdmin();
    const victim = await provisionTechnician(admin.session, 'Victim');
    const attacker = await activeTechnician(admin.session);

    // A live, legitimately signed-in technician cannot reach the trusted
    // completion at all: it is granted to service_role only.
    const session = await signIn(attacker.email, attacker.password);
    const { error } = await session.client.rpc('app_trusted_complete_credential_action', {
      p_account: victim.accountId,
    });
    expect(error?.message).toMatch(/permission denied|function|schema cache/i);
    expect((await accountRow(victim.accountId)).status).toBe('setup_pending');
  });

  it('does not let a recovery link complete a different pending account', async () => {
    const admin = await createAdmin();
    const pending = await provisionTechnician(admin.session, 'Still Pending');
    const active = await activeTechnician(admin.session);

    // A recovery link for the ACTIVE account produces a session for that
    // account. The completion is keyed to the session's own user id, so it can
    // only ever complete that account's grant.
    const token = await issueLink(admin.session, active.accountId, 'recovery');
    const exchange = await exchangeLink(token);
    expect(exchange.ok).toBe(true);
    expect(exchange.userId).toBe(active.accountId);

    const completion = await completeWithPassword(
      exchange.client!,
      exchange.userId!,
      ephemeralPassword(),
    );
    expect(completion.purpose).toBe('recovery');
    expect((await accountRow(pending.accountId)).status).toBe('setup_pending');
  });

  it('refuses a recovery link for a pending account and a setup link for an active one', async () => {
    const admin = await createAdmin();
    const pending = await provisionTechnician(admin.session, 'Pending Person');
    const active = await activeTechnician(admin.session);

    const wrongRecovery = await admin.session.client.rpc('app_admin_request_credential_grant', {
      p_account: pending.accountId,
      p_purpose: 'recovery',
      p_ttl_seconds: 3600,
    });
    expect(wrongRecovery.error?.message).toMatch(/has not completed setup/i);

    const wrongSetup = await admin.session.client.rpc('app_admin_request_credential_grant', {
      p_account: active.accountId,
      p_purpose: 'setup',
      p_ttl_seconds: 3600,
    });
    expect(wrongSetup.error?.message).toMatch(/already completed setup/i);
  });

  it('never stores a link, token, or password anywhere in the account tables', async () => {
    const admin = await createAdmin();
    const tech = await provisionTechnician(admin.session);
    const token = await issueLink(admin.session, tech.accountId, 'setup');
    const exchange = await exchangeLink(token);
    const password = ephemeralPassword();
    await completeWithPassword(exchange.client!, exchange.userId!, password);

    const service = serviceClient();
    const [grants, events, accounts, provisions, bindings, credentialState] = await Promise.all([
      service.from('account_credential_grants').select('*'),
      service.from('account_events').select('*'),
      service.from('app_accounts').select('*'),
      service.from('account_provisions').select('*'),
      service.from('account_credential_bindings').select('*'),
      service.from('account_credential_state').select('*'),
    ]);

    const serialised = JSON.stringify([grants.data, events.data, accounts.data, provisions.data, bindings.data, credentialState.data]);

    // Reduce to booleans BEFORE asserting. A failing expectation must not echo
    // the payload — that would print the very secrets this test is about.
    const findings = {
      containsToken: serialised.includes(token),
      containsPassword: serialised.includes(password),
      containsTokenField: /token_hash|hashed_token|"token"/i.test(serialised),
      containsPasswordField: /"password"|password_hash|encrypted_password/i.test(serialised),
      containsUrl: /https?:\/\//.test(serialised),
    };

    expect(findings).toEqual({
      containsToken: false,
      containsPassword: false,
      containsTokenField: false,
      containsPasswordField: false,
      containsUrl: false,
    });

    // The audit trail still records that the actions happened.
    const kinds = (events.data ?? []).map((event) => (event as { kind: string }).kind);
    expect(kinds).toContain('setup_issued');
    expect(kinds).toContain('setup_completed');
    expect(kinds).toContain('sessions_invalidated');
  });
});
