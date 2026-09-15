/**
 * Today's briefing: the machines due back, and enough rows to choose from.
 *
 * `20260914150200_m5_today_devices.sql` does two things and this proves both.
 *
 * 1. THE SECTION CAPS. `app_today_briefing()` returned five unclaimed tickets;
 *    the screen ranks across every section, folds repeats of one problem into
 *    a single row, and then shows seven. Five in, seven wanted: Today read
 *    "26 things need you" over a single row. The database's job is to hand
 *    over enough to choose from.
 *
 * 2. DEVICES DUE BACK. Two machines nobody ever looks at: the one a graduate
 *    still holds, and the one that has been "In repair" since October. Read
 *    through a SECURITY DEFINER function because the owner's
 *    `inventory_devices` is revoked from `authenticated` outright, gated to a
 *    NetRider or an administrator in its own body, and EMPTY rather than
 *    refused for anybody else — Today is the landing page, and a landing page
 *    must not fail for the person who does not do inventory.
 *
 * Everything is exercised through real signed-in sessions, because the gate is
 * written inside the function body and a test that called it any other way
 * would prove nothing about the application.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  openTicket,
  rpcOk,
  seedInventoryDevice,
  seedRequester,
  signIn,
} from './support/harness';

interface Briefing {
  counts: {
    waiting: number;
    unassigned: number;
    mine: number;
    access_requests: number;
    devices_due: number;
  };
  unassigned: Array<{ id: string }>;
  devices_due: Array<{
    id: string;
    reason: string;
    holder_name: string | null;
    status: string;
    asset_tag: string | null;
    version: number;
  }>;
}

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

let netrider: SupabaseClient;
let officer: SupabaseClient;

/** The machines this file made, so an assertion never counts somebody else's. */
const mine = new Set<string>();

async function briefing(client: SupabaseClient): Promise<Briefing> {
  return rpcOk<Briefing>(client, 'app_today_briefing');
}

/** Only the rows this file seeded, in the order the function returned them. */
function ours(view: Briefing): Briefing['devices_due'] {
  return view.devices_due.filter((row) => mine.has(row.id));
}

async function seedDue(overrides: Record<string, unknown>): Promise<string> {
  const device = await seedInventoryDevice(overrides);
  mine.add(device.id);
  return device.id;
}

beforeAll(async () => {
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
});

describe('app_today_briefing section caps', () => {
  it('hands back at least seven unclaimed tickets when ten are open', async () => {
    // The screen's own limit is seven, and it folds repeats before it counts.
    // Five from the database was never enough to fill it.
    const opened: string[] = [];
    for (let at = 0; at < 10; at += 1) {
      opened.push(await openTicket({ title: `Cap check ${Date.now()}-${at}` }));
    }

    const view = await briefing(netrider);
    expect(view.counts.unassigned).toBeGreaterThanOrEqual(10);
    expect(view.unassigned.length).toBeGreaterThanOrEqual(7);
    // And the rows really are the open queue, not a repeated one.
    expect(new Set(view.unassigned.map((row) => row.id)).size).toBe(view.unassigned.length);
    expect(opened.length).toBe(10);
  });
});

describe('app_today_briefing devices due back', () => {
  it('lists a machine whose student holder has graduated', async () => {
    const graduate = await seedRequester('student', { student_status: 'graduated' });
    // Aged on purpose: the list is oldest first and capped at 20, so every row
    // this file wants to find again is seeded older than anything else here.
    const id = await seedDue({
      assigned_requester_id: graduate.id,
      status: 'Assigned',
      updated_at: daysAgo(500),
    });

    const row = ours(await briefing(netrider)).find((entry) => entry.id === id);
    expect(row).toBeDefined();
    expect(row?.reason).toBe('holder_left');
    expect(row?.holder_name).toBe(graduate.displayName);
  });

  it('lists a machine whose staff holder has been archived', async () => {
    const left = await seedRequester('staff', { archived_at: daysAgo(30) });
    const id = await seedDue({
      assigned_requester_id: left.id,
      status: 'Assigned',
      updated_at: daysAgo(499),
    });

    const row = ours(await briefing(netrider)).find((entry) => entry.id === id);
    expect(row?.reason).toBe('holder_left');
  });

  it('leaves a machine alone while its holder is still here', async () => {
    const here = await seedRequester('student', { student_status: 'current' });
    const id = await seedDue({
      assigned_requester_id: here.id,
      status: 'Assigned',
      updated_at: daysAgo(498),
    });

    expect(ours(await briefing(netrider)).some((entry) => entry.id === id)).toBe(false);
  });

  it('lists a machine that has been in repair for over a fortnight', async () => {
    const id = await seedDue({ status: 'In repair', updated_at: daysAgo(30) });

    const row = ours(await briefing(netrider)).find((entry) => entry.id === id);
    expect(row?.reason).toBe('in_repair');
    expect(row?.holder_name).toBeNull();
  });

  it('leaves a machine that went to the bench this week alone', async () => {
    const id = await seedDue({ status: 'In repair', updated_at: daysAgo(3) });

    expect(ours(await briefing(netrider)).some((entry) => entry.id === id)).toBe(false);
  });

  it('reads the status whatever case the district wrote it in', async () => {
    const id = await seedDue({ status: '  in_repair ', updated_at: daysAgo(40) });

    expect(ours(await briefing(netrider)).some((entry) => entry.id === id)).toBe(true);
  });

  it('puts the machine that has been out longest first', async () => {
    const older = await seedDue({ status: 'In repair', updated_at: daysAgo(400) });
    const newer = await seedDue({ status: 'In repair', updated_at: daysAgo(390) });

    const rows = ours(await briefing(netrider)).map((entry) => entry.id);
    expect(rows.indexOf(older)).toBeLessThan(rows.indexOf(newer));
  });

  it('carries what the row needs: the sticker and the version Return will send', async () => {
    const id = await seedDue({ status: 'In repair', updated_at: daysAgo(20) });

    const row = ours(await briefing(netrider)).find((entry) => entry.id === id);
    expect(row?.asset_tag).toMatch(/^DOE-/);
    expect(row?.version).toBe(1);
  });

  it('counts the whole set, and shows at most twenty', async () => {
    const view = await briefing(netrider);
    expect(view.devices_due.length).toBeLessThanOrEqual(20);
    expect(view.counts.devices_due).toBeGreaterThanOrEqual(view.devices_due.length);
  });

  it('shows an administrator the same machines', async () => {
    const admin = await signIn('admin');
    expect(ours(await briefing(admin)).length).toBeGreaterThan(0);
  });

  it('is empty for a skills officer, rather than an error on the landing page', async () => {
    const view = await briefing(officer);
    expect(view.devices_due).toEqual([]);
    expect(view.counts.devices_due).toBe(0);
  });

  it('takes a returned machine off the list', async () => {
    const graduate = await seedRequester('student', { student_status: 'graduated' });
    const id = await seedDue({
      assigned_requester_id: graduate.id,
      status: 'Assigned',
      updated_at: daysAgo(497),
    });
    expect(ours(await briefing(netrider)).some((entry) => entry.id === id)).toBe(true);

    await rpcOk(netrider, 'app_return_inventory_device', { p_device: id, p_status: 'Available' });

    expect(ours(await briefing(netrider)).some((entry) => entry.id === id)).toBe(false);
    const { data } = await adminServiceClient()
      .from('inventory_devices')
      .select('assigned_requester_id, status')
      .eq('id', id)
      .single();
    expect(data).toMatchObject({ assigned_requester_id: null, status: 'Available' });
  });
});
