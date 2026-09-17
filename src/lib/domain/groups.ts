/**
 * What a group's screens and its server actions both have to agree about.
 *
 * Pure: no React, no `server-only`, no `'use server'`. It exists because a
 * module marked `'use server'` may export NOTHING but async functions — every
 * export of one is an endpoint — so a shared ceiling or a shared shape has to
 * live somewhere a client component and an action can both import it from.
 * That is this file, and the unit suite can read it without a database.
 */

/** How many keys one `app_find_people` call answers, and so one paste. */
export const PASTE_LIMIT = 200;

/** The database's own ceilings, so a box stops where its column does. */
export const GROUP_NAME_MAX = 80;
export const GROUP_DESCRIPTION_MAX = 300;
export const GROUP_NOTE_MAX = 80;
export const GROUP_EVENT_NAME_MAX = 80;
export const GROUP_FIELD_NAME_MAX = 40;

/**
 * Checklist columns per group. Six because each is a column on a table a phone
 * has to show; past that it is a form, and a form is a different screen.
 */
export const GROUP_FIELD_LIMIT = 6;

import type { PersonKind } from '@/lib/domain/types';

/** One line of a pasted list, and what the directory made of it. */
export interface ResolvedPerson {
  /** The line as it was pasted, so a "no match" row can be read against it. */
  key: string;
  found: 'match' | 'none' | 'ambiguous';
  /** How many records the line matched. Two or more is what makes it ambiguous. */
  matches: number;
  id: string | null;
  displayName: string | null;
  kind: PersonKind | null;
  /** Class or department: which of two people of one name this is. */
  groupLabel: string | null;
}

/**
 * What one scan or one typed identifier did.
 *
 * Five answers rather than a boolean, because the four that are not "present"
 * each need a different sentence and a different next move: they were already
 * marked, they are not in this group, nothing reads like that, or more than one
 * person does.
 */
export type MarkOutcome =
  | 'present'
  | 'already'
  | 'not_member'
  | 'no_match'
  | 'ambiguous'
  /** Not an answer: the call itself was refused. */
  | 'error';

export interface MarkByKeyResult {
  outcome: MarkOutcome;
  requesterId: string | null;
  displayName: string | null;
  /** Set only for `error`. */
  error?: string;
}

/**
 * The line the register says back, in the desk's voice: what happened, to whom,
 * in one clause. Pure so the wording is testable without a camera.
 *
 * `key` is what was scanned or typed, and it is shown ONLY when nobody was
 * found — a code nobody can look up is the one thing somebody has to read back
 * off the card themselves.
 */
export function markLine(result: MarkByKeyResult, groupName: string, key: string): string {
  const name = result.displayName ?? 'That person';
  switch (result.outcome) {
    case 'present':
      return `${name}, present.`;
    case 'already':
      return `${name} was already marked.`;
    case 'not_member':
      return `${name} is not in ${groupName}.`;
    case 'ambiguous':
      return `More than one person matches "${key}". Use their OSIS or staff ID.`;
    case 'no_match':
      return `No match for "${key}".`;
    default:
      return result.error ?? 'That did not go through. Nothing changed.';
  }
}
