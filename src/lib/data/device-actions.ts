'use server';

/**
 * Inventory lookups and mutations for the application.
 *
 * The type-ahead finds one machine while somebody types, so a technician can
 * name it on a ticket; the inventory screen reads `app_list_inventory`
 * server-side (`devices.ts`).
 *
 * Every mutation calls a SECURITY DEFINER RPC with the signed-in user's own
 * JWT. `app_save_inventory_device` is the owner's editor and enforces the
 * optimistic lock and the serial-number rule; assignment, return and the bulk
 * change are `20260914130000`'s, and each writes both the owner's
 * inventory_events snapshot and the sentence a person reads.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import { bulkResultMessage, shapeBulkPatch, type BulkDevicePatch } from '@/lib/data/device-bulk';
import { callRpc, type RpcResult } from '@/lib/data/rpc';
import { mapInventoryDevice, mapInventoryPage } from '@/lib/data/mapping';
import { deviceLabel, type DeviceInput, type DeviceStatus } from '@/lib/domain/types';

export interface DeviceSearchResult {
  id: string;
  /** Asset tag, else serial, else the inventory id: how the machine is named. */
  label: string;
  serialNumber: string | null;
  type: string;
  model: string | null;
  status: DeviceStatus;
  holderName: string | null;
}

export async function searchDevicesAction(query: string): Promise<DeviceSearchResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const actor = await loadActor();
  if (actor.kind !== 'active') return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_inventory', {
    p_query: term,
    p_page: 1,
    p_requester: null,
  });
  if (error) return [];

  // The list RPC pages at fifty; a type-ahead shows the first few and asks the
  // operator to narrow the term rather than scrolling a page of results.
  return mapInventoryPage(data as never, mapInventoryDevice)
    .rows.slice(0, 8)
    .map((device) => ({
      id: device.id,
      label: deviceLabel(device),
      serialNumber: device.serialNumber || null,
      type: device.deviceType,
      model: device.model || null,
      status: device.status,
      holderName: device.assignedName,
    }));
}

/**
 * The code printed on a machine, resolved to the machine.
 *
 * Exact matches only, across the inventory id, the asset tag and the serial.
 * A code that names two machines returns nothing rather than a guess: a
 * scanner has nobody to ask which one the operator is holding.
 */
export async function lookupDeviceCodeAction(
  code: string,
): Promise<{ id: string; label: string } | null> {
  const term = code.trim();
  if (!term) return null;

  const actor = await loadActor();
  if (actor.kind !== 'active') return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_lookup_inventory_code', { p_code: term });
  if (error || !Array.isArray(data) || data.length !== 1) return null;
  const row = data[0] as { id: string; label: string };
  return { id: row.id, label: row.label };
}

export async function saveDeviceAction(
  input: DeviceInput & { id?: string | null; version?: number | null },
): Promise<ActionResult & { id?: string }> {
  const { id, version, ...fields } = input;
  return callRpc(
    'app_save_inventory_device',
    {
      p_id: id ?? null,
      p_version: version ?? null,
      p_data: {
        deviceType: fields.deviceType,
        manufacturer: fields.manufacturer,
        model: fields.model,
        osVersion: fields.osVersion,
        serialNumber: fields.serialNumber,
        assetTag: fields.assetTag,
        status: fields.status,
        location: fields.location,
        notes: fields.notes,
        assignedRequesterId: fields.assignedRequesterId,
      },
    },
    id ? 'Device saved.' : 'Device added to the inventory.',
  );
}

export async function assignDeviceAction(
  deviceId: string,
  personId: string,
  note?: string | null,
  version?: number | null,
): Promise<ActionResult> {
  return callRpc(
    'app_assign_inventory_device',
    {
      p_device: deviceId,
      p_requester: personId,
      p_note: note ?? null,
      p_version: version ?? null,
    },
    'Device assigned.',
  );
}

export async function returnDeviceAction(
  deviceId: string,
  status = 'Available',
  note?: string | null,
  version?: number | null,
): Promise<ActionResult> {
  return callRpc(
    'app_return_inventory_device',
    {
      p_device: deviceId,
      p_status: status,
      p_note: note ?? null,
      p_version: version ?? null,
    },
    'Device returned.',
  );
}

export async function bulkUpdateDevicesAction(
  ids: string[],
  patch: BulkDevicePatch,
): Promise<RpcResult> {
  return callRpc(
    'app_bulk_update_inventory',
    { p_ids: ids, p_patch: shapeBulkPatch(patch) },
    // The database says how many machines it actually changed; the toast
    // reports that rather than how many were selected.
    (result) => bulkResultMessage(patch, result.count ?? ids.length),
  );
}
