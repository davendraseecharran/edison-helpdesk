/**
 * Evidence 4: intake rules enforced server-side.
 *
 * The technician rules are the security-sensitive half: a technician must not be
 * able to record a phone-call ticket, put it in someone else's queue, or backdate
 * it, and the server must REJECT such a request rather than quietly correcting it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createTicketAs,
  identity,
  rawEvents,
  rawTicket,
  rpcFails,
  schoolDateOffset,
  schoolToday,
  signIn,
  eventKinds,
} from './support/harness';

let admin: SupabaseClient;
let owner: SupabaseClient;

beforeAll(async () => {
  [admin, owner] = await Promise.all([signIn('admin'), signIn('owner')]);
});

describe('admin intake', () => {
  it('defaults to an unassigned open ticket', async () => {
    const ticketId = await createTicketAs('admin', { channel: 'phone_call' });
    const row = await rawTicket(ticketId);
    expect(row.status).toBe('open');
    expect(row.owner_id).toBeNull();
    expect(row.assigned_at).toBeNull();
    expect(row.created_by).toBe(identity('admin').id);
    expect(row.submitted_on).toBe(schoolToday());
  });

  it('assigns directly to an active technician when asked', async () => {
    const ticketId = await createTicketAs('admin', {
      channel: 'email',
      ownerId: identity('owner').id,
    });
    const row = await rawTicket(ticketId);
    expect(row.status).toBe('assigned');
    expect(row.owner_id).toBe(identity('owner').id);
    expect(row.assigned_at).not.toBeNull();
    expect(eventKinds(await rawEvents(ticketId))).toEqual(['created', 'assigned']);
  });

  it('backdates the submission date while keeping the real creation instant', async () => {
    const backdated = schoolDateOffset(-7);
    const ticketId = await createTicketAs('admin', { submittedOn: backdated, channel: 'phone_call' });
    const row = await rawTicket(ticketId);
    expect(row.submitted_on).toBe(backdated);
    expect(String(row.created_at) > `${backdated}T23:59:59Z`).toBe(true);

    const created = (await rawEvents(ticketId)).find((event) => event.kind === 'created');
    expect(String(created?.detail)).toMatch(/backdated/i);
  });

  it('refuses a future submission date and an inactive owner', async () => {
    const future = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Future ticket',
      p_issue: 'Should never be accepted.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
      p_submitted_on: schoolDateOffset(3),
    });
    expect(future.message).toMatch(/cannot be in the future/i);

    const inactiveOwner = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Assigned to a disabled account',
      p_issue: 'Should never be accepted.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
      p_owner_id: identity('inactive').id,
    });
    expect(inactiveOwner.message).toMatch(/active technician/i);
  });

  it('records devices and collaborators in the same transaction', async () => {
    const ticketId = await createTicketAs('admin', {
      ownerId: identity('owner').id,
      collaboratorIds: [identity('collaborator').id],
      devices: [
        { deviceType: 'Laptop', model: 'Lenovo 300w', serialNumber: 'SYNTH-INT-0001' },
        { deviceType: 'Laptop', identifiersNotApplicable: true },
      ],
    });

    const { data: devices } = await admin
      .from('device_observations')
      .select('*')
      .eq('ticket_id', ticketId);
    expect(devices ?? []).toHaveLength(2);
    // Unknown identifiers stay null rather than blocking the record.
    const unknown = (devices ?? []).find((d: { serial_number: string | null }) => d.serial_number === null);
    expect(unknown?.identifiers_not_applicable).toBe(true);

    const { data: collaborators } = await admin
      .from('ticket_collaborators')
      .select('account_id')
      .eq('ticket_id', ticketId);
    expect(collaborators ?? []).toHaveLength(1);

    expect(eventKinds(await rawEvents(ticketId))).toEqual([
      'created',
      'assigned',
      'collaborator_added',
      'device_recorded',
      'device_recorded',
    ]);
  });

  it('rolls the whole intake back when one device entry is invalid', async () => {
    const before = await admin.from('tickets').select('id', { count: 'exact', head: true });
    const failure = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Partial intake probe',
      p_issue: 'One device entry is blank, so nothing may persist.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
      p_devices: [{ deviceType: 'Laptop' }, { deviceType: '   ' }],
    });
    expect(failure.message).toMatch(/device type/i);

    const after = await admin.from('tickets').select('id', { count: 'exact', head: true });
    // No ticket, no requester, no device survived the failed call.
    expect(after.count).toBe(before.count);
  });

  it('accepts an explicitly unknown requester and an unknown location', async () => {
    const ticketId = await createTicketAs('admin', { requesterUnknown: true, location: '' });
    const row = await rawTicket(ticketId);
    expect(row.requester_unknown).toBe(true);
    expect(row.requester_id).toBeNull();
    expect(row.location).toBeNull();
  });

  it('requires a requester or an explicit unknown marker', async () => {
    const failure = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'No requester at all',
      p_issue: 'Should be refused.',
      p_channel: 'walk_in',
    });
    expect(failure.message).toMatch(/requester/i);
  });

  it('rejects a blank title, a long title and a blank issue', async () => {
    const base = { p_channel: 'walk_in', p_requester_unknown: true };
    expect(
      (await rpcFails(admin, 'app_create_ticket', { ...base, p_title: '   ', p_issue: 'Something.' }))
        .message,
    ).toMatch(/title is required/i);
    expect(
      (
        await rpcFails(admin, 'app_create_ticket', {
          ...base,
          p_title: 'x'.repeat(121),
          p_issue: 'Something.',
        })
      ).message,
    ).toMatch(/under 120 characters/i);
    expect(
      (await rpcFails(admin, 'app_create_ticket', { ...base, p_title: 'Fine', p_issue: '  ' }))
        .message,
    ).toMatch(/describe the issue/i);
  });
});

describe('technician intake', () => {
  it('creates a self-owned walk-in dated today', async () => {
    const ticketId = await createTicketAs('owner', { channel: 'walk_in' });
    const row = await rawTicket(ticketId);
    expect(row.channel).toBe('walk_in');
    expect(row.owner_id).toBe(identity('owner').id);
    expect(row.status).toBe('assigned');
    expect(row.submitted_on).toBe(schoolToday());
    expect(row.created_by).toBe(identity('owner').id);
  });

  it('rejects a forged channel rather than silently correcting it', async () => {
    const failure = await rpcFails(owner, 'app_create_ticket', {
      p_title: 'Phone call from a technician',
      p_issue: 'Should be refused.',
      p_channel: 'phone_call',
      p_requester_unknown: true,
    });
    expect(failure.message).toMatch(/only record walk-in/i);
  });

  it("rejects assigning a new walk-in to someone else's queue", async () => {
    const failure = await rpcFails(owner, 'app_create_ticket', {
      p_title: 'Handing work to a colleague',
      p_issue: 'Should be refused.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
      p_owner_id: identity('unrelated').id,
    });
    expect(failure.message).toMatch(/assign their walk-in tickets to themselves/i);
  });

  it('rejects a backdated walk-in', async () => {
    const failure = await rpcFails(owner, 'app_create_ticket', {
      p_title: 'Backdated walk-in',
      p_issue: 'Should be refused.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
      p_submitted_on: schoolDateOffset(-2),
    });
    expect(failure.message).toMatch(/cannot backdate/i);
  });

  it('allows collaborators on a technician walk-in', async () => {
    const ticketId = await createTicketAs('owner', {
      collaboratorIds: [identity('collaborator').id],
    });
    const { data } = await admin
      .from('ticket_collaborators')
      .select('account_id')
      .eq('ticket_id', ticketId);
    expect((data ?? [])[0]?.account_id).toBe(identity('collaborator').id);
  });

  it('creates a minimal requester record when given a new name', async () => {
    const ticketId = await createTicketAs('owner', { requesterName: 'Mr. Quintero' });
    const row = await rawTicket(ticketId);
    const { data } = await admin
      .from('requesters')
      .select('display_name, created_by')
      .eq('id', String(row.requester_id))
      .single();
    expect(data?.display_name).toBe('Mr. Quintero');
    expect(data?.created_by).toBe(identity('owner').id);
  });
});
