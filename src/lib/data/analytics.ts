import 'server-only';

/**
 * The desk's analytics, read from `app_analytics` and checked into the shape
 * `src/lib/domain/analytics.ts` declares.
 *
 * One call, one document. The function does every count in the database and
 * refuses anybody who does not work tickets, so this module does no filtering
 * of its own: the page's gate decides what a person sees instead of a refusal,
 * and the database decides what they may read.
 *
 * The document is checked field by field rather than cast, because these are
 * the numbers people are measured by. A number that arrives as text, an array
 * a day short, a category the vocabulary does not know: each has to fail here,
 * where it is a log line, rather than reach the page as a zero that reads like
 * a quiet term. A failure is `null`, and the page draws its empty state; the
 * log says where the document went wrong and never what it held, since the
 * document names people and tickets.
 *
 * Keys arrive in the database's snake_case and leave in the domain's camelCase;
 * the mapping is written once, here.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { isRecord } from '@/lib/guards';
import {
  bucketFor,
  periodBounds,
  type Analytics,
  type AnalyticsPeriod,
  type Arrivals,
  type Bucket,
  type CategoryStat,
  type ChannelStat,
  type HardTicket,
  type Honour,
  type HonourKey,
  type LocationStat,
  type Overview,
  type People,
  type PersonRow,
  type PriorityStat,
  type Requesters,
  type RequesterStat,
  type ThroughputPoint,
  type Waiting,
} from '@/lib/domain/analytics';
import { PRIORITY_ORDER } from '@/lib/domain/resolved-stats';
import {
  CHANNEL_LABELS,
  isTicketCategory,
  type IntakeChannel,
  type Priority,
} from '@/lib/domain/types';

/** Where a document stopped being the shape the domain declares. */
class Malformed extends Error {
  constructor(path: string) {
    super(path);
    this.name = 'Malformed';
  }
}

function fail(path: string): never {
  throw new Malformed(path);
}

const HONOUR_KEYS: readonly HonourKey[] = ['fastest_urgent', 'hardest', 'most_hands', 'steadiest'];
const REQUESTER_KINDS = ['staff', 'student', 'role', 'unknown'] as const;

function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITY_ORDER as readonly string[]).includes(value);
}

function isChannel(value: unknown): value is IntakeChannel {
  return typeof value === 'string' && Object.hasOwn(CHANNEL_LABELS, value);
}

function isRequesterKind(value: unknown): value is RequesterStat['kind'] {
  return typeof value === 'string' && (REQUESTER_KINDS as readonly string[]).includes(value);
}

// --- Readers -----------------------------------------------------------------
// Each takes the value and the path it was found at, returns the checked value,
// and throws Malformed otherwise. Nothing is coerced: a count that arrives as
// "3" is a count the database did not send.

function record(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(path);
}

function list(value: unknown, path: string): unknown[] {
  return Array.isArray(value) ? value : fail(path);
}

function fixedList(value: unknown, path: string, length: number): unknown[] {
  const items = list(value, path);
  return items.length === length ? items : fail(`${path}.length`);
}

/** A finite number. */
function figure(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fail(path);
}

function nullableFigure(value: unknown, path: string): number | null {
  return value === null || value === undefined ? null : figure(value, path);
}

/** A whole number that is never negative. */
function count(value: unknown, path: string): number {
  const parsed = figure(value, path);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fail(path);
}

function nullableCount(value: unknown, path: string): number | null {
  return value === null || value === undefined ? null : count(value, path);
}

/** Hours: finite and not negative. */
function hours(value: unknown, path: string): number {
  const parsed = figure(value, path);
  return parsed >= 0 ? parsed : fail(path);
}

function nullableHours(value: unknown, path: string): number | null {
  return value === null || value === undefined ? null : hours(value, path);
}

/** A share of something: between zero and one, with a hair of rounding room. */
function share(value: unknown, path: string): number {
  const parsed = figure(value, path);
  return parsed >= 0 && parsed <= 1.0001 ? Math.min(1, parsed) : fail(path);
}

function nullableShare(value: unknown, path: string): number | null {
  return value === null || value === undefined ? null : share(value, path);
}

