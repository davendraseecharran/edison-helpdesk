/**
 * Directory filters carried in the URL, so a filtered list is shareable,
 * survives a refresh, and is applied by the database rather than to a
 * client-side copy of the roster.
 */

import type { PeopleFilters } from '@/lib/data/people';
import { isPersonKind } from '@/lib/domain/types';

export type SearchParamValue = string | string[] | undefined;

export interface PeopleSearchParams {
  query?: SearchParamValue;
  kind?: SearchParamValue;
  department?: SearchParamValue;
  classOf?: SearchParamValue;
  archived?: SearchParamValue;
  page?: SearchParamValue;
}

export function firstParam(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A page number from the URL: a positive safe integer, bounded, else 1. */
export function pageParam(value: SearchParamValue): number {
  const page = Number.parseInt(firstParam(value) ?? '1', 10);
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000_000) : 1;
}

export function toPeopleFilters(params: PeopleSearchParams): PeopleFilters {
  const kind = firstParam(params.kind);
  const archived = firstParam(params.archived);
  return {
    query: firstParam(params.query),
    // A kind the vocabulary does not know is dropped rather than sent: the
    // database would match nothing, and a mistyped link would look like an
    // empty roster with no way to tell why.
    kind: isPersonKind(kind) ? kind : undefined,
    department: firstParam(params.department),
    classOf: firstParam(params.classOf),
    // "Show archived" includes them beside the active roster. Only the exact
    // value the toggle writes turns it on.
    active: archived === '1' ? 'all' : 'true',
    page: pageParam(params.page),
  };
}
