/**
 * M5 insights: the numbers behind the dashboard.
 *
 * One decision shapes this whole file, and it is worth being explicit about
 * because it is the opposite of every other read in this schema. Insights are
 * TEAM-WIDE BY DESIGN. Everywhere else a technician sees the tickets they own,
 * collaborate on, or could claim; here they see how the helpdesk as a whole is
 * doing — how many requests came in this week, how long resolutions are taking,
 * who has what open. That is the point of the screen, so `app_insights` is
 * SECURITY DEFINER and deliberately reads past row-level security.
 *
 * What that buys has to be paid for at the door, so the only gate is the one
 * that matters: an ACTIVE ACCOUNT. An account awaiting setup, a denied request
 * and an anonymous caller each reach nothing at all, and there is no partial
 * answer for any of them.
 *
 * Every count below is asserted as a DELTA around the call that changes it,
 * never as an absolute. Files in this suite share a database and run in
 * sequence, so "there are four open tickets" is a fact about whatever ran first;
 * "claiming a ticket moved one from open to assigned" is a fact about the
 * function under test.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  anonClient,
  identity,
  rpcFails,
  rpcOk,
  schoolToday,
  signIn,
} from './support/harness';

/** insufficient_privilege, as PostgREST reports it. */
const REFUSED = '42501';

let admin: SupabaseClient;
let owner: SupabaseClient;
let unrelated: SupabaseClient;
let pending: SupabaseClient;
let denied: SupabaseClient;

const ACTIVE_STATUSES = ['assigned', 'in_progress', 'open', 'waiting'];
const PRIORITIES = ['high', 'low', 'normal', 'urgent'];
const DEVICE_STATUSES = [
  'deployed',
  'in_repair',
  'in_stock',
  'lost',
  'retired',
  'surplus',
];

interface SeriesPoint {
  date: string;
  opened: number;
  resolved: number;
}

interface TechnicianRow {
  account_id: string;
  name: string | null;
  resolved: number;
  minutes: number;
  open: number;
}

interface Counted {
  count: number;
}

interface Insights {
  days: number;
  series: SeriesPoint[];
  open_by_status: Record<string, number>;
  open_by_priority: Record<string, number>;
  by_category: Array<Counted & { category: string }>;
  resolution: {
    median_hours: number | null;
    mean_hours: number | null;
    resolved_count: number;
  };
  technicians: TechnicianRow[];
  device_types_in_tickets: Array<Counted & { type: string }>;
  inventory: {
    by_status: Record<string, number>;
    by_type: Array<Counted & { type: string }>;
    total: number;
  };
}

/** Fresh identifiers per run, so a re-run against an un-reset database still passes. */
const RUN_TAG = String(Math.floor(Math.random() * 9000) + 1000);
let sequence = 0;

async function insights(client: SupabaseClient, days?: number): Promise<Insights> {
  return rpcOk<Insights>(client, 'app_insights', days === undefined ? {} : { p_days: days });
}

/** Today's point in the series, which is always the last one. */
function today(report: Insights): SeriesPoint {
  const point = report.series[report.series.length - 1];
  expect(point.date).toBe(schoolToday());
  return point;
}

function categoryCount(report: Insights, category: string): number {
  return report.by_category.find((row) => row.category === category)?.count ?? 0;
}

function typeCount(rows: Array<Counted & { type: string }>, type: string): number {
  return rows.find((row) => row.type === type)?.count ?? 0;
}

function technician(report: Insights, accountId: string): TechnicianRow {
  const row = report.technicians.find((entry) => entry.account_id === accountId);
  if (!row) throw new Error(`No technician row for ${accountId}`);
  return row;
}

/** A ticket created by the administrator, so channel, category and priority are all settable. */
async function createTicket(
  options: { category?: string; priority?: string; title?: string } = {},
): Promise<string> {
  sequence += 1;
  return rpcOk<string>(admin, 'app_create_ticket', {
    p_title: options.title ?? `Insights probe ${RUN_TAG}-${sequence}`,
    p_issue: 'Synthetic request used to prove an aggregate moves.',
    p_channel: 'phone_call',
    p_priority: options.priority ?? 'normal',
    p_requester_name: 'Ms. Calloway',
    p_location: 'Room 212',
    p_category: options.category ?? 'other',
  });
}

beforeAll(async () => {
  [admin, owner, unrelated, pending, denied] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('unrelated'),
    signIn('pending'),
    signIn('denied'),
  ]);
});

