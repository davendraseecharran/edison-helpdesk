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
import {
  mapDeviceDetail,
  mapDeviceSummary,
  type DeviceDetailPayload,
  type DeviceSummaryRow,
} from './mapping';

export const DEVICES_PAGE_SIZE = 25;

/** The most rows a list page or an export may ask the database for at once. */
export const DEVICES_RPC_LIMIT = 100;

export type HolderFilter = 'student' | 'staff' | 'none';

export interface DeviceFilters {
  query?: string;
  type?: string;
  status?: string;
  location?: string;
  /** `none` is a device nobody is holding: in stock, in repair, retired, lost or surplus. */
  holder?: HolderFilter;
  page?: number;
}

export interface DevicesPage {
  devices: DeviceSummary[];
  total: number;
  page: number;
  pageCount: number;
}

function optional(value: string | undefined): string | null {
  if (!value || value.trim() === '' || value === 'all') return null;
  return value;
}

/** The RPC arguments for one page of `filters`, shared with the CSV export. */
export function deviceListArgs(
  filters: DeviceFilters,
  limit: number,
  offset: number,
): Record<string, unknown> {
  return {
    p_query: optional(filters.query),
    p_type: optional(filters.type),
    p_status: optional(filters.status),
    p_location: optional(filters.location),
    p_holder_kind: filters.holder ?? null,
    p_limit: limit,
    p_offset: offset,
  };
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
