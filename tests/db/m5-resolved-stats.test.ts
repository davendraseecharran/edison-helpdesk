/**
 * Who resolved what, and who may ask.
 *
 * `20260916100100_m5_resolved_stats.sql` adds one administrator-only read over
 * `tickets` and `activity_events`. Four things about it are load-bearing:
 *
 * 1. IT IS ADMINISTRATOR ONLY, AND IT SAYS SO. A NetRider is refused out loud
 *    rather than handed an empty table, because an empty table is a claim about
 *    the desk and a refusal is a claim about the reader.
 * 2. THE RESOLVER IS THE PERSON ON THE TICKET. Not the owner, not the creator:
 *    `resolved_by`, which is the column the lifecycle keeps separate precisely
 *    so a collaborator's close is attributed to them.
 * 3. THE PERIOD IS A FILTER, NOT A LABEL. Work outside the window is not
 *    counted, or the four buttons on the screen are decoration.
 * 4. THE TOTALS ROW IS THE PERIOD'S OWN, and it is last. A footer that summed
 *    the rows above it would be right about counts and wrong about medians,
 *    which is the number nobody can check by eye.
 *
 * Exercised through real signed-in sessions: the actor is derived inside the
 * function body, so a test that called it any other way would prove nothing
 * about the application.
 *
 * Every assertion is scoped to a window that opens when this file starts, so
 * tickets other files resolved against the same database cannot move a number
 * here.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  anonClient,
  identity,
  openTicket,
  ownedTicket,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

interface StatsRow {
  resolver_id: string | null;
  resolver_name: string | null;
  resolved_count: number;
  by_priority: Record<string, number>;
  by_category: Record<string, number>;
  median_hours: number | string | null;
  mean_hours: number | string | null;
  reopened_count: number;
}

let admin: SupabaseClient;
let owner: SupabaseClient;
let collaborator: SupabaseClient;

/** The window this file's own work falls inside. */
let opened: string;

async function stats(
  client: SupabaseClient,
  since: string | null,
  until: string | null = null,
): Promise<StatsRow[]> {
  return rpcOk<StatsRow[]>(client, 'app_resolved_stats', { p_since: since, p_until: until });
}

function rowFor(rows: StatsRow[], accountId: string): StatsRow | undefined {
  return rows.find((row) => row.resolver_id === accountId);
}

function totalsOf(rows: StatsRow[]): StatsRow {
  const totals = rows.find((row) => row.resolver_id === null);
  if (!totals) throw new Error('The totals row is missing.');
  return totals;
}

/** A moment strictly after everything that has happened so far. */
function now(): string {
  return new Date().toISOString();
}

beforeAll(async () => {
  admin = await signIn('admin');
  owner = await signIn('owner');
  collaborator = await signIn('collaborator');
  opened = now();
});

