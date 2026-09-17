'use server';

/**
 * Everything that changes a roster.
 *
 * Every one of these calls a SECURITY DEFINER function with the signed-in
 * user's own JWT, so the database re-derives the actor, applies the rules
 * (every active account may edit a roster; only an administrator may delete
 * one) and writes its own history entry. Nothing here checks a role before
 * asking: the screen hides what somebody cannot do, and the database is what
 * refuses it.
 *
 * `resolvePeopleAction` is the paste box. It resolves a column of OSIS
 * numbers, staff ids, emails and names through `app_find_people` — the same
 * reader the assistant's `find_people` uses — and answers one row per line, in
 * the order they were pasted, so a list of thirty-one can be looked at before
 * a single person is added.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import { callRpc } from '@/lib/data/rpc';
// A module marked `'use server'` may export nothing but async functions: every
// export of one is an endpoint. The ceiling and the shape live in the pure
// module both this and the screens import.
import { PASTE_LIMIT, type ResolvedPerson } from '@/lib/domain/groups';

export async function createGroupAction(
  name: string,
  description: string,
): Promise<ActionResult> {
  return callRpc(
    'app_create_group',
    { p_name: name, p_description: description },
    'Group created.',
  );
}

export async function updateGroupAction(
  id: string,
  name: string,
  description: string,
): Promise<ActionResult> {
  return callRpc(
    'app_update_group',
    { p_group: id, p_name: name, p_description: description },
    'Group saved.',
  );
}

export async function deleteGroupAction(id: string): Promise<ActionResult> {
  return callRpc('app_delete_group', { p_group: id }, 'Group deleted.');
}

/**
 * Adds people, and says what actually happened rather than what was asked for.
 *
 * The database returns how many rows it wrote, which is the number of people
 * who were not already in the group. "Added 28 of 31" is the true sentence
 * when three were already members, and it is the one somebody needs: the other
 * three are not missing, they are in there twice over.
 */
export async function addGroupMembersAction(
  id: string,
  requesterIds: string[],
): Promise<ActionResult> {
  const asked = requesterIds.length;
  return callRpc('app_add_group_members', { p_group: id, p_requesters: requesterIds }, (result) => {
    const added = result.count ?? 0;
    if (added === 0) return 'Everybody on that list is already in the group.';
    const people = added === 1 ? 'person' : 'people';
    if (added === asked) return `Added ${added} ${people}.`;
    return `Added ${added} of ${asked}. The rest were already in the group.`;
  });
}

export async function removeGroupMemberAction(
  id: string,
  requesterId: string,
): Promise<ActionResult> {
  return callRpc(
    'app_remove_group_member',
    { p_group: id, p_requester: requesterId },
    'Taken out of the group.',
  );
}

/**
 * The note beside one member. No message: a note is edited in the cell it
 * lives in, where the value on screen is already the confirmation, and a toast
 * for every one of them would be the desk talking about its own typing.
 */
export async function setGroupMemberNoteAction(
  id: string,
  requesterId: string,
  note: string,
): Promise<ActionResult> {
  return callRpc('app_set_group_member_note', {
    p_group: id,
    p_requester: requesterId,
    p_note: note,
  });
}

interface FindRow {
  key: string;
  found: string;
  matches: number | null;
  id: string | null;
  display_name: string | null;
  kind: string | null;
  group_label: string | null;
}

/**
 * Reads a pasted block into one answer per line.
 *
 * Blank lines are dropped and a line repeated is asked once, because somebody
 * pasting a column out of a spreadsheet should not have to tidy it first. The
 * order the rest arrive in is the order they were written, which is what makes
 * the report readable next to the thing it was pasted from.
 */
export async function resolvePeopleAction(keys: string[]): Promise<ResolvedPerson[]> {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const line of keys) {
    const key = line.trim();
    if (key === '') continue;
    const folded = key.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    cleaned.push(key);
  }
  if (cleaned.length === 0) return [];

  const actor = await loadActor();
  if (actor.kind !== 'active') return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_find_people', {
    p_keys: cleaned.slice(0, PASTE_LIMIT),
  });
  if (error || !data) return [];

  return (data as FindRow[]).map((row) => ({
    key: row.key,
    found: row.found === 'match' ? 'match' : row.found === 'ambiguous' ? 'ambiguous' : 'none',
    matches: Number(row.matches ?? 0),
    id: row.id,
    displayName: row.display_name,
    kind: row.kind === 'staff' ? 'staff' : row.kind === 'student' ? 'student' : null,
    groupLabel: row.group_label,
  }));
}

// ---------------------------------------------------------------------------
// Checklist columns
//
// The six things a group ticks off against its members. Same shape as
// everything else here: the database owns the cap, the one-of-each-name rule
// and the membership check, and says so in a sentence the form shows.
// ---------------------------------------------------------------------------

export async function saveGroupFieldAction(
  groupId: string,
  field: { id?: string | null; name: string; position: number },
): Promise<ActionResult> {
  return callRpc(
    'app_save_group_field',
    {
      p_field: field.id ?? null,
      p_group: groupId,
      p_name: field.name,
      p_position: field.position,
    },
    field.id ? 'Column saved.' : 'Column added.',
  );
}

export async function deleteGroupFieldAction(fieldId: string): Promise<ActionResult> {
  return callRpc('app_delete_group_field', { p_field: fieldId }, 'Column removed.');
}

/**
 * One tick. No message, for the same reason a note has none: the box on screen
 * is the confirmation, and a roster is ticked a column at a time.
 */
export async function setGroupMarkAction(
  fieldId: string,
  requesterId: string,
  checked: boolean,
): Promise<ActionResult> {
  return callRpc('app_set_group_mark', {
    p_field: fieldId,
    p_requester: requesterId,
    p_checked: checked,
  });
}
