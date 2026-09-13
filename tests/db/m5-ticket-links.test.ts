/**
 * M5: what a ticket is about, whose it is, and which machines it touches.
 *
 * Three joins land here, and each one carries a rule that is not obvious from
 * its column list.
 *
 *   1. `category` is a small fixed vocabulary on the ticket, not free text, so
 *      the queue filter is a real filter rather than a search over typing. An
 *      unknown value is refused by the database, not normalised to 'other':
 *      silently rewriting a category would hide a broken caller and file the
 *      ticket in the wrong queue.
 *
 *   2. A requester may now BE somebody in the directory. The link is one
 *      requester row per person, so a second ticket for the same person reuses
 *      the row instead of growing a second copy of them — the whole point of the
 *      directory is that a person has one record.
 *
 *   3. A ticket may link real inventory devices, and `ticket_devices` inherits
 *      the PARENT TICKET's visibility exactly, like every other child table. An
 *      account that cannot see the ticket cannot see which machines it names,
 *      and an account awaiting setup sees nothing at all.
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
  identity,
  rawEvents,
  rawTicket,
  rpcFails,
  rpcOk,
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

function nextOsis(): string {
  sequence += 1;
  return `2${RUN_TAG}${String(sequence).padStart(4, '0')}`;
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
  device_id: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  type: string;
  model: string | null;
  status: string;
  linked_at: string;
  linked_by: string;
}

interface TicketDetailPayload {
  ticket: Record<string, unknown>;
  linked_devices: LinkedDevice[];
  devices: unknown[];
  activity: Array<Record<string, unknown>>;
}

interface DeviceDetailPayload {
  device: Record<string, unknown>;
  tickets: Array<{
    id: string;
    number: string;
    title: string;
    status: string;
    created_at: string;
  }>;
}

interface PersonListRow {
  id: string;
  display_name: string;
  device_count: number;
  open_ticket_count: number;
}

interface PersonDetailPayload {
  person: Record<string, unknown>;
  tickets: Array<{ id: string; number: string; title: string; status: string }>;
}

async function addPerson(
  client: SupabaseClient,
  person: Record<string, unknown>,
): Promise<string> {
  return rpcOk<string>(client, 'app_upsert_person', { p_person: person });
}

async function addDevice(
  client: SupabaseClient,
  device: Record<string, unknown> = {},
): Promise<string> {
  return rpcOk<string>(client, 'app_upsert_device', {
    p_device: { serial_number: nextSerial(), type: 'Laptop', model: 'IdeaPad Flex', ...device },
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

async function rawRequesters(personId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service.from('requesters').select('*').eq('person_id', personId);
  if (error) throw new Error(`Could not read requesters: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

/** An admin-created ticket already owned by `owner`, the standard arrangement. */
async function ownedTicketWith(options: Record<string, unknown> = {}): Promise<string> {
  const ticketId = await rpcOk<string>(admin, 'app_create_ticket', {
    p_title: 'Projector will not display',
    p_issue: 'Reported during first period; podium laptop shows no signal.',
    p_channel: 'phone_call',
    p_requester_name: 'Ms. Calloway',
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
});

describe('ticket category', () => {
  it('defaults to other and accepts the fixed vocabulary', async () => {
    const plain = await createTicketAs('admin', { channel: 'phone_call' });
    expect((await rawTicket(plain)).category).toBe('other');

    const network = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: 'Wi-Fi drops in the library',
      p_issue: 'Devices lose the network every few minutes near the stacks.',
      p_channel: 'phone_call',
      p_requester_name: 'Ms. Calloway',
      p_category: 'network',
    });
    expect((await rawTicket(network)).category).toBe('network');
  });

  it('refuses a category outside the vocabulary rather than filing it as other', async () => {
    const failure = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Something odd',
      p_issue: 'A description long enough to pass validation.',
      p_channel: 'phone_call',
      p_requester_name: 'Ms. Calloway',
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
      p_requester_name: 'Ms. Calloway',
      p_category: 'printer',
    });
    const account = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: `Password reset ${RUN_TAG}`,
      p_issue: 'Cannot sign in after the summer break.',
      p_channel: 'phone_call',
      p_requester_name: 'Ms. Calloway',
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

describe('a directory person as the requester', () => {
  it('creates one requester for a person and reuses it for their next ticket', async () => {
    const personId = await addPerson(owner, {
      kind: 'student',
      first_name: 'Amara',
      last_name: 'Whitfield',
      osis: nextOsis(),
      official_class: '9A',
    });

    const first = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: 'Chromebook will not charge',
      p_issue: 'The charging light never comes on.',
      p_channel: 'walk_in',
      p_category: 'chromebook',
      p_person_id: personId,
    });

    const linked = await rawRequesters(personId);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.display_name).toBe('Amara Whitfield');
    expect(linked[0]?.kind).toBe('student');
    expect(linked[0]?.descriptor).toBe('9A');
    expect((await rawTicket(first)).requester_id).toBe(linked[0]?.id);
    expect((await rawTicket(first)).requester_unknown).toBe(false);

    const second = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: 'Chromebook screen cracked',
      p_issue: 'Dropped in the hallway between periods.',
      p_channel: 'walk_in',
      p_person_id: personId,
    });
    expect(await rawRequesters(personId)).toHaveLength(1);
    expect((await rawTicket(second)).requester_id).toBe(linked[0]?.id);
  });

  it('refuses a person who is not in the directory', async () => {
    const failure = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'Ghost request',
      p_issue: 'A description long enough to pass validation.',
      p_channel: 'phone_call',
      p_person_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(failure.code).toBe(MISSING);
    expect(failure.message).toMatch(/directory/i);
  });

  it('counts a person’s open tickets and current devices in the directory listing', async () => {
    const personId = await addPerson(owner, {
      kind: 'staff',
      first_name: 'Rowan',
      last_name: `Bex${RUN_TAG}`,
      department: 'Science',
    });
    const deviceId = await addDevice(owner);
    await rpcOk(owner, 'app_assign_device', { p_device: deviceId, p_person: personId });

    const ticketId = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: 'Laptop runs hot',
      p_issue: 'The fan runs constantly during lessons.',
      p_channel: 'email',
      p_person_id: personId,
    });

    const rows = await rpcOk<PersonListRow[]>(admin, 'app_list_people', {
      p_query: `Bex${RUN_TAG}`,
    });
    const row = rows.find((entry) => entry.id === personId);
    expect(row?.device_count).toBe(1);
    expect(row?.open_ticket_count).toBe(1);

    const person = await rpcOk<PersonDetailPayload>(admin, 'app_person_detail', {
      p_person: personId,
    });
    expect(person.tickets.map((entry) => entry.id)).toContain(ticketId);

    // Resolving takes it out of the open count.
    await rpcOk(admin, 'app_claim_ticket', { p_ticket: ticketId });
    await rpcOk(admin, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Cleared the vents and confirmed the fan settles.',
    });
    const after = await rpcOk<PersonListRow[]>(admin, 'app_list_people', {
      p_query: `Bex${RUN_TAG}`,
    });
    expect(after.find((entry) => entry.id === personId)?.open_ticket_count).toBe(0);
  });
});

