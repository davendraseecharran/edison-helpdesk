/**
 * In-app notices: the vocabulary, how each kind is drawn, and how a list of
 * them is grouped for reading.
 *
 * Pure on purpose, like `preferences.ts`. The database owns the notices —
 * `app_notify()` writes them, `app_notifications()` reads them back and
 * `app_mark_notifications_read()` is the only way read state changes — and this
 * module is the display knowledge that goes with them: the label and glyph for
 * each kind, and the two buckets a list is read in. Nothing here is a security
 * boundary; the one rule that looks like one (`safeHref`) is a second gate in
 * front of a column the schema already promises is a relative in-app path.
 *
 * A kind this build does not recognise is still shown. Notices are written by
 * migrations, so a deployment can be one release behind the database, and the
 * right answer to an unknown kind is a plain bell and the title the database
 * wrote — never a blank row.
 */

import {
  Bell,
  CalendarRange,
  HandHelping,
  KeyRound,
  ShieldCheck,
  ShieldX,
  Undo2,
  UserCheck,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { toDateKey } from '@/lib/format';

/**
 * Every kind the migrations write, with the RPC that writes it:
 *   - `ticket_assigned`    app_reassign_ticket        → the new owner
 *   - `ticket_claimed`     app_claim_ticket           → the technician who held it
 *   - `ticket_returned`    app_return_ticket_to_queue → active administrators
 *   - `ticket_reopened`    app_reopen_ticket          → the owner
 *   - `collaborator_added` app_add_collaborator       → the new collaborator
 *   - `collaborator_joined` app_join_ticket           → the owner
 *   - `access_requested`   app_trusted_link_identity  → active administrators
 *   - `access_approved`/`access_denied`
 *     app_admin_review_access_request → the requester
 *   - `weekly_summary`     app_weekly_summary_notify  → the account itself, once a week
 */
export const NOTIFICATION_KINDS = [
  'ticket_assigned',
  'ticket_claimed',
  'ticket_returned',
  'ticket_reopened',
  'collaborator_added',
  'collaborator_joined',
  'access_requested',
  'access_approved',
  'access_denied',
  'weekly_summary',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** One notice as the interface sees it. Mirrors a `public.notifications` row. */
export interface NotificationView {
  id: string;
  /** One of `NOTIFICATION_KINDS`, or something a newer migration writes. */
  kind: string;
  title: string;
  body: string | null;
  /** A relative in-app path, already checked by `safeHref`. */
  href: string | null;
  createdAt: string;
  readAt: string | null;
}

/** Which notices a view is showing. */
export type NotificationFilter = 'all' | 'unread';

/**
 * The kind, said in words.
 *
 * Shown to assistive technology and in the row's tooltip rather than on screen:
 * the title the database wrote already reads as a sentence, and repeating the
 * category next to it would be noise. It exists so the glyph is never the only
 * thing carrying the category.
 */
const KIND_LABELS: Record<NotificationKind, string> = {
  ticket_assigned: 'Assigned to you',
  ticket_claimed: 'Claimed by someone else',
  ticket_returned: 'Returned to the Open Queue',
  ticket_reopened: 'Reopened',
  collaborator_added: 'Added as a collaborator',
  collaborator_joined: 'Joined your ticket',
  access_requested: 'Access requested',
  access_approved: 'Access approved',
  access_denied: 'Access declined',
  weekly_summary: 'Your week in review',
};

const KIND_ICONS: Record<NotificationKind, LucideIcon> = {
  ticket_assigned: UserCheck,
  ticket_claimed: HandHelping,
  ticket_returned: Undo2,
  ticket_reopened: KeyRound,
  collaborator_added: UserPlus,
  collaborator_joined: UserPlus,
  access_requested: Bell,
  access_approved: ShieldCheck,
  access_denied: ShieldX,
  weekly_summary: CalendarRange,
};

export function isNotificationKind(value: unknown): value is NotificationKind {
  return NOTIFICATION_KINDS.includes(value as NotificationKind);
}

/** What this kind is called. An unrecognised kind reads as a plain notice. */
export function notificationLabel(kind: string): string {
  return isNotificationKind(kind) ? KIND_LABELS[kind] : 'Notification';
}

/** The glyph for this kind. An unrecognised kind gets the bell. */
export function notificationIcon(kind: string): LucideIcon {
  return isNotificationKind(kind) ? KIND_ICONS[kind] : Bell;
}

/**
 * What the count dot says, or null when there is nothing to show.
 *
 * Capped at "9+": the dot sits on a 40px button, and the exact number past
 * nine changes nothing about what the reader does next.
 */
export function unreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? '9+' : String(Math.floor(count));
}

/** The bell's accessible name, which has to carry the count on its own. */
export function bellLabel(count: number, showCount: boolean): string {
  if (!showCount || count <= 0) return 'Notifications';
  return count === 1 ? 'Notifications, 1 unread' : `Notifications, ${count} unread`;
}

/**
 * A notice's link, or null.
 *
 * The schema promises a relative in-app path and nothing writes anything else,
 * so this is a second gate rather than the rule: a protocol-relative `//host`
 * or an absolute URL is dropped instead of rendered as a link out of the
 * application. A dropped href leaves the row as plain text, which still reads.
 */
export function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  return trimmed;
}

