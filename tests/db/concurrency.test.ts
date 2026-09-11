/**
 * Evidence 8: genuinely concurrent calls over separate authenticated sessions.
 *
 * Each pair is issued with Promise.all over two independent clients, so they are
 * two real HTTP requests on two separate database connections racing each other —
 * not sequential calls relabelled as concurrency.
 *
 * The serialisation comes from every mutation taking a FOR UPDATE lock on the
 * parent ticket before it re-reads state, so the loser of a race always observes
 * the winner's committed result rather than a stale snapshot.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  collaborativeTicket,
  eventKinds,
  freshSession,
  identity,
  openTicket,
  ownedTicket,
  rawEvents,
  resignIn,
  rawTicket,
  rpcOk,
  signIn,
} from './support/harness';

interface Attempt {
  ok: boolean;
  message: string;
}

/** Fires two RPCs at once on separate connections and reports both outcomes. */
async function race(
  first: { client: SupabaseClient; fn: string; args: Record<string, unknown> },
  second: { client: SupabaseClient; fn: string; args: Record<string, unknown> },
): Promise<Attempt[]> {
  const [a, b] = await Promise.all([
    first.client.rpc(first.fn, first.args),
    second.client.rpc(second.fn, second.args),
  ]);
  return [a, b].map((result) => ({
    ok: result.error === null,
    message: result.error?.message ?? '',
  }));
}

let admin: SupabaseClient;
let ownerA: SupabaseClient;
let collaboratorB: SupabaseClient;
let unrelatedC: SupabaseClient;

beforeAll(async () => {
  admin = await signIn('admin');
  // Independent sessions, each with its own connection to the API.
  [ownerA, collaboratorB, unrelatedC] = await Promise.all([
    freshSession('owner'),
    freshSession('collaborator'),
    freshSession('unrelated'),
  ]);
});

describe('two technicians claiming at once', () => {
  it('produces exactly one owner and one claim event', async () => {
    // Repeated so a lucky non-overlapping run cannot make this pass by accident.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const ticketId = await openTicket({ title: `Concurrent claim ${attempt}` });

      const results = await race(
        { client: ownerA, fn: 'app_claim_ticket', args: { p_ticket: ticketId } },
        { client: unrelatedC, fn: 'app_claim_ticket', args: { p_ticket: ticketId } },
      );

      const winners = results.filter((result) => result.ok);
      expect(winners, `attempt ${attempt}: exactly one claim must win`).toHaveLength(1);
      expect(results.find((result) => !result.ok)?.message).toBe(
        'That ticket is not available to claim.',
      );

      const row = await rawTicket(ticketId);
      expect([identity('owner').id, identity('unrelated').id]).toContain(row.owner_id);
      expect(row.status).toBe('assigned');

      const claims = (await rawEvents(ticketId)).filter((event) => event.kind === 'claimed');
      expect(claims, `attempt ${attempt}: one claim event`).toHaveLength(1);
    }
  });

  it('survives a six-way pile-up on the same ticket with one winner', async () => {
    // Six independent sessions firing at once: overlap is guaranteed rather than
    // lucky, so this cannot pass by requests happening to arrive sequentially.
    const ticketId = await openTicket({ title: 'Six-way claim pile-up' });
    const clients = await Promise.all([
      freshSession('owner'),
      freshSession('collaborator'),
      freshSession('unrelated'),
      freshSession('owner'),
      freshSession('collaborator'),
      freshSession('unrelated'),
    ]);

    const results = await Promise.all(
      clients.map((client) => client.rpc('app_claim_ticket', { p_ticket: ticketId })),
    );

    const winners = results.filter((result) => result.error === null);
    expect(winners).toHaveLength(1);
    for (const loser of results.filter((result) => result.error !== null)) {
      expect(loser.error?.message).toBe('That ticket is not available to claim.');
    }

    const claims = (await rawEvents(ticketId)).filter((event) => event.kind === 'claimed');
    expect(claims).toHaveLength(1);
    expect((await rawTicket(ticketId)).status).toBe('assigned');
  });
});

describe('two participants resolving at once', () => {
  it('records exactly one resolution and one completion event', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { ticketId } = await collaborativeTicket();

      const results = await race(
        {
          client: ownerA,
          fn: 'app_resolve_ticket',
          args: { p_ticket: ticketId, p_solution: 'Owner replaced the projector lamp.' },
        },
        {
          client: collaboratorB,
          fn: 'app_resolve_ticket',
          args: { p_ticket: ticketId, p_solution: 'Collaborator reseated the HDMI cable.' },
        },
      );

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)?.message).toMatch(/already been resolved/i);

      const row = await rawTicket(ticketId);
      expect(row.status).toBe('resolved');
      // The owner is preserved regardless of which side won.
      expect(row.owner_id).toBe(identity('owner').id);
      expect([identity('owner').id, identity('collaborator').id]).toContain(row.resolved_by);

      const resolved = (await rawEvents(ticketId)).filter((event) => event.kind === 'resolved');
      expect(resolved, `attempt ${attempt}: one completion event`).toHaveLength(1);
    }
  });
});

