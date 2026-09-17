/**
 * Turning a list of people into something that can be pasted somewhere else.
 *
 * Pure on purpose, and separate from the component that offers it: every rule
 * here is a decision about the school's data rather than about a menu — which
 * addresses are the same address, what a blank cell means, how many recipients
 * one link can carry — and each of those is worth a test that does not need a
 * browser.
 *
 * Three rules run through all of it:
 *
 *   * A BLANK IS SKIPPED, NEVER PRINTED. The directory is real, and a fair
 *     number of students have no address on file and no guardian phone. A line
 *     reading `Nia Okonkwo <>` in a list somebody is about to paste into Gmail
 *     is worse than a shorter list, because the shorter list is the truth.
 *   * THE SAME ADDRESS IS ONE ADDRESS. Two records can carry one guardian's
 *     address, and a mailing that reaches them twice looks like a mistake by
 *     whoever sent it.
 *   * THE COUNT IS WHAT WAS COPIED. Every formatter answers with the number of
 *     lines it actually wrote, so the message afterwards says what happened
 *     rather than how many rows were on screen.
 */

import type { GmailMode } from '@/lib/domain/preferences';

export type { GmailMode };

/**
 * One person, as much of them as writing to them or listing them needs.
 *
 * Deliberately not `Person`: this shape crosses the wire five hundred at a
 * time, and the fields left out — notes, home address, home phone — are the
 * ones a bulk read has no business carrying. `app_people_addressees` returns
 * exactly this.
 */
export type PersonAddressee = {
  id: string;
  displayName: string;
  email: string | null;
  externalId: string | null;
  kind: 'student' | 'staff';
  guardianName?: string | null;
  guardianPhone?: string | null;
};

/**
 * The most addresses one Gmail compose link carries.
 *
 * Not a rule of the product: browsers and Gmail both stop somewhere north of
 * two thousand characters of URL, and a hundred school addresses is already
 * about that. Past it the link does not fail loudly — it opens a compose window
 * with a truncated recipient list, which is the worst possible outcome — so the
 * button refuses instead and points at the clipboard, which has no such limit.
 */
export const GMAIL_ADDRESS_CAP = 100;

/**
 * The most people one read of a filter answers with, matching the cap inside
 * `app_people_addressees`.
 *
 * Here rather than in the server module that calls the RPC, because the menu
 * has to say the same number while it is waiting: "preparing 3,448 people" for
 * a list that will come back with five hundred of them is a lie the reader
 * finds out about afterwards.
 */
export const ADDRESSEE_CAP = 500;

const GMAIL_COMPOSE = 'https://mail.google.com/mail/';

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The addresses in a list, once: trimmed, blanks dropped, and two spellings of
 * one address counted as one. The first spelling wins, because that is the one
 * the directory holds and the one a reply will come back to.
 */
export function addressesOf(people: readonly PersonAddressee[]): string[] {
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const person of people) {
    const email = clean(person.email);
    if (email === '') continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(email);
  }
  return addresses;
}

export interface GmailLink {
  /** Where the button goes, or null when it cannot go anywhere. */
  url: string | null;
  /** Distinct addresses the link would carry. */
  addressCount: number;
  /** People in the list with no address on file. */
  skipped: number;
  overCap: boolean;
  /** Why the button is disabled, or null when it is not. */
  reason: string | null;
}

/**
 * The compose link for a list, and the decision about whether to offer it.
 *
 * Both halves are here rather than in the component because the interesting
 * part is the decision: nothing to write to, too many to write to, or a link.
 * `view=cm&fs=1` is Gmail's own "open a compose window, full screen"; the
 * addresses ride in `cc` or `bcc` according to the account's own setting.
 */
export function gmailLink(people: readonly PersonAddressee[], mode: GmailMode): GmailLink {
  const addresses = addressesOf(people);
  const skipped = people.length - addresses.length;
  const overCap = addresses.length > GMAIL_ADDRESS_CAP;

  if (addresses.length === 0) {
    return {
      url: null,
      addressCount: 0,
      skipped,
      overCap: false,
      reason: 'Nobody here has an address on file.',
    };
  }

  if (overCap) {
    return {
      url: null,
      addressCount: addresses.length,
      skipped,
      overCap: true,
      reason: 'Too many for one Gmail link; copy the addresses instead.',
    };
  }

  const params = new URLSearchParams({ view: 'cm', fs: '1' });
  params.set(mode, addresses.join(','));
  return {
    url: `${GMAIL_COMPOSE}?${params.toString()}`,
    addressCount: addresses.length,
    skipped,
    overCap: false,
    reason: null,
  };
}

/**
 * What the Gmail button says about itself when the pointer rests on it.
 *
 * The count and the mode, and the people it cannot reach: somebody about to
 * write to a class has to know that four of the thirty-one have no address
 * before they send it, not after.
 */
export function gmailTitle(link: GmailLink, mode: GmailMode): string {
  if (link.reason) return link.reason;
  const who = countWord(link.addressCount, 'address', 'addresses');
  const line = mode === 'to' ? `Compose to ${who}.` : `Compose to ${who} in ${mode.toUpperCase()}.`;
  if (link.skipped === 0) return line;
  return `${line} ${countWord(link.skipped, 'person', 'people')} with no address left out.`;
}

