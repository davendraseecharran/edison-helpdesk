/**
 * Evidence 5 and 6: resolution semantics, and the approved technician
 * return-to-queue behaviour, all through authenticated sessions.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  UNAVAILABLE,
  collaborativeTicket,
  eventKinds,
  identity,
  openTicket,
  ownedTicket,
  rawEvents,
  rawTicket,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

let admin: SupabaseClient;
let owner: SupabaseClient;
let collaborator: SupabaseClient;
let unrelated: SupabaseClient;

beforeAll(async () => {
  [admin, owner, collaborator, unrelated] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('collaborator'),
    signIn('unrelated'),
  ]);
});

describe('claiming', () => {
  it('gives the claimer ownership and removes the ticket from the open queue', async () => {
    const ticketId = await openTicket();
    await rpcOk(owner, 'app_claim_ticket', { p_ticket: ticketId });

    const row = await rawTicket(ticketId);
    expect(row.owner_id).toBe(identity('owner').id);
    expect(row.status).toBe('assigned');
    expect(row.assigned_at).not.toBeNull();

    // It has left every other technician's view.
    const { data } = await unrelated.from('tickets').select('id').eq('id', ticketId);
    expect(data ?? []).toHaveLength(0);
    expect(eventKinds(await rawEvents(ticketId))).toContain('claimed');
  });
});

describe('resolution', () => {
  const solution = 'Replaced the HDMI cable at the podium and confirmed the display works.';

  it('lets the owner resolve with no time recorded at all', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(owner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: solution });

    const row = await rawTicket(ticketId);
    expect(row.status).toBe('resolved');
    expect(row.resolved_by).toBe(identity('owner').id);
    expect(row.resolved_at).not.toBeNull();

    const { data: logs } = await admin.from('work_logs').select('id').eq('ticket_id', ticketId);
    expect(logs ?? []).toHaveLength(0);
  });

  it('lets a collaborator resolve while the primary owner is preserved', async () => {
    const { ticketId } = await collaborativeTicket();
    await rpcOk(collaborator, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: solution });

    const row = await rawTicket(ticketId);
    expect(row.status).toBe('resolved');
    expect(row.owner_id).toBe(identity('owner').id);
    expect(row.resolved_by).toBe(identity('collaborator').id);

    const resolved = (await rawEvents(ticketId)).filter((event) => event.kind === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(String(resolved[0]?.summary)).toMatch(/Dev Okafor resolved the ticket \(owner Priya Raman\)/);
  });

  it('rejects a blank and a trivial solution', async () => {
    const { ticketId } = await ownedTicket();
    expect(
      (await rpcFails(owner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: '   ' })).message,
    ).toMatch(/solution is required/i);
    expect(
      (await rpcFails(owner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: 'ok' })).message,
    ).toMatch(/describe the solution/i);

    expect((await rawTicket(ticketId)).status).toBe('assigned');
  });

  it('refuses a second resolution and keeps exactly one completion event', async () => {
    const { ticketId } = await collaborativeTicket();
    await rpcOk(owner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: solution });

    const second = await rpcFails(collaborator, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'A different fix.',
    });
    expect(second.message).toMatch(/already been resolved/i);

    const resolved = (await rawEvents(ticketId)).filter((event) => event.kind === 'resolved');
    expect(resolved).toHaveLength(1);
  });

  it('blocks notes on a closed ticket but still allows recording time', async () => {
    const { ticketId } = await collaborativeTicket();
    await rpcOk(owner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: solution });

    const note = await rpcFails(collaborator, 'app_add_note', {
      p_ticket: ticketId,
      p_body: 'Late note.',
    });
    expect(note.message).toMatch(/closed/i);

    // Time entries stay open after resolution, per the plan's time rules.
    await rpcOk(collaborator, 'app_log_work', { p_ticket: ticketId, p_minutes: 20 });
    const { data } = await admin.from('work_logs').select('minutes').eq('ticket_id', ticketId);
    expect(data ?? []).toHaveLength(1);
  });

  it('survives reopen and re-resolution with all earlier history intact', async () => {
    const { ticketId } = await collaborativeTicket();
    await rpcOk(owner, 'app_add_note', { p_ticket: ticketId, p_body: 'Initial diagnosis note.' });
    await rpcOk(owner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: solution });

    expect(
      (await rpcFails(admin, 'app_reopen_ticket', { p_ticket: ticketId, p_reason: '  ' })).message,
    ).toMatch(/needs a reason/i);

    await rpcOk(admin, 'app_reopen_ticket', {
      p_ticket: ticketId,
      p_reason: 'Fault returned the next morning.',
    });

    const reopened = await rawTicket(ticketId);
    expect(reopened.status).toBe('assigned');
    expect(reopened.owner_id).toBe(identity('owner').id);
    expect(reopened.resolved_by).toBeNull();
    expect(reopened.resolved_at).toBeNull();
    // The previous solution is retained as history rather than erased.
    expect(reopened.solution).toBe(solution);

    const second = 'Replaced the faulty wall plate and retested for an hour.';
    await rpcOk(collaborator, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: second });

    const events = await rawEvents(ticketId);
    // Both resolution events survive: one per resolution cycle.
    expect(events.filter((event) => event.kind === 'resolved')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'reopened')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'note_added')).toHaveLength(1);
    expect((await rawTicket(ticketId)).solution).toBe(second);
  });

  it('records a cancellation that is not a resolution, and requires a reason', async () => {
    const { ticketId } = await ownedTicket();
    expect(
      (await rpcFails(admin, 'app_cancel_ticket', { p_ticket: ticketId, p_reason: '' })).message,
    ).toMatch(/needs a reason/i);

    await rpcOk(admin, 'app_cancel_ticket', {
      p_ticket: ticketId,
      p_reason: 'Duplicate of an earlier report.',
    });
    const row = await rawTicket(ticketId);
    expect(row.status).toBe('cancelled');
    expect(row.resolved_at).toBeNull();
    expect(row.resolved_by).toBeNull();
    expect(row.cancel_reason).toMatch(/duplicate/i);
  });

  it('refuses reopen and cancel to a technician', async () => {
    const { ticketId } = await ownedTicket();
    expect(
      (await rpcFails(owner, 'app_cancel_ticket', { p_ticket: ticketId, p_reason: 'No longer needed.' }))
        .message,
    ).toMatch(/only an administrator/i);
    await rpcOk(owner, 'app_resolve_ticket', { p_ticket: ticketId, p_solution: solution });
    expect(
      (await rpcFails(owner, 'app_reopen_ticket', { p_ticket: ticketId, p_reason: 'Please reopen.' }))
        .message,
    ).toMatch(/only an administrator/i);
  });
});

describe('return to the open queue', () => {
  async function arrangeContributions(ticketId: string): Promise<void> {
    await rpcOk(owner, 'app_add_note', { p_ticket: ticketId, p_body: 'Swapped the cable; no change.' });
    await rpcOk(owner, 'app_record_device', {
      p_ticket: ticketId,
      p_device_type: 'Projector',
      p_asset_tag: 'DEMO-000777',
    });
    await rpcOk(owner, 'app_log_work', { p_ticket: ticketId, p_minutes: 30 });
    await rpcOk(owner, 'app_add_collaborator', {
      p_ticket: ticketId,
      p_account: identity('collaborator').id,
    });
  }

  it('preserves every contribution and collaborator, and re-opens the queue entry', async () => {
    const { ticketId } = await ownedTicket();
    await arrangeContributions(ticketId);

    await rpcOk(owner, 'app_return_ticket_to_queue', { p_ticket: ticketId });

    const row = await rawTicket(ticketId);
    expect(row.status).toBe('open');
    expect(row.owner_id).toBeNull();
    expect(row.assigned_at).toBeNull();

    const { data: notes } = await admin.from('notes').select('id').eq('ticket_id', ticketId);
    const { data: devices } = await admin
      .from('device_observations')
      .select('id')
      .eq('ticket_id', ticketId);
    const { data: logs } = await admin.from('work_logs').select('id').eq('ticket_id', ticketId);
    const { data: collaborators } = await admin
      .from('ticket_collaborators')
      .select('account_id')
      .eq('ticket_id', ticketId);
    expect(notes ?? []).toHaveLength(1);
    expect(devices ?? []).toHaveLength(1);
    expect(logs ?? []).toHaveLength(1);
    expect(collaborators ?? []).toHaveLength(1);

    expect(eventKinds(await rawEvents(ticketId))).toContain('returned_to_queue');
  });

  it('works from In progress and from Waiting, clearing the waiting state', async () => {
    const inProgress = (await ownedTicket()).ticketId;
    await rpcOk(owner, 'app_add_note', { p_ticket: inProgress, p_body: 'Started looking at it.' });
    expect((await rawTicket(inProgress)).status).toBe('in_progress');
    await rpcOk(owner, 'app_return_ticket_to_queue', { p_ticket: inProgress });
    expect((await rawTicket(inProgress)).status).toBe('open');

    const waiting = (await ownedTicket()).ticketId;
    await rpcOk(owner, 'app_set_waiting', {
      p_ticket: waiting,
      p_reason: 'Awaiting parts — replacement pen ordered',
    });
    await rpcOk(owner, 'app_return_ticket_to_queue', { p_ticket: waiting });
    const row = await rawTicket(waiting);
    expect(row.status).toBe('open');
    expect(row.waiting_reason).toBeNull();
  });

  it('lets another technician claim it, after which the former owner loses access', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(owner, 'app_add_note', { p_ticket: ticketId, p_body: 'Handing this over.' });
    await rpcOk(owner, 'app_return_ticket_to_queue', { p_ticket: ticketId });

    // Back in the shared queue for everyone.
    const { data: queued } = await unrelated.from('tickets').select('id').eq('id', ticketId);
    expect(queued ?? []).toHaveLength(1);

    await rpcOk(unrelated, 'app_claim_ticket', { p_ticket: ticketId });
    expect((await rawTicket(ticketId)).owner_id).toBe(identity('unrelated').id);

    // Past authorship is not a grant of continuing access.
    const { data: formerOwnerView } = await owner.from('tickets').select('id').eq('id', ticketId);
    expect(formerOwnerView ?? []).toHaveLength(0);
    expect(
      (await rpcFails(owner, 'app_add_note', { p_ticket: ticketId, p_body: 'One more thought.' }))
        .message,
    ).toBe(UNAVAILABLE);

    // The note they wrote earlier is still attributed to them.
    const { data: notes } = await admin
      .from('notes')
      .select('author_id')
      .eq('ticket_id', ticketId);
    expect((notes ?? [])[0]?.author_id).toBe(identity('owner').id);
  });

  it('refuses a collaborator releasing someone else’s ticket', async () => {
    const { ticketId } = await collaborativeTicket();
    const failure = await rpcFails(collaborator, 'app_return_ticket_to_queue', {
      p_ticket: ticketId,
    });
    expect(failure.message).toMatch(/only the primary owner or an administrator/i);
    expect((await rawTicket(ticketId)).owner_id).toBe(identity('owner').id);
  });

  it('refuses an unrelated technician, and refuses a closed ticket', async () => {
    const { ticketId } = await ownedTicket();
    expect(
      (await rpcFails(unrelated, 'app_return_ticket_to_queue', { p_ticket: ticketId })).message,
    ).toBe(UNAVAILABLE);

    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Finished before anyone needed to hand it over.',
    });
    expect(
      (await rpcFails(owner, 'app_return_ticket_to_queue', { p_ticket: ticketId })).message,
    ).toMatch(/closed ticket cannot be returned/i);
  });

  it('lets an admin return another technician’s ticket', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(admin, 'app_return_ticket_to_queue', { p_ticket: ticketId });
    expect((await rawTicket(ticketId)).status).toBe('open');
  });

  it('refuses a technician reassigning work to another owner', async () => {
    const { ticketId } = await ownedTicket();
    const failure = await rpcFails(owner, 'app_reassign_ticket', {
      p_ticket: ticketId,
      p_new_owner: identity('unrelated').id,
    });
    expect(failure.message).toMatch(/only an administrator can reassign/i);
    expect((await rawTicket(ticketId)).owner_id).toBe(identity('owner').id);
  });

  it('lets an admin reassign, which moves visibility with ownership', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(admin, 'app_reassign_ticket', {
      p_ticket: ticketId,
      p_new_owner: identity('unrelated').id,
    });
    const row = await rawTicket(ticketId);
    expect(row.owner_id).toBe(identity('unrelated').id);

    const { data: previousOwnerView } = await owner.from('tickets').select('id').eq('id', ticketId);
    expect(previousOwnerView ?? []).toHaveLength(0);
  });
});

describe('progress and contributions', () => {
  it('moves an untouched assignment to In progress on the first note', async () => {
    const { ticketId } = await ownedTicket();
    expect((await rawTicket(ticketId)).status).toBe('assigned');
    await rpcOk(owner, 'app_add_note', { p_ticket: ticketId, p_body: 'Checked the adapter.' });
    expect((await rawTicket(ticketId)).status).toBe('in_progress');
  });

  it('records priority changes in history and refuses a no-op change', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(owner, 'app_set_priority', { p_ticket: ticketId, p_priority: 'urgent' });
    expect((await rawTicket(ticketId)).priority).toBe('urgent');

    const events = (await rawEvents(ticketId)).filter((event) => event.kind === 'priority_changed');
    expect(events).toHaveLength(1);
    expect(String(events[0]?.summary)).toMatch(/from Normal to Urgent/);

    expect(
      (await rpcFails(owner, 'app_set_priority', { p_ticket: ticketId, p_priority: 'urgent' })).message,
    ).toMatch(/already Urgent/i);
  });

  it('requires a reason to wait, and resumes cleanly', async () => {
    const { ticketId } = await ownedTicket();
    expect(
      (await rpcFails(owner, 'app_set_waiting', { p_ticket: ticketId, p_reason: '  ' })).message,
    ).toMatch(/needs a reason/i);

    await rpcOk(owner, 'app_set_waiting', { p_ticket: ticketId, p_reason: 'Awaiting vendor' });
    expect((await rawTicket(ticketId)).status).toBe('waiting');
    await rpcOk(owner, 'app_resume_work', { p_ticket: ticketId });
    const row = await rawTicket(ticketId);
    expect(row.status).toBe('in_progress');
    expect(row.waiting_reason).toBeNull();
  });

  it('removes a collaborator, revoking access while keeping their authorship', async () => {
    const { ticketId } = await collaborativeTicket();
    await rpcOk(collaborator, 'app_add_note', {
      p_ticket: ticketId,
      p_body: 'Reinstalled the district root certificate.',
    });

    await rpcOk(owner, 'app_remove_collaborator', {
      p_ticket: ticketId,
      p_account: identity('collaborator').id,
    });

    const { data: view } = await collaborator.from('tickets').select('id').eq('id', ticketId);
    expect(view ?? []).toHaveLength(0);
    expect(
      (await rpcFails(collaborator, 'app_add_note', { p_ticket: ticketId, p_body: 'Another note.' }))
        .message,
    ).toBe(UNAVAILABLE);

    const { data: notes } = await admin
      .from('notes')
      .select('author_id')
      .eq('ticket_id', ticketId);
    expect((notes ?? []).some((note: { author_id: string }) =>
      note.author_id === identity('collaborator').id)).toBe(true);
  });

  it('refuses a collaborator adding further collaborators', async () => {
    const { ticketId } = await collaborativeTicket();
    const failure = await rpcFails(collaborator, 'app_add_collaborator', {
      p_ticket: ticketId,
      p_account: identity('unrelated').id,
    });
    expect(failure.message).toMatch(/only the primary owner or an administrator/i);
  });
});
