/**
 * The pure half of the analytics screen.
 *
 * Three rules are worth a test each, and all three are rules somebody could
 * plausibly "simplify" into being wrong:
 *
 * 1. A PERIOD IS SCHOOL-LOCAL AND CALENDAR-ANCHORED. A ticket resolved at 10pm
 *    belongs to the day the desk worked; in UTC that evening is already
 *    tomorrow, and "this month" computed from a UTC date would move a day's
 *    work into the next month on the last evening of every one of them.
 * 2. A TERM IS THE MOST RECENT 1 SEPTEMBER. In February that is last year's,
 *    which is exactly the case an off-by-one year gets wrong and nobody
 *    notices until June.
 * 3. A SPAN IS WRITTEN IN TWO UNITS AT MOST. The number exists to be compared,
 *    and "3.47" is a number somebody has to convert before it means anything.
 */

import { describe, expect, it } from 'vitest';
import {
  barPercent,
  DEFAULT_PERIOD,
  formatHours,
  maxResolved,
  periodBounds,
  statsSentence,
  topCategory,
  toStatsPeriod,
  type ResolvedStats,
  type ResolverStats,
} from '../src/lib/domain/resolved-stats';

function resolver(name: string, count: number): ResolverStats {
  return {
    resolverId: `id-${name}`,
    resolverName: name,
    resolvedCount: count,
    byPriority: { urgent: 0, high: 0, normal: count, low: 0 },
    byCategory: { printer: count },
    medianHours: 2,
    meanHours: 3,
    reopenedCount: 0,
  };
}

function stats(period: ResolvedStats['period'], rows: ResolverStats[]): ResolvedStats {
  const total = rows.reduce((sum, row) => sum + row.resolvedCount, 0);
  return {
    period,
    resolvers: rows,
    totals: { ...resolver('totals', total), resolverId: null, resolverName: null },
  };
}

describe('periodBounds', () => {
  // Wednesday 16 September 2026, 11am in the school's own timezone.
  const wednesday = new Date('2026-09-16T15:00:00Z');

  it('starts a week on the Monday of the school week', () => {
    expect(periodBounds('week', wednesday).since).toBe('2026-09-14T04:00:00.000Z');
  });

  it('keeps Sunday in the week that began six days earlier', () => {
    const sunday = new Date('2026-09-13T15:00:00Z');
    expect(periodBounds('week', sunday).since).toBe('2026-09-07T04:00:00.000Z');
  });

  it('starts a month on its first school-local day', () => {
    expect(periodBounds('month', wednesday).since).toBe('2026-09-01T04:00:00.000Z');
  });

  it('counts a late evening as the school day it was, not the UTC day it became', () => {
    // 10pm on 1 September, which is already the 2nd in UTC.
    const lateOnTheFirst = new Date('2026-09-02T02:00:00Z');
    expect(periodBounds('month', lateOnTheFirst).since).toBe('2026-09-01T04:00:00.000Z');
  });

  it('starts a term on the most recent 1 September', () => {
    expect(periodBounds('term', wednesday).since).toBe('2026-09-01T04:00:00.000Z');
  });

  it('reaches back to last September from the spring term', () => {
    const february = new Date('2027-02-10T15:00:00Z');
    // Winter, so the school clock is five hours behind UTC in February — but
    // the term began in September, when it was four.
    expect(periodBounds('term', february).since).toBe('2026-09-01T04:00:00.000Z');
  });

  it('leaves both ends open for all time', () => {
    expect(periodBounds('all', wednesday)).toEqual({ since: null, until: null });
  });

  it('leaves the far end open: the database decides what now means', () => {
    expect(periodBounds('week', wednesday).until).toBeNull();
    expect(periodBounds('term', wednesday).until).toBeNull();
  });
});

describe('toStatsPeriod', () => {
  it('takes the four it knows', () => {
    expect(toStatsPeriod('week')).toBe('week');
    expect(toStatsPeriod('term')).toBe('term');
  });

  it('falls back rather than throwing on anything else', () => {
    expect(toStatsPeriod('fortnight')).toBe(DEFAULT_PERIOD);
    expect(toStatsPeriod(undefined)).toBe(DEFAULT_PERIOD);
    expect(toStatsPeriod(7)).toBe(DEFAULT_PERIOD);
  });
});

