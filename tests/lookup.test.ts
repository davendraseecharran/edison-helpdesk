import { describe, expect, it } from 'vitest';
import { ticketStatusFromMeta } from '../src/components/shell/LookupResults';
import {
  groupHits,
  hitFromRow,
  hrefFor,
  isSearchKind,
  matchesQuery,
  parseRecent,
  RECENT_LIMIT,
  rememberRecent,
  splitTicketTitle,
  ticketNumberFromQuery,
  type SearchHit,
} from '../src/lib/data/search';

function hit(kind: SearchHit['kind'], id: string, title = `${kind} ${id}`): SearchHit {
  return { kind, id, title, subtitle: null, meta: null, href: hrefFor({ kind, id }) };
}

describe('hrefFor', () => {
  it('links each kind to its detail page', () => {
    expect(hrefFor({ kind: 'ticket', id: 'abc' })).toBe('/tickets/abc');
    expect(hrefFor({ kind: 'person', id: 'abc' })).toBe('/people/abc');
    expect(hrefFor({ kind: 'device', id: 'abc' })).toBe('/devices/abc');
    expect(hrefFor({ kind: 'group', id: 'abc' })).toBe('/groups/abc');
  });

  it('links an event through the redirecting page, since a hit does not carry its group', () => {
    expect(hrefFor({ kind: 'event', id: 'abc' })).toBe('/events/abc');
  });

  it('encodes an id that is not a plain path segment', () => {
    expect(hrefFor({ kind: 'device', id: 'a/b?c' })).toBe('/devices/a%2Fb%3Fc');
  });
});

describe('isSearchKind', () => {
  it('accepts the five kinds the search returns and nothing else', () => {
    for (const kind of ['ticket', 'person', 'device', 'group', 'event']) {
      expect(isSearchKind(kind), kind).toBe(true);
    }
    expect(isSearchKind('account')).toBe(false);
    expect(isSearchKind('Group')).toBe(false);
    expect(isSearchKind('')).toBe(false);
    expect(isSearchKind(null)).toBe(false);
    expect(isSearchKind(1)).toBe(false);
  });
});

describe('groupHits', () => {
  it('splits mixed hits into tickets, people, devices, groups and events in the given order', () => {
    const hits = [
      hit('event', 'e1'),
      hit('device', 'd1'),
      hit('group', 'g1'),
      hit('ticket', 't1'),
      hit('person', 'p1'),
      hit('ticket', 't2'),
      hit('group', 'g2'),
    ];
    const grouped = groupHits(hits);
    expect(grouped.tickets.map((h) => h.id)).toEqual(['t1', 't2']);
    expect(grouped.people.map((h) => h.id)).toEqual(['p1']);
    expect(grouped.devices.map((h) => h.id)).toEqual(['d1']);
    expect(grouped.groups.map((h) => h.id)).toEqual(['g1', 'g2']);
    expect(grouped.events.map((h) => h.id)).toEqual(['e1']);
  });

  it('returns five empty lists for no hits', () => {
    expect(groupHits([])).toEqual({ tickets: [], people: [], devices: [], groups: [], events: [] });
  });
});

describe('ticketNumberFromQuery', () => {
  it('normalises the forms a technician types', () => {
    expect(ticketNumberFromQuery('1042')).toBe('EDT-1042');
    expect(ticketNumberFromQuery('edt-1042')).toBe('EDT-1042');
    expect(ticketNumberFromQuery('EDT 1042')).toBe('EDT-1042');
    expect(ticketNumberFromQuery('edt1042')).toBe('EDT-1042');
    expect(ticketNumberFromQuery('  EDT-1042  ')).toBe('EDT-1042');
  });

  it('is null for text that is not a ticket number', () => {
    expect(ticketNumberFromQuery('')).toBeNull();
    expect(ticketNumberFromQuery('projector')).toBeNull();
    expect(ticketNumberFromQuery('EDT-')).toBeNull();
    expect(ticketNumberFromQuery('EDT-12a')).toBeNull();
    expect(ticketNumberFromQuery('1042 projector')).toBeNull();
  });

  it('does not read a nine-digit OSIS as a ticket number', () => {
    expect(ticketNumberFromQuery('230045611')).toBeNull();
    expect(ticketNumberFromQuery('EDT-230045611')).toBe('EDT-230045611');
  });
});

