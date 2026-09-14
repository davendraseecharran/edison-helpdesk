'use server';

/**
 * Directory lookups and mutations for the application.
 *
 * Reads for the people screen happen server-side (`people.ts`); what a form
 * needs is the ability to find one person while somebody is typing, which is a
 * POST-only server action rather than a route that returns the roster to
 * anyone who asks for it.
 *
 * Every mutation calls one of the reviewed M5 RPCs with the signed-in user's
 * own JWT, so the database re-derives identity from auth.uid() and applies the
 * same authorization and audit rules it applies to any other caller. Nothing
 * here trusts an actor id or role from the browser.
 *
 * `app_list_people_m5` is SECURITY INVOKER, so the row policy decides what comes
 * back: an account that is not active gets an empty list rather than an error,
 * because the directory holds children's home addresses and parents' phone
 * numbers and is hidden by the database rather than by this file.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import { callRpc } from '@/lib/data/rpc';
import type { PersonKind } from '@/lib/domain/types';

export interface PersonSearchResult {
  id: string;
  displayName: string;
  kind: PersonKind;
  /** OSIS for a student, department or role for staff. Whatever identifies them. */
  descriptor: string | null;
  email: string | null;
  /** The identifier a picker shows in mono: OSIS for a student, staff id for staff. */
  identifier: string | null;
}

/** How many results a type-ahead shows before an operator should narrow the term. */
const SEARCH_LIMIT = 8;

export async function searchPeopleAction(query: string): Promise<PersonSearchResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const actor = await loadActor();
  if (actor.kind !== 'active') return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_people_m5', {
    p_query: term,
    p_limit: SEARCH_LIMIT,
  });
  if (error) return [];

  return ((data ?? []) as Array<{
    id: string;
    kind: string;
    display_name: string;
    email: string | null;
    osis: string | null;
    staff_id: string | null;
    department: string | null;
    role_title: string | null;
    official_class: string | null;
  }>).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    kind: row.kind === 'student' ? 'student' : 'staff',
    // What tells two people of the same name apart, in the order a technician
    // would use to do it: a student by their OSIS or class, staff by what they
    // do and where.
    descriptor:
      row.kind === 'student'
        ? (row.osis ?? row.official_class)
        : (row.department ?? row.role_title),
    email: row.email,
    identifier: row.kind === 'student' ? row.osis : row.staff_id,
  }));
}

/**
 * The fields a form may send. Keys are the database's own column names, so
 * the object goes to `app_upsert_person` as it is: an absent key is left
 * alone and an empty one clears the column. `active` is not here on purpose;
 * archiving is `setPersonActiveAction`, and the database refuses it here.
 */
export interface PersonFields {
  kind: PersonKind;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  email?: string;
  osis?: string;
  staff_id?: string;
  school_dbn?: string;
  department?: string;
  role_title?: string;
  official_class?: string;
  class_of?: string;
  parent_name?: string;
  parent_phone?: string;
  home_phone?: string;
  address?: string;
  notes?: string;
}

const PERSON_KEYS: Array<keyof PersonFields> = [
  'kind', 'first_name', 'last_name', 'display_name', 'email', 'osis', 'staff_id',
  'school_dbn', 'department', 'role_title', 'official_class', 'class_of',
  'parent_name', 'parent_phone', 'home_phone', 'address', 'notes',
];

export async function savePersonAction(
  fields: PersonFields & { id?: string },
): Promise<ActionResult & { id?: string }> {
  // Only the known keys go through, so a stray `active` or anything else a
  // browser might add cannot reach the database under this action's name.
  const person: Record<string, unknown> = {};
  for (const key of PERSON_KEYS) {
    if (fields[key] !== undefined) person[key] = fields[key];
  }
  if (fields.id) person.id = fields.id;
  return callRpc(
    'app_upsert_person',
    { p_person: person },
    fields.id ? 'Person saved.' : 'Person added to the directory.',
  );
}

/** Administrator only; the database refuses anyone else. */
export async function setPersonActiveAction(id: string, active: boolean): Promise<ActionResult> {
  return callRpc(
    'app_set_person_active',
    { p_person: id, p_active: active },
    active ? 'Person restored to the directory.' : 'Person archived.',
  );
}
