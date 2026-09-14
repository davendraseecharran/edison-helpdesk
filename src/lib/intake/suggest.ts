/**
 * What the ticket is probably about, read off what was typed.
 *
 * Intake is the action a NetRider repeats all day, and two of its fields are
 * answered by the sentence above them: somebody who typed "the projector in 118
 * shows no signal" has already said the category, and somebody who typed "the
 * whole cart will not charge before period 1" has already said it is urgent.
 * Asking them to say it again in a select is asking twice.
 *
 * So this reads the title and the issue and offers an answer. It OFFERS: the
 * suggestion is a visible chip that Tab accepts, never a value that appears in
 * a field on its own. A form that quietly changed a category under somebody's
 * hands would be worse than one that asked, because the wrong category is
 * invisible until a month of reporting is wrong.
 *
 * Keywords rather than a model, because this has to answer on every keystroke
 * with no network and no account. The assistant writes a better draft when it
 * is connected; this is the version that works at the desk with the Wi-Fi down
 * — which is, notably, when the helpdesk is busiest.
 */

import type { Priority, TicketCategory } from '@/lib/domain/types';

export interface Suggestion<T> {
  value: T;
  /** The word that decided it, so the chip can say why. */
  because: string;
}

/**
 * Words that name a category, most specific first.
 *
 * Each entry is checked as a whole word, so "account" does not match
 * "accountant" and "mac" does not match "machine". Order matters: "chromebook
 * will not charge" is a Chromebook before it is hardware.
 */
const CATEGORY_WORDS: ReadonlyArray<[TicketCategory, readonly string[]]> = [
  ['chromebook', ['chromebook', 'chromebooks', 'chrome book', 'cart', 'carts', 'chromeos']],
  ['projector_display', ['projector', 'projectors', 'screen', 'display', 'hdmi', 'promethean', 'smartboard', 'monitor']],
  ['network', ['wifi', 'wi fi', 'wireless', 'network', 'ethernet', 'internet', 'lan', 'ssid', 'drops', 'dropping']],
  ['printer', ['printer', 'printers', 'printing', 'print', 'toner', 'copier', 'scanner']],
  ['account', ['password', 'passwords', 'login', 'log in', 'sign in', 'signin', 'account', 'locked out', 'osis', 'google account', 'reset']],
  ['software', ['software', 'app', 'application', 'install', 'update', 'licence', 'license', 'extension', 'clever', 'jupiter']],
  ['phone', ['phone', 'phones', 'handset', 'voicemail', 'extension number']],
  ['laptop_desktop', ['laptop', 'laptops', 'desktop', 'pc', 'macbook', 'imac', 'workstation', 'keyboard', 'mouse', 'battery']],
];

/**
 * Words that raise the priority.
 *
 * Nothing lowers it: a NetRider who thinks something is routine leaves the
 * field alone, and a heuristic that quietly marked somebody's report as low
 * would be the interface disagreeing with the person in front of it.
 */
const URGENT_WORDS: readonly string[] = [
  'urgent',
  'emergency',
  'whole class',
  'whole school',
  'everyone',
  'all of',
  'exam',
  'regents',
  'state test',
  'testing today',
  'cannot teach',
  "can't teach",
  'no one can',
  'nobody can',
  'smoke',
  'burning',
  'sparks',
];

const HIGH_WORDS: readonly string[] = [
  'today',
  'this morning',
  'this period',
  'period 1',
  'first period',
  'asap',
  'as soon as',
  'right now',
  'immediately',
  'presentation',
  'observation',
  'parent',
  'whole cart',
  'entire cart',
];

/** Lower case with punctuation flattened, so a phrase can be searched for. */
function flatten(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** Whether the flattened text contains this word or phrase as whole words. */
function contains(haystack: string, needle: string): boolean {
  const phrase = flatten(needle).trim();
  return phrase !== '' && haystack.includes(` ${phrase} `);
}

/**
 * The category the words point at, or null.
 *
 * Null rather than `other`: "no suggestion" and "I suggest Other" are different
 * things, and only one of them is worth a chip.
 */
export function suggestCategory(title: string, issue: string): Suggestion<TicketCategory> | null {
  const text = flatten(`${title} ${issue}`);
  for (const [category, words] of CATEGORY_WORDS) {
    for (const word of words) {
      if (contains(text, word)) return { value: category, because: word };
    }
  }
  return null;
}

/**
 * The priority the words point at, or null.
 *
 * Only upward, and only from the words that mean "this stops a lesson". A
 * suggestion of `normal` would be a chip offering to change nothing.
 */
export function suggestPriority(title: string, issue: string): Suggestion<Priority> | null {
  const text = flatten(`${title} ${issue}`);
  for (const word of URGENT_WORDS) {
    if (contains(text, word)) return { value: 'urgent', because: word };
  }
  for (const word of HIGH_WORDS) {
    if (contains(text, word)) return { value: 'high', because: word };
  }
  return null;
}

/**
 * The words a duplicate search should use.
 *
 * The longest few words of the title, because those are the ones that name the
 * thing: "projector" and "signal" find the other reports; "the", "in" and "is"
 * find the whole queue. Short words and digits are dropped — a room number is
 * matched by the room, not by the text.
 */
export function duplicateTokens(title: string, limit = 3): string[] {
  const words = flatten(title)
    .trim()
    .split(' ')
    .filter((word) => word.length >= 5 && !/^\d+$/.test(word));
  return [...new Set(words)].sort((left, right) => right.length - left.length).slice(0, limit);
}

/** Whether there is enough text to guess from at all. */
export function worthSuggesting(title: string, issue: string): boolean {
  return `${title} ${issue}`.trim().length >= 8;
}