describe('who may ask', () => {
  it('answers any active account, technician or administrator', async () => {
    const asTechnician = await insights(owner);
    const asAdmin = await insights(admin);

    // The same team-wide numbers either way: this is not a filtered view.
    expect(asTechnician.days).toBe(30);
    expect(asAdmin.days).toBe(30);
    expect(asTechnician.inventory.total).toBe(asAdmin.inventory.total);
    expect(asTechnician.open_by_status).toEqual(asAdmin.open_by_status);
  });

  it('refuses an account awaiting setup and one whose request was denied', async () => {
    const notSetUp = await rpcFails(pending, 'app_insights', { p_days: 30 });
    expect(notSetUp.code).toBe(REFUSED);
    expect(notSetUp.message).toMatch(/cannot access helpdesk records/i);

    const refused = await rpcFails(denied, 'app_insights', { p_days: 30 });
    expect(refused.code).toBe(REFUSED);
    expect(refused.message).toMatch(/cannot access helpdesk records/i);
  });

  it('is closed to an anonymous caller', async () => {
    const failure = await rpcFails(anonClient(), 'app_insights', { p_days: 30 });
    expect(failure.message).toMatch(/permission denied|function|schema cache/i);
  });
});

describe('the window', () => {
  it('covers the last thirty school-local days by default, today last', async () => {
    const report = await insights(owner);

    expect(report.days).toBe(30);
    expect(report.series).toHaveLength(30);
    expect(report.series[report.series.length - 1].date).toBe(schoolToday());

    // One row per day, in order, with no gaps: a day nothing happened on is a
    // zero rather than a missing point, so a chart does not have to invent one.
    const dates = report.series.map((point) => point.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(30);
    for (const point of report.series) {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(point.opened)).toBe(true);
      expect(Number.isInteger(point.resolved)).toBe(true);
      expect(point.opened).toBeGreaterThanOrEqual(0);
      expect(point.resolved).toBeGreaterThanOrEqual(0);
    }
  });

  it('clamps a nonsense window rather than refusing it', async () => {
    const none = await insights(owner, 0);
    expect(none.days).toBe(1);
    expect(none.series).toHaveLength(1);
    expect(none.series[0].date).toBe(schoolToday());

    const negative = await insights(owner, -5);
    expect(negative.days).toBe(1);

    const forever = await insights(owner, 1000);
    expect(forever.days).toBe(365);
    expect(forever.series).toHaveLength(365);

    const asked = await insights(owner, 7);
    expect(asked.days).toBe(7);
    expect(asked.series).toHaveLength(7);
  });
});

describe('what came in and what went out', () => {
  it('counts todays new requests and todays resolutions', async () => {
    const before = await insights(owner);
    const openedBefore = today(before).opened;
    const resolvedBefore = today(before).resolved;
    const countBefore = before.resolution.resolved_count;

    const first = await createTicket();
    await createTicket();
    await createTicket();

    await rpcOk(owner, 'app_claim_ticket', { p_ticket: first });
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: first,
      p_solution: 'Reseated the display cable.',
    });

    const after = await insights(owner);
    expect(today(after).opened).toBe(openedBefore + 3);
    expect(today(after).resolved).toBe(resolvedBefore + 1);
    expect(after.resolution.resolved_count).toBe(countBefore + 1);

    // A resolution that happened moments ago is a small number of hours, not a
    // null and not a negative.
    expect(after.resolution.median_hours).not.toBeNull();
    expect(after.resolution.mean_hours).not.toBeNull();
    expect(Number(after.resolution.median_hours)).toBeGreaterThanOrEqual(0);
    expect(Number(after.resolution.mean_hours)).toBeGreaterThanOrEqual(0);
  });

  it('reports the four active statuses and the four priorities, always all of them', async () => {
    const report = await insights(owner);

    expect(Object.keys(report.open_by_status).sort()).toEqual(ACTIVE_STATUSES);
    expect(Object.keys(report.open_by_priority).sort()).toEqual(PRIORITIES);
    for (const value of Object.values(report.open_by_status)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('moves a ticket from open to assigned when somebody claims it', async () => {
    const before = await insights(owner);
    const ticket = await createTicket({ priority: 'urgent' });

    const queued = await insights(owner);
    expect(queued.open_by_status.open).toBe(before.open_by_status.open + 1);
    expect(queued.open_by_status.assigned).toBe(before.open_by_status.assigned);
    expect(queued.open_by_priority.urgent).toBe(before.open_by_priority.urgent + 1);

    await rpcOk(owner, 'app_claim_ticket', { p_ticket: ticket });

    const claimed = await insights(owner);
    expect(claimed.open_by_status.open).toBe(before.open_by_status.open);
    expect(claimed.open_by_status.assigned).toBe(before.open_by_status.assigned + 1);
    // Still urgent, still counted: priority is about the live queue, not the status.
    expect(claimed.open_by_priority.urgent).toBe(before.open_by_priority.urgent + 1);
  });

  it('counts open tickets by category, and drops one out again when it is resolved', async () => {
    const before = await insights(owner);
    const printersBefore = categoryCount(before, 'printer');

    await createTicket({ category: 'printer' });
    const second = await createTicket({ category: 'printer' });

    const opened = await insights(owner);
    expect(categoryCount(opened, 'printer')).toBe(printersBefore + 2);

    await rpcOk(owner, 'app_claim_ticket', { p_ticket: second });
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: second,
      p_solution: 'Cleared the print spooler.',
    });

    const resolved = await insights(owner);
    expect(categoryCount(resolved, 'printer')).toBe(printersBefore + 1);
  });
});

