import 'server-only';

/**
 * Authorized ticket reads.
 *
 * Every query here runs through the signed-in user's own client, so row-level
 * security decides the rows. Nothing in this file uses the service role, and
 * nothing filters rows in JavaScript for security: search, ordering, counting
 * and pagination all happen inside `app_list_tickets`, which is SECURITY
 * INVOKER and therefore still subject to RLS.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { Account, Requester, Ticket, TicketStatus } from '@/lib/domain/types';
import type { TicketDetail, TimeSummary } from '@/lib/domain/selectors';
import { summariseTime } from '@/lib/domain/selectors';
import {
  mapActivity,
  mapDevice,
  mapDirectoryAccount,
  mapLinkedDevice,
  mapNote,
  mapRequester,
  mapTicket,
  mapWorkLog,
  type DirectoryRow,
  type TicketRow,
} from './mapping';

export type QueueScope = 'open_queue' | 'mine' | 'collaborating' | 'closed' | 'all';

export const PAGE_SIZE = 25;

export interface QueueFilters {
  query?: string;
  status?: string;
  priority?: string;
  channel?: string;
  owner?: string;
  /** One of TicketCategory. A value outside it matches nothing, by design. */
  category?: string;
  page?: number;
}

export interface QueuePage {
  tickets: Ticket[];
  /** Display names resolved server-side, so no extra client lookup is needed. */
  ownerNames: Record<string, string>;
  requesterNames: Record<string, string>;
  total: number;
  page: number;
  pageCount: number;
}

function normaliseFilter(value: string | undefined): string | null {
  if (!value || value === 'all' || value.trim() === '') return null;
  return value;
}

