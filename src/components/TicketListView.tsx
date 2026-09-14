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

import { useCallback, useMemo, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  type IntakeChannel,
  type Priority,
  type Ticket,
  type TicketCategory,
  type TicketStatus,
  CHANNEL_LABELS,
  PRIORITY_LABELS,
  TICKET_CATEGORY_LABELS,
  TICKET_STATUS_LABELS,
} from '@/lib/domain/types';
import { canClaimTicket, canResolveTicket } from '@/lib/domain/permissions';
import { claimableIn, groupLabel, groupTickets, type TicketGroup } from '@/lib/domain/grouping';
import { claimTicketAction, claimTicketsAction } from '@/lib/data/actions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { ageLabel, formatDateTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { Avatar, EmptyState, Field, TimeAgo } from '@/components/Primitives';
import { PriorityBadge, StatusBadge } from '@/components/Badges';
import { Button, ButtonLink } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Icon } from '@/components/ui/Icon';
import { FilterBar } from '@/components/ui/FilterBar';
import { Pagination } from '@/components/ui/Pagination';
import { SavedViews } from '@/components/ui/SavedViews';
import { useRowKeys } from '@/components/ui/useRowKeys';
import type { ListAction } from '@/lib/lists/keys';
import type { QueuePage } from '@/lib/data/tickets';
import '@/styles/lists.css';

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
  const { directory, pendingKey, run, savedViews } = useRuntime();
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
      category: searchParams.get('category') ?? 'all',
    }),
    [searchParams],
  );

  /*
   * Every filter the URL carries, including category.
   *
   * `toFilters` has always passed `?category=` through to the database, so a
   * category-only queue was filtered but reported as unfiltered: no "Clear
   * filters" action, and an emptied list explained itself with "the queue is
   * clear" rather than "no tickets match these filters". Leaving one parameter
   * out here is the whole bug, so the list reads the same keys as `toFilters`.
   */
  const filtersActive =
    current.query.trim() !== '' ||
    current.status !== 'all' ||
    current.priority !== 'all' ||
    current.channel !== 'all' ||
    current.owner !== 'all' ||
    current.category !== 'all';

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

  const onClaim = useCallback(
    async (ticket: Ticket) => {
      await run(`claim:${ticket.id}`, () => claimTicketAction(ticket.id));
    },
    [run],
  );

  /*
   * The same problem, reported five times, as one row.
   *
   * A projector dies in room 118 and five people report it before lunch. Five
   * rows, five claims, five pages, the same solution written five times — none
   * of that is work, all of it is typing. The rule for "the same problem" lives
   * in `grouping.ts` and is a unit test, because grouping decides what one
   * press claims.
   *
   * Only live lists group. A history of resolved tickets is a record, and
   * folding two records into one would be rewriting it.
   */
  const groups = useMemo(
    () => (history ? [] : groupTickets(page.tickets)),
    [history, page.tickets],
  );

  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set<string>());

  /** The group a ticket leads, when it leads one of more than one. */
  const groupByLead = useMemo(() => {
    const map = new Map<string, TicketGroup>();
    for (const group of groups) if (group.tickets.length > 1) map.set(group.lead.id, group);
    return map;
  }, [groups]);

  /**
   * The rows on screen: every group's lead, plus the members of the groups that
   * are open. A group that was never folded is simply its one ticket.
   */
  const rows = useMemo(() => {
    if (groups.length === 0) return page.tickets;
    const out: Ticket[] = [];
    for (const group of groups) {
      out.push(group.lead);
      if (group.tickets.length > 1 && opened.has(group.key)) {
        out.push(...group.tickets.slice(1));
      }
    }
    return out;
  }, [groups, opened, page.tickets]);

  const toggleGroup = useCallback((key: string) => {
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const claimGroup = useCallback(
    async (group: TicketGroup) => {
      const ids = claimableIn(group, (ticket) => canClaimTicket(ticket, actor));
      if (ids.length === 0) return;
      await run(`claim:${group.key}`, () => claimTicketsAction(ids));
    },
    [actor, run],
  );

  /*
   * The same keyboard as Today, on the same keys, for the same reasons.
   *
   * `j` and `k` move, the number keys jump, `o` opens, `c` claims, `r` opens
   * the resolve field on the ticket and `e` puts the cursor in its note box.
   * Every one of those presses a control that is on the row or on the page it
   * opens; the shortcut is the short way, never the only way. Claiming happens
   * in place — the row is the thing you were looking at, and leaving the queue
   * to claim and coming back is the trip this removes.
   */
  const can = useCallback(
    (action: ListAction, ticket: Ticket) => {
      if (action === 'claim') return allowClaim && canClaimTicket(ticket, actor);
      if (action === 'resolve') return canResolveTicket(ticket, actor);
      return true;
    },
    [allowClaim, actor],
  );

  const onAction = useCallback(
    (action: ListAction, ticket: Ticket) => {
      const group = groupByLead.get(ticket.id);
      if (action === 'claim') {
        if (group) void claimGroup(group);
        else void onClaim(ticket);
        return;
      }
      // `o` on a folded row opens the group rather than the first ticket in it:
      // the row on screen is the group, and that is what the key acts on.
      if (action === 'open' && group && !opened.has(group.key)) {
        toggleGroup(group.key);
        return;
      }
      const intent = action === 'resolve' ? '?do=resolve' : action === 'edit' ? '?do=note' : '';
      router.push(`/tickets/${ticket.id}${intent}`);
    },
    [onClaim, router, groupByLead, claimGroup, opened, toggleGroup],
  );

  const keys = useRowKeys<Ticket>({
    rows,
    keyOf: (ticket) => ticket.id,
    onAction,
    can,
  });

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
      cell: (ticket) => {
        /*
         * Quick peek. The issue as it was reported is already on every queue
         * row — `app_list_tickets` returns it — and the whole reason a
         * technician opens a ticket from the queue is to read it. Hovering or
         * tabbing to the title shows it in place instead.
         *
         * It is the link's `aria-describedby`, so a screen reader reads the
         * title and then the issue, which is the same thing the eye gets, and
         * the peek is never a second unlabelled copy of the row. A row with no
         * issue text describes nothing rather than pointing at an empty box.
         *
         * The column is `hideOnPhone`, so this markup exists only in the table
         * layout and the id cannot collide with the phone card's copy.
         */
        const issue = ticket.issue.trim();
        const peekId = `queue-peek-${ticket.id}`;
        const group = groupByLead.get(ticket.id);
        const count = group ? groupLabel(group) : null;
        const open = group ? opened.has(group.key) : false;
        return (
          <div className="queue-cell-title">
            <Link
              href={`/tickets/${ticket.id}`}
              className="queue-title"
              aria-describedby={issue === '' ? undefined : peekId}
            >
              {ticket.title}
            </Link>
            <span className="queue-sub">
              {count ? (
                <button
                  type="button"
                  className="queue-group-toggle"
                  aria-expanded={open}
                  onClick={() => toggleGroup(group!.key)}
                >
                  <Icon icon={open ? ChevronDown : ChevronRight} size={13} />
                  {count}
                </button>
              ) : (
                requesterOf(ticket)
              )}
            </span>
            {issue === '' ? null : (
              <span className="queue-peek" id={peekId}>
                {issue}
              </span>
            )}
          </div>
        );
      },
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
        const group = groupByLead.get(ticket.id);
        if (group) {
          const ids = claimableIn(group, (entry) => canClaimTicket(entry, actor));
          if (ids.length === 0) return null;
          return (
            <Button
              size="sm"
              className="queue-claim"
              onClick={() => void claimGroup(group)}
              disabled={pendingKey !== null}
              loading={pendingKey === `claim:${group.key}`}
            >
              Claim all {ids.length}
            </Button>
          );
        }
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
      {/* Above the bar, because they are the shortcut past it. */}
      <SavedViews path={pathname} query={searchParams.toString()} stored={savedViews} />
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
              // Short enough to read in full at the width this field gets when
              // the bar also carries five selects (all tickets, 1440px); the
              // longer phrasing was cut mid-word there, which reads as a bug.
              placeholder="Number, name, device or text"
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
          <Field label="Category" htmlFor="queue-category">
            <select
              id="queue-category"
              value={current.category}
              onChange={(event) => updateParam('category', event.target.value)}
            >
              <option value="all">Any category</option>
              {(Object.keys(TICKET_CATEGORY_LABELS) as TicketCategory[]).map((category) => (
                <option key={category} value={category}>
                  {TICKET_CATEGORY_LABELS[category]}
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
            rows={rows}
            rowKey={(ticket) => ticket.id}
            caption="Tickets visible to this account"
            rowProps={keys.rowProps}
            listProps={keys.listProps}
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
