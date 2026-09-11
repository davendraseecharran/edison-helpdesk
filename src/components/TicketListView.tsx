'use client';

/**
 * Shared queue view.
 *
 * Filters, sorting scope and pagination all live in the URL and are applied by
 * the database (`app_list_tickets`, SECURITY INVOKER) against the rows RLS
 * allows. Nothing is filtered client-side for security, and the total shown is
 * the count of the caller's own authorized matches, so it cannot hint at the
 * existence of tickets they may not see.
 */

import { useMemo, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  type IntakeChannel,
  type Priority,
  type Ticket,
  type TicketStatus,
  CHANNEL_LABELS,
  PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
} from '@/lib/domain/types';
import { canClaimTicket } from '@/lib/domain/permissions';
import { claimTicketAction } from '@/lib/data/actions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { formatDateKey } from '@/lib/format';
import { EmptyState, Field, TimeAgo } from '@/components/Primitives';
import { PriorityBadge, StatusBadge } from '@/components/Badges';
import type { QueuePage } from '@/lib/data/tickets';

export interface TicketListViewProps {
  page: QueuePage;
  emptyTitle: string;
  emptyBody?: React.ReactNode;
  showOwner?: boolean;
  allowClaim?: boolean;
  history?: boolean;
  notice?: React.ReactNode;
}