/**
 * The ticket a notice points at, or null.
 *
 * Every ticket notice carries `/tickets/<id>` as its link, which is the only
 * place the id appears — the row is written by the database and holds a path,
 * not a foreign key. Parsed rather than trusted: a path that is not a ticket
 * path yields null, so an action is never offered against something that is not
 * a ticket.
 */
export function ticketIdFromHref(href: string | null): string | null {
  const safe = safeHref(href);
  if (safe === null) return null;
  const match = /^\/tickets\/([^/?#]+)$/.exec(safe);
  return match ? decodeURIComponent(match[1]) : null;
}

/** What a notice offers to do about itself, beside opening it. */
export type NotificationAction =
  | { kind: 'claim'; label: string; ticketId: string }
  | { kind: 'review'; label: string; href: string }
  | { kind: 'open'; label: string; href: string }
  | null;

/**
 * The one action this notice is about.
 *
 * A notice is a thing that happened and a thing you might do about it, and the
 * second half was missing: every row navigated, and claiming the ticket
 * somebody had just returned meant opening it, finding the button and coming
 * back. The kinds that carry a real action are the two where the notice IS the
 * work — a ticket returned to the queue, and somebody waiting to be let in.
 * Everything else opens, which is what the row already did.
 */
export function notificationAction(item: NotificationView): NotificationAction {
  const href = safeHref(item.href);
  if (item.kind === 'ticket_returned') {
    const ticketId = ticketIdFromHref(item.href);
    if (ticketId) return { kind: 'claim', label: 'Claim', ticketId };
  }
  if (item.kind === 'access_requested' && href) {
    return { kind: 'review', label: 'Review', href };
  }
  if (href) return { kind: 'open', label: 'Open', href };
  return null;
}

/** Whether a notice has not been read yet. */
export function isUnread(item: NotificationView): boolean {
  return item.readAt === null;
}

export interface NotificationGroup {
  key: 'today' | 'earlier';
  label: string;
  items: NotificationView[];
}

/**
 * Today and everything before it, in that order.
 *
 * Two buckets rather than a date per row: the list is read newest first and the
 * only question a reader has is whether something happened while they were at
 * the desk. "Today" is the school-local day (`toDateKey`), computed on the
 * server and handed down, so the server render and the hydrated one agree and a
 * notice written at 11pm does not jump groups because the browser is on UTC.
 *
 * Empty groups are dropped, so a list with nothing from today starts at
 * "Earlier" rather than showing an empty heading. A list that is entirely from
 * today still gets its heading: the grouping has to look the same either way,
 * or the page changes shape as the day turns over.
 */
export function groupNotifications(
  items: NotificationView[],
  todayKey: string,
): NotificationGroup[] {
  const today: NotificationView[] = [];
  const earlier: NotificationView[] = [];
  for (const item of items) {
    const at = new Date(item.createdAt);
    const key = Number.isNaN(at.getTime()) ? null : toDateKey(at);
    // An unparseable timestamp is old news, not today's: it must not be
    // promoted into the group a reader scans first.
    (key === todayKey ? today : earlier).push(item);
  }
  const groups: NotificationGroup[] = [];
  if (today.length > 0) groups.push({ key: 'today', label: 'Today', items: today });
  if (earlier.length > 0) groups.push({ key: 'earlier', label: 'Earlier', items: earlier });
  return groups;
}

/** The filter a URL asked for. Anything else means the unfiltered list. */
export function toNotificationFilter(value: string | string[] | undefined): NotificationFilter {
  const first = Array.isArray(value) ? value[0] : value;
  return first === 'unread' ? 'unread' : 'all';
}
