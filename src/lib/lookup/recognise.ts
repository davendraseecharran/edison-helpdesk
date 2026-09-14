/**
 * Paste anything.
 *
 * A NetRider at the desk does not type queries, they paste: an asset tag read
 * off a sticker, a serial from a label printer, an OSIS out of a spreadsheet, a
 * ticket number from an email, a parent's phone number. Every one of those has
 * a shape, and a shape is enough to know what kind of record is being asked
 * for before any search has run. That is the whole job of this module: turn a
 * blob of pasted text into "this is an asset tag, and the thing to search for
 * is A-93542614".
 *
 * Pure, and nothing here touches the network or the DOM, so every pattern is a
 * unit test rather than a manual paste. Knowing the KIND is what buys the two
 * conveniences downstream: the palette can head the results with what it thinks
 * it was given, and when the search comes back with exactly one record of that
 * kind, Enter goes straight there instead of into a list of one.
 *
 * Nothing here is an authorization decision. A recognised OSIS is a search
 * term; the database still decides whether this account may see the student.
 */

import type { SearchKind } from '@/lib/data/search';

/** What a piece of pasted text turned out to be. */
export type LookupKind =
  | 'ticket'
  | 'osis'
  | 'staff_id'
  | 'email'
  | 'phone'
  | 'asset_tag'
  | 'serial'
  | 'device_id'
  | 'text';

export interface Recognition {
  kind: LookupKind;
  /** The value to search with, in the spelling the database stores. */
  value: string;
  /**
   * Whether the shape is unambiguous. An uncertain reading still heads the
   * results with what it guessed, but never jumps on its own.
   */
  certain: boolean;
}

/** Nothing was recognised: the text is a search, not an identifier. */
export function plainText(value: string): Recognition {
  return { kind: 'text', value, certain: false };
}

/** What each kind is called where the palette groups by it. */
export const LOOKUP_KIND_LABELS: Record<LookupKind, string> = {
  ticket: 'Ticket',
  osis: 'OSIS',
  staff_id: 'Staff id',
  email: 'Email',
  phone: 'Phone',
  asset_tag: 'Asset tag',
  serial: 'Serial number',
  device_id: 'Device id',
  text: 'Search',
};

/**
 * Which kind of record a recognition points at, or null when it points at no
 * particular one. This is what decides whether a single result is worth
 * jumping to: a recognised asset tag that returns one device is that device.
 */
export function targetKind(kind: LookupKind): SearchKind | null {
  switch (kind) {
    case 'ticket':
      return 'ticket';
    case 'osis':
    case 'staff_id':
    case 'email':
    case 'phone':
      return 'person';
    case 'asset_tag':
    case 'serial':
    case 'device_id':
      return 'device';
    default:
      return null;
  }
}

