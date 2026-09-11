/**
 * Evidence 7: deactivation revokes access immediately for a session that is
 * ALREADY open, without rewriting any history.
 *
 * The session used here is signed in before the account is deactivated and is
 * never re-authenticated, so a passing test means the check happens per
 * statement in the database rather than at sign-in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  UNAVAILABLE,
  collaborativeTicket,
  identities,
  identity,
  ownedTicket,
  rawTicket,
  rpcFails,
  rpcOk,
  forgetSessions,
  freshSession,
  resignIn,
  signIn,
  stack,
} from './support/harness';
import { restoreIdentityStates } from './support/identities';

let admin: SupabaseClient;
let owner: SupabaseClient;

beforeAll(async () => {
  [admin, owner] = await Promise.all([signIn('admin'), signIn('owner')]);
});

afterAll(async () => {
  // Leave the shared synthetic accounts as the other files expect them.
  await restoreIdentityStates(stack(), identities());
  // Any token minted before a deactivation in this file is permanently refused,
  // so later files must sign in again rather than reuse a cached client.
  forgetSessions();
});

describe('deactivation with a live session', () => {
  it('cuts off reads and writes mid-session, and restores them on reactivation', async () => {
    const { ticketId } = await collaborativeTicket();
    const collaboratorSession = await freshSession('collaborator');

    // Working normally before deactivation.
    await rpcOk(collaboratorSession, 'app_add_note', {
      p_ticket: ticketId,
      p_body: 'Checked the certificate store before losing access.',
    });
    const { data: before } = await collaboratorSession
      .from('tickets')
      .select('id')
      .eq('id', ticketId);
    expect(before ?? []).toHaveLength(1);

    await rpcOk(admin, 'app_set_account_status', {
      p_account: identity('collaborator').id,
      p_status: 'inactive',
    });

    // Same session object, same access token, no re-authentication.
    const { data: after } = await collaboratorSession.from('tickets').select('id').eq('id', ticketId);
    expect(after ?? []).toHaveLength(0);

    const write = await rpcFails(collaboratorSession, 'app_add_note', {
      p_ticket: ticketId,
      p_body: 'Should never be recorded.',
    });
    expect(write.message).toMatch(/cannot access helpdesk records/i);

    const directory = await rpcFails(collaboratorSession, 'app_directory');
    expect(directory.message).toMatch(/cannot access/i);

    // History is untouched: the note they wrote is still there, still theirs.
    const { data: notes } = await admin
      .from('notes')
      .select('author_id, body')
      .eq('ticket_id', ticketId);
    expect(notes ?? []).toHaveLength(1);
    expect((notes ?? [])[0]?.author_id).toBe(identity('collaborator').id);

    // Admin keeps full visibility of the active work for reassignment.
    const { data: adminView } = await admin.from('tickets').select('id, owner_id').eq('id', ticketId);
    expect(adminView ?? []).toHaveLength(1);

    // A deactivated account still reads its own status, and nothing else.
    const self = await rpcOk<Array<Record<string, unknown>>>(
      collaboratorSession,
      'app_my_account',
    );
    expect(self[0]?.status).toBe('inactive');

    await rpcOk(admin, 'app_set_account_status', {
      p_account: identity('collaborator').id,
      p_status: 'active',
    });

    // M3 change: deactivation moves the account's sessions_valid_from cutoff
    // forward, so the access token that was live before it is refused for good.
    // Reactivation does NOT resurrect it — the holder of a token captured before
    // deactivation gains nothing from the account being re-enabled later.
    const { data: stillRefused } = await collaboratorSession
      .from('tickets')
      .select('id')
      .eq('id', ticketId);
    expect(stillRefused ?? []).toHaveLength(0);
    const staleWrite = await rpcFails(collaboratorSession, 'app_add_note', {
      p_ticket: ticketId,
      p_body: 'Written with a token from before deactivation.',
    });
    expect(staleWrite.message).toMatch(/signed out|cannot access helpdesk records/i);

    // A genuinely new sign-in works again.
    const reborn = await resignIn('collaborator');
    const { data: restored } = await reborn.from('tickets').select('id').eq('id', ticketId);
    expect(restored ?? []).toHaveLength(1);
  });

  it('leaves a deactivated owner’s active ticket visible to the admin for reassignment', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(admin, 'app_set_account_status', {
      p_account: identity('owner').id,
      p_status: 'inactive',
    });

    const { data } = await admin
      .from('tickets')
      .select('id, owner_id, status')
      .eq('id', ticketId)
      .single();
    expect(data?.owner_id).toBe(identity('owner').id);
    expect(data?.status).toBe('assigned');

    // The deactivated owner cannot touch it, including with an already-open session.
    expect(
      (await rpcFails(owner, 'app_add_note', { p_ticket: ticketId, p_body: 'Still working.' }))
        .message,
    ).toMatch(/cannot access helpdesk records/i);

    // Reassignment to an active technician still works and preserves the record.
    await rpcOk(admin, 'app_reassign_ticket', {
      p_ticket: ticketId,
      p_new_owner: identity('unrelated').id,
    });
    expect((await rawTicket(ticketId)).owner_id).toBe(identity('unrelated').id);

    await rpcOk(admin, 'app_set_account_status', {
      p_account: identity('owner').id,
      p_status: 'active',
    });
    // The owner's pre-deactivation token is dead for good; get a fresh one.
    owner = await resignIn('owner');
  });

  it('refuses to assign new work to a deactivated account', async () => {
    await rpcOk(admin, 'app_set_account_status', {
      p_account: identity('unrelated').id,
      p_status: 'inactive',
    });

    const intake = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Assigning to a disabled account',
      p_issue: 'Should be refused.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
      p_owner_id: identity('unrelated').id,
    });
    expect(intake.message).toMatch(/active technician/i);

    const { ticketId } = await ownedTicket();
    const collaborate = await rpcFails(admin, 'app_add_collaborator', {
      p_ticket: ticketId,
      p_account: identity('unrelated').id,
    });
    expect(collaborate.message).toMatch(/active account/i);

    await rpcOk(admin, 'app_set_account_status', {
      p_account: identity('unrelated').id,
      p_status: 'active',
    });
    await resignIn('unrelated');
  });

  it('refuses a setup_pending account every helpdesk operation', async () => {
    const pending = await freshSession('pending');
    const { ticketId } = await ownedTicket();

    const { data } = await pending.from('tickets').select('id');
    expect(data ?? []).toHaveLength(0);

    for (const [fn, args] of [
      ['app_create_ticket', {
        p_title: 'Pending intake',
        p_issue: 'Should be refused.',
        p_channel: 'walk_in',
        p_requester_unknown: true,
      }],
      ['app_add_note', { p_ticket: ticketId, p_body: 'Should be refused.' }],
      ['app_log_work', { p_ticket: ticketId, p_minutes: 10 }],
    ] as const) {
      const failure = await rpcFails(pending, fn, args as Record<string, unknown>);
      expect(failure.message, fn).toMatch(/cannot access helpdesk records/i);
    }
  });
});

describe('removed collaborator', () => {
  it('loses access immediately on an already-open session', async () => {
    const { ticketId } = await collaborativeTicket();
    const collaboratorSession = await freshSession('collaborator');

    const { data: before } = await collaboratorSession
      .from('activity_events')
      .select('id')
      .eq('ticket_id', ticketId);
    expect((before ?? []).length).toBeGreaterThan(0);

    await rpcOk(owner, 'app_remove_collaborator', {
      p_ticket: ticketId,
      p_account: identity('collaborator').id,
    });

    const { data: after } = await collaboratorSession
      .from('activity_events')
      .select('id')
      .eq('ticket_id', ticketId);
    expect(after ?? []).toHaveLength(0);

    expect(
      (await rpcFails(collaboratorSession, 'app_log_work', { p_ticket: ticketId, p_minutes: 10 }))
        .message,
    ).toBe(UNAVAILABLE);
  });
});
