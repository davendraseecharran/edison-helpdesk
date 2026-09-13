/**
 * M5 account states: invites, access requests and role changes.
 *
 * Four things are proven here, all through the same surface a browser reaches:
 *
 *   1. Invites are an administrator-only record. A technician cannot create,
 *      list or revoke one, and cannot read the table directly either, because
 *      the invite list is a list of people's email addresses.
 *   2. An account waiting for an access decision, and one that has been denied,
 *      reach nothing at all — no tickets, no directory — and do not appear in
 *      the directory other technicians see.
 *   3. Approving or denying a request is an administrator decision that is
 *      recorded in the account audit trail and told to the person waiting.
 *      Nobody can review their own request or change their own role.
 *   4. `app_trusted_link_identity` is reachable only by the trusted server.
 *      A signed-in administrator cannot call it, and neither can anyone else.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import {
  adminServiceClient,
  anonClient,
  identities,
  identity,
  rpcFails,
  rpcOk,
  signIn,
  stack,
} from './support/harness';
import { restoreIdentityStates } from './support/identities';

/** insufficient_privilege and check_violation, as PostgREST reports them. */
const REFUSED = '42501';
const REJECTED = '23514';

let service: SupabaseClient;
let admin: SupabaseClient;
let owner: SupabaseClient;
let awaitingReview: SupabaseClient;
let denied: SupabaseClient;

interface InviteRow {
  id: string;
  email: string;
  role: string;
  display_name: string | null;
  invited_by: string;
  invited_by_name: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  state: string;
}

/** Fresh per call, so a rerun without a database reset never collides. */
function inviteEmail(): string {
  return `invite-${randomUUID().slice(0, 8)}@edison.example`;
}

async function listInvites(): Promise<InviteRow[]> {
  return rpcOk<InviteRow[]>(admin, 'app_admin_list_invites');
}

async function invited(email: string): Promise<InviteRow | undefined> {
  return (await listInvites()).find((row) => row.email === email);
}

async function accountRow(accountId: string): Promise<Record<string, unknown>> {
  const { data, error } = await service
    .from('app_accounts')
    .select('role, status')
    .eq('id', accountId)
    .single();
  if (error) throw new Error(`Could not read account ${accountId}: ${error.message}`);
  return data as Record<string, unknown>;
}

async function accountEventKinds(accountId: string): Promise<string[]> {
  const { data, error } = await service
    .from('account_events')
    .select('kind')
    .eq('account_id', accountId);
  if (error) throw new Error(`Could not read account events: ${error.message}`);
  return (data ?? []).map((row) => String((row as { kind: string }).kind));
}

