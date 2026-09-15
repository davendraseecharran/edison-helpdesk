/**
 * What needs you today, ranked, and the sentence that says so.
 *
 * Pure. The database hands back four lists (`app_today_briefing`), and this
 * module turns them into the one thing the screen is actually for: an ordered
 * list of what to do next, and a line of prose that is true about it.
 *
 * The ranking is a rule rather than a feeling, because a list that reorders
 * itself on a hunch is a list nobody trusts. Two keys, in this order:
 *
 *   1. urgency  — an urgent unclaimed ticket beats everything. A person who
 *                 cannot sign in ranks with a high-priority one: they are
 *                 stopped, but a classroom is not. A ticket of your own that is
 *                 waiting on somebody else's reply ranks with a normal one, and
 *                 a low-priority unclaimed ticket ranks last.
 *   2. age      — inside a band, oldest first. The thing that has been waiting
 *                 longest is the thing worth doing now.
 *
 * Nothing here is authorization. The briefing arrives already filtered by
 * row-level security; this only decides the order it is read in.
 */

import { deviceTypeLabel } from './device-types';
import { normaliseTitle } from './grouping';
import type { Priority, TicketStatus } from './types';

/** One row of what the database said is going on. */
export interface BriefingTicket {
  id: string;
  number: string;
  title: string;
  priority: Priority;
  status: TicketStatus;
  waitingReason: string | null;
  createdAt: string;
  /** When this became your problem: assigned, or created if never assigned. */
  since: string;
  requesterName: string | null;
}

