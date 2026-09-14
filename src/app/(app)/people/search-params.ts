/**
 * Directory filters carried in the URL, so a filtered list is shareable,
 * survives a refresh, and is applied by the database rather than to a
 * client-side copy of the roster.
 *
 * The district's directory holds 3,448 students and 261 staff, and
 * `app_list_people` takes one kind, one search term and one page number. There
 * is no "everybody" list and no faceted filter: students and staff are two
 * lists, which is how the people who use this talk about them.
 */

import type { PeopleFilters } from '@/lib/data/people';
import { isPersonKind, type PersonKind } from '@/lib/domain/types';

export type SearchParamValue = string | string[] | undefined;

export interface PeopleSearchParams {
  query?: SearchParamValue;
  kind?: SearchParamValue;
  page?: SearchParamValue;
}

export function firstParam(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A page number from the URL: a positive safe integer, bounded, else 1. */
export function pageParam(value: SearchParamValue): number {
  const page = Number.parseInt(firstParam(value) ?? '1', 10);
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100_000) : 1;
}

/** Students unless the URL says staff. A kind the vocabulary does not know is ignored. */
export function kindParam(value: SearchParamValue): PersonKind {
  const kind = firstParam(value);
  return isPersonKind(kind) ? kind : 'student';
}

export function toPeopleFilters(params: PeopleSearchParams): PeopleFilters {
  return {
    kind: kindParam(params.kind),
    query: firstParam(params.query),
    page: pageParam(params.page),
  };
}
