/**
 * Read models for the queues and the ticket detail view.
 *
 * Every list starts from `visibleTickets`, so search, counts and history obey the
 * same visibility rule as the tables. When M2 moves this to Postgres the same
 * shapes come back from queries guarded by row-level security.
 */

import {
  type Account,
  type AccountId,
  type ActivityEvent,
  type DeviceObservation,
  type HelpdeskData,
  type IntakeChannel,
  type LinkedDevice,
  type Priority,
  type Requester,
  type Ticket,
  type TicketId,
  type TicketStatus,
  type WorkLog,
  type WorkNote,
  isActiveStatus,
} from './types';
import { findAccount, visibleTickets } from './permissions';

const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** Urgent first, then oldest first — the order a queue should be worked in. */
export function sortForQueue(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Most recently finished first. */
export function sortByRecency(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) =>
    (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt),
  );
}

export function openQueue(data: HelpdeskData, actor: Account | null): Ticket[] {
  return sortForQueue(
    visibleTickets(data, actor).filter(
      (ticket) => ticket.status === 'open' && ticket.ownerId === null,
    ),
  );
}

export function myTickets(data: HelpdeskData, actor: Account | null): Ticket[] {
  if (!actor) return [];
  return sortForQueue(
    visibleTickets(data, actor).filter(
      (ticket) => ticket.ownerId === actor.id && isActiveStatus(ticket.status),
    ),
  );
}

export function collaboratingTickets(data: HelpdeskData, actor: Account | null): Ticket[] {
  if (!actor) return [];
  return sortForQueue(
    visibleTickets(data, actor).filter(
      (ticket) =>
        ticket.collaboratorIds.includes(actor.id) &&
        ticket.ownerId !== actor.id &&
        isActiveStatus(ticket.status),
    ),
  );
}

/**
 * Resolved and cancelled tickets the actor may still see. Technicians keep the
 * history of work they owned or collaborated on; unrelated closed tickets are
 * filtered out by `visibleTickets`.
 */
export function closedHistory(data: HelpdeskData, actor: Account | null): Ticket[] {
  return sortByRecency(
    visibleTickets(data, actor).filter(
      (ticket) => ticket.status === 'resolved' || ticket.status === 'cancelled',
    ),
  );
}

export function allTickets(data: HelpdeskData, actor: Account | null): Ticket[] {
  return sortForQueue(visibleTickets(data, actor));
}

export interface QueueCounts {
  openQueue: number;
  myTickets: number;
  collaborating: number;
  closed: number;
  all: number;
}

export function queueCounts(data: HelpdeskData, actor: Account | null): QueueCounts {
  return {
    openQueue: openQueue(data, actor).length,
    myTickets: myTickets(data, actor).length,
    collaborating: collaboratingTickets(data, actor).length,
    closed: closedHistory(data, actor).length,
    all: visibleTickets(data, actor).length,
  };
}

// ---------------------------------------------------------------------------
// Search and filtering
// ---------------------------------------------------------------------------

export interface TicketFilters {
  query: string;
  status: TicketStatus | 'all';
  priority: Priority | 'all';
  channel: IntakeChannel | 'all';
  /** `'unassigned'` matches tickets sitting in the Open Queue. */
  owner: AccountId | 'all' | 'unassigned';
}

export const EMPTY_FILTERS: TicketFilters = {
  query: '',
  status: 'all',
  priority: 'all',
  channel: 'all',
  owner: 'all',
};

export function hasActiveFilters(filters: TicketFilters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.status !== 'all' ||
    filters.priority !== 'all' ||
    filters.channel !== 'all' ||
    filters.owner !== 'all'
  );
}

function searchHaystack(data: HelpdeskData, ticket: Ticket): string {
  const requester = ticket.requesterUnknown
    ? 'unknown requester'
    : (data.requesters.find((entry) => entry.id === ticket.requesterId)?.displayName ?? '');
  const owner = ticket.ownerId ? findAccount(data, ticket.ownerId)?.displayName : 'unassigned';
  const collaborators = ticket.collaboratorIds
    .map((id) => findAccount(data, id)?.displayName ?? '')
    .join(' ');
  const devices = data.deviceObservations
    .filter((device) => device.ticketId === ticket.id)
    .map((device) =>
      [device.deviceType, device.model, device.serialNumber, device.assetTag]
        .filter(Boolean)
        .join(' '),
    )
    .join(' ');

  return [
    ticket.number,
    ticket.title,
    ticket.issue,
    ticket.location ?? (ticket.isRemote ? 'remote' : 'unknown location'),
    requester,
    owner ?? '',
    collaborators,
    devices,
  ]
    .join(' ')
    .toLowerCase();
}

