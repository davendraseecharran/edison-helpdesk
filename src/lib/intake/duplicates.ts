/**
 * Which of the lookup's hits is actually "somebody already reported this".
 *
 * The warning on the intake form is only worth reading if every line on it is
 * still true. A ticket closed last November matches the words "projector" and
 * "118" as well as this morning's does, and printing it under "this looks like
 * a ticket that is already open" teaches the desk to ignore the warning — which
 * costs more than never having shown it.
 *
 * So two rules, both of them the ones a person would apply: it has to still be
 * somebody's problem, and it has to be recent. Recent is `GROUP_WINDOW_DAYS`,
 * the same seven days the queue already uses to decide that three reports are
 * one incident; a duplicate and a group are the same judgement made at two
 * different moments.
 *
 * Pure, so the judgement is testable without a database or a clock.
 */

import type { SearchHit } from '@/lib/data/search';
import { GROUP_WINDOW_DAYS } from '@/lib/domain/grouping';

/** A ticket hit, plus the one fact `app_search` does not carry: when it was opened. */
export interface DuplicateHit extends SearchHit {
  /** ISO 8601, or null when the row could not be read. */
  createdAt: string | null;
}

/**
 * The statuses that mean the ticket is still somebody's problem.
 *
 * These are the labels `app_search` renders in `meta`, not the raw column
 * values — the lookup deliberately returns rendered text for every kind. They
 * are compared folded, so a label that gains a capital does not silently empty
 * the warning.
 */
export const OPEN_DUPLICATE_STATUSES: readonly string[] = [
  'open',
  'assigned',
  'in progress',
  'waiting',
];

/** How many duplicates the warning shows before it becomes a list to read. */
export const DUPLICATE_LIMIT = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the rendered status means the ticket has not been closed. */
export function isStillOpen(meta: string | null): boolean {
  if (typeof meta !== 'string') return false;
  return OPEN_DUPLICATE_STATUSES.includes(meta.trim().toLowerCase());
}

/**
 * Whether a ticket opened at `createdAt` is recent enough to be the same
 * incident. A date that cannot be read is not recent: the warning claims a
 * fact, so an unknown answer is a no.
 */
export function withinDuplicateWindow(createdAt: string | null, now: number): boolean {
  if (typeof createdAt !== 'string' || createdAt === '') return false;
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return false;
  const apart = now - at;
  // A row stamped slightly ahead of this clock is still this week's ticket.
  if (apart < -DAY_MS) return false;
  return apart <= GROUP_WINDOW_DAYS * DAY_MS;
}

/** The hits worth warning about, in the order the lookup ranked them. */
export function openDuplicates(
  hits: DuplicateHit[],
  now: number,
  limit = DUPLICATE_LIMIT,
): DuplicateHit[] {
  return hits
    .filter((hit) => hit.kind === 'ticket')
    .filter((hit) => isStillOpen(hit.meta))
    .filter((hit) => withinDuplicateWindow(hit.createdAt, now))
    .slice(0, Math.max(0, limit));
}

/**
 * What linking writes on the new ticket.
 *
 * There is no relation table in this schema and inventing one for a hint typed
 * at a desk would be the wrong size of change, so the link is a note — the same
 * place the rest of a ticket's story is kept, and the place the next NetRider
 * is already reading.
 */
export function relatedNote(number: string): string {
  return `Related: ${number}. Recorded at intake as the same issue.`;
}
