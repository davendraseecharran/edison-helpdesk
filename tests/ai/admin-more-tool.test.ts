/**
 * The Administration screen's remaining two panels — invites and the people
 * waiting for access — as the assistant reaches them.
 *
 * Two things are pinned that the older suites could not:
 *
 *   1. Somebody waiting for access is NOT in `app_directory`, on purpose, so
 *      `review_access_request` resolves a name against the waiting list the
 *      Access screen reads — the `app_accounts` table under the
 *      administrator's own row policies — rather than against a directory
 *      that will never hold them.
 *   2. An address may have been invited more than once. The pending invite is
 *      what the address means; a name that resolves to one already accepted
 *      is refused in those words rather than as "no such invite".
 */

import { describe, expect, it } from 'vitest';
import {
  ADMIN_READ_TOOLS,
  executeTool,
  isWriteTool,
  requiresApproval,
  toolsFor,
  validateArgs,
  type ToolContext,
} from '../../src/lib/ai/tools';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

interface TableRead {
  table: string;
  filter: [string, unknown] | null;
}

/**
 * The RPC stub the other suites use, plus enough of a PostgREST builder to
 * answer `from('app_accounts').select(...).eq(...).order(...)`.
 */
function context(
  options: {
    results?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
    roles?: string[];
    accounts?: Record<string, unknown>[];
  } = {},
): { ctx: ToolContext; calls: Call[]; reads: TableRead[] } {
  const calls: Call[] = [];
  const reads: TableRead[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const results = options.results ?? {};
        const found = fn in results ? results[fn] : null;
        return { data: typeof found === 'function' ? found(args) : found, error: null };
      },
      from: (table: string) => {
        const read: TableRead = { table, filter: null };
        reads.push(read);
        const builder = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            read.filter = [column, value];
            return builder;
          },
          order: () =>
            Promise.resolve({
              data: (options.accounts ?? []).filter(
                (row) => read.filter === null || row[read.filter[0]] === read.filter[1],
              ),
              error: null,
            }),
        };
        return builder;
      },
    },
    actor: { id: 'actor-1', displayName: 'Nia Example', roles: options.roles ?? ['admin'] },
  } as unknown as ToolContext;
  return { ctx, calls, reads };
}

const WAITING = 'eeeeeeee-1111-4111-8111-111111111111';
const WAITING_TOO = 'eeeeeeee-2222-4222-8222-222222222222';
const ACTIVE = 'eeeeeeee-3333-4333-8333-333333333333';

const ACCOUNTS = [
  { id: WAITING, display_name: 'Priya Patel', email: 'priya@example.com', status: 'pending_approval', created_at: '2026-09-15T13:00:00Z' },
  { id: WAITING_TOO, display_name: 'Priya Patil', email: 'p.patil@example.com', status: 'pending_approval', created_at: '2026-09-16T09:00:00Z' },
  { id: ACTIVE, display_name: 'Dev Okafor', email: 'dev@edison.example', status: 'active', created_at: '2026-09-01T09:00:00Z' },
];

const INVITE_OLD = 'ffffffff-1111-4111-8111-111111111111';
const INVITE_NEW = 'ffffffff-2222-4222-8222-222222222222';
const INVITE_DONE = 'ffffffff-3333-4333-8333-333333333333';

const INVITES = [
  { id: INVITE_NEW, email: 'sam@example.com', role: 'technician', roles: ['netrider'], display_name: 'Sam', invited_by_name: 'Nia Example', created_at: '2026-09-16T10:00:00Z', expires_at: '2026-09-30T10:00:00Z', accepted_at: null, revoked_at: null, state: 'pending' },
  { id: INVITE_OLD, email: 'sam@example.com', role: 'technician', roles: ['netrider'], display_name: 'Sam', invited_by_name: 'Nia Example', created_at: '2026-09-01T10:00:00Z', expires_at: '2026-09-15T10:00:00Z', accepted_at: null, revoked_at: '2026-09-02T10:00:00Z', state: 'revoked' },
  { id: INVITE_DONE, email: 'dev@edison.example', role: 'admin', roles: ['admin', 'netrider'], display_name: null, invited_by_name: 'Nia Example', created_at: '2026-08-20T10:00:00Z', expires_at: '2026-09-03T10:00:00Z', accepted_at: '2026-08-21T10:00:00Z', revoked_at: null, state: 'accepted' },
];

describe('who is offered what', () => {
  it('offers the two lists to an administrator alone, as reads that never ask', () => {
    for (const name of ['list_invites', 'list_access_requests']) {
      expect(ADMIN_READ_TOOLS).toContain(name);
      expect(toolsFor(['admin']).map((tool) => tool.name)).toContain(name);
      expect(toolsFor(['netrider']).map((tool) => tool.name)).not.toContain(name);
      expect(toolsFor(['skills_officer']).map((tool) => tool.name)).not.toContain(name);
      expect(isWriteTool(name)).toBe(false);
      expect(requiresApproval(name, {}, true)).toBe(false);
    }
  });

  it('makes revoking an invite an administrator change that always asks', () => {
    expect(toolsFor(['netrider']).map((tool) => tool.name)).not.toContain('revoke_invite');
    expect(requiresApproval('revoke_invite', { invite: 'sam@example.com' }, false)).toBe(true);
  });

  it('refuses a NetRider at the executor', async () => {
    const { ctx, calls, reads } = context({ roles: ['netrider'], accounts: ACCOUNTS });
    for (const name of ['list_invites', 'list_access_requests', 'revoke_invite']) {
      const result = await executeTool(name, name === 'revoke_invite' ? { invite: 'x' } : {}, ctx);
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/only an administrator/i);
    }
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
  });
});