function text(value: unknown, path: string): string {
  return typeof value === 'string' ? value : fail(path);
}

function nullableText(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : text(value, path);
}

/** An instant the database wrote, kept as the ISO string it arrived as. */
function instant(value: unknown, path: string): string {
  const parsed = text(value, path);
  return Number.isNaN(Date.parse(parsed)) ? fail(path) : parsed;
}

function counts(value: unknown, path: string, length: number): number[] {
  return fixedList(value, path, length).map((item, index) => count(item, `${path}[${index}]`));
}

// --- Sections ------------------------------------------------------------------

function overviewOf(value: unknown): Overview {
  const row = record(value, 'overview');
  return {
    resolved: count(row.resolved, 'overview.resolved'),
    resolvedPrevious: nullableCount(row.resolved_previous, 'overview.resolved_previous'),
    created: count(row.created, 'overview.created'),
    createdPrevious: nullableCount(row.created_previous, 'overview.created_previous'),
    cancelled: count(row.cancelled, 'overview.cancelled'),
    reopened: count(row.reopened, 'overview.reopened'),
    medianHours: nullableHours(row.median_hours, 'overview.median_hours'),
    medianHoursPrevious: nullableHours(row.median_hours_previous, 'overview.median_hours_previous'),
    p90Hours: nullableHours(row.p90_hours, 'overview.p90_hours'),
    sameDayShare: nullableShare(row.same_day_share, 'overview.same_day_share'),
    schoolDays: count(row.school_days, 'overview.school_days'),
    perSchoolDay: nullableHours(row.per_school_day, 'overview.per_school_day'),
    perWeek: nullableHours(row.per_week, 'overview.per_week'),
    openNow: count(row.open_now, 'overview.open_now'),
    unassignedNow: count(row.unassigned_now, 'overview.unassigned_now'),
    waitingNow: count(row.waiting_now, 'overview.waiting_now'),
    oldestOpenHours: nullableHours(row.oldest_open_hours, 'overview.oldest_open_hours'),
  };
}

/** `YYYY-MM-DD` for a day or a week (its Monday), `YYYY-MM` for a month. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

function throughputOf(value: unknown, bucket: Bucket): ThroughputPoint[] {
  const pattern = bucket === 'month' ? MONTH_KEY : DAY_KEY;
  return list(value, 'throughput').map((item, index) => {
    const path = `throughput[${index}]`;
    const row = record(item, path);
    const key = text(row.key, `${path}.key`);
    if (!pattern.test(key)) fail(`${path}.key`);
    return {
      key,
      created: count(row.created, `${path}.created`),
      resolved: count(row.resolved, `${path}.resolved`),
      backlog: count(row.backlog, `${path}.backlog`),
    };
  });
}

function arrivalsOf(value: unknown): Arrivals {
  const row = record(value, 'arrivals');
  return {
    byWeekday: counts(row.by_weekday, 'arrivals.by_weekday', 7),
    byHour: counts(row.by_hour, 'arrivals.by_hour', 24),
    heat: fixedList(row.heat, 'arrivals.heat', 7).map((line, index) =>
      counts(line, `arrivals.heat[${index}]`, 24),
    ),
  };
}

/** Only the categories the vocabulary knows; a stranger is dropped, not fatal. */
function categoriesOf(value: unknown, slices: number): CategoryStat[] {
  const rows: CategoryStat[] = [];
  list(value, 'categories').forEach((item, index) => {
    const path = `categories[${index}]`;
    const row = record(item, path);
    if (!isTicketCategory(row.category)) return;
    rows.push({
      category: row.category,
      resolved: count(row.resolved, `${path}.resolved`),
      created: count(row.created, `${path}.created`),
      share: share(row.share, `${path}.share`),
      medianHours: nullableHours(row.median_hours, `${path}.median_hours`),
      trend: counts(row.trend, `${path}.trend`, slices),
    });
  });
  return rows;
}

