/**
 * M5: what a ticket is about, whose it is, and which machines it touches.
 *
 * Three rules land here, and each one is not obvious from a column list.
 *
 *   1. `category` is a small fixed vocabulary on the ticket, not free text, so
 *      the queue filter is a real filter rather than a search over typing. An
 *      unknown value is refused by the database, not normalised to 'other':
 *      silently rewriting a category would hide a broken caller and file the
 *      ticket in the wrong queue.
 *
 *   2. The requester is somebody already in the district directory, or plainly
 *      nobody. `public.requesters` holds 3,448 students and 261 staff, each
 *      with a source identifier from the roster; a free-text name typed at the
 *      desk would make a row with no identifier beside all of them, and the
 *      database refuses it. So does remote intake: a room goes in `location`.
 *
 *   3. A ticket may link real inventory machines, and `ticket_devices` inherits
 *      the PARENT TICKET's visibility exactly, like every other child table. An
 *      account that cannot see the ticket cannot see which machines it names,
 *      and an account awaiting setup sees nothing at all. The inventory itself
 *      has row-level security with no policies, so the linked machines come
 *      back through app_ticket_devices, which asks app_can_view_ticket first.
 *
 * Everything is arranged through real signed-in sessions and read back with the
 * service role, so nothing here proves something about a privileged path the
 * application will never take.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  createTicketAs,
  eventKinds,
  freshSession,
  identity,
  rawEvents,
  rawTicket,
  rpcFails,
  rpcOk,
  seedInventoryDevice,
  seedRequester,
  signIn,
} from './support/harness';

/** insufficient_privilege, check_violation and no_data_found, as PostgREST reports them. */
const REFUSED = '42501';
const REJECTED = '23514';
const MISSING = 'P0002';

let service: SupabaseClient;
let admin: SupabaseClient;
let owner: SupabaseClient;
let collaborator: SupabaseClient;
let unrelated: SupabaseClient;
let pending: SupabaseClient;

/** One member of staff in the directory, named on most of the tickets below. */
let calloway: string;

/**
 * Fresh identifiers per run so the suite can be re-run against a database that
 * was not reset.
 */
const RUN_TAG = String(Math.floor(Math.random() * 9000) + 1000);
let sequence = 0;

function nextSerial(): string {
  sequence += 1;
  return `SN${RUN_TAG}L${String(sequence).padStart(4, '0')}`;
}

interface TicketListRow {
  id: string;
  number: string;
  category: string;
  device_count: number;
  total_count: number;
}

interface LinkedDevice {
  id: string;
  external_id: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  type: string;
  manufacturer: string | null;
  model: string | null;
  status: string;
  location: string | null;
  linked_at: string;
  linked_by: string;
}

interface TicketDetailPayload {
  ticket: Record<string, unknown>;
  linked_devices: LinkedDevice[];
  devices: unknown[];
  activity: Array<Record<string, unknown>>;
}

interface PersonPage {
  rows: Array<Record<string, unknown>>;
  total: number;
}

/** A machine in the district inventory, unique to this call. */
async function addDevice(device: Record<string, unknown> = {}): Promise<string> {
  const seeded = await seedInventoryDevice({
    serial_number: nextSerial(),
    device_type: 'Laptop',
    model: 'IdeaPad Flex',
    ...device,
  });
  return seeded.id;
}

/**
 * The tickets one machine is named on, as the device page reads them: a client
 * select on ticket_devices under app_can_view_ticket, joined to the tickets
 * the caller's own policy allows.
 */
async function ticketsForDevice(
  client: SupabaseClient,
  deviceId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await client
    .from('ticket_devices')
    .select('linked_at, tickets!inner(id, number, title, status)')
    .eq('device_id', deviceId);
  if (error) throw new Error(`Could not read the machine's tickets: ${error.message}`);
  // PostgREST types an embedded one-to-one as an array; either shape is
  // flattened so the test reads the tickets rather than the join rows.
  return (data ?? []).flatMap((row) => {
    const embedded = (row as { tickets: unknown }).tickets;
    return (Array.isArray(embedded) ? embedded : [embedded]) as Array<Record<string, unknown>>;
  });
}

async function detail(client: SupabaseClient, ticketId: string): Promise<TicketDetailPayload> {
  return rpcOk<TicketDetailPayload>(client, 'app_ticket_detail', { p_ticket: ticketId });
}

