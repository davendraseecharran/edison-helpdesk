import 'server-only';

/**
 * Authorized reads for attendance.
 *
 * Both reads are the owner's SECURITY DEFINER functions on the signed-in
 * user's client. One event is found by reading its group's list and picking it
 * out, exactly as one group is found by reading `app_list_groups`: a group
 * holds tens of events, the list carries the two counts the page needs anyway,
 * and there is one fewer function for the next person to keep in step.
 */

import { createClient } from '@/lib/supabase/server';
import type { PersonKind } from '@/lib/domain/types';

export interface GroupEventSummary {
  id: string;
  name: string;
  /** School-local calendar day, `YYYY-MM-DD`. */
  heldOn: string;
  presentCount: number;
  /** The group's membership now, which is what the count is read against. */
  memberCount: number;
}

export interface RollEntry {
  id: string;
  displayName: string;
  kind: PersonKind;
  externalId: string | null;
  groupLabel: string | null;
  present: boolean;
  markedAt: string | null;
}

interface EventRow {
  id: string;
  name: string;
  held_on: string;
  present_count: number | null;
  member_count: number | null;
}

interface RollRow {
  requester_id: string;
  display_name: string;
  kind: string;
  external_id: string | null;
  group_label: string | null;
  present: boolean | null;
  marked_at: string | null;
}

function mapEvent(row: EventRow): GroupEventSummary {
  return {
    id: row.id,
    name: row.name,
    heldOn: row.held_on,
    presentCount: Number(row.present_count ?? 0),
    memberCount: Number(row.member_count ?? 0),
  };
}

function mapRoll(row: RollRow): RollEntry {
  return {
    id: row.requester_id,
    displayName: row.display_name,
    kind: row.kind === 'staff' ? 'staff' : 'student',
    externalId: row.external_id,
    groupLabel: row.group_label,
    present: row.present === true,
    markedAt: row.marked_at,
  };
}

export async function loadGroupEvents(groupId: string): Promise<GroupEventSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_group_events', { p_group: groupId });
  if (error) return [];
  return ((data ?? []) as EventRow[]).map(mapEvent);
}

export interface EventDetail {
  event: GroupEventSummary;
  groupId: string;
  groupName: string;
  roll: RollEntry[];
}

/**
 * One event with its roll, or null when there is no such event in that group —
 * which is also the answer when the link is to the wrong group, so a URL
 * cannot be edited into somebody else's roster.
 */
export async function loadGroupEvent(
  groupId: string,
  eventId: string,
): Promise<EventDetail | null> {
  const supabase = await createClient();
  const [groups, events, roll] = await Promise.all([
    supabase.rpc('app_list_groups'),
    supabase.rpc('app_list_group_events', { p_group: groupId }),
    supabase.rpc('app_event_roll', { p_event: eventId }),
  ]);

  if (events.error) return null;
  const event = ((events.data ?? []) as EventRow[]).find((row) => row.id === eventId);
  if (event === undefined) return null;

  const group = ((groups.data ?? []) as Array<{ id: string; name: string }>).find(
    (row) => row.id === groupId,
  );

  return {
    event: mapEvent(event),
    groupId,
    groupName: group?.name ?? 'the group',
    roll: ((roll.data ?? []) as RollRow[]).map(mapRoll),
  };
}
