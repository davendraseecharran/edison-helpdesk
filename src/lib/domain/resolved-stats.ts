/**
 * What the desk closed, per person, over a period.
 *
 * Pure. `app_resolved_stats` does the counting in the database; this module
 * owns the two decisions the database has no business making — where a period
 * begins, and how a span of hours is written down — and the shape the screen
 * reads.
 *
 * The periods are calendar-anchored rather than rolling, because every one of
 * them is a question somebody asks out loud: this week, this month, this term.
 * A rolling seven days answers a question nobody asked, and it moves under the
 * reader: the same table refreshed an hour later would quietly drop last
 * Tuesday. Anchoring also makes two people looking at the same screen on the
 * same day see the same numbers, which is the whole point of a table anyone
 * might be measured by.
 *
 * Every bound is school-local (`America/New_York`), like every other date in
 * this product: a ticket resolved at 9pm belongs to the day the desk worked,
 * not to the UTC day that had already started.
 */

import { schoolDayStart, schoolWeekday, toDateKey } from '@/lib/format';
import { spell } from './today';
import { TICKET_CATEGORIES, type Priority, type TicketCategory } from './types';

/** The four spans the screen offers. */
export type StatsPeriod = 'week' | 'month' | 'term' | 'all';

export const STATS_PERIODS: readonly StatsPeriod[] = ['week', 'month', 'term', 'all'];

/**
 * The label on the control, and the words the lead line uses for the same span.
 * Two forms because "Week" is a button and "this week" is a sentence.
 */
export const PERIOD_LABELS: Record<StatsPeriod, string> = {
  week: 'This week',
  month: 'This month',
  term: 'This term',
  all: 'All time',
};

export const PERIOD_PHRASES: Record<StatsPeriod, string> = {
  week: 'this week',
  month: 'this month',
  term: 'this term',
  all: 'since the desk opened',
};

/** The default, and what an unreadable search param falls back to. */
export const DEFAULT_PERIOD: StatsPeriod = 'month';

export function isStatsPeriod(value: unknown): value is StatsPeriod {
  return (
    value === 'week' || value === 'month' || value === 'term' || value === 'all'
  );
}

/** The period a query string asked for, or the default. Never throws. */
export function toStatsPeriod(value: unknown): StatsPeriod {
  return isStatsPeriod(value) ? value : DEFAULT_PERIOD;
}

/** The instants a period covers. `null` is an open end, which the RPC reads as now. */
export interface PeriodBounds {
  since: string | null;
  until: string | null;
}

/** The month the school year turns over in: term starts on its first day. */
const TERM_START_MONTH = 9;

/** A `YYYY-MM-DD` key moved by whole days. UTC arithmetic, so no DST to cross. */
function shiftKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Where a period begins, as an instant the database can compare.
 *
 * A week begins on Monday, because the school's does and because a table that
 * reset on Sunday would show an empty desk to whoever opened it first thing.
 * A term begins on the most recent 1 September: in October that is this year's,
 * in February it is last year's, and neither answer needs a school calendar to
 * be maintained. `all` has no lower bound at all — the function caps it.
 */
export function periodBounds(period: StatsPeriod, now: Date = new Date()): PeriodBounds {
  if (period === 'all') return { since: null, until: null };

  const today = toDateKey(now);
  if (period === 'week') {
    // `schoolWeekday` is 0 for Sunday; Monday is the start, so Sunday is six
    // days into the week rather than the beginning of the next one.
    const intoWeek = (schoolWeekday(now) + 6) % 7;
    return { since: schoolDayStart(shiftKey(today, -intoWeek)), until: null };
  }
  if (period === 'month') {
    return { since: schoolDayStart(`${today.slice(0, 7)}-01`), until: null };
  }

  const [year, month] = today.split('-').map(Number);
  const startYear = month >= TERM_START_MONTH ? year : year - 1;
  return {
    since: schoolDayStart(`${startYear}-${String(TERM_START_MONTH).padStart(2, '0')}-01`),
    until: null,
  };
}

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * A span of hours, written the way the queue writes an age: "18m", "2h",
 * "1d 4h".
 *
 * Rounded to the minute and never to more than two units. A median that reads
 * "3.47 hours" is a number somebody has to convert in their head before it
 * means anything, and the third unit is always noise — nobody deciding
 * anything cares about the seconds on a two-day repair.
 */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return '—';
  const minutes = Math.max(0, Math.round(hours * MINUTES_PER_HOUR));
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;

  const wholeHours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (wholeHours < HOURS_PER_DAY) {
    const rest = minutes % MINUTES_PER_HOUR;
    return rest > 0 ? `${wholeHours}h ${rest}m` : `${wholeHours}h`;
  }

  const days = Math.floor(wholeHours / HOURS_PER_DAY);
  const rest = wholeHours % HOURS_PER_DAY;
  return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

