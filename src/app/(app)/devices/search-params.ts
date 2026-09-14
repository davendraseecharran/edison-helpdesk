/**
 * Inventory filters carried in the URL. See `people/search-params.ts` for why.
 *
 * `app_list_inventory` searches every field of a machine and its holder at
 * once, and takes four exact filters beside it: the person holding it, and the
 * status, type and location facets. They are exact because the search is not —
 * "repair" as a term also matches a note, a model name and a room, so "every
 * Chromebook in repair" needs the columns, not the haystack.
 */

import type { DeviceFilters } from '@/lib/data/devices';
import { firstParam, pageParam, type SearchParamValue } from '../people/search-params';

export interface DeviceSearchParams {
  query?: SearchParamValue;
  requester?: SearchParamValue;
  status?: SearchParamValue;
  type?: SearchParamValue;
  location?: SearchParamValue;
  page?: SearchParamValue;
}

/** A facet value from the URL: trimmed, bounded, and empty means "any". */
function facetParam(value: SearchParamValue): string | null {
  const first = firstParam(value)?.trim();
  return first && first.length <= 120 ? first : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toDeviceFilters(params: DeviceSearchParams): DeviceFilters {
  const requester = firstParam(params.requester);
  return {
    query: firstParam(params.query),
    // Validated here rather than passed through: a value that is not an id
    // would make the database raise rather than show an empty inventory.
    requesterId: requester && UUID.test(requester) ? requester : null,
    status: facetParam(params.status),
    deviceType: facetParam(params.type),
    location: facetParam(params.location),
    page: pageParam(params.page),
  };
}
