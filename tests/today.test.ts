import { describe, expect, it } from 'vitest';
import {
  briefingSentence,
  deviceCode,
  deviceTitle,
  devicesDue,
  devicesDueSentence,
  DUE_LIMIT,
  EMPTY_BRIEFING,
  NEEDS_LIMIT,
  needsCount,
  needsYou,
  nextBestAction,
  spell,
  urgencyBand,
  type Briefing,
  type BriefingTicket,
  type DueDevice,
} from '../src/lib/domain/today';
import type { Priority, TicketStatus } from '../src/lib/domain/types';

function ticket(
  id: string,
  priority: Priority,
  since: string,
  status: TicketStatus = 'open',
): BriefingTicket {
  return {
    id,
    number: `EDT-${id}`,
    title: `Ticket ${id}`,
    priority,
    status,
    waitingReason: status === 'waiting' ? 'Waiting on the vendor' : null,
    createdAt: since,
    since,
    requesterName: 'Nia Okonkwo',
  };
}

function briefing(patch: Partial<Briefing>): Briefing {
  const counts = {
    waiting: patch.waiting?.length ?? 0,
    unassigned: patch.unassigned?.length ?? 0,
    mine: patch.mine?.length ?? 0,
    accessRequests: patch.accessRequests?.length ?? 0,
    devicesDue: patch.devicesDue?.length ?? 0,
    ...patch.counts,
  };
  return { ...EMPTY_BRIEFING, ...patch, counts };
}

describe('needsYou', () => {
  it('puts an urgent unclaimed ticket above everything', () => {
    const list = needsYou(
      briefing({
        unassigned: [ticket('2', 'normal', '2026-09-10T08:00:00Z'), ticket('1', 'urgent', '2026-09-14T08:00:00Z')],
        waiting: [ticket('3', 'urgent', '2026-09-01T08:00:00Z', 'waiting')],
        accessRequests: [{ id: 'a', name: 'Ada', email: 'ada@edison.example', createdAt: '2026-09-01T08:00:00Z' }],
      }),
    );
    expect(list[0].number).toBe('EDT-1');
  });

  it('reads oldest first inside a band', () => {
    const list = needsYou(
      briefing({
        unassigned: [
          ticket('new', 'normal', '2026-09-14T08:00:00Z'),
          ticket('old', 'normal', '2026-09-01T08:00:00Z'),
        ],
      }),
    );
    expect(list.map((item) => item.number)).toEqual(['EDT-old', 'EDT-new']);
  });

  it('ranks a locked-out person with the high band, above a normal ticket', () => {
    const list = needsYou(
      briefing({
        unassigned: [ticket('normal', 'normal', '2026-09-01T08:00:00Z')],
        accessRequests: [
          { id: 'a', name: 'Ada', email: 'ada@edison.example', createdAt: '2026-09-14T08:00:00Z' },
        ],
      }),
    );
    expect(list[0].kind).toBe('access');
  });

  it('keeps a high-priority unclaimed ticket above a locked-out person', () => {
    const list = needsYou(
      briefing({
        unassigned: [ticket('high', 'high', '2026-09-14T08:00:00Z')],
        accessRequests: [
          { id: 'a', name: 'Ada', email: 'ada@edison.example', createdAt: '2026-09-14T09:00:00Z' },
        ],
      }),
    );
    // Same band, so the older one wins, and the ticket is older.
    expect(list[0].number).toBe('EDT-high');
  });

  it('is a total order, so two rows never swap between renders', () => {
    const same = '2026-09-01T08:00:00Z';
    const input = briefing({
      unassigned: [ticket('b', 'normal', same), ticket('a', 'normal', same)],
    });
    expect(needsYou(input).map((item) => item.key)).toEqual(needsYou(input).map((item) => item.key));
    expect(needsYou(input)[0].number).toBe('EDT-a');
  });

  it('caps the list rather than becoming an inbox', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      ticket(String(index), 'normal', `2026-09-${String(index + 1).padStart(2, '0')}T08:00:00Z`),
    );
    expect(needsYou(briefing({ unassigned: many })).length).toBe(NEEDS_LIMIT);
  });

  it('marks only the unclaimed rows claimable', () => {
    const list = needsYou(
      briefing({
        unassigned: [ticket('1', 'normal', '2026-09-01T08:00:00Z')],
        waiting: [ticket('2', 'normal', '2026-09-01T08:00:00Z', 'waiting')],
      }),
    );
    expect(list.find((item) => item.kind === 'unassigned')?.claimable).toBe(true);
    expect(list.find((item) => item.kind === 'waiting')?.claimable).toBe(false);
  });

  it('says why a ticket of yours is stopped rather than that it is stopped', () => {
    const list = needsYou(briefing({ waiting: [ticket('1', 'normal', '2026-09-01T08:00:00Z', 'waiting')] }));
    expect(list[0].subtitle).toBe('Nia Okonkwo');
    expect(list[0].state).toBe('Waiting on the vendor');
  });

  it('falls back to the plain state when no reason was given', () => {
    const stopped = { ...ticket('1', 'normal', '2026-09-01T08:00:00Z', 'waiting'), waitingReason: null };
    expect(needsYou(briefing({ waiting: [stopped] }))[0].state).toBe('Waiting on a reply');
  });

  it('says so when a ticket has no requester on it', () => {
    const anonymous = { ...ticket('1', 'normal', '2026-09-01T08:00:00Z'), requesterName: null };
    expect(needsYou(briefing({ unassigned: [anonymous] }))[0].subtitle).toBe('Requester unknown');
  });

  it('is empty for an empty briefing', () => {
    expect(needsYou(EMPTY_BRIEFING)).toEqual([]);
  });
});

