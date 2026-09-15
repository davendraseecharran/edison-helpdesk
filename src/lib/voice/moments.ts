/**
 * The helpdesk's voice: what it says at the few moments worth saying anything.
 *
 * The person using this application is a NetRider between classes who wants to
 * be done. So character is spent where it saves effort or marks a real win — a
 * queue that hit zero, a ticket closed, a device back on the shelf, a first
 * sign-in, a Friday afternoon — and nowhere near the actions repeated a hundred
 * times a day. Claiming a ticket gets one flat sentence, because the tenth time
 * you read a joke about claiming a ticket it is not a joke, it is a delay.
 *
 * Who it sounds like: a calm senior technician who has seen this before. Names
 * what happened, says what it means, stops. No exclamation marks, no emoji, no
 * apologies, sentence case throughout. See docs/VOICE.md.
 *
 * Pure and free of React, the DOM and the clock, so every line is testable and
 * the same moment reads the same on the server and in the browser. Selection is
 * deterministic: the context (hour, weekday, count, an explicit seed) picks the
 * variant, so a server render and its hydration never disagree, and the line
 * changes through the day rather than on every keystroke.
 */

/** Every moment the interface has something to say at. */
export const MOMENTS = [
  'today.morning',
  'today.afternoon',
  'today.evening',
  'today.empty',
  'queue.cleared',
  'ticket.resolved',
  'ticket.claimed',
  'device.returned',
  'signin.first',
  'friday.afternoon',
  'error.generic',
  'assistant.idle',
] as const;

export type MomentId = (typeof MOMENTS)[number];

/**
 * What a line may name.
 *
 * Every field is optional, and a line that names a value the context does not
 * carry is simply not chosen — which is why each moment has several. That is
 * the whole reason `{count}` can appear in a line at all: on a screen that does
 * not know the count, a different line is picked rather than "undefined open".
 */
export interface MomentContext {
  /** The first name of the person reading. Greetings need it. */
  name?: string;
  /** What the line is about: a ticket number, an asset tag. */
  subject?: string;
  /** A real number the line may quote. Never a placeholder. */
  count?: number;
  /** The palette's keycap as this platform writes it: "⌘K" or "Ctrl K". */
  key?: string;
  /** School-local hour, 0–23. Chooses the greeting and varies the wording. */
  hour?: number;
  /** Day of the week, 0 is Sunday. */
  weekday?: number;
  /** Forces a variant. For tests and for a line that must not change on a re-render. */
  seed?: number;
}

/** A line, and the quieter second line some moments carry. */
export interface VoiceLine {
  text: string;
  /** The second line of a two-line moment, or null. */
  follow: string | null;
}

interface MomentCopy {
  lines: readonly string[];
  /** Chosen with the same index as `lines`, so a pair always reads as a pair. */
  follow?: readonly string[];
}

/**
 * The library.
 *
 * Every moment carries at least three lines and no line runs past 70
 * characters — both are unit-tested, because a fourth line added in a hurry is
 * exactly where a wall of text gets in. Placeholders are `{name}`, `{subject}`,
 * `{count}` and `{key}`.
 */
const COPY: Record<MomentId, MomentCopy> = {
  /*
   * A greeting is the shortest line on the page set at the largest size, so
   * every variant is a salutation and a name and nothing else. The remark that
   * used to ride along here pushed the briefing under it into a footnote; it
   * belongs on the second line, at the size a sentence is read at.
   */
  'today.morning': {
    lines: ['Good morning, {name}.', 'Morning, {name}.', 'Early, {name}.'],
  },
  'today.afternoon': {
    lines: ['Good afternoon, {name}.', 'Afternoon, {name}.', 'Hello, {name}.'],
  },
  'today.evening': {
    lines: ['Good evening, {name}.', 'Evening, {name}.', 'Still here, {name}.'],
  },
  'today.empty': {
    lines: [
      'Nothing needs you. The queue is clear.',
      'All clear. Nothing is waiting on you.',
      'Nothing needs you. Good time to walk the carts.',
      'Queue is clear. The next thing to break will find you.',
    ],
  },
  'queue.cleared': {
    lines: [
      'Queue is clear. That was real work.',
      'Zero waiting. You emptied it.',
      'Nothing left in the queue. Take the ten minutes.',
      'Queue at zero. Somebody should write that down.',
    ],
  },
  'ticket.resolved': {
    lines: [
      '{subject} closed. Someone got their day back.',
      '{subject} closed. Written down and out of the queue.',
      '{subject} closed. One fewer walk-in tomorrow.',
      '{subject} closed. {count} still open.',
    ],
  },
  /*
   * Flat on purpose, and the last line names nothing: a claim made from a
   * notification or the palette does not always have a number in hand, and a
   * moment whose every line needs one would render "  is yours."
   */
  'ticket.claimed': {
    lines: [
      '{subject} is yours.',
      'You own {subject}.',
      '{subject} claimed.',
      'You own this ticket.',
    ],
  },
  'device.returned': {
    lines: [
      '{subject} is back on the shelf.',
      '{subject} returned. Back in stock.',
      '{subject} is checked in.',
    ],
  },
  'signin.first': {
    lines: [
      'Welcome, {name}. This is the desk.',
      'Welcome in, {name}. Everything starts here.',
      'Welcome, {name}. You are on the helpdesk now.',
    ],
    follow: [
      'Press {key} for anything. Paste a tag or a number and it jumps.',
      'One key worth knowing: {key} reaches everything you can see.',
      '{key} opens the palette. It is the short way through this app.',
    ],
  },
  'friday.afternoon': {
    lines: [
      'Friday afternoon. Close what you can, leave the rest.',
      'Friday. Whatever is still open will keep until Monday.',
      'Friday afternoon. The carts can wait until Monday.',
    ],
  },
  'error.generic': {
    lines: [
      'That did not go through. Nothing changed. Try again.',
      'That did not save. Nothing on the record changed.',
      'That did not go through. Check your connection and try again.',
    ],
  },
  'assistant.idle': {
    lines: [
      'Ask me to claim, resolve or look something up.',
      'Ask what changed today, or who has a device out.',
      'The queue has {count} waiting. Ask me to summarise it.',
      '{count} waiting in the queue. Ask me who should take them.',
    ],
  },
};

