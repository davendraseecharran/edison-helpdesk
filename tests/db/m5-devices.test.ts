/**
 * M5 device inventory: the roughly 7,500 machines the school lends out, and who
 * is holding each one.
 *
 * The rules proven here follow from two facts about this table.
 *
 * It is an inventory of things, not of children, so its history may name values
 * — a location, a status, an asset tag — where the people directory may only
 * name fields. What it must NOT do is leak the directory: a device row points at
 * a person, so reading devices and assignments requires an ACTIVE account for
 * exactly the reason reading people does.
 *
 * And it has to stay internally consistent. A device is `deployed` if and only
 * if somebody currently holds it. That invariant is not a convention the
 * application is trusted to keep: assignment, return, the status setter and the
 * upsert all enforce it, so no path can leave a machine marked deployed with
 * nobody holding it, or marked in stock while a student has it in their bag.
 *
 * Everything is arranged through real signed-in sessions and read back with the
 * service role, so no test proves something about a privileged path the
 * application will never take.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
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
let helper: SupabaseClient;
let pending: SupabaseClient;
let inactive: SupabaseClient;
let pendingApproval: SupabaseClient;
let denied: SupabaseClient;

/**
 * Fresh identifiers per run so the suite can be re-run against a database that
 * was not reset. Asset tags are shaped like the school's real ones
 * (`DOE-LN1221779`) without colliding with any of them.
 */
const RUN_TAG = String(Math.floor(Math.random() * 9000) + 1000);
let sequence = 0;

function nextSerial(): string {
  sequence += 1;
  return `SN${RUN_TAG}${String(sequence).padStart(4, '0')}`;
}

function nextAssetTag(): string {
  sequence += 1;
  return `DOE-LN${RUN_TAG}${String(sequence).padStart(4, '0')}`;
}

function nextDeviceId(): string {
  sequence += 1;
  return `PW${RUN_TAG}${String(sequence).padStart(4, '0')}-WIN`;
}

interface DeviceListRow {
  id: string;
  device_id: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  type: string;
  manufacturer: string | null;
  model: string | null;
  os: string | null;
  status: string;
  location: string | null;
  holder_id: string | null;
  holder_name: string | null;
  holder_kind: string | null;
  updated_at: string;
  total_count: number;
}

interface DeviceAssignmentEntry {
  id: string;
  person_id: string;
  person_name: string;
  person_kind: string;
  assigned_at: string;
  assigned_by_name: string | null;
  returned_at: string | null;
  returned_by_name: string | null;
  note: string | null;
}

interface DeviceDetail {
  device: Record<string, unknown>;
  holder: { id: string; display_name: string; kind: string; assigned_at: string } | null;
  assignments: DeviceAssignmentEntry[];
  tickets: unknown[];
  events: Array<Record<string, unknown>>;
}

interface PersonDetail {
  person: Record<string, unknown>;
  devices: Array<{
    assignment_id: string;
    assigned_at: string;
    returned_at: string | null;
    device: {
      id: string;
      device_id: string | null;
      serial_number: string | null;
      asset_tag: string | null;
      type: string;
      model: string | null;
      status: string;
    };
  }>;
  tickets: unknown[];
  events: Array<Record<string, unknown>>;
}

interface DeviceFacets {
  types: string[];
  statuses: string[];
  locations: string[];
}

const STATUSES = ['in_stock', 'deployed', 'in_repair', 'retired', 'lost', 'surplus'];

async function upsertDevice(
  client: SupabaseClient,
  device: Record<string, unknown>,
): Promise<string> {
  return rpcOk<string>(client, 'app_upsert_device', { p_device: device });
}

async function listDevices(
  client: SupabaseClient,
  args: Record<string, unknown> = {},
): Promise<DeviceListRow[]> {
  return rpcOk<DeviceListRow[]>(client, 'app_list_devices', args);
}

async function addPerson(
  client: SupabaseClient,
  person: Record<string, unknown>,
): Promise<string> {
  return rpcOk<string>(client, 'app_upsert_person', { p_person: person });
}

/** Ground truth straight from the tables, bypassing every read path under test. */
async function rawDevice(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await service.from('devices').select('*').eq('id', id).single();
  if (error) throw new Error(`Could not read device ${id}: ${error.message}`);
  return data as Record<string, unknown>;
}

async function rawAssignments(deviceId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('device_assignments')
    .select('*')
    .eq('device_id', deviceId)
    .order('assigned_at', { ascending: true });
  if (error) throw new Error(`Could not read assignments: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function recordEvents(
  entityType: 'device' | 'person',
  id: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('record_events')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', id)
    .order('at', { ascending: true });
  if (error) throw new Error(`Could not read ${entityType} history: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

function kinds(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => String(event.kind));
}

/** An ordinary Lenovo laptop, unique to this call unless overridden. */
function laptop(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serial_number: nextSerial(),
    asset_tag: nextAssetTag(),
    type: 'Laptop',
    manufacturer: 'Lenovo',
    model: 'ThinkPad L13',
    os: 'Windows 11',
    ...overrides,
  };
}

/** A student who can hold a device, unique to this call. */
async function newStudent(name = 'Rowan Vance'): Promise<string> {
  const [first, last] = name.split(' ');
  sequence += 1;
  return addPerson(owner, {
    kind: 'student',
    first_name: first,
    last_name: last,
    osis: `2${RUN_TAG}${String(sequence).padStart(4, '0')}`,
  });
}

async function newStaff(name = 'Odette Marchetti'): Promise<string> {
  const [first, last] = name.split(' ');
  sequence += 1;
  return addPerson(owner, {
    kind: 'staff',
    first_name: first,
    last_name: last,
    staff_id: `EMP-${RUN_TAG}-${sequence}`,
  });
}

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, helper, pending, inactive, pendingApproval, denied] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('collaborator'),
    signIn('pending'),
    signIn('inactive'),
    signIn('pendingApproval'),
    signIn('denied'),
  ]);
});

