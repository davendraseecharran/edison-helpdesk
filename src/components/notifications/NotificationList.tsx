'use client';

/**
 * The list of notices, and the screen that wraps it at `/notifications`.
 *
 * Two shapes of the same rows. The bell's dropdown shows the eight newest as a
 * flat list; the page groups them into Today and Earlier, because a page is
 * read rather than glanced at and the first question is what happened while the
 * reader was at the desk. The grouping is computed from the school-local day
 * handed down by the server, so the server render and the hydrated one agree.
 *
 * The filter lives in the URL rather than in component state: a filtered list is
 * then shareable, survives a refresh, and — the part that matters — is a real
 * query against the database under the caller's own row policies rather than a
 * client-side sieve over rows that were fetched anyway.
 */

import { useCallback, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CheckCheck } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { EmptyState } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Pagination } from '@/components/ui/Pagination';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { markReadAction } from '@/lib/data/notification-actions';
import {
  groupNotifications,
  isUnread,
  type NotificationFilter,
  type NotificationView,
} from '@/lib/domain/notifications';
import { NotificationItem } from './NotificationItem';

/** The empty state both the page and the dropdown show. */
export const ALL_CAUGHT_UP = "You're all caught up.";

const FILTER_OPTIONS: Array<{ value: NotificationFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
];

/**
 * Which notices this view has treated as read, and the press that adds one.
 *
 * Opening a notice marks it read immediately on screen and tells the server
 * afterwards. A failure is reported rather than swallowed: the toast stack
 * survives the navigation the press started, so the message still lands, and
 * the next server render puts the row back to whatever actually committed.
 */
export function useOptimisticReads(onOpened?: (item: NotificationView) => void): {
  read: ReadonlySet<string>;
  open: (item: NotificationView) => void;
} {
  const { notify } = useRuntime();
  const [read, setRead] = useState<ReadonlySet<string>>(() => new Set<string>());

  const open = useCallback(
    (item: NotificationView) => {
      if (!isUnread(item)) return;
      setRead((previous) => new Set(previous).add(item.id));
      onOpened?.(item);
      markReadAction([item.id])
        .then((result) => {
          if (!result.ok) {
            notify('error', result.error ?? 'That notification could not be marked read.');
          }
        })
        .catch(() => {
          notify('error', 'That notification could not be marked read. Check your connection.');
        });
    },
    [notify, onOpened],
  );

  return { read, open };
}

export interface NotificationListProps {
  items: NotificationView[];
  /** Ids this view has already treated as read, from `useOptimisticReads`. */
  read: ReadonlySet<string>;
  /** The clock this list was rendered against, for the age on each row. */
  now: number;
  onOpen?: (item: NotificationView) => void;
  /** School-local `YYYY-MM-DD`. With it the list groups; without it, it is flat. */
  todayKey?: string;
}

export function NotificationList({ items, read, now, onOpen, todayKey }: NotificationListProps) {
  function row(item: NotificationView) {
    return (
      <NotificationItem
        key={item.id}
        item={item}
        read={!isUnread(item) || read.has(item.id)}
        now={now}
        onOpen={onOpen}
      />
    );
  }

  if (todayKey === undefined) {
    return <div className="notification-rows">{items.map(row)}</div>;
  }

  return (
    <div className="notification-groups">
      {groupNotifications(items, todayKey).map((group) => (
        <section key={group.key} className="notification-group">
          <h2 className="notification-group-title">{group.label}</h2>
          <div className="notification-rows">{group.items.map(row)}</div>
        </section>
      ))}
    </div>
  );
}

export interface NotificationsScreenProps {
  items: NotificationView[];
  total: number;
  page: number;
  pageCount: number;
  filter: NotificationFilter;
  /** How many are unread across every page, for the "Mark all read" state. */
  unread: number;
  todayKey: string;
  /** The instant the page was rendered, so the first paint's ages match. */
  now: number;
}

/** `/notifications`: the filter, "Mark all read", the grouped list and paging. */
export function NotificationsScreen({
  items,
  total,
  page,
  pageCount,
  filter,
  unread,
  todayKey,
  now,
}: NotificationsScreenProps) {
  const { pendingKey, run } = useRuntime();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [navigating, startNavigation] = useTransition();
  const { read, open } = useOptimisticReads();

  function hrefForPage(target: number): string {
    const next = new URLSearchParams(searchParams.toString());
    if (target <= 1) next.delete('page');
    else next.set('page', String(target));
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  /** Changing the filter starts again at the first page. */
  function chooseFilter(value: NotificationFilter) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === 'all') next.delete('filter');
    else next.set('filter', value);
    next.delete('page');
    const query = next.toString();
    startNavigation(() => router.replace(query ? `${pathname}?${query}` : pathname));
  }

  async function markAll() {
    await run('notifications:mark-all', () => markReadAction(null));
  }

  return (
    <div className="notifications-screen">
      <div className="notifications-toolbar" role="group" aria-label="Notifications">
        <SegmentedControl
          label="Show"
          value={filter}
          options={FILTER_OPTIONS}
          onChange={chooseFilter}
          size="sm"
        />
        <div className="notifications-toolbar-end">
          <span className="notifications-summary" aria-live="polite">
            {total === 1 ? '1 notification' : `${total} notifications`}
          </span>
          <Button
            variant="secondary"
            size="sm"
            icon={CheckCheck}
            onClick={markAll}
            disabled={unread === 0}
            loading={pendingKey === 'notifications:mark-all'}
          >
            Mark all read
          </Button>
        </div>
      </div>

      <div className="notifications-body" aria-busy={navigating || undefined}>
        {items.length === 0 ? (
          <EmptyState title={ALL_CAUGHT_UP}>
            {filter === 'unread'
              ? 'Nothing is waiting to be read. Choose All to see everything from the past.'
              : 'Notices arrive when a ticket is assigned to you, someone adds you as a collaborator, or a ticket you own is reopened.'}
          </EmptyState>
        ) : (
          <NotificationList
            items={items}
            read={read}
            now={now}
            onOpen={open}
            todayKey={todayKey}
          />
        )}
      </div>

      <Pagination
        page={page}
        pageCount={pageCount}
        hrefFor={hrefForPage}
        label="Notification pages"
      />
    </div>
  );
}
