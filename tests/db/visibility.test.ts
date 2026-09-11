/**
 * Evidence 2 and 9: read visibility through real authenticated sessions.
 *
 * Every assertion here goes through PostgREST with a user JWT, so it exercises
 * the row-level security policies themselves — not the TypeScript predicates in
 * src/lib/domain/permissions.ts, which are an interface filter only.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  anonClient,
  collaborativeTicket,
  identity,
  openTicket,
  ownedTicket,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

let admin: SupabaseClient;
let owner: SupabaseClient;
let collaborator: SupabaseClient;
let unrelated: SupabaseClient;
let pending: SupabaseClient;
let inactive: SupabaseClient;

/** Ticket ids arranged once for the whole file. */
let claimableId: string;
let ownedId: string;
let collaborativeId: string;
let unrelatedOwnedId: string;

async function canSeeTicket(client: SupabaseClient, ticketId: string): Promise<boolean> {
  const { data, error } = await client.from('tickets').select('id').eq('id', ticketId);
  if (error) throw new Error(error.message);
  return (data ?? []).length === 1;
}

beforeAll(async () => {
  [admin, owner, collaborator, unrelated, pending, inactive] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('collaborator'),
    signIn('unrelated'),
    signIn('pending'),
    signIn('inactive'),
  ]);

  claimableId = await openTicket({ title: 'Claimable projector fault' });
  ownedId = (await ownedTicket({ title: 'Owned laptop fault' })).ticketId;
  collaborativeId = (await collaborativeTicket()).ticketId;

  // Arranged through a real session belonging to the unrelated technician.
  unrelatedOwnedId = await openTicket({ title: 'Cafeteria terminal fault' });
  await rpcOk(unrelated, 'app_claim_ticket', { p_ticket: unrelatedOwnedId });
  await rpcOk(unrelated, 'app_add_note', {
    p_ticket: unrelatedOwnedId,
    p_body: 'Restarted the terminal and watched it for ten minutes.',
  });
});

describe('claimable open work', () => {
  it('is visible to every active technician and to the admin', async () => {
    expect(await canSeeTicket(owner, claimableId)).toBe(true);
    expect(await canSeeTicket(collaborator, claimableId)).toBe(true);
    expect(await canSeeTicket(unrelated, claimableId)).toBe(true);
    expect(await canSeeTicket(admin, claimableId)).toBe(true);
  });
});

describe('owned and collaborating work', () => {
  it('is visible to its owner but not to an unrelated technician', async () => {
    expect(await canSeeTicket(owner, ownedId)).toBe(true);
    expect(await canSeeTicket(unrelated, ownedId)).toBe(false);
    expect(await canSeeTicket(admin, ownedId)).toBe(true);
  });

  it('becomes visible to a collaborator once they are added', async () => {
    expect(await canSeeTicket(collaborator, collaborativeId)).toBe(true);
    expect(await canSeeTicket(unrelated, collaborativeId)).toBe(false);
  });

  it("hides another technician's assigned ticket and its notes", async () => {
    expect(await canSeeTicket(owner, unrelatedOwnedId)).toBe(false);

    const { data: notes } = await owner
      .from('notes')
      .select('id, body')
      .eq('ticket_id', unrelatedOwnedId);
    expect(notes ?? []).toHaveLength(0);

    // The unrelated technician's own session does see them, proving the rows
    // exist and the empty result above is a policy decision, not missing data.
    const { data: ownNotes } = await unrelated
      .from('notes')
      .select('id')
      .eq('ticket_id', unrelatedOwnedId);
    expect(ownNotes ?? []).toHaveLength(1);
  });
});