describe('adding a device', () => {
  it('accepts a machine identified only by its serial number', async () => {
    const serial = nextSerial();
    const deviceId = await upsertDevice(owner, { serial_number: serial, model: 'ThinkPad L13' });

    const row = await rawDevice(deviceId);
    expect(row.serial_number).toBe(serial);
    expect(row.device_id).toBeNull();
    expect(row.asset_tag).toBeNull();
    // The defaults the inventory starts a device from.
    expect(row.type).toBe('Laptop');
    expect(row.status).toBe('in_stock');
    expect(row.source).toBe('manual');
  });

  it('upper-cases and trims every identifier, and treats a blank cell as absent', async () => {
    const serial = nextSerial();
    const assetTag = nextAssetTag();
    const device = nextDeviceId();
    const deviceId = await upsertDevice(owner, {
      serial_number: `  ${serial.toLowerCase()}  `,
      asset_tag: assetTag.toLowerCase(),
      device_id: ` ${device.toLowerCase()}`,
      model: '  ThinkPad L13  ',
      location: '   ',
      notes: '',
    });

    const row = await rawDevice(deviceId);
    expect(row.serial_number).toBe(serial);
    expect(row.asset_tag).toBe(assetTag);
    expect(row.device_id).toBe(device);
    expect(row.model).toBe('ThinkPad L13');
    expect(row.location).toBeNull();
    expect(row.notes).toBeNull();
  });

  it('refuses a second device with the same serial typed in another case', async () => {
    const serial = nextSerial();
    await upsertDevice(owner, { serial_number: serial });

    const clash = await rpcFails(owner, 'app_upsert_device', {
      p_device: { serial_number: serial.toLowerCase() },
    });
    expect(clash.message).toMatch(/already has serial number/i);
    expect(clash.message).toContain(serial);
    // Never the raw index name.
    expect(clash.message).not.toMatch(/devices_serial_idx|duplicate key/i);
  });

  it('refuses a duplicate asset tag and a duplicate device id too', async () => {
    const assetTag = nextAssetTag();
    const device = nextDeviceId();
    await upsertDevice(owner, { asset_tag: assetTag, device_id: device });

    const sameTag = await rpcFails(owner, 'app_upsert_device', {
      p_device: { asset_tag: assetTag.toLowerCase() },
    });
    expect(sameTag.message).toMatch(/already has asset tag/i);
    expect(sameTag.message).not.toMatch(/devices_asset_tag_idx|duplicate key/i);

    const sameDeviceId = await rpcFails(owner, 'app_upsert_device', {
      p_device: { device_id: device.toLowerCase() },
    });
    expect(sameDeviceId.message).toMatch(/already has device id/i);
    expect(sameDeviceId.message).not.toMatch(/devices_device_id_idx|duplicate key/i);
  });

  it('refuses a device with no identifier at all, including one blanked by trimming', async () => {
    const none = await rpcFails(owner, 'app_upsert_device', {
      p_device: { model: 'ThinkPad L13' },
    });
    expect(none.code).toBe(REJECTED);
    expect(none.message).toMatch(/device id, serial number or asset tag/i);

    const blank = await rpcFails(owner, 'app_upsert_device', {
      p_device: { serial_number: '   ', asset_tag: '' },
    });
    expect(blank.code).toBe(REJECTED);
    expect(blank.message).toMatch(/device id, serial number or asset tag/i);
  });

  it('refuses a status that is not one of the six', async () => {
    const failure = await rpcFails(owner, 'app_upsert_device', {
      p_device: { serial_number: nextSerial(), status: 'broken' },
    });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/status/i);
  });

  it('records who added it, and says what changed by field name', async () => {
    const deviceId = await upsertDevice(owner, laptop());
    const created = await recordEvents('device', deviceId);
    expect(kinds(created)).toEqual(['created']);
    expect(created[0]?.actor_id).toBe(identity('owner').id);
    expect(created[0]?.performed_via).toBe('user');

    await upsertDevice(owner, { id: deviceId, os: 'Windows 11 Pro', notes: 'Cracked bezel' });
    const events = await recordEvents('device', deviceId);
    expect(kinds(events)).toEqual(['created', 'updated']);
    const detail = String(events.at(-1)?.detail);
    expect(detail).toContain('os');
    expect(detail).toContain('notes');
  });

  it('changes only the fields that were sent, and writes no history for a no-op', async () => {
    const deviceId = await upsertDevice(owner, laptop({ location: 'Cart 3' }));
    const before = await rawDevice(deviceId);

    await upsertDevice(owner, {
      id: deviceId,
      manufacturer: 'Lenovo',
      // Not a device column: ignored rather than refused, so a richer import row
      // does not fail over a field the inventory does not keep.
      warranty_expires: '2029-06-30',
    });
    expect(kinds(await recordEvents('device', deviceId))).toEqual(['created']);

    await upsertDevice(owner, { id: deviceId, os: 'Windows 10' });
    const after = await rawDevice(deviceId);
    expect(after.os).toBe('Windows 10');
    expect(after.location).toBe(before.location);
    expect(after.serial_number).toBe(before.serial_number);
    expect(String(after.updated_at) > String(before.updated_at)).toBe(true);
  });

  it('refuses an id that is not in the inventory', async () => {
    const failure = await rpcFails(owner, 'app_upsert_device', {
      p_device: { id: '00000000-0000-0000-0000-000000000000', model: 'Ghost' },
    });
    expect(failure.code).toBe(MISSING);
    expect(failure.message).toMatch(/not in the inventory/i);
  });
});

