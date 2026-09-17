/**
 * `app_analytics`: the analytics screen as one document.
 *
 * `20260916170000_m5_analytics.sql` adds one read over `tickets`,
 * `ticket_collaborators`, `requesters` and `activity_events`, open to anybody
 * who works tickets. What has to be true of it:
 *
 * 1. WHO MAY READ, AND HOW MUCH. A skills officer is refused in the same words
 *    every ticket door uses. A NetRider gets the whole document with the
 *    per-person ranking withheld and a colleague's ticket unnamed; an
 *    administrator gets everything.
 * 2. THE COUNTS ARE THE COUNTS. Resolved, created, cancelled and reopened over
 *    a seeded span come out exactly, cancellations never count as resolutions,
 *    and the previous span's figures are the span before and nothing else.
 * 3. THE SERIES IS ZERO-FILLED, in school-local buckets, and a category's
 *    trend runs the same length as the series.
 * 4. THE ARITHMETIC MATCHES THE DOMAIN. The hard score is the formula in
 *    `hardScore`, the fastest-on-urgent honour is the person with the lowest
 *    median from-claim time over at least three urgent or high tickets, and
 *    the shares sum to one.
 *
 * Every call goes through a real signed-in session, because the actor is
 * derived inside the function. Finished tickets with known hours are written
 * with `app_import_resolved_ticket`, which is the only path that can land a
 * ticket resolved five hours after it was called in; live tickets go through
 * the ordinary lifecycle so the history carries real waiting, reopen and join
 * events.
 *
 * Two spans are read. `tight` opens when this file starts, so its counts are
 * exact whatever ran before it; `wide` reaches back ten days for the figures
 * that need earlier days (steadiest, the previous span).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  identity,
  rawTicket,
  rpcFails,
  rpcOk,
  seedRequester,
  signIn,
} from './support/harness';

// --- The document, as the database writes it ---------------------------------

interface Honour {
  key: string;
  account_id: string | null;
  name: string | null;
  value: string | null;
  detail: string;
}

interface PersonRow {
  account_id: string;
  name: string;
  resolved: number;
  median_hours: number | null;
  median_from_claim_hours: number | null;
  urgent_high: number;
  hard_score: number | null;
  joined: number;
  reopened: number;
}

interface HardTicket {
  ticket_id: string;
  number: string | null;
  title: string | null;
  category: string;
  priority: string;
  hours: number;
  from_claim_hours: number | null;
  resolver_name: string | null;
  hands: number;
  score: number;
}

interface Point {
  key: string;
  created: number;
  resolved: number;
  backlog: number;
}

interface Analytics {
  period_since: string | null;
  until: string;
  bucket: string;
  overview: Record<string, number | null>;
  throughput: Point[];
  arrivals: { by_weekday: number[]; by_hour: number[]; heat: number[][] };
  categories: Array<{
    category: string;
    resolved: number;
    created: number;
    share: number;
    median_hours: number | null;
    trend: number[];
  }>;
  priorities: Array<{
    priority: string;
    resolved: number;
    share: number;
    median_hours: number | null;
    p90_hours: number | null;
    median_from_claim_hours: number | null;
  }>;
  channels: Array<{ channel: string; count: number; share: number }>;
  locations: Array<{ location: string; count: number }>;
  remote: number;
  requesters: {
    staff: number;
    student: number;
    other: number;
    repeat: Array<{ name: string; kind: string; count: number }>;
  };
  waiting: {
    tickets_waited: number;
    share: number;
    median_wait_hours: number | null;
    reasons: Array<{ reason: string; count: number }>;
  };
  people: { honours: Honour[]; rows: PersonRow[]; me: PersonRow | null };
  hardest: HardTicket[];
}

// --- Clocks and calendars -----------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const schoolDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The school-local date an instant falls on. */
function keyOf(at: Date): string {
  return schoolDate.format(at);
}

