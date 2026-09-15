import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_LIMIT,
  isStillOpen,
  openDuplicates,
  relatedNote,
  withinDuplicateWindow,
  type DuplicateHit,
} from '../src/lib/intake/duplicates';
import { GROUP_WINDOW_DAYS } from '../src/lib/domain/grouping';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-14T15:00:00.000Z');

function hit(over: Partial<DuplicateHit> = {}): DuplicateHit {
  return {
    kind: 'ticket',
    id: over.id ?? 'a',
    title: over.title ?? 'EDT-1042 Projector shows no signal',
    subtitle: 'Ms Whitfield',
    meta: 'Open',
    href: '/tickets/a',
    createdAt: new Date(NOW - DAY).toISOString(),
    ...over,
  };
}

describe('isStillOpen', () => {
  it('reads the labels the lookup renders for a live ticket', () => {
    for (const meta of ['Open', 'Assigned', 'In progress', 'Waiting']) {
      expect(isStillOpen(meta), meta).toBe(true);
    }
  });

  it('is false for a ticket nobody is working on any more', () => {
    expect(isStillOpen('Resolved')).toBe(false);
    expect(isStillOpen('Cancelled')).toBe(false);
  });

  it('does not depend on the label casing or padding', () => {
    expect(isStillOpen('  in progress ')).toBe(true);
  });

  it('is false when there is no status to read', () => {
    expect(isStillOpen(null)).toBe(false);
    expect(isStillOpen('')).toBe(false);
  });
});

describe('withinDuplicateWindow', () => {
  it('accepts a ticket opened inside the grouping window', () => {
    expect(withinDuplicateWindow(new Date(NOW - 6 * DAY).toISOString(), NOW)).toBe(true);
  });

  it('rejects one opened past it', () => {
    const old = new Date(NOW - (GROUP_WINDOW_DAYS + 1) * DAY).toISOString();
    expect(withinDuplicateWindow(old, NOW)).toBe(false);
  });

  it('rejects a date it cannot read, because the warning states a fact', () => {
    expect(withinDuplicateWindow(null, NOW)).toBe(false);
    expect(withinDuplicateWindow('last tuesday', NOW)).toBe(false);
  });

  it('tolerates a row stamped a little ahead of this clock', () => {
    expect(withinDuplicateWindow(new Date(NOW + 60_000).toISOString(), NOW)).toBe(true);
  });
});

describe('openDuplicates', () => {
  it('keeps only what is still open and still recent', () => {
    const kept = openDuplicates(
      [
        hit({ id: 'live' }),
        hit({ id: 'closed', meta: 'Resolved' }),
        hit({ id: 'stale', createdAt: new Date(NOW - 300 * DAY).toISOString() }),
      ],
      NOW,
    );
    expect(kept.map((entry) => entry.id)).toEqual(['live']);
  });

  it('drops a person or a machine that matched the same words', () => {
    const kept = openDuplicates([hit({ id: 'p', kind: 'person' }), hit({ id: 't' })], NOW);
    expect(kept.map((entry) => entry.id)).toEqual(['t']);
  });

  it('shows a couple, not a list to read', () => {
    const many = ['a', 'b', 'c', 'd'].map((id) => hit({ id }));
    expect(openDuplicates(many, NOW)).toHaveLength(DUPLICATE_LIMIT);
  });

  it('keeps the order the lookup ranked them in', () => {
    const kept = openDuplicates([hit({ id: 'second' }), hit({ id: 'first' })], NOW, 2);
    expect(kept.map((entry) => entry.id)).toEqual(['second', 'first']);
  });
});

describe('relatedNote', () => {
  it('names the ticket it points at', () => {
    expect(relatedNote('EDT-1042')).toContain('EDT-1042');
  });

  it('is one sentence a NetRider would read in the history', () => {
    expect(relatedNote('EDT-1042').length).toBeLessThan(120);
  });
});
