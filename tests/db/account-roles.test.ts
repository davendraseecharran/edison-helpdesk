/**
 * Account role administration: the database is the authorization boundary,
 * role changes preserve status, and old target sessions stop being current.
 *
 * A role is a set from P2-3 onward, so the RPC is `app_set_account_roles` and
 * takes an array. `role` is still read here because it is still the derived
 * column every older gate consults, and proving it follows the set is the whole
 * point of keeping it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anonClient,
  adminServiceClient,
  forgetSessions,
  freshSession,
  identities,
  identity,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

const EPOCH = '1970-01-01T00:00:00.000Z';

async function restoreRoleFixtures(): Promise<void> {
  const service = adminServiceClient();
  for (const person of identities()) {
    const { error } = await service
      .from('app_accounts')
      .update({
        roles: person.roles,
        sessions_valid_from: EPOCH,
      })
      .eq('id', person.id);
    if (error) throw new Error(`Could not restore role fixture: ${error.message}`);
  }
  forgetSessions();
}

beforeEach(restoreRoleFixtures);
afterEach(restoreRoleFixtures);

describe('account roles', () => {
  it('lets an admin promote and demote an account, audits it, and revokes old sessions', async () => {
    const admin = await signIn('admin');
    const target = await freshSession('owner');
    const targetId = identity('owner').id;

    const before = await admin
      .from('app_accounts')
      .select('sessions_valid_from')
      .eq('id', targetId)
      .single();
    expect(before.error).toBeNull();

    expect(
      await rpcOk(admin, 'app_set_account_roles', {
        p_account: targetId,
        p_roles: ['admin'],
      }),
    ).toBe(targetId);

    const promoted = await admin
      .from('app_accounts')
      .select('role, roles, status, sessions_valid_from')
      .eq('id', targetId)
      .single();
    expect(promoted.error).toBeNull();
    expect(promoted.data?.role).toBe('admin');
    expect(promoted.data?.roles).toEqual(['admin']);
    expect(promoted.data?.status).toBe('active');
    expect(new Date(String(promoted.data?.sessions_valid_from)).getTime()).toBeGreaterThan(
      new Date(String(before.data?.sessions_valid_from)).getTime(),
    );

    const staleStatus = await rpcOk<Array<Record<string, unknown>>>(target, 'app_my_account');
    expect(staleStatus[0]?.session_is_current).toBe(false);

    const { data: events, error: eventError } = await admin
      .from('account_events')
      .select('kind, actor_id, detail')
      .eq('account_id', targetId)
      .eq('kind', 'role_changed')
      .order('at', { ascending: false })
      .limit(1);
    expect(eventError).toBeNull();
    expect(events?.[0]?.actor_id).toBe(identity('admin').id);
    expect(events?.[0]?.detail).toBe('Roles changed from netrider to admin.');

    expect(
      await rpcOk(admin, 'app_set_account_roles', {
        p_account: targetId,
        p_roles: ['netrider'],
      }),
    ).toBe(targetId);
    const demoted = await admin
      .from('app_accounts')
      .select('role, roles, status')
      .eq('id', targetId)
      .single();
    expect(demoted.data).toEqual({ role: 'technician', roles: ['netrider'], status: 'active' });
  });

  it('accepts only the three roles and is callable only by an active administrator', async () => {
    const owner = await signIn('owner');
    const netriderFailure = await rpcFails(owner, 'app_set_account_roles', {
      p_account: identity('unrelated').id,
      p_roles: ['admin'],
    });
    expect(netriderFailure.message).toMatch(/only an administrator/i);

    const anonymousFailure = await rpcFails(anonClient(), 'app_set_account_roles', {
      p_account: identity('owner').id,
      p_roles: ['admin'],
    });
    expect(anonymousFailure.message).toMatch(/permission denied|function/i);

    const admin = await signIn('admin');
    const invalidRole = await rpcFails(admin, 'app_set_account_roles', {
      p_account: identity('owner').id,
      p_roles: ['superadmin'],
    });
    expect(invalidRole.message).toMatch(/administrator, netrider or skills officer/i);

    const emptySet = await rpcFails(admin, 'app_set_account_roles', {
      p_account: identity('owner').id,
      p_roles: [],
    });
    expect(emptySet.message).toMatch(/at least one role/i);
  });

  it('does not remove the last active usable administrator', async () => {
    const admin = await signIn('admin');
    const failure = await rpcFails(admin, 'app_set_account_roles', {
      p_account: identity('admin').id,
      p_roles: ['netrider'],
    });
    expect(failure.message).toMatch(/last active administrator/i);

    const { data } = await admin
      .from('app_accounts')
      .select('role, roles, status')
      .eq('id', identity('admin').id)
      .single();
    expect(data).toEqual({ role: 'admin', roles: ['admin'], status: 'active' });
  });

  it('does not count an administrator with an unapproved credential as a usable replacement', async () => {
    const service = adminServiceClient();
    const targetId = identity('owner').id;
    const promoted = await service.from('app_accounts').update({ role: 'admin' }).eq('id', targetId);
    expect(promoted.error).toBeNull();
    const original = await service.from('account_credential_state').select('approved_digest').eq('account_id', targetId).single();
    if (original.error || !original.data) throw new Error('Could not read synthetic credential state.');
    try {
      const invalidated = await service.from('account_credential_state').update({ approved_digest: 'synthetic-unapproved' }).eq('account_id', targetId);
      expect(invalidated.error).toBeNull();
      const failure = await rpcFails(await signIn('admin'), 'app_set_account_roles', {
        p_account: identity('admin').id, p_roles: ['netrider'],
      });
      expect(failure.message).toMatch(/last active administrator/i);
    } finally {
      const restored = await service.from('account_credential_state').update({ approved_digest: original.data.approved_digest }).eq('account_id', targetId);
      if (restored.error) throw new Error('Could not restore synthetic credential state.');
    }
  });

  it('never activates pending or inactive accounts during a role change', async () => {
    const admin = await signIn('admin');
    for (const [key, status] of [
      ['pending', 'setup_pending'],
      ['inactive', 'inactive'],
    ] as const) {
      const accountId = identity(key).id;
      await rpcOk(admin, 'app_set_account_roles', {
        p_account: accountId,
        p_roles: ['admin'],
      });

      const { data } = await admin
        .from('app_accounts')
        .select('role, status')
        .eq('id', accountId)
        .single();
      expect(data).toEqual({ role: 'admin', status });

      await rpcOk(admin, 'app_set_account_roles', {
        p_account: accountId,
        p_roles: ['netrider'],
      });
    }
  });
});

