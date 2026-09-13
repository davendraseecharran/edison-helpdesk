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

import { useMemo, useTransition, type ReactNode } from 'react';
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
import { ageLabel, formatDateTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { Avatar, EmptyState, Field, TimeAgo } from '@/components/Primitives';
import { PriorityBadge, StatusBadge } from '@/components/Badges';
import { Button, ButtonLink } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Pagination } from '@/components/ui/Pagination';
import type { QueuePage } from '@/lib/data/tickets';

export interface TicketListViewProps {
  page: QueuePage;
  /**
   * The request time in epoch milliseconds. Ages are computed from it until
   * the client clock takes over after hydration, so the first paint and the
   * server render agree on every label.
   */
  now: number;
  emptyTitle: string;
  emptyBody?: ReactNode;
  /** Shown under the empty state when nothing is filtered, e.g. a New ticket link. */
  emptyAction?: ReactNode;
  showOwner?: boolean;
  allowClaim?: boolean;
  /** Closed tickets: the age column becomes "Closed". */
  history?: boolean;
}

export function TicketListView({
  page,
  now: renderedAt,
  emptyTitle,
  emptyBody,
  emptyAction,
  showOwner = false,
  allowClaim = false,
  history = false,
}: TicketListViewProps) {
  const { directory, pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();
  const tick = useNow();
  const now = new Date(tick ?? renderedAt);

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

  function hrefForPage(target: number): string {
    const next = new URLSearchParams(searchParams.toString());
    if (target <= 1) next.delete('page');
    else next.set('page', String(target));
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  async function onClaim(ticket: Ticket) {
    await run(`claim:${ticket.id}`, () => claimTicketAction(ticket.id));
  }

  function requesterOf(ticket: Ticket): string {
    if (ticket.requesterUnknown || !ticket.requesterId) return 'Requester unknown';
    return page.requesterNames[ticket.requesterId] ?? 'Requester unknown';
  }

  const { tickets, total, pageCount } = page;
  const busy = navigating;

  const columns: Column<Ticket>[] = [
    {
      key: 'number',
      header: 'Number',
      mono: true,
      hideOnPhone: true,
      width: 104,
      cell: (ticket) => (
        <Link href={`/tickets/${ticket.id}`} className="queue-number">
          {ticket.number}
        </Link>
      ),
    },
    {
      key: 'title',
      header: 'Title',
      hideOnPhone: true,
      cell: (ticket) => (
        <div className="queue-cell-title">
          <Link href={`/tickets/${ticket.id}`} className="queue-title">
            {ticket.title}
          </Link>
          <span className="queue-sub">{requesterOf(ticket)}</span>
        </div>
      ),
    },
  ];

  if (showOwner) {
    columns.push({
      key: 'owner',
      header: 'Owner',
      hideOnPhone: true,
      width: 200,
      cell: (ticket) => {
        const ownerName = ticket.ownerId ? (page.ownerNames[ticket.ownerId] ?? 'Unknown') : null;
        return ownerName ? (
          <span className="queue-owner">
            <Avatar name={ownerName} />
            <span className="queue-owner-name">{ownerName}</span>
          </span>
        ) : (
          <span className="queue-quiet">Unassigned</span>
        );
      },
    });
  }

  columns.push(
    {
      key: 'age',
      header: history ? 'Closed' : 'Age',
      align: 'right',
      width: 88,
      cell: (ticket) =>
        history ? (
          ticket.resolvedAt ? (
            <span className="queue-age">
              <TimeAgo iso={ticket.resolvedAt} />
            </span>
          ) : (
            <span className="queue-quiet">Cancelled</span>
          )
        ) : (
          <time
            className="queue-age"
            dateTime={ticket.createdAt}
            title={formatDateTime(ticket.createdAt)}
          >
            {ageLabel(ticket.createdAt, now)}
          </time>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 140,
      cell: (ticket) => (
        <span className="queue-cell-status">
          <StatusBadge status={ticket.status} />
          {ticket.status === 'waiting' && ticket.waitingReason ? (
            <span className="queue-reason">{ticket.waitingReason}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      width: 120,
      cell: (ticket) => <PriorityBadge priority={ticket.priority} />,
    },
  );

  if (allowClaim) {
    columns.push({
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      align: 'right',
      width: 128,
      cell: (ticket) => {
        if (!canClaimTicket(ticket, actor)) return null;
        const claimKey = `claim:${ticket.id}`;
        return (
          <Button
            size="sm"
            className="queue-claim"
            onClick={() => void onClaim(ticket)}
            disabled={pendingKey !== null}
            loading={pendingKey === claimKey}
          >
            Claim ticket
          </Button>
        );
      },
    });
  }

  return (
    <section className="panel queue" data-busy={busy || undefined} aria-busy={busy || undefined}>
      <FilterBar
        label="Ticket filters"
        active={filtersActive}
        clearHref={pathname}
        summary={busy ? 'Loading' : `${total} ${total === 1 ? 'ticket' : 'tickets'}`}
      >
        <div className="queue-filters">
          <Field label="Search" htmlFor="queue-search" className="field-search">
            <input
              id="queue-search"
              type="search"
              name="query"
              placeholder="Number, requester, location, device or text"
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
        </div>
      </FilterBar>

      {tickets.length === 0 ? (
        filtersActive ? (
          <EmptyState
            title="No tickets match these filters"
            action={<ButtonLink href={pathname}>Clear filters</ButtonLink>}
          >
            Widen the search text or the filters to see more.
          </EmptyState>
        ) : (
          <EmptyState title={emptyTitle} action={emptyAction}>
            {emptyBody}
          </EmptyState>
        )
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={tickets}
            rowKey={(ticket) => ticket.id}
            caption="Tickets visible to this account"
            settle
            cardTitle={(ticket) => (
              <Link href={`/tickets/${ticket.id}`}>
                <span className="queue-card-number mono">{ticket.number}</span>
                {ticket.title}
              </Link>
            )}
            cardMeta={(ticket) => requesterOf(ticket)}
          />
          <Pagination page={page.page} pageCount={pageCount} hrefFor={hrefForPage} label="Ticket pages" />
        </>
      )}
    </section>
  );
}