describe('the team', () => {
  it('lists every active account with a name, and nobody who cannot work', async () => {
    const report = await insights(owner);

    const ids = report.technicians.map((row) => row.account_id);
    expect(ids).toContain(identity('owner').id);
    expect(ids).toContain(identity('admin').id);
    expect(ids).toContain(identity('unrelated').id);
    // Restricted accounts are not part of the team's numbers.
    expect(ids).not.toContain(identity('pending').id);
    expect(ids).not.toContain(identity('denied').id);

    expect(technician(report, identity('owner').id).name).toBe(identity('owner').displayName);
  });

  it('follows one technician through claiming, logging work and resolving', async () => {
    const account = identity('unrelated').id;
    const before = technician(await insights(owner), account);

    const ticket = await createTicket();
    await rpcOk(unrelated, 'app_claim_ticket', { p_ticket: ticket });

    const claimed = technician(await insights(owner), account);
    expect(claimed.open).toBe(before.open + 1);
    expect(claimed.resolved).toBe(before.resolved);

    await rpcOk(unrelated, 'app_log_work', {
      p_ticket: ticket,
      p_minutes: 45,
      p_work_date: null,
      p_description: 'Swapped the projector lamp.',
    });

    const worked = technician(await insights(owner), account);
    expect(worked.minutes).toBe(before.minutes + 45);

    await rpcOk(unrelated, 'app_resolve_ticket', {
      p_ticket: ticket,
      p_solution: 'Swapped the projector lamp and tested it.',
    });

    const done = technician(await insights(owner), account);
    expect(done.resolved).toBe(before.resolved + 1);
    // No longer open, but the time logged against it stays counted.
    expect(done.open).toBe(before.open);
    expect(done.minutes).toBe(before.minutes + 45);
  });
});

describe('devices', () => {
  it('counts the kinds of machine technicians are recording on tickets', async () => {
    const kind = `Interactive panel ${RUN_TAG}`;
    const before = await insights(owner);
    expect(typeCount(before.device_types_in_tickets, kind)).toBe(0);

    const ticket = await createTicket();
    await rpcOk(owner, 'app_claim_ticket', { p_ticket: ticket });
    await rpcOk(owner, 'app_record_device', {
      p_ticket: ticket,
      p_device_type: kind,
      p_identifiers_not_applicable: true,
    });

    const after = await insights(owner);
    expect(typeCount(after.device_types_in_tickets, kind)).toBe(1);
    expect(after.device_types_in_tickets.length).toBeLessThanOrEqual(8);
  });

  it('summarises the inventory, with every status present even at zero', async () => {
    const before = await insights(owner);
    expect(Object.keys(before.inventory.by_status).sort()).toEqual(DEVICE_STATUSES);

    sequence += 1;
    const kind = `Visualiser ${RUN_TAG}`;
    await rpcOk(owner, 'app_upsert_device', {
      p_device: {
        serial_number: `IN${RUN_TAG}${String(sequence).padStart(4, '0')}`,
        type: kind,
        model: 'ThinkPad L13',
      },
    });

    const after = await insights(owner);
    expect(after.inventory.total).toBe(before.inventory.total + 1);
    expect(after.inventory.by_status.in_stock).toBe(before.inventory.by_status.in_stock + 1);
    expect(typeCount(after.inventory.by_type, kind)).toBe(1);
    expect(after.inventory.by_type.length).toBeLessThanOrEqual(10);
  });
});