describe('splitTicketTitle', () => {
  it('separates the number from the title', () => {
    expect(splitTicketTitle('EDT-1042 Projector shows no signal')).toEqual({
      number: 'EDT-1042',
      rest: 'Projector shows no signal',
    });
  });

  it('leaves a title without a number alone', () => {
    expect(splitTicketTitle('Priya Raman')).toEqual({ number: null, rest: 'Priya Raman' });
  });
});

describe('hitFromRow', () => {
  it('maps a database row to a hit with its link', () => {
    expect(
      hitFromRow({ kind: 'person', id: 'p1', title: 'Priya Raman', subtitle: 'Student — 7-401', meta: '230045611', rank: 1 }),
    ).toEqual({
      kind: 'person',
      id: 'p1',
      title: 'Priya Raman',
      subtitle: 'Student — 7-401',
      meta: '230045611',
      href: '/people/p1',
    });
  });

  it('maps a group and an event to their links', () => {
    expect(
      hitFromRow({ kind: 'group', id: 'g1', title: 'Officers', subtitle: 'Runs the chapter', meta: '6 members' }),
    ).toEqual({
      kind: 'group',
      id: 'g1',
      title: 'Officers',
      subtitle: 'Runs the chapter',
      meta: '6 members',
      href: '/groups/g1',
    });
    expect(hitFromRow({ kind: 'event', id: 'e1', title: 'Weekly meeting', subtitle: 'Officers', meta: 'Sep 16' })).toEqual({
      kind: 'event',
      id: 'e1',
      title: 'Weekly meeting',
      subtitle: 'Officers',
      meta: 'Sep 16',
      href: '/events/e1',
    });
  });

  it('turns empty subtitle and meta into null', () => {
    const mapped = hitFromRow({ kind: 'device', id: 'd1', title: 'EDS-CB-2291', subtitle: '', meta: null });
    expect(mapped?.subtitle).toBeNull();
    expect(mapped?.meta).toBeNull();
  });

  it('rejects rows of an unknown kind or shape', () => {
    expect(hitFromRow({ kind: 'account', id: 'a1', title: 'x' })).toBeNull();
    expect(hitFromRow({ kind: 'ticket', id: '', title: 'x' })).toBeNull();
    expect(hitFromRow({ kind: 'ticket', id: 't1' })).toBeNull();
    expect(hitFromRow(null)).toBeNull();
    expect(hitFromRow('ticket')).toBeNull();
  });
});

describe('matchesQuery', () => {
  it('matches every token as a word prefix of the label or keywords', () => {
    expect(matchesQuery('New ticket', ['create'], 'new')).toBe(true);
    expect(matchesQuery('New ticket', ['create'], 'cre')).toBe(true);
    expect(matchesQuery('Go to my tickets', [], 'my t')).toBe(true);
    expect(matchesQuery('Toggle theme', ['dark', 'light'], 'DARK')).toBe(true);
  });

  it('matches everything on an empty query', () => {
    expect(matchesQuery('Toggle theme', [], '')).toBe(true);
    expect(matchesQuery('Toggle theme', [], '   ')).toBe(true);
  });

  it('does not match fuzzily or mid-word', () => {
    expect(matchesQuery('Go to resolved', [], 'os')).toBe(false);
    expect(matchesQuery('New ticket', [], 'icket')).toBe(false);
    expect(matchesQuery('New ticket', [], 'new device')).toBe(false);
  });
});