/** Collapses whitespace, including the newlines a pasted cell brings with it. */
function collapse(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/*
 * The patterns, in the order they are tried. Order is the whole design here:
 * `A-91001` is an asset tag before it is a serial, and `EDT-1042` is a ticket
 * before it is anything, so the specific shapes are checked before the general
 * ones and the last rule — "letters and digits together" — never gets to claim
 * something a named shape already explained.
 */

/** `EDT-1042`, `edt 1042`, `edt1042`, `#1042`. */
const TICKET = /^#?edt[\s-]?(\d{1,7})$/i;

/** A bare number small enough to be a ticket rather than anybody's id. */
const TICKET_BARE = /^#(\d{1,6})$|^(\d{1,6})$/;

/**
 * An OSIS is nine digits and the leading zeros are part of it. The database
 * stores it as text for exactly that reason, so it is never turned into a
 * number anywhere in this path.
 */
const OSIS = /^(\d{9})$/;

/** Six to twelve digits is the range the importer accepts; nine is the certain one. */
const OSIS_WIDE = /^(\d{6,12})$/;

/** `A-93542614`, `a93542614`. The school's asset stickers. */
const ASSET_TAG = /^a[\s-]?(\d{4,10})$/i;

/** `DEV-F8BC7DBDE7A2`: the inventory's own external id. */
const DEVICE_ID = /^(dev-[0-9a-f]{6,20})$/i;

/** A staff handle as the district writes it: `a.okonkwo`, `j.p.rivera`. */
const STAFF_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/i;

/**
 * Deliberately loose. A wrong-looking address is still an address somebody
 * pasted, and the search will simply not find it; refusing to recognise it
 * would only mean not saying what was searched for.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/**
 * A phone number has to carry punctuation or a country code. Bare digits are
 * never read as a phone, because nine bare digits are an OSIS and ten are a
 * spreadsheet cell nobody formatted — guessing between them would put a
 * student's record behind a wrong turn.
 */
const PHONE = /^[+(]?[0-9(][0-9\s().-]{8,20}$/;
const PHONE_PUNCTUATION = /[\s().+-]/;

/** Letters and digits together, no spaces: what a serial always looks like. */
const SERIAL = /^[a-z0-9][a-z0-9-]{4,23}$/i;

/**
 * What one token of pasted text is.
 *
 * Returns a `text` recognition rather than null when nothing matched, so every
 * caller has a value to search with and none of them has to handle absence.
 */
export function recognise(raw: string): Recognition {
  const value = collapse(raw);
  if (value === '') return plainText('');

  const ticket = TICKET.exec(value);
  if (ticket) return { kind: 'ticket', value: `EDT-${ticket[1]}`, certain: true };

  const device = DEVICE_ID.exec(value);
  if (device) return { kind: 'device_id', value: device[1].toUpperCase(), certain: true };

  const asset = ASSET_TAG.exec(value);
  if (asset) return { kind: 'asset_tag', value: `A-${asset[1]}`, certain: true };

  if (EMAIL.test(value)) return { kind: 'email', value: value.toLowerCase(), certain: true };

  const osis = OSIS.exec(value);
  if (osis) return { kind: 'osis', value: osis[1], certain: true };

  const bareTicket = TICKET_BARE.exec(value);
  if (bareTicket) {
    return { kind: 'ticket', value: `EDT-${bareTicket[1] ?? bareTicket[2]}`, certain: false };
  }

  const wideOsis = OSIS_WIDE.exec(value);
  if (wideOsis) return { kind: 'osis', value: wideOsis[1], certain: false };

  if (PHONE.test(value) && PHONE_PUNCTUATION.test(value)) {
    const digits = value.replace(/[^0-9]/g, '');
    return { kind: 'phone', value: value.startsWith('+') ? `+${digits}` : digits, certain: true };
  }

  if (STAFF_ID.test(value)) return { kind: 'staff_id', value: value.toLowerCase(), certain: true };

  // A serial has to carry both a letter and a digit. Without that rule a
  // surname is a serial, and every name typed into the palette gets filed
  // under Devices.
  if (SERIAL.test(value) && /[a-z]/i.test(value) && /[0-9]/.test(value)) {
    return { kind: 'serial', value: value.toUpperCase(), certain: false };
  }

  return plainText(value);
}

/**
 * The identifier inside a larger paste, or null.
 *
 * Somebody copies a row out of a spreadsheet, a line out of an email, a whole
 * signature block. The identifier is in there; it is just not alone. Every
 * token is read and the most specific certain one wins, so pasting
 *
 *   Okonkwo, Nia   9A   A-93542614   in repair
 *
 * jumps to the machine rather than searching for the whole line. Only certain
 * recognitions count here: inside a blob of text, a four-digit number is far
 * more likely to be a room or a year than a ticket.
 */
export function recogniseInText(raw: string): Recognition | null {
  const tokens = raw.split(/[\s,;|]+/).filter((token) => token !== '');
  if (tokens.length <= 1) return null;

  // Most specific first: a device or a ticket named in a line is what the line
  // is about; an email address in a signature is the least surprising thing in
  // it and should not beat an asset tag sitting two tokens away.
  const order: LookupKind[] = ['ticket', 'asset_tag', 'device_id', 'serial', 'osis', 'email', 'staff_id', 'phone'];
  const found = new Map<LookupKind, Recognition>();
  for (const token of tokens) {
    const recognition = recognise(token);
    if (!recognition.certain || recognition.kind === 'text') continue;
    if (!found.has(recognition.kind)) found.set(recognition.kind, recognition);
  }
  for (const kind of order) {
    const hit = found.get(kind);
    if (hit) return hit;
  }
  return null;
}

/**
 * What a paste means: the whole text if it is one identifier, otherwise the
 * identifier inside it, otherwise the text as a search.
 *
 * The one entry point the palette and the global paste listener both use, so
 * pasting a tag and pasting the line it came in behave the same way.
 */
export function recognisePaste(raw: string): Recognition {
  const whole = recognise(raw);
  if (whole.kind !== 'text') return whole;
  return recogniseInText(raw) ?? whole;
}

/** How the palette heads a group of results it recognised the query for. */
export function recognitionHeading(recognition: Recognition): string {
  if (recognition.kind === 'text') return 'Results';
  return `${LOOKUP_KIND_LABELS[recognition.kind]} ${recognition.value}`;
}
