/**
 * M5 inventory workflow: the four movements a help desk performs.
 *
 * `20260914130000` added assignment, return, bulk restatus and the scanner
 * lookup on the owner's `inventory_devices`, and `20260914130100` fixed the
 * guards on three of them. What is proven here is the whole of that surface,
 * through real signed-in sessions, because the guard is written inside each
 * SECURITY DEFINER body and a test that called it any other way would prove
 * nothing about the application.
 *
 * Four properties.
 *
 *   1. The movements do what they say: a machine changes hands, comes back
 *      with the state it came back in, and a trayful is restatused at once.
 *      Both histories are written every time — the owner's `inventory_events`
 *      before/after snapshot AND the sentence a person reads in
 *      `record_events`.
 *   2. The version is respected. A caller that passes the version it read is
 *      refused when somebody else has changed the row since, with the owner's
 *      own serialization_failure; a caller that passes none is allowed,
 *      because a scanner at a cart has not read a form.
 *   3. Roles, not the derived column. A skills officer holds
 *      `role = 'technician'` exactly as a NetRider does, so all three writers
 *      are tested against BOTH: the officer is refused, the NetRider is
 *      allowed, and the officer can still read.
 *   4. Attribution survives. A request that declares `x-edison-via: ai` is
 *      recorded as the account's assistant on the events these RPCs write,
 *      the same as every other event in the application.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  identity,
  ownedTicket,
  rawDevice,
  rawInventoryEvents,
  rawRecordEvents,
  rpcFails,
  rpcOk,
  seedInventoryDevice,
  seedRequester,
  signIn,
  signInWithHeaders,
} from './support/harness';

/**
 * Fresh names per run, and never the harness default: `directory-inventory`
 * asserts the exact list a search for "Synthetic Staff" returns, so a fixture
 * here that answered to it would break a suite that has nothing to do with
 * this one.
 */
const RUN = String(Math.floor(Math.random() * 9000) + 1000);

/** The model an assistant declares, and the two headers it sends with it. */
const MODEL = 'gpt-5.6-luna';
const AI_HEADERS = { 'x-edison-via': 'ai', 'x-edison-ai-model': MODEL };

/** insufficient_privilege and check_violation, as PostgREST reports them. */
const REFUSED = '42501';
const REJECTED = '23514';
/** The owner's own errcode for "somebody changed this first". */
const STALE = '40001';

interface LookupRow {
  id: string;
  label: string;
}

let admin: SupabaseClient;
let netrider: SupabaseClient;
let officer: SupabaseClient;
let aiNetrider: SupabaseClient;

let student: { id: string; displayName: string };
let staff: { id: string; displayName: string };

beforeAll(async () => {
  admin = await signIn('admin');
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
  aiNetrider = await signInWithHeaders('owner', AI_HEADERS);

  student = await seedRequester('student', { display_name: `Wren Calloway-${RUN}` });
  staff = await seedRequester('staff', { display_name: `Ms. Ferreira-${RUN}` });
});

/** The device's current version, read the way the screen reads it. */
async function versionOf(deviceId: string): Promise<number> {
  return Number((await rawDevice(deviceId)).version);
}

describe('handing a machine to somebody', () => {
  it('moves it, sets the status the inventory already knows, and writes both histories', async () => {
    const device = await seedInventoryDevice();

    const returned = await rpcOk<string>(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
      p_note: 'Loaned for the science fair.',
      p_version: await versionOf(device.id),
    });
    expect(returned).toBe(device.id);

    const row = await rawDevice(device.id);
    expect(row.assigned_requester_id).toBe(student.id);
    expect(row.status).toBe('Assigned');

    // The owner's audit row: a full before/after snapshot, whoever wrote it.
    const audit = await rawInventoryEvents('device', device.id);
    expect(audit).toHaveLength(1);
    expect((audit[0].before_record as Record<string, unknown>).assigned_requester_id).toBeNull();
    expect((audit[0].after_record as Record<string, unknown>).assigned_requester_id).toBe(
      student.id,
    );
    expect(audit[0].actor_id).toBe(identity('owner').id);

    // And the sentence a person reads, on the machine and on the person.
    const onDevice = await rawRecordEvents('inventory_device', device.id);
    expect(onDevice.map((event) => event.kind)).toEqual(['assigned']);
    expect(String(onDevice[0].summary)).toContain(student.displayName);
    expect(onDevice[0].detail).toBe('Loaned for the science fair.');

    const onPerson = await rawRecordEvents('requester', student.id);
    expect(onPerson.map((event) => event.kind)).toContain('device_assigned');
  });

  it('tells the previous holder, on their own record, that they no longer have it', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: staff.id,
    });
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });

    const onPrevious = await rawRecordEvents('requester', staff.id);
    const reassigned = onPrevious.filter((event) => event.kind === 'device_returned');
    expect(reassigned.length).toBeGreaterThan(0);
    expect(String(reassigned[reassigned.length - 1].summary)).toContain(student.displayName);
  });

  it('refuses a machine that is already with that person, and one that does not exist', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });

    const again = await rpcFails(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });
    expect(again.code).toBe(REJECTED);
    expect(again.message).toContain('already assigned');

    const missing = await rpcFails(netrider, 'app_assign_inventory_device', {
      p_device: '00000000-0000-4000-8000-000000000000',
      p_requester: student.id,
    });
    expect(missing.message).toContain('not in the inventory');
  });
});

