import { describe, expect, it } from 'vitest';
import {
  claimableIn,
  GROUP_WINDOW_DAYS,
  groupLabel,
  groupTickets,
  normaliseLocation,
  normaliseTitle,
  sameProblem,
} from '../src/lib/domain/grouping';
import type { Ticket } from '../src/lib/domain/types';

function ticket(id: string, patch: Partial<Ticket> = {}): Ticket {
  return {
    id,
    number: `EDT-${id}`,
    title: 'Projector shows no signal in room 118',
    issue: '',
    requesterId: null,
    requesterUnknown: true,
    location: 'Room 118',
    isRemote: false,
    channel: 'walk_in',
    priority: 'normal',
    status: 'open',
    submittedOn: '2026-09-14',
    createdAt: '2026-09-14T08:00:00Z',
    createdBy: 'a',
    ownerId: null,
    assignedAt: null,
    waitingReason: null,
    solution: null,
    resolvedBy: null,
    resolvedAt: null,
    cancelReason: null,
    category: 'projector_display',
    collaboratorIds: [],
    ...patch,
  } as unknown as Ticket;
}

describe('normaliseTitle', () => {
  it('takes off case, punctuation and extra space', () => {
    expect(normaliseTitle('Projector shows NO signal!!')).toBe('projector shows no signal');
    expect(normaliseTitle('  Cart 3 —  will not charge ')).toBe('cart 3 will not charge');
  });

  it('does not guess at a different sentence', () => {
    expect(normaliseTitle('Projector is dead')).not.toBe(normaliseTitle('Projector shows no signal'));
  });
});

describe('normaliseLocation', () => {
  it('folds a room number', () => {
    expect(normaliseLocation('Room 118')).toBe('room 118');
    expect(normaliseLocation('room  118')).toBe('room 118');
  });

  it('reads a blank place as no place', () => {
    expect(normaliseLocation('   ')).toBeNull();
    expect(normaliseLocation(null)).toBeNull();
  });
});

describe('sameProblem', () => {
  it('groups two reports of the same sentence', () => {
    expect(sameProblem(ticket('a'), ticket('b', { location: 'Library' }))).toBe(true);
  });

  it('groups the same place and the same category under different words', () => {
    expect(
      sameProblem(ticket('a'), ticket('b', { title: 'No picture on the projector' })),
    ).toBe(true);
  });

  it('keeps a different category in the same room apart', () => {
    expect(
      sameProblem(
        ticket('a'),
        ticket('b', { title: 'Wi-Fi keeps dropping', category: 'network' as Ticket['category'] }),
      ),
    ).toBe(false);
  });

  it('keeps two rooms apart when the words differ', () => {
    expect(
      sameProblem(
        ticket('a'),
        ticket('b', { title: 'No picture on the projector', location: 'Room 214' }),
      ),
    ).toBe(false);
  });

  it('never reaches back beyond a week', () => {
    const old = ticket('b', { createdAt: '2026-09-01T08:00:00Z' });
    expect(sameProblem(ticket('a'), old)).toBe(false);
  });

  it('groups inside the week', () => {
    const within = ticket('b', { createdAt: '2026-09-09T08:00:00Z' });
    expect(GROUP_WINDOW_DAYS).toBe(7);
    expect(sameProblem(ticket('a'), within)).toBe(true);
  });

  it('never groups two tickets that name no place under different words', () => {
    const left = ticket('a', { title: 'Something broke', location: null });
    const right = ticket('b', { title: 'Something else broke', location: null });
    expect(sameProblem(left, right)).toBe(false);
  });
});

describe('groupTickets', () => {
  it('folds repeats into one group and leaves the rest alone', () => {
    const rows = [
      ticket('1'),
      ticket('2'),
      ticket('3', { title: 'Wi-Fi drops in the library', location: 'Library', category: 'network' as Ticket['category'] }),
      ticket('4'),
    ];
    const groups = groupTickets(rows);
    expect(groups.length).toBe(2);
    expect(groups[0].tickets.map((entry) => entry.id)).toEqual(['1', '2', '4']);
    expect(groups[1].tickets.map((entry) => entry.id)).toEqual(['3']);
  });

  it('keeps a group where its first member was, so the queue is not reordered', () => {
    const rows = [
      ticket('first', { title: 'Wi-Fi drops', location: 'Library', category: 'network' as Ticket['category'] }),
      ticket('a'),
      ticket('b'),
    ];
    expect(groupTickets(rows).map((group) => group.key)).toEqual(['first', 'a']);
  });

  it('reads oldest first inside a group, and leads with the oldest', () => {
    const rows = [
      ticket('new', { createdAt: '2026-09-14T10:00:00Z' }),
      ticket('old', { createdAt: '2026-09-14T08:00:00Z' }),
    ];
    const [group] = groupTickets(rows);
    expect(group.tickets.map((entry) => entry.id)).toEqual(['old', 'new']);
    expect(group.lead.id).toBe('old');
  });

  it('compares against the lead, so a chain of near-misses is not one group', () => {
    // A and B share a title; B and C share a room; A and C share neither.
    const a = ticket('a', { title: 'Same title', location: 'Room 1' });
    const b = ticket('b', { title: 'Same title', location: 'Room 2' });
    const c = ticket('c', { title: 'Another thing', location: 'Room 2' });
    const groups = groupTickets([a, b, c]);
    expect(groups.map((group) => group.tickets.map((entry) => entry.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('names the place only when every ticket agrees on it', () => {
    expect(groupTickets([ticket('a'), ticket('b')])[0].location).toBe('Room 118');
    expect(groupTickets([ticket('a'), ticket('b', { location: 'Library' })])[0].location).toBeNull();
  });

  it('groups an empty list into nothing', () => {
    expect(groupTickets([])).toEqual([]);
  });
});

describe('groupLabel', () => {
  it('says the count and the place', () => {
    expect(groupLabel(groupTickets([ticket('a'), ticket('b')])[0])).toBe('2 tickets, Room 118');
  });

  it('says only the count when the places differ', () => {
    const group = groupTickets([ticket('a'), ticket('b', { location: 'Library' })])[0];
    expect(groupLabel(group)).toBe('2 tickets');
  });

  it('says nothing about a group of one', () => {
    expect(groupLabel(groupTickets([ticket('a')])[0])).toBeNull();
  });
});

describe('claimableIn', () => {
  it('names only the tickets this account could claim', () => {
    const group = groupTickets([ticket('a'), ticket('b', { ownerId: 'someone' })])[0];
    expect(claimableIn(group, (entry) => entry.ownerId === null)).toEqual(['a']);
  });
});