async function notices(accountId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('notifications')
    .select('kind, title, href')
    .eq('account_id', accountId);
  if (error) throw new Error(`Could not read notifications: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, awaitingReview, denied] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('pendingApproval'),
    signIn('denied'),
  ]);
});

afterAll(async () => {
  // This file approves and denies seeded accounts on purpose, so it hands the
  // fixtures back in their intended state for whichever file runs next.
  await restoreIdentityStates(stack(), identities());
});

describe('invites', () => {
  it('lets an administrator invite someone, and lists the invite as pending', async () => {
    const email = inviteEmail();
    const inviteId = await rpcOk<string>(admin, 'app_admin_create_invite', {
      p_email: email,
      p_role: 'technician',
      p_display_name: 'Blair Okonkwo',
    });
    expect(inviteId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await invited(email);
    expect(row?.id).toBe(inviteId);
    expect(row?.state).toBe('pending');
    expect(row?.role).toBe('technician');
    expect(row?.display_name).toBe('Blair Okonkwo');
    expect(row?.invited_by).toBe(identity('admin').id);
    expect(row?.invited_by_name).toBe('Morgan Ellis');
    expect(row?.accepted_at).toBeNull();
    expect(row?.revoked_at).toBeNull();
  });

  it('normalises the address and refuses a malformed address or role', async () => {
    const email = inviteEmail();
    await rpcOk(admin, 'app_admin_create_invite', {
      p_email: `  ${email.toUpperCase()}  `,
      p_role: 'admin',
    });
    const row = await invited(email);
    expect(row?.role).toBe('admin');
    expect(row?.display_name).toBeNull();

    expect(
      (await rpcFails(admin, 'app_admin_create_invite', {
        p_email: 'not-an-address',
        p_role: 'technician',
      })).code,
    ).toBe(REJECTED);
    expect(
      (await rpcFails(admin, 'app_admin_create_invite', {
        p_email: inviteEmail(),
        p_role: 'superuser',
      })).code,
    ).toBe(REJECTED);
  });

  it('supersedes a live invite when the same address is invited again', async () => {
    const email = inviteEmail();
    const first = await rpcOk<string>(admin, 'app_admin_create_invite', {
      p_email: email,
      p_role: 'technician',
    });
    const second = await rpcOk<string>(admin, 'app_admin_create_invite', {
      p_email: email,
      p_role: 'admin',
    });
    expect(second).not.toBe(first);

    const rows = await listInvites();
    expect(rows.find((row) => row.id === first)?.state).toBe('revoked');
    expect(rows.find((row) => row.id === second)?.state).toBe('pending');
    // Exactly one live invite per address, whichever way an admin arrives at it.
    expect(rows.filter((row) => row.email === email && row.state === 'pending')).toHaveLength(1);
  });

  it('revokes an invite, and refuses to revoke it twice or to revoke nothing', async () => {
    const email = inviteEmail();
    const inviteId = await rpcOk<string>(admin, 'app_admin_create_invite', {
      p_email: email,
      p_role: 'technician',
    });
    await rpcOk(admin, 'app_admin_revoke_invite', { p_invite: inviteId });
    expect((await invited(email))?.state).toBe('revoked');

    expect((await rpcFails(admin, 'app_admin_revoke_invite', { p_invite: inviteId })).code).toBe(
      REJECTED,
    );
    expect((await rpcFails(admin, 'app_admin_revoke_invite', { p_invite: randomUUID() })).code).toBe(
      REJECTED,
    );
  });

  it('refuses an invite for an address that already has an account', async () => {
    const failure = await rpcFails(admin, 'app_admin_create_invite', {
      p_email: identity('owner').email,
      p_role: 'technician',
    });
    expect(failure.code).toBe(REJECTED);
  });

  it('keeps invited addresses away from technicians and anonymous callers', async () => {
    expect(
      (await rpcFails(owner, 'app_admin_create_invite', {
        p_email: inviteEmail(),
        p_role: 'technician',
      })).code,
    ).toBe(REFUSED);
    expect((await rpcFails(owner, 'app_admin_list_invites')).code).toBe(REFUSED);
    expect((await rpcFails(owner, 'app_admin_revoke_invite', { p_invite: randomUUID() })).code).toBe(
      REFUSED,
    );

    // The table is exactly as private as the RPC: an admin sees the rows, a
    // technician sees none, and an anonymous caller is refused outright.
    const asAdmin = await admin.from('account_invites').select('id, email');
    expect(asAdmin.error).toBeNull();
    expect((asAdmin.data ?? []).length).toBeGreaterThan(0);

    const asTechnician = await owner.from('account_invites').select('id, email');
    expect(asTechnician.data ?? []).toHaveLength(0);

    const anon = anonClient();
    const anonRead = await anon.from('account_invites').select('id');
    expect(anonRead.data ?? []).toHaveLength(0);
    const anonRpc = await rpcFails(anon, 'app_admin_create_invite', {
      p_email: inviteEmail(),
      p_role: 'technician',
    });
    // No EXECUTE at all, so the call never runs. An executed-and-refused call
    // would say something else entirely, and must not satisfy this assertion.
    expect(anonRpc.message).toMatch(/permission denied/i);
  });

  it('cannot be written from a session, not even an administrator one', async () => {
    const insert = await admin.from('account_invites').insert({
      email: inviteEmail(),
      role: 'admin',
      invited_by: identity('admin').id,
    });
    expect(insert.error?.message).toMatch(/permission denied|violates row-level security/i);

    const update = await admin.from('account_invites').update({ role: 'admin' }).neq('role', '');
    expect(update.error?.message).toMatch(/permission denied/i);
  });
});

describe('access requests', () => {
  it('leaves an account awaiting a decision with no helpdesk access at all', async () => {
    const self = await rpcOk<Array<Record<string, unknown>>>(awaitingReview, 'app_my_account');
    expect(self[0]?.status).toBe('pending_approval');

    const { data } = await awaitingReview.from('tickets').select('id');
    expect(data ?? []).toHaveLength(0);
    expect((await rpcFails(awaitingReview, 'app_directory')).code).toBe(REFUSED);

    const deniedSelf = await rpcOk<Array<Record<string, unknown>>>(denied, 'app_my_account');
    expect(deniedSelf[0]?.status).toBe('denied');
    const deniedTickets = await denied.from('tickets').select('id');
    expect(deniedTickets.data ?? []).toHaveLength(0);
    expect((await rpcFails(denied, 'app_directory')).code).toBe(REFUSED);
  });

  it('keeps accounts awaiting or refused a decision out of the directory', async () => {
    const rows = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_directory');
    const ids = rows.map((row) => row.id);
    expect(ids).not.toContain(identity('pendingApproval').id);
    expect(ids).not.toContain(identity('denied').id);
    // A deactivated colleague is still shown, because their name appears on
    // historical work; someone who never gained access has no work to attribute.
    expect(ids).toContain(identity('inactive').id);
  });

  it('refuses a review by a technician, a self-review, and a nonsense decision', async () => {
    expect(
      (await rpcFails(owner, 'app_admin_review_access_request', {
        p_account: identity('pendingApproval').id,
        p_decision: 'approve',
      })).code,
    ).toBe(REFUSED);

    expect(
      (await rpcFails(admin, 'app_admin_review_access_request', {
        p_account: identity('admin').id,
        p_decision: 'deny',
      })).code,
    ).toBe(REFUSED);

    expect(
      (await rpcFails(admin, 'app_admin_review_access_request', {
        p_account: identity('pendingApproval').id,
        p_decision: 'maybe',
      })).code,
    ).toBe(REJECTED);

    // An account that is not waiting for a decision is not reviewable.
    expect(
      (await rpcFails(admin, 'app_admin_review_access_request', {
        p_account: identity('owner').id,
        p_decision: 'approve',
      })).code,
    ).toBe(REJECTED);
  });

  it('denies a request, records the decision, and tells the person waiting', async () => {
    await rpcOk(admin, 'app_admin_review_access_request', {
      p_account: identity('pendingApproval').id,
      p_decision: 'deny',
    });

    expect(await accountRow(identity('pendingApproval').id)).toMatchObject({
      status: 'denied',
      role: 'technician',
    });
    expect(await accountEventKinds(identity('pendingApproval').id)).toContain('access_denied');

    const notice = (await notices(identity('pendingApproval').id)).find(
      (row) => row.kind === 'access_denied',
    );
    expect(notice?.href).toBe('/restricted');

    // Denying again changes nothing and says so.
    expect(
      (await rpcFails(admin, 'app_admin_review_access_request', {
        p_account: identity('pendingApproval').id,
        p_decision: 'deny',
      })).code,
    ).toBe(REJECTED);
  });

  it('approves a refused request with a role, activating the account immediately', async () => {
    await rpcOk(admin, 'app_admin_review_access_request', {
      p_account: identity('pendingApproval').id,
      p_decision: 'approve',
      p_role: 'admin',
    });

    expect(await accountRow(identity('pendingApproval').id)).toMatchObject({
      status: 'active',
      role: 'admin',
    });
    const kinds = await accountEventKinds(identity('pendingApproval').id);
    expect(kinds).toContain('access_approved');
    expect(kinds).toContain('role_changed');

    const notice = (await notices(identity('pendingApproval').id)).find(
      (row) => row.kind === 'access_approved',
    );
    expect(notice?.href).toBe('/queue');

    // The decision reaches the session that was already open, with no new token.
    const directory = await rpcOk<Array<Record<string, unknown>>>(awaitingReview, 'app_directory');
    expect(directory.map((row) => row.id)).toContain(identity('pendingApproval').id);
  });

  it('refuses the ordinary status RPC for an account awaiting a decision', async () => {
    const failure = await rpcFails(admin, 'app_set_account_status', {
      p_account: identity('denied').id,
      p_status: 'active',
    });
    expect(failure.code).toBe(REFUSED);
  });
});

describe('role changes', () => {
  it('sets another account’s role, and never the administrator’s own', async () => {
    expect(
      (await rpcFails(admin, 'app_admin_set_role', {
        p_account: identity('admin').id,
        p_role: 'technician',
      })).code,
    ).toBe(REFUSED);

    expect(
      (await rpcFails(owner, 'app_admin_set_role', {
        p_account: identity('collaborator').id,
        p_role: 'admin',
      })).code,
    ).toBe(REFUSED);

    await rpcOk(admin, 'app_admin_set_role', {
      p_account: identity('unrelated').id,
      p_role: 'admin',
    });
    expect(await accountRow(identity('unrelated').id)).toMatchObject({ role: 'admin' });
    expect(await accountEventKinds(identity('unrelated').id)).toContain('role_changed');

    // Setting the same role again, or a role on an account that has not been
    // reviewed yet, is refused.
    expect(
      (await rpcFails(admin, 'app_admin_set_role', {
        p_account: identity('unrelated').id,
        p_role: 'admin',
      })).code,
    ).toBe(REJECTED);
    expect(
      (await rpcFails(admin, 'app_admin_set_role', {
        p_account: identity('denied').id,
        p_role: 'admin',
      })).code,
    ).toBe(REJECTED);

    await rpcOk(admin, 'app_admin_set_role', {
      p_account: identity('unrelated').id,
      p_role: 'technician',
    });
    expect(await accountRow(identity('unrelated').id)).toMatchObject({ role: 'technician' });
  });
});

describe('trusted identity linking', () => {
  it('is unreachable from any session, administrator or not', async () => {
    const asAdmin = await rpcFails(admin, 'app_trusted_link_identity', {
      p_user: identity('admin').id,
    });
    expect(asAdmin.message).toMatch(/permission denied/i);

    const asTechnician = await rpcFails(owner, 'app_trusted_link_identity', {
      p_user: identity('owner').id,
    });
    expect(asTechnician.message).toMatch(/permission denied/i);

    const asAnon = await rpcFails(anonClient(), 'app_trusted_link_identity', {
      p_user: identity('owner').id,
    });
    expect(asAnon.message).toMatch(/permission denied/i);
  });

  it('answers the trusted server with the account that already exists', async () => {
    const rows = await rpcOk<Array<Record<string, unknown>>>(service, 'app_trusted_link_identity', {
      p_user: identity('owner').id,
    });
    expect(rows[0]?.outcome).toBe('existing');
    expect(rows[0]?.account_id).toBe(identity('owner').id);
    expect(rows[0]?.status).toBe('active');
  });
});