describe('taking a machine back', () => {
  it('clears the holder, records the state it came back in, and writes both histories', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });

    await rpcOk(netrider, 'app_return_inventory_device', {
      p_device: device.id,
      p_status: 'Needs repair',
      p_note: 'Hinge cracked.',
      p_version: await versionOf(device.id),
    });

    const row = await rawDevice(device.id);
    expect(row.assigned_requester_id).toBeNull();
    expect(row.status).toBe('Needs repair');

    expect(await rawInventoryEvents('device', device.id)).toHaveLength(2);

    const onDevice = await rawRecordEvents('inventory_device', device.id);
    expect(onDevice.map((event) => event.kind)).toEqual(['assigned', 'returned']);
    expect(String(onDevice[1].detail)).toContain('Status set to Needs repair.');
    expect(String(onDevice[1].detail)).toContain('Hinge cracked.');
  });

  it('defaults to the shelf, and refuses a machine nobody is holding', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: staff.id,
    });
    await rpcOk(netrider, 'app_return_inventory_device', { p_device: device.id });
    expect((await rawDevice(device.id)).status).toBe('Available');

    const again = await rpcFails(netrider, 'app_return_inventory_device', {
      p_device: device.id,
    });
    expect(again.code).toBe(REJECTED);
    expect(again.message).toContain('not assigned to anybody');
  });
});

describe('the version somebody read', () => {
  it('refuses an assignment made against a version that has moved on', async () => {
    const device = await seedInventoryDevice();
    const stale = await versionOf(device.id);

    // Somebody else changes the row first.
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: staff.id,
    });

    const refused = await rpcFails(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
      p_version: stale,
    });
    expect(refused.code).toBe(STALE);
    expect(refused.message).toContain('Reload it before saving.');

    // The refusal changed nothing.
    expect((await rawDevice(device.id)).assigned_requester_id).toBe(staff.id);
  });

  it('refuses a return made against a stale version, and allows one that passes none', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });
    const stale = (await versionOf(device.id)) - 1;

    const refused = await rpcFails(netrider, 'app_return_inventory_device', {
      p_device: device.id,
      p_version: stale,
    });
    expect(refused.code).toBe(STALE);

    // A scanner at a cart has not read a form: no version means "whatever it
    // is now", and the movement goes through.
    await rpcOk(netrider, 'app_return_inventory_device', { p_device: device.id });
    expect((await rawDevice(device.id)).assigned_requester_id).toBeNull();
  });
});

