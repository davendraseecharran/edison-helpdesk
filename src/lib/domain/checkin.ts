/**
 * Self check-in, as every screen, action and assistant tool agrees on it.
 *
 * Pure: no React, no `server-only`, no `'use server'`. The database is the
 * authority (`20260924100000_event_self_checkin.sql`); the folding and
 * matching here mirror `app_checkin_fold` and `app_checkin_name_matches` so the
 * page can tell somebody their name is empty before a round trip, and so the
 * rules are written down somewhere a unit test can hold them.
 */

export type CheckinIdentity = 'osis' | 'name' | 'either' | 'both';
export type CheckinState = 'open' | 'closed' | 'early' | 'ended';

export const CHECKIN_IDENTITIES: readonly CheckinIdentity[] = ['either', 'osis', 'name', 'both'];

export const CHECKIN_IDENTITY_LABELS: Record<CheckinIdentity, string> = {
  either: 'OSIS or name',
  osis: 'OSIS only',
  name: 'Name only',
  both: 'OSIS and name',
};

export const CHECKIN_IDENTITY_HINTS: Record<CheckinIdentity, string> = {
  either: 'People type their name. Two people with one name add their OSIS.',
  osis: 'The OSIS or staff ID on file. Nothing to guess, nothing to misspell.',
  name: 'First and last name. Anybody who knows a name can check that person in.',
  both: 'Both, and they have to be the same person. The strictest.',
};

export const CHECKIN_STATE_LABELS: Record<CheckinState, string> = {
  open: 'Open',
  closed: 'Closed',
  early: 'Not yet open',
  ended: 'Ended',
};

export function isCheckinIdentity(value: unknown): value is CheckinIdentity {
  return value === 'osis' || value === 'name' || value === 'either' || value === 'both';
}

export function isCheckinState(value: unknown): value is CheckinState {
  return value === 'open' || value === 'closed' || value === 'early' || value === 'ended';
}

/** What an officer's screen holds about one event's self check-in. */
export interface CheckinSettings {
  eventId: string;
  slug: string;
  isOpen: boolean;
  identity: CheckinIdentity;
  walkIns: boolean;
  state: CheckinState;
  heldOn: string;
  presentCount: number;
  selfCount: number;
  memberCount: number;
}

export function checkinFromJson(value: unknown): CheckinSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.slug !== 'string' || typeof row.event_id !== 'string') return null;
  return {
    eventId: row.event_id,
    slug: row.slug,
    isOpen: row.is_open === true,
    identity: isCheckinIdentity(row.identity) ? row.identity : 'either',
    walkIns: row.walk_ins === true,
    state: isCheckinState(row.state) ? row.state : 'closed',
    heldOn: typeof row.held_on === 'string' ? row.held_on : '',
    presentCount: Number(row.present_count ?? 0),
    selfCount: Number(row.self_count ?? 0),
    memberCount: Number(row.member_count ?? 0),
  };
}

/** What `/c/<slug>` renders. */
export interface PublicCheckin {
  slug: string;
  eventName: string;
  groupName: string;
  heldOn: string;
  identity: CheckinIdentity;
  state: CheckinState;
}

export function publicCheckinFromJson(value: unknown): PublicCheckin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.slug !== 'string') return null;
  return {
    slug: row.slug,
    eventName: typeof row.event_name === 'string' ? row.event_name : '',
    groupName: typeof row.group_name === 'string' ? row.group_name : '',
    heldOn: typeof row.held_on === 'string' ? row.held_on : '',
    identity: isCheckinIdentity(row.identity) ? row.identity : 'either',
    state: isCheckinState(row.state) ? row.state : 'closed',
  };
}

export const CHECKIN_SLUG = /^[a-z0-9]{12}$/;
export const CHECKIN_PATH_PREFIX = '/c/';

export function checkinPath(slug: string): string {
  return `${CHECKIN_PATH_PREFIX}${slug}`;
}

