/**
 * Evidence 1: migrations apply reproducibly and constraints reject invalid state.
 *
 * These write with the SERVICE ROLE deliberately: the point is that the schema
 * itself refuses bad data even for a privileged caller, so a future admin script
 * or a bug in an RPC cannot persist an impossible ticket.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminServiceClient,
  identity,
  openTicket,
  rawTicket,
  rpcOk,
  schoolDateOffset,
  schoolToday,
  signIn,
} from './support/harness';
import type { SupabaseClient } from '@supabase/supabase-js';

let service: SupabaseClient;

beforeAll(() => {
  service = adminServiceClient();
});

/** Inserts a ticket row directly, returning the database error if refused. */
async function insertTicket(overrides: Record<string, unknown>) {
  return service.from('tickets').insert({
    title: 'Constraint probe',
    issue: 'Synthetic row used to prove a constraint fires.',
    requester_unknown: true,
    channel: 'walk_in',
    status: 'open',
    submitted_on: schoolToday(),
    created_by: identity('admin').id,
    ...overrides,
  });
}

describe('migrations', () => {
  it('applies every migration, leaving all eight tables present and readable', async () => {
    // `npm run test:db` resets the database and replays the migrations from
    // scratch before this runs, so reaching every object proves a reproducible
    // fresh apply. PostgREST does not expose supabase_migrations, so the
    // assertion is on the schema those migrations produce.
    const tables = [
      'app_accounts',
      'requesters',
      'tickets',
      'ticket_collaborators',
      'device_observations',
      'notes',
      'work_logs',
      'activity_events',
    ];
    for (const table of tables) {
      const { error } = await service.from(table).select('*', { count: 'exact', head: true });
      expect(error, `table ${table} should exist`).toBeNull();
    }
  });

  it('exposes the school-local date helper to a signed-in account', async () => {
    const client = await signIn('admin');
    const today = await rpcOk<string>(client, 'app_today');
    expect(today).toBe(schoolToday());
  });

  it('generates readable ticket numbers in the database', async () => {
    const first = await rawTicket(await openTicket());
    const second = await rawTicket(await openTicket());
    expect(String(first.number)).toMatch(/^EDT-\d+$/);
    expect(String(second.number)).toMatch(/^EDT-\d+$/);
    expect(first.number).not.toBe(second.number);
  });
});

describe('ticket constraints', () => {
  it('rejects a ticket that is neither known-requester nor explicitly unknown', async () => {
    const { error } = await insertTicket({ requester_unknown: false, requester_id: null });
    expect(error?.message).toMatch(/tickets_requester_resolution/);
  });

  it('rejects a blank title and an over-long title', async () => {
    expect((await insertTicket({ title: '   ' })).error?.message).toMatch(/tickets_title_length/);
    expect((await insertTicket({ title: 'x'.repeat(121) })).error?.message).toMatch(
      /tickets_title_length/,
    );
  });

  it('rejects a future submission date', async () => {
    const future = schoolDateOffset(7);
    const { error } = await insertTicket({ submitted_on: future });
    expect(error?.message).toMatch(/submission date cannot be in the future/i);
  });

  it('rejects an open ticket that still carries an owner', async () => {
    const { error } = await insertTicket({
      status: 'open',
      owner_id: identity('owner').id,
      assigned_at: new Date().toISOString(),
    });
    expect(error?.message).toMatch(/tickets_open_has_no_owner/);
  });

  it('rejects an assigned ticket with no owner', async () => {
    const { error } = await insertTicket({ status: 'assigned' });
    expect(error?.message).toMatch(/tickets_active_owned_has_owner/);
  });

  it('rejects a resolved ticket with no solution or no resolver', async () => {
    const withoutSolution = await insertTicket({
      status: 'resolved',
      resolved_by: identity('owner').id,
      resolved_at: new Date().toISOString(),
    });
    expect(withoutSolution.error?.message).toMatch(/tickets_resolved_complete/);

    const trivialSolution = await insertTicket({
      status: 'resolved',
      solution: 'ok',
      resolved_by: identity('owner').id,
      resolved_at: new Date().toISOString(),
    });
    expect(trivialSolution.error?.message).toMatch(/tickets_resolved_complete/);
  });

  it('rejects waiting without a reason, and a reason without waiting', async () => {
    expect(
      (
        await insertTicket({
          status: 'waiting',
          owner_id: identity('owner').id,
          assigned_at: new Date().toISOString(),
        })
      ).error?.message,
    ).toMatch(/tickets_waiting_has_reason/);

    expect((await insertTicket({ waiting_reason: 'Awaiting parts' })).error?.message).toMatch(
      /tickets_waiting_has_reason/,
    );
  });

  it('rejects a cancellation that pretends to be a resolution', async () => {
    const { error } = await insertTicket({
      status: 'cancelled',
      cancel_reason: 'Duplicate',
      resolved_at: new Date().toISOString(),
      resolved_by: identity('admin').id,
    });
    expect(error?.message).toMatch(/tickets_unresolved_has_no_resolver/);
  });

  it('rejects a remote ticket that also claims a physical location', async () => {
    const { error } = await insertTicket({ is_remote: true, location: 'Room 212' });
    expect(error?.message).toMatch(/tickets_location_shape/);
  });

  it('keeps the creation timestamp immutable', async () => {
    const ticketId = await openTicket();
    const { error } = await service
      .from('tickets')
      .update({ created_at: '2020-01-01T00:00:00Z' })
      .eq('id', ticketId);
    expect(error?.message).toMatch(/creation timestamp is immutable/i);
  });

  it('keeps the submission date immutable after intake', async () => {
    const ticketId = await openTicket();
    const { error } = await service
      .from('tickets')
      .update({ submitted_on: '2026-01-05' })
      .eq('id', ticketId);
    expect(error?.message).toMatch(/submission date cannot be changed/i);
  });
});