export async function loadQueue(
  scope: QueueScope,
  filters: QueueFilters = {},
): Promise<QueuePage> {
  const supabase = await createClient();
  const page = Math.max(1, filters.page ?? 1);

  const { data, error } = await supabase.rpc('app_list_tickets', {
    p_scope: scope,
    p_query: normaliseFilter(filters.query),
    p_status: normaliseFilter(filters.status),
    p_priority: normaliseFilter(filters.priority),
    p_channel: normaliseFilter(filters.channel),
    p_owner: normaliseFilter(filters.owner),
    p_category: normaliseFilter(filters.category),
    p_limit: PAGE_SIZE,
    p_offset: (page - 1) * PAGE_SIZE,
  });

  if (error) {
    throw new Error(`Could not load the ${scope} queue: ${error.message}`);
  }

  const rows = (data ?? []) as Array<
    TicketRow & {
      requester_name: string | null;
      owner_name: string | null;
      device_count: number;
      total_count: number;
    }
  >;

  // A ticket may leave the last page while another technician works. Return
  // to the first page instead of displaying a false zero count with no way back.
  if (rows.length === 0 && page > 1) return loadQueue(scope, { ...filters, page: 1 });

  const ownerNames: Record<string, string> = {};
  const requesterNames: Record<string, string> = {};
  for (const row of rows) {
    if (row.owner_id && row.owner_name) ownerNames[row.owner_id] = row.owner_name;
    if (row.requester_id && row.requester_name) requesterNames[row.requester_id] = row.requester_name;
  }

  const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;

  return {
    tickets: rows.map(mapTicket),
    ownerNames,
    requesterNames,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export interface QueueCounts {
  openQueue: number;
  myTickets: number;
  collaborating: number;
  closed: number;
  all: number;
}

export const loadCounts = cache(async (): Promise<QueueCounts> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_queue_counts');
  if (error || !Array.isArray(data) || data.length === 0) {
    return { openQueue: 0, myTickets: 0, collaborating: 0, closed: 0, all: 0 };
  }
  const row = data[0] as {
    open_queue: number;
    mine: number;
    collaborating: number;
    closed: number;
    all_tickets: number;
  };
  return {
    openQueue: Number(row.open_queue),
    myTickets: Number(row.mine),
    collaborating: Number(row.collaborating),
    closed: Number(row.closed),
    all: Number(row.all_tickets),
  };
});

/** Minimal labels for collaborator pickers and historical attribution. */
export const loadDirectory = cache(async (): Promise<Account[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_directory');
  if (error) return [];
  return ((data ?? []) as DirectoryRow[]).map(mapDirectoryAccount);
});

// MERGE-TODO: the owner's `requesters` table now holds the whole school
// (3,448 students and 261 staff), so reading every row into the shell on every
// page is no longer proportionate. The M5 intake page is the only caller; the
// rewire task replaces it with `app_search_requesters(p_kind, p_query)`, which
// is what their intake page uses. Bounded here so a full directory cannot be
// pulled into a page render in the meantime.
export const loadRequesters = cache(async (): Promise<Requester[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('requesters')
    .select('id, display_name, kind, descriptor')
    .order('display_name')
    .limit(200);
  if (error) return [];
  return (data ?? []).map(mapRequester);
});

export interface TicketDetailView extends TicketDetail {
  time: TimeSummary;
}

/**
 * Full ticket detail, or null when the ticket does not exist OR is not visible.
 * The two are deliberately indistinguishable, matching the database contract.
 */
export async function loadTicketDetail(
  ticketId: string,
  directory: Account[],
): Promise<TicketDetailView | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_ticket_detail', { p_ticket: ticketId });
  if (error || !data) return null;

  const payload = data as {
    ticket: TicketRow & {
      requester_name: string | null;
      requester_kind: string | null;
      requester_descriptor: string | null;
      person_id: string | null;
      creator_name: string | null;
      resolver_name: string | null;
    };
    devices: Parameters<typeof mapDevice>[0][];
    linked_devices: Parameters<typeof mapLinkedDevice>[0][];
    notes: Parameters<typeof mapNote>[0][];
    work_logs: Parameters<typeof mapWorkLog>[0][];
    activity: Parameters<typeof mapActivity>[0][];
  };

  const linkedDevices = (payload.linked_devices ?? []).map(mapLinkedDevice);
  // The detail RPC returns the machines themselves rather than a count, so the
  // count on the ticket is taken from them instead of being asked for twice.
  const ticket: Ticket = {
    ...mapTicket(payload.ticket),
    linkedDeviceCount: linkedDevices.length,
  };
  const byId = new Map(directory.map((account) => [account.id, account]));

  const requester: Requester | null = payload.ticket.requester_id
    ? {
        id: payload.ticket.requester_id,
        displayName: payload.ticket.requester_name ?? 'Unknown',
        kind: (payload.ticket.requester_kind ?? 'unknown') as Requester['kind'],
        descriptor: payload.ticket.requester_descriptor,
        // Set when this requester is somebody on the roster rather than a name
        // typed in at the desk.
        personId: payload.ticket.person_id,
      }
    : null;

  const workLogs = payload.work_logs.map(mapWorkLog);

  return {
    ticket,
    requester,
    owner: ticket.ownerId ? (byId.get(ticket.ownerId) ?? null) : null,
    collaborators: ticket.collaboratorIds
      .map((id) => byId.get(id))
      .filter((account): account is Account => account !== undefined),
    creator: byId.get(ticket.createdById) ?? null,
    resolver: ticket.resolvedById ? (byId.get(ticket.resolvedById) ?? null) : null,
    devices: payload.devices.map(mapDevice),
    linkedDevices,
    notes: payload.notes.map(mapNote),
    workLogs,
    activity: payload.activity.map(mapActivity),
    time: summariseTime(
      {
        accounts: directory,
        requesters: [],
        tickets: [],
        deviceObservations: [],
        notes: [],
        workLogs,
        activity: [],
        sequences: { ticketNumber: 0, entity: 0 },
      },
      ticketId,
    ),
  };
}

export const ACTIVE_STATUS_VALUES: TicketStatus[] = ['open', 'assigned', 'in_progress', 'waiting'];
