/**
 * When what you typed is a question rather than a lookup.
 *
 * The palette is the one surface everybody already reaches for, so it is also
 * the shortest route to the assistant — but only when that is plainly what was
 * meant. "EDT-1042" is a ticket. "5CD91001JX" is a machine. "who has the cart
 * 3 chromebooks" is a question, and making somebody close the palette, find the
 * assistant and type it again is the kind of small tax that stops people using
 * either.
 *
 * Three signals, in order of how certain they are:
 *
 *   1. A forced prefix. `> ` or `? ` means "ask", full stop, and the prefix is
 *      stripped before the text is sent. It is the escape hatch for the case
 *      the heuristics get wrong, and it is why the heuristics are allowed to be
 *      conservative.
 *   2. The shape of a question or an instruction: it ends in a question mark,
 *      or it opens with a verb somebody says to a colleague.
 *   3. Nothing matched. A search that found no record is the one moment the
 *      assistant is obviously more useful than another spelling.
 *
 * Pure, so the classifier is a unit test rather than a paragraph of judgement
 * living inside a component.
 */

import { recognise } from './recognise';

/** How sure the palette is that this text is meant for the assistant. */
export type AskRank =
  /** Not an ask. The row still exists, at the bottom of the actions. */
  | 'no'
  /** Probably an ask: it reads as a question or an instruction. */
  | 'likely'
  /** Certainly an ask: the text said so with a prefix. */
  | 'forced';

export interface AskReading {
  rank: AskRank;
  /** What would actually be sent: the text with any forced prefix removed. */
  prompt: string;
}

/**
 * Verbs a NetRider uses when they are telling somebody to do something.
 *
 * Deliberately short. Every word here is one that almost never begins a
 * person's name, a device model or a ticket title, because a false positive
 * costs the first row of the results — the row Enter opens.
 */
const INSTRUCTION_VERBS = new Set([
  'ask',
  'assign',
  'can',
  'claim',
  'close',
  'could',
  'draft',
  'explain',
  'find',
  'give',
  'how',
  'is',
  'list',
  'reassign',
  'resolve',
  'show',
  'summarise',
  'summarize',
  'tell',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'write',
]);

/** The two characters that force the ask, whether or not a space follows. */
const FORCED = /^([>?])\s*([\s\S]*)$/;

/** Under this many characters it is a code or an abbreviation, not a sentence. */
const MIN_QUESTION_LENGTH = 6;

/**
 * What the palette should do with this text.
 *
 * `found` is whether the search came back with anything; it is what turns a
 * failed lookup into an offer to ask instead. Pass `true` when the answer is
 * not known yet, so the row does not jump to the top of a list that is still
 * loading.
 */
export function readAsk(raw: string, found: boolean): AskReading {
  const text = raw.trim();
  if (text === '') return { rank: 'no', prompt: '' };

  const forced = FORCED.exec(text);
  if (forced) {
    const prompt = forced[2].trim();
    // A bare `>` is somebody who has started forcing an ask and not finished
    // typing it. It is still an ask; there is just nothing to send yet.
    return { rank: 'forced', prompt };
  }

  /*
   * Text that is ENTIRELY an identifier is never an ask, however it is
   * punctuated: a serial with a question mark on the end is still a serial.
   * An identifier inside a sentence is a different matter — "who has
   * A-93542614" is a question about a device, and the sentence around the tag
   * is what makes it one — so this asks `recognise` about the whole string
   * rather than `recognisePaste`, which digs identifiers out of prose.
   */
  if (recognise(text).kind !== 'text') return { rank: 'no', prompt: text };

  if (text.length >= MIN_QUESTION_LENGTH) {
    if (text.endsWith('?')) return { rank: 'likely', prompt: text };
    const first = text.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
    // One word is a search term even when it is also a verb: "close" on its own
    // is somebody looking for the word in a ticket title.
    if (text.includes(' ') && INSTRUCTION_VERBS.has(first)) return { rank: 'likely', prompt: text };
  }

  // Nothing matched the search: another spelling is unlikely to, and the
  // assistant can read the sentence.
  if (!found) return { rank: 'likely', prompt: text };

  return { rank: 'no', prompt: text };
}

/** Whether this reading puts the ask above the records rather than under them. */
export function asksFirst(reading: AskReading): boolean {
  return reading.rank !== 'no';
}
