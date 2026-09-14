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
import { SEED_DEVICE_STATUSES } from '@/lib/domain/types';
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
  page?: number;
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

/** The catalogue of type, manufacturer and model tuples the editor offers. */
export async function loadDeviceCatalog(): Promise<DeviceCatalogEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_device_catalog');
  if (error || !data) return [];
  return (data as Array<{ device_type: string; manufacturer: string; model: string }>).map(
    mapDeviceCatalogEntry,
  );
}