describe('linked inventory devices', () => {
  it('links a device as the owner and shows it on the ticket detail', async () => {
    const ticketId = await ownedTicketWith();
    const deviceId = await addDevice(owner, { asset_tag: `DOE-LN${RUN_TAG}9001` });

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
    const deviceId = await addDevice(owner);
    await rpcOk(owner, 'app_link_ticket_device', { p_ticket: ticketId, p_device: deviceId });

    const events = await rawEvents(ticketId);
    expect(eventKinds(events)).toContain('device_linked');
    const linked = events.find((event) => event.kind === 'device_linked');
    expect(linked?.performed_via).toBe('user');

    const { data } = await service
      .from('record_events')
      .select('*')
      .eq('entity_type', 'device')
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
    const deviceId = await addDevice(owner);

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
    const deviceId = await addDevice(owner);
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
    const deviceId = await addDevice(owner);
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
    const first = await addDevice(owner);
    const second = await addDevice(owner);
    const ticketId = await rpcOk<string>(admin, 'app_create_ticket', {
      p_title: 'Two carts of Chromebooks will not update',
      p_issue: 'Both carts stall at 40 per cent on the policy update.',
      p_channel: 'email',
      p_requester_name: 'Ms. Calloway',
      p_category: 'chromebook',
      p_device_ids: [first, second, first],
    });

    const links = await rawLinks(ticketId);
    expect(links.map((row) => String(row.device_id)).sort()).toEqual([first, second].sort());
    expect(eventKinds(await rawEvents(ticketId)).filter((kind) => kind === 'device_linked')).toHaveLength(2);
  });

  it('shows the ticket on the device page only to accounts that may see the ticket', async () => {
    const ticketId = await ownedTicketWith({ p_title: `Cracked lid ${RUN_TAG}` });
    const deviceId = await addDevice(owner);
    await rpcOk(owner, 'app_link_ticket_device', { p_ticket: ticketId, p_device: deviceId });

    const mine = await rpcOk<DeviceDetailPayload>(owner, 'app_device_detail', {
      p_device: deviceId,
    });
    expect(mine.tickets.map((entry) => entry.id)).toEqual([ticketId]);
    expect(mine.tickets[0]?.title).toBe(`Cracked lid ${RUN_TAG}`);
    expect(mine.tickets[0]?.status).toBe('assigned');

    const theirs = await rpcOk<DeviceDetailPayload>(unrelated, 'app_device_detail', {
      p_device: deviceId,
    });
    expect(theirs.tickets).toEqual([]);
  });

  it('takes no session writes to ticket_devices at all', async () => {
    const ticketId = await ownedTicketWith();
    const deviceId = await addDevice(owner);
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