describe('assigning a device', () => {
  it('hands a laptop to a student and shows it from both sides', async () => {
    const personId = await newStudent('Imogen Ruiz');
    const deviceId = await upsertDevice(owner, laptop());
    const assignmentId = await rpcOk<string>(owner, 'app_assign_device', {
      p_device: deviceId,
      p_person: personId,
      p_note: 'Signed loan agreement',
    });

    expect((await rawDevice(deviceId)).status).toBe('deployed');

    const open = await rawAssignments(deviceId);
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(assignmentId);
    expect(open[0]?.person_id).toBe(personId);
    expect(open[0]?.assigned_by).toBe(identity('owner').id);
    expect(open[0]?.returned_at).toBeNull();
    expect(open[0]?.note).toBe('Signed loan agreement');

    const detail = await rpcOk<DeviceDetail>(owner, 'app_device_detail', { p_device: deviceId });
    expect(detail.holder?.id).toBe(personId);
    expect(detail.holder?.display_name).toBe('Imogen Ruiz');
    expect(detail.holder?.kind).toBe('student');
    expect(detail.holder?.assigned_at).toBeTruthy();
    expect(detail.assignments).toHaveLength(1);
    expect(detail.assignments[0]?.assigned_by_name).toBe('Priya Raman');

    const person = await rpcOk<PersonDetail>(owner, 'app_person_detail', { p_person: personId });
    expect(person.devices).toHaveLength(1);
    expect(person.devices[0]?.assignment_id).toBe(assignmentId);
    expect(person.devices[0]?.returned_at).toBeNull();
    expect(person.devices[0]?.device.id).toBe(deviceId);
    expect(person.devices[0]?.device.status).toBe('deployed');
  });

  it('records the handover on the device and on the person', async () => {
    const personId = await newStudent('Solomon Adeyemi');
    const assetTag = nextAssetTag();
    const deviceId = await upsertDevice(owner, laptop({ asset_tag: assetTag }));
    await rpcOk(owner, 'app_assign_device', { p_device: deviceId, p_person: personId });

    const deviceHistory = await recordEvents('device', deviceId);
    expect(kinds(deviceHistory)).toEqual(['created', 'assigned']);
    expect(String(deviceHistory.at(-1)?.summary)).toContain('Assigned to Solomon Adeyemi');

    const personHistory = await recordEvents('person', personId);
    expect(kinds(personHistory)).toEqual(['created', 'device_assigned']);
    expect(String(personHistory.at(-1)?.summary)).toContain(`${assetTag} assigned`);
  });

  it('auto-returns the previous holder when the device moves to somebody else', async () => {
    const firstId = await newStudent('Marisol Ferrer');
    const secondId = await newStudent('Devon Blake');
    const deviceId = await upsertDevice(owner, laptop());

    await rpcOk(owner, 'app_assign_device', { p_device: deviceId, p_person: firstId });
    await rpcOk(owner, 'app_assign_device', { p_device: deviceId, p_person: secondId });

    const rows = await rawAssignments(deviceId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.returned_at === null)).toHaveLength(1);
    const closed = rows.find((row) => row.returned_at !== null);
    expect(closed?.person_id).toBe(firstId);
    expect(closed?.returned_by).toBe(identity('owner').id);
    const stillOpen = rows.find((row) => row.returned_at === null);
    expect(stillOpen?.person_id).toBe(secondId);

    // Still one device, still deployed, now to the second person. The handover
    // is one device event, not a return and an assignment sharing an instant.
    expect((await rawDevice(deviceId)).status).toBe('deployed');
    expect(kinds(await recordEvents('device', deviceId))).toEqual(['created', 'assigned', 'assigned']);
    const detail = await rpcOk<DeviceDetail>(owner, 'app_device_detail', { p_device: deviceId });
    expect(detail.holder?.id).toBe(secondId);
    // Newest first, so the open assignment leads.
    expect(detail.assignments.map((entry) => entry.person_id)).toEqual([secondId, firstId]);
    expect(detail.assignments[1]?.returned_by_name).toBe('Priya Raman');

    // The person who no longer has it is told so in their own history.
    expect(kinds(await recordEvents('person', firstId))).toEqual(['created', 'device_assigned', 'device_returned']);
    // And their record shows the device as a past loan, after any current one.
    const person = await rpcOk<PersonDetail>(owner, 'app_person_detail', { p_person: firstId });
    expect(person.devices).toHaveLength(1);
    expect(person.devices[0]?.returned_at).not.toBeNull();
  });

  it('lists a person’s current loans before their past ones', async () => {
    const personId = await newStudent('Iris Nakamura');
    const past = await upsertDevice(owner, laptop());
    const current = await upsertDevice(owner, laptop());

    await rpcOk(owner, 'app_assign_device', { p_device: past, p_person: personId });
    await rpcOk(owner, 'app_return_device', { p_device: past });
    await rpcOk(owner, 'app_assign_device', { p_device: current, p_person: personId });

    const person = await rpcOk<PersonDetail>(owner, 'app_person_detail', { p_person: personId });
    expect(person.devices.map((entry) => entry.device.id)).toEqual([current, past]);
    expect(person.devices[0]?.returned_at).toBeNull();
    expect(person.devices[1]?.returned_at).not.toBeNull();
  });

  it('changes nothing when the device is handed to the person who already has it', async () => {
    const personId = await newStudent('Callum Reyes');
    const deviceId = await upsertDevice(owner, laptop());
    const first = await rpcOk<string>(owner, 'app_assign_device', {
      p_device: deviceId,
      p_person: personId,
    });

    const again = await rpcOk<string>(owner, 'app_assign_device', {
      p_device: deviceId,
      p_person: personId,
      p_note: 'Submitted twice',
    });

    // The loan they already have, not a zero-length one beside it.
    expect(again).toBe(first);
    const rows = await rawAssignments(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.returned_at).toBeNull();
    // Nothing happened, so the note describing it is not recorded either.
    expect(rows[0]?.note).toBeNull();
    expect(kinds(await recordEvents('device', deviceId))).toEqual(['created', 'assigned']);
    expect(kinds(await recordEvents('person', personId))).toEqual(['created', 'device_assigned']);

    // And a bulk patch that re-assigns them counts it as unchanged.
    expect(
      Number(
        await rpcOk<number>(owner, 'app_bulk_update_devices', {
          p_ids: [deviceId],
          p_patch: { person_id: personId },
        }),
      ),
    ).toBe(0);
    expect(await rawAssignments(deviceId)).toHaveLength(1);
  });

  it('refuses a device or a person that is not there, and an archived person', async () => {
    const personId = await newStudent('Percy Underwood');
    const deviceId = await upsertDevice(owner, laptop());

    const noDevice = await rpcFails(owner, 'app_assign_device', {
      p_device: '00000000-0000-0000-0000-000000000000',
      p_person: personId,
    });
    expect(noDevice.code).toBe(MISSING);
    expect(noDevice.message).toMatch(/not in the inventory/i);

    const noPerson = await rpcFails(owner, 'app_assign_device', {
      p_device: deviceId,
      p_person: '00000000-0000-0000-0000-000000000000',
    });
    expect(noPerson.code).toBe(MISSING);
    expect(noPerson.message).toMatch(/not in the directory/i);

    await rpcOk(admin, 'app_set_person_active', { p_person: personId, p_active: false });
    const archived = await rpcFails(owner, 'app_assign_device', {
      p_device: deviceId,
      p_person: personId,
    });
    expect(archived.code).toBe(REJECTED);
    expect(archived.message).toMatch(/archived/i);

    // Nothing happened: the device is still in stock and unheld.
    expect((await rawDevice(deviceId)).status).toBe('in_stock');
    expect(await rawAssignments(deviceId)).toHaveLength(0);
  });
});