function prioritiesOf(value: unknown): PriorityStat[] {
  const rows: PriorityStat[] = [];
  list(value, 'priorities').forEach((item, index) => {
    const path = `priorities[${index}]`;
    const row = record(item, path);
    if (!isPriority(row.priority)) return;
    rows.push({
      priority: row.priority,
      resolved: count(row.resolved, `${path}.resolved`),
      share: share(row.share, `${path}.share`),
      medianHours: nullableHours(row.median_hours, `${path}.median_hours`),
      p90Hours: nullableHours(row.p90_hours, `${path}.p90_hours`),
      medianFromClaimHours: nullableHours(
        row.median_from_claim_hours,
        `${path}.median_from_claim_hours`,
      ),
    });
  });
  return rows;
}

function channelsOf(value: unknown): ChannelStat[] {
  const rows: ChannelStat[] = [];
  list(value, 'channels').forEach((item, index) => {
    const path = `channels[${index}]`;
    const row = record(item, path);
    if (!isChannel(row.channel)) return;
    rows.push({
      channel: row.channel,
      count: count(row.count, `${path}.count`),
      share: share(row.share, `${path}.share`),
    });
  });
  return rows;
}

function locationsOf(value: unknown): LocationStat[] {
  return list(value, 'locations').map((item, index) => {
    const path = `locations[${index}]`;
    const row = record(item, path);
    return {
      location: text(row.location, `${path}.location`),
      count: count(row.count, `${path}.count`),
    };
  });
}

function requestersOf(value: unknown): Requesters {
  const row = record(value, 'requesters');
  const repeat = list(row.repeat, 'requesters.repeat').map((item, index) => {
    const path = `requesters.repeat[${index}]`;
    const entry = record(item, path);
    return {
      name: text(entry.name, `${path}.name`),
      kind: isRequesterKind(entry.kind) ? entry.kind : fail(`${path}.kind`),
      count: count(entry.count, `${path}.count`),
    };
  });
  return {
    staff: count(row.staff, 'requesters.staff'),
    student: count(row.student, 'requesters.student'),
    other: count(row.other, 'requesters.other'),
    repeat,
  };
}

function waitingOf(value: unknown): Waiting {
  const row = record(value, 'waiting');
  const reasons = list(row.reasons, 'waiting.reasons').map((item, index) => {
    const path = `waiting.reasons[${index}]`;
    const entry = record(item, path);
    return {
      reason: text(entry.reason, `${path}.reason`),
      count: count(entry.count, `${path}.count`),
    };
  });
  return {
    ticketsWaited: count(row.tickets_waited, 'waiting.tickets_waited'),
    share: share(row.share, 'waiting.share'),
    medianWaitHours: nullableHours(row.median_wait_hours, 'waiting.median_wait_hours'),
    reasons,
  };
}

function personOf(value: unknown, path: string): PersonRow {
  const row = record(value, path);
  return {
    accountId: text(row.account_id, `${path}.account_id`),
    name: text(row.name, `${path}.name`),
    resolved: count(row.resolved, `${path}.resolved`),
    medianHours: nullableHours(row.median_hours, `${path}.median_hours`),
    medianFromClaimHours: nullableHours(
      row.median_from_claim_hours,
      `${path}.median_from_claim_hours`,
    ),
    urgentHigh: count(row.urgent_high, `${path}.urgent_high`),
    hardScore: nullableFigure(row.hard_score, `${path}.hard_score`),
    joined: count(row.joined, `${path}.joined`),
    reopened: count(row.reopened, `${path}.reopened`),
  };
}

/**
 * Exactly the four honours, in the declared order. A missing one is a
 * malformed document, not an empty honour: the database always sends all four
 * and says in each whether anybody earned it.
 */
function honoursOf(value: unknown): Honour[] {
  const items = list(value, 'people.honours');
  return HONOUR_KEYS.map((key) => {
    const index = items.findIndex((item) => isRecord(item) && item.key === key);
    if (index < 0) fail(`people.honours.${key}`);
    const path = `people.honours[${index}]`;
    const row = record(items[index], path);
    const name = nullableText(row.name, `${path}.name`);
    const accountId = nullableText(row.account_id, `${path}.account_id`);
    const figure = nullableText(row.value, `${path}.value`);
    // Named and unnamed are the two shapes; half of one is neither.
    if ((name === null) !== (accountId === null) || (name === null) !== (figure === null)) {
      fail(`${path}.name`);
    }
    return {
      key,
      accountId,
      name,
      value: figure,
      detail: text(row.detail, `${path}.detail`),
    };
  });
}

