/**
 * When a ticket was opened, when it was written down, and a ticket that
 * arrives already finished.
 *
 * `20260923120000_m5_ticket_opened_at.sql` lets intake say when a request was
 * opened (created_at) and keeps when it was actually logged (logged_at), and
 * lets a ticket be created resolved in one call. `20260923120100_m5_import_
 * sheet.sql` moves the sheet import's rules into one function behind two
 * doors, and adds the batch door the Resolved page uses.
 *
 * What is pinned: the bounds (never the future, never before 2020, within a
 * minute of now IS now), that the NetRider rules survive (a walk-in they own;
 * the date-only backdate still theirs to be refused), that the history says a
 * ticket was logged later and in which order things happened, that logged_at
 * is as frozen as created_at, and that the batch answers every row — made,
 * skipped or refused — without one refusal losing the rest.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  identity,
  rawEvents,
  rawTicket,
  rpcFails,
  rpcOk,
  schoolDateOffset,
  signIn,
} from './support/harness';

let netrider: SupabaseClient;
let admin: SupabaseClient;
let officer: SupabaseClient;

beforeAll(async () => {
  [netrider, admin, officer] = await Promise.all([
    signIn('owner'),
    signIn('admin'),
    signIn('skillsOfficer'),
  ]);
});

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function at(value: unknown): number {
  return Date.parse(String(value));
}

function schoolDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function walkIn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    p_title: 'Chromebook will not charge',
    p_issue: 'Brought to the desk before first period.',
    p_channel: 'walk_in',
    p_requester_unknown: true,
    ...overrides,
  };
}

describe('app_create_ticket: the opened time', () => {
  it('opens now and logs nothing extra when no time is given', async () => {
    const id = await rpcOk<string>(netrider, 'app_create_ticket', walkIn());
    const ticket = await rawTicket(id);

    expect(ticket.logged_at).toBeNull();
    expect(Math.abs(at(ticket.created_at) - Date.now())).toBeLessThan(60_000);
    const created = (await rawEvents(id)).find((event) => event.kind === 'created');
    expect(created?.detail ?? null).toBeNull();
  });

  it('lets a NetRider log a walk-in that happened earlier, owned by themselves', async () => {
    const opened = hoursAgo(72);
    const id = await rpcOk<string>(netrider, 'app_create_ticket', walkIn({ p_opened_at: opened }));
    const ticket = await rawTicket(id);

    expect(at(ticket.created_at)).toBe(at(opened));
    expect(ticket.submitted_on).toBe(schoolDateOf(opened));
    expect(at(ticket.logged_at)).toBeGreaterThan(at(opened));
    expect(ticket.status).toBe('assigned');
    expect(ticket.owner_id).toBe(identity('owner').id);
    expect(ticket.channel).toBe('walk_in');
    // Taken on at the desk when it happened, not when it was typed.
    expect(at(ticket.assigned_at)).toBe(at(opened));

    const events = await rawEvents(id);
    const created = events.find((event) => event.kind === 'created');
    expect(at(created?.at)).toBe(at(opened));
    expect(String(created?.detail)).toMatch(/^Logged on \w{3} \d{1,2} for \w{3} \d{1,2} at \d{1,2}:\d{2} [AP]M\.$/);
  });

  it('says "logged at" with two times when it was logged later the same day', async () => {
    // Two minutes ago is still today in New York for all but two minutes a
    // day; either sentence names both moments, which is what matters.
    const opened = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const id = await rpcOk<string>(netrider, 'app_create_ticket', walkIn({ p_opened_at: opened }));
    const created = (await rawEvents(id)).find((event) => event.kind === 'created');
    expect(String(created?.detail)).toMatch(/^Logged (at \d{1,2}:\d{2} [AP]M for|on )/);
  });

  it('treats a time within a minute of now as now, whichever side of it', async () => {
    for (const offset of [-30_000, 30_000]) {
      const id = await rpcOk<string>(
        netrider,
        'app_create_ticket',
        walkIn({ p_opened_at: new Date(Date.now() + offset).toISOString() }),
      );
      expect((await rawTicket(id)).logged_at).toBeNull();
    }
  });

  it('refuses a future time and anything before 2020', async () => {
    const future = await rpcFails(
      netrider,
      'app_create_ticket',
      walkIn({ p_opened_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    );
    expect(future.message).toBe('The opened time cannot be in the future.');

    const ancient = await rpcFails(
      admin,
      'app_create_ticket',
      walkIn({ p_channel: 'phone_call', p_opened_at: '2019-12-31T12:00:00Z' }),
    );
    expect(ancient.message).toBe('The opened time cannot be before 2020.');

    // The first moment of 2020 in New York is inside the line.
    const first = await rpcOk<string>(
      admin,
      'app_create_ticket',
      walkIn({ p_channel: 'phone_call', p_opened_at: '2020-01-01T05:00:00Z' }),
    );
    expect((await rawTicket(first)).submitted_on).toBe('2020-01-01');
  });

  it('refuses the opened time and the old submission date together', async () => {
    const both = await rpcFails(
      admin,
      'app_create_ticket',
      walkIn({ p_channel: 'phone_call', p_opened_at: hoursAgo(30), p_submitted_on: schoolDateOffset(-1) }),
    );
    expect(both.message).toContain('not both');
  });

  it('keeps every NetRider rule: walk-in, their own, and no date-only backdate', async () => {
    const opened = hoursAgo(48);
    const phone = await rpcFails(
      netrider,
      'app_create_ticket',
      walkIn({ p_channel: 'phone_call', p_opened_at: opened }),
    );
    expect(phone.message).toContain('walk-in');

    const someoneElse = await rpcFails(
      netrider,
      'app_create_ticket',
      walkIn({ p_owner_id: identity('collaborator').id, p_opened_at: opened }),
    );
    expect(someoneElse.message).toContain('to themselves');

    const dateOnly = await rpcFails(
      netrider,
      'app_create_ticket',
      walkIn({ p_submitted_on: schoolDateOffset(-2) }),
    );
    expect(dateOnly.message).toMatch(/cannot backdate/i);
  });

  it('lets an administrator log an earlier phone call to the queue', async () => {
    const opened = hoursAgo(26);
    const id = await rpcOk<string>(
      admin,
      'app_create_ticket',
      walkIn({ p_channel: 'phone_call', p_opened_at: opened }),
    );
    const ticket = await rawTicket(id);
    expect(ticket.status).toBe('open');
    expect(ticket.owner_id).toBeNull();
    expect(at(ticket.created_at)).toBe(at(opened));
    expect(ticket.logged_at).not.toBeNull();
  });

  it('shows the logged moment on the detail read, and freezes it', async () => {
    const id = await rpcOk<string>(netrider, 'app_create_ticket', walkIn({ p_opened_at: hoursAgo(5) }));
    const detail = await rpcOk<{ ticket: Record<string, unknown> }>(netrider, 'app_ticket_detail', {
      p_ticket: id,
    });
    expect(detail.ticket.logged_at).not.toBeNull();

    const { error } = await adminServiceClient()
      .from('tickets')
      .update({ logged_at: new Date().toISOString() })
      .eq('id', id);
    expect(error?.message).toContain('cannot be changed');
  });
});

describe('app_create_ticket: already resolved', () => {
  it('creates a NetRider walk-in resolved in one go, in the order it happened', async () => {
    const opened = hoursAgo(50);
    const resolved = hoursAgo(49);
    const id = await rpcOk<string>(
      netrider,
      'app_create_ticket',
      walkIn({
        p_opened_at: opened,
        p_solution: 'Swapped the charger for a spare from the cart.',
        p_resolved_at: resolved,
      }),
    );
    const ticket = await rawTicket(id);

    expect(ticket.status).toBe('resolved');
    expect(ticket.solution).toBe('Swapped the charger for a spare from the cart.');
    expect(ticket.resolved_by).toBe(identity('owner').id);
    expect(ticket.owner_id).toBe(identity('owner').id);
    expect(at(ticket.resolved_at)).toBe(at(resolved));
    expect(at(ticket.created_at)).toBe(at(opened));

    const events = await rawEvents(id);
    // Created and taken on share the opened moment; the resolution is last.
    expect(events.map((event) => String(event.kind)).sort()).toEqual(['assigned', 'created', 'resolved']);
    const last = events[events.length - 1];
    expect(last.kind).toBe('resolved');
    expect(at(last.at)).toBe(at(resolved));
    expect(String(last.summary)).toContain('resolved the ticket at intake');
    expect(last.detail).toBe('Swapped the charger for a spare from the cart.');
  });

  it('resolves now when no resolved time is given', async () => {
    const id = await rpcOk<string>(
      netrider,
      'app_create_ticket',
      walkIn({ p_solution: 'Reseated the power cable.' }),
    );
    const ticket = await rawTicket(id);
    expect(ticket.status).toBe('resolved');
    expect(Math.abs(at(ticket.resolved_at) - Date.now())).toBeLessThan(60_000);
    expect(ticket.logged_at).toBeNull();
  });

  it('refuses a resolution out of order, in the future, too short, or without a solution', async () => {
    const opened = hoursAgo(10);
    const before = await rpcFails(
      netrider,
      'app_create_ticket',
      walkIn({ p_opened_at: opened, p_solution: 'Reseated the cable.', p_resolved_at: hoursAgo(11) }),
    );
    expect(before.message).toBe('A ticket cannot be resolved before it was opened.');

    const future = await rpcFails(
      netrider,
      'app_create_ticket',
      walkIn({
        p_opened_at: opened,
        p_solution: 'Reseated the cable.',
        p_resolved_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      }),
    );
    expect(future.message).toBe('The resolved time cannot be in the future.');

    const short = await rpcFails(netrider, 'app_create_ticket', walkIn({ p_solution: 'ok' }));
    expect(short.message).toContain('Describe the solution');

    const noSolution = await rpcFails(
      netrider,
      'app_create_ticket',
      walkIn({ p_resolved_at: hoursAgo(1) }),
    );
    expect(noSolution.message).toContain('Write what fixed it');
  });

  it('gives an administrator the ticket they resolve, and refuses naming somebody else', async () => {
    const queue = await rpcOk<string>(
      admin,
      'app_create_ticket',
      walkIn({ p_channel: 'email', p_solution: 'Reset the password with the requester.' }),
    );
    const ticket = await rawTicket(queue);
    expect(ticket.owner_id).toBe(identity('admin').id);
    expect(ticket.resolved_by).toBe(identity('admin').id);
    expect(ticket.channel).toBe('email');

    const other = await rpcFails(
      admin,
      'app_create_ticket',
      walkIn({
        p_channel: 'email',
        p_owner_id: identity('owner').id,
        p_solution: 'Reset the password with the requester.',
      }),
    );
    expect(other.message).toContain('belongs to whoever logs it');
  });

  it('still refuses a skills officer, who never reaches a ticket', async () => {
    const refused = await rpcFails(officer, 'app_create_ticket', walkIn({ p_solution: 'Reseated it.' }));
    expect(refused.message.length).toBeGreaterThan(0);
  });
});

interface BatchRow {
  row_index: number;
  outcome: 'made' | 'skipped' | 'refused';
  ticket_id: string | null;
  ticket_number: string | null;
  message: string | null;
}

function sheetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Smartboard pen stopped writing',
    issue: 'Room 204, period 2.',
    opened_at: hoursAgo(24 * 20),
    resolved_at: hoursAgo(24 * 19),
    ...overrides,
  };
}

describe('app_import_resolved_tickets', () => {
  it('answers every row: made, then skipped when the same rows come again', async () => {
    const stamp = Date.now();
    const rows = [
      sheetRow({ title: `Cart 2 charger missing ${stamp}` }),
      sheetRow({ title: `Printer jam in 118 ${stamp}`, solution: 'Cleared the jam and reseated the tray.' }),
    ];
    const first = await rpcOk<BatchRow[]>(netrider, 'app_import_resolved_tickets', { p_rows: rows });
    expect(first.map((row) => row.outcome)).toEqual(['made', 'made']);
    expect(first.map((row) => row.row_index)).toEqual([1, 2]);
    expect(first[0].ticket_number).toMatch(/^EDT-\d+$/);

    const again = await rpcOk<BatchRow[]>(netrider, 'app_import_resolved_tickets', { p_rows: rows });
    expect(again.map((row) => row.outcome)).toEqual(['skipped', 'skipped']);
    expect(again[1].ticket_id).toBe(first[1].ticket_id);

    const second = await rawTicket(String(first[1].ticket_id));
    expect(second.solution).toBe('Cleared the jam and reseated the tray.');
    expect(second.logged_at).not.toBeNull();
    const created = (await rawEvents(String(first[1].ticket_id))).find((event) => event.kind === 'created');
    expect(String(created?.detail)).toMatch(/^Logged on /);
  });

  it('refuses a bad row by itself and lands the rows around it', async () => {
    const stamp = Date.now();
    const answer = await rpcOk<BatchRow[]>(netrider, 'app_import_resolved_tickets', {
      p_rows: [
        sheetRow({ title: `Projector bulb ${stamp}` }),
        sheetRow({ title: `Backwards ${stamp}`, opened_at: hoursAgo(10), resolved_at: hoursAgo(20) }),
        sheetRow({ title: `From 2019 ${stamp}`, opened_at: '2019-06-01', resolved_at: '2019-06-02' }),
        sheetRow({ title: `Not a date ${stamp}`, opened_at: 'next tuesday' }),
        sheetRow({ title: `Colleague ${stamp}`, resolved_by: identity('collaborator').id }),
        sheetRow({ title: `Speaker cable ${stamp}` }),
      ],
    });
    expect(answer.map((row) => row.outcome)).toEqual([
      'made',
      'refused',
      'refused',
      'refused',
      'refused',
      'made',
    ]);
    expect(answer[1].message).toContain('resolved before it was called in');
    expect(answer[2].message).toContain('before 2020');
    expect(answer[3].message).toContain('could not read a date');
    expect(answer[4].message).toContain('Only an administrator');
    expect(answer[1].ticket_id).toBeNull();
  });

  it('keeps a one-word solution and the sheet’s own name for who fixed it', async () => {
    const stamp = Date.now();
    const [short, named] = await rpcOk<BatchRow[]>(admin, 'app_import_resolved_tickets', {
      p_rows: [
        sheetRow({ title: `One word ${stamp}`, solution: 'done' }),
        sheetRow({ title: `Named ${stamp}`, resolved_by_name: 'Sam Okafor' }),
      ],
    });
    expect((await rawTicket(String(short.ticket_id))).solution).toBe('The sheet says: done');

    const namedTicket = await rawTicket(String(named.ticket_id));
    expect(String(namedTicket.solution)).toContain('Sam Okafor resolved this on');
    const resolved = (await rawEvents(String(named.ticket_id))).find((event) => event.kind === 'resolved');
    expect(String(resolved?.detail)).toContain('The sheet names Sam Okafor as the technician.');
  });

  it('refuses a skills officer once, and a batch that is too long or empty', async () => {
    const officerRefused = await rpcFails(officer, 'app_import_resolved_tickets', { p_rows: [sheetRow()] });
    expect(officerRefused.message).toContain('Only a NetRider or an administrator');

    const tooMany = await rpcFails(netrider, 'app_import_resolved_tickets', {
      p_rows: Array.from({ length: 201 }, (_, index) => sheetRow({ title: `Row ${index}` })),
    });
    expect(tooMany.message).toContain('at most 200');

    const empty = await rpcFails(netrider, 'app_import_resolved_tickets', { p_rows: [] });
    expect(empty.message).toContain('no rows');
  });

  it('keeps the one-row door the assistant uses, with the new solution argument', async () => {
    const id = await rpcOk<string>(netrider, 'app_import_resolved_ticket', {
      p_title: `Assistant row ${Date.now()}`,
      p_issue: null,
      p_called_at: hoursAgo(24 * 3),
      p_resolved_at: hoursAgo(24 * 2),
      p_solution: 'Replaced the HDMI cable at the podium.',
    });
    expect((await rawTicket(id)).solution).toBe('Replaced the HDMI cable at the podium.');
  });
});
