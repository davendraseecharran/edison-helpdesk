/**
 * The inventory list's filters and how they become RPC arguments. Pure, and
 * shared by the list loader and the CSV export so a filtered export contains
 * exactly what the list showed.
 */

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

/** A filter the screen is not applying (blank or "all") is sent as NULL, which the RPC reads as every value. */
export function optionalFilter(value: string | undefined): string | null {
  if (!value || value.trim() === '' || value === 'all') return null;
  return value;
}

/** The RPC arguments for one page of `filters`. */
export function deviceListArgs(
  filters: DeviceFilters,
  limit: number,
  offset: number,
): Record<string, unknown> {
  return {
    p_query: optionalFilter(filters.query),
    p_type: optionalFilter(filters.type),
    p_status: optionalFilter(filters.status),
    p_location: optionalFilter(filters.location),
    p_holder_kind: filters.holder ?? null,
    p_limit: limit,
    p_offset: offset,
  };
}