describe('a trayful at once', () => {
  it('restatuses and moves every named machine, and writes a history for each', async () => {
    const one = await seedInventoryDevice({ location: 'Cart 4' });
    const two = await seedInventoryDevice({ location: 'Cart 4' });

    const changed = await rpcOk<number>(netrider, 'app_bulk_update_inventory', {
      p_ids: [one.id, two.id],
      p_patch: { status: 'In repair', location: 'Bench 2' },
    });
    expect(changed).toBe(2);

    for (const device of [one, two]) {
      const row = await rawDevice(device.id);
      expect(row.status).toBe('In repair');
      expect(row.location).toBe('Bench 2');
      expect(await rawInventoryEvents('device', device.id)).toHaveLength(1);
      const events = await rawRecordEvents('inventory_device', device.id);
      expect(events.map((event) => event.kind)).toEqual(['bulk_updated']);
      expect(String(events[0].detail)).toContain('status to In repair');
      expect(String(events[0].detail)).toContain('location to Bench 2');
    }
  });

  it('says the notes were cleared when they were cleared', async () => {
    const device = await seedInventoryDevice({ notes: 'Sticky spacebar.' });

    await rpcOk(netrider, 'app_bulk_update_inventory', {
      p_ids: [device.id],
      p_patch: { notes: '' },
    });

    expect((await rawDevice(device.id)).notes).toBeNull();
    const [event] = await rawRecordEvents('inventory_device', device.id);
    expect(String(event.detail)).toContain('notes cleared');
    expect(String(event.detail)).not.toContain('notes rewritten');
  });

  it('skips an id that names no machine rather than failing the batch', async () => {
    const device = await seedInventoryDevice();
    const changed = await rpcOk<number>(netrider, 'app_bulk_update_inventory', {
      p_ids: [device.id, '00000000-0000-4000-8000-000000000000'],
      p_patch: { status: 'Retired' },
    });
    expect(changed).toBe(1);
  });

  it('caps the batch at two hundred', async () => {
    const device = await seedInventoryDevice();
    // The cap is counted before a single row is read, which is the point of
    // it, so 199 ids that name nothing plus one that does is a batch of 200
    // and is answered, while 201 never reaches the inventory at all.
    const filler = Array.from({ length: 199 }, () => crypto.randomUUID());

    expect(
      await rpcOk<number>(netrider, 'app_bulk_update_inventory', {
        p_ids: [device.id, ...filler],
        p_patch: { status: 'Available' },
      }),
    ).toBe(1);

    const overCap = await rpcFails(netrider, 'app_bulk_update_inventory', {
      p_ids: [device.id, ...filler, crypto.randomUUID()],
      p_patch: { status: 'Available' },
    });
    expect(overCap.code).toBe(REJECTED);
    expect(overCap.message).toContain('at most 200');
  });

  it('refuses an empty selection, an empty change and a field it does not understand', async () => {
    const device = await seedInventoryDevice();

    expect(
      (await rpcFails(netrider, 'app_bulk_update_inventory', { p_ids: [], p_patch: { status: 'Available' } }))
        .message,
    ).toContain('Choose the machines');

    expect(
      (await rpcFails(netrider, 'app_bulk_update_inventory', { p_ids: [device.id], p_patch: {} }))
        .message,
    ).toContain('Choose what to change');

    expect(
      (
        await rpcFails(netrider, 'app_bulk_update_inventory', {
          p_ids: [device.id],
          p_patch: { serialNumber: 'SER-0001' },
        })
      ).message,
    ).toContain('status, location or notes only');
  });
});

/**
 * The finding this file exists for.
 *
 * `app_accounts.role` is derived: `app_derive_role_from_roles` writes
 * 'technician' for every account that is not an administrator, so a skills
 * officer and a NetRider are indistinguishable by that column. Every writer
 * here is asked about the role SET instead, and the two are tested side by
 * side so a gate that regressed to `role` would fail on the officer.
 */
describe('who may move the inventory', () => {
  it('refuses a skills officer the assignment, the return and the bulk change', async () => {
    const device = await seedInventoryDevice();

    const assign = await rpcFails(officer, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });
    expect(assign.code).toBe(REFUSED);
    expect(assign.message).toContain('Only a NetRider or an administrator');

    // Arranged by somebody who may, so the return is refused on the role and
    // not on "nobody is holding it".
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });

    const back = await rpcFails(officer, 'app_return_inventory_device', { p_device: device.id });
    expect(back.code).toBe(REFUSED);

    const bulk = await rpcFails(officer, 'app_bulk_update_inventory', {
      p_ids: [device.id],
      p_patch: { status: 'Retired' },
    });
    expect(bulk.code).toBe(REFUSED);

    // Nothing moved.
    const row = await rawDevice(device.id);
    expect(row.assigned_requester_id).toBe(student.id);
    expect(row.status).toBe('Assigned');
  });

  it('allows a NetRider and an administrator all three', async () => {
    const device = await seedInventoryDevice();

    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });
    await rpcOk(admin, 'app_return_inventory_device', { p_device: device.id });
    expect(
      await rpcOk<number>(admin, 'app_bulk_update_inventory', {
        p_ids: [device.id],
        p_patch: { status: 'Available' },
      }),
    ).toBe(1);
  });

  it('still lets a skills officer read what a person is holding, and scan a code', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: staff.id,
    });

    const held = await rpcOk<Array<Record<string, unknown>>>(officer, 'app_requester_devices', {
      p_requester: staff.id,
    });
    expect(held.map((entry) => entry.id)).toContain(device.id);

    const scanned = await rpcOk<LookupRow[]>(officer, 'app_lookup_inventory_code', {
      p_code: device.assetTag,
    });
    expect(scanned.map((row) => row.id)).toEqual([device.id]);
  });
});