/** What one of the copy menu's items produces. */
export type CopyKind =
  | 'addresses'
  | 'names'
  | 'names-and-addresses'
  | 'identifiers'
  | 'guardian-phones';

export interface Clip {
  /** What goes on the clipboard. Empty when there was nothing to write. */
  text: string;
  /** Lines (or addresses) actually written. */
  count: number;
  /** What to say afterwards, whether it worked or there was nothing to copy. */
  message: string;
}

function countWord(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * What the identifier column is called for these people.
 *
 * Students carry an OSIS and staff carry a staff id, and a list can only be one
 * or the other because the directory is two lists. A selection that somehow
 * held both gets the neutral word rather than a wrong one.
 */
export function identifierLabel(people: readonly PersonAddressee[]): string {
  const only = soleKind(people);
  if (only === 'student') return 'OSIS numbers';
  if (only === 'staff') return 'staff ids';
  return 'identifiers';
}

/** The one kind everybody in a list is, or null when the list is mixed or empty. */
export function soleKind(people: readonly PersonAddressee[]): 'student' | 'staff' | null {
  const hasStudent = people.some((person) => person.kind === 'student');
  const hasStaff = people.some((person) => person.kind === 'staff');
  if (hasStudent && !hasStaff) return 'student';
  if (hasStaff && !hasStudent) return 'staff';
  return null;
}

/**
 * The copy menu's identifier item, in sentence case.
 *
 * `kind` is what the list on screen is, which the menu knows before the people
 * have been fetched; without it the answer is read off the people themselves,
 * and a list that is neither or both gets the honest both-ways wording rather
 * than a label that would be wrong for half of it.
 */
export function identifierMenuLabel(
  people: readonly PersonAddressee[],
  kind?: 'student' | 'staff',
): string {
  const which = kind ?? soleKind(people);
  if (which === 'student') return 'OSIS numbers';
  if (which === 'staff') return 'Staff ids';
  return 'OSIS or staff ids';
}

/**
 * Whether the guardian item is worth offering.
 *
 * Staff have no guardian, so on the staff list the item is not shown at all
 * rather than shown and empty. `kind` answers before the people have arrived.
 */
export function hasStudents(
  people: readonly PersonAddressee[],
  kind?: 'student' | 'staff',
): boolean {
  if (kind) return kind === 'student';
  return people.some((person) => person.kind === 'student');
}

function nothing(what: string): Clip {
  return { text: '', count: 0, message: `Nobody here has ${what} on file.` };
}

function copied(count: number, what: string): string {
  return `Copied ${count} ${what}.`;
}

/**
 * One menu item's worth of clipboard text.
 *
 * Addresses are comma-separated because that is what a To: field takes;
 * everything else is one per line, because that is what a column of a
 * spreadsheet takes and because a list of forty names on one line is not a
 * list anybody can read.
 */
export function clipboardFor(kind: CopyKind, people: readonly PersonAddressee[]): Clip {
  if (kind === 'addresses') {
    const addresses = addressesOf(people);
    if (addresses.length === 0) return nothing('an address');
    return {
      text: addresses.join(', '),
      count: addresses.length,
      message: copied(addresses.length, addresses.length === 1 ? 'address' : 'addresses'),
    };
  }

  if (kind === 'names') {
    const names = people.map((person) => clean(person.displayName)).filter((name) => name !== '');
    if (names.length === 0) return nothing('a name');
    return {
      text: names.join('\n'),
      count: names.length,
      message: copied(names.length, names.length === 1 ? 'name' : 'names'),
    };
  }

  if (kind === 'names-and-addresses') {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const person of people) {
      const email = clean(person.email);
      const name = clean(person.displayName);
      if (email === '' || name === '') continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${name} <${email}>`);
    }
    if (lines.length === 0) return nothing('a name and an address');
    return {
      text: lines.join('\n'),
      count: lines.length,
      message: copied(lines.length, lines.length === 1 ? 'name and address' : 'names and addresses'),
    };
  }

  if (kind === 'identifiers') {
    const only = soleKind(people);
    const ids = people.map((person) => clean(person.externalId)).filter((id) => id !== '');
    if (ids.length === 0) return nothing(only === 'staff' ? 'a staff id' : 'an OSIS');
    const one = only === 'staff' ? 'staff id' : only === 'student' ? 'OSIS number' : 'identifier';
    return {
      text: ids.join('\n'),
      count: ids.length,
      message: copied(ids.length, ids.length === 1 ? one : identifierLabel(people)),
    };
  }

  // Guardian phones. The name is on the line because a column of phone numbers
  // with nobody's name against them is a list nobody can make a call from.
  const lines: string[] = [];
  for (const person of people) {
    if (person.kind !== 'student') continue;
    const phone = clean(person.guardianPhone);
    if (phone === '') continue;
    const name = clean(person.guardianName) || clean(person.displayName);
    if (name === '') continue;
    lines.push(`${name}: ${phone}`);
  }
  if (lines.length === 0) return nothing('a guardian phone');
  return {
    text: lines.join('\n'),
    count: lines.length,
    message: copied(lines.length, lines.length === 1 ? 'guardian phone' : 'guardian phones'),
  };
}
