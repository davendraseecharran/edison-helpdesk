import 'server-only';

/**
 * The directory filter as a list of people to write to, copy, or export.
 *
 * The list on screen is one page of fifty and the thing somebody is about to
 * mail is the whole filter, so this is a second read rather than a slice of the
 * first: `app_people_addressees` answers the same kind and the same search
 * `app_list_people` ran, with only the fields an address line, a clipboard line
 * or a CSV row is made of, and at most five hundred of them.
 *
 * It is SECURITY DEFINER behind an active-account gate like every other
 * directory read, so nothing here decides who may see a roster; what this
 * module decides is the SHAPE, and the shape is deliberately narrow. Notes,
 * home addresses and home phones are on a person's own page, one click away,
 * for the one person somebody actually needs them for.
 */

import { createClient } from '@/lib/supabase/server';
import { CSV_ROW_CAP } from '@/lib/csv';
import { PEOPLE_PAGE_SIZE } from '@/lib/data/people';
import { ADDRESSEE_CAP, type PersonAddressee } from '@/lib/people/clipboard';
import type { PersonKind } from '@/lib/domain/types';

export { ADDRESSEE_CAP };

/**
 * An addressee plus the one placement field a spreadsheet wants: a student's
 * official class, a member of staff's department. The menus ignore them; the
 * CSV is the only reader.
 */
export interface AddresseeRow extends PersonAddressee {
  officialClass: string | null;
  department: string | null;
}

export interface AddresseeFilters {
  kind: PersonKind;
  query?: string;
  /** A selection somebody ticked, instead of the whole filter. */
  ids?: string[] | null;
}

export interface AddresseePage {
  people: AddresseeRow[];
  /** How many the filter matches, which can be more than came back. */
  total: number;
  /** True when the filter matched more than the cap. */
  capped: boolean;
}

export const NO_ADDRESSEES: AddresseePage = { people: [], total: 0, capped: false };

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** One row of the RPC's `rows` array, in the application's own vocabulary. */
export function addresseeFromRow(row: Record<string, unknown>): AddresseeRow {
  return {
    id: String(row.id),
    displayName: text(row.displayName),
    // Empty is how the projection spells "not recorded", and null is how the
    // rest of this application does. Converting here means every reader tests
    // one thing rather than two.
    email: text(row.email) || null,
    externalId: text(row.externalId) || null,
    kind: row.kind === 'staff' ? 'staff' : 'student',
    guardianName: text(row.guardianName) || null,
    guardianPhone: text(row.guardianPhone) || null,
    officialClass: text(row.officialClass) || null,
    department: text(row.department) || null,
  };
}

/**
 * Everybody one filter matches, up to the cap.
 *
 * A failure is an empty page rather than a throw: this is read when a menu is
 * opened, and a directory that could not answer should leave the menu saying
 * there is nobody rather than replacing the screen with an error.
 */
export async function loadPeopleAddressees(filters: AddresseeFilters): Promise<AddresseePage> {
  const supabase = await createClient();
  const ids = filters.ids && filters.ids.length > 0 ? filters.ids : null;

  const { data, error } = await supabase.rpc('app_people_addressees', {
    p_kind: filters.kind,
    p_query: filters.query?.trim() ?? '',
    p_ids: ids,
  });
  if (error || !data) return NO_ADDRESSEES;

  const payload = data as { rows?: unknown; total?: unknown; capped?: unknown };
  const rows = Array.isArray(payload.rows) ? (payload.rows as Record<string, unknown>[]) : [];
  return {
    people: rows.map(addresseeFromRow),
    total: Number(payload.total ?? rows.length),
    capped: payload.capped === true,
  };
}

/**
 * Everybody a filter matches, for the CSV: the whole list, not the first five
 * hundred of it.
 *
 * A selection is one call to `app_people_addressees`, because a selection is at
 * most a page of ticked rows. A filter is walked page by page through
 * `app_list_people` — the same reader the screen uses, so the file holds exactly
 * what the list showed — up to the cap every export in this application shares.
 * The alternative would have been a second cap on the addressee read, and then
 * two different answers to "how much is too much".
 */
export async function loadPeopleForExport(
  filters: AddresseeFilters,
): Promise<{ people: AddresseeRow[]; total: number; capped: boolean }> {
  if (filters.ids && filters.ids.length > 0) {
    const page = await loadPeopleAddressees(filters);
    return { people: page.people, total: page.total, capped: page.capped };
  }

  const supabase = await createClient();
  const rows: AddresseeRow[] = [];
  let total = 0;
  let reachedEnd = false;

  for (let page = 1; rows.length < CSV_ROW_CAP && !reachedEnd; page += 1) {
    const { data, error } = await supabase.rpc('app_list_people', {
      p_kind: filters.kind,
      p_query: filters.query?.trim() ?? '',
      p_page: page,
    });
    if (error || !data) break;

    const payload = data as { rows?: unknown; total?: unknown; pageSize?: unknown };
    const batch = Array.isArray(payload.rows) ? (payload.rows as Record<string, unknown>[]) : [];
    if (page === 1) total = Number(payload.total ?? batch.length);
    rows.push(...batch.slice(0, CSV_ROW_CAP - rows.length).map(addresseeFromRow));
    reachedEnd = batch.length < Number(payload.pageSize || PEOPLE_PAGE_SIZE);
  }

  return { people: rows, total, capped: !reachedEnd && total > rows.length };
}

/**
 * Records that a directory list left the building. The count, never the content.
 *
 * The outcome is returned rather than swallowed, and the route refuses the
 * export when it fails: an export nobody can see afterwards is the one thing
 * this function exists to make impossible, so a history that would not take the
 * entry stops the file rather than letting it through unrecorded.
 */
export async function logPeopleExport(
  kind: PersonKind,
  count: number,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('app_log_people_export', {
    p_kind: kind,
    p_count: count,
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}