describe('returning a device', () => {
  it('closes the loan and puts the machine back in stock', async () => {
    const personId = await newStudent('Theodore Ashby');
    const assetTag = nextAssetTag();
    const deviceId = await upsertDevice(owner, laptop({ asset_tag: assetTag }));
    await rpcOk(owner, 'app_assign_device', { p_device: deviceId, p_person: personId });

    await rpcOk(owner, 'app_return_device', { p_device: deviceId });

    expect((await rawDevice(deviceId)).status).toBe('in_stock');
    const rows = await rawAssignments(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.returned_at).not.toBeNull();
    expect(rows[0]?.returned_by).toBe(identity('owner').id);

    const detail = await rpcOk<DeviceDetail>(owner, 'app_device_detail', { p_device: deviceId });
    expect(detail.holder).toBeNull();
    expect(detail.assignments).toHaveLength(1);
    expect(detail.assignments[0]?.returned_by_name).toBe('Priya Raman');

    expect(kinds(await recordEvents('device', deviceId))).toEqual(['created', 'assigned', 'returned']);
    const personHistory = await recordEvents('person', personId);
    expect(kinds(personHistory)).toEqual(['created', 'device_assigned', 'device_returned']);
    expect(String(personHistory.at(-1)?.summary)).toContain(`${assetTag} returned`);
  });

  it('takes the status the machine is coming back in', async () => {
    const personId = await newStaff('Harper Quinn');
    const deviceId = await upsertDevice(owner, laptop());
    await rpcOk(owner, 'app_assign_device', { p_device: deviceId, p_person: personId });

    await rpcOk(owner, 'app_return_device', {
      p_device: deviceId,
      p_status: 'in_repair',
      p_note: 'Screen flickers',
    });

    expect((await rawDevice(deviceId)).status).toBe('in_repair');
    const events = await recordEvents('device', deviceId);
    expect(String(events.at(-1)?.summary)).toMatch(/in repair/i);
    expect(String(events.at(-1)?.detail)).toContain('Screen flickers');
  });

  it('refuses to return a device nobody is holding', async () => {
    const deviceId = await upsertDevice(owner, laptop());
    const failure = await rpcFails(owner, 'app_return_device', { p_device: deviceId });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toBe('This device is not assigned to anyone.');
    expect((await rawDevice(deviceId)).status).toBe('in_stock');
  });

  it('refuses to return a device into the deployed status', async () => {
    const personId = await newStudent('Nadia Krall');
    const deviceId = await upsertDevice(owner, laptop());
    await rpcOk(owner, 'app_assign_device', { p_device: deviceId, p_person: personId });

    const failure = await rpcFails(owner, 'app_return_device', {
      p_device: deviceId,
      p_status: 'deployed',
    });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/deployed/i);

    // Nothing changed: the student still has it.
    expect((await rawDevice(deviceId)).status).toBe('deployed');
    expect((await rawAssignments(deviceId))[0]?.returned_at).toBeNull();
  });
});

