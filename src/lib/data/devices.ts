import 'server-only';

/**
 * Authorized inventory reads.
 *
 * Same contract as the directory: the signed-in user's own client, RLS decides
 * the rows, and `app_list_devices` (SECURITY INVOKER) does the search,
 * filtering, ordering, counting and pagination in the database.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { DeviceDetail, DeviceSummary } from '@/lib/domain/types';
import { deviceListArgs, type DeviceFilters } from './device-filters';
import {
  mapDeviceDetail,
  mapDeviceSummary,
  type DeviceDetailPayload,
  type DeviceSummaryRow,
} from './mapping';

export const DEVICES_PAGE_SIZE = 25;

// The filter shapes and the RPC argument builder are pure and live in
// `device-filters.ts`, so the export and the unit tests can use them without
// importing this server-only module. Re-exported here so callers keep one
// import for inventory reads.
export { DEVICES_RPC_LIMIT, deviceListArgs } from './device-filters';
export type { DeviceFilters, HolderFilter } from './device-filters';

export interface DevicesPage {
  devices: DeviceSummary[];
  total: number;
  page: number;
  pageCount: number;
}

export async function loadDevices(filters: DeviceFilters = {}): Promise<DevicesPage> {
  const supabase = await createClient();
  const page = Math.max(1, filters.page ?? 1);

  const { data, error } = await supabase.rpc(
    'app_list_devices',
    deviceListArgs(filters, DEVICES_PAGE_SIZE, (page - 1) * DEVICES_PAGE_SIZE),
  );

  if (error) {
    throw new Error(`Could not load the inventory: ${error.message}`);
  }

  const rows = (data ?? []) as DeviceSummaryRow[];
  if (rows.length === 0 && page > 1) return loadDevices({ ...filters, page: 1 });

  const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
  return {
    devices: rows.map(mapDeviceSummary),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / DEVICES_PAGE_SIZE)),
  };
}

/**
 * One device with its holder, loan history, tickets and history, or null when
 * there is no such record OR the caller may not see it.
 */
export async function loadDevice(id: string): Promise<DeviceDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_device_detail', { p_device: id });
  if (error || !data) return null;
  return mapDeviceDetail(data as DeviceDetailPayload);
}

export interface DeviceFacets {
  types: string[];
  statuses: string[];
  locations: string[];
}

/** The filter options the inventory offers: types and locations from the rows, statuses fixed. */
export const loadDeviceFacets = cache(async (): Promise<DeviceFacets> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_device_facets');
  if (error || !data) return { types: [], statuses: [], locations: [] };
  const payload = data as { types?: string[]; statuses?: string[]; locations?: string[] };
  return {
    types: payload.types ?? [],
    statuses: payload.statuses ?? [],
    locations: payload.locations ?? [],
  };
});