describe('contribution constraints', () => {
  it('rejects zero and over-long work-log minutes', async () => {
    const ticketId = await openTicket();
    const base = {
      ticket_id: ticketId,
      contributor_id: identity('owner').id,
      work_date: schoolToday(),
    };
    // Zero is rejected on purpose: "not recorded" is the absence of a row, and
    // must stay distinguishable from a recorded zero.
    expect((await service.from('work_logs').insert({ ...base, minutes: 0 })).error?.message).toMatch(
      /work_logs_minutes_range/,
    );
    expect(
      (await service.from('work_logs').insert({ ...base, minutes: 1441 })).error?.message,
    ).toMatch(/work_logs_minutes_range/);
  });

  it('rejects future-dated work', async () => {
    const ticketId = await openTicket();
    const future = schoolDateOffset(1);
    const { error } = await service.from('work_logs').insert({
      ticket_id: ticketId,
      contributor_id: identity('owner').id,
      work_date: future,
      minutes: 30,
    });
    expect(error?.message).toMatch(/work date cannot be in the future/i);
  });

  it('rejects a blank note body', async () => {
    const ticketId = await openTicket();
    const { error } = await service
      .from('notes')
      .insert({ ticket_id: ticketId, author_id: identity('owner').id, body: '   ' });
    expect(error?.message).toMatch(/notes_body_present/);
  });

  it('refuses to make the primary owner their own collaborator', async () => {
    const ticketId = await openTicket({ ownerId: identity('owner').id });
    const { error } = await service
      .from('ticket_collaborators')
      .insert({
        ticket_id: ticketId,
        account_id: identity('owner').id,
        added_by: identity('admin').id,
      });
    expect(error?.message).toMatch(/primary owner cannot also be a collaborator/i);
  });

  it('refuses duplicate collaborator rows', async () => {
    const ticketId = await openTicket();
    const row = {
      ticket_id: ticketId,
      account_id: identity('collaborator').id,
      added_by: identity('admin').id,
    };
    expect((await service.from('ticket_collaborators').insert(row)).error).toBeNull();
    expect((await service.from('ticket_collaborators').insert(row)).error?.message).toMatch(
      /duplicate key|ticket_collaborators_pkey/i,
    );
  });

  it('keeps activity history append-only even for a privileged caller', async () => {
    const ticketId = await openTicket();
    const { data: events } = await service
      .from('activity_events')
      .select('id')
      .eq('ticket_id', ticketId)
      .limit(1);
    const eventId = (events ?? [])[0]?.id as string;
    expect(eventId).toBeTruthy();

    const updated = await service
      .from('activity_events')
      .update({ summary: 'rewritten history' })
      .eq('id', eventId);
    expect(updated.error?.message).toMatch(/append-only/i);

    const deleted = await service.from('activity_events').delete().eq('id', eventId);
    expect(deleted.error?.message).toMatch(/append-only/i);
  });

  it('refuses to delete an account that authored ticket history', async () => {
    const ticketId = await openTicket();
    expect(ticketId).toBeTruthy();
    const { error } = await service.from('app_accounts').delete().eq('id', identity('admin').id);
    expect(error?.message).toMatch(/violates foreign key constraint/i);
  });
});