describe('the machines one person holds', () => {
  it('returns an empty list for somebody holding nothing, and caps at two hundred', async () => {
    const nobody = await seedRequester('staff', { display_name: `Ola Bergstrom-${RUN}` });
    expect(
      await rpcOk<Array<Record<string, unknown>>>(netrider, 'app_requester_devices', {
        p_requester: nobody.id,
      }),
    ).toEqual([]);

    // Arranged with the service role: two hundred and one assignments through
    // the RPC would be two hundred and one transactions to prove a `limit`.
    const holder = await seedRequester('student', { display_name: `Ines Okonjo-${RUN}` });
    const rows = Array.from({ length: 201 }, (_, index) => ({
      external_id: `DEV-CAP-${holder.id.slice(0, 8)}-${index}`,
      device_type: 'Chromebook',
      manufacturer: 'Lenovo',
      model: '300e',
      serial_number: `SER-CAP-${holder.id.slice(0, 8)}-${index}`,
      status: 'Assigned',
      assigned_requester_id: holder.id,
    }));
    const { error } = await adminServiceClient().from('inventory_devices').insert(rows);
    if (error) throw new Error(`Could not seed the cap fixture: ${error.message}`);

    const held = await rpcOk<Array<Record<string, unknown>>>(netrider, 'app_requester_devices', {
      p_requester: holder.id,
    });
    expect(held).toHaveLength(200);
  });
});

describe('a code read off a machine', () => {
  it('finds it by inventory id, asset tag and serial, whatever the case', async () => {
    const device = await seedInventoryDevice();

    for (const code of [device.externalId, device.assetTag, device.serialNumber]) {
      const rows = await rpcOk<LookupRow[]>(netrider, 'app_lookup_inventory_code', {
        p_code: code.toLowerCase(),
      });
      expect(rows.map((row) => row.id)).toEqual([device.id]);
      expect(rows[0].label).toBeTruthy();
    }
  });

  it('answers nothing for a code that names none, and nothing for one that names two', async () => {
    expect(
      await rpcOk<LookupRow[]>(netrider, 'app_lookup_inventory_code', { p_code: 'NOT-A-TAG' }),
    ).toEqual([]);
    expect(await rpcOk<LookupRow[]>(netrider, 'app_lookup_inventory_code', { p_code: '  ' })).toEqual(
      [],
    );

    // One machine's asset tag is another's serial: two rows, no answer,
    // because a scanner has nobody to ask which one is in the operator's hand.
    const shared = `AMBIG-${Date.now()}`;
    await seedInventoryDevice({ asset_tag: shared });
    await seedInventoryDevice({ serial_number: shared });
    expect(
      await rpcOk<LookupRow[]>(netrider, 'app_lookup_inventory_code', { p_code: shared }),
    ).toEqual([]);
  });
});

describe('who did it', () => {
  it('records the assistant and its model on an assignment made through one', async () => {
    const device = await seedInventoryDevice();

    await rpcOk(aiNetrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });

    const [event] = await rawRecordEvents('inventory_device', device.id);
    expect(event.performed_via).toBe('ai');
    expect(event.ai_model).toBe(MODEL);
    // The account is still the person: an assistant acts on somebody's behalf.
    expect(event.actor_id).toBe(identity('owner').id);
  });

  it('records the assistant on a return and on a bulk change too', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: staff.id,
    });
    await rpcOk(aiNetrider, 'app_return_inventory_device', { p_device: device.id });
    await rpcOk(aiNetrider, 'app_bulk_update_inventory', {
      p_ids: [device.id],
      p_patch: { location: 'Bench 1' },
    });

    const events = await rawRecordEvents('inventory_device', device.id);
    const byKind = new Map(events.map((event) => [String(event.kind), event]));
    expect(byKind.get('assigned')?.performed_via).toBe('user');
    expect(byKind.get('returned')?.performed_via).toBe('ai');
    expect(byKind.get('bulk_updated')?.performed_via).toBe('ai');
    expect(byKind.get('bulk_updated')?.ai_model).toBe(MODEL);
  });
});