describe('child records inherit ticket visibility', () => {
  const childTables = [
    'ticket_collaborators',
    'device_observations',
    'notes',
    'work_logs',
    'activity_events',
  ] as const;

  it('leaks no child row of an invisible ticket to an unrelated technician', async () => {
    for (const table of childTables) {
      const { data, error } = await unrelated
        .from(table)
        .select('*')
        .eq('ticket_id', ownedId);
      expect(error, `${table} select should not error`).toBeNull();
      expect(data ?? [], `${table} should leak nothing`).toHaveLength(0);
    }
  });

  it('shows the same child rows to a participant', async () => {
    await rpcOk(owner, 'app_record_device', {
      p_ticket: ownedId,
      p_device_type: 'Laptop',
      p_serial_number: 'SYNTH-VIS-0001',
    });
    const { data } = await owner.from('device_observations').select('*').eq('ticket_id', ownedId);
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});

describe('restricted identities', () => {
  it('gives a setup_pending account no ticket data at all', async () => {
    const { data, error } = await pending.from('tickets').select('id');
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
    expect(await canSeeTicket(pending, claimableId)).toBe(false);
  });

  it('gives a deactivated account no ticket data at all', async () => {
    const { data } = await inactive.from('tickets').select('id');
    expect(data ?? []).toHaveLength(0);
  });

  it('refuses mutations from restricted identities', async () => {
    const asPending = await rpcFails(pending, 'app_claim_ticket', { p_ticket: claimableId });
    expect(asPending.message).toMatch(/cannot access helpdesk records/i);
    const asInactive = await rpcFails(inactive, 'app_claim_ticket', { p_ticket: claimableId });
    expect(asInactive.message).toMatch(/cannot access helpdesk records/i);
  });

  it('gives an anonymous caller nothing, on every table', async () => {
    const anon = anonClient();
    for (const table of [
      'tickets',
      'app_accounts',
      'requesters',
      'notes',
      'work_logs',
      'activity_events',
      'device_observations',
      'ticket_collaborators',
    ]) {
      const { data, error } = await anon.from(table).select('*').limit(1);
      // Either refused outright or filtered to nothing; never actual rows.
      expect(data ?? [], `${table} must leak nothing to anon`).toHaveLength(0);
      if (error) expect(error.code).toBeTruthy();
    }
  });

  it('refuses every RPC to an anonymous caller', async () => {
    const anon = anonClient();
    const claim = await rpcFails(anon, 'app_claim_ticket', { p_ticket: claimableId });
    expect(claim.message).toMatch(/permission denied|not available|cannot access/i);
    const create = await rpcFails(anon, 'app_create_ticket', {
      p_title: 'Anonymous attempt',
      p_issue: 'Should never be recorded.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
    });
    expect(create.message).toMatch(/permission denied|cannot access/i);
  });

  it('refuses public self-registration', async () => {
    const { error } = await anonClient().auth.signUp({
      email: 'intruder@edison.example',
      password: `Ed-${crypto.randomUUID()}`,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/signups not allowed|disabled/i);
  });
});

describe('account and requester lookups', () => {
  it('shows a technician only their own account row directly', async () => {
    const { data } = await owner.from('app_accounts').select('id, email');
    expect(data ?? []).toHaveLength(1);
    expect((data ?? [])[0]?.id).toBe(identity('owner').id);
  });

  it('shows an admin every account row', async () => {
    const { data } = await admin.from('app_accounts').select('id');
    expect((data ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('returns labels only from the directory lookup, never admin metadata', async () => {
    const rows = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_directory');
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['display_name', 'id', 'role', 'status']);
    }
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toMatch(/@edison\.example/);
    expect(serialised).not.toMatch(/credential/i);
  });

  it('returns only the caller in the self-status lookup', async () => {
    const rows = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_my_account');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(identity('owner').id);
    // M3 extends this with two fields about the CALLER'S OWN session state, so a
    // restricted account can be routed to the right screen. Still the caller's
    // own row only, still no other account's email or credential metadata.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'credential_action_pending',
      'display_name',
      'email',
      'id',
      'role',
      'session_is_current',
      'status',
    ]);
  });

  it('lets a restricted account read its own status but no tickets', async () => {
    const rows = await rpcOk<Array<Record<string, unknown>>>(pending, 'app_my_account');
    expect(rows[0]?.status).toBe('setup_pending');
    const { data } = await pending.from('tickets').select('id');
    expect(data ?? []).toHaveLength(0);
  });

  it('refuses the directory lookup to restricted and anonymous callers', async () => {
    expect((await rpcFails(pending, 'app_directory')).message).toMatch(/cannot access/i);
    expect((await rpcFails(inactive, 'app_directory')).message).toMatch(/cannot access/i);
    expect((await rpcFails(anonClient(), 'app_directory')).message).toMatch(
      /permission denied|cannot access/i,
    );
  });

  it('lets an active technician read requesters for walk-in intake', async () => {
    const { data, error } = await owner.from('requesters').select('id, display_name, kind');
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('gives restricted identities no requester access', async () => {
    const { data } = await pending.from('requesters').select('id');
    expect(data ?? []).toHaveLength(0);
  });
});
