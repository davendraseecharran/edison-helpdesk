'use server';

/**
 * Taking attendance.
 *
 * Every call is one of the owner's SECURITY DEFINER functions on the signed-in
 * user's client, so membership, the actor and the history are the database's
 * to decide. Nothing here checks who may do what: any active account runs the
 * chapter's own business, and the database says so.
 *
 * `markByKeyAction` is the scanner's: it returns the outcome rather than an
 * ActionResult, because the five answers — present, already, not a member, no
 * match, more than one match — are the whole point and a boolean would throw
 * four of them away. The page turns each into one line somebody can act on.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import { callRpc } from '@/lib/data/rpc';
// Shapes live in the pure module: this file may export only async functions.
import type { MarkByKeyResult, MarkOutcome } from '@/lib/domain/groups';

export async function createGroupEventAction(
  groupId: string,
  name: string,
  heldOn: string,
): Promise<ActionResult> {
  return callRpc(
    'app_create_group_event',
    { p_group: groupId, p_name: name, p_held_on: heldOn || null },
    'Event added.',
  );
}

export async function deleteGroupEventAction(eventId: string): Promise<ActionResult> {
  return callRpc('app_delete_group_event', { p_event: eventId }, 'Event deleted.');
}

/**
 * One tick. No message: the box itself is the confirmation, and a toast for
 * every one of twenty-four people would be the desk narrating a register.
 */
export async function markAttendanceAction(
  eventId: string,
  requesterId: string,
  present: boolean,
): Promise<ActionResult> {
  return callRpc('app_mark_attendance', {
    p_event: eventId,
    p_requester: requesterId,
    p_present: present,
  });
}

/** What a scanned card or a typed identifier did. */
export async function markByKeyAction(eventId: string, key: string): Promise<MarkByKeyResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return {
      outcome: 'error',
      requesterId: null,
      displayName: null,
      error: 'Your session is not able to make changes. Sign in again.',
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_mark_attendance_by_key', {
    p_event: eventId,
    p_key: key,
  });
  if (error) {
    return { outcome: 'error', requesterId: null, displayName: null, error: error.message };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; requester_id: string | null; display_name: string | null }
    | undefined;
  if (row === undefined) {
    return {
      outcome: 'error',
      requesterId: null,
      displayName: null,
      error: 'That did not go through. Nothing changed.',
    };
  }

  const outcome: MarkOutcome =
    row.outcome === 'present' ||
    row.outcome === 'already' ||
    row.outcome === 'not_member' ||
    row.outcome === 'ambiguous'
      ? row.outcome
      : 'no_match';

  return { outcome, requesterId: row.requester_id, displayName: row.display_name };
}