/** Applies the filter set to an already visibility-filtered list. */
export function filterTickets(
  data: HelpdeskData,
  tickets: Ticket[],
  filters: TicketFilters,
): Ticket[] {
  const query = filters.query.trim().toLowerCase();
  const terms = query.length > 0 ? query.split(/\s+/) : [];

  return tickets.filter((ticket) => {
    if (filters.status !== 'all' && ticket.status !== filters.status) return false;
    if (filters.priority !== 'all' && ticket.priority !== filters.priority) return false;
    if (filters.channel !== 'all' && ticket.channel !== filters.channel) return false;
    if (filters.owner === 'unassigned' && ticket.ownerId !== null) return false;
    if (
      filters.owner !== 'all' &&
      filters.owner !== 'unassigned' &&
      ticket.ownerId !== filters.owner
    ) {
      return false;
    }
    if (terms.length === 0) return true;
    const haystack = searchHaystack(data, ticket);
    return terms.every((term) => haystack.includes(term));
  });
}

// ---------------------------------------------------------------------------
// Ticket detail
// ---------------------------------------------------------------------------

export interface ContributorTime {
  accountId: AccountId;
  displayName: string;
  minutes: number;
}

export interface TimeSummary {
  /**
   * Person-minutes: two technicians logging 20 minutes each totals 40. Elapsed
   * ticket lifetime is a separate measure and is not mixed in here.
   */
  totalMinutes: number;
  /** False means no one recorded time, which is not the same as zero minutes. */
  recorded: boolean;
  byContributor: ContributorTime[];
}

export function summariseTime(data: HelpdeskData, ticketId: TicketId): TimeSummary {
  const logs = data.workLogs.filter((log) => log.ticketId === ticketId);
  const byAccount = new Map<AccountId, number>();
  for (const log of logs) {
    byAccount.set(log.contributorId, (byAccount.get(log.contributorId) ?? 0) + log.minutes);
  }
  const byContributor: ContributorTime[] = [...byAccount.entries()]
    .map(([accountId, minutes]) => ({
      accountId,
      displayName: findAccount(data, accountId)?.displayName ?? 'Unknown user',
      minutes,
    }))
    .sort((a, b) => b.minutes - a.minutes);

  return {
    totalMinutes: byContributor.reduce((sum, entry) => sum + entry.minutes, 0),
    recorded: logs.length > 0,
    byContributor,
  };
}

export interface TicketDetail {
  ticket: Ticket;
  requester: Requester | null;
  owner: Account | null;
  collaborators: Account[];
  creator: Account | null;
  resolver: Account | null;
  /** What a technician wrote down, including machines not in the inventory. */
  devices: DeviceObservation[];
  /** Inventory records this ticket names. Empty is the normal case. */
  linkedDevices: LinkedDevice[];
  notes: WorkNote[];
  workLogs: WorkLog[];
  activity: ActivityEvent[];
  time: TimeSummary;
}

/** Returns `null` when the ticket does not exist or the actor may not see it. */
export function ticketDetail(
  data: HelpdeskData,
  actor: Account | null,
  ticketId: TicketId,
): TicketDetail | null {
  const ticket = visibleTickets(data, actor).find((entry) => entry.id === ticketId);
  if (!ticket) return null;

  return {
    ticket,
    requester: ticket.requesterId
      ? (data.requesters.find((entry) => entry.id === ticket.requesterId) ?? null)
      : null,
    owner: findAccount(data, ticket.ownerId),
    collaborators: ticket.collaboratorIds
      .map((id) => findAccount(data, id))
      .filter((account): account is Account => account !== null),
    creator: findAccount(data, ticket.createdById),
    resolver: findAccount(data, ticket.resolvedById),
    devices: data.deviceObservations.filter((device) => device.ticketId === ticketId),
    // The in-memory dataset has no inventory: links exist only in the database,
    // and this selector is the prototype's read model.
    linkedDevices: [],
    notes: data.notes
      .filter((note) => note.ticketId === ticketId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    workLogs: data.workLogs
      .filter((log) => log.ticketId === ticketId)
      .sort((a, b) => a.workDate.localeCompare(b.workDate) || a.createdAt.localeCompare(b.createdAt)),
    // Array#sort is stable, so events sharing a timestamp keep insertion order.
    activity: data.activity
      .filter((event) => event.ticketId === ticketId)
      .sort((a, b) => a.at.localeCompare(b.at)),
    time: summariseTime(data, ticketId),
  };
}

/** Live tickets still owned by an account — used when deactivating someone. */
export function liveTicketsOwnedBy(data: HelpdeskData, accountId: AccountId): Ticket[] {
  return sortForQueue(
    data.tickets.filter(
      (ticket) => ticket.ownerId === accountId && isActiveStatus(ticket.status),
    ),
  );
}