describe('resolve racing a return to the queue', () => {
  it('lands in exactly one coherent final state, never a half-applied one', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { ticketId } = await collaborativeTicket();

      const results = await race(
        {
          client: collaboratorB,
          fn: 'app_resolve_ticket',
          args: { p_ticket: ticketId, p_solution: 'Collaborator finished the repair.' },
        },
        { client: ownerA, fn: 'app_return_ticket_to_queue', args: { p_ticket: ticketId } },
      );

      const row = await rawTicket(ticketId);
      const events = eventKinds(await rawEvents(ticketId));
      const returns = events.filter((kind) => kind === 'returned_to_queue').length;
      const resolutions = events.filter((kind) => kind === 'resolved').length;

      // Neither operation may ever be recorded twice.
      expect(returns).toBeLessThanOrEqual(1);
      expect(resolutions).toBeLessThanOrEqual(1);
      expect(results.some((result) => result.ok)).toBe(true);

      if (row.status === 'resolved') {
        expect(resolutions).toBe(1);
        expect(row.resolved_by).toBe(identity('collaborator').id);
        expect(row.resolved_at).not.toBeNull();

        if (returns === 1) {
          // The return committed first, then the collaborator — still attached,
          // because a return preserves collaborators — resolved the now-unowned
          // ticket. Both operations genuinely succeeded, in that order.
          // Flagged in docs/M2-DATABASE.md as a rule worth confirming.
          expect(row.owner_id).toBeNull();
          expect(row.assigned_at).toBeNull();
        } else {
          // The resolve committed first, so the return was refused and must not
          // have stripped ownership on its way out.
          expect(row.owner_id).toBe(identity('owner').id);
          expect(row.assigned_at).not.toBeNull();
        }
      } else {
        // The return won and the resolution was refused: no resolution fields
        // may be set, and no completion event may exist.
        expect(row.status).toBe('open');
        expect(returns).toBe(1);
        expect(resolutions).toBe(0);
        expect(row.owner_id).toBeNull();
        expect(row.assigned_at).toBeNull();
        expect(row.resolved_by).toBeNull();
        expect(row.resolved_at).toBeNull();
      }
    }
  });
});

describe('a contribution racing the ticket closing', () => {
  it('either records the note or refuses it, never both', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { ticketId } = await collaborativeTicket();

      const results = await race(
        {
          client: collaboratorB,
          fn: 'app_add_note',
          args: { p_ticket: ticketId, p_body: 'Late-arriving diagnosis note.' },
        },
        {
          client: ownerA,
          fn: 'app_resolve_ticket',
          args: { p_ticket: ticketId, p_solution: 'Owner closed it out.' },
        },
      );

      const { data: notes } = await admin.from('notes').select('id').eq('ticket_id', ticketId);
      const noteAccepted = results[0]?.ok === true;
      expect(notes ?? [], 'note rows must match the reported outcome').toHaveLength(
        noteAccepted ? 1 : 0,
      );

      // The resolution itself must always succeed: it is not blocked by a note.
      expect(results[1]?.ok).toBe(true);
      expect((await rawTicket(ticketId)).status).toBe('resolved');
    }
  });

  it('either records the contribution or refuses it when a collaborator is removed', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { ticketId } = await collaborativeTicket();

      const results = await race(
        {
          client: collaboratorB,
          fn: 'app_log_work',
          args: { p_ticket: ticketId, p_minutes: 20 },
        },
        {
          client: ownerA,
          fn: 'app_remove_collaborator',
          args: { p_ticket: ticketId, p_account: identity('collaborator').id },
        },
      );

      const { data: logs } = await admin
        .from('work_logs')
        .select('id, contributor_id')
        .eq('ticket_id', ticketId);
      const logAccepted = results[0]?.ok === true;
      expect(logs ?? []).toHaveLength(logAccepted ? 1 : 0);

      // Removal always succeeds; a stale session cannot keep writing afterwards.
      expect(results[1]?.ok).toBe(true);
      const { data: collaborators } = await admin
        .from('ticket_collaborators')
        .select('account_id')
        .eq('ticket_id', ticketId);
      expect(collaborators ?? []).toHaveLength(0);
    }
  });
});

describe('concurrent intake', () => {
  it('never issues the same ticket number twice', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        ownerA.rpc('app_create_ticket', {
          p_title: `Parallel intake ${index}`,
          p_issue: 'Created in parallel to check number generation.',
          p_channel: 'walk_in',
          p_requester_unknown: true,
        }),
      ),
    );
    const ids = results.map((result) => result.data as string);
    expect(ids.every(Boolean)).toBe(true);

    const { data } = await admin.from('tickets').select('number').in('id', ids);
    const numbers = (data ?? []).map((row: { number: string }) => row.number);
    expect(new Set(numbers).size).toBe(ids.length);
  });
});

describe('deactivation racing a contribution', () => {
  it('never leaves a write recorded by an account that lost access', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { ticketId } = await ownedTicket();
      const victim = await freshSession('owner');

      const results = await race(
        {
          client: victim,
          fn: 'app_add_note',
          args: { p_ticket: ticketId, p_body: 'Written while being deactivated.' },
        },
        {
          client: admin,
          fn: 'app_set_account_status',
          args: { p_account: identity('owner').id, p_status: 'inactive' },
        },
      );

      const { data: notes } = await admin.from('notes').select('id').eq('ticket_id', ticketId);
      expect(notes ?? []).toHaveLength(results[0]?.ok ? 1 : 0);
      expect(results[1]?.ok).toBe(true);

      await rpcOk(admin, 'app_set_account_status', {
        p_account: identity('owner').id,
        p_status: 'active',
      });
      // Deactivation invalidated every token minted before it (M3), so the
      // shared cached session must be replaced before the next iteration.
      await resignIn('owner');
    }
  });
});