describe('status and location', () => {
  it('changes a status and records the reason', async () => {
    const deviceId = await upsertDevice(owner, laptop());
    await rpcOk(owner, 'app_set_device_status', {
      p_device: deviceId,
      p_status: 'in_repair',
      p_reason: 'Sent to the depot',
    });

    expect((await rawDevice(deviceId)).status).toBe('in_repair');
    const events = await recordEvents('device', deviceId);
    expect(kinds(events)).toEqual(['created', 'status_changed']);
    expect(String(events.at(-1)?.summary)).toMatch(/in repair/i);
    expect(String(events.at(-1)?.detail)).toBe('Sent to the depot');

    // Setting the status it already has changes nothing and records nothing.
    await rpcOk(owner, 'app_set_device_status', { p_device: deviceId, p_status: 'in_repair' });
    expect(kinds(await recordEvents('device', deviceId))).toEqual(['created', 'status_changed']);
  });

  it('will not mark a device deployed when nobody is holding it', async () => {
    const deviceId = await upsertDevice(owner, laptop());
    const failure = await rpcFails(owner, 'app_set_device_status', {
      p_device: deviceId,
      p_status: 'deployed',
    });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/assign/i);
    expect((await rawDevice(deviceId)).status).toBe('in_stock');
  });

  it('will not take a device out of deployed while somebody still has it', async () => {
    const personId = await newStudent('Amos Winterbourne');
    const deviceId = await upsertDevice(owner, laptop());
    await rpcOk(owner, 'app_assign_device', { p_device: deviceId, p_person: personId });

    const failure = await rpcFails(owner, 'app_set_device_status', {
      p_device: deviceId,
      p_status: 'lost',
    });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/return/i);
    expect((await rawDevice(deviceId)).status).toBe('deployed');
  });

  it('holds the same invariant when the status arrives through the upsert', async () => {
    const personId = await newStudent('Zara Abiodun');
    const free = await upsertDevice(owner, laptop());
    const held = await upsertDevice(owner, laptop());
    await rpcOk(owner, 'app_assign_device', { p_device: held, p_person: personId });

    const deployWithoutHolder = await rpcFails(owner, 'app_upsert_device', {
      p_device: { id: free, status: 'deployed' },
    });
    expect(deployWithoutHolder.code).toBe(REJECTED);
    expect((await rawDevice(free)).status).toBe('in_stock');

    const undeployWhileHeld = await rpcFails(owner, 'app_upsert_device', {
      p_device: { id: held, status: 'in_stock' },
    });
    expect(undeployWhileHeld.code).toBe(REJECTED);
    expect((await rawDevice(held)).status).toBe('deployed');

    // Resending the status it already has is not a change, so it is allowed.
    await upsertDevice(owner, { id: held, status: 'deployed', location: `Room ${RUN_TAG}` });
    expect((await rawDevice(held)).location).toBe(`Room ${RUN_TAG}`);
  });

  it('moves a device and records where it went', async () => {
    const deviceId = await upsertDevice(owner, laptop());
    await rpcOk(owner, 'app_move_device', { p_device: deviceId, p_location: '  Room 212  ' });

    expect((await rawDevice(deviceId)).location).toBe('Room 212');
    const events = await recordEvents('device', deviceId);
    expect(kinds(events)).toEqual(['created', 'moved']);
    expect(String(events.at(-1)?.summary)).toContain('Room 212');

    // Moving it where it already is records nothing.
    await rpcOk(owner, 'app_move_device', { p_device: deviceId, p_location: 'Room 212' });
    expect(kinds(await recordEvents('device', deviceId))).toEqual(['created', 'moved']);

    // An empty location clears it.
    await rpcOk(owner, 'app_move_device', { p_device: deviceId, p_location: '' });
    expect((await rawDevice(deviceId)).location).toBeNull();
    expect(kinds(await recordEvents('device', deviceId))).toEqual(['created', 'moved', 'moved']);
  });
});

describe('bulk changes', () => {
  it('changes the status of three devices and says it changed three', async () => {
    const ids = [
      await upsertDevice(owner, laptop()),
      await upsertDevice(owner, laptop()),
      await upsertDevice(owner, laptop()),
    ];

    const changed = await rpcOk<number>(owner, 'app_bulk_update_devices', {
      p_ids: ids,
      p_patch: { status: 'surplus' },
    });
    expect(Number(changed)).toBe(3);

    for (const id of ids) {
      expect((await rawDevice(id)).status).toBe('surplus');
      expect(kinds(await recordEvents('device', id))).toEqual(['created', 'status_changed']);
    }

    // Re-running the same patch changes nothing, and says so.
    expect(
      Number(
        await rpcOk<number>(owner, 'app_bulk_update_devices', {
          p_ids: ids,
          p_patch: { status: 'surplus' },
        }),
      ),
    ).toBe(0);
  });

  it('moves a whole cart to a new room', async () => {
    const ids = [await upsertDevice(owner, laptop()), await upsertDevice(owner, laptop())];
    const location = `Cart ${RUN_TAG}`;

    const changed = await rpcOk<number>(owner, 'app_bulk_update_devices', {
      p_ids: ids,
      p_patch: { location },
    });
    expect(Number(changed)).toBe(2);
    for (const id of ids) {
      expect((await rawDevice(id)).location).toBe(location);
    }
  });

  it('assigns a set of devices to one person and returns them again', async () => {
    const personId = await newStaff('Bertram Oyelaran');
    const ids = [await upsertDevice(owner, laptop()), await upsertDevice(owner, laptop())];

    expect(
      Number(
        await rpcOk<number>(owner, 'app_bulk_update_devices', {
          p_ids: ids,
          p_patch: { person_id: personId },
        }),
      ),
    ).toBe(2);
    for (const id of ids) {
      expect((await rawDevice(id)).status).toBe('deployed');
    }

    expect(
      Number(
        await rpcOk<number>(owner, 'app_bulk_update_devices', {
          p_ids: ids,
          p_patch: { return: true, status: 'in_repair' },
        }),
      ),
    ).toBe(2);
    for (const id of ids) {
      expect((await rawDevice(id)).status).toBe('in_repair');
      expect((await rawAssignments(id))[0]?.returned_at).not.toBeNull();
    }
  });

  it('applies nothing at all when one device in the selection cannot be changed', async () => {
    const personId = await newStudent('Cleo Barnaby');
    const freeTag = nextAssetTag();
    const held = await upsertDevice(owner, laptop());
    const free = await upsertDevice(owner, laptop({ asset_tag: freeTag }));
    await rpcOk(owner, 'app_assign_device', { p_device: held, p_person: personId });

    const failure = await rpcFails(owner, 'app_bulk_update_devices', {
      p_ids: [held, free],
      p_patch: { return: true },
    });
    expect(failure.code).toBe(REJECTED);
    // Which machine refused, not only that one did. "This device is not assigned
    // to anyone." over a selection of three hundred laptops is not something an
    // operator can act on.
    expect(failure.message).toContain(freeTag);
    expect(failure.message).toContain('This device is not assigned to anyone.');

    // All or nothing: the one that could have been returned was not.
    expect((await rawDevice(held)).status).toBe('deployed');
    expect((await rawAssignments(held))[0]?.returned_at).toBeNull();
  });

  it('names a device by its id when the selection contains one that is not there', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const failure = await rpcFails(owner, 'app_bulk_update_devices', {
      p_ids: [missing],
      p_patch: { status: 'surplus' },
    });
    expect(failure.message).toContain(missing);
    expect(failure.message).toMatch(/not in the inventory/i);
  });

  it('refuses more than five hundred devices at once', async () => {
    const ids = Array.from({ length: 501 }, () => '00000000-0000-0000-0000-000000000000');
    const failure = await rpcFails(owner, 'app_bulk_update_devices', {
      p_ids: ids,
      p_patch: { status: 'surplus' },
    });
    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/500/);
  });

  it('refuses a patch that says nothing, and one that says two things at once', async () => {
    const deviceId = await upsertDevice(owner, laptop());
    const personId = await newStudent('Ines Fontaine');

    const empty = await rpcFails(owner, 'app_bulk_update_devices', {
      p_ids: [deviceId],
      p_patch: {},
    });
    expect(empty.code).toBe(REJECTED);

    const both = await rpcFails(owner, 'app_bulk_update_devices', {
      p_ids: [deviceId],
      p_patch: { person_id: personId, return: true },
    });
    expect(both.code).toBe(REJECTED);

    // Assigning already sets the status to deployed, so a status beside it is a
    // contradiction, and every other contradiction here is refused rather than
    // quietly resolved by precedence.
    const assignAndSet = await rpcFails(owner, 'app_bulk_update_devices', {
      p_ids: [deviceId],
      p_patch: { person_id: personId, status: 'in_repair' },
    });
    expect(assignAndSet.code).toBe(REJECTED);
    expect(assignAndSet.message).toMatch(/deployed/i);

    // Nothing was applied by any of the three refusals.
    expect((await rawDevice(deviceId)).status).toBe('in_stock');
    expect(await rawAssignments(deviceId)).toHaveLength(0);
  });
});