describe('app_resolved_stats', () => {
  it('refuses a NetRider out loud rather than answering with an empty desk', async () => {
    const refused = await rpcFails(owner, 'app_resolved_stats', {
      p_since: opened,
      p_until: null,
    });
    expect(refused.message).toContain('Only an administrator');
    expect(refused.code).toBe('42501');
  });

  it('is closed to a session that is not signed in', async () => {
    const refused = await rpcFails(anonClient(), 'app_resolved_stats', {
      p_since: null,
      p_until: null,
    });
    expect(refused.message).not.toBe('');
  });

  it('counts a resolver’s tickets and splits them by priority', async () => {
    const since = now();
    const high = await ownedTicket({ priority: 'high', title: 'Projector dark in 118' });
    const low = await ownedTicket({ priority: 'low', title: 'Spare mouse for the lab' });

    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: high.ticketId,
      p_solution: 'Reseated the podium HDMI cable.',
    });
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: low.ticketId,
      p_solution: 'Took a mouse from the spares drawer.',
    });

    const rows = await stats(admin, since);
    const mine = rowFor(rows, identity('owner').id);

    expect(mine?.resolver_name).toBe(identity('owner').displayName);
    expect(mine?.resolved_count).toBe(2);
    expect(mine?.by_priority).toEqual({ urgent: 0, high: 1, normal: 0, low: 1 });
    // Both tickets are created with the harness's default category, so the
    // breakdown holds exactly one key and it accounts for both.
    expect(Object.values(mine?.by_category ?? {}).reduce((sum, n) => sum + n, 0)).toBe(2);
    expect(mine?.reopened_count).toBe(0);

    // Resolved seconds after they were created, so the span is real and small.
    expect(Number(mine?.median_hours)).toBeGreaterThanOrEqual(0);
    expect(Number(mine?.median_hours)).toBeLessThan(1);
    expect(Number(mine?.mean_hours)).toBeLessThan(1);
  });

  it('excludes work that falls outside the period', async () => {
    const before = now();
    const { ticketId } = await ownedTicket({ title: 'Cart 4 will not charge' });
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Replaced the cart power brick.',
    });
    const after = now();

    const inside = await stats(admin, before, after);
    expect(rowFor(inside, identity('owner').id)?.resolved_count).toBeGreaterThanOrEqual(1);

    // The same call with a window that closes before the work happened.
    const outside = await stats(admin, before, before);
    expect(rowFor(outside, identity('owner').id)).toBeUndefined();
    expect(totalsOf(outside).resolved_count).toBe(0);
    expect(totalsOf(outside).median_hours).toBeNull();
  });

  it('credits the collaborator who wrote the solution, not the owner', async () => {
    const since = now();
    const { ticketId } = await ownedTicket({ title: 'Staff laptop will not join the domain' });
    await rpcOk(owner, 'app_add_collaborator', {
      p_ticket: ticketId,
      p_account: identity('collaborator').id,
    });
    await rpcOk(collaborator, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Rejoined the machine to the domain and reset the trust.',
    });

    const rows = await stats(admin, since);
    expect(rowFor(rows, identity('collaborator').id)?.resolved_count).toBe(1);
    expect(rowFor(rows, identity('owner').id)).toBeUndefined();
  });

  it('never counts a cancellation as a resolution', async () => {
    const since = now();
    const ticketId = await openTicket({ title: 'Duplicate of the projector report' });
    await rpcOk(admin, 'app_cancel_ticket', {
      p_ticket: ticketId,
      p_reason: 'Already reported on another ticket.',
    });

    const rows = await stats(admin, since);
    expect(totalsOf(rows).resolved_count).toBe(0);
  });

  it('remembers a resolution the reopen took off the ticket', async () => {
    const since = now();
    const { ticketId } = await ownedTicket({ title: 'Printer jams on every second page' });
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Cleared the jam and replaced the pickup roller.',
    });
    await rpcOk(admin, 'app_reopen_ticket', {
      p_ticket: ticketId,
      p_reason: 'It jammed again the next morning.',
    });

    // The ticket row no longer names a resolver at all, so the count is zero —
    // and the history still says the hour was worked.
    const rows = await stats(admin, since);
    const mine = rowFor(rows, identity('owner').id);
    expect(mine?.resolved_count).toBe(0);
    expect(mine?.reopened_count).toBe(1);
    expect(totalsOf(rows).resolved_count).toBe(0);
    expect(totalsOf(rows).reopened_count).toBe(1);
  });

  it('puts the desk’s own row last, with no id and the period’s own median', async () => {
    const since = now();
    const { ticketId } = await ownedTicket({
      priority: 'high',
      title: 'Smartboard will not calibrate',
    });
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Recalibrated the board against the projector.',
    });

    const rows = await stats(admin, since);
    expect(rows[rows.length - 1].resolver_id).toBeNull();
    expect(rows[rows.length - 1].resolver_name).toBeNull();
    expect(rows.filter((row) => row.resolver_id === null)).toHaveLength(1);

    const totals = totalsOf(rows);
    expect(totals.resolved_count).toBe(1);
    expect(totals.by_priority).toEqual({ urgent: 0, high: 1, normal: 0, low: 0 });
    expect(Number(totals.median_hours)).toBeLessThan(1);
  });

  it('reads an open far end as now and an open near end as the cap', async () => {
    const rows = await stats(admin, null, null);
    // Everything this file resolved is inside five years of now.
    expect(totalsOf(rows).resolved_count).toBeGreaterThanOrEqual(1);
  });

  it('refuses a period that ends before it begins', async () => {
    const refused = await rpcFails(admin, 'app_resolved_stats', {
      p_since: now(),
      p_until: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(refused.message).toContain('ends before it begins');
  });
});
