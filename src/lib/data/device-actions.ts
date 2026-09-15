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
import type { ManagedDevice } from '@/lib/inventory/types';

/**
 * One machine, whole, as `app_get_inventory_device` returns it.
 *
 * Folded in from `inventory-management-actions.ts`, which held a parallel set
 * of directory and inventory server actions that nothing else in the
 * application still called: this one function was the last of them with a
 * caller, and a file kept alive by one import is a second place for the next
 * person to add an inventory action to.
 *
 * `returnDeviceAction` needs it because `app_save_inventory_device` states the
 * whole record — the return has to read what is there before it can write back
 * everything except the assignment.
 */
async function getManagedDevice(id: string): Promise<ManagedDevice> {
  const actor = await loadActor();
  if (actor.kind !== 'active') throw new Error('Sign in again to read the inventory.');
  const db = await createClient();
  const { data, error } = await db.rpc('app_get_inventory_device', { p_id: id });
  if (error) throw new Error(error.message);
  return data as ManagedDevice;
}

export interface DeviceSearchResult {
  id: string;
  /** Asset tag, else serial, else the inventory id: how the machine is named. */
  label: string;
  /** The tag itself, which is not always what the label fell back to. */
  assetTag: string | null;
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
      assetTag: device.assetTag || null,
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

/**
 * Hand a cart to a class, or take one back.
 *
 * Status and location have a bulk RPC of their own because they are a patch:
 * one statement over a list of ids. Assignment does not — each hand-over writes
 * an `inventory_events` row, a holder and a status together, and the version
 * check that stops two people assigning the same machine is per machine. So
 * these walk the selection and call the single-device RPC for each one, and
 * report what actually happened rather than what was asked for.
 *
 * A failure stops the walk. The alternative is carrying on and reporting "9 of
 * 12", which leaves somebody to work out which three — and the usual reason to
 * fail is that the selection is stale, which will fail for the rest too.
 */
async function walkSelection(
  ids: string[],
  step: (id: string) => Promise<ActionResult>,
  done: (count: number) => string,
): Promise<RpcResult> {
  let count = 0;
  for (const id of ids) {
    const result = await step(id);
    if (!result.ok) {
      return {
        ok: false,
        error:
          count === 0
            ? result.error
            : `${result.error} ${count === 1 ? '1 device was' : `${count} devices were`} changed before that.`,
        count,
      };
    }
    count += 1;
  }
  return { ok: true, count, message: done(count) };
}

export async function bulkAssignDevicesAction(
  ids: string[],
  personId: string,
  note?: string | null,
): Promise<RpcResult> {
  return walkSelection(
    ids,
    (id) => assignDeviceAction(id, personId, note ?? null, null),
    (count) => `${count === 1 ? '1 device' : `${count} devices`} assigned.`,
  );
}

export async function bulkReturnDevicesAction(
  ids: string[],
  status = 'Available',
  note?: string | null,
): Promise<RpcResult> {
  return walkSelection(
    ids,
    (id) => returnDeviceAction(id, status, note ?? null, null),
    (count) => `${count === 1 ? '1 device' : `${count} devices`} returned.`,
  );
}

/**
 * Put one machine back to Available from a row that is only a summary.
 *
 * `app_bulk_update_inventory` was doing this, and it takes no version: a bulk
 * change is a deliberate "apply this to all of these", so it cannot offer the
 * optimistic lock that every single-machine edit in this application has. From
 * Today that was the wrong trade — one machine, one press, and somebody else may
 * have assigned it while the screen was open.
 *
 * So the owner's editor does it instead. The untouched fields come from a fresh
 * read, because `app_save_inventory_device` is a whole-record replace and
 * sending blanks would erase a location and a note; the VERSION is the one the
 * row on screen was rendered at, so a machine that changed in between is refused
 * with the inventory's own sentence rather than quietly overwritten.
 */
export async function markDeviceAvailableAction(
  deviceId: string,
  version: number | null,
  status = 'Available',
): Promise<ActionResult> {
  let current: ManagedDevice;
  try {
    current = await getManagedDevice(deviceId);
  } catch {
    return { ok: false, error: 'That machine could not be read. Reload the page and try again.' };
  }
  if (!current || typeof current.id !== 'string') {
    return { ok: false, error: 'That machine is no longer in the inventory.' };
  }

  return callRpc(
    'app_save_inventory_device',
    {
      p_id: deviceId,
      p_version: version,
      p_data: {
        deviceType: current.deviceType,
        manufacturer: current.manufacturer,
        model: current.model,
        osVersion: current.osVersion,
        serialNumber: current.serialNumber,
        assetTag: current.assetTag,
        status,
        location: current.location,
        notes: current.notes,
        assignedRequesterId: current.assignedRequesterId,
      },
    },
    'Device marked available.',
  );
}
