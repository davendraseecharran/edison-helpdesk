/**
 * The same problem, reported five times, as one row.
 *
 * A projector dies in room 118 and five people report it before lunch. The
 * queue shows five rows, a NetRider claims five tickets, opens five pages and
 * writes the same solution five times. None of that is work; all of it is
 * typing. So the list groups them: one row, a count, and one press that claims
 * every ticket in the group.
 *
 * Two tickets are the same problem when either is true:
 *
 *   * their titles read the same once punctuation and case are taken off, or
 *   * they name the same place and the same category.
 *
 * Both are bounded by a week. A projector that dies every September is not one
 * problem, and a group that reaches back through the term would hide a new
 * fault inside an old one.
 *
 * Pure, and the rule is a unit test. Grouping decides what a press claims, so
 * "these two are the same" has to be a sentence somebody can read and check
 * rather than a similarity score.
 */

import type { Ticket } from './types';

/** Tickets further apart than this are never one problem. */
export const GROUP_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TicketGroup {
  /** Stable across renders: the lead ticket's id. */
  key: string;
  /** The row that stands for the group: the oldest, which is the one to work. */
  lead: Ticket;
  /** Every ticket in the group, oldest first. Length 1 is an ordinary row. */
  tickets: Ticket[];
  /** The place they all name, when they all name one. */
  location: string | null;
}

/**
 * A title with nothing left but its words.
 *
 * Case, punctuation and runs of whitespace go. Nothing else: no stemming, no
 * stop words, no fuzzy distance. "Projector shows no signal" and "Projector
 * shows no signal!" are one problem; "Projector is dead" is a different
 * sentence and stays a different row, because a rule that guessed at that
 * would sooner or later claim somebody else's ticket.
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The place a ticket names, folded for comparison, or null. */
export function normaliseLocation(location: string | null | undefined): string | null {
  const text = (location ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * Whether these two tickets are the same problem.
 *
 * Open tickets only. A resolved ticket is a record of something that was
 * already dealt with, and folding it into a live group would offer to claim
 * something that is finished.
 */
export function sameProblem(left: Ticket, right: Ticket): boolean {
  const apart = Math.abs(Date.parse(left.createdAt) - Date.parse(right.createdAt));
  if (!Number.isFinite(apart) || apart > GROUP_WINDOW_DAYS * DAY_MS) return false;

  if (normaliseTitle(left.title) === normaliseTitle(right.title)) return true;

  const place = normaliseLocation(left.location);
  return (
    place !== null && place === normaliseLocation(right.location) && left.category === right.category
  );
}

/**
 * The list, with repeats folded into their lead.
 *
 * Order is preserved: a group appears where its FIRST member appeared, so
 * grouping never reorders a queue that was carefully sorted by priority and
 * age. Inside a group the tickets read oldest first, which is the order to work
 * them in, and the lead is that oldest one.
 *
 * Grouping is transitive through the lead only. A chain of near-misses — A is
 * like B, B is like C, A is nothing like C — must not become one group, so each
 * ticket is compared against the group's lead rather than against its newest
 * member.
 */
export function groupTickets(tickets: readonly Ticket[]): TicketGroup[] {
  const groups: TicketGroup[] = [];

  for (const ticket of tickets) {
    const existing = groups.find((group) => sameProblem(group.lead, ticket));
    if (existing) {
      existing.tickets.push(ticket);
      continue;
    }
    groups.push({
      key: ticket.id,
      lead: ticket,
      tickets: [ticket],
      location: ticket.location ?? null,
    });
  }

  for (const group of groups) {
    group.tickets.sort((left, right) => {
      const age = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      if (Number.isFinite(age) && age !== 0) return age;
      return left.id.localeCompare(right.id);
    });
    group.lead = group.tickets[0];
    // The place is only the group's place when every ticket agrees on it.
    const place = normaliseLocation(group.tickets[0].location);
    const agreed =
      place !== null && group.tickets.every((entry) => normaliseLocation(entry.location) === place);
    group.location = agreed ? (group.tickets[0].location ?? null) : null;
  }

  return groups;
}

/**
 * What the count line says: "5 tickets, room 118", or just the count.
 *
 * Returns null for a group of one, which is an ordinary row and says nothing
 * about being a group.
 */
export function groupLabel(group: TicketGroup): string | null {
  if (group.tickets.length < 2) return null;
  const count = `${group.tickets.length} tickets`;
  return group.location ? `${count}, ${group.location}` : count;
}

/** Every ticket in the group that this account could still claim. */
export function claimableIn(group: TicketGroup, canClaim: (ticket: Ticket) => boolean): string[] {
  return group.tickets.filter(canClaim).map((ticket) => ticket.id);
}
