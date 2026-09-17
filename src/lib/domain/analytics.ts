/**
 * The desk's analytics: the shape, the vocabulary, and the few decisions
 * the database has no business making.
 *
 * `app_analytics` (20260916170000) does the counting in one call and hands
 * back one JSON document in exactly the shape below; `loadAnalytics` in
 * `src/lib/data/analytics.ts` checks it field by field rather than casting.
 * The page at /analytics draws it; the assistant's `desk_analytics` tool
 * reads the same document, so the two never disagree about a number.
 *
 * Who may read it: anybody who works tickets. A NetRider's own Resolved list
 * shows them only their tickets, and row-level security hides a colleague's
 * ticket from them by design; this document is aggregate — counts, medians,
 * shares — and the one place it names a ticket (`hardest`) carries the
 * ticket's number and title only when the reader could open it. The
 * per-person table (`people.rows`) is the ranking the owner reserved for
 * administrators; everybody else gets the honours and their own row.
 *
 * Periods are the calendar-anchored ones `resolved-stats` already defines
 * (this week, this month, this term, all time), so the two screens agree,
 * and every bound is school-local (`America/New_York`).
 */

import { PERIOD_LABELS, periodBounds, type StatsPeriod } from './resolved-stats';
import type { IntakeChannel, Priority, TicketCategory } from './types';

export type AnalyticsPeriod = StatsPeriod;

/**
 * How the throughput series is sliced. A week or a month is read day by day;
 * a term week by week; all time month by month, since a bar a day for five
 * years is a texture, not a chart.
 */
export type Bucket = 'day' | 'week' | 'month';

export function bucketFor(period: AnalyticsPeriod): Bucket {
  if (period === 'week' || period === 'month') return 'day';
  if (period === 'term') return 'week';
  return 'month';
}

/** One slice of the throughput series. */
export interface ThroughputPoint {
  /** `YYYY-MM-DD` for a day, the Monday's date for a week, `YYYY-MM` for a month. */
  key: string;
  /** Tickets created in the slice. */
  created: number;
  /** Tickets resolved in the slice (cancellations are not resolutions). */
  resolved: number;
  /**
   * Tickets open at the end of the slice: created by then and not resolved by
   * then. Cancelled tickets are left out of the backlog altogether, since a
   * cancellation carries no instant of its own.
   */
  backlog: number;
}

export interface Overview {
  resolved: number;
  /** The same figure for the span of equal length just before this one; null for all time. */
  resolvedPrevious: number | null;
  created: number;
  createdPrevious: number | null;
  cancelled: number;
  /** Resolved tickets that had been reopened at least once before. */
  reopened: number;
  /** Hours from creation to resolution, over the period's resolved tickets. */
  medianHours: number | null;
  medianHoursPrevious: number | null;
  p90Hours: number | null;
  /** Share (0 to 1) of resolutions that came within twenty-four hours of creation. */
  sameDayShare: number | null;
  /** Monday-to-Friday days inside the period, up to today. */
  schoolDays: number;
  /** Resolutions per school day; null when the period holds no school day yet. */
  perSchoolDay: number | null;
  /** Resolutions per seven days of the period. */
  perWeek: number | null;
  /** Snapshots of now, not of the period. */
  openNow: number;
  unassignedNow: number;
  waitingNow: number;
  /** How long the oldest open ticket has been open, in hours. */
  oldestOpenHours: number | null;
}

/** When tickets arrive, school-local. Counted over tickets created in the period. */
export interface Arrivals {
  /** Monday first; seven entries. */
  byWeekday: number[];
  /** Midnight first; twenty-four entries. */
  byHour: number[];
  /** Seven rows of twenty-four, Monday first, midnight first. */
  heat: number[][];
}

export interface CategoryStat {
  category: TicketCategory;
  resolved: number;
  created: number;
  /** Share (0 to 1) of the period's resolutions. */
  share: number;
  medianHours: number | null;
  /** Resolved per throughput slice, in the same order as `throughput`. */
  trend: number[];
}

export interface PriorityStat {
  priority: Priority;
  resolved: number;
  share: number;
  medianHours: number | null;
  p90Hours: number | null;
  /** Hours from the resolver taking the ticket (claim, or joining it) to resolving it. */
  medianFromClaimHours: number | null;
}

export interface ChannelStat {
  channel: IntakeChannel;
  count: number;
  share: number;
}

export interface LocationStat {
  /** The room as typed on the ticket, trimmed; the eight most frequent. */
  location: string;
  count: number;
}

export interface RequesterStat {
  name: string;
  kind: 'staff' | 'student' | 'role' | 'unknown';
  count: number;
}

export interface Requesters {
  staff: number;
  student: number;
  other: number;
  /** The five people who opened the most tickets in the period. */
  repeat: RequesterStat[];
}

export interface Waiting {
  /** Resolved tickets that spent time in "waiting" at least once. */
  ticketsWaited: number;
  /** Share (0 to 1) of the period's resolutions. */
  share: number;
  /** Hours from entering "waiting" to leaving it, over every such spell. */
  medianWaitHours: number | null;
  /** The reasons given, most frequent first; at most six. */
  reasons: Array<{ reason: string; count: number }>;
}

/**
 * The four honours. Each names one person and says why in plain words;
 * none is "most tickets", which is the ranking that stays with administrators.
 */
export type HonourKey = 'fastest_urgent' | 'hardest' | 'most_hands' | 'steadiest';