/** A `YYYY-MM-DD` key moved by whole days. */
function shiftKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** 0 for Sunday, as JavaScript counts. */
function weekdayOf(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isSchoolDay(key: string): boolean {
  const weekday = weekdayOf(key);
  return weekday >= 1 && weekday <= 5;
}

/** Monday-to-Friday dates from one key to another, both inclusive. */
function schoolDaysBetween(from: string, to: string): number {
  let count = 0;
  for (let key = from; key <= to; key = shiftKey(key, 1)) {
    if (isSchoolDay(key)) count += 1;
  }
  return count;
}

/** Every date key from one to another, inclusive. */
function keysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  for (let key = from; key <= to; key = shiftKey(key, 1)) keys.push(key);
  return keys;
}

/**
 * Midday on a school-local date, as an instant. 17:00 UTC is 1pm in summer
 * and noon in winter, and either is safely inside the day.
 */
function middayOf(key: string): Date {
  return new Date(`${key}T17:00:00Z`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The same arithmetic as `hardScore` in src/lib/domain/analytics.ts, written
 * out here because the database suite cannot load that module (it reaches the
 * `@/` alias the db config does not resolve).
 */
const WEIGHT: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

function hardScore(priority: string, hours: number, hands: number, reopened: number): number {
  return WEIGHT[priority] * Math.log(1 + Math.max(0, hours)) + 0.5 * Math.max(0, hands - 1) + reopened;
}

// --- Seeding ------------------------------------------------------------------

let admin: SupabaseClient;
let owner: SupabaseClient;
let collaborator: SupabaseClient;
let officer: SupabaseClient;

/** When this file started: the tight span opens here. */
let opened: Date;
/** An instant just after `opened`, at which the imported tickets are resolved. */
let base: Date;

let today: string;
let staffName: string;
let waitedTicketId: string;
/** The three school days before today that carry one owner resolution each. */
let steadyKeys: string[];

interface NewTicket {
  title: string;
  category?: string;
  priority?: string;
  channel?: 'email' | 'phone_call';
  requesterId?: string | null;
  location?: string;
}

/** A ticket through the real intake, as the administrator, unassigned. */
async function newTicket(options: NewTicket): Promise<string> {
  return rpcOk<string>(admin, 'app_create_ticket', {
    p_title: options.title,
    p_issue: 'Seeded by the analytics suite.',
    p_channel: options.channel ?? 'phone_call',
    p_priority: options.priority ?? 'normal',
    p_submitted_on: null,
    p_requester_id: options.requesterId ?? null,
    p_requester_unknown: options.requesterId == null,
    p_location: options.location ?? 'Room 212',
    p_owner_id: null,
    p_collaborator_ids: [],
    p_devices: [],
    p_category: options.category ?? 'other',
  });
}

/** Claimed and resolved by the same person, seconds apart. */
async function resolvedBy(client: SupabaseClient, ticketId: string): Promise<void> {
  await rpcOk(client, 'app_claim_ticket', { p_ticket: ticketId });
  await rpcOk(client, 'app_resolve_ticket', {
    p_ticket: ticketId,
    p_solution: 'Reseated the cable and confirmed with the requester.',
  });
}

interface Imported {
  title: string;
  resolvedBy: string;
  calledAt: Date;
  resolvedAt: Date;
  priority?: string;
  category?: string;
}

/** A finished ticket with the hours it really took, through the import door. */
async function imported(options: Imported): Promise<string> {
  return rpcOk<string>(admin, 'app_import_resolved_ticket', {
    p_title: options.title,
    p_issue: 'From the desk’s sheet, for the analytics suite.',
    p_called_at: options.calledAt.toISOString(),
    p_resolved_at: options.resolvedAt.toISOString(),
    p_resolved_by: options.resolvedBy,
    p_category: options.category ?? 'other',
    p_priority: options.priority ?? 'normal',
  });
}

async function analytics(
  client: SupabaseClient,
  since: Date | null,
  until: Date | null,
  bucket = 'day',
): Promise<Analytics> {
  return rpcOk<Analytics>(client, 'app_analytics', {
    p_since: since ? since.toISOString() : null,
    p_until: until ? until.toISOString() : null,
    p_bucket: bucket,
  });
}

function tight(client: SupabaseClient, bucket = 'day'): Promise<Analytics> {
  return analytics(client, opened, new Date(opened.getTime() + 2 * DAY), bucket);
}

function wide(client: SupabaseClient, bucket = 'day'): Promise<Analytics> {
  return analytics(client, new Date(opened.getTime() - 10 * DAY), new Date(opened.getTime() + 2 * DAY), bucket);
}

function honour(doc: Analytics, key: string): Honour {
  const found = doc.people.honours.find((entry) => entry.key === key);
  if (!found) throw new Error(`No ${key} honour in the document.`);
  return found;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

beforeAll(async () => {
  admin = await signIn('admin');
  owner = await signIn('owner');
  collaborator = await signIn('collaborator');
  officer = await signIn('skillsOfficer');

  opened = new Date();
  today = keyOf(opened);
  // The imported tickets are resolved at `base`, which has to sit after
  // `opened` and before the database's own now(). A moment's pause makes room.
  await sleep(1500);
  base = new Date(Date.now() - 200);

  const ownerId = identity('owner').id;
  const collaboratorId = identity('collaborator').id;
  const unrelatedId = identity('unrelated').id;

  // Three high tickets the owner took five hours over, three urgent ones the
  // collaborator closed in half an hour, one low one that sat thirty hours.
  for (const n of [1, 2, 3]) {
    await imported({
      title: `Podium laptop ${n} will not join the domain`,
      resolvedBy: ownerId,
      calledAt: new Date(base.getTime() - 5 * HOUR),
      resolvedAt: base,
      priority: 'high',
      category: 'laptop_desktop',
    });
    await imported({
      title: `Locked account ${n} before first period`,
      resolvedBy: collaboratorId,
      calledAt: new Date(base.getTime() - HOUR / 2),
      resolvedAt: base,
      priority: 'urgent',
      category: 'account',
    });
  }
  await imported({
    title: 'Projector in 118 flickers when warm',
    resolvedBy: unrelatedId,
    calledAt: new Date(base.getTime() - 30 * HOUR),
    resolvedAt: base,
    priority: 'low',
    category: 'projector_display',
  });

  // One ticket in the span before `wide`: called fifteen days back, resolved
  // a day later.
  await imported({
    title: 'Cart 4 would not charge overnight',
    resolvedBy: ownerId,
    calledAt: new Date(opened.getTime() - 15 * DAY),
    resolvedAt: new Date(opened.getTime() - 14 * DAY),
  });

  // One owner resolution on each of the three most recent school days before
  // today, so the steadiest honour has days to count.
  steadyKeys = [];
  for (let key = shiftKey(today, -1); steadyKeys.length < 3; key = shiftKey(key, -1)) {
    if (isSchoolDay(key)) steadyKeys.push(key);
  }
  for (const key of steadyKeys) {
    const at = middayOf(key);
    await imported({
      title: `Smartboard recalibrated on ${key}`,
      resolvedBy: ownerId,
      calledAt: new Date(at.getTime() - HOUR),
      resolvedAt: at,
    });
  }

  // Live tickets, through the ordinary lifecycle.
  for (const n of [1, 2]) {
    const id = await newTicket({ title: `Chromebook ${n} keyboard sticks`, category: 'chromebook' });
    await resolvedBy(owner, id);
  }
  await resolvedBy(owner, await newTicket({ title: 'Printer jams on duplex', category: 'printer' }));
  await newTicket({ title: 'Wi-Fi drops in the gym', category: 'network', location: 'Room 118' });

  // Waited, resolved, came back, resolved again.
  waitedTicketId = await newTicket({ title: 'Smartboard pen not tracking' });
  await rpcOk(owner, 'app_claim_ticket', { p_ticket: waitedTicketId });
  await rpcOk(owner, 'app_set_waiting', { p_ticket: waitedTicketId, p_reason: 'Awaiting parts' });
  await rpcOk(owner, 'app_resume_work', { p_ticket: waitedTicketId });
  await rpcOk(owner, 'app_resolve_ticket', {
    p_ticket: waitedTicketId,
    p_solution: 'Replaced the pen battery.',
  });
  await rpcOk(admin, 'app_reopen_ticket', {
    p_ticket: waitedTicketId,
    p_reason: 'Stopped tracking again after lunch.',
  });
  await rpcOk(owner, 'app_resolve_ticket', {
    p_ticket: waitedTicketId,
    p_solution: 'Recalibrated the board and replaced the pen.',
  });

  const cancelled = await newTicket({ title: 'Duplicate of the gym Wi-Fi report' });
  await rpcOk(admin, 'app_cancel_ticket', { p_ticket: cancelled, p_reason: 'Already reported.' });

  // Two requesters from the directory; the collaborator joins the first.
  const staff = await seedRequester('staff');
  const student = await seedRequester('student');
  staffName = staff.displayName;
  const joined = await newTicket({
    title: 'Teacher laptop will not wake',
    channel: 'email',
    requesterId: staff.id,
    location: 'Room 118',
  });
  await rpcOk(owner, 'app_claim_ticket', { p_ticket: joined });
  const number = String((await rawTicket(joined)).number);
  await rpcOk(collaborator, 'app_join_ticket', { p_number: number });
  await newTicket({
    title: 'Student Chromebook screen cracked',
    channel: 'email',
    requesterId: student.id,
    location: 'Library',
  });
});

// --- Who may read ------------------------------------------------------------

describe('app_analytics: who may read', () => {
  it('refuses a skills officer in so many words', async () => {
    const refused = await rpcFails(officer, 'app_analytics', {
      p_since: opened.toISOString(),
      p_until: null,
      p_bucket: 'day',
    });
    expect(refused.message).toBe("Only somebody who works tickets can read the desk's analytics.");
    expect(refused.code).toBe('42501');
  });

  it('gives a NetRider the document with the ranking withheld and only their own tickets named', async () => {
    const doc = await tight(owner);
    expect(doc.people.rows).toEqual([]);
    expect(doc.people.me?.account_id).toBe(identity('owner').id);
    expect(doc.people.me?.resolved).toBe(7);

    const own = doc.hardest.filter((row) => row.resolver_name === identity('owner').displayName);
    const theirs = doc.hardest.filter((row) => row.resolver_name === identity('collaborator').displayName);
    expect(own.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row.number).toMatch(/^EDT-\d+$/);
      expect(row.title).not.toBeNull();
    }
    for (const row of theirs) {
      expect(row.number).toBeNull();
      expect(row.title).toBeNull();
    }
  });

  it('gives an administrator every row, number and title', async () => {
    const doc = await tight(admin);
    expect(doc.people.rows.map((row) => [row.name, row.resolved])).toEqual([
      [identity('owner').displayName, 7],
      [identity('collaborator').displayName, 3],
      [identity('unrelated').displayName, 1],
    ]);
    expect(doc.people.me).toBeNull();
    expect(doc.hardest).toHaveLength(8);
    for (const row of doc.hardest) {
      expect(row.number).toMatch(/^EDT-\d+$/);
      expect(typeof row.title).toBe('string');
    }
  });

  it('refuses a bucket it does not slice by', async () => {
    const refused = await rpcFails(admin, 'app_analytics', {
      p_since: opened.toISOString(),
      p_until: null,
      p_bucket: 'hour',
    });
    expect(refused.message).toBe('Choose day, week or month.');
    expect(refused.code).toBe('23514');
  });

  it('refuses a period that ends before it begins', async () => {
    const refused = await rpcFails(admin, 'app_analytics', {
      p_since: new Date().toISOString(),
      p_until: opened.toISOString(),
      p_bucket: 'day',
    });
    expect(refused.message).toContain('ends before it begins');
  });
});

// --- The counts ---------------------------------------------------------------

describe('app_analytics: the overview', () => {
  it('counts the span exactly, and never a cancellation as a resolution', async () => {
    const { overview } = await tight(admin);
    expect(overview.resolved).toBe(11);
    expect(overview.created).toBe(8);
    expect(overview.cancelled).toBe(1);
    expect(overview.reopened).toBe(1);

    // Ten closed inside a day; the thirty-hour projector did not.
    expect(overview.same_day_share).toBeCloseTo(10 / 11, 3);
    expect(overview.median_hours).toBeGreaterThanOrEqual(0);
    expect(overview.p90_hours).toBeGreaterThanOrEqual(overview.median_hours ?? 0);

    const schoolDays = isSchoolDay(today) ? 1 : 0;
    expect(overview.school_days).toBe(schoolDays);
    expect(overview.per_school_day).toBe(schoolDays === 1 ? 11 : null);

    // Snapshots: the gym Wi-Fi, the teacher laptop and the cracked screen are open.
    expect(overview.open_now).toBeGreaterThanOrEqual(3);
    expect(overview.unassigned_now).toBeGreaterThanOrEqual(2);
    expect(overview.waiting_now).toBeGreaterThanOrEqual(0);
    expect(overview.oldest_open_hours).toBeGreaterThanOrEqual(0);
  });

  it('carries the span before, and none when the start is open', async () => {
    const { overview } = await wide(admin);
    expect(overview.resolved_previous).toBe(1);
    expect(overview.created_previous).toBe(1);
    expect(overview.median_hours_previous).toBe(24);

    const all = await analytics(admin, null, null, 'month');
    expect(all.period_since).toBeNull();
    expect(all.overview.resolved_previous).toBeNull();
    expect(all.overview.created_previous).toBeNull();
    expect(all.overview.median_hours_previous).toBeNull();
  });
});

// --- The series ---------------------------------------------------------------

describe('app_analytics: throughput', () => {
  it('fills every day of the span, zeros included, on the school calendar', async () => {
    const doc = await tight(admin);
    const expectedKeys = keysBetween(today, shiftKey(today, 2));
    expect(doc.throughput.map((point) => point.key)).toEqual(expectedKeys);
    expect(doc.throughput[0]).toMatchObject({ created: 8, resolved: 11 });
    expect(doc.throughput[0].backlog).toBeGreaterThanOrEqual(3);
    for (const point of doc.throughput.slice(1)) {
      expect(point).toMatchObject({ created: 0, resolved: 0 });
    }

    const wider = await wide(admin);
    const wideKeys = keysBetween(keyOf(new Date(opened.getTime() - 10 * DAY)), shiftKey(today, 2));
    expect(wider.throughput.map((point) => point.key)).toEqual(wideKeys);
    const quiet = wider.throughput.filter((point) => point.created === 0 && point.resolved === 0);
    expect(quiet.length).toBeGreaterThanOrEqual(5);
    for (const key of steadyKeys) {
      expect(wider.throughput.find((point) => point.key === key)?.resolved).toBeGreaterThanOrEqual(1);
    }
  });

  it('keys a week by its Monday and a month by its year and month', async () => {
    const weeks = await wide(admin, 'week');
    expect(weeks.throughput.length).toBeGreaterThanOrEqual(2);
    for (const point of weeks.throughput) {
      expect(point.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(weekdayOf(point.key)).toBe(1);
    }

    const months = await analytics(admin, null, null, 'month');
    expect(months.throughput.length).toBeGreaterThanOrEqual(1);
    for (const point of months.throughput) expect(point.key).toMatch(/^\d{4}-\d{2}$/);
    expect(months.throughput[months.throughput.length - 1].key).toBe(today.slice(0, 7));
  });

  it('lays arrivals on the weekday and hour grid', async () => {
    const { arrivals } = await tight(admin);
    expect(arrivals.by_weekday).toHaveLength(7);
    expect(arrivals.by_hour).toHaveLength(24);
    expect(arrivals.heat).toHaveLength(7);
    for (const line of arrivals.heat) expect(line).toHaveLength(24);

    const mondayFirst = (weekdayOf(today) + 6) % 7;
    expect(arrivals.by_weekday[mondayFirst]).toBe(8);
    expect(sum(arrivals.by_weekday)).toBe(8);
    expect(sum(arrivals.by_hour)).toBe(8);
    expect(sum(arrivals.heat.map(sum))).toBe(8);
    expect(sum(arrivals.heat[mondayFirst])).toBe(8);
  });
});

// --- Kinds of work ------------------------------------------------------------

describe('app_analytics: categories, priorities and the rest', () => {
  it('lists every category the span touched, busiest first, shares summing to one', async () => {
    const doc = await tight(admin);
    expect(doc.categories.map((row) => [row.category, row.resolved, row.created])).toEqual([
      ['account', 3, 0],
      ['laptop_desktop', 3, 0],
      ['chromebook', 2, 2],
      ['other', 1, 4],
      ['printer', 1, 1],
      ['projector_display', 1, 0],
      ['network', 0, 1],
    ]);
    expect(sum(doc.categories.map((row) => row.share))).toBeCloseTo(1, 3);
    for (const row of doc.categories) {
      expect(row.trend).toHaveLength(doc.throughput.length);
      expect(sum(row.trend)).toBe(row.resolved);
    }
    expect(doc.categories[1].median_hours).toBe(5);
    expect(doc.categories[6].median_hours).toBeNull();
  });

  it('carries all four priorities in order, with hours from creation and from the claim', async () => {
    const doc = await tight(admin);
    expect(doc.priorities.map((row) => row.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(doc.priorities.map((row) => row.resolved)).toEqual([3, 3, 4, 1]);
    expect(sum(doc.priorities.map((row) => row.share))).toBeCloseTo(1, 3);

    const [urgent, high, , low] = doc.priorities;
    expect(urgent.median_hours).toBe(0.5);
    expect(urgent.median_from_claim_hours).toBe(0.5);
    expect(high.median_hours).toBe(5);
    expect(high.p90_hours).toBe(5);
    expect(high.median_from_claim_hours).toBe(5);
    expect(low.median_hours).toBe(30);
  });

  it('counts channels, rooms, remote work and who asked', async () => {
    const doc = await tight(admin);
    expect(doc.channels.map((row) => [row.channel, row.count])).toEqual([
      ['walk_in', 0],
      ['email', 2],
      ['phone_call', 6],
    ]);
    expect(sum(doc.channels.map((row) => row.share))).toBeCloseTo(1, 3);

    expect(doc.locations[0]).toEqual({ location: 'Room 212', count: 5 });
    expect(doc.locations[1]).toEqual({ location: 'Room 118', count: 2 });
    expect(doc.locations.length).toBeLessThanOrEqual(8);
    expect(doc.remote).toBe(0);

    expect(doc.requesters).toMatchObject({ staff: 1, student: 1, other: 6 });
    expect(doc.requesters.repeat.length).toBeLessThanOrEqual(5);
    expect(doc.requesters.repeat).toContainEqual({ name: staffName, kind: 'staff', count: 1 });
  });

  it('finds the tickets that waited, how long, and why', async () => {
    const { waiting } = await tight(admin);
    expect(waiting.tickets_waited).toBe(1);
    expect(waiting.share).toBeCloseTo(1 / 11, 3);
    expect(waiting.median_wait_hours).toBeGreaterThanOrEqual(0);
    expect(waiting.median_wait_hours).toBeLessThan(0.1);
    expect(waiting.reasons).toEqual([{ reason: 'Awaiting parts', count: 1 }]);
  });
});

// --- People -------------------------------------------------------------------

describe('app_analytics: people', () => {
  it('names the fastest on urgent work by median from-claim time over at least three', async () => {
    const fastest = honour(await tight(admin), 'fastest_urgent');
    expect(fastest.account_id).toBe(identity('collaborator').id);
    expect(fastest.name).toBe(identity('collaborator').displayName);
    expect(fastest.value).toBe('30m');
    expect(fastest.detail).toBe(
      'Median time from taking an urgent or high ticket to resolving it, over 3 of them',
    );
  });

  it('gives the hard-ones honour to the highest mean score among those with three resolutions', async () => {
    const doc = await tight(admin);
    const eligible = doc.people.rows.filter((row) => row.resolved >= 3);
    const best = eligible.reduce((top, row) => ((row.hard_score ?? 0) > (top.hard_score ?? 0) ? row : top));
    const hardest = honour(doc, 'hardest');
    expect(hardest.account_id).toBe(best.account_id);
    expect(hardest.value).toBe(`score ${(best.hard_score ?? 0).toFixed(1)}`);
    expect(hardest.detail).toContain(`over ${best.resolved} resolutions`);
  });

  it('counts hands on deck from the collaborator table, and leaves an unearned honour empty', async () => {
    const doc = await tight(admin);
    const hands = honour(doc, 'most_hands');
    expect(hands.account_id).toBe(identity('collaborator').id);
    expect(hands.value).toBe('1 ticket joined');

    const steadiest = honour(doc, 'steadiest');
    expect(steadiest.account_id).toBeNull();
    expect(steadiest.name).toBeNull();
    expect(steadiest.value).toBeNull();
    expect(steadiest.detail.length).toBeGreaterThan(0);

    expect(doc.people.honours.map((entry) => entry.key)).toEqual([
      'fastest_urgent',
      'hardest',
      'most_hands',
      'steadiest',
    ]);
  });

  it('names the steadiest by distinct school days with a resolution', async () => {
    const steadiest = honour(await wide(admin), 'steadiest');
    expect(steadiest.account_id).toBe(identity('owner').id);
    const days = 3 + (isSchoolDay(today) ? 1 : 0);
    const schoolDays = schoolDaysBetween(keyOf(new Date(opened.getTime() - 10 * DAY)), today);
    expect(steadiest.value).toBe(`${days} of ${schoolDays} school days`);
  });

  it('fills each person’s row', async () => {
    const doc = await tight(admin);
    const mine = doc.people.rows.find((row) => row.account_id === identity('owner').id);
    expect(mine).toMatchObject({ resolved: 7, urgent_high: 3, reopened: 1, joined: 0 });
    expect(mine?.median_hours).toBeGreaterThanOrEqual(0);
    expect(mine?.median_from_claim_hours).toBeGreaterThanOrEqual(0);
    expect(mine?.hard_score).toBeGreaterThan(0);

    const theirs = doc.people.rows.find((row) => row.account_id === identity('collaborator').id);
    expect(theirs).toMatchObject({ resolved: 3, urgent_high: 3, reopened: 0, joined: 1 });
    expect(theirs?.median_from_claim_hours).toBe(0.5);
  });
});

// --- The hardest tickets ------------------------------------------------------

describe('app_analytics: hardest', () => {
  it('scores each ticket by the domain’s arithmetic and orders them by it', async () => {
    const doc = await tight(admin);
    expect(doc.hardest).toHaveLength(8);
    for (let index = 1; index < doc.hardest.length; index += 1) {
      expect(doc.hardest[index - 1].score).toBeGreaterThanOrEqual(doc.hardest[index].score);
    }
    for (const row of doc.hardest) {
      const reopened = row.ticket_id === waitedTicketId ? 1 : 0;
      expect(row.score).toBeCloseTo(hardScore(row.priority, row.hours, row.hands, reopened), 1);
    }

    // Five hours at high priority, one pair of hands, never came back.
    const top = doc.hardest[0];
    expect(top.priority).toBe('high');
    expect(top.hours).toBe(5);
    expect(top.from_claim_hours).toBe(5);
    expect(top.hands).toBe(1);
    expect(top.score).toBeCloseTo(3 * Math.log(6), 1);

    const waited = doc.hardest.find((row) => row.ticket_id === waitedTicketId);
    expect(waited?.score).toBeGreaterThanOrEqual(1);
  });
});
