import {
  NOTIFICATIONS_PAGE_SIZE,
  loadNotifications,
  loadUnreadCount,
} from '@/lib/data/notifications';
import { toNotificationFilter } from '@/lib/domain/notifications';
import { requestTime, schoolToday } from '@/lib/format';
import { PageHeader } from '@/components/Primitives';
import { NotificationsScreen } from '@/components/notifications/NotificationList';
import '@/styles/notifications.css';

export const metadata = { title: 'Notifications — Edison Helpdesk' };

interface NotificationsSearchParams {
  filter?: string | string[];
  page?: string | string[];
}

/** A page number from the URL. Anything unusable means the first page. */
function pageNumber(value: string | string[] | undefined): number {
  const first = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(first ?? '1', 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 1_000_000);
}

/**
 * Everything the signed-in account has been told, newest first.
 *
 * The filter and the page live in the URL, so the list is a real query under
 * the caller's own row policies rather than a client-side slice, and a link to
 * "my unread notices" survives being shared or refreshed. The unread total is
 * read separately from the same RPC the bell uses, so "Mark all read" knows
 * whether there is anything to do even while the All filter is showing.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<NotificationsSearchParams>;
}) {
  const params = await searchParams;
  const filter = toNotificationFilter(params.filter);

  const [result, unread] = await Promise.all([
    loadNotifications({
      limit: NOTIFICATIONS_PAGE_SIZE,
      unreadOnly: filter === 'unread',
      page: pageNumber(params.page),
    }),
    loadUnreadCount(),
  ]);

  return (
    <>
      <PageHeader
        title="Notifications"
        description="What happened to your tickets and your access, newest first. Opening one marks it read."
      />
      <NotificationsScreen
        items={result.items}
        total={result.total}
        page={result.page}
        pageCount={result.pageCount}
        filter={filter}
        unread={unread}
        todayKey={schoolToday()}
        now={requestTime()}
      />
    </>
  );
}