/** The longest a line may be. Past this it stops being a remark and becomes copy. */
export const MAX_LINE_LENGTH = 70;

const PLACEHOLDER = /\{(name|subject|count|key)\}/g;

/** The placeholders a line names, in the order they appear. */
export function placeholdersIn(line: string): string[] {
  return Array.from(line.matchAll(PLACEHOLDER), (match) => match[1]);
}

/** Every line of a moment, unsubstituted. For tests and for docs. */
export function linesOf(moment: MomentId): readonly string[] {
  return COPY[moment].lines;
}

/** Every second line of a moment, unsubstituted. Empty when it has none. */
export function followsOf(moment: MomentId): readonly string[] {
  return COPY[moment].follow ?? [];
}

/** Whether the context carries a real value for every placeholder in `line`. */
function satisfiable(line: string, context: MomentContext): boolean {
  return placeholdersIn(line).every((token) => {
    if (token === 'count') return typeof context.count === 'number' && Number.isFinite(context.count);
    const value = context[token as 'name' | 'subject' | 'key'];
    return typeof value === 'string' && value.trim() !== '';
  });
}

function fill(line: string, context: MomentContext): string {
  return line.replace(PLACEHOLDER, (_, token: string) => {
    if (token === 'count') return String(Math.trunc(context.count ?? 0));
    return (context[token as 'name' | 'subject' | 'key'] ?? '').trim();
  });
}

/**
 * The variant number this context asks for.
 *
 * Deterministic, and deliberately coarse: the hour and the weekday move it
 * through the day, a count moves it as the desk changes, and an explicit
 * `seed` pins it. Nothing here is random, so the same render on the server and
 * in the browser produces the same sentence, and a page that re-renders three
 * times while you read it does not rewrite itself under you.
 */
export function variantIndex(context: MomentContext, length: number): number {
  if (length <= 0) return 0;
  const base =
    context.seed !== undefined
      ? Math.trunc(context.seed)
      : (context.hour ?? 0) * 3 + (context.weekday ?? 0) * 5 + Math.trunc(context.count ?? 0);
  return ((base % length) + length) % length;
}

/**
 * What the interface says at this moment.
 *
 * Lines whose placeholders the context cannot fill are dropped first, so a
 * screen that does not know the open count never renders one that quotes it.
 * If nothing survives that, the first line is used with empty values rather
 * than returning nothing: a moment always has something to say.
 */
export function voiceLine(moment: MomentId, context: MomentContext = {}): VoiceLine {
  const copy = COPY[moment];
  const usable = copy.lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => satisfiable(entry.line, context));
  const chosen = usable.length > 0 ? usable[variantIndex(context, usable.length)] : { line: copy.lines[0], index: 0 };

  const follows = copy.follow ?? [];
  const follow = follows.length > 0 ? follows[chosen.index % follows.length] : null;

  return {
    text: fill(chosen.line, context),
    follow: follow === null ? null : fill(follow, context),
  };
}

/** Just the sentence, for the many callers that never show a second line. */
export function say(moment: MomentId, context: MomentContext = {}): string {
  return voiceLine(moment, context).text;
}

/** Which greeting a school-local hour calls for. */
export function greetingMoment(hour: number): 'today.morning' | 'today.afternoon' | 'today.evening' {
  if (hour < 12) return 'today.morning';
  if (hour < 17) return 'today.afternoon';
  return 'today.evening';
}

/**
 * Whether it is Friday after lunch.
 *
 * The one calendar moment the interface acknowledges, because it is the one
 * that changes what a NetRider does next: close what you can, leave the rest.
 */
export function isFridayAfternoon(context: { weekday?: number; hour?: number }): boolean {
  return context.weekday === 5 && (context.hour ?? 0) >= 12;
}
