'use client';

/**
 * One notice, in the dropdown and on the page alike.
 *
 * The whole row is the link, so the press target is the thing a reader is
 * looking at rather than a word inside it. Opening a notice marks it read: the
 * row was the notice, and having read it is what a reader means by having read
 * it. That happens optimistically — the row loses its marker in the same frame
 * as the navigation starts — because waiting on a round trip to dim a row the
 * reader is already leaving would only ever be visible when it failed.
 *
 * Nothing here is carried by colour or by a glyph alone: the kind's icon is
 * labelled with what it means, so the row is announced as "Assigned to you, You
 * were assigned EDT-1042, 4h, Unread", and the lit dot has the word "Unread"
 * beside it for anything that cannot see a dot.
 *
 * The age is the queue's one-token form ("12m", "4h", "2d", "5w") with the full
 * timestamp on hover, and it is computed from a clock the server handed down
 * until the shared ticker takes over after hydration — so the first paint of a
 * server-rendered list matches, and nothing reflows a second later.
 */

import Link from 'next/link';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { claimTicketAction } from '@/lib/data/actions';
import { ageLabel, formatDateTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import {
  notificationAction,
  notificationIcon,
  notificationLabel,
  type NotificationView,
} from '@/lib/domain/notifications';

export interface NotificationItemProps {
  item: NotificationView;
  /** Read as of this render, including a row opened a moment ago. */
  read: boolean;
  /** The clock this list was rendered against, until the ticker takes over. */
  now: number;
  /** Called when the row is opened, before navigation. */
  onOpen?: (item: NotificationView) => void;
}

export function NotificationItem({ item, read, now, onOpen }: NotificationItemProps) {
  const { pendingKey, run } = useRuntime();
  const tick = useNow();
  const at = new Date(tick ?? now);
  const absolute = formatDateTime(item.createdAt);

  const body = (
    <>
      <span className="notification-glyph">
        <Icon icon={notificationIcon(item.kind)} size={16} label={notificationLabel(item.kind)} />
      </span>
      <span className="notification-text">
        <span className="notification-title">{item.title}</span>
        {item.body ? <span className="notification-body">{item.body}</span> : null}
      </span>
      <span className="notification-meta">
        <time dateTime={item.createdAt} title={absolute}>
          {ageLabel(item.createdAt, at)}
        </time>
        <span className="notification-state">
          {read ? null : <span className="notification-dot" aria-hidden="true" />}
          <span className="visually-hidden">{read ? 'Read' : 'Unread'}</span>
        </span>
      </span>
    </>
  );

  const className = read ? 'notification' : 'notification notification-unread';

  /*
   * The action the notice is about, beside the notice.
   *
   * A notice used to be half a thing: it said what happened and then made you
   * go and find the button. Claiming a ticket somebody had just returned meant
   * opening it, scrolling to Claim, and coming back for the next row. The
   * action sits on the row now, and pressing it marks the notice read — you
   * have plainly read it.
   *
   * It is a sibling of the link rather than a child of it, because a button
   * inside a link is a press with two meanings.
   */
  const action = notificationAction(item);
  const claimKey = action?.kind === 'claim' ? `claim:${action.ticketId}` : null;

  // Every kind the migrations write carries a path. A notice without one is
  // still worth showing; it simply has nowhere to go, so it is not a link.
  const row = item.href ? (
    <Link className={className} href={item.href} onClick={() => onOpen?.(item)}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );

  if (action === null || action.kind === 'open') return row;

  return (
    <div className="notification-row">
      {row}
      <div className="notification-action">
        {action.kind === 'claim' ? (
          <Button
            size="sm"
            disabled={pendingKey !== null}
            loading={pendingKey === claimKey}
            onClick={() => {
              onOpen?.(item);
              void run(claimKey!, () => claimTicketAction(action.ticketId));
            }}
          >
            {action.label}
          </Button>
        ) : (
          <Link className="btn btn-secondary btn-sm" href={action.href} onClick={() => onOpen?.(item)}>
            {action.label}
          </Link>
        )}
      </div>
    </div>
  );
}