export interface Honour {
  key: HonourKey;
  accountId: string | null;
  name: string | null;
  /** The figure that earned it, already worded: "2h 10m", "4 tickets joined". */
  value: string | null;
  /** What was measured, in one line, so the number cannot be misread. */
  detail: string;
}

export const HONOUR_TITLES: Record<HonourKey, string> = {
  fastest_urgent: 'Fastest on urgent',
  hardest: 'Takes the hard ones',
  most_hands: 'Most hands on deck',
  steadiest: 'Steadiest',
};

export interface PersonRow {
  accountId: string;
  name: string;
  resolved: number;
  /** Creation to resolution. */
  medianHours: number | null;
  /** Taking the ticket (claim or join) to resolution. */
  medianFromClaimHours: number | null;
  /** Urgent and high resolutions. */
  urgentHigh: number;
  /** Mean difficulty over their resolutions; see `HARD_SCORE_NOTE`. */
  hardScore: number | null;
  /** Tickets they joined as a collaborator in the period. */
  joined: number;
  reopened: number;
}

export interface People {
  honours: Honour[];
  /** Every resolver, for an administrator; empty for anybody else. */
  rows: PersonRow[];
  /** The reader's own row, whoever they are; null if they resolved nothing. */
  me: PersonRow | null;
}

export interface HardTicket {
  ticketId: string;
  /** Null when the reader may not open the ticket; the row still counts. */
  number: string | null;
  title: string | null;
  category: TicketCategory;
  priority: Priority;
  hours: number;
  fromClaimHours: number | null;
  resolverName: string | null;
  /** How many people worked it: the owner plus collaborators. */
  hands: number;
  score: number;
}

export interface Analytics {
  period: AnalyticsPeriod;
  bucket: Bucket;
  /** ISO instants; `since` is null for all time, `until` is when it was measured. */
  since: string | null;
  until: string;
  overview: Overview;
  throughput: ThroughputPoint[];
  arrivals: Arrivals;
  categories: CategoryStat[];
  priorities: PriorityStat[];
  channels: ChannelStat[];
  locations: LocationStat[];
  /** Tickets marked remote in the period. */
  remote: number;
  requesters: Requesters;
  waiting: Waiting;
  people: People;
  hardest: HardTicket[];
}

/**
 * How hard a ticket was, as one number.
 *
 * Priority weight (urgent 4, high 3, normal 2, low 1) times the natural log of
 * one plus the hours it was open, plus half a point for every extra pair of
 * hands, plus one for every reopen. Logarithmic in time so a machine that sat
 * over a holiday does not outrank every urgent ticket of the term. The same
 * arithmetic is written in SQL; this is its explanation for the screen.
 */
export const HARD_SCORE_NOTE =
  'Priority, how long it stayed open, how many people it took, and whether it came back. Time counts logarithmically, so one ticket that sat over a holiday does not outrank everything else.';

export const PRIORITY_WEIGHT: Record<Priority, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

/** The arithmetic behind `HARD_SCORE_NOTE`, for tests and for the page's own examples. */
export function hardScore(priority: Priority, hours: number, hands: number, reopened: number): number {
  const extraHands = Math.max(0, hands - 1);
  return PRIORITY_WEIGHT[priority] * Math.log(1 + Math.max(0, hours)) + 0.5 * extraHands + reopened;
}

/** The change from a previous figure, as the sign and percentage a stat card shows. */
export interface Delta {
  direction: 'up' | 'down' | 'same';
  /** Whole percent, absent when there was nothing to compare with. */
  percent: number | null;
  text: string;
}

export function deltaOf(current: number, previous: number | null): Delta {
  if (previous === null) return { direction: 'same', percent: null, text: 'No earlier period to compare' };
  if (previous === 0 && current === 0) return { direction: 'same', percent: 0, text: 'Same as before' };
  if (previous === 0) return { direction: 'up', percent: null, text: `Up from none` };
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return { direction: 'same', percent: 0, text: 'Same as before' };
  return {
    direction: change > 0 ? 'up' : 'down',
    percent: Math.abs(change),
    text: `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)}% on the period before`,
  };
}

/** A share (0 to 1) as the whole percent the page prints. */
export function percentOf(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return '—';
  return `${Math.round(share * 100)}%`;
}

/** What a throughput slice is called on an axis: "Mon 16", "Sep 8", "Sep". */
export function bucketLabel(key: string, bucket: Bucket): string {
  const [year, month, day] = key.split('-').map(Number);
  const at = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  if (bucket === 'month') return at.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  if (bucket === 'week') return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  // Spelled by hand: the locale's own "weekday + day" order is not the same
  // on every runtime, and an axis must not change shape between machines.
  return `${WEEKDAY_LABELS[(at.getUTCDay() + 6) % 7]} ${at.getUTCDate()}`;
}

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** An hour of the day as the axis prints it: "8a", "12p", "3p". */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

/** The lead line under the title. */
export function analyticsSentence(overview: Overview, period: AnalyticsPeriod): string {
  const label = PERIOD_LABELS[period].toLowerCase();
  if (overview.resolved === 0) return `Nothing resolved ${label} yet.`;
  const what = overview.resolved === 1 ? 'One ticket resolved' : `${overview.resolved} tickets resolved`;
  const pace =
    overview.perSchoolDay === null
      ? ''
      : `, about ${overview.perSchoolDay.toFixed(overview.perSchoolDay < 10 ? 1 : 0)} a school day`;
  return `${what} ${label}${pace}.`;
}

export { periodBounds };
