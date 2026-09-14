/**
 * The solution, drafted from what is already written down.
 *
 * By the time somebody resolves a ticket they have usually typed the answer
 * twice: once in a note while they were working, once in the solution field
 * afterwards. This builds the second from the first, so the field starts with
 * a sentence to edit rather than a blank box at the end of a long day — which
 * is the moment solutions get written as "fixed".
 *
 * Pure, and deliberately dumb. It does not summarise; it selects and joins,
 * because a summary that quietly drops the one detail the next NetRider needed
 * is worse than no draft at all. Everything in the draft was typed by a person
 * on this ticket. The assistant can write a better one when it is connected;
 * this is the version that works with no account, no network and no wait.
 */

import type { TicketDetail } from './selectors';

/** The longest a draft may be before it stops being a solution and becomes a log. */
export const DRAFT_SOLUTION_MAX = 600;

/** Collapses whitespace so a pasted paragraph reads as one line. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Ends a fragment with a full stop, unless it already ends with punctuation. */
function sentence(text: string): string {
  const trimmed = collapse(text);
  if (trimmed === '') return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** "25m", "1h 25m" — the same shape the time panel shows. */
function minutes(total: number): string {
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * A solution drafted from the ticket's own record, or null when there is
 * nothing to draft from.
 *
 * What goes in, in this order:
 *
 *   * the last two notes, newest last, because the newest note is almost
 *     always the fix and the one before it is almost always what was tried;
 *   * every work-log description that says something a note did not;
 *   * the total time, when any was logged, as a closing clause.
 *
 * Null rather than an empty string when the ticket has nothing written on it:
 * the panel should offer nothing rather than offer a blank.
 */
export function draftSolution(detail: TicketDetail): string | null {
  const notes = detail.notes
    .map((note) => collapse(note.body))
    .filter((body) => body !== '')
    .slice(-2);

  const seen = new Set(notes.map((note) => note.toLowerCase()));
  const work = detail.workLogs
    .map((log) => collapse(log.description ?? ''))
    .filter((text) => text !== '' && !seen.has(text.toLowerCase()));

  const parts = [...notes, ...work].map(sentence).filter((text) => text !== '');
  if (parts.length === 0) return null;

  const total = detail.workLogs.reduce((sum, log) => sum + (log.minutes ?? 0), 0);
  if (total > 0) parts.push(`${minutes(total)} logged.`);

  const draft = parts.join(' ');
  if (draft.length <= DRAFT_SOLUTION_MAX) return draft;
  // Cut at a sentence boundary rather than mid-word, so what is offered still
  // reads as something a person wrote.
  const cut = draft.slice(0, DRAFT_SOLUTION_MAX);
  const lastStop = cut.lastIndexOf('. ');
  return lastStop > 0 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}
