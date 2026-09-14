/**
 * What a tool chip says while the call is still running.
 *
 * The server sends `describeCall`'s text — "Claim ticket (ticket: EDT-1042)" —
 * and that is exactly right on the approval card, where somebody is being asked
 * to consent to a specific call and has to see the arguments as they are. On a
 * chip in the transcript it reads like a function signature, and the chips are
 * the assistant's running commentary: a colleague says "claiming EDT-1042",
 * not "claim_ticket(ticket: EDT-1042)".
 *
 * So the chip is written here instead, from the tool's own name and arguments.
 * A tool name is `verb_noun`; the verb becomes a present participle and the
 * most identifying argument becomes the subject. Anything this cannot phrase
 * falls back to the server's text, which is always correct if wordy.
 *
 * Only the label changes. The result line ("Claimed EDT-1042") is already the
 * past tense of the same sentence and comes from the tool itself.
 */

/** Verb at the head of a tool name, in the tense the chip needs. */
const PARTICIPLE: Record<string, string> = {
  add: 'Adding',
  assign: 'Assigning',
  bulk: 'Updating',
  cancel: 'Cancelling',
  claim: 'Claiming',
  create: 'Opening',
  get: 'Reading',
  import: 'Importing',
  link: 'Linking',
  list: 'Listing',
  log: 'Recording',
  move: 'Moving',
  reassign: 'Reassigning',
  record: 'Recording',
  remove: 'Removing',
  reopen: 'Reopening',
  resolve: 'Resolving',
  resume: 'Resuming',
  return: 'Returning',
  review: 'Reviewing',
  search: 'Searching',
  set: 'Setting',
  update: 'Updating',
};

/**
 * The argument that names what is being worked on, in preference order. A
 * ticket number beats a free-text query, which beats a person or a machine.
 */
const SUBJECT_KEYS = [
  'ticket',
  'query',
  'person',
  'device',
  'asset_tag',
  'serial_number',
  'osis',
  'number',
  'title',
  'display_name',
  'email',
  'account',
  'scope',
];

/** The rest of the tool name, spoken rather than spelled: `my_tickets` → `my tickets`. */
function objectOf(name: string): string {
  return name.split('_').slice(1).join(' ');
}

/**
 * The object with an article in front of it, where one belongs.
 *
 * `return_to_queue` is `returning` plus `to queue`, and "Returning the to
 * queue" is not English. A leading preposition keeps its place and the article
 * goes after it.
 */
const PREPOSITIONS = new Set(['to', 'from', 'on', 'in', 'for', 'with']);

function withArticle(object: string): string {
  const [first, ...rest] = object.split(' ');
  if (PREPOSITIONS.has(first) && rest.length > 0) return `${first} the ${rest.join(' ')}`;
  return `the ${object}`;
}

function subjectOf(args: Record<string, unknown>): string | null {
  for (const key of SUBJECT_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/**
 * The running label for one call, or null when the server's text should stand.
 *
 * Kept deliberately short: a chip is read at a glance while something else is
 * happening, so it names the action and the one thing it is happening to, and
 * leaves the rest of the arguments to the transcript and the audit log.
 */
export function runningLabel(name: string, args: Record<string, unknown>): string | null {
  const verb = PARTICIPLE[name.split('_')[0]];
  if (verb === undefined) return null;

  const object = objectOf(name);
  const subject = subjectOf(args);

  // "Searching for "projector"" reads better than "Searching records".
  if (verb === 'Searching') {
    return subject === null ? 'Searching the records' : `Searching for “${subject}”`;
  }

  // A list call names what is being listed, never a subject: "Listing people".
  if (verb === 'Listing') return `Listing ${object}`;

  if (subject !== null) return `${verb} ${subject}`;
  return object === '' ? null : `${verb} ${withArticle(object)}`;
}