export interface BriefingAccessRequest {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

/** Why a machine is on the list. Two different failures, two different fixes. */
export type DueReason = 'holder_left' | 'in_repair';

/**
 * A machine that should be back on the shelf and is not.
 *
 * Not a ticket, which is exactly why it had no screen: nobody raises a ticket
 * saying a graduate still has a Chromebook, and nobody raises one saying a
 * laptop has been on the bench since October.
 */
export interface DueDevice {
  id: string;
  /** The district's own identifier, and the sticker on the lid. */
  externalId: string;
  assetTag: string | null;
  serialNumber: string | null;
  deviceType: string;
  manufacturer: string;
  model: string | null;
  status: string;
  /** The row version, so Return refuses a machine somebody else just moved. */
  version: number | null;
  /** When the machine last changed, which is how long it has been like this. */
  since: string;
  /** Who is holding it, where anybody is. */
  holderName: string | null;
  reason: DueReason;
}

/** What each reason is called on the row. */
export const DUE_LABELS: Record<DueReason, string> = {
  holder_left: 'Holder has left',
  // "Untouched" rather than "over a fortnight": the RPC tests `updated_at`, so
  // the row is the repair nobody has come back to, not the repair that has run
  // long. A label that claimed the second would be a claim the data cannot make.
  in_repair: 'In repair, untouched for a fortnight',
};

/** The machine, as a person names it: "Dell Latitude 3190", "HP Chromebook". */
export function deviceTitle(device: DueDevice): string {
  const parts = [device.manufacturer, device.model].filter((part) => (part ?? '').trim() !== '');
  // The fallback is a type, and a type reaches a screen through the vocabulary
  // like every other one: a machine recorded as a "chromebook" is not shown as
  // one here because the make and model happen to be blank.
  return parts.length > 0 ? parts.join(' ') : deviceTypeLabel(device.deviceType) || 'Device';
}

/** The identifier to print beside it: the sticker if there is one, else the id. */
export function deviceCode(device: DueDevice): string {
  return device.assetTag?.trim() || device.serialNumber?.trim() || device.externalId;
}

export interface BriefingCounts {
  /** Tickets you own that are stopped on somebody else's reply. */
  waiting: number;
  /** Open tickets nobody has claimed. */
  unassigned: number;
  /** Your own live work, the waiting ones aside. */
  mine: number;
  /** People waiting for an administrator to let them in. Zero unless you are one. */
  accessRequests: number;
  /** Machines due back. Zero unless you are a NetRider or an administrator. */
  devicesDue: number;
}

export interface Briefing {
  /** When the database answered, so ages agree with the server. */
  at: string;
  counts: BriefingCounts;
  waiting: BriefingTicket[];
  unassigned: BriefingTicket[];
  mine: BriefingTicket[];
  accessRequests: BriefingAccessRequest[];
  devicesDue: DueDevice[];
}

export const EMPTY_BRIEFING: Briefing = {
  at: '',
  counts: { waiting: 0, unassigned: 0, mine: 0, accessRequests: 0, devicesDue: 0 },
  waiting: [],
  unassigned: [],
  mine: [],
  accessRequests: [],
  devicesDue: [],
};

/** What kind of thing a row on the list is. */
export type NeedKind = 'unassigned' | 'waiting' | 'access';

export interface NeedItem {
  kind: NeedKind;
  /** Unique across kinds, for React keys and for the keyboard's focus. */
  key: string;
  /** What this row is about, as a heading. */
  title: string;
  /** The person this is about, as one quiet line. */
  subtitle: string;
  /**
   * What state the row is in, in the fewest words that are true. A waiting
   * ticket says why it is waiting rather than that it is waiting: "Waiting on
   * the vendor" beside "Waiting on a reply" is the same fact twice.
   */
  state: string;
  /** The ticket number, where there is one. */
  number: string | null;
  /** Where opening this row goes. */
  href: string;
  /** The timestamp the age is measured from. */
  since: string;
  priority: Priority | null;
  /** The ticket id, for the actions that need one. Null for an access request. */
  ticketId: string | null;
  /**
   * Every ticket this row stands for. One, normally; more when the same problem
   * was reported several times and the row is the group.
   */
  ticketIds: string[];
  /** How many tickets this row stands for. One is an ordinary row. */
  count: number;
  /** Whether this row can be claimed from here. */
  claimable: boolean;
}

/** How hard a priority pushes. Lower goes first. */
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** What each kind is called on the row. */
export const NEED_LABELS: Record<NeedKind, string> = {
  unassigned: 'Unclaimed',
  waiting: 'Waiting on a reply',
  access: 'Wants access',
};

/**
 * The urgency band a row sits in.
 *
 * An unclaimed ticket carries its own priority, because nobody has looked at it
 * yet and the priority is the only thing anybody has said about it. An access
 * request sits with the high band: somebody is locked out, which is worse than
 * routine and better than a classroom on fire. A ticket of yours stopped on a
 * reply sits with the normal band, because the next move is a chase rather than
 * a repair.
 */
export function urgencyBand(item: NeedItem): number {
  if (item.kind === 'access') return PRIORITY_RANK.high;
  if (item.kind === 'waiting') return PRIORITY_RANK.normal;
  return item.priority ? PRIORITY_RANK[item.priority] : PRIORITY_RANK.normal;
}

function ticketNeed(
  ticket: BriefingTicket,
  kind: 'unassigned' | 'waiting',
  others: BriefingTicket[] = [],
): NeedItem {
  const who = ticket.requesterName ?? 'Requester unknown';
  const count = others.length + 1;
  return {
    kind,
    key: `${kind}:${ticket.id}`,
    title: ticket.title,
    subtitle: count > 1 ? `${count} tickets` : who,
    state:
      kind === 'waiting'
        ? (ticket.waitingReason ?? NEED_LABELS.waiting)
        : NEED_LABELS[kind],
    number: count > 1 ? null : ticket.number,
    href: `/tickets/${ticket.id}`,
    since: ticket.since,
    priority: ticket.priority,
    ticketId: ticket.id,
    ticketIds: [ticket.id, ...others.map((entry) => entry.id)],
    count,
    claimable: kind === 'unassigned',
  };
}

/**
 * The unclaimed tickets, with repeats folded into one row.
 *
 * A projector dies and five people report it; Today should say one thing needs
 * you, not five. Titles only here — the briefing carries no room or category,
 * and the queue's fuller rule (`grouping.ts`) has both. A title that reads the
 * same once case and punctuation are off is the case this is for, and it is the
 * case that actually happens.
 *
 * The oldest leads, which is the one to work and the one whose age the row
 * shows.
 */
function foldUnassigned(tickets: readonly BriefingTicket[]): NeedItem[] {
  const groups = new Map<string, BriefingTicket[]>();
  for (const ticket of tickets) {
    const key = normaliseTitle(ticket.title);
    const existing = groups.get(key);
    if (existing) existing.push(ticket);
    else groups.set(key, [ticket]);
  }

  return [...groups.values()].map((entries) => {
    const sorted = [...entries].sort((left, right) => {
      const age = Date.parse(left.since) - Date.parse(right.since);
      if (Number.isFinite(age) && age !== 0) return age;
      return left.id.localeCompare(right.id);
    });
    return ticketNeed(sorted[0], 'unassigned', sorted.slice(1));
  });
}

/** The most rows the list shows. Past this it stops being a plan and becomes an inbox. */
export const NEEDS_LIMIT = 7;

/**
 * Everything that needs you, in the order to do it in.
 *
 * Ties are broken by the key so the order is total: two tickets created in the
 * same second must not swap places between two renders of the same page.
 */
export function needsYou(briefing: Briefing): NeedItem[] {
  const items: NeedItem[] = [
    ...foldUnassigned(briefing.unassigned),
    ...briefing.waiting.map((ticket) => ticketNeed(ticket, 'waiting')),
    ...briefing.accessRequests.map((request) => ({
      kind: 'access' as const,
      key: `access:${request.id}`,
      title: request.name,
      subtitle: request.email,
      state: NEED_LABELS.access,
      number: null,
      href: '/admin',
      since: request.createdAt,
      priority: null,
      ticketId: null,
      ticketIds: [],
      count: 1,
      claimable: false,
    })),
  ];

  return items
    .sort((left, right) => {
      const band = urgencyBand(left) - urgencyBand(right);
      if (band !== 0) return band;
      const age = Date.parse(left.since) - Date.parse(right.since);
      if (Number.isFinite(age) && age !== 0) return age;
      return left.key.localeCompare(right.key);
    })
    .slice(0, NEEDS_LIMIT);
}

/**
 * How many things need you, across every kind, whether or not they fit on screen.
 *
 * Machines due back are deliberately NOT counted. "Four things need you" is a
 * sentence about the next hour; a Chromebook a graduate still has is a
 * fortnight's problem, and folding the two together would make the number
 * somebody reads first the one number they learn to discount.
 */
export function needsCount(counts: BriefingCounts): number {
  return counts.unassigned + counts.waiting + counts.accessRequests;
}

/** The most machines the section shows before it becomes an inventory report. */
export const DUE_LIMIT = 6;

/**
 * The machines worth showing, oldest first.
 *
 * The database already ordered and capped them; this is where the screen's own
 * limit lives, and where the order is made total so two machines that last
 * changed in the same second cannot swap places between renders.
 */
export function devicesDue(briefing: Briefing): DueDevice[] {
  return [...briefing.devicesDue]
    .sort((left, right) => {
      const age = Date.parse(left.since) - Date.parse(right.since);
      if (Number.isFinite(age) && age !== 0) return age;
      return left.id.localeCompare(right.id);
    })
    .slice(0, DUE_LIMIT);
}

/**
 * The line beside the section heading.
 *
 * It names the count the database counted rather than the rows on screen, for
 * the same reason the briefing does, and it says what the section is FOR:
 * these are machines to get back, not a list of everything in repair.
 */
export function devicesDueSentence(counts: BriefingCounts): string {
  const total = counts.devicesDue;
  if (total === 0) return '';
  if (total === 1) return 'One machine is due back.';
  const digits = total > 10;
  return `${capitalise(digits ? String(total) : spell(total))} machines are due back.`;
}

const NUMBER_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

/** Small numbers read as words; larger ones stay digits. */
export function spell(count: number): string {
  const value = Math.max(0, Math.trunc(count));
  return value < NUMBER_WORDS.length ? NUMBER_WORDS[value] : String(value);
}

/** The first letter of a sentence, when the sentence starts with a spelled number. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinClauses(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The line under the greeting.
 *
 * It says how many things need you and then what shape they are, because those
 * are two different decisions: whether to sit down at all, and what to open
 * first. The counts are the real totals from the database, not the length of
 * the list on screen — "three things need you" has to stay true when only two
 * fit.
 *
 * Returns an empty string when nothing needs you; the screen says that in the
 * interface's own voice instead, which is a different sentence and a different
 * place on the page.
 */
export function briefingSentence(counts: BriefingCounts): string {
  const total = needsCount(counts);
  if (total === 0) return '';

  /*
   * One register for the whole sentence. "11 things need you. Ten unclaimed
   * and one waiting on a reply" mixes digits and words in a single breath,
   * which reads as two people writing. Past ten the sentence is all digits.
   */
  const digits = total > 10;
  const count = (value: number) => (digits ? String(value) : spell(value));

  const lead = total === 1 ? 'One thing needs you.' : `${capitalise(count(total))} things need you.`;

  const parts: string[] = [];
  if (counts.unassigned > 0) parts.push(`${count(counts.unassigned)} unclaimed`);
  if (counts.waiting > 0) parts.push(`${count(counts.waiting)} waiting on a reply`);
  if (counts.accessRequests > 0) {
    parts.push(
      `${count(counts.accessRequests)} ${counts.accessRequests === 1 ? 'person' : 'people'} waiting for access`,
    );
  }

  // One clause that only restates the lead is noise: "One thing needs you. One
  // unclaimed." says nothing the first sentence did not.
  if (parts.length < 2) return lead;

  return `${lead} ${capitalise(joinClauses(parts))}.`;
}

/**
 * What to do when nothing needs you.
 *
 * An empty screen is an invitation, so it always carries somewhere to go, and
 * the somewhere depends on what is actually true: your own live work if you
 * have any, otherwise recording the next walk-in.
 */
export function nextBestAction(counts: BriefingCounts): { label: string; href: string } {
  if (counts.mine > 0) {
    return {
      label: counts.mine === 1 ? 'Open your one ticket' : `Open your ${counts.mine} tickets`,
      href: '/my-tickets',
    };
  }
  return { label: 'Record a walk-in', href: '/tickets/new' };
}
