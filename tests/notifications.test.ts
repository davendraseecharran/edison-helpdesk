import { describe, expect, it } from 'vitest';
import { Bell } from 'lucide-react';
import {
  NOTIFICATION_KINDS,
  bellLabel,
  groupNotifications,
  isNotificationKind,
  isUnread,
  notificationIcon,
  notificationLabel,
  safeHref,
  toNotificationFilter,
  unreadBadge,
  type NotificationView,
  notificationAction,
  ticketIdFromHref,
} from '../src/lib/domain/notifications';

/** A notice, with only the fields a test cares about spelled out. */
function notice(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: 'n1',
    kind: 'ticket_assigned',
    title: 'You were assigned EDT-1042',
    body: 'Chromebook will not charge',
    href: '/tickets/8f0a0f4e-0000-4000-8000-000000000001',
    createdAt: '2026-09-13T14:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('kinds', () => {
  // These are the kinds the migrations actually write. A drift here is a drift
  // in 20260914101000_m5_audit_notifications.sql, ..101020 or ..100100.
  it('covers every kind the database writes', () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual([
      'access_approved',
      'access_denied',
      'access_requested',
      'collaborator_added',
      'ticket_assigned',
      'ticket_claimed',
      'ticket_reopened',
      'ticket_returned',
    ]);
  });

  it('gives every kind its own label and glyph', () => {
    const labels = new Set<string>();
    for (const kind of NOTIFICATION_KINDS) {
      expect(isNotificationKind(kind)).toBe(true);
      const label = notificationLabel(kind);
      expect(label).toBeTruthy();
      // Sentence case, never a shouted or snake_case category.
      expect(label).not.toMatch(/_/);
      expect(label).toBe(label.charAt(0).toUpperCase() + label.slice(1));
      labels.add(label);
      expect(notificationIcon(kind)).toBeTruthy();
    }
    expect(labels.size).toBe(NOTIFICATION_KINDS.length);
  });

  it('shows a notice from a newer migration rather than dropping it', () => {
    expect(isNotificationKind('device_retired')).toBe(false);
    expect(notificationLabel('device_retired')).toBe('Notification');
    expect(notificationIcon('device_retired')).toBe(Bell);
    expect(notificationIcon('')).toBe(Bell);
  });
});

