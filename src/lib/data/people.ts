import 'server-only';

/**
 * Authorized directory reads.
 *
 * Every query runs through the signed-in user's own client, so row-level
 * security decides the rows: an account that is not active gets nothing, and
 * nothing here filters in JavaScript for security. Search, filtering, ordering,
 * counting and pagination all happen inside `app_list_people`, which is
 * SECURITY INVOKER and therefore still subject to RLS.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { PersonDetail, PersonKind, PersonSummary } from '@/lib/domain/types';
import {
  mapPersonDetail,
  mapPersonSummary,
  type PersonDetailPayload,
  type PersonSummaryRow,
} from './mapping';

export const PEOPLE_PAGE_SIZE = 25;

export interface PeopleFilters {
  query?: string;
  kind?: PersonKind;
  department?: string;
  classOf?: string;
  /**
   * `true` (the default) lists the active roster, `false` the archived records
   * only, and `all` both together. Archived people are not what somebody means
   * when they search the directory, so they are opt-in.
   */
  active?: 'true' | 'false' | 'all';
  page?: number;
}

export interface PeoplePage {
  people: PersonSummary[];
  total: number;
  page: number;
  pageCount: number;
}

function optional(value: string | undefined): string | null {
  if (!value || value.trim() === '' || value === 'all') return null;
  return value;
}

export async function loadPeople(filters: PeopleFilters = {}): Promise<PeoplePage> {
  const supabase = await createClient();
  const page = Math.max(1, filters.page ?? 1);

  const { data, error } = await supabase.rpc('app_list_people', {
    p_query: optional(filters.query),
    p_kind: filters.kind ?? null,
    p_department: optional(filters.department),
    p_class_of: optional(filters.classOf),
    // NULL means every value; the database's own default is the active roster.
    p_active: filters.active === 'all' ? null : filters.active !== 'false',
    p_limit: PEOPLE_PAGE_SIZE,
    p_offset: (page - 1) * PEOPLE_PAGE_SIZE,
  });

  if (error) {
    throw new Error(`Could not load the directory: ${error.message}`);
  }

  const rows = (data ?? []) as PersonSummaryRow[];
  // A person may leave the last page while somebody else edits. Return to the
  // first page instead of showing a false zero with no way back.
  if (rows.length === 0 && page > 1) return loadPeople({ ...filters, page: 1 });

  const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
  return {
    people: rows.map(mapPersonSummary),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PEOPLE_PAGE_SIZE)),
  };
}

/**
 * One person with their devices, tickets and history, or null when there is
 * no such record OR the caller may not see it. The two are deliberately
 * indistinguishable, matching the database contract.
 */
export async function loadPerson(id: string): Promise<PersonDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_person_detail', { p_person: id });
  if (error || !data) return null;
  return mapPersonDetail(data as PersonDetailPayload);
}

export interface PeopleFacets {
  departments: string[];
  classYears: string[];
}

/** The filter options the directory offers, taken from the active roster. */
export const loadPeopleFacets = cache(async (): Promise<PeopleFacets> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_people_facets');
  if (error || !data) return { departments: [], classYears: [] };
  const payload = data as { departments?: string[]; class_years?: string[] };
  return {
    departments: payload.departments ?? [],
    classYears: payload.class_years ?? [],
  };
});
