/**
 * A month at the desk, invented, for building and checking the analytics page
 * without a database: what `app_analytics` would hand back for September 2026,
 * measured on the last evening of the month.
 *
 * Every figure agrees with every other. The throughput days sum to the
 * overview's created and resolved, the backlog ends at what is open now, the
 * category and priority counts add up to the resolutions, the shares to one,
 * and every hard score is the domain's own arithmetic. That is what makes it
 * worth drawing charts against: a bar that looks wrong here is the chart's
 * fault, not the fixture's. Names are the demo data's; nothing is real.
 *
 * `ANALYTICS_FIXTURE=1` makes /analytics draw this instead of reading the
 * database, so the page can be looked at on a dev server.
 */

import {
  hardScore,
  type Analytics,
  type CategoryStat,
  type HardTicket,
  type Honour,
  type PersonRow,
  type ThroughputPoint,
} from '@/lib/domain/analytics';
import type { Priority, TicketCategory } from '@/lib/domain/types';

/**
 * `total` split across `weights`, in proportion and in whole numbers, so the
 * pieces always sum back to the total (cumulative rounding, not per-cell).
 */
function spread(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  let running = 0;
  let placed = 0;
  return weights.map((weight) => {
    running += weight;
    const target = Math.round((total * running) / sum);
    const piece = target - placed;
    placed = target;
    return piece;
  });
}

/* September 2026, Tuesday the 1st to Wednesday the 30th. Weekends are quiet. */
const CREATED_BY_DAY = [
  5, 4, 3, 2, 0, 1, 4, 3, 5, 2, 3, 0, 0, 6, 3, 4, 2, 1, 0, 1, 3, 4, 2, 3, 2, 0, 0, 2, 2, 1,
];
const RESOLVED_BY_DAY = [
  3, 4, 2, 3, 0, 0, 2, 4, 3, 3, 2, 0, 0, 4, 3, 5, 3, 2, 0, 0, 2, 3, 4, 2, 2, 0, 0, 1, 2, 1,
];
/** Open when the month began; the backlog runs forward from here. */
const OPEN_BEFORE = 6;

const CREATED = CREATED_BY_DAY.reduce((a, b) => a + b, 0); // 68
const RESOLVED = RESOLVED_BY_DAY.reduce((a, b) => a + b, 0); // 60

const THROUGHPUT: ThroughputPoint[] = CREATED_BY_DAY.map((created, i) => {
  const key = `2026-09-${String(i + 1).padStart(2, '0')}`;
  const resolved = RESOLVED_BY_DAY[i];
  const backlog =
    OPEN_BEFORE +
    CREATED_BY_DAY.slice(0, i + 1).reduce((a, b) => a + b, 0) -
    RESOLVED_BY_DAY.slice(0, i + 1).reduce((a, b) => a + b, 0);
  return { key, created, resolved, backlog };
});

const OPEN_NOW = THROUGHPUT[THROUGHPUT.length - 1].backlog; // 14

/* When the 68 arrived. Monday first, midnight first. */
const BY_WEEKDAY = [15, 17, 16, 12, 6, 0, 2];
const BY_HOUR = [0, 0, 0, 0, 0, 0, 1, 4, 9, 8, 7, 6, 5, 7, 6, 5, 3, 2, 1, 1, 1, 1, 1, 0];
const HEAT = BY_WEEKDAY.map((count) => spread(count, BY_HOUR));

function category(
  key: TicketCategory,
  resolved: number,
  created: number,
  medianHours: number | null,
): CategoryStat {
  return {
    category: key,
    resolved,
    created,
    share: resolved / RESOLVED,
    medianHours,
    trend: spread(resolved, RESOLVED_BY_DAY),
  };
}

const CATEGORIES: CategoryStat[] = [
  category('chromebook', 19, 22, 3.2),
  category('laptop_desktop', 9, 10, 9.5),
  category('projector_display', 8, 8, 4.0),
  category('network', 7, 9, 6.5),
  category('printer', 6, 6, 2.1),
  category('account', 5, 6, 1.2),
  category('software', 4, 4, 7.8),
  category('other', 2, 2, 12.0),
  category('phone', 0, 1, null),
];

function person(
  accountId: string,
  name: string,
  resolved: number,
  medianHours: number,
  medianFromClaimHours: number,
  urgentHigh: number,
  hard: number,
  joined: number,
  reopened: number,
): PersonRow {
  return {
    accountId,
    name,
    resolved,
    medianHours,
    medianFromClaimHours,
    urgentHigh,
    hardScore: hard,
    joined,
    reopened,
  };
}

const PEOPLE: PersonRow[] = [
  person('acct_morgan', 'Morgan Ellis', 18, 4.8, 3.1, 5, 6.9, 2, 1),
  person('acct_priya', 'Priya Raman', 15, 3.9, 2.4, 6, 7.4, 3, 0),
  person('acct_dev', 'Dev Okafor', 12, 7.6, 5.2, 4, 9.1, 1, 1),
  person('acct_sam', 'Sam Whitaker', 9, 6.1, 4.4, 2, 6.2, 5, 0),
  person('acct_jordan', 'Jordan Pike', 6, 9.8, 7.0, 0, 5.5, 1, 1),
];

const HONOURS: Honour[] = [
  {
    key: 'fastest_urgent',
    accountId: 'acct_priya',
    name: 'Priya Raman',
    value: '1h 25m',
    detail: 'Median from claiming an urgent ticket to resolving it, over at least two.',
  },
  {
    key: 'hardest',
    accountId: 'acct_dev',
    name: 'Dev Okafor',
    value: '9.1 average',
    detail: 'Mean hard score over the tickets they resolved.',
  },
  {
    key: 'most_hands',
    accountId: 'acct_sam',
    name: 'Sam Whitaker',
    value: '5 tickets joined',
    detail: "Tickets they joined as a collaborator on somebody else's ticket.",
  },
  {
    key: 'steadiest',
    accountId: 'acct_morgan',
    name: 'Morgan Ellis',
    value: '14 of 22 school days',
    detail: 'School days with at least one resolution of their own.',
  },
];