describe('formatHours', () => {
  it('writes less than an hour in minutes', () => {
    expect(formatHours(0)).toBe('0m');
    expect(formatHours(0.5)).toBe('30m');
    expect(formatHours(0.3)).toBe('18m');
  });

  it('writes hours, with minutes only when there are any', () => {
    expect(formatHours(2)).toBe('2h');
    expect(formatHours(2.5)).toBe('2h 30m');
  });

  it('writes a day and the hours after it', () => {
    expect(formatHours(24)).toBe('1d');
    expect(formatHours(28)).toBe('1d 4h');
    expect(formatHours(48)).toBe('2d');
  });

  it('never writes a third unit', () => {
    // 2 days, 3 hours and 25 minutes: the minutes are dropped, not rounded up
    // into an hour that did not happen.
    expect(formatHours(51.42)).toBe('2d 3h');
  });

  it('rounds up to the next unit rather than showing a bare zero', () => {
    expect(formatHours(0.999)).toBe('1h');
  });

  it('has an answer for a number that is not one', () => {
    expect(formatHours(Number.NaN)).toBe('—');
  });
});

describe('topCategory', () => {
  it('names the category with the most', () => {
    expect(topCategory({ printer: 2, network: 5, other: 1 })).toBe('network');
  });

  it('breaks a tie by the vocabulary order, so the answer never moves', () => {
    expect(topCategory({ printer: 2, network: 2 })).toBe('network');
    expect(topCategory({ network: 2, printer: 2 })).toBe('network');
  });

  it('has nothing to name when nothing was resolved', () => {
    expect(topCategory({})).toBeNull();
    expect(topCategory({ printer: 0 })).toBeNull();
  });
});

describe('the bar', () => {
  it('measures every row against the busiest one', () => {
    const rows = [resolver('Priya', 12), resolver('Dev', 6)];
    expect(maxResolved(rows)).toBe(12);
    expect(barPercent(12, 12)).toBe(100);
    expect(barPercent(6, 12)).toBe(50);
  });

  it('draws nothing for nothing', () => {
    expect(barPercent(0, 12)).toBe(0);
    expect(maxResolved([])).toBe(0);
    expect(barPercent(3, 0)).toBe(0);
  });

  it('keeps a row with work visible however far behind it is', () => {
    // Half a pixel reads as none, and none is a different claim from few.
    expect(barPercent(1, 900)).toBe(2);
  });
});

describe('statsSentence', () => {
  it('says how much, over what, and by how many people', () => {
    const line = statsSentence(
      stats('month', [resolver('Priya', 5), resolver('Dev', 3), resolver('Sam', 1)]),
    );
    expect(line).toBe('Nine resolved this month by three NetRiders.');
  });

  /*
   * Ten is where this product stops spelling a count out, everywhere it counts
   * anything (`spell`, in domain/today.ts). One rule, so the greeting and this
   * table never disagree about how a number is written.
   */
  it('stops spelling counts out where the rest of the product does', () => {
    expect(statsSentence(stats('month', [resolver('Priya', 12)]))).toBe(
      '12 resolved this month by one NetRider.',
    );
  });

  it('counts one person as one person', () => {
    expect(statsSentence(stats('week', [resolver('Priya', 4)]))).toBe(
      'Four resolved this week by one NetRider.',
    );
  });

  it('leaves large numbers as digits', () => {
    expect(statsSentence(stats('term', [resolver('Priya', 42)]))).toBe(
      '42 resolved this term by one NetRider.',
    );
  });

  it('does not count somebody whose only work came back', () => {
    const reopenedOnly: ResolverStats = { ...resolver('Sam', 0), reopenedCount: 2 };
    const line = statsSentence(stats('month', [resolver('Priya', 3), reopenedOnly]));
    expect(line).toBe('Three resolved this month by one NetRider.');
  });

  it('says nothing happened in plain words', () => {
    expect(statsSentence({ period: 'week', resolvers: [], totals: null })).toBe(
      'Nothing resolved in this period.',
    );
    expect(statsSentence(stats('week', []))).toBe('Nothing resolved in this period.');
  });

  it('keeps every line inside the voice’s line length', () => {
    for (const period of ['week', 'month', 'term', 'all'] as const) {
      const line = statsSentence(stats(period, [resolver('Priya', 7), resolver('Dev', 4)]));
      expect(line.length).toBeLessThanOrEqual(70);
      expect(line).not.toContain('!');
    }
  });
});