describe('urgencyBand', () => {
  it('reads an unclaimed ticket by its own priority', () => {
    const [urgent] = needsYou(briefing({ unassigned: [ticket('1', 'urgent', '2026-09-01T08:00:00Z')] }));
    const [low] = needsYou(briefing({ unassigned: [ticket('2', 'low', '2026-09-01T08:00:00Z')] }));
    expect(urgencyBand(urgent)).toBeLessThan(urgencyBand(low));
  });
});

describe('briefingSentence', () => {
  it('says nothing when nothing needs you', () => {
    expect(briefingSentence(EMPTY_BRIEFING.counts)).toBe('');
  });

  it('does not restate itself for a single thing', () => {
    expect(briefingSentence({ waiting: 0, unassigned: 1, mine: 0, accessRequests: 0, devicesDue: 0 })).toBe(
      'One thing needs you.',
    );
  });

  it('names the shape once there is more than one kind', () => {
    expect(briefingSentence({ waiting: 1, unassigned: 2, mine: 4, accessRequests: 0, devicesDue: 0 })).toBe(
      'Three things need you. Two unclaimed and one waiting on a reply.',
    );
  });

  it('counts the people waiting to get in', () => {
    expect(briefingSentence({ waiting: 0, unassigned: 1, mine: 0, accessRequests: 2, devicesDue: 0 })).toBe(
      'Three things need you. One unclaimed and two people waiting for access.',
    );
  });

  it('reads all three kinds as a list', () => {
    expect(briefingSentence({ waiting: 1, unassigned: 1, mine: 0, accessRequests: 1, devicesDue: 0 })).toBe(
      'Three things need you. One unclaimed, one waiting on a reply and one person waiting for access.',
    );
  });

  it('keeps one number register for the whole sentence past ten', () => {
    expect(briefingSentence({ waiting: 0, unassigned: 14, mine: 0, accessRequests: 1, devicesDue: 0 })).toBe(
      '15 things need you. 14 unclaimed and 1 person waiting for access.',
    );
  });
});

describe('needsCount', () => {
  it('adds the three kinds and leaves your own live work out of it', () => {
    expect(needsCount({ waiting: 1, unassigned: 2, mine: 9, accessRequests: 3, devicesDue: 0 })).toBe(6);
  });
});

describe('spell', () => {
  it('writes small numbers as words', () => {
    expect(spell(0)).toBe('no');
    expect(spell(1)).toBe('one');
    expect(spell(10)).toBe('ten');
    expect(spell(11)).toBe('11');
  });

  it('never returns a negative or a fraction', () => {
    expect(spell(-3)).toBe('no');
    expect(spell(2.7)).toBe('two');
  });
});

describe('nextBestAction', () => {
  it('sends you to your own work when you have some', () => {
    expect(nextBestAction({ waiting: 0, unassigned: 0, mine: 3, accessRequests: 0, devicesDue: 0 })).toEqual({
      label: 'Open your 3 tickets',
      href: '/my-tickets',
    });
  });

  it('counts one ticket as one', () => {
    expect(nextBestAction({ waiting: 0, unassigned: 0, mine: 1, accessRequests: 0, devicesDue: 0 }).label).toBe(
      'Open your one ticket',
    );
  });

  it('offers the next walk-in when the desk is genuinely clear', () => {
    expect(nextBestAction(EMPTY_BRIEFING.counts)).toEqual({
      label: 'Record a walk-in',
      href: '/tickets/new',
    });
  });
});

