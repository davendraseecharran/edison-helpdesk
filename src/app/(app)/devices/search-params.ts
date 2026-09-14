/**
 * Inventory filters carried in the URL. See `people/search-params.ts` for why.
 *
 * `app_list_inventory` searches every field of a machine and its holder at
 * once, and takes one optional filter: the person holding it. The type, status
 * and location facets the M5 list offered have no counterpart, because the
 * inventory's status is free text and the search already covers a room name or
 * a model.
 */

import type { DeviceFilters } from '@/lib/data/devices';
import { firstParam, pageParam, type SearchParamValue } from '../people/search-params';

export interface DeviceSearchParams {
  query?: SearchParamValue;
  requester?: SearchParamValue;
  page?: SearchParamValue;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toDeviceFilters(params: DeviceSearchParams): DeviceFilters {
  const requester = firstParam(params.requester);
  return {
    query: firstParam(params.query),
    // Validated here rather than passed through: a value that is not an id
    // would make the database raise rather than show an empty inventory.
    requesterId: requester && UUID.test(requester) ? requester : null,
    page: pageParam(params.page),
  };
}