describe('listing and searching', () => {
  const TYPE = 'Interactive panel';
  let studentId = '';
  let staffPersonId = '';
  let held = '';
  let staffHeld = '';
  let spare = '';
  let retired = '';
  let location = '';
  let everything: string[] = [];

  beforeAll(async () => {
    location = `Annex ${RUN_TAG}`;
    studentId = await newStudent('Lucia Moreau');
    staffPersonId = await newStaff('Wendell Pike');

    held = await upsertDevice(owner, laptop({ model: `Yoga ${RUN_TAG}`, location }));
    staffHeld = await upsertDevice(owner, laptop({ model: `Yoga ${RUN_TAG}`, location }));
    spare = await upsertDevice(owner, laptop({ model: `Yoga ${RUN_TAG}`, location }));
    retired = await upsertDevice(owner, laptop({ model: `Yoga ${RUN_TAG}`, location, type: TYPE }));
    everything = [held, staffHeld, spare, retired];

    await rpcOk(owner, 'app_assign_device', { p_device: held, p_person: studentId });
    await rpcOk(owner, 'app_assign_device', { p_device: staffHeld, p_person: staffPersonId });
    await rpcOk(owner, 'app_set_device_status', { p_device: retired, p_status: 'retired' });
  });

  it('filters by status, type, location and holder kind, and counts the whole set', async () => {
    const all = await listDevices(owner, { p_location: location });
    expect(all.map((row) => row.id).sort()).toEqual([...everything].sort());
    expect(Number(all[0]?.total_count)).toBe(4);

    const byType = await listDevices(owner, { p_location: location, p_type: TYPE });
    expect(byType.map((row) => row.id)).toEqual([retired]);

    const byStatus = await listDevices(owner, { p_location: location, p_status: 'retired' });
    expect(byStatus.map((row) => row.id)).toEqual([retired]);

    const students = await listDevices(owner, { p_location: location, p_holder_kind: 'student' });
    expect(students.map((row) => row.id)).toEqual([held]);
    expect(students[0]?.holder_id).toBe(studentId);
    expect(students[0]?.holder_name).toBe('Lucia Moreau');
    expect(students[0]?.holder_kind).toBe('student');
    expect(students[0]?.status).toBe('deployed');

    const staffRows = await listDevices(owner, { p_location: location, p_holder_kind: 'staff' });
    expect(staffRows.map((row) => row.id)).toEqual([staffHeld]);
    expect(staffRows[0]?.holder_name).toBe('Wendell Pike');

    const unheld = await listDevices(owner, { p_location: location, p_holder_kind: 'none' });
    expect(unheld.map((row) => row.id).sort()).toEqual([spare, retired].sort());
    expect(unheld[0]?.holder_id).toBeNull();
    expect(unheld[0]?.holder_name).toBeNull();
  });

  it('pages within the filtered set and reports the full total on every page', async () => {
    const first = await listDevices(owner, { p_location: location, p_limit: 3 });
    expect(first).toHaveLength(3);
    expect(Number(first[0]?.total_count)).toBe(4);

    const second = await listDevices(owner, { p_location: location, p_limit: 3, p_offset: 3 });
    expect(second).toHaveLength(1);
    expect(Number(second[0]?.total_count)).toBe(4);

    // No overlap between the pages, and no row missed.
    expect([...first, ...second].map((row) => row.id).sort()).toEqual([...everything].sort());

    // Asking for no rows gets no rows rather than being rounded up to one.
    expect(await listDevices(owner, { p_location: location, p_limit: 0 })).toHaveLength(0);
  });

  it('matches an identifier from its start and a model anywhere in it', async () => {
    const serial = nextSerial();
    const assetTag = nextAssetTag();
    const deviceId = await upsertDevice(owner, {
      serial_number: serial,
      asset_tag: assetTag,
      device_id: nextDeviceId(),
      model: `IdeaPad Flex ${RUN_TAG}`,
    });

    expect((await listDevices(owner, { p_query: serial.slice(0, 8) })).map((row) => row.id)).toContain(
      deviceId,
    );
    expect(
      (await listDevices(owner, { p_query: assetTag.slice(0, 9).toLowerCase() })).map((row) => row.id),
    ).toContain(deviceId);
    // A model is matched anywhere in it, so "Flex" finds an IdeaPad Flex.
    expect((await listDevices(owner, { p_query: 'deaPad Flex' })).map((row) => row.id)).toContain(
      deviceId,
    );
    // An identifier only from its start: the run tag sits in the middle of the
    // serial without starting it.
    expect(
      (await listDevices(owner, { p_query: `N${RUN_TAG}`, p_status: 'in_stock' })).map((row) => row.id),
    ).not.toContain(deviceId);
  });

  it('treats an unrecognised holder kind as matching nothing', async () => {
    // Fails closed. An unknown value is a bug in the caller, and answering it
    // with the whole inventory would be the wrong way to report one.
    expect(await listDevices(owner, { p_location: location, p_holder_kind: 'parent' })).toEqual([]);
    expect(await listDevices(owner, { p_location: location, p_holder_kind: '' })).toEqual([]);
  });

  it('never returns more than a hundred rows, whatever the caller asks for', async () => {
    const warehouse = `Warehouse ${RUN_TAG}`;
    const total = 101;
    for (let done = 0; done < total; done += 20) {
      await Promise.all(
        Array.from({ length: Math.min(20, total - done) }, () =>
          upsertDevice(owner, laptop({ location: warehouse })),
        ),
      );
    }

    const rows = await listDevices(owner, { p_location: warehouse, p_limit: 1000 });
    expect(rows).toHaveLength(100);
    // The total still counts the whole filtered set, not the page.
    expect(Number(rows[0]?.total_count)).toBe(total);
  });

  it('treats a wildcard typed into the search box as text', async () => {
    const assetTag = nextAssetTag();
    const deviceId = await upsertDevice(owner, laptop({ asset_tag: assetTag }));
    expect((await listDevices(owner, { p_query: assetTag })).map((row) => row.id)).toContain(deviceId);

    expect(await listDevices(owner, { p_query: '%' })).toHaveLength(0);
    expect(await listDevices(owner, { p_query: '_OE-LN' })).toHaveLength(0);
    expect(await listDevices(owner, { p_query: '\\' })).toHaveLength(0);
  });

  it('orders the newest change first', async () => {
    const older = await upsertDevice(owner, laptop({ location: `Shelf ${RUN_TAG}` }));
    const newer = await upsertDevice(owner, laptop({ location: `Shelf ${RUN_TAG}` }));
    await rpcOk(owner, 'app_set_device_status', { p_device: older, p_status: 'surplus' });

    const rows = await listDevices(owner, { p_location: `Shelf ${RUN_TAG}` });
    expect(rows.map((row) => row.id)).toEqual([older, newer]);
  });
});