function hard(
  ticketId: string,
  number: string | null,
  title: string | null,
  cat: TicketCategory,
  priority: Priority,
  hours: number,
  fromClaimHours: number | null,
  resolverName: string | null,
  hands: number,
  reopened: number,
): HardTicket {
  return {
    ticketId,
    number,
    title,
    category: cat,
    priority,
    hours,
    fromClaimHours,
    resolverName,
    hands,
    score: hardScore(priority, hours, hands, reopened),
  };
}

const HARDEST: HardTicket[] = [
  hard('t_1037', 'EDT-1037', 'Wi-Fi drops across the whole east wing', 'network', 'urgent', 30, 28, 'Priya Raman', 3, 0),
  // A ticket the reader may not open: it still counts, but carries no name.
  hard('t_1029', null, null, 'chromebook', 'urgent', 40, null, null, 1, 0),
  hard('t_1042', 'EDT-1042', 'Projector in Room 212 flickers, then drops HDMI', 'projector_display', 'high', 96, 70, 'Dev Okafor', 2, 0),
  hard('t_1046', null, null, 'network', 'high', 60, null, null, 2, 0),
  hard('t_1051', 'EDT-1051', 'Main office printer jams every third page', 'printer', 'high', 52, 44, 'Sam Whitaker', 2, 0),
  hard('t_1008', 'EDT-1008', 'Cart of Chromebooks will not charge', 'chromebook', 'normal', 200, 160, 'Jordan Pike', 3, 0),
  hard('t_1019', 'EDT-1019', 'Staff laptop will not boot after an update', 'laptop_desktop', 'normal', 150, 120, 'Morgan Ellis', 2, 1),
  hard('t_1033', 'EDT-1033', 'Account locked the morning of a state test', 'account', 'urgent', 6, 5, 'Priya Raman', 1, 0),
].sort((a, b) => b.score - a.score);

export const SAMPLE_ANALYTICS: Analytics = {
  period: 'month',
  bucket: 'day',
  since: '2026-09-01T04:00:00.000Z',
  until: '2026-09-30T20:00:00.000Z',
  overview: {
    resolved: RESOLVED,
    resolvedPrevious: 52,
    created: CREATED,
    createdPrevious: 61,
    cancelled: 4,
    reopened: 3,
    medianHours: 5.5,
    medianHoursPrevious: 7.2,
    p90Hours: 52,
    sameDayShare: 0.63,
    schoolDays: 22,
    perSchoolDay: RESOLVED / 22,
    perWeek: RESOLVED / (30 / 7),
    openNow: OPEN_NOW,
    unassignedNow: 3,
    waitingNow: 4,
    oldestOpenHours: 212,
  },
  throughput: THROUGHPUT,
  arrivals: { byWeekday: BY_WEEKDAY, byHour: BY_HOUR, heat: HEAT },
  categories: CATEGORIES,
  priorities: [
    { priority: 'urgent', resolved: 4, share: 4 / RESOLVED, medianHours: 1.6, p90Hours: 6, medianFromClaimHours: 1.1 },
    { priority: 'high', resolved: 13, share: 13 / RESOLVED, medianHours: 3.4, p90Hours: 20, medianFromClaimHours: 2.5 },
    { priority: 'normal', resolved: 36, share: 36 / RESOLVED, medianHours: 6.2, p90Hours: 60, medianFromClaimHours: 4.0 },
    { priority: 'low', resolved: 7, share: 7 / RESOLVED, medianHours: 30, p90Hours: 120, medianFromClaimHours: 22 },
  ],
  channels: [
    { channel: 'walk_in', count: 41, share: 41 / CREATED },
    { channel: 'email', count: 19, share: 19 / CREATED },
    { channel: 'phone_call', count: 8, share: 8 / CREATED },
  ],
  locations: [
    { location: 'Room 212', count: 7 },
    { location: 'Library', count: 6 },
    { location: 'Main Office', count: 5 },
    { location: 'Lab B', count: 5 },
    { location: 'Room 118', count: 4 },
    { location: 'Gym office', count: 3 },
    { location: 'Room 305', count: 3 },
    { location: 'Cafeteria', count: 2 },
  ],
  remote: 6,
  requesters: {
    staff: 38,
    student: 24,
    other: 6,
    repeat: [
      { name: 'Ms. Calloway', kind: 'staff', count: 5 },
      { name: 'Riley Chen', kind: 'student', count: 4 },
      { name: 'Front Office', kind: 'role', count: 4 },
      { name: 'Dr. Hale', kind: 'staff', count: 3 },
      { name: 'Mr. Osei', kind: 'staff', count: 3 },
    ],
  },
  waiting: {
    ticketsWaited: 14,
    share: 14 / RESOLVED,
    medianWaitHours: 26,
    reasons: [
      { reason: 'Awaiting parts', count: 6 },
      { reason: 'Awaiting user', count: 5 },
      { reason: 'Awaiting vendor', count: 3 },
    ],
  },
  people: {
    honours: HONOURS,
    rows: PEOPLE,
    me: PEOPLE[2],
  },
  hardest: HARDEST,
};

/** The same month as a NetRider sees it: honours and their own row, no table. */
export const SAMPLE_ANALYTICS_FOR_NETRIDER: Analytics = {
  ...SAMPLE_ANALYTICS,
  people: { ...SAMPLE_ANALYTICS.people, rows: [] },
  hardest: SAMPLE_ANALYTICS.hardest,
};
