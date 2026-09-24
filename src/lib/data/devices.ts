import 'server-only';

/**
 * Authorized inventory reads.
 *
 * `public.inventory_devices` carries row-level security with no policies at
 * all: in the owner's design every read of the 4,278 machines goes through a
 * SECURITY DEFINER function, and `app_list_inventory` and
 * `app_get_inventory_device` are those functions. Their gate is an active
 * account, the same one the directory answers to.
 *
 * What they do not carry is a machine's tickets or its history, which the
 * device page reads for itself: `public.ticket_devices` is a child of the
 * ticket and is policed by app_can_view_ticket, so the join below shows a
 * technician only the tickets they are already entitled to see.
 */

import { createClient } from '@/lib/supabase/server';
import type { DeviceCatalogEntry, DeviceDetail, DeviceSummary } from '@/lib/domain/types';
import { deviceLabel, SEED_DEVICE_STATUSES } from '@/lib/domain/types';
import type { DeviceSearchResult } from '@/lib/data/device-actions';
import {
  mapDeviceCatalogEntry,
  mapInventoryDevice,
  mapInventoryPage,
  mapRecordEvent,
  mapRecordTicket,
  type DeviceJson,
  type RecordEventRow,
  type RecordTicketRow,
} from './mapping';

export const DEVICES_PAGE_SIZE = 50;

export interface DeviceFilters {
  query?: string;
  /** The owner's one list filter: only the machines assigned to this person. */
  requesterId?: string | null;
  /** Exact matches, from the values actually in the inventory. */
  status?: string | null;
  deviceType?: string | null;
  location?: string | null;
  page?: number;
}

/** The values the inventory actually holds, for the list's own controls. */
export interface DeviceFacets {
  types: string[];
  locations: string[];
}

export interface DevicesPage {
  devices: DeviceSummary[];
  total: number;
  page: number;
  pageCount: number;
}

export async function loadDevices(filters: DeviceFilters = {}): Promise<DevicesPage> {
  const supabase = await createClient();
  const page = Math.max(1, filters.page ?? 1);

  const { data, error } = await supabase.rpc('app_list_inventory', {
    p_query: filters.query?.trim() ?? '',
    p_page: page,
    p_requester: filters.requesterId ?? null,
    p_status: filters.status ?? null,
    p_type: filters.deviceType ?? null,
    p_location: filters.location ?? null,
  });

  if (error) {
    throw new Error(`Could not load the inventory: ${error.message}`);
  }

  const mapped = mapInventoryPage(data as never, mapInventoryDevice);
  if (mapped.rows.length === 0 && page > 1) return loadDevices({ ...filters, page: 1 });

  return {
    devices: mapped.rows,
    total: mapped.total,
    page,
    pageCount: Math.max(1, Math.ceil(mapped.total / (mapped.pageSize || DEVICES_PAGE_SIZE))),
  };
}

/**
 * One machine with its tickets and history, or null when there is no such
 * record OR the caller may not see it.
 */
export async function loadDevice(id: string): Promise<DeviceDetail | null> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('app_get_inventory_device', { p_id: id });
  if (error || !data) return null;

  const [links, events] = await Promise.all([
    supabase
      .from('ticket_devices')
      .select('linked_at, tickets!inner(id, number, title, status, created_at)')
      .eq('device_id', id)
      .order('linked_at', { ascending: false })
      .limit(50),
    supabase
      .from('record_events')
      .select('id, entity_type, entity_id, kind, actor_id, performed_via, ai_model, at, summary, detail')
      .eq('entity_type', 'inventory_device')
      .eq('entity_id', id)
      .order('at', { ascending: false })
      .limit(100),
  ]);

  const tickets = ((links.data ?? []) as Array<{ tickets: RecordTicketRow | RecordTicketRow[] | null }>)
    .flatMap((row) => (Array.isArray(row.tickets) ? row.tickets : row.tickets ? [row.tickets] : []))
    .map(mapRecordTicket);

  return {
    device: mapInventoryDevice(data as DeviceJson),
    tickets,
    events: ((events.data ?? []) as RecordEventRow[]).map(mapRecordEvent),
  };
}

/**
 * One machine as the ticket form's device picker names it, for a ticket
 * started from that machine. Null for an id that names nothing.
 */
export async function loadDeviceRef(id: string): Promise<DeviceSearchResult | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_get_inventory_device', { p_id: id });
  if (error || !data) return null;
  const device = mapInventoryDevice(data as DeviceJson);
  return {
    id: device.id,
    label: deviceLabel(device),
    assetTag: device.assetTag || null,
    serialNumber: device.serialNumber || null,
    type: device.deviceType,
    model: device.model || null,
    status: device.status,
    holderName: device.assignedName,
  };
}

/**
 * The statuses the inventory screen offers: every value in use, plus the five
 * the database seeds. Free text underneath, so this is a vocabulary rather
 * than a constraint.
 */
export async function loadDeviceStatuses(): Promise<string[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_inventory_statuses');
  if (error || !Array.isArray(data)) return [...SEED_DEVICE_STATUSES];
  return (data as unknown[]).filter((value): value is string => typeof value === 'string');
}

/**
 * The device types and locations the inventory actually holds.
 *
 * Read rather than guessed: `inventory_devices.location` is free text and the
 * district's rooms and carts are not a vocabulary anybody wrote down. An empty
 * list is not an error — it is an inventory with nothing in that column yet,
 * and the control hides itself rather than offering a filter with no values.
 */
export async function loadDeviceFacets(): Promise<DeviceFacets> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_inventory_facets');
  if (error || !data || typeof data !== 'object') return { types: [], locations: [] };
  const record = data as { types?: unknown; locations?: unknown };
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return { types: strings(record.types), locations: strings(record.locations) };
}

/** The catalogue of type, manufacturer and model tuples the editor offers. */
export async function loadDeviceCatalog(): Promise<DeviceCatalogEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_device_catalog');
  if (error || !data) return [];
  return (data as Array<{ device_type: string; manufacturer: string; model: string }>).map(
    mapDeviceCatalogEntry,
  );
}