describe('list_invites', () => {
  it('lists every invite with its roles and state', async () => {
    const { ctx } = context({ results: { app_admin_list_invites: INVITES } });
    const result = await executeTool('list_invites', {}, ctx);
    expect(result.ok).toBe(true);
    const listed = result.result as { email: string; roles: string[]; state: string; invitedBy: string | null }[];
    expect(listed.map((invite) => [invite.email, invite.state])).toEqual([
      ['sam@example.com', 'pending'],
      ['sam@example.com', 'revoked'],
      ['dev@edison.example', 'accepted'],
    ]);
    expect(listed[2].roles).toEqual(['admin', 'netrider']);
    expect(listed[0].invitedBy).toBe('Nia Example');
    expect(result.summary).toBe('Listed 3 invites.');
  });

  it('narrows to one state', async () => {
    const { ctx } = context({ results: { app_admin_list_invites: INVITES } });
    const result = await executeTool('list_invites', { state: 'pending' }, ctx);
    expect((result.result as unknown[]).length).toBe(1);
    expect(result.summary).toBe('Listed 1 pending invite.');
    expect(validateArgs('list_invites', { state: 'lost' }).ok).toBe(false);
  });
});

describe('revoke_invite', () => {
  it('revokes the pending invite to an address, not an older one', async () => {
    const { ctx, calls } = context({ results: { app_admin_list_invites: INVITES } });
    const result = await executeTool('revoke_invite', { invite: 'Sam@Example.com' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_admin_revoke_invite')?.args).toEqual({ p_invite: INVITE_NEW });
    expect(result.summary).toBe('Revoked the invite to sam@example.com');
  });

  it('says why when the invite named is not pending', async () => {
    const { ctx, calls } = context({ results: { app_admin_list_invites: INVITES } });
    const result = await executeTool('revoke_invite', { invite: 'dev@edison.example' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('The invite to dev@edison.example is accepted, so there is nothing to revoke.');
    expect(calls.map((call) => call.fn)).not.toContain('app_admin_revoke_invite');
  });

  it('takes an id from list_invites', async () => {
    const { ctx, calls } = context({ results: { app_admin_list_invites: INVITES } });
    const result = await executeTool('revoke_invite', { invite: INVITE_NEW }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_admin_revoke_invite')?.args.p_invite).toBe(INVITE_NEW);
  });

  it('names nobody when no invite went to that address', async () => {
    const { ctx } = context({ results: { app_admin_list_invites: INVITES } });
    const result = await executeTool('revoke_invite', { invite: 'nobody@example.com' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('No invite went to "nobody@example.com".');
  });
});

describe('list_access_requests', () => {
  it('reads the waiting accounts from the table the Access screen reads, oldest first', async () => {
    const { ctx, reads } = context({ accounts: ACCOUNTS });
    const result = await executeTool('list_access_requests', {}, ctx);
    expect(result.ok).toBe(true);
    expect(reads).toEqual([{ table: 'app_accounts', filter: ['status', 'pending_approval'] }]);
    expect((result.result as { name: string }[]).map((row) => row.name)).toEqual(['Priya Patel', 'Priya Patil']);
    expect(result.summary).toBe('2 people are waiting for access.');
  });

  it('says so when nobody is', async () => {
    const { ctx } = context({ accounts: [ACCOUNTS[2]] });
    const result = await executeTool('list_access_requests', {}, ctx);
    expect(result.summary).toBe('Nobody is waiting for access.');
  });
});

describe('review_access_request', () => {
  it('finds the waiting person by name, where the directory could not', async () => {
    const { ctx, calls } = context({ accounts: ACCOUNTS });
    const result = await executeTool(
      'review_access_request',
      { account: 'Priya Patel', decision: 'approve', role: 'skills_officer' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.fn)).not.toContain('app_directory');
    expect(calls.find((call) => call.fn === 'app_admin_review_access_request')?.args).toEqual({
      p_account: WAITING,
      p_decision: 'approve',
      p_roles: ['skills_officer'],
    });
    expect(result.summary).toBe('Approved access for Priya Patel');
  });

  it('finds them by address, and by id', async () => {
    for (const account of ['p.patil@example.com', WAITING_TOO]) {
      const { ctx, calls } = context({ accounts: ACCOUNTS });
      const result = await executeTool('review_access_request', { account, decision: 'deny' }, ctx);
      expect(result.ok).toBe(true);
      expect(calls.find((call) => call.fn === 'app_admin_review_access_request')?.args.p_account).toBe(WAITING_TOO);
      expect(result.summary).toBe('Declined access for Priya Patil');
    }
  });

  it('refuses a partial that fits two people, naming both', async () => {
    const { ctx, calls } = context({ accounts: ACCOUNTS });
    const result = await executeTool('review_access_request', { account: 'Priya', decision: 'approve' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Priya Patel (priya@example.com)');
    expect(result.summary).toContain('Priya Patil (p.patil@example.com)');
    expect(calls).toEqual([]);
  });

  it('says who is waiting when the name matches nobody waiting', async () => {
    const { ctx } = context({ accounts: ACCOUNTS });
    // Dev is active, not waiting: an active account is not a request.
    const result = await executeTool('review_access_request', { account: 'Dev Okafor', decision: 'approve' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('Nobody waiting for access matches "Dev Okafor". Waiting: Priya Patel, Priya Patil.');
  });
});