/**
 * The Backups screen reads the district's own tables.
 *
 * `src/lib/data/backup-actions.ts` enumerated four tables this milestone
 * dropped, so the three that actually hold the district's records could not be
 * backed up at all. Two of them have row-level security with no policies, so a
 * session client cannot read them however privileged the account: those go
 * through `app_backup_rows` / `app_backup_count`, which carry the screen's own
 * administrator-only gate.
 */
describe('backing up the district tables', () => {
  it('lets an administrator read rows out of each of the three', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', {
      p_device: device.id,
      p_requester: student.id,
    });

    // requesters keeps the owner's policy: any active account may read it, and
    // the screen's own admin check is what narrows it.
    const { data: people, error: peopleError } = await admin
      .from('requesters')
      .select('*')
      .limit(5);
    expect(peopleError).toBeNull();
    expect((people ?? []).length).toBeGreaterThan(0);

    for (const table of ['inventory_devices', 'inventory_events']) {
      const rows = await rpcOk<Array<Record<string, unknown>>>(admin, 'app_backup_rows', {
        p_table: table,
        p_limit: 5,
        p_offset: 0,
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].id).toBeTruthy();

      const total = await rpcOk<number>(admin, 'app_backup_count', { p_table: table });
      expect(Number(total)).toBeGreaterThan(0);
    }
  });

  it('pages, newest first, without repeating a row', async () => {
    const first = await rpcOk<Array<Record<string, unknown>>>(admin, 'app_backup_rows', {
      p_table: 'inventory_events',
      p_limit: 2,
      p_offset: 0,
    });
    const second = await rpcOk<Array<Record<string, unknown>>>(admin, 'app_backup_rows', {
      p_table: 'inventory_events',
      p_limit: 2,
      p_offset: 2,
    });
    const ids = [...first, ...second].map((row) => String(row.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses a NetRider, a skills officer, and a table that is not on the list', async () => {
    for (const client of [netrider, officer]) {
      expect(
        (await rpcFails(client, 'app_backup_rows', { p_table: 'inventory_devices' })).code,
      ).toBe(REFUSED);
      expect(
        (await rpcFails(client, 'app_backup_count', { p_table: 'inventory_devices' })).code,
      ).toBe(REFUSED);
    }

    const wrong = await rpcFails(admin, 'app_backup_rows', { p_table: 'app_accounts' });
    expect(wrong.code).toBe(REJECTED);
    expect(wrong.message).toContain('not a table this screen can export');
  });
});

/**
 * An observation can name the machine it was made about.
 *
 * `device_observations.inventory_device_id` has existed since 20260912220000
 * and `src/lib/data/mapping.ts` has mapped it all milestone, but
 * `app_record_device` took seven arguments and none of them was the inventory
 * id, so nothing ever wrote it. 20260914130100 adds the eighth.
 */
describe('an observation that names an inventory machine', () => {
  it('stores the id when the machine was chosen from the picker', async () => {
    const device = await seedInventoryDevice();
    const { ticketId } = await ownedTicket();

    const observationId = await rpcOk<string>(netrider, 'app_record_device', {
      p_ticket: ticketId,
      p_device_type: 'Chromebook',
      p_serial_number: device.serialNumber,
      p_inventory_device_id: device.id,
    });

    const { data, error } = await adminServiceClient()
      .from('device_observations')
      .select('*')
      .eq('id', observationId)
      .single();
    if (error) throw new Error(`Could not read the observation: ${error.message}`);
    expect((data as Record<string, unknown>).inventory_device_id).toBe(device.id);
  });

  it('still records a machine the district does not own, with no id at all', async () => {
    const { ticketId } = await ownedTicket();

    const observationId = await rpcOk<string>(netrider, 'app_record_device', {
      p_ticket: ticketId,
      p_device_type: 'Projector',
    });

    const { data } = await adminServiceClient()
      .from('device_observations')
      .select('inventory_device_id')
      .eq('id', observationId)
      .single();
    expect((data as Record<string, unknown>).inventory_device_id).toBeNull();
  });

  it('refuses an id that names no machine rather than failing on the foreign key', async () => {
    const { ticketId } = await ownedTicket();

    const refused = await rpcFails(netrider, 'app_record_device', {
      p_ticket: ticketId,
      p_device_type: 'Chromebook',
      p_inventory_device_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(refused.message).toContain('not in the inventory');
  });
});
