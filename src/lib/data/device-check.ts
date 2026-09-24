import 'server-only';

/**
 * Reads behind the device check and the label printer.
 *
 * Both start from what is printed on a machine and need the record, not a
 * search: the check to answer "who has this", the label printer to put the
 * tag, the serial and the model on paper. Everything goes through the same
 * SECURITY DEFINER readers the device page uses (`app_lookup_inventory_code`,
 * `app_get_inventory_device`) and the same row policies for tickets and
 * history, so neither can show more than the device page would.
 */

import { createClient } from '@/lib/supabase/server';
import { mapInventoryDevice, mapPerson, mapRecordEvent, mapRecordTicket } from '@/lib/data/mapping';
import type { DeviceJson, PersonJson, RecordEventRow, RecordTicketRow } from '@/lib/data/mapping';
import { assignedAtFrom, isOpenTicket, type CheckResult } from '@/lib/domain/device-check';
import { deviceLabel, type Device } from '@/lib/domain/types';
import type { LabelDevice } from '@/lib/labels/layout';
import { personFrom } from '@/lib/workflows/session';

type Client = Awaited<ReturnType<typeof createClient>>;

/** The machines answering to one printed code: none, one, or the ones that share it. */
export async function lookupCode(
  supabase: Client,
  code: string,
): Promise<Array<{ id: string; label: string }> | null> {
  const { data, error } = await supabase.rpc('app_lookup_inventory_code', { p_code: code.trim() });
  if (error) return null;
  return (Array.isArray(data) ? data : [])
    .map((row) => row as { id?: unknown; label?: unknown })
    .filter((row) => typeof row.id === 'string')
    .map((row) => ({ id: String(row.id), label: typeof row.label === 'string' ? row.label : String(row.id) }));
}

async function getDevice(supabase: Client, id: string): Promise<Device | null> {
  const { data, error } = await supabase.rpc('app_get_inventory_device', { p_id: id });
  if (error || !data) return null;
  return mapInventoryDevice(data as DeviceJson);
}

/** Runs `step` over `items` with at most `limit` in flight, keeping the order. */
async function inBatches<T, R>(items: readonly T[], limit: number, step: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await step(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function toLabelDevice(device: Device): LabelDevice {
  return {
    id: device.id,
    code: deviceLabel(device),
    assetTag: device.assetTag,
    serialNumber: device.serialNumber,
    manufacturer: device.manufacturer,
    model: device.model,
    deviceType: device.deviceType,
  };
}

/** The machines for these ids, in the order given; ids that name nothing are left out. */
export async function loadLabelDevices(ids: readonly string[]): Promise<LabelDevice[]> {
  if (ids.length === 0) return [];
  const supabase = await createClient();
  const devices = await inBatches(ids, 12, (id) => getDevice(supabase, id));
  return devices.filter((device): device is Device => device !== null).map(toLabelDevice);
}

export interface CodesResult {
  found: LabelDevice[];
  unknown: string[];
  ambiguous: string[];
}

/** Printed codes to machines, exact matches only, in the order they were given. */
export async function loadLabelDevicesByCodes(codes: readonly string[]): Promise<CodesResult> {
  const supabase = await createClient();
  const matches = await inBatches(codes, 12, async (code) => ({ code, rows: await lookupCode(supabase, code) }));
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const ids: string[] = [];
  for (const { code, rows } of matches) {
    if (!rows || rows.length === 0) unknown.push(code);
    else if (rows.length > 1) ambiguous.push(code);
    else ids.push(rows[0].id);
  }
  const found = await loadLabelDevices([...new Set(ids)]);
  return { found, unknown, ambiguous };
}

/**
 * The whole check for one machine: the record, its holder's directory entry,
 * the open tickets this account may see, and the last three history lines.
 */
export async function checkDeviceById(id: string, code = ''): Promise<CheckResult> {
  const supabase = await createClient();
  const device = await getDevice(supabase, id);
  if (!device) return { kind: 'unknown', code: code || id };

  const [links, events, holder] = await Promise.all([
    supabase
      .from('ticket_devices')
      .select('linked_at, tickets!inner(id, number, title, status, created_at)')
      .eq('device_id', id)
      .order('linked_at', { ascending: false })
      .limit(25),
    supabase
      .from('record_events')
      .select('id, entity_type, entity_id, kind, actor_id, performed_via, ai_model, at, summary, detail')
      .eq('entity_type', 'inventory_device')
      .eq('entity_id', id)
      .order('at', { ascending: false })
      .limit(20),
    device.assignedRequesterId
      ? supabase.rpc('app_get_person', { p_id: device.assignedRequesterId })
      : Promise.resolve({ data: null, error: null }),
  ]);

  const tickets = ((links.data ?? []) as Array<{ tickets: RecordTicketRow | RecordTicketRow[] | null }>)
    .flatMap((row) => (Array.isArray(row.tickets) ? row.tickets : row.tickets ? [row.tickets] : []))
    .map(mapRecordTicket)
    .filter(isOpenTicket);
  const history = ((events.data ?? []) as RecordEventRow[]).map(mapRecordEvent);
  const person = holder.data ? mapPerson(holder.data as PersonJson) : null;

  return {
    kind: 'device',
    code: code || deviceLabel(device),
    device: {
      id: device.id,
      label: deviceLabel(device),
      assetTag: device.assetTag,
      serialNumber: device.serialNumber,
      externalId: device.externalId,
      deviceType: device.deviceType,
      manufacturer: device.manufacturer,
      model: device.model,
      status: device.status,
      location: device.location,
      version: device.version,
      updatedAt: device.updatedAt,
      holder:
        device.assignedRequesterId && device.assignedName
          ? {
              id: device.assignedRequesterId,
              name: device.assignedName,
              kind: device.assignedKind ?? person?.kind ?? 'staff',
              externalId: person?.externalId ?? '',
            }
          : null,
      assignedAt: device.assignedRequesterId ? assignedAtFrom(history) : null,
      openTickets: tickets,
      recent: history.slice(0, 3),
    },
  };
}

/** A scanned or typed code, answered: a machine, a choice of two, a person's card, or nothing. */
export async function checkCode(code: string): Promise<CheckResult> {
  const trimmed = code.trim();
  if (trimmed === '') return { kind: 'unknown', code: trimmed };
  const supabase = await createClient();
  const rows = await lookupCode(supabase, trimmed);
  if (rows === null) {
    return { kind: 'error', code: trimmed, message: 'The inventory could not be read. Scan it again.' };
  }
  if (rows.length === 1) return checkDeviceById(rows[0].id, trimmed);
  if (rows.length > 1) return { kind: 'ambiguous', code: trimmed, options: rows.slice(0, 6) };

  // Not a machine. It may be the card of the person holding one.
  const { data } = await supabase.rpc('app_workflow_find_person', { p_code: trimmed });
  const person = personFrom(data);
  if (person) return { kind: 'person', code: trimmed, person };
  return { kind: 'unknown', code: trimmed };
}
