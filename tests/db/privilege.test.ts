/**
 * Evidence 3: direct table writes and RPC abuse cannot elevate privilege, forge
 * authorship, fabricate history, or delete anything.
 *
 * Everything here runs as a genuinely signed-in technician or admin over the
 * REST API, which is the same surface a browser or a curl command would reach.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  UNAVAILABLE,
  UNAVAILABLE_TO_CLAIM,
  anonClient,
  collaborativeTicket,
  identity,
  openTicket,
  ownedTicket,
  rawEvents,
  rawTicket,
  rpcFails,
  rpcOk,
  schoolToday,
  signIn,
} from './support/harness';

let admin: SupabaseClient;
let owner: SupabaseClient;
let collaborator: SupabaseClient;
let unrelated: SupabaseClient;

let ownedId: string;
let claimableId: string;

beforeAll(async () => {
  [admin, owner, collaborator, unrelated] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('collaborator'),
    signIn('unrelated'),
  ]);
  ownedId = (await ownedTicket()).ticketId;
  claimableId = await openTicket();
});

describe('direct table writes are impossible', () => {
  it('refuses INSERT on every table, even for an admin', async () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['tickets', {
        title: 'Forged ticket',
        issue: 'Written straight to the table.',
        requester_unknown: true,
        channel: 'walk_in',
        status: 'open',
        submitted_on: schoolToday(),
        created_by: identity('admin').id,
      }],
      ['notes', { ticket_id: ownedId, author_id: identity('owner').id, body: 'Forged note' }],
      ['activity_events', {
        ticket_id: ownedId,
        kind: 'resolved',
        actor_id: identity('owner').id,
        summary: 'Fabricated resolution',
      }],
      ['work_logs', {
        ticket_id: ownedId,
        contributor_id: identity('owner').id,
        work_date: schoolToday(),
        minutes: 30,
      }],
      ['device_observations', {
        ticket_id: ownedId,
        device_type: 'Forged device',
        recorded_by: identity('owner').id,
      }],
      ['ticket_collaborators', {
        ticket_id: ownedId,
        account_id: identity('unrelated').id,
        added_by: identity('unrelated').id,
      }],
      ['requesters', { display_name: 'Forged requester', created_by: identity('owner').id }],
      ['app_accounts', {
        id: identity('unrelated').id,
        display_name: 'Forged',
        email: 'forged@edison.example',
        role: 'admin',
        status: 'active',
      }],
    ];

    for (const [table, row] of attempts) {
      for (const [label, client] of [['owner', owner], ['admin', admin]] as const) {
        const { error } = await client.from(table).insert(row);
        expect(error, `${label} INSERT into ${table} must be refused`).not.toBeNull();
        expect(error?.message).toMatch(/permission denied|violates row-level security/i);
      }
    }
  });

  it('refuses UPDATE on tickets and accounts', async () => {
    const ticketUpdate = await owner
      .from('tickets')
      .update({ status: 'resolved', solution: 'Claimed without doing the work.' })
      .eq('id', ownedId);
    expect(ticketUpdate.error?.message).toMatch(/permission denied/i);

    const accountUpdate = await owner
      .from('app_accounts')
      .update({ role: 'admin' })
      .eq('id', identity('owner').id);
    expect(accountUpdate.error?.message).toMatch(/permission denied/i);
  });

  it('refuses DELETE everywhere, so history cannot be erased', async () => {
    for (const table of ['notes', 'activity_events', 'work_logs', 'device_observations']) {
      const { error } = await admin.from(table).delete().eq('ticket_id', ownedId);
      expect(error?.message, `${table} delete`).toMatch(/permission denied/i);
    }
    const ticketDelete = await admin.from('tickets').delete().eq('id', ownedId);
    expect(ticketDelete.error?.message).toMatch(/permission denied/i);
  });
});

describe('role and status cannot be self-elevated', () => {
  it('refuses a technician changing their own role or status', async () => {
    const update = await owner
      .from('app_accounts')
      .update({ role: 'admin', status: 'active' })
      .eq('id', identity('owner').id);
    expect(update.error?.message).toMatch(/permission denied/i);

    const fresh = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_my_account');
    expect(fresh[0]?.role).toBe('technician');
  });

  it('refuses a technician calling the account-status RPC', async () => {
    const failure = await rpcFails(owner, 'app_set_account_status', {
      p_account: identity('unrelated').id,
      p_status: 'inactive',
    });
    expect(failure.message).toMatch(/only an administrator/i);
  });

  it('refuses an admin deactivating their own account', async () => {
    const failure = await rpcFails(admin, 'app_set_account_status', {
      p_account: identity('admin').id,
      p_status: 'inactive',
    });
    expect(failure.message).toMatch(/your own account status/i);
  });

  it('ignores forged role claims in RPC arguments', async () => {
    // Extra arguments are rejected outright; identity comes from the JWT only.
    const failure = await rpcFails(owner, 'app_claim_ticket', {
      p_ticket: claimableId,
      p_actor: identity('admin').id,
      p_role: 'admin',
    });
    expect(failure.message).toMatch(/function|does not exist|schema cache/i);
  });
});

describe('authorship and timestamps come from the server', () => {
  it('records the caller as the note author regardless of intent', async () => {
    const { ticketId } = await collaborativeTicket();
    await rpcOk(collaborator, 'app_add_note', {
      p_ticket: ticketId,
      p_body: 'Collaborator note for attribution check.',
    });
    const { data } = await admin
      .from('notes')
      .select('author_id, created_at')
      .eq('ticket_id', ticketId);
    const authored = (data ?? []).filter(
      (note: { author_id: string }) => note.author_id === identity('collaborator').id,
    );
    expect(authored).toHaveLength(1);
  });

  it('records the caller as the work-log contributor', async () => {
    await rpcOk(owner, 'app_log_work', { p_ticket: ownedId, p_minutes: 25 });
    const { data } = await admin.from('work_logs').select('contributor_id').eq('ticket_id', ownedId);
    expect((data ?? []).every((log: { contributor_id: string }) =>
      log.contributor_id === identity('owner').id)).toBe(true);
  });

  it('writes an activity event for every mutation, attributed to the caller', async () => {
    const events = await rawEvents(ownedId);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(typeof event.actor_id).toBe('string');
      expect(event.at).toBeTruthy();
    }
  });

  it('keeps the real creation timestamp when an admin backdates intake', async () => {
    const backdated = '2026-09-03';
    const ticketId = await openTicket({ submittedOn: backdated, channel: 'email' });
    const row = await rawTicket(ticketId);
    expect(row.submitted_on).toBe(backdated);
    // created_at is the real instant, today, not the backdated day.
    expect(String(row.created_at).slice(0, 4)).toBe(String(new Date().getUTCFullYear()));
    expect(new Date(String(row.created_at)).getTime()).toBeGreaterThan(
      new Date(`${backdated}T23:59:59Z`).getTime(),
    );
  });
});

describe('invisible and missing ids behave identically', () => {
  it('gives the same error for a missing id and an invisible one', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const invisibleToUnrelated = ownedId;

    const missingNote = await rpcFails(unrelated, 'app_add_note', {
      p_ticket: missing,
      p_body: 'Probe',
    });
    const invisibleNote = await rpcFails(unrelated, 'app_add_note', {
      p_ticket: invisibleToUnrelated,
      p_body: 'Probe',
    });
    expect(missingNote.message).toBe(UNAVAILABLE);
    expect(invisibleNote.message).toBe(UNAVAILABLE);
  });

  it('never names the owner when a claim loses the race', async () => {
    // Deliberate M2 change from the M1 demo, documented in docs/M2-DATABASE.md:
    // the claim endpoint must not become an ownership oracle.
    const missing = '00000000-0000-4000-8000-000000000001';
    const alreadyOwned = await rpcFails(unrelated, 'app_claim_ticket', { p_ticket: ownedId });
    const notThere = await rpcFails(unrelated, 'app_claim_ticket', { p_ticket: missing });

    expect(alreadyOwned.message).toBe(UNAVAILABLE_TO_CLAIM);
    expect(notThere.message).toBe(UNAVAILABLE_TO_CLAIM);
    expect(alreadyOwned.message).not.toMatch(/Priya|Raman|owner/i);
  });

  it('refuses contributions from an uninvolved technician', async () => {
    for (const [fn, args] of [
      ['app_add_note', { p_ticket: ownedId, p_body: 'Let me help.' }],
      ['app_record_device', { p_ticket: ownedId, p_device_type: 'Laptop' }],
      ['app_set_priority', { p_ticket: ownedId, p_priority: 'urgent' }],
      ['app_resolve_ticket', { p_ticket: ownedId, p_solution: 'Nothing was actually done.' }],
      ['app_log_work', { p_ticket: ownedId, p_minutes: 15 }],
      ['app_add_collaborator', { p_ticket: ownedId, p_account: identity('unrelated').id }],
      ['app_return_ticket_to_queue', { p_ticket: ownedId }],
    ] as const) {
      const failure = await rpcFails(unrelated, fn, args as Record<string, unknown>);
      expect(failure.message, `${fn} must be refused`).toBe(UNAVAILABLE);
    }
  });
});

describe('anonymous callers reach nothing', () => {
  it('cannot call any mutation RPC', async () => {
    const anon = anonClient();
    for (const fn of [
      'app_claim_ticket',
      'app_resolve_ticket',
      'app_set_account_status',
      'app_return_ticket_to_queue',
    ]) {
      const failure = await rpcFails(anon, fn, { p_ticket: claimableId, p_solution: 'x', p_account: identity('owner').id, p_status: 'inactive' });
      expect(failure.message, fn).toMatch(/permission denied|function|schema cache/i);
    }
  });
});