export function TicketListView({
  page,
  emptyTitle,
  emptyBody,
  showOwner = false,
  allowClaim = false,
  history = false,
  notice,
}: TicketListViewProps) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();

  const current = useMemo(
    () => ({
      query: searchParams.get('query') ?? '',
      status: searchParams.get('status') ?? 'all',
      priority: searchParams.get('priority') ?? 'all',
      channel: searchParams.get('channel') ?? 'all',
      owner: searchParams.get('owner') ?? 'all',
    }),
    [searchParams],
  );

  const filtersActive =
    current.query.trim() !== '' ||
    current.status !== 'all' ||
    current.priority !== 'all' ||
    current.channel !== 'all' ||
    current.owner !== 'all';

  const ownerOptions = useMemo(
    () => directory.filter((account) => account.status === 'active'),
    [directory],
  );

  /** Any filter change resets to page 1; an empty value drops the parameter. */
  function updateParam(name: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === '' || value === 'all') next.delete(name);
    else next.set(name, value);
    next.delete('page');
    startNavigation(() => router.replace(`${pathname}?${next.toString()}`));
  }

  function goToPage(target: number) {
    const next = new URLSearchParams(searchParams.toString());
    if (target <= 1) next.delete('page');
    else next.set('page', String(target));
    startNavigation(() => router.replace(`${pathname}?${next.toString()}`));
  }

  async function onClaim(ticket: Ticket) {
    await run(`claim:${ticket.id}`, () => claimTicketAction(ticket.id));
  }

  const { tickets, total, pageCount } = page;
  const busy = navigating;

  return (
    <div className="card">
      <div className="toolbar">
        <Field label="Search" htmlFor="queue-search" className="field-search">
          <input
            id="queue-search"
            type="search"
            name="query"
            placeholder="Ticket number, requester, location, device, text…"
            defaultValue={current.query}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                updateParam('query', (event.target as HTMLInputElement).value);
              }
            }}
            onBlur={(event) => {
              if (event.target.value !== current.query) {
                updateParam('query', event.target.value);
              }
            }}
          />
        </Field>
        <Field label="Status" htmlFor="queue-status">
          <select
            id="queue-status"
            value={current.status}
            onChange={(event) => updateParam('status', event.target.value)}
          >
            <option value="all">Any status</option>
            {(Object.keys(TICKET_STATUS_LABELS) as TicketStatus[]).map((status) => (
              <option key={status} value={status}>
                {TICKET_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority" htmlFor="queue-priority">
          <select
            id="queue-priority"
            value={current.priority}
            onChange={(event) => updateParam('priority', event.target.value)}
          >
            <option value="all">Any priority</option>
            {(Object.keys(PRIORITY_LABELS) as Priority[]).map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Channel" htmlFor="queue-channel">
          <select
            id="queue-channel"
            value={current.channel}
            onChange={(event) => updateParam('channel', event.target.value)}
          >
            <option value="all">Any channel</option>
            {(Object.keys(CHANNEL_LABELS) as IntakeChannel[]).map((channel) => (
              <option key={channel} value={channel}>
                {CHANNEL_LABELS[channel]}
              </option>
            ))}
          </select>
        </Field>
        {showOwner ? (
          <Field label="Owner" htmlFor="queue-owner">
            <select
              id="queue-owner"
              value={current.owner}
              onChange={(event) => updateParam('owner', event.target.value)}
            >
              <option value="all">Anyone</option>
              <option value="unassigned">Unassigned</option>
              {ownerOptions.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {filtersActive ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => startNavigation(() => router.replace(pathname))}
          >
            Clear filters
          </button>
        ) : null}
        <span className="result-count" aria-live="polite">
          {busy ? 'Loading…' : `${total} ${total === 1 ? 'ticket' : 'tickets'}`}
        </span>
      </div>

      {notice ? <div className="card-body-tight">{notice}</div> : null}

      {tickets.length === 0 ? (
        filtersActive ? (
          <EmptyState
            title="No tickets match these filters"
            action={
              <button
                type="button"
                className="btn"
                onClick={() => startNavigation(() => router.replace(pathname))}
              >
                Clear filters
              </button>
            }
          >
            Adjust the search text or filter selections to widen the results.
          </EmptyState>
        ) : (
          <EmptyState title={emptyTitle}>{emptyBody}</EmptyState>
        )
      ) : (
        <>
          <div className="table-wrap">
            <table className="tickets">
              <caption className="sr-only">
                Tickets visible to this account.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Ticket</th>
                  <th scope="col">Request</th>
                  <th scope="col">Location</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Status</th>
                  {showOwner ? <th scope="col">Owner</th> : null}
                  <th scope="col">{history ? 'Closed' : 'Age'}</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => {
                  const claimable = allowClaim && canClaimTicket(ticket, actor);
                  const claimKey = `claim:${ticket.id}`;
                  const requesterName = ticket.requesterId
                    ? (page.requesterNames[ticket.requesterId] ?? 'Requester unknown')
                    : 'Requester unknown';
                  const ownerName = ticket.ownerId
                    ? (page.ownerNames[ticket.ownerId] ?? 'Unknown')
                    : null;

                  return (
                    <tr key={ticket.id}>
                      <td className="cell-number" data-label="Ticket">
                        {ticket.number}
                      </td>
                      <td className="cell-title" data-label="Request">
                        <Link href={`/tickets/${ticket.id}`}>{ticket.title}</Link>
                        <span className="cell-sub">
                          {ticket.requesterUnknown ? 'Requester unknown' : requesterName}
                          {' · '}
                          {CHANNEL_LABELS[ticket.channel]}
                          {' · '}
                          {formatDateKey(ticket.submittedOn)}
                        </span>
                      </td>
                      <td data-label="Location">
                        {ticket.isRemote ? 'Remote' : (ticket.location ?? 'Unknown')}
                      </td>
                      <td data-label="Priority">
                        <PriorityBadge priority={ticket.priority} />
                      </td>
                      <td data-label="Status">
                        <StatusBadge status={ticket.status} />
                        {ticket.status === 'waiting' && ticket.waitingReason ? (
                          <span className="cell-sub">{ticket.waitingReason}</span>
                        ) : null}
                      </td>
                      {showOwner ? (
                        <td data-label="Owner">
                          {ownerName ?? <span className="subtle">Unassigned</span>}
                        </td>
                      ) : null}
                      <td className="cell-nowrap" data-label={history ? 'Closed' : 'Age'}>
                        {history ? (
                          ticket.resolvedAt ? (
                            <TimeAgo iso={ticket.resolvedAt} />
                          ) : (
                            <span className="subtle">Cancelled</span>
                          )
                        ) : (
                          <TimeAgo iso={ticket.createdAt} mode="age" />
                        )}
                      </td>
                      <td className="cell-actions" data-label="Actions">
                        {claimable ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => void onClaim(ticket)}
                            disabled={pendingKey !== null}
                          >
                            {pendingKey === claimKey ? 'Claiming…' : 'Claim'}
                          </button>
                        ) : (
                          <Link className="btn btn-sm" href={`/tickets/${ticket.id}`}>
                            Open
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pageCount > 1 ? (
            <div className="card-body-tight row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">
                Page {page.page} of {pageCount}
              </span>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page.page <= 1 || busy}
                  onClick={() => goToPage(page.page - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page.page >= pageCount || busy}
                  onClick={() => goToPage(page.page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