describe('facets', () => {
  it('offers the six statuses in a fixed order, plus the types and locations in use', async () => {
    const type = `Interactive panel ${RUN_TAG}`;
    const location = `Auditorium ${RUN_TAG}`;
    await upsertDevice(owner, laptop({ type, location }));

    const facets = await rpcOk<DeviceFacets>(owner, 'app_device_facets');
    expect(facets.statuses).toEqual(STATUSES);
    expect(facets.types).toContain(type);
    expect(facets.locations).toContain(location);
    expect(facets.types).toEqual([...facets.types].sort());
    expect(facets.locations).toEqual([...facets.locations].sort());
    expect(facets.types).not.toContain(null);
    expect(facets.locations).not.toContain(null);
  });
});

describe('device detail', () => {
  it('returns the device, its holder, its whole loan history and its events', async () => {
    const firstId = await newStudent('Rowan Delgado');
    const secondId = await newStaff('Odette Marchetti');
    const deviceId = await upsertDevice(owner, laptop());

    await rpcOk(owner, 'app_assign_device', {
      p_device: deviceId,
      p_person: firstId,
      p_note: 'Loan for the term',
    });
    await rpcOk(helper, 'app_assign_device', { p_device: deviceId, p_person: secondId });

    const detail = await rpcOk<DeviceDetail>(owner, 'app_device_detail', { p_device: deviceId });
    expect(detail.device.id).toBe(deviceId);
    expect(detail.device.status).toBe('deployed');
    expect(detail.holder?.id).toBe(secondId);
    expect(detail.holder?.kind).toBe('staff');

    expect(detail.assignments).toHaveLength(2);
    expect(detail.assignments[0]?.person_name).toBe('Odette Marchetti');
    expect(detail.assignments[0]?.assigned_by_name).toBe('Dev Okafor');
    expect(detail.assignments[0]?.returned_at).toBeNull();
    expect(detail.assignments[1]?.person_name).toBe('Rowan Delgado');
    expect(detail.assignments[1]?.person_kind).toBe('student');
    expect(detail.assignments[1]?.note).toBe('Loan for the term');
    expect(detail.assignments[1]?.returned_by_name).toBe('Dev Okafor');

    // Task 10 fills this in; it is empty, never absent.
    expect(detail.tickets).toEqual([]);
    // Newest first, the opposite of the person history's order. Moving a device
    // to a new holder is ONE device event, so the handover reads as a single
    // line rather than a return and an assignment a millisecond apart.
    expect(kinds(detail.events)).toEqual(['assigned', 'assigned', 'created']);
    expect(String(detail.events[0]?.detail)).toContain('Rowan Delgado');
  });

  it('returns nothing for a device that is not there', async () => {
    const detail = await rpcOk<DeviceDetail | null>(owner, 'app_device_detail', {
      p_device: '00000000-0000-0000-0000-000000000000',
    });
    expect(detail).toBeNull();
  });
});