/** Counts per priority. Every key is present; the database sends explicit zeros. */
export type PriorityCounts = Record<Priority, number>;

/** Counts per category. Only the categories that occurred; an absent key is zero. */
export type CategoryCounts = Partial<Record<TicketCategory, number>>;

export const EMPTY_PRIORITY_COUNTS: PriorityCounts = {
  urgent: 0,
  high: 0,
  normal: 0,
  low: 0,
};

/** The priorities in the order the table's columns read: hottest first. */
export const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

/**
 * One resolver's period, or — with `resolverId` null — the whole desk's.
 *
 * The totals row is a row rather than a second shape because everything true of
 * a person over a period is true of the desk over the same period, and because
 * a footer that came back in a different type is a footer somebody eventually
 * renders with the wrong formatter.
 */
export interface ResolverStats {
  /** Null on the totals row, which is always last. */
  resolverId: string | null;
  resolverName: string | null;
  resolvedCount: number;
  byPriority: PriorityCounts;
  byCategory: CategoryCounts;
  /** Null when this row resolved nothing: there is no median of no tickets. */
  medianHours: number | null;
  meanHours: number | null;
  reopenedCount: number;
}

export interface ResolvedStats {
  period: StatsPeriod;
  /** One per person, busiest first. Never holds the totals row. */
  resolvers: ResolverStats[];
  /** The desk's own row, or null when the period is empty. */
  totals: ResolverStats | null;
}

export const EMPTY_STATS: ResolvedStats = {
  period: DEFAULT_PERIOD,
  resolvers: [],
  totals: null,
};

/**
 * The category this row saw most of.
 *
 * Ties go to the vocabulary's own order, which runs from the calls the desk
 * takes most often to `other`. That makes the answer stable between two
 * renders of the same data, which a tie broken by whatever the database
 * happened to return first would not be.
 */
export function topCategory(counts: CategoryCounts): TicketCategory | null {
  let best: TicketCategory | null = null;
  let most = 0;
  for (const category of TICKET_CATEGORIES) {
    const count = counts[category] ?? 0;
    if (count > most) {
      best = category;
      most = count;
    }
  }
  return best;
}

/** The busiest row's count, which every bar is drawn as a fraction of. */
export function maxResolved(rows: ResolverStats[]): number {
  return rows.reduce((most, row) => Math.max(most, row.resolvedCount), 0);
}

/**
 * How wide one row's bar is, as a percentage of the busiest row's.
 *
 * A row with work always draws something: at 40 resolved against a leader's
 * 900 the honest width is half a pixel, which reads as "none" rather than as
 * "few", and the number is right there beside it anyway.
 */
export function barPercent(count: number, most: number): number {
  if (count <= 0 || most <= 0) return 0;
  return Math.max(2, Math.round((count / most) * 100));
}

/** The line a spelled number begins, capitalised. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The line above the table.
 *
 * Two facts and nothing else: how much was closed, and how many people closed
 * it. The second is the one a total on its own hides — forty tickets is a busy
 * term across six NetRiders and an unsustainable one across two.
 *
 * Small numbers are spelled out, the way every other counted line in this
 * product reads them. An empty period gets the plain sentence rather than a
 * zero, because "Nothing" is what a person would say.
 */
export function statsSentence(stats: ResolvedStats): string {
  const resolved = stats.totals?.resolvedCount ?? 0;
  if (resolved === 0) return 'Nothing resolved in this period.';

  const people = stats.resolvers.filter((row) => row.resolvedCount > 0).length;
  const who = people === 1 ? 'one NetRider' : `${spell(people)} NetRiders`;
  return `${capitalise(spell(resolved))} resolved ${PERIOD_PHRASES[stats.period]} by ${who}.`;
}