describe('parseRecent', () => {
  it('reads a stored list back', () => {
    const raw = JSON.stringify([
      { kind: 'ticket', id: 't1', title: 'EDT-1042 Projector', href: '/tickets/t1', at: 5 },
    ]);
    expect(parseRecent(raw)).toEqual([
      { kind: 'ticket', id: 't1', title: 'EDT-1042 Projector', href: '/tickets/t1', at: 5 },
    ]);
  });

  it('tolerates garbage of every shape', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent(undefined)).toEqual([]);
    expect(parseRecent('')).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"kind":"ticket"}')).toEqual([]);
    expect(parseRecent('42')).toEqual([]);
    expect(parseRecent(JSON.stringify([null, 7, 'x', {}, { kind: 'ticket' }]))).toEqual([]);
  });

  it('drops entries with an unknown kind or a mistyped field and keeps the rest', () => {
    const raw = JSON.stringify([
      { kind: 'account', id: 'a1', title: 'Nope', href: '/x', at: 1 },
      { kind: 'person', id: 42, title: 'Nope', href: '/x', at: 1 },
      { kind: 'device', id: 'd1', title: 'EDS-CB-2291', href: '/devices/d1', at: 'yesterday' },
    ]);
    expect(parseRecent(raw)).toEqual([
      { kind: 'device', id: 'd1', title: 'EDS-CB-2291', href: '/devices/d1', at: 0 },
    ]);
  });

  it('reads a remembered group and event back with their links', () => {
    const raw = JSON.stringify([
      { kind: 'group', id: 'g1', title: 'Officers', href: '/groups/g1', at: 2 },
      { kind: 'event', id: 'e1', title: 'Weekly meeting', href: '/events/e1', at: 1 },
    ]);
    expect(parseRecent(raw)).toEqual([
      { kind: 'group', id: 'g1', title: 'Officers', href: '/groups/g1', at: 2 },
      { kind: 'event', id: 'e1', title: 'Weekly meeting', href: '/events/e1', at: 1 },
    ]);
  });

  it('derives the link rather than trusting the stored one', () => {
    const raw = JSON.stringify([
      { kind: 'person', id: 'p1', title: 'Priya Raman', href: 'https://elsewhere.example/', at: 1 },
    ]);
    expect(parseRecent(raw)[0].href).toBe('/people/p1');
  });

  it('collapses duplicates and caps the list', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      kind: 'ticket',
      id: `t${i % 12}`,
      title: `Ticket ${i}`,
      href: `/tickets/t${i}`,
      at: i,
    }));
    const parsed = parseRecent(JSON.stringify(entries));
    expect(parsed).toHaveLength(RECENT_LIMIT);
    expect(new Set(parsed.map((item) => item.id)).size).toBe(RECENT_LIMIT);
  });
});

describe('rememberRecent', () => {
  it('puts the new selection first and removes an earlier copy', () => {
    const list = rememberRecent(
      [
        { kind: 'person', id: 'p1', title: 'Priya', href: '/people/p1', at: 1 },
        { kind: 'ticket', id: 't1', title: 'EDT-1042', href: '/tickets/t1', at: 2 },
      ],
      hit('ticket', 't1', 'EDT-1042 Projector'),
      3,
    );
    expect(list.map((item) => item.id)).toEqual(['t1', 'p1']);
    expect(list[0]).toEqual({ kind: 'ticket', id: 't1', title: 'EDT-1042 Projector', href: '/tickets/t1', at: 3 });
  });

  it('never grows past the limit', () => {
    let list = [] as ReturnType<typeof rememberRecent>;
    for (let i = 0; i < RECENT_LIMIT + 4; i += 1) {
      list = rememberRecent(list, hit('device', `d${i}`), i);
    }
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0].id).toBe(`d${RECENT_LIMIT + 3}`);
  });
});

describe('ticketStatusFromMeta', () => {
  it('reads the rendered label the search returns back to the status key', () => {
    expect(ticketStatusFromMeta('Open')).toBe('open');
    expect(ticketStatusFromMeta('Assigned')).toBe('assigned');
    expect(ticketStatusFromMeta('In progress')).toBe('in_progress');
    expect(ticketStatusFromMeta('Waiting')).toBe('waiting');
    expect(ticketStatusFromMeta('Resolved')).toBe('resolved');
    expect(ticketStatusFromMeta('Cancelled')).toBe('cancelled');
  });

  it('still accepts the raw key and refuses anything else', () => {
    expect(ticketStatusFromMeta('in_progress')).toBe('in_progress');
    expect(ticketStatusFromMeta('open')).toBe('open');
    expect(ticketStatusFromMeta('Deployed — Priya Raman')).toBeNull();
    expect(ticketStatusFromMeta('')).toBeNull();
  });
});
