/**
 * Deleting an inventory record: `20260924110000_inventory_delete_device.sql`.
 *
 * A room audit's "not seen" pile holds a few records that were never
 * machines — a tag typed twice, a duplicate. What is proven here, through real
 * signed-in sessions because the gate is written inside a SECURITY DEFINER
 * body:
 *
 *   1. An administrator deletes a record nothing depends on, and the trail is
 *      written: the whole row in inventory_events, a readable line with the
 *      identifiers in record_events, attributed to the assistant when it was
 *      the assistant.
 *   2. A NetRider can too (20260924140000; the trail names them). A skills
 *      officer and an anonymous caller are refused and nothing is written.
 *   3. A record something depends on is refused with a sentence that says
 *      Retired: with somebody, linked to a ticket, or carrying a file.
 *   4. A stale version and a record that is already gone are refused.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  ownedTicket,
  rawInventoryEvents,
  rawRecordEvents,
  rpcFails,
  rpcOk,
  seedInventoryDevice,
  seedRequester,
  signIn,
  signInWithHeaders,
} from './support/harness';

const REFUSED = '42501';
const REJECTED = '23514';

let admin: SupabaseClient;
let netrider: SupabaseClient;
let officer: SupabaseClient;
let aiAdmin: SupabaseClient;

beforeAll(async () => {
  admin = await signIn('admin');
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
  aiAdmin = await signInWithHeaders('admin', { 'x-edison-via': 'ai', 'x-edison-ai-model': 'gpt-5.6-luna' });
});

async function exists(id: string): Promise<boolean> {
  const { data, error } = await adminServiceClient().from('inventory_devices').select('id').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}

describe('an administrator deletes a record nothing depends on', () => {
  it('removes it and keeps the whole row in the trail', async () => {
    const device = await seedInventoryDevice({ location: 'Room 204', model: '300e', manufacturer: 'Lenovo' });
    const answer = await rpcOk<{ id: string; label: string }>(admin, 'app_delete_inventory_device', {
      p_device: device.id,
      p_reason: 'Duplicate of the tag that was seen',
    });
    expect(answer).toEqual({ id: device.id, label: device.assetTag });
    expect(await exists(device.id)).toBe(false);

    const [event] = await rawInventoryEvents('device', device.id);
    expect(event.actor_id).toBe(identity('admin').id);
    expect((event.before_record as Record<string, unknown>).asset_tag).toBe(device.assetTag);
    expect(event.after_record).toEqual({ deleted: true, reason: 'Duplicate of the tag that was seen' });

    const [record] = await rawRecordEvents('inventory_device', device.id);
    expect(record.kind).toBe('deleted');
    expect(record.performed_via).toBe('user');
    expect(String(record.summary)).toContain(`deleted the record ${device.assetTag}`);
    const detail = String(record.detail);
    expect(detail).toContain('Reason: Duplicate of the tag that was seen');
    expect(detail).toContain(`serial ${device.serialNumber}`);
    expect(detail).toContain(`inventory id ${device.externalId}`);
    expect(detail).toContain('recorded in Room 204');
  });

  it('says it was the assistant when the assistant did it', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(aiAdmin, 'app_delete_inventory_device', { p_device: device.id });
    const [record] = await rawRecordEvents('inventory_device', device.id);
    expect(record.performed_via).toBe('ai');
    expect(record.ai_model).toBe('gpt-5.6-luna');
    expect(String(record.detail)).not.toContain('Reason:');
  });

  it('refuses a record that is already gone, and a stale version', async () => {
    const device = await seedInventoryDevice();
    const stale = await rpcFails(admin, 'app_delete_inventory_device', { p_device: device.id, p_version: 99 });
    expect(stale.message).toContain('changed since you opened it');
    expect(await exists(device.id)).toBe(true);

    await rpcOk(admin, 'app_delete_inventory_device', { p_device: device.id, p_version: 1 });
    const again = await rpcFails(admin, 'app_delete_inventory_device', { p_device: device.id });
    expect(again.code).toBe('P0002');
    expect(again.message).toContain('not in the inventory');
  });

  it('keeps the reason to a sentence', async () => {
    const device = await seedInventoryDevice();
    const long = await rpcFails(admin, 'app_delete_inventory_device', {
      p_device: device.id,
      p_reason: 'x'.repeat(501),
    });
    expect(long.code).toBe(REJECTED);
    expect(await exists(device.id)).toBe(true);
  });
});

describe('administrators and NetRiders', () => {
  it('lets a NetRider delete, with the trail in their name', async () => {
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_delete_inventory_device', { p_device: device.id, p_reason: 'Typo' });
    expect(await exists(device.id)).toBe(false);
    const [event] = await rawInventoryEvents('device', device.id);
    expect(event.actor_id).toBe(identity('owner').id);
  });

  it('refuses a skills officer and anybody signed out, and writes nothing', async () => {
    const device = await seedInventoryDevice();
    const refused = await rpcFails(officer, 'app_delete_inventory_device', { p_device: device.id });
    expect(refused.code).toBe(REFUSED);
    expect(refused.message).toContain('Retired');
    const { error } = await anonClient().rpc('app_delete_inventory_device', { p_device: device.id });
    expect(error).not.toBeNull();

    expect(await exists(device.id)).toBe(true);
    expect(await rawInventoryEvents('device', device.id)).toHaveLength(0);
    expect(await rawRecordEvents('inventory_device', device.id)).toHaveLength(0);
  });
});

describe('a record something depends on is kept', () => {
  it('refuses a machine somebody has, and names them', async () => {
    const person = await seedRequester('student', { display_name: `Wren Calloway-${crypto.randomUUID().slice(0, 4)}` });
    const device = await seedInventoryDevice();
    await rpcOk(netrider, 'app_assign_inventory_device', { p_device: device.id, p_requester: person.id });
    const refused = await rpcFails(admin, 'app_delete_inventory_device', { p_device: device.id });
    expect(refused.code).toBe(REJECTED);
    expect(refused.message).toContain(`is with ${person.displayName}`);
    expect(refused.message).toContain('Retired');
    expect(await exists(device.id)).toBe(true);
    // The assignment's own trail is there; the deletion wrote nothing to it.
    const kinds = (await rawRecordEvents('inventory_device', device.id)).map((event) => event.kind);
    expect(kinds).not.toContain('deleted');
  });

  it('refuses a machine a ticket names', async () => {
    const device = await seedInventoryDevice();
    const { ticketId } = await ownedTicket();
    await rpcOk(netrider, 'app_link_ticket_device', { p_ticket: ticketId, p_device: device.id });
    const refused = await rpcFails(admin, 'app_delete_inventory_device', { p_device: device.id });
    expect(refused.code).toBe(REJECTED);
    expect(refused.message).toContain('linked to 1 ticket');
    expect(refused.message).toContain('Retired');
    expect(await exists(device.id)).toBe(true);
  });

  it('refuses a machine with a file attached, so the file is not orphaned', async () => {
    const device = await seedInventoryDevice();
    const { error } = await adminServiceClient()
      .from('attachments')
      .insert({
        device_id: device.id,
        path: `device/${device.id}/lid-${crypto.randomUUID().slice(0, 6)}.jpg`,
        filename: 'lid.jpg',
        mime: 'image/jpeg',
        bytes: 1024,
        uploaded_by: identity('admin').id,
      });
    if (error) throw new Error(error.message);
    const refused = await rpcFails(admin, 'app_delete_inventory_device', { p_device: device.id });
    expect(refused.code).toBe(REJECTED);
    expect(refused.message).toContain('has a file attached');
    expect(await exists(device.id)).toBe(true);
    expect(await rawInventoryEvents('device', device.id)).toHaveLength(0);
  });
});
