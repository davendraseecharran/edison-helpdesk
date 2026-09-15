'use client';

/**
 * The bell in the top bar: an unread count, and the eight newest behind it.
 *
 * The count arrives with the page — the authenticated layout reads it once per
 * request — and is then kept current by polling: on window focus, and every 60
 * seconds while the tab is visible. There is no realtime subscription, by
 * design; a long-lived socket per signed-in technician is a lot of machinery for
 * a number that nobody watches, and a poll that fails costs nothing.
 *
 * The list is fetched when the dropdown opens rather than rendered into the
 * chrome of every page, because it is wanted on the presses that open it.
 *
 * Two surfaces, one body: a popover anchored to the bell from 720px up, and a
 * bottom sheet below that, where a popover pinned to the top-right corner of a
 * phone would be unreachable with a thumb. The popover is a real modal — it
 * traps focus, closes on Escape and on a press outside, and hands focus back to
 * the bell — so `role="dialog"` with `aria-modal` is honest, and the shell's
 * Ctrl+K guard correctly refuses to open the command palette on top of it.
 *
 * When an account has turned in-app notices off (`notify_in_app`), the count
 * disappears and the polling stops. The bell, the dropdown and `/notifications`
 * all stay: the setting is about being interrupted, not about losing access to
 * what happened.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import {
  ALL_CAUGHT_UP,
  NotificationList,
  useOptimisticReads,
} from '@/components/notifications/NotificationList';
import { Button } from '@/components/ui/Button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shadcn/popover';
import { usePhone } from '@/components/ui/media';
import { Sheet } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  markReadAction,
  recentNotificationsAction,
  refreshUnreadCountAction,
} from '@/lib/data/notification-actions';
import { bellLabel, isUnread, unreadBadge, type NotificationView } from '@/lib/domain/notifications';
import '@/styles/notifications.css';

/** How often the count is refetched while the tab is visible. */
const POLL_MS = 60_000;

const MARK_ALL_KEY = 'notifications:mark-all';

export interface NotificationsBellProps {
  /** Unread count as of this request, from the authenticated layout. */
  unread: number;
  /** The account's `notify_in_app` setting. False hides the count. */
  showCount?: boolean;
}

export function NotificationsBell({ unread, showCount = true }: NotificationsBellProps) {
  const { pendingKey, run } = useRuntime();
  const phone = usePhone();

  // The server count is the truth on every navigation; the local one also moves
  // when this component marks something read, so it is adjusted rather than
  // replaced. Comparing against the last value seen keeps the two in step
  // without an effect that would repaint the badge a frame late.
  const [count, setCount] = useState(unread);
  const [lastFromServer, setLastFromServer] = useState(unread);
  if (unread !== lastFromServer) {
    setLastFromServer(unread);
    setCount(unread);
  }

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationView[] | null>(null);
  // The clock the list was fetched against. The shared ticker takes over on the
  // next minute; this only has to be right for the first paint.
  const [fetchedAt, setFetchedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Only the newest fetch may write state: opening, closing and opening again
  // must not be settled by whichever response happens to land last.
  const request = useRef(0);

  // Refetch the count on focus and on a timer. A failed poll leaves the last
  // count on screen: a number that is a minute stale is better than a badge
  // that blinks away because the network did.
  useEffect(() => {
    if (!showCount) return;
    let alive = true;
    // Refocusing a tab fires `focus` and `visibilitychange` within the same
    // instant, both bound to this same function: without a guard, that is two
    // requests in flight for one refocus rather than one.
    let inFlight = false;

    async function refresh() {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try {
        const next = await refreshUnreadCountAction();
        if (alive) setCount(next);
      } catch {
        // Keep what is on screen.
      } finally {
        inFlight = false;
      }
    }

    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [showCount]);

  const load = useCallback(async () => {
    const ticket = request.current + 1;
    request.current = ticket;
    setLoading(true);
    setFailed(false);
    try {
      const next = await recentNotificationsAction();
      if (request.current === ticket) {
        setFetchedAt(Date.now());
        setItems(next);
      }
    } catch {
      if (request.current === ticket) setFailed(true);
    } finally {
      if (request.current === ticket) setLoading(false);
    }
  }, []);

  const close = useCallback(() => setOpen(false), []);

  function toggle() {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    void load();
  }

  // Opening a notice closes the surface it was opened from, in the same frame
  // as the navigation starts — whether or not the notice was unread. The
  // count only comes off for one that actually was: a click on an
  // already-read row must not double-count against it.
  const onOpened = useCallback((item: NotificationView) => {
    if (isUnread(item)) setCount((previous) => Math.max(0, previous - 1));
    setOpen(false);
  }, []);
  const { read, open: openItem } = useOptimisticReads(onOpened);

  const popoverOpen = open && !phone;

  async function markAll() {
    const result = await run(MARK_ALL_KEY, () => markReadAction(null));
    if (!result.ok) return;
    setCount(0);
    const at = new Date().toISOString();
    setItems((previous) =>
      previous === null ? previous : previous.map((item) => ({ ...item, readAt: item.readAt ?? at })),
    );
  }

  const badge = showCount ? unreadBadge(count) : null;

  const body =
    items === null && loading ? (
      <div className="notifications-pop-loading" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div key={row} className="notification notification-placeholder">
            <Skeleton width={20} height={20} circle />
            <span className="notification-text">
              <Skeleton width="min(220px, 70%)" />
              <Skeleton width="min(150px, 45%)" height={10} />
            </span>
          </div>
        ))}
      </div>
    ) : failed ? (
      <p className="notifications-pop-message">
        Notifications could not be loaded. Check your connection and open this again.
      </p>
    ) : items !== null && items.length === 0 ? (
      <p className="notifications-pop-message">{ALL_CAUGHT_UP}</p>
    ) : (
      <NotificationList items={items ?? []} read={read} now={fetchedAt} onOpen={openItem} />
    );

  const footer = (
    <div className="notifications-pop-foot">
      <Button
        variant="ghost"
        size="sm"
        icon={CheckCheck}
        onClick={markAll}
        disabled={count === 0}
        loading={pendingKey === MARK_ALL_KEY}
      >
        Mark all read
      </Button>
      <Link href="/notifications" className="btn btn-ghost btn-sm" onClick={close}>
        See all notifications
      </Link>
    </div>
  );

  const bell = (
    <span className="bell">
      <Button
        variant="ghost"
        icon={Bell}
        aria-label={bellLabel(count, showCount)}
        title="Notifications"
        onClick={toggle}
      />
      {badge ? (
        <span className="bell-count" aria-hidden="true">
          {badge}
        </span>
      ) : null}
    </span>
  );

  return (
    <>
      <Popover
        open={popoverOpen}
        onOpenChange={(next) => {
          if (next) toggle();
          else close();
        }}
      >
        <PopoverTrigger asChild>{bell}</PopoverTrigger>
        <PopoverContent aria-label="Notifications" className="notifications-pop">
          <h2 className="notifications-pop-title">Notifications</h2>
          <div className="notifications-pop-body">{body}</div>
          {footer}
        </PopoverContent>
      </Popover>

      {/* Below 720px the same content arrives as a bottom sheet, which brings
          its own focus trap, scroll lock and dismissal. */}
      <Sheet open={open && phone} onClose={close} side="bottom" title="Notifications" footer={footer}>
        {body}
      </Sheet>
    </>
  );
}
