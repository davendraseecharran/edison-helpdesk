'use server';

/**
 * Directory lookups and mutations for the application.
 *
 * Reads for the people screen happen server-side (`people.ts`); what a form
 * needs is the ability to find one person while somebody is typing, which is a
 * POST-only server action rather than a route that returns the roster to
 * anyone who asks for it.
 *
 * Every mutation calls the owner's `app_save_person` with the signed-in user's
 * own JWT, so the database re-derives identity from auth.uid(), validates the
 * profile, enforces the optimistic lock and writes its own audit row. Nothing
 * here trusts an actor id or a role from the browser, and nothing here
 * pre-empts a rule the database will apply anyway.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import type { PeopleFilters } from '@/lib/data/people';
import { loadPeopleAddressees } from '@/lib/data/people-addressees';
import { callRpc } from '@/lib/data/rpc';
import type { PersonAddressee } from '@/lib/people/clipboard';
import type { PersonInput, PersonKind } from '@/lib/domain/types';

export interface PersonSearchResult {
  id: string;
  displayName: string;
  kind: PersonKind;
  /** OSIS or staff id: what tells two people of the same name apart. */
  identifier: string | null;
  /** The same thing again, for a picker that shows one quiet second line. */
  descriptor: string | null;
  email: string | null;
}

/**
 * One search, both kinds.
 *
 * The owner's `app_search_requesters` takes exactly one kind and caps at
 * twenty, so a picker that offers students and staff together asks twice and
 * interleaves the answers. Two round trips against an indexed lookup is
 * cheaper than one query that would have to scan the whole directory.
 */
export async function searchPeopleAction(
  query: string,
  kind?: PersonKind,
): Promise<PersonSearchResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const actor = await loadActor();
  if (actor.kind !== 'active') return [];

  const supabase = await createClient();
  const kinds: PersonKind[] = kind ? [kind] : ['student', 'staff'];

  const answers = await Promise.all(
    kinds.map(async (one) => {
      const { data, error } = await supabase.rpc('app_search_requesters', {
        p_kind: one,
        p_query: term,
      });
      if (error) return [];
      return ((data ?? []) as Array<{ id: string; display_name: string; external_id: string | null }>).map(
        (row) => ({
          id: row.id,
          displayName: row.display_name,
          kind: one,
          identifier: row.external_id,
          descriptor: row.external_id,
          email: null,
        }),
      );
    }),
  );

  return answers.flat();
}

export interface PeopleAddresseesResult {
  people: PersonAddressee[];
  /** How many the filter matches, which can be more than came back. */
  total: number;
  /** True when the filter matched more people than one answer carries. */
  capped: boolean;
}

/**
 * Everybody the list is currently showing, as people to write to.
 *
 * The list is filtered and paged by the database, so "the current result set"
 * is a question only the database can answer — the fifty rows on screen are not
 * it. This asks for the whole filter, up to five hundred, and it is a POST-only
 * server action rather than a route for the same reason `searchPeopleAction` is:
 * there is no URL that hands somebody the roster for asking.
 *
 * Called when one of the menus is first opened rather than with the page, so a
 * directory nobody is mailing today costs nothing.
 */
export async function peopleAddresseesAction(
  filters: PeopleFilters & { ids?: string[] | null },
): Promise<PeopleAddresseesResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { people: [], total: 0, capped: false };

  const page = await loadPeopleAddressees({
    kind: filters.kind,
    query: filters.query,
    ids: filters.ids ?? null,
  });

  // Narrowed on the way out: the class and department the CSV needs are not
  // any of a menu's business, and this crosses the wire five hundred at a time.
  return {
    people: page.people.map((person) => ({
      id: person.id,
      displayName: person.displayName,
      email: person.email,
      externalId: person.externalId,
      kind: person.kind,
      guardianName: person.guardianName ?? null,
      guardianPhone: person.guardianPhone ?? null,
    })),
    total: page.total,
    capped: page.capped,
  };
}

/**
 * Save one person.
 *
 * `p_version` is the row the form was opened on. The database refuses a stale
 * one with "This record changed since you opened it", which is the message the
 * form shows: two people editing the same student is a real Monday morning,
 * and the second one has to be told rather than silently overwrite the first.
 */
export async function savePersonAction(
  input: PersonInput & { id?: string | null; version?: number | null },
): Promise<ActionResult & { id?: string }> {
  const { id, version, ...fields } = input;
  const data: Record<string, unknown> = {
    kind: fields.kind,
    displayName: fields.displayName,
    externalId: fields.externalId,
    firstName: fields.firstName,
    lastName: fields.lastName,
    email: fields.email,
    notes: fields.notes,
    // Always sent, like every other field on this form: a cleared box has to
    // really clear. The database keeps the date it already had when the box was
    // already ticked, so saving a phone number does not restate when somebody
    // left.
    archived: fields.archived,
  };

  if (fields.kind === 'student') {
    data.classOf = fields.classOf;
    data.officialClass = fields.officialClass;
    data.studentStatus = fields.studentStatus;
    data.guardianName = fields.guardianName;
    data.guardianPhone = fields.guardianPhone;
    data.homePhone = fields.homePhone;
    data.address = fields.address;
  } else {
    data.schoolDbn = fields.schoolDbn;
    data.department = fields.department;
    data.staffRole = fields.staffRole;
  }

  return callRpc(
    'app_save_person',
    { p_id: id ?? null, p_version: version ?? null, p_data: data },
    id ? 'Person saved.' : 'Person added to the directory.',
  );
}