/** Ground truth straight from the table, bypassing every read path under test. */
async function rawLinks(ticketId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('ticket_devices')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('linked_at', { ascending: true });
  if (error) throw new Error(`Could not read ticket_devices: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

/** An admin-created ticket already owned by `owner`, the standard arrangement. */
async function ownedTicketWith(options: Record<string, unknown> = {}): Promise<string> {
  const ticketId = await rpcOk<string>(admin, 'app_create_ticket', {
    p_title: 'Projector will not display',
    p_issue: 'Reported during first period; podium laptop shows no signal.',
    p_channel: 'phone_call',
    p_requester_id: calloway,
    p_location: 'Room 212',
    ...options,
  });
  await rpcOk(owner, 'app_claim_ticket', { p_ticket: ticketId });
  return ticketId;
}

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, collaborator, unrelated, pending] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('collaborator'),
    signIn('unrelated'),
    signIn('pending'),
  ]);
  // Deliberately NOT carrying RUN_TAG: one test searches the queue for
  // RUN_TAG, and the lookup matches a requester's name as well as a title.
  calloway = (await seedRequester('staff', { display_name: 'Ms. Calloway' })).id;
});

describe('ticket category', () => {
  it('defaults to other and accepts the fixed vocabulary', async () => {
    const plain = await createTicketAs('admin', { channel: 'phone_call' });
    expect((await rawTicket(plain)).category).toBe('other');

    const network = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: 'Wi-Fi drops in the library',
      p_issue: 'Devices lose the network every few minutes near the stacks.',
      p_channel: 'phone_call',
      p_requester_id: calloway,
      p_category: 'network',
    });
    expect((await rawTicket(network)).category).toBe('network');
  });

  it('refuses a category outside the vocabulary rather than filing it as other', async () => {
    const failure = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Something odd',
      p_issue: 'A description long enough to pass validation.',
      p_channel: 'phone_call',
      p_requester_id: calloway,
      p_category: 'smartboard',
    });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/category/i);
  });

  it('filters the queue by category over the same RLS-limited rows', async () => {
    const printer = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: `Printer jam ${RUN_TAG}`,
      p_issue: 'The third-floor printer jams on every duplex job.',
      p_channel: 'phone_call',
      p_requester_id: calloway,
      p_category: 'printer',
    });
    const account = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: `Password reset ${RUN_TAG}`,
      p_issue: 'Cannot sign in after the summer break.',
      p_channel: 'phone_call',
      p_requester_id: calloway,
      p_category: 'account',
    });

    const printers = await rpcOk<TicketListRow[]>(admin, 'app_list_tickets', {
      p_scope: 'open_queue',
      p_category: 'printer',
      p_limit: 100,
    });
    const ids = printers.map((row) => row.id);
    expect(ids).toContain(printer);
    expect(ids).not.toContain(account);
    expect(printers.every((row) => row.category === 'printer')).toBe(true);

    // No category filter still returns both.
    const everything = await rpcOk<TicketListRow[]>(admin, 'app_list_tickets', {
      p_scope: 'open_queue',
      p_query: RUN_TAG,
      p_limit: 100,
    });
    expect(everything.map((row) => row.id).sort()).toEqual([printer, account].sort());
  });

  it('lets a contributor change the category and records what changed', async () => {
    const ticketId = await ownedTicketWith();
    await rpcOk(owner, 'app_set_category', { p_ticket: ticketId, p_category: 'projector_display' });
    expect((await rawTicket(ticketId)).category).toBe('projector_display');

    const events = await rawEvents(ticketId);
    const change = events.find((event) => event.kind === 'category_changed');
    expect(change).toBeTruthy();
    expect(String(change?.summary)).toMatch(/other/i);
    expect(String(change?.summary)).toMatch(/projector/i);
    expect(change?.performed_via).toBe('user');
    expect(change?.actor_id).toBe(identity('owner').id);
  });

  it('refuses a category change to a value outside the vocabulary', async () => {
    const ticketId = await ownedTicketWith();
    for (const value of ['smartboard', '', 'OTHER', 'Chromebook']) {
      const failure = await rpcFails(owner, 'app_set_category', {
        p_ticket: ticketId,
        p_category: value,
      });
      expect(failure.code, `p_category ${JSON.stringify(value)}`).toBe(REJECTED);
      expect(failure.message).toMatch(/choose a category/i);
    }
    expect((await rawTicket(ticketId)).category).toBe('other');
  });

  it('refuses a category change from an unrelated account and on a closed ticket', async () => {
    const ticketId = await ownedTicketWith();
    const stranger = await rpcFails(unrelated, 'app_set_category', {
      p_ticket: ticketId,
      p_category: 'printer',
    });
    expect(stranger.code).toBe(REFUSED);

    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Replaced the display cable and confirmed the picture.',
    });
    const closed = await rpcFails(owner, 'app_set_category', {
      p_ticket: ticketId,
      p_category: 'printer',
    });
    expect(closed.code).toBe(REFUSED);
    expect(closed.message).toMatch(/closed/i);
    expect((await rawTicket(ticketId)).category).toBe('other');
  });
});

describe('the requester is somebody in the district directory', () => {
  it('names an existing staff or student row, and reuses it for their next ticket', async () => {
    const student = await seedRequester('student', {
      display_name: `Amara Whitfield ${RUN_TAG}`,
      official_class: '9A',
    });

    const first = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: 'Chromebook will not charge',
      p_issue: 'The charging light never comes on.',
      p_channel: 'walk_in',
      p_category: 'chromebook',
      p_requester_id: student.id,
    });
    expect((await rawTicket(first)).requester_id).toBe(student.id);
    expect((await rawTicket(first)).requester_unknown).toBe(false);

    const second = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: 'Chromebook screen cracked',
      p_issue: 'Dropped in the hallway between periods.',
      p_channel: 'walk_in',
      p_requester_id: student.id,
    });
    expect((await rawTicket(second)).requester_id).toBe(student.id);

    // One row, not two: the directory already had them, so intake never makes
    // a second copy of a person.
    const { data } = await service
      .from('requesters')
      .select('id')
      .eq('display_name', `Amara Whitfield ${RUN_TAG}`);
    expect(data ?? []).toHaveLength(1);
  });

  it('records the same person from six desks at once without a duplicate or an index name', async () => {
    // Several people recording a walk-in for the same student at the same
    // moment is a Monday morning at the help desk, not an exotic scenario.
    // Six genuinely separate connections per attempt, so the intakes race
    // inside the database rather than being serialised by one client.
    const sessions = await Promise.all([
      freshSession('admin'),
      freshSession('owner'),
      freshSession('collaborator'),
      freshSession('unrelated'),
      freshSession('owner'),
      freshSession('collaborator'),
    ]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const student = await seedRequester('student', {
        display_name: `Ines Marchetti ${RUN_TAG}-${attempt}`,
        official_class: '10B',
      });

      const results = await Promise.all(
        sessions.map((client, index) =>
          client.rpc('app_create_ticket', {
            p_title: `Simultaneous intake ${attempt}-${index}`,
            p_issue: 'Recorded at the desk at the same moment as the others.',
            p_channel: 'walk_in',
            p_requester_id: student.id,
          }),
        ),
      );

      for (const result of results) {
        // Whatever else goes wrong here, an index name must never be the message.
        expect(String(result.error?.message ?? ''), `attempt ${attempt}`).not.toMatch(
          /_idx|duplicate key/i,
        );
        expect(result.error, `attempt ${attempt}`).toBeNull();
      }

      const tickets = await Promise.all(results.map((result) => rawTicket(result.data as string)));
      for (const ticket of tickets) {
        expect(ticket.requester_id, `attempt ${attempt}`).toBe(student.id);
      }
    }
  });

  it('refuses a requester who is not in the directory, and one who is not a person', async () => {
    const ghost = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Ghost request',
      p_issue: 'A description long enough to pass validation.',
      p_channel: 'phone_call',
      p_requester_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(ghost.code).toBe(REJECTED);
    expect(ghost.message).toMatch(/existing requester|Requester Unknown/i);

    // requesters also holds 'role' and 'unknown' rows, which are the walk-in
    // shorthand tickets used to be recorded against. They are not people, and
    // intake will not name one.
    const { data } = await service
      .from('requesters')
      .insert({
        display_name: `Front desk ${RUN_TAG}`,
        kind: 'role',
        created_by: identity('admin').id,
      })
      .select('id')
      .single();
    const desk = (data as { id: string }).id;
    const notAPerson = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Role request',
      p_issue: 'A description long enough to pass validation.',
      p_channel: 'phone_call',
      p_requester_id: desk,
    });
    expect(notAPerson.code).toBe(REJECTED);
  });

  it('refuses a free-text requester name and remote intake, and writes no row for either', async () => {
    const displayName = `Inline requester ${RUN_TAG}`;
    const inline = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Inline requester attempt',
      p_issue: 'A description long enough to pass validation.',
      p_channel: 'phone_call',
      p_requester_name: displayName,
    });
    expect(inline.code).toBe(REJECTED);
    expect(inline.message).toMatch(/existing requester|Requester Unknown/i);
    const { count } = await service
      .from('requesters')
      .select('id', { count: 'exact', head: true })
      .eq('display_name', displayName);
    expect(count).toBe(0);

    const remote = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Remote intake attempt',
      p_issue: 'A description long enough to pass validation.',
      p_channel: 'phone_call',
      p_requester_unknown: true,
      p_is_remote: true,
    });
    expect(remote.code).toBe(REJECTED);
    expect(remote.message).toMatch(/location field/i);
  });

  it('counts the machines a person holds in the directory listing, and shows their tickets', async () => {
    const staff = await seedRequester('staff', {
      display_name: `Rowan Bex ${RUN_TAG}`,
      department: 'Science',
    });
    const deviceId = await addDevice();
    await rpcOk(owner, 'app_assign_inventory_device', {
      p_device: deviceId,
      p_requester: staff.id,
    });

    const ticketId = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: `Laptop runs hot ${RUN_TAG}`,
      p_issue: 'The fan runs constantly during lessons.',
      p_channel: 'email',
      p_requester_id: staff.id,
    });
    // Claimed, so it leaves the Open Queue every NetRider may read and the
    // visibility assertion below is about the ticket policy rather than about
    // an unassigned ticket being public to the team.
    await rpcOk(owner, 'app_claim_ticket', { p_ticket: ticketId });

    const page = await rpcOk<PersonPage>(admin, 'app_list_people', {
      p_kind: 'staff',
      p_query: `Rowan Bex ${RUN_TAG}`,
      p_page: 1,
    });
    const row = page.rows.find((entry) => entry.id === staff.id);
    expect(row?.deviceCount).toBe(1);
    expect(row?.department).toBe('Science');

    // The machines they hold, from the person page's own read.
    const held = await rpcOk<Array<Record<string, unknown>>>(admin, 'app_requester_devices', {
      p_requester: staff.id,
    });
    expect(held.map((entry) => entry.id)).toEqual([deviceId]);

    // Their tickets are read from public.tickets under the caller's own
    // policy, which is what keeps a NetRider from learning that a ticket they
    // may not read exists.
    const { data: mine } = await admin
      .from('tickets')
      .select('id')
      .eq('requester_id', staff.id);
    expect((mine ?? []).map((entry) => entry.id)).toContain(ticketId);

    const { data: theirs } = await unrelated
      .from('tickets')
      .select('id')
      .eq('requester_id', staff.id);
    expect((theirs ?? []).map((entry) => entry.id)).not.toContain(ticketId);
  });
});

describe('linked inventory devices', () => {
  it('links a device as the owner and shows it on the ticket detail', async () => {
    const ticketId = await ownedTicketWith();
    const deviceId = await addDevice({ asset_tag: `DOE-LN${RUN_TAG}9001` });

    await rpcOk(owner, 'app_link_ticket_device', { p_ticket: ticketId, p_device: deviceId });

    const links = await rawLinks(ticketId);
    expect(links).toHaveLength(1);
    expect(links[0]?.device_id).toBe(deviceId);
    expect(links[0]?.linked_by).toBe(identity('owner').id);

    const payload = await detail(owner, ticketId);
    expect(payload.ticket.category).toBe('other');
    expect(payload.linked_devices).toHaveLength(1);
    expect(payload.linked_devices[0]?.id).toBe(deviceId);
    expect(payload.linked_devices[0]?.asset_tag).toBe(`DOE-LN${RUN_TAG}9001`);
    expect(payload.linked_devices[0]?.linked_by).toBe(identity('owner').id);

    const list = await rpcOk<TicketListRow[]>(owner, 'app_list_tickets', {
      p_scope: 'mine',
      p_limit: 100,
    });
    expect(list.find((row) => row.id === ticketId)?.device_count).toBe(1);
  });

  it('records the link on both histories and refuses a duplicate', async () => {
    const ticketId = await ownedTicketWith();
    const deviceId = await addDevice();
    await rpcOk(owner, 'app_link_ticket_device', { p_ticket: ticketId, p_device: deviceId });

    const events = await rawEvents(ticketId);
    expect(eventKinds(events)).toContain('device_linked');
    const linked = events.find((event) => event.kind === 'device_linked');
    expect(linked?.performed_via).toBe('user');

    const { data } = await service
      .from('record_events')
      .select('*')
      .eq('entity_type', 'inventory_device')
      .eq('entity_id', deviceId);
    expect((data ?? []).map((event) => String(event.kind))).toContain('ticket_linked');

    const again = await rpcFails(owner, 'app_link_ticket_device', {
      p_ticket: ticketId,
      p_device: deviceId,
    });
    expect(again.code).toBe(REJECTED);
    expect(again.message).toMatch(/already linked/i);
  });

  it('refuses an unrelated account and a device that is not in the inventory', async () => {
    const ticketId = await ownedTicketWith();
    const deviceId = await addDevice();

    const stranger = await rpcFails(unrelated, 'app_link_ticket_device', {
      p_ticket: ticketId,
      p_device: deviceId,
    });
    expect(stranger.code).toBe(REFUSED);
    expect(await rawLinks(ticketId)).toHaveLength(0);

    const ghost = await rpcFails(owner, 'app_link_ticket_device', {
      p_ticket: ticketId,
      p_device: '00000000-0000-4000-8000-000000000000',
    });
    expect(ghost.code).toBe(MISSING);
  });

  it('hides links from an account that cannot see the ticket and from a pending account', async () => {
    const ticketId = await ownedTicketWith();
    const deviceId = await addDevice();
    await rpcOk(owner, 'app_link_ticket_device', { p_ticket: ticketId, p_device: deviceId });

    const strangerRows = await unrelated.from('ticket_devices').select('*').eq('ticket_id', ticketId);
    expect(strangerRows.error).toBeNull();
    expect(strangerRows.data).toEqual([]);

    const pendingRows = await pending.from('ticket_devices').select('*');
    expect(pendingRows.error).toBeNull();
    expect(pendingRows.data).toEqual([]);

    // The collaborator can see the ticket, so they can see what it names.
    await rpcOk(owner, 'app_add_collaborator', {
      p_ticket: ticketId,
      p_account: identity('collaborator').id,
    });
    const helperRows = await collaborator.from('ticket_devices').select('*').eq('ticket_id', ticketId);
    expect(helperRows.data).toHaveLength(1);
  });

  it('unlinks a device and records it', async () => {
    const ticketId = await ownedTicketWith();
    const deviceId = await addDevice();
    await rpcOk(owner, 'app_link_ticket_device', { p_ticket: ticketId, p_device: deviceId });
    await rpcOk(owner, 'app_unlink_ticket_device', { p_ticket: ticketId, p_device: deviceId });

    expect(await rawLinks(ticketId)).toHaveLength(0);
    expect((await detail(owner, ticketId)).linked_devices).toEqual([]);

    const unlinked = (await rawEvents(ticketId)).find((event) => event.kind === 'device_unlinked');
    expect(unlinked).toBeTruthy();
    expect(unlinked?.performed_via).toBe('user');

    const missing = await rpcFails(owner, 'app_unlink_ticket_device', {
      p_ticket: ticketId,
      p_device: deviceId,
    });
    expect(missing.code).toBe(REJECTED);
    expect(missing.message).toMatch(/not linked/i);
  });

  it('links devices named at intake', async () => {
    const first = await addDevice();
    const second = await addDevice();
    const ticketId = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: 'Two carts of Chromebooks will not update',
      p_issue: 'Both carts stall at 40 per cent on the policy update.',
      p_channel: 'email',
      p_requester_id: calloway,
      p_category: 'chromebook',
      p_device_ids: [first, second, first],
    });

    const links = await rawLinks(ticketId);
    expect(links.map((row) => String(row.device_id)).sort()).toEqual([first, second].sort());
    expect(eventKinds(await rawEvents(ticketId)).filter((kind) => kind === 'device_linked')).toHaveLength(2);
  });

  it('shows the ticket on the device page only to accounts that may see the ticket', async () => {
    const ticketId = await ownedTicketWith({ p_title: `Cracked lid ${RUN_TAG}` });
    const deviceId = await addDevice();
    await rpcOk(owner, 'app_link_ticket_device', { p_ticket: ticketId, p_device: deviceId });

    const mine = await ticketsForDevice(owner, deviceId);
    expect(mine.map((entry) => entry.id)).toEqual([ticketId]);
    expect(mine[0]?.title).toBe(`Cracked lid ${RUN_TAG}`);
    expect(mine[0]?.status).toBe('assigned');

    const theirs = await ticketsForDevice(unrelated, deviceId);
    expect(theirs).toEqual([]);
  });

  it('takes no session writes to ticket_devices at all', async () => {
    const ticketId = await ownedTicketWith();
    const deviceId = await addDevice();
    const insert = await owner
      .from('ticket_devices')
      .insert({ ticket_id: ticketId, device_id: deviceId, linked_by: identity('owner').id });
    expect(insert.error).not.toBeNull();

    await rpcOk(owner, 'app_link_ticket_device', { p_ticket: ticketId, p_device: deviceId });
    const remove = await owner.from('ticket_devices').delete().eq('ticket_id', ticketId);
    expect(remove.error).not.toBeNull();
    expect(await rawLinks(ticketId)).toHaveLength(1);
  });
});
