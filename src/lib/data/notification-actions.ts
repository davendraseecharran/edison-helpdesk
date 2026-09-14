'use server';

/**
 * The three things the notifications interface asks the server for.
 *
 * Marking read is a real mutation and goes through the reviewed RPC with the
 * signed-in user's own JWT: `app_mark_notifications_read()` begins with
 * `app_require_actor()`, so the database re-derives who is calling and refuses a
 * session that is inactive, mid-recovery or superseded. Ids from the browser are
 * a filter, never an authority — the RPC only ever touches rows belonging to the
 * actor it derived, so an id from another account simply matches nothing and the
 * returned count says so.
 *
 * The two reads exist because the bell is a client component: it opens after
 * hydration and polls, so its list and its count cannot come from the page's
 * server render. Both delegate to `notifications.ts`, which runs under the
 * caller's session like every other read.
 *
 * Server Actions are POST-only by construction and are protected by Next.js's
 * built-in action-id and origin checks, so no state-changing GET exists here.
 */

import { revalidatePath } from 'next/cache';
// A malformed id is dropped before the trip; the RPC still decides ownership.
import { isUuid } from '@/lib/guards';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import type { NotificationView } from '@/lib/domain/notifications';
import {
  BELL_NOTIFICATION_LIMIT,
  loadNotifications,
  loadUnreadCount,
} from '@/lib/data/notifications';

/**
 * Marks notices read. `null` marks every unread notice the caller has.
 *
 * The ids are narrowed to well-formed uuids first, which saves a round trip on
 * an obvious mistake without being the thing that enforces ownership; the RPC
 * does that. An empty list after narrowing is not turned into "mark everything":
 * that would be the opposite of what the caller asked for.
 */
export async function markReadAction(ids: string[] | null): Promise<ActionResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to make changes. Sign in again.' };
  }

  let selected: string[] | null = null;
  if (ids !== null) {
    selected = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && isUuid(id)) : [];
    if (selected.length === 0) return { ok: true };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_mark_notifications_read', { p_ids: selected });
  if (error) return { ok: false, error: error.message };

  // The bell's count is rendered by the authenticated layout, so every page
  // needs rebuilding for it to change; the notifications page is server
  // rendered too, and the unread filter changes shape when rows are read.
  revalidatePath('/', 'layout');

  // Reading one row as it is opened is not worth a toast; "Mark all read" is a
  // deliberate press and says what it did.
  if (selected !== null) return { ok: true };
  const marked = typeof data === 'number' ? data : 0;
  return {
    ok: true,
    message: marked === 0 ? 'Nothing was unread.' : 'All notifications marked read.',
  };
}

/**
 * The unread count, for the bell's poll on focus and every 60 seconds.
 *
 * Reads as zero for a session that cannot read notices, which is what the bell
 * should show for one.
 */
export async function refreshUnreadCountAction(): Promise<number> {
  return loadUnreadCount();
}

/**
 * The newest notices, for the dropdown when it opens.
 *
 * The bell asks for these instead of the layout server-rendering them into the
 * chrome of every page: the list is wanted on the presses that open the
 * dropdown, not on every navigation.
 */
export async function recentNotificationsAction(): Promise<NotificationView[]> {
  const page = await loadNotifications({ limit: BELL_NOTIFICATION_LIMIT });
  return page.items;
}
