import 'server-only';

/**
 * Authorized directory reads.
 *
 * The directory is the district's own `public.requesters` — 3,448 students and
 * 261 staff — and it is read through the owner's `app_list_people` and
 * `app_get_person`. Both are SECURITY DEFINER with an active-account gate,
 * which is how the whole directory surface is reached; nothing here filters in
 * JavaScript for security, and the page size is the database's, not ours.
 *
 * A person's page needs three more things the projection does not carry: the
 * machines they hold, the tickets they asked for, and their history. The first
 * is `app_requester_devices`; the other two are plain reads of
 * `public.tickets` and `public.record_events` through the signed-in user's own
 * client, so the ticket policy decides which of somebody's tickets a viewer is
 * allowed to know about.
 */

import { createClient } from '@/lib/supabase/server';
import { ACTIVE_STATUSES, type PersonDetail, type PersonKind } from '@/lib/domain/types';
import {
  mapInventoryDevice,
  mapInventoryPage,
  mapPerson,
  mapRecordEvent,
  mapRecordTicket,
  type DeviceJson,
  type PersonJson,
  type RecordEventRow,
  type RecordTicketRow,
} from './mapping';
import type { PersonSummary } from '@/lib/domain/types';

/** The owner's list RPC pages at fifty, and says so in every envelope. */
export const PEOPLE_PAGE_SIZE = 50;

export interface PeopleFilters {
  /** Students and staff are separate lists, not a filter over one. */
  kind: PersonKind;
  query?: string;
  page?: number;
}

export interface PeoplePage {
  people: PersonSummary[];
  total: number;
  page: number;
  pageCount: number;
  /**
   * How many tickets of this person's are still live, by person id, for the
   * people on this page. Absent from the map means none — or none this viewer
   * is allowed to know about, which is the same answer as far as the list is
   * concerned.
   */
  openTickets: Record<string, number>;
}

/**
 * The live ticket count for a page of people.
 *
 * A separate read rather than a column on `app_list_people`, and deliberately:
 * that function is SECURITY DEFINER and would have to decide for itself which
 * tickets a viewer may count. This runs as the signed-in user, so the ticket
 * policy answers — a skills officer, who may read the roster and no tickets at
 * all, gets an empty map and a directory with no counts in it, which is the
 * truth for them.
 *
 * One query for the page, not one per row, and a failure is not an error: the
 * directory's job is the roster, and a count that could not be fetched is a
 * count that is not shown.
 */
async function loadOpenTicketCounts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const { data, error } = await supabase
    .from('tickets')
    .select('requester_id')
    .in('requester_id', ids)
    .in('status', ACTIVE_STATUSES);
  if (error || !data) return {};

  const counts: Record<string, number> = {};
  for (const row of data as { requester_id: string | null }[]) {
    if (!row.requester_id) continue;
    counts[row.requester_id] = (counts[row.requester_id] ?? 0) + 1;
  }
  return counts;
}

export async function loadPeople(filters: PeopleFilters): Promise<PeoplePage> {
  const supabase = await createClient();
  const page = Math.max(1, filters.page ?? 1);

  const { data, error } = await supabase.rpc('app_list_people', {
    p_kind: filters.kind,
    p_query: filters.query?.trim() ?? '',
    p_page: page,
  });

  if (error) {
    throw new Error(`Could not load the directory: ${error.message}`);
  }

  const mapped = mapInventoryPage(data as never, mapPerson);
  // Somebody can leave the last page while a colleague is editing. Return to
  // the first page rather than showing a false zero with no way back.
  if (mapped.rows.length === 0 && page > 1) return loadPeople({ ...filters, page: 1 });

  const openTickets = await loadOpenTicketCounts(
    supabase,
    mapped.rows.map((person) => person.id),
  );

  return {
    people: mapped.rows,
    total: mapped.total,
    page,
    pageCount: Math.max(1, Math.ceil(mapped.total / (mapped.pageSize || PEOPLE_PAGE_SIZE))),
    openTickets,
  };
}

/**
 * One person with their machines, tickets and history, or null when there is
 * no such record OR the caller may not see it. The two are deliberately
 * indistinguishable, matching the database contract.
 */
export async function loadPerson(id: string): Promise<PersonDetail | null> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('app_get_person', { p_id: id });
  if (error || !data) return null;

  const [devices, tickets, events] = await Promise.all([
    supabase.rpc('app_requester_devices', { p_requester: id }),
    supabase
      .from('tickets')
      .select('id, number, title, status, created_at')
      .eq('requester_id', id)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('record_events')
      .select('id, entity_type, entity_id, kind, actor_id, performed_via, ai_model, at, summary, detail')
      .eq('entity_type', 'requester')
      .eq('entity_id', id)
      .order('at', { ascending: false })
      .limit(100),
  ]);

  return {
    person: mapPerson(data as PersonJson),
    devices: ((devices.data ?? []) as DeviceJson[]).map(mapInventoryDevice),
    tickets: ((tickets.data ?? []) as RecordTicketRow[]).map(mapRecordTicket),
    events: ((events.data ?? []) as RecordEventRow[]).map(mapRecordEvent),
  };
}

export interface StaffDirectoryOptions {
  departments: string[];
  roles: string[];
}

/** The datalists the staff form offers. New values are allowed; these are suggestions. */
export async function loadStaffDirectoryOptions(): Promise<StaffDirectoryOptions> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_staff_directory_options');
  if (error || !data) return { departments: [], roles: [] };
  const payload = data as { departments?: string[]; roles?: string[] };
  return { departments: payload.departments ?? [], roles: payload.roles ?? [] };
}
