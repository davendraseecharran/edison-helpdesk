import 'server-only';

/**
 * Authorized reads for the rosters.
 *
 * Both reads are the owner's own SECURITY DEFINER functions called on the
 * signed-in user's client, so the active-account gate is the database's and
 * nothing here filters in JavaScript for security. `app_list_groups` is
 * deliberately unpaged — a school has tens of groups, not thousands — which is
 * also why one group is found by reading the list rather than by a function of
 * its own: it is one round trip either way, and there is one fewer thing in the
 * API surface for the next person to keep in step.
 */

import { createClient } from '@/lib/supabase/server';
import type { PersonKind } from '@/lib/domain/types';

export interface GroupSummary {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  updatedAt: string;
}

export interface GroupMember {
  id: string;
  displayName: string;
  kind: PersonKind;
  /** OSIS or staff id. Null for a record that arrived without one. */
  externalId: string | null;
  email: string | null;
  /** A student's official class, a member of staff's department. */
  groupLabel: string | null;
  note: string;
  addedAt: string;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  member_count: number | null;
  updated_at: string;
}

interface MemberRow {
  requester_id: string;
  display_name: string;
  kind: string;
  external_id: string | null;
  email: string | null;
  group_label: string | null;
  note: string | null;
  added_at: string;
}

function mapGroup(row: GroupRow): GroupSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    memberCount: Number(row.member_count ?? 0),
    updatedAt: row.updated_at,
  };
}

function mapMember(row: MemberRow): GroupMember {
  return {
    id: row.requester_id,
    displayName: row.display_name,
    kind: row.kind === 'staff' ? 'staff' : 'student',
    externalId: row.external_id,
    email: row.email,
    groupLabel: row.group_label,
    note: row.note ?? '',
    addedAt: row.added_at,
  };
}

export async function loadGroups(): Promise<GroupSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_groups');
  if (error) throw new Error(`Could not load the groups: ${error.message}`);
  return ((data ?? []) as GroupRow[]).map(mapGroup);
}

export interface GroupDetail {
  group: GroupSummary;
  members: GroupMember[];
}

/**
 * One group with its people, or null when there is no such group — which is
 * also the answer for a caller who may not see it, deliberately
 * indistinguishable, as every other record read here is.
 */
export async function loadGroup(id: string): Promise<GroupDetail | null> {
  const supabase = await createClient();
  const [list, members] = await Promise.all([
    supabase.rpc('app_list_groups'),
    supabase.rpc('app_group_members', { p_group: id }),
  ]);

  if (list.error) return null;
  const group = ((list.data ?? []) as GroupRow[]).find((row) => row.id === id);
  if (group === undefined) return null;

  return {
    group: mapGroup(group),
    members: ((members.data ?? []) as MemberRow[]).map(mapMember),
  };
}
