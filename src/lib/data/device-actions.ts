'use server';

/**
 * Inventory lookups and mutations for the application.
 *
 * The type-ahead finds one machine while somebody types, so a technician can
 * name it on a ticket or in a bulk assignment; the inventory screen reads
 * `app_list_devices` server-side with its own filters (`devices.ts`).
 *
 * Every mutation calls one of the reviewed M5 RPCs with the signed-in user's
 * own JWT. The database decides what a status change may do given who is
 * holding the device; nothing here pre-empts or "corrects" that.
 *
 * `app_list_devices` is SECURITY INVOKER, so the row policy decides what comes
 * back. An assignment row names a student, so the inventory is gated exactly as
 * the directory is: an account that is not active gets an empty list.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import { bulkResultMessage, shapeBulkPatch, type BulkDevicePatch } from '@/lib/data/device-bulk';
import { callRpc, type RpcResult } from '@/lib/data/rpc';
import { deviceLabel, type DeviceStatus } from '@/lib/domain/types';

export interface DeviceSearchResult {
  id: string;
  /** Asset tag, else serial, else managed-device id: how the machine is named. */
  label: string;
  serialNumber: string | null;
  type: string;
  model: string | null;
  status: DeviceStatus;
  holderName: string | null;
}

/** How many results a type-ahead shows before an operator should narrow the term. */
const SEARCH_LIMIT = 8;

export async function searchDevicesAction(query: string): Promise<DeviceSearchResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const actor = await loadActor();
  if (actor.kind !== 'active') return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_devices', {
    p_query: term,
    p_limit: SEARCH_LIMIT,
  });
  if (error) return [];

  return ((data ?? []) as Array<{
    id: string;
    device_id: string | null;
    serial_number: string | null;
    asset_tag: string | null;
    type: string;
    model: string | null;
    status: string;
    holder_name: string | null;
  }>).map((row) => ({
    id: row.id,
    // The same order app_device_label uses in the database, so a machine is
    // named the same way in the picker and in the history it ends up in.
    label: deviceLabel({
      assetTag: row.asset_tag,
      serialNumber: row.serial_number,
      deviceId: row.device_id,
    }),
    serialNumber: row.serial_number,
    type: row.type,
    model: row.model,
    status: row.status as DeviceStatus,
    holderName: row.holder_name,
  }));
}

/**
 * The fields a form may send, keyed by the database's own column names so the
 * object goes to `app_upsert_device` as it is: an absent key is left alone and
 * an empty one clears the column.
 */
export interface DeviceFields {
  device_id?: string;
  serial_number?: string;
  asset_tag?: string;
  type?: string;
  manufacturer?: string;
  model?: string;
  os?: string;
  status?: string;
  location?: string;
  notes?: string;
}

const DEVICE_KEYS: Array<keyof DeviceFields> = [
  'device_id', 'serial_number', 'asset_tag', 'type', 'manufacturer', 'model', 'os',
  'status', 'location', 'notes',
];

export async function saveDeviceAction(
  fields: DeviceFields & { id?: string },
): Promise<ActionResult & { id?: string }> {
  const device: Record<string, unknown> = {};
  for (const key of DEVICE_KEYS) {
    if (fields[key] !== undefined) device[key] = fields[key];
  }
  if (fields.id) device.id = fields.id;
  return callRpc(
    'app_upsert_device',
    { p_device: device },
    fields.id ? 'Device saved.' : 'Device added to the inventory.',
  );
}

export async function assignDeviceAction(
  deviceId: string,
  personId: string,
  note?: string | null,
): Promise<ActionResult> {
  return callRpc(
    'app_assign_device',
    { p_device: deviceId, p_person: personId, p_note: note ?? null },
    'Device assigned.',
  );
}

export async function returnDeviceAction(
  deviceId: string,
  status: string = 'in_stock',
  note?: string | null,
): Promise<ActionResult> {
  return callRpc(
    'app_return_device',
    { p_device: deviceId, p_status: status, p_note: note ?? null },
    'Device returned.',
  );
}

export async function setDeviceStatusAction(
  deviceId: string,
  status: string,
  reason?: string | null,
): Promise<ActionResult> {
  return callRpc(
    'app_set_device_status',
    { p_device: deviceId, p_status: status, p_reason: reason ?? null },
    'Status updated.',
  );
}

export async function moveDeviceAction(
  deviceId: string,
  location: string,
): Promise<ActionResult> {
  return callRpc(
    'app_move_device',
    { p_device: deviceId, p_location: location },
    location.trim() ? 'Device moved.' : 'Location cleared.',
  );
}

export async function bulkUpdateDevicesAction(
  ids: string[],
  patch: BulkDevicePatch,
): Promise<RpcResult> {
  return callRpc(
    'app_bulk_update_devices',
    { p_ids: ids, p_patch: shapeBulkPatch(patch) },
    // The database says how many devices it actually changed; the toast
    // reports that rather than how many were selected.
    (result) => bulkResultMessage(patch, result.count ?? ids.length),
  );
}