describe('attribution labels', () => {
  it('names a colleague, including a deactivated one, and nobody else', async () => {
    const label = async (client: SupabaseClient, account: string): Promise<string | null> =>
      rpcOk<string | null>(client, 'app_account_label', { p_account: account });

    expect(await label(owner, identity('collaborator').id)).toBe('Dev Okafor');
    // A deactivated colleague stays nameable: their name is on historical work
    // and still has to render beside it.
    expect(await label(owner, identity('inactive').id)).toBe('Alex Reyes');

    // Someone waiting for, or refused, an access decision is not a colleague.
    // app_directory() omits them so that a named person's attempt to sign in is
    // not broadcast to every technician in the building, and a label function
    // that answered for them would be that broadcast one uuid at a time.
    expect(await label(owner, identity('pendingApproval').id)).toBeNull();
    expect(await label(owner, identity('denied').id)).toBeNull();

    expect(await label(owner, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await label(owner, null as unknown as string)).toBeNull();

    // And nothing at all to a caller who is not active themselves.
    for (const client of [pending, inactive, pendingApproval, denied]) {
      expect(await label(client, identity('admin').id)).toBeNull();
    }
  });
});

describe('the assignment closer is unreachable from a session', () => {
  const args = { p_device: '00000000-0000-0000-0000-000000000000', p_actor: null };

  it('refuses an admin session', async () => {
    const failure = await rpcFails(admin, 'app_close_device_assignment', args);
    expect(failure.message).toMatch(/permission denied/i);
  });

  it('refuses an ordinary technician too', async () => {
    const failure = await rpcFails(owner, 'app_close_device_assignment', args);
    expect(failure.message).toMatch(/permission denied/i);
  });

  it('refuses the service role as well', async () => {
    const { error } = await service.rpc('app_close_device_assignment', args);
    expect(error?.message).toMatch(/permission denied/i);
  });
});

describe('who may reach the inventory', () => {
  let existingId = '';
  let holderId = '';

  beforeAll(async () => {
    holderId = await newStudent('Visible Holder');
    existingId = await upsertDevice(owner, laptop({ location: `Store ${RUN_TAG}` }));
    await rpcOk(owner, 'app_assign_device', { p_device: existingId, p_person: holderId });
  });

  it('shows an active technician the inventory', async () => {
    const devices = await helper.from('devices').select('id').limit(1);
    expect(devices.error).toBeNull();
    expect((devices.data ?? []).length).toBeGreaterThan(0);

    const assignments = await helper.from('device_assignments').select('id').limit(1);
    expect(assignments.error).toBeNull();
    expect((assignments.data ?? []).length).toBeGreaterThan(0);
  });

  it('shows nothing to an account that is not active', async () => {
    for (const [label, client] of [
      ['awaiting setup', pending],
      ['deactivated', inactive],
      ['awaiting an access decision', pendingApproval],
      ['denied', denied],
    ] as const) {
      const devices = await client.from('devices').select('id');
      expect(devices.error, `${label} must not error`).toBeNull();
      expect(devices.data ?? [], `${label} must see no devices`).toHaveLength(0);

      const assignments = await client.from('device_assignments').select('id');
      expect(assignments.error, `${label} must not error`).toBeNull();
      expect(assignments.data ?? [], `${label} must see no assignments`).toHaveLength(0);

      expect(await listDevices(client), `${label} must list nothing`).toEqual([]);
      expect(
        await rpcOk<DeviceDetail | null>(client, 'app_device_detail', { p_device: existingId }),
        `${label} must see no detail`,
      ).toBeNull();

      const facets = await rpcOk<DeviceFacets>(client, 'app_device_facets');
      expect(facets.types, `${label} must see no types`).toEqual([]);
      expect(facets.locations, `${label} must see no locations`).toEqual([]);
      // The six statuses are a fixed vocabulary, not data about the school.
      expect(facets.statuses, `${label} still gets the vocabulary`).toEqual(STATUSES);
    }
  });

  it('refuses every write from an account that is not active', async () => {
    for (const client of [pending, inactive, pendingApproval, denied]) {
      expect(
        (await rpcFails(client, 'app_upsert_device', { p_device: { serial_number: nextSerial() } }))
          .code,
      ).toBe(REFUSED);
      expect(
        (await rpcFails(client, 'app_assign_device', { p_device: existingId, p_person: holderId }))
          .code,
      ).toBe(REFUSED);
      expect((await rpcFails(client, 'app_return_device', { p_device: existingId })).code).toBe(
        REFUSED,
      );
      expect(
        (await rpcFails(client, 'app_set_device_status', { p_device: existingId, p_status: 'lost' }))
          .code,
      ).toBe(REFUSED);
      expect(
        (await rpcFails(client, 'app_move_device', { p_device: existingId, p_location: 'Nowhere' }))
          .code,
      ).toBe(REFUSED);
      expect(
        (
          await rpcFails(client, 'app_bulk_update_devices', {
            p_ids: [existingId],
            p_patch: { status: 'lost' },
          })
        ).code,
      ).toBe(REFUSED);
    }

    // None of that touched the device.
    expect((await rawDevice(existingId)).status).toBe('deployed');
  });

  it('refuses anonymous callers outright', async () => {
    const anon = anonClient();

    for (const table of ['devices', 'device_assignments']) {
      const read = await anon.from(table).select('id');
      expect(read.error?.message, table).toMatch(/permission denied/i);
    }

    for (const fn of ['app_list_devices', 'app_device_facets']) {
      const { error } = await anon.rpc(fn);
      expect(error?.message, fn).toMatch(/permission denied|function|schema cache/i);
    }

    const write = await anon.rpc('app_upsert_device', {
      p_device: { serial_number: 'FORGED-1' },
    });
    expect(write.error?.message).toMatch(/permission denied|function|schema cache/i);
  });

  it('takes no write from a session, not even an administrator’s', async () => {
    const insert = await admin.from('devices').insert({ serial_number: 'FORGED-2' });
    expect(insert.error?.message).toMatch(/permission denied|violates row-level security/i);

    const update = await admin.from('devices').update({ status: 'lost' }).eq('id', existingId);
    expect(update.error?.message).toMatch(/permission denied/i);

    const remove = await admin.from('devices').delete().eq('id', existingId);
    expect(remove.error?.message).toMatch(/permission denied/i);

    const assign = await admin
      .from('device_assignments')
      .insert({ device_id: existingId, person_id: holderId });
    expect(assign.error?.message).toMatch(/permission denied|violates row-level security/i);

    const close = await admin
      .from('device_assignments')
      .update({ returned_at: new Date().toISOString() })
      .eq('device_id', existingId);
    expect(close.error?.message).toMatch(/permission denied/i);

    const deleteAssignment = await admin
      .from('device_assignments')
      .delete()
      .eq('device_id', existingId);
    expect(deleteAssignment.error?.message).toMatch(/permission denied/i);

    expect((await rawDevice(existingId)).status).toBe('deployed');
  });
});
