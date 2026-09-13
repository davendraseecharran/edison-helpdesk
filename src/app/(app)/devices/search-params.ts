/**
 * Inventory filters carried in the URL. See `people/search-params.ts` for why.
 */

import type { DeviceFilters, HolderFilter } from '@/lib/data/devices';
import { isDeviceStatus } from '@/lib/domain/types';
import { firstParam, pageParam, type SearchParamValue } from '../people/search-params';

export interface DeviceSearchParams {
  query?: SearchParamValue;
  type?: SearchParamValue;
  status?: SearchParamValue;
  location?: SearchParamValue;
  holder?: SearchParamValue;
  page?: SearchParamValue;
}

const HOLDER_FILTERS: HolderFilter[] = ['student', 'staff', 'none'];

export function isHolderFilter(value: unknown): value is HolderFilter {
  return typeof value === 'string' && (HOLDER_FILTERS as string[]).includes(value);
}

export function toDeviceFilters(params: DeviceSearchParams): DeviceFilters {
  const status = firstParam(params.status);
  const holder = firstParam(params.holder);
  return {
    query: firstParam(params.query),
    type: firstParam(params.type),
    // Validated here rather than passed through, for the same reason as a
    // ticket category: an unknown value would silently match nothing.
    status: isDeviceStatus(status) ? status : undefined,
    location: firstParam(params.location),
    holder: isHolderFilter(holder) ? holder : undefined,
    page: pageParam(params.page),
  };
}
