import { describe, expect, it } from 'vitest';
import { claimTicket, reassignTicket } from '../src/lib/domain/operations';
import { canReturnToQueue, canViewTicket } from '../src/lib/domain/permissions';
import { myTickets, openQueue } from '../src/lib/domain/selectors';
import { accountOf, contextFor, expectOk, freshData, IDS } from './helpers';

describe('technician return to Open Queue', () => {
  it.each(['assigned', 'in_progress', 'waiting'] as const)(
    'releases %s work, preserves contributions, and allows another technician to claim', (status) => {
      const data = freshData();
      const ticket = data.tickets.find(t => t.ownerId === IDS.priya)!;
      ticket.status = status;
      ticket.collaboratorIds = [IDS.dev];
      const original = structuredClone(ticket);
      const returned = expectOk(reassignTicket(data, contextFor(IDS.priya), ticket.id, null));
      expect(returned.tickets.find(t => t.id === ticket.id)).toEqual({
        ...original, ownerId: null, status: 'open', assignedAt: null, waitingReason: null,
      });
      for (const field of ['notes', 'deviceObservations', 'workLogs'] as const) {
        expect(returned[field]).toEqual(data[field]);
      }
      expect(returned.activity).toEqual(expect.arrayContaining(data.activity));
      expect(returned.activity.filter(e => e.ticketId === ticket.id && e.kind === 'returned_to_queue'))
        .toEqual([expect.objectContaining({ actorId: IDS.priya })]);
      expect(myTickets(returned, accountOf(returned, IDS.priya)).map(t => t.id)).not.toContain(ticket.id);
      expect(openQueue(returned, accountOf(returned, IDS.sam)).map(t => t.id)).toContain(ticket.id);
      const claimed = expectOk(claimTicket(returned, contextFor(IDS.sam), ticket.id));
      const nextTicket = claimed.tickets.find(t => t.id === ticket.id)!;
      expect(nextTicket.ownerId).toBe(IDS.sam);
      expect(canViewTicket(nextTicket, accountOf(claimed, IDS.priya))).toBe(false);
      expect(canViewTicket(nextTicket, accountOf(claimed, IDS.dev))).toBe(true);
      expect(reassignTicket(returned, contextFor(IDS.priya), ticket.id, null).ok).toBe(false);
    },
  );

  it('rejects collaborators, unrelated or inactive technicians, closed tickets, and reassignment to someone else', () => {
    const data = freshData();
    const ticket = data.tickets.find(t => t.ownerId === IDS.priya)!;
    ticket.collaboratorIds = [IDS.dev];
    for (const actor of [IDS.dev, IDS.sam]) {
      expect(canReturnToQueue(ticket, accountOf(data, actor))).toBe(false);
      expect(reassignTicket(data, contextFor(actor), ticket.id, null).ok).toBe(false);
    }
    expect(reassignTicket(data, contextFor(IDS.priya), ticket.id, IDS.sam).ok).toBe(false);
    for (const status of ['resolved', 'cancelled'] as const) {
      ticket.status = status;
      expect(canReturnToQueue(ticket, accountOf(data, IDS.priya))).toBe(false);
      expect(reassignTicket(data, contextFor(IDS.priya), ticket.id, null).ok).toBe(false);
    }
    ticket.status = 'assigned';
    accountOf(data, IDS.priya).status = 'inactive';
    expect(reassignTicket(data, contextFor(IDS.priya), ticket.id, null).ok).toBe(false);
  });
});