describe('the same problem reported several times', () => {
  it('folds repeats into one row and says how many', () => {
    const list = needsYou(
      briefing({
        unassigned: [
          { ...ticket('a', 'normal', '2026-09-14T09:00:00Z'), title: 'Projector shows no signal' },
          { ...ticket('b', 'normal', '2026-09-14T08:00:00Z'), title: 'Projector shows no signal!' },
          { ...ticket('c', 'normal', '2026-09-14T10:00:00Z'), title: 'Wi-Fi drops in the library' },
        ],
      }),
    );
    const folded = list.find((item) => item.title.startsWith('Projector'));
    expect(folded?.count).toBe(2);
    expect(folded?.subtitle).toBe('2 tickets');
    // The oldest leads: it is the one to work, and its age is the row's age.
    expect(folded?.ticketId).toBe('b');
    expect(folded?.ticketIds).toEqual(['b', 'a']);
    expect(list.find((item) => item.title.startsWith('Wi-Fi'))?.count).toBe(1);
  });

  it('leaves an ordinary row saying who reported it', () => {
    const [only] = needsYou(briefing({ unassigned: [ticket('a', 'normal', '2026-09-01T08:00:00Z')] }));
    expect(only.count).toBe(1);
    expect(only.subtitle).toBe('Nia Okonkwo');
    expect(only.ticketIds).toEqual(['a']);
  });

  it('counts a folded row once in the list, not once per ticket', () => {
    const same = (id: string, at: string) => ({
      ...ticket(id, 'normal', at),
      title: 'Projector shows no signal',
    });
    const list = needsYou(
      briefing({
        unassigned: [
          same('a', '2026-09-14T08:00:00Z'),
          same('b', '2026-09-14T09:00:00Z'),
          same('c', '2026-09-14T10:00:00Z'),
        ],
      }),
    );
    expect(list.length).toBe(1);
  });
});

function device(id: string, since: string, patch: Partial<DueDevice> = {}): DueDevice {
  return {
    id,
    externalId: `INV-${id}`,
    assetTag: `A-9${id}`,
    serialNumber: `5CD${id}`,
    deviceType: 'Chromebook',
    manufacturer: 'HP',
    model: 'Chromebook 11 G8',
    status: 'Assigned',
    version: 3,
    since,
    holderName: 'Wren Calloway',
    reason: 'holder_left',
    ...patch,
  };
}

describe('devicesDue', () => {
  it('puts the machine that has been out longest first', () => {
    const list = devicesDue({
      ...EMPTY_BRIEFING,
      devicesDue: [
        device('2', '2026-09-10T08:00:00Z'),
        device('1', '2026-04-30T08:00:00Z'),
        device('3', '2026-09-01T08:00:00Z'),
      ],
    });
    expect(list.map((entry) => entry.id)).toEqual(['1', '3', '2']);
  });

  it('breaks a tie on the id, so two renders cannot disagree', () => {
    const at = '2026-09-01T08:00:00Z';
    const list = devicesDue({ ...EMPTY_BRIEFING, devicesDue: [device('b', at), device('a', at)] });
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('stops at the section limit', () => {
    const many = Array.from({ length: DUE_LIMIT + 4 }, (_, at) =>
      device(String(at), `2026-0${(at % 9) + 1}-01T08:00:00Z`),
    );
    expect(devicesDue({ ...EMPTY_BRIEFING, devicesDue: many })).toHaveLength(DUE_LIMIT);
  });
});

describe('devicesDueSentence', () => {
  it('says nothing when nothing is due', () => {
    expect(devicesDueSentence(EMPTY_BRIEFING.counts)).toBe('');
  });

  it('counts what the database counted, not the rows on screen', () => {
    expect(devicesDueSentence({ ...EMPTY_BRIEFING.counts, devicesDue: 1 })).toBe(
      'One machine is due back.',
    );
    expect(devicesDueSentence({ ...EMPTY_BRIEFING.counts, devicesDue: 4 })).toBe(
      'Four machines are due back.',
    );
    expect(devicesDueSentence({ ...EMPTY_BRIEFING.counts, devicesDue: 23 })).toBe(
      '23 machines are due back.',
    );
  });
});

describe('needsCount with machines due', () => {
  it('leaves them out, because a fortnight is not this hour', () => {
    expect(needsCount({ waiting: 1, unassigned: 2, mine: 9, accessRequests: 0, devicesDue: 7 })).toBe(3);
  });
});

describe('how a machine is named', () => {
  it('reads as a person would say it', () => {
    expect(deviceTitle(device('1', '2026-09-01T08:00:00Z'))).toBe('HP Chromebook 11 G8');
  });

  it('falls back to the type when the model is missing', () => {
    expect(deviceTitle(device('1', '2026-09-01T08:00:00Z', { manufacturer: '', model: null }))).toBe(
      'Chromebook',
    );
  });

  it('prints the sticker on the lid, then the serial, then the inventory id', () => {
    const at = '2026-09-01T08:00:00Z';
    expect(deviceCode(device('1', at))).toBe('A-91');
    expect(deviceCode(device('1', at, { assetTag: null }))).toBe('5CD1');
    expect(deviceCode(device('1', at, { assetTag: null, serialNumber: null }))).toBe('INV-1');
  });
});
