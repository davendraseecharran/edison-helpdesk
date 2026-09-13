'use server';

/**
 * Directory lookups for the application.
 *
 * One action, deliberately. The people screen Task 17 builds reads the
 * directory server-side; what a form needs is the ability to find one person
 * while somebody is typing, which is a POST-only server action rather than a
 * route that returns the roster to anyone who asks for it.
 *
 * `app_list_people` is SECURITY INVOKER, so the row policy decides what comes
 * back: an account that is not active gets an empty list rather than an error,
 * because the directory holds children's home addresses and parents' phone
 * numbers and is hidden by the database rather than by this file.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';

export interface PersonSearchResult {
  id: string;
  displayName: string;
  kind: 'student' | 'staff';
  /** OSIS for a student, department or role for staff. Whatever identifies them. */
  descriptor: string | null;
  email: string | null;
}

/** How many results a type-ahead shows before an operator should narrow the term. */
const SEARCH_LIMIT = 8;

export async function searchPeopleAction(query: string): Promise<PersonSearchResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const actor = await loadActor();
  if (actor.kind !== 'active') return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_people', {
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
  }));
}