describe('unreadBadge', () => {
  it('shows nothing at zero and caps at nine', () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(-3)).toBeNull();
    expect(unreadBadge(1)).toBe('1');
    expect(unreadBadge(9)).toBe('9');
    expect(unreadBadge(10)).toBe('9+');
    expect(unreadBadge(4210)).toBe('9+');
  });

  it('refuses a count that is not a number it can render', () => {
    expect(unreadBadge(Number.NaN)).toBeNull();
    expect(unreadBadge(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('bellLabel', () => {
  it('carries the count in words, and drops it when notices are silenced', () => {
    expect(bellLabel(0, true)).toBe('Notifications');
    expect(bellLabel(1, true)).toBe('Notifications, 1 unread');
    expect(bellLabel(12, true)).toBe('Notifications, 12 unread');
    // notify_in_app false: the page stays reachable, the count stops announcing.
    expect(bellLabel(12, false)).toBe('Notifications');
  });
});

describe('safeHref', () => {
  it('keeps a relative in-app path', () => {
    expect(safeHref('/tickets/abc')).toBe('/tickets/abc');
    expect(safeHref('  /admin  ')).toBe('/admin');
    expect(safeHref('/queue')).toBe('/queue');
  });

  it('drops anything that would leave the application', () => {
    expect(safeHref('//evil.example/tickets')).toBeNull();
    expect(safeHref('https://evil.example')).toBeNull();
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('tickets/abc')).toBeNull();
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });
});

describe('groupNotifications', () => {
  const today = '2026-09-13';

  it('splits the list into today and earlier, in that order', () => {
    // 14:00Z is 10am in New York on the 13th; 02:00Z on the 14th is 10pm on
    // the 13th, still today at the desk.
    const groups = groupNotifications(
      [
        notice({ id: 'a', createdAt: '2026-09-14T02:00:00.000Z' }),
        notice({ id: 'b', createdAt: '2026-09-13T14:00:00.000Z' }),
        notice({ id: 'c', createdAt: '2026-09-12T23:00:00.000Z' }),
      ],
      today,
    );
    expect(groups.map((group) => group.key)).toEqual(['today', 'earlier']);
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Earlier']);
    expect(groups[0].items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(groups[1].items.map((item) => item.id)).toEqual(['c']);
  });

  it('groups by the school day, not by UTC', () => {
    // 03:00Z on the 13th is 11pm on the 12th in New York: yesterday's work.
    const groups = groupNotifications([notice({ createdAt: '2026-09-13T03:00:00.000Z' })], today);
    expect(groups.map((group) => group.key)).toEqual(['earlier']);
  });

  it('drops an empty group instead of showing an empty heading', () => {
    expect(
      groupNotifications([notice({ createdAt: '2026-09-10T14:00:00.000Z' })], today).map(
        (group) => group.key,
      ),
    ).toEqual(['earlier']);
    expect(
      groupNotifications([notice({ createdAt: '2026-09-13T14:00:00.000Z' })], today).map(
        (group) => group.key,
      ),
    ).toEqual(['today']);
    expect(groupNotifications([], today)).toEqual([]);
  });

  it('treats an unreadable timestamp as old news rather than today', () => {
    const groups = groupNotifications([notice({ createdAt: 'not a date' })], today);
    expect(groups.map((group) => group.key)).toEqual(['earlier']);
  });

  it('keeps the order it was given inside each group', () => {
    const groups = groupNotifications(
      [
        notice({ id: 'first', createdAt: '2026-09-13T18:00:00.000Z' }),
        notice({ id: 'second', createdAt: '2026-09-13T12:00:00.000Z' }),
      ],
      today,
    );
    expect(groups[0].items.map((item) => item.id)).toEqual(['first', 'second']);
  });
});

describe('read state and filters', () => {
  it('reads unread from the absence of a read timestamp', () => {
    expect(isUnread(notice())).toBe(true);
    expect(isUnread(notice({ readAt: '2026-09-13T15:00:00.000Z' }))).toBe(false);
  });

  it('takes only "unread" from the URL and ignores anything else', () => {
    expect(toNotificationFilter('unread')).toBe('unread');
    expect(toNotificationFilter(['unread', 'all'])).toBe('unread');
    expect(toNotificationFilter('all')).toBe('all');
    expect(toNotificationFilter('UNREAD')).toBe('all');
    expect(toNotificationFilter(undefined)).toBe('all');
    expect(toNotificationFilter('')).toBe('all');
  });
});

describe('the action a notice carries', () => {
  function notice(kind: string, href: string | null): NotificationView {
    return { id: `n-${kind}`, kind, title: kind, body: null, href, createdAt: '', readAt: null };
  }

  it('reads the ticket out of the link, and only out of a ticket link', () => {
    expect(ticketIdFromHref('/tickets/abc-123')).toBe('abc-123');
    expect(ticketIdFromHref('/tickets/a%2Fb')).toBe('a/b');
    expect(ticketIdFromHref('/tickets/abc/extra')).toBeNull();
    expect(ticketIdFromHref('/people/abc')).toBeNull();
    expect(ticketIdFromHref('//evil.example/tickets/abc')).toBeNull();
    expect(ticketIdFromHref(null)).toBeNull();
  });

  it('offers to claim a ticket that was returned to the queue', () => {
    expect(notificationAction(notice('ticket_returned', '/tickets/t1'))).toEqual({
      kind: 'claim',
      label: 'Claim',
      ticketId: 't1',
    });
  });

  it('offers to review an access request', () => {
    expect(notificationAction(notice('access_requested', '/admin'))).toEqual({
      kind: 'review',
      label: 'Review',
      href: '/admin',
    });
  });

  it('opens everything else, which is what the row already did', () => {
    expect(notificationAction(notice('ticket_assigned', '/tickets/t1'))?.kind).toBe('open');
    expect(notificationAction(notice('collaborator_added', '/tickets/t1'))?.kind).toBe('open');
  });

  it('offers nothing for a notice with nowhere to go', () => {
    expect(notificationAction(notice('ticket_assigned', null))).toBeNull();
    // A returned-ticket notice whose link is not a ticket falls back rather
    // than offering to claim something it cannot name.
    expect(notificationAction(notice('ticket_returned', '/queue'))?.kind).toBe('open');
  });
});
