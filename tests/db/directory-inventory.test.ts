/**
 * M4 directory and inventory boundaries.
 *
 * Directory and inventory rows are arranged with the service role, as an
 * operator import would be. Every lookup and ticket creation under test uses a
 * normal signed-in session.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  createTicketAs,
  identity,
  rawTicket,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

interface RequesterFixture {
  id: string;
  display_name: string;
  kind: 'staff' | 'student';
  external_id: string;
}

interface InventoryFixture {
  id: string;
  external_id: string;
  device_type: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  assigned_requester_id: string | null;
}

const CATALOG = {
  device_type: 'Laptop',
  manufacturer: 'Lenovo',
  model: '300w',
};

let service: SupabaseClient;
let admin: SupabaseClient;
let owner: SupabaseClient;
let inactive: SupabaseClient;
let staff: RequesterFixture;
let student: RequesterFixture;
let staffDevice: InventoryFixture;
let studentDevice: InventoryFixture;

async function ensureRequester(
  fixture: Omit<RequesterFixture, 'id'>,
): Promise<RequesterFixture> {
  const existing = await service
    .from('requesters')
    .select('id, display_name, kind, external_id')
    .eq('kind', fixture.kind)
    .eq('external_id', fixture.external_id)
    .maybeSingle();
  if (existing.error) throw new Error(`Could not find requester fixture: ${existing.error.message}`);
  if (existing.data) return existing.data as RequesterFixture;

  const inserted = await service
    .from('requesters')
    .insert({ ...fixture, created_by: identity('admin').id })
    .select('id, display_name, kind, external_id')
    .single();
  if (inserted.error || !inserted.data) {
    throw new Error(`Could not seed requester fixture: ${inserted.error?.message}`);
  }
  return inserted.data as RequesterFixture;
}

async function ensureCatalog(): Promise<void> {
  const existing = await service
    .from('device_catalog')
    .select('device_type')
    .match(CATALOG)
    .maybeSingle();
  if (existing.error) throw new Error(`Could not find catalog fixture: ${existing.error.message}`);
  if (existing.data) return;

  const inserted = await service.from('device_catalog').insert(CATALOG);
  if (inserted.error) throw new Error(`Could not seed catalog fixture: ${inserted.error.message}`);
}

async function ensureInventory(
  fixture: Omit<InventoryFixture, 'id'>,
): Promise<InventoryFixture> {
  const existing = await service
    .from('inventory_devices')
    .select(
      'id, external_id, device_type, manufacturer, model, serial_number, assigned_requester_id',
    )
    .eq('external_id', fixture.external_id)
    .maybeSingle();
  if (existing.error) throw new Error(`Could not find inventory fixture: ${existing.error.message}`);
  if (existing.data) return existing.data as InventoryFixture;

  const inserted = await service
    .from('inventory_devices')
    .insert({ ...fixture, status: 'assigned' })
    .select(
      'id, external_id, device_type, manufacturer, model, serial_number, assigned_requester_id',
    )
    .single();
  if (inserted.error || !inserted.data) {
    throw new Error(`Could not seed inventory fixture: ${inserted.error?.message}`);
  }
  return inserted.data as InventoryFixture;
}

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, inactive] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('inactive'),
  ]);

  await ensureCatalog();
  staff = await ensureRequester({
    display_name: 'M4 Synthetic Staff',
    kind: 'staff',
    external_id: 'M4-STAFF-0001',
  });
  student = await ensureRequester({
    display_name: 'M4 Synthetic Student',
    kind: 'student',
    external_id: 'M4-OSIS-0001',
  });
  staffDevice = await ensureInventory({
    external_id: 'M4-DEVICE-0001',
    device_type: CATALOG.device_type,
    manufacturer: CATALOG.manufacturer,
    model: CATALOG.model,
    serial_number: 'M4-SERIAL-0001',
    assigned_requester_id: staff.id,
  });
  studentDevice = await ensureInventory({
    external_id: 'M4-DEVICE-0002',
    device_type: CATALOG.device_type,
    manufacturer: CATALOG.manufacturer,
    model: CATALOG.model,
    serial_number: 'M4-SERIAL-0002',
    assigned_requester_id: student.id,
  });
});

describe('directory and inventory lookups', () => {
  it('searches staff by name and students by OSIS, with literal wildcard and length bounds', async () => {
    const staffRows = await rpcOk<Array<Record<string, unknown>>>(
      owner,
      'app_search_requesters',
      { p_kind: 'staff', p_query: 'Synthetic Staff' },
    );
    expect(staffRows).toEqual([
      expect.objectContaining({
        id: staff.id,
        display_name: staff.display_name,
        external_id: staff.external_id,
      }),
    ]);

    const studentRows = await rpcOk<Array<Record<string, unknown>>>(
      owner,
      'app_search_requesters',
      { p_kind: 'student', p_query: 'M4-OSIS-0001' },
    );
    expect(studentRows).toEqual([
      expect.objectContaining({ id: student.id, external_id: student.external_id }),
    ]);

    // Search uses bounded literal matching. `%` is not a wildcard that can
    // turn a partial OSIS query into a directory-wide result.
    const wildcard = await rpcOk<Array<Record<string, unknown>>>(
      owner,
      'app_search_requesters',
      { p_kind: 'student', p_query: 'M4-%' },
    );
    expect(wildcard).toEqual([]);

    const tooLong = await rpcFails(owner, 'app_search_requesters', {
      p_kind: 'student',
      p_query: 'x'.repeat(121),
    });
    expect(tooLong.message).toMatch(/too long/i);
  });

  it('lists only devices assigned to the requested person', async () => {
    const staffRows = await rpcOk<Array<Record<string, unknown>>>(
      owner,
      'app_assigned_devices',
      { p_requester: staff.id },
    );
    expect(staffRows).toEqual([
      expect.objectContaining({ id: staffDevice.id, assigned_requester_id: staff.id }),
    ]);
    expect(staffRows.some((row) => row.id === studentDevice.id)).toBe(false);

    const catalogRows = await rpcOk<Array<Record<string, unknown>>>(owner, 'app_device_catalog');
    expect(catalogRows).toContainEqual(CATALOG);
  });

  it('refuses directory and inventory lookups to anonymous and inactive callers', async () => {
    const anon = anonClient();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['app_search_requesters', { p_kind: 'staff', p_query: 'Synthetic' }],
      ['app_assigned_devices', { p_requester: staff.id }],
      ['app_device_catalog', {}],
    ];
    for (const [fn, args] of calls) {
      expect((await rpcFails(anon, fn, args)).message).toMatch(/permission denied|cannot access/i);
      expect((await rpcFails(inactive, fn, args)).message).toMatch(/cannot access/i);
    }

    for (const table of ['device_catalog', 'inventory_devices']) {
      const anonymousRead = await anon.from(table).select('*').limit(1);
      expect(anonymousRead.data ?? []).toHaveLength(0);
      expect(anonymousRead.error).not.toBeNull();
      const inactiveRead = await inactive.from(table).select('*').limit(1);
      expect(inactiveRead.data ?? []).toHaveLength(0);
      expect(inactiveRead.error).not.toBeNull();
    }
  });
});

describe('inventory-aware ticket intake', () => {
  it('snapshots authoritative inventory fields instead of spoofed device details', async () => {
    const ticketId = await createTicketAs('admin', {
      title: `Inventory snapshot ${randomUUID()}`,
      requesterId: staff.id,
      requesterKind: 'staff',
      devices: [
        {
          deviceType: 'Laptop',
          inventoryDeviceId: staffDevice.id,
          manufacturer: 'Spoofed Manufacturer',
          model: 'Forged Model',
          serialNumber: 'FORGED-SERIAL',
        },
      ],
    });
    expect((await rawTicket(ticketId)).requester_id).toBe(staff.id);

    const observation = await service
      .from('device_observations')
      .select('device_type, manufacturer, model, serial_number, inventory_device_id')
      .eq('ticket_id', ticketId)
      .single();
    expect(observation.error).toBeNull();
    expect(observation.data).toEqual({
      device_type: staffDevice.device_type,
      manufacturer: staffDevice.manufacturer,
      model: staffDevice.model,
      serial_number: staffDevice.serial_number,
      inventory_device_id: staffDevice.id,
    });
  });

  it('rejects a device assigned to a different requester and duplicate inventory entries', async () => {
    const mismatch = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'M4 mismatched assignment',
      p_issue: 'Synthetic mismatch probe.',
      p_channel: 'phone_call',
      p_requester_id: student.id,
      p_requester_kind: 'student',
      p_devices: [{ deviceType: 'Laptop', inventoryDeviceId: staffDevice.id }],
    });
    expect(mismatch.message).toMatch(/no longer assigned/i);

    const duplicate = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'M4 duplicate inventory',
      p_issue: 'Synthetic duplicate probe.',
      p_channel: 'phone_call',
      p_requester_id: staff.id,
      p_requester_kind: 'staff',
      p_devices: [
        { deviceType: 'Laptop', inventoryDeviceId: staffDevice.id },
        { deviceType: 'Laptop', inventoryDeviceId: staffDevice.id },
      ],
    });
    expect(duplicate.message).toMatch(/already added/i);
  });

  it('requires a catalog tuple and serial for manual device intake', async () => {
    const missingSerial = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'M4 missing serial',
      p_issue: 'Synthetic manual device probe.',
      p_channel: 'phone_call',
      p_requester_unknown: true,
      p_devices: [
        {
          deviceType: CATALOG.device_type,
          manufacturer: CATALOG.manufacturer,
          model: CATALOG.model,
          identifiersNotApplicable: true,
        },
      ],
    });
    expect(missingSerial.message).toMatch(/requires.*serial/i);

    const missingCatalog = await rpcFails(admin, 'app_create_ticket', {
      p_title: 'M4 unknown catalog tuple',
      p_issue: 'Synthetic catalog probe.',
      p_channel: 'phone_call',
      p_requester_unknown: true,
      p_devices: [
        {
          deviceType: CATALOG.device_type,
          manufacturer: 'Not In Catalog',
          model: 'Synthetic Model',
          serialNumber: 'M4-MANUAL-0001',
        },
      ],
    });
    expect(missingCatalog.message).toMatch(/select a device type.*inventory/i);
  });

  it('rolls back the ticket and earlier device rows when a later device is invalid', async () => {
    const title = `M4 transactional rollback ${randomUUID()}`;
    const serial = `M4-ROLLBACK-${randomUUID()}`;
    const failure = await rpcFails(admin, 'app_create_ticket', {
      p_title: title,
      p_issue: 'The second device is intentionally incomplete.',
      p_channel: 'phone_call',
      p_requester_id: staff.id,
      p_requester_kind: 'staff',
      p_devices: [
        {
          deviceType: CATALOG.device_type,
          manufacturer: CATALOG.manufacturer,
          model: CATALOG.model,
          serialNumber: serial,
        },
        {
          deviceType: CATALOG.device_type,
          manufacturer: CATALOG.manufacturer,
          model: CATALOG.model,
        },
      ],
    });
    expect(failure.message).toMatch(/requires.*serial/i);

    const ticket = await service.from('tickets').select('id').eq('title', title);
    expect(ticket.data ?? []).toHaveLength(0);
    const observation = await service
      .from('device_observations')
      .select('id')
      .eq('serial_number', serial);
    expect(observation.data ?? []).toHaveLength(0);
  });
});
