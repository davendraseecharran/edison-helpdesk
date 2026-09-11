/**
 * Visibility rules.
 *
 * These assert the intended rule set. They do NOT prove backend authorization:
 * the functions under test run in the browser in M1. Enforcement belongs to
 * Supabase row-level security in M2.
 */

import { describe, expect, it } from 'vitest';
import {
  closedHistory,
  collaboratingTickets,
  myTickets,
  openQueue,
  queueCounts,
} from '../src/lib/domain/selectors';
import { canViewTicket, visibleTickets } from '../src/lib/domain/permissions';
import { accountOf, freshData, IDS, ticketByNumber } from './helpers';

describe('technician visibility', () => {
  const data = freshData();
  const priya = accountOf(data, IDS.priya);
  const sam = accountOf(data, IDS.sam);
  const admin = accountOf(data, IDS.admin);

  it('shows every unassigned open ticket to every technician', () => {
    const queue = openQueue(data, priya);
    expect(queue.map((ticket) => ticket.number)).toEqual(
      expect.arrayContaining(['EDT-1001', 'EDT-1002', 'EDT-1003']),
    );
    expect(queue.every((ticket) => ticket.ownerId === null)).toBe(true);
    // Urgent first, because the queue sorts by priority then age.
    expect(queue[0]?.number).toBe('EDT-1003');
  });

  it('hides another technician’s assigned ticket', () => {
    const samsAssigned = ticketByNumber(data, 'EDT-1009');
    expect(samsAssigned.ownerId).toBe(IDS.sam);
    expect(canViewTicket(samsAssigned, priya)).toBe(false);
    expect(canViewTicket(samsAssigned, sam)).toBe(true);
    expect(canViewTicket(samsAssigned, admin)).toBe(true);
  });

  it('hides another technician’s resolved ticket from history', () => {
    const samsResolved = ticketByNumber(data, 'EDT-1010');
    expect(canViewTicket(samsResolved, priya)).toBe(false);
    expect(closedHistory(data, priya).map((ticket) => ticket.number)).not.toContain('EDT-1010');
    expect(closedHistory(data, sam).map((ticket) => ticket.number)).toContain('EDT-1010');
  });

  it('keeps owned and collaborating work in the right queues', () => {
    expect(myTickets(data, priya).map((ticket) => ticket.number)).toEqual(
      expect.arrayContaining(['EDT-1004', 'EDT-1005', 'EDT-1007']),
    );
    // EDT-1006 is owned by Dev with Priya collaborating.
    expect(collaboratingTickets(data, priya).map((ticket) => ticket.number)).toEqual(['EDT-1006']);
    expect(collaboratingTickets(data, priya).every((ticket) => ticket.ownerId !== priya.id)).toBe(
      true,
    );
  });

  it('keeps a resolved ticket visible to both its owner and its collaborator', () => {
    const resolved = ticketByNumber(data, 'EDT-1008');
    expect(resolved.ownerId).toBe(IDS.priya);
    expect(resolved.resolvedById).toBe(IDS.dev);
    const dev = accountOf(data, IDS.dev);
    expect(closedHistory(data, priya).map((t) => t.number)).toContain('EDT-1008');
    expect(closedHistory(data, dev).map((t) => t.number)).toContain('EDT-1008');
  });

  it('shows the admin everything and counts only what each actor may see', () => {
    expect(visibleTickets(data, admin).length).toBe(data.tickets.length);
    expect(visibleTickets(data, priya).length).toBeLessThan(data.tickets.length);

    const priyaCounts = queueCounts(data, priya);
    const adminCounts = queueCounts(data, admin);
    expect(adminCounts.all).toBe(data.tickets.length);
    expect(priyaCounts.all).toBe(visibleTickets(data, priya).length);
    // The cancelled ticket is not part of any technician's history here.
    expect(closedHistory(data, priya).map((t) => t.number)).not.toContain('EDT-1011');
    expect(closedHistory(data, admin).map((t) => t.number)).toContain('EDT-1011');
  });
});

describe('account state gates access', () => {
  const data = freshData();

  it('gives a setup-pending account no visibility at all', () => {
    const jordan = accountOf(data, IDS.jordan);
    expect(jordan.status).toBe('setup_pending');
    expect(visibleTickets(data, jordan)).toHaveLength(0);
    expect(openQueue(data, jordan)).toHaveLength(0);
  });

  it('gives a deactivated account no visibility at all', () => {
    const alex = accountOf(data, IDS.alex);
    expect(alex.status).toBe('inactive');
    expect(visibleTickets(data, alex)).toHaveLength(0);
  });

  it('gives a signed-out viewer nothing', () => {
    expect(visibleTickets(data, null)).toHaveLength(0);
  });
});

describe('search obeys visibility', () => {
  const data = freshData();

  it('cannot surface an unrelated technician’s ticket through a search list', () => {
    const priya = accountOf(data, IDS.priya);
    // "cafeteria" only matches Sam's assigned ticket.
    const searchable = visibleTickets(data, priya).filter((ticket) =>
      `${ticket.title} ${ticket.issue}`.toLowerCase().includes('cafeteria'),
    );
    expect(searchable).toHaveLength(0);
  });
});
