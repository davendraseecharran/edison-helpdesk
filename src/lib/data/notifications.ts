import 'server-only';

/**
 * Reads of the signed-in account's own notices.
 *
 * Both reads run in the caller's session, so the database decides what comes
 * back. `app_unread_notification_count()` and `app_notifications()` are
 * SECURITY INVOKER and filter on `app_active_account_id()`, which is NULL for an
 * anonymous, inactive, setup_pending, credential-pending or stale-token caller;
 * the paged read goes straight at the table, where the `notifications_select_own`
 * policy applies the same rule. There is no path here that can see another
 * account's notices, and no id from the browser is trusted: neither read takes
 * an account parameter.
 *
 * Why the paged read is a table query rather than the RPC: `app_notifications()`
 * takes a limit and no offset, and caps that limit at 100. That is the right
 * shape for the bell (the eight newest) and the wrong one for a page somebody
 * scrolls back through, which needs an offset and an exact total. The table is
 * granted SELECT to `authenticated` for exactly this, behind the same policy the
 * RPC relies on, so the two reads are equally private.
 *
 * A failure is reported, not swallowed: an empty notifications page and a
 * notifications page that could not be read look identical, and the second one
 * is a lie. The bell's count is the one exception — see `loadUnreadCount`.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { safeHref, type NotificationView } from '@/lib/domain/notifications';

export type { NotificationView };

/** The page's page. 25 rows, like every other list in the application. */
export const NOTIFICATIONS_PAGE_SIZE = 25;

/** How many the bell's dropdown lists. */
export const BELL_NOTIFICATION_LIMIT = 8;

/** The ceiling `app_notifications()` enforces on its own limit. */
const RPC_LIMIT_CEILING = 100;

export interface NotificationsPage {
  items: NotificationView[];
  /** Total matching the current filter. Equals `items.length` for the bell read. */
  total: number;
  page: number;
  pageCount: number;
}

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  created_at: string;
  read_at: string | null;
}

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    // The column is documented as a relative in-app path and nothing writes
    // anything else; checking again here means a row that somehow held an
    // absolute URL renders as text instead of as a way out of the application.
    href: safeHref(row.href),
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export interface NotificationsQuery {
  /** Rows per read. Ignored past 100 on the unpaged read, which the RPC caps. */
  limit?: number;
  unreadOnly?: boolean;
  /** 1-based. Omit it for the newest `limit` rows in one go, as the bell wants. */
  page?: number;
}

/**
 * The caller's notices, newest first.
 *
 * With `page`, a paged slice with an exact total, for `/notifications`. Without
 * it, the newest `limit` through the reviewed RPC, for the bell.
 */
export async function loadNotifications({
  limit = NOTIFICATIONS_PAGE_SIZE,
  unreadOnly = false,
  page,
}: NotificationsQuery = {}): Promise<NotificationsPage> {
  const supabase = await createClient();
  const size = Math.max(1, Math.min(Math.floor(limit), RPC_LIMIT_CEILING));

  if (page === undefined) {
    const { data, error } = await supabase.rpc('app_notifications', {
      p_limit: size,
      p_unread_only: unreadOnly,
    });
    if (error) throw new Error(`Could not load notifications: ${error.message}`);
    const items = ((data ?? []) as NotificationRow[]).map(toView);
    return { items, total: items.length, page: 1, pageCount: 1 };
  }

  const current = Math.max(1, Math.floor(page));
  const from = (current - 1) * size;

  let query = supabase
    .from('notifications')
    .select('id, kind, title, body, href, created_at, read_at', { count: 'exact' })
    // The same ordering the RPC uses: id breaks ties so paging is deterministic
    // when two notices share an instant.
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + size - 1);
  if (unreadOnly) query = query.is('read_at', null);

  const { data, error, count } = await query;
  if (error) throw new Error(`Could not load notifications: ${error.message}`);

  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / size));
  // Marking everything read while on page 3 of the unread filter empties the
  // list under the reader. Go back to the first page rather than show a count
  // with no rows and no way back.
  if (data !== null && data.length === 0 && current > 1 && total > 0) {
    return loadNotifications({ limit, unreadOnly, page: 1 });
  }

  return {
    items: ((data ?? []) as NotificationRow[]).map(toView),
    total,
    page: Math.min(current, pageCount),
    pageCount,
  };
}

/**
 * How many notices the caller has not read.
 *
 * Memoised for the render pass, so the layout asks once however many components
 * want it. A failure reads as zero on purpose: this one number decorates a
 * button in the chrome of every authenticated page, and a count that could not
 * be fetched is not a reason to fail the page the reader actually asked for.
 * The dropdown and `/notifications` both report their own failures.
 */
export const loadUnreadCount = cache(async (): Promise<number> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_unread_notification_count');
  if (error || typeof data !== 'number') return 0;
  return Math.max(0, data);
});