/** "helpdesk.edison.example/c/k3x9q2mfab7p": the link as a poster prints it. */
export function shortLink(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A name with everything that is not the name taken out, as the database
 * folds it: lower case, accents removed, apostrophes and full stops removed,
 * every other run of punctuation or space one space.
 */
export function foldName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** An OSIS or staff id as it is compared: no spaces, lower case. */
export function foldId(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

export interface NamedPerson {
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Whether a record carries the name somebody typed: its display name read
 * either way round, or its own first and last name (a first name on file as
 * "Nia Amara" is also found by "Nia"). Mirrors `app_checkin_name_matches`.
 */
export function nameMatches(person: NamedPerson, first: string, last: string): boolean {
  const f = foldName(first);
  const l = foldName(last);
  if (f === '' || l === '') return false;
  const display = foldName(person.displayName);
  if (display === `${f} ${l}` || display === `${l} ${f}`) return true;
  const onFileLast = foldName(person.lastName ?? '');
  const onFileFirst = foldName(person.firstName ?? '');
  return onFileLast === l && (onFileFirst === f || onFileFirst.split(' ')[0] === f);
}

// ---------------------------------------------------------------------------
// What the public page asks for, and what it says back
// ---------------------------------------------------------------------------

export interface CheckinInput {
  osis: string;
  first: string;
  last: string;
}

/** Which boxes the page shows for a setting. `either` starts on the name. */
export function asksFor(identity: CheckinIdentity): { osis: boolean; name: boolean } {
  switch (identity) {
    case 'osis':
      return { osis: true, name: false };
    case 'name':
      return { osis: false, name: true };
    case 'both':
      return { osis: true, name: true };
    default:
      return { osis: false, name: true };
  }
}

/**
 * The first thing missing from what somebody typed, as the sentence the page
 * shows, or null when it is enough to send.
 */
export function inputProblem(identity: CheckinIdentity, input: CheckinInput, mode: 'osis' | 'name'): string | null {
  const hasOsis = foldId(input.osis) !== '';
  const hasFirst = foldName(input.first) !== '';
  const hasLast = foldName(input.last) !== '';
  const needOsis = identity === 'osis' || identity === 'both' || (identity === 'either' && mode === 'osis');
  const needName = identity === 'name' || identity === 'both' || (identity === 'either' && mode === 'name');
  if (needName && !hasFirst && !hasLast) return 'Enter your first and last name.';
  if (needName && !hasFirst) return 'Enter your first name.';
  if (needName && !hasLast) return 'Enter your last name.';
  if (needOsis && !hasOsis) return 'Enter your OSIS.';
  return null;
}

export type CheckinRefusal =
  | 'missing'
  | 'closed'
  | 'early'
  | 'ended'
  | 'incomplete'
  | 'no_match'
  | 'ambiguous'
  | 'throttled'
  | 'error';

export type CheckinResult =
  | { ok: true; outcome: 'present' | 'already'; firstName: string }
  | { ok: false; reason: CheckinRefusal; message: string };

export function isCheckinRefusal(value: unknown): value is CheckinRefusal {
  return (
    value === 'missing' ||
    value === 'closed' ||
    value === 'early' ||
    value === 'ended' ||
    value === 'incomplete' ||
    value === 'no_match' ||
    value === 'ambiguous' ||
    value === 'throttled' ||
    value === 'error'
  );
}

/**
 * The line somebody reads when a check-in is refused. A name nobody has and a
 * name that is not on this roster read the same, on purpose: the page is not a
 * way to find out who goes to the school.
 */
export function checkinMessage(
  reason: CheckinRefusal,
  context: { identity: CheckinIdentity; groupName: string; mode: 'osis' | 'name' },
): string {
  switch (reason) {
    case 'missing':
      return 'This check-in link is not available. Ask the officer running the event.';
    case 'closed':
      return 'Check-in is closed. Ask an officer to mark you present.';
    case 'early':
      return 'Check-in has not opened yet. It opens on the day of the event.';
    case 'ended':
      return 'Check-in for this event has ended.';
    case 'incomplete':
      return context.identity === 'osis'
        ? 'Enter your OSIS.'
        : context.identity === 'both'
          ? 'Enter your OSIS and your first and last name.'
          : 'Enter your first and last name, or your OSIS.';
    case 'ambiguous':
      return context.identity === 'name'
        ? 'More than one person has that name. Ask an officer to check you in.'
        : 'More than one person has that name. Add your OSIS to tell you apart.';
    case 'no_match': {
      const list = context.groupName ? `the list for ${context.groupName}` : 'the list';
      if (context.identity === 'osis' || (context.identity === 'either' && context.mode === 'osis')) {
        return `That OSIS is not on ${list}. Check the number and try again.`;
      }
      if (context.identity === 'both') return `That OSIS and name are not on ${list} together. Check both.`;
      if (context.identity === 'name') return `That name is not on ${list}. Check the spelling.`;
      return `That name is not on ${list}. Check the spelling, or use your OSIS.`;
    }
    case 'throttled':
      return 'Too many tries from this phone. Wait fifteen minutes, or ask an officer.';
    default:
      return 'That did not go through. Check your connection and try again.';
  }
}

/** The one line under the QR code, per setting. */
export function posterInstruction(identity: CheckinIdentity): string {
  switch (identity) {
    case 'osis':
      return 'Have your OSIS ready.';
    case 'name':
      return 'You will type your first and last name.';
    case 'both':
      return 'Have your OSIS ready. You will type your name too.';
    default:
      return 'You will type your name, or your OSIS.';
  }
}

/** How long the officer's page waits between looks at the roll. */
export const CHECKIN_POLL_MS = 4000;

const LONG_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

/** "Friday, October 3": a school day as a poster and a phone say it. */
export function longDate(key: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  const date = new Date(`${key}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? key : LONG_DATE.format(date);
}

// ---------------------------------------------------------------------------
// Shapes the check-in actions take and give. Here because a `'use server'`
// module may export nothing but async functions.
// ---------------------------------------------------------------------------

export interface CheckinPatch {
  open?: boolean;
  identity?: CheckinIdentity;
  walkIns?: boolean;
}

export type CheckinSaveResult =
  | { ok: true; settings: CheckinSettings; message?: string }
  | { ok: false; error: string };

export type CheckinCodeResult =
  | { ok: true; url: string; svg: string; png: string }
  | { ok: false; error: string };