function peopleOf(value: unknown): People {
  const row = record(value, 'people');
  return {
    honours: honoursOf(row.honours),
    rows: list(row.rows, 'people.rows').map((item, index) =>
      personOf(item, `people.rows[${index}]`),
    ),
    me: row.me === null || row.me === undefined ? null : personOf(row.me, 'people.me'),
  };
}

/** A ticket with a category or priority the vocabulary does not know is dropped. */
function hardestOf(value: unknown): HardTicket[] {
  const rows: HardTicket[] = [];
  list(value, 'hardest').forEach((item, index) => {
    const path = `hardest[${index}]`;
    const row = record(item, path);
    if (!isTicketCategory(row.category) || !isPriority(row.priority)) return;
    rows.push({
      ticketId: text(row.ticket_id, `${path}.ticket_id`),
      number: nullableText(row.number, `${path}.number`),
      title: nullableText(row.title, `${path}.title`),
      category: row.category,
      priority: row.priority,
      hours: hours(row.hours, `${path}.hours`),
      fromClaimHours: nullableHours(row.from_claim_hours, `${path}.from_claim_hours`),
      resolverName: nullableText(row.resolver_name, `${path}.resolver_name`),
      hands: count(row.hands, `${path}.hands`),
      score: figure(row.score, `${path}.score`),
    });
  });
  return rows;
}

/**
 * The document `app_analytics` returned, as the domain's `Analytics`, or null
 * when any part of it is not the shape declared. The period and bucket are
 * what the caller asked for, not what the document says: the document is the
 * answer, the request is the question, and the screen labels the question.
 */
export function checkAnalytics(
  document: unknown,
  period: AnalyticsPeriod,
  bucket: Bucket,
): Analytics | null {
  try {
    const root = record(document, 'document');
    const throughput = throughputOf(root.throughput, bucket);
    return {
      period,
      bucket,
      since: root.period_since === null || root.period_since === undefined
        ? null
        : instant(root.period_since, 'period_since'),
      until: instant(root.until, 'until'),
      overview: overviewOf(root.overview),
      throughput,
      arrivals: arrivalsOf(root.arrivals),
      categories: categoriesOf(root.categories, throughput.length),
      priorities: prioritiesOf(root.priorities),
      channels: channelsOf(root.channels),
      locations: locationsOf(root.locations),
      remote: count(root.remote, 'remote'),
      requesters: requestersOf(root.requesters),
      waiting: waitingOf(root.waiting),
      people: peopleOf(root.people),
      hardest: hardestOf(root.hardest),
    };
  } catch (cause) {
    if (cause instanceof Malformed) {
      console.error(`app_analytics document malformed at ${cause.message}`);
      return null;
    }
    throw cause;
  }
}

/**
 * One period's analytics, memoised for the render pass.
 *
 * The bounds are computed here rather than in the database so the period is
 * the school's calendar rather than the server's, and the bucket follows the
 * period so a term is read week by week and all time month by month. Null on
 * a refusal, an error or a malformed document; the reason is logged without
 * the document, and the page draws its empty state.
 */
export const loadAnalytics = cache(
  async (period: AnalyticsPeriod): Promise<Analytics | null> => {
    const bounds = periodBounds(period);
    const bucket = bucketFor(period);
    try {
      const supabase = await createClient();
      const { data, error } = await supabase.rpc('app_analytics', {
        p_since: bounds.since,
        p_until: bounds.until,
        p_bucket: bucket,
      });
      if (error) {
        console.error(`app_analytics failed (${error.code ?? 'no code'})`);
        return null;
      }
      return checkAnalytics(data, period, bucket);
    } catch (cause) {
      console.error(`loadAnalytics failed (${cause instanceof Error ? cause.name : 'unknown'})`);
      return null;
    }
  },
);
