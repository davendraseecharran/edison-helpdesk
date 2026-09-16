/**
 * The line under the greeting, when the reader's own ChatGPT is connected.
 *
 * `briefingSentence` in `lib/domain/today.ts` already says how many things need
 * you and what shape they are. It is correct, it is instant, and it is the same
 * sentence every morning: "Four things need you. Three unclaimed and one
 * waiting on a reply." What it cannot say is the thing a colleague would say
 * first — that three of those four are the same dead projector.
 *
 * So when a ChatGPT account is linked, the same facts are handed to that
 * person's own assistant and it writes the sentence instead. Everything here is
 * pure: what the model is told, what counts as an acceptable answer, and when a
 * stored line may be reused. The call itself is `today-line-actions.ts`.
 *
 * Three rules shape the whole module:
 *
 *   1. NOTHING NEW IS SENT. The facts are built from `needsYou()` — the rows
 *      already rendered on the screen — plus the counts already printed in the
 *      library sentence. No requester name, no email, no ticket id, no room, no
 *      body text. If it is not on the screen the reader is looking at, it is
 *      not in the prompt.
 *   2. AN ANSWER IS CHECKED, NOT TRUSTED. `acceptTodayLine` is the whole
 *      contract: one sentence, ninety characters, the voice's own bans. A model
 *      that answers with three options, a markdown fence or an exclamation mark
 *      is treated exactly as a model that did not answer at all, and the screen
 *      keeps the library line.
 *   3. THE INPUT IS THE CACHE KEY. A line is stored with a hash of the facts it
 *      was written from, so it survives for ten minutes of reloads and dies the
 *      moment a ticket is claimed. A cached sentence about a queue that has
 *      changed is worse than no sentence at all.
 */

import { MAX_LINE_LENGTH } from '@/lib/voice/moments';
import { createHash } from 'node:crypto';
import { isRecord, textOf } from '@/lib/guards';
import { needsYou, type Briefing, type BriefingCounts } from '@/lib/domain/today';

/**
 * How long a line stands before it is written again.
 *
 * Ten minutes, because the counts are the real trigger: a claim or a resolve
 * changes the hash and the next render asks for a new sentence anyway. This is
 * only the ceiling for a queue that is sitting still, where a line that quietly
 * ages for an afternoon would start describing a morning.
 */
export const TODAY_LINE_TTL_MS = 10 * 60 * 1000;

/** How long an ask that came back with nothing is remembered before trying again. */
export const TODAY_LINE_RETRY_MS = 2 * 60_000;

/**
 * The voice's limit, and the same one every library line is held to
 * (`MAX_LINE_LENGTH` in `voice/moments.ts`): docs/VOICE.md says never longer
 * than seventy characters, and a sentence in this slot is in that voice
 * whoever wrote it. "Look like one fault" fits in seventy; an essay does not.
 */
export const TODAY_LINE_MAX_CHARS = MAX_LINE_LENGTH;

/** The most rows named in the prompt. `needsYou` already caps at seven. */
const ROW_LIMIT = 7;

/** How much of a title goes in. Long enough to recognise, short enough to scan. */
const TITLE_CHARS = 70;

/** One row of the screen, as the model is allowed to see it. */
export interface TodayFactRow {
  /** Unclaimed or waiting on a reply. An access request is a count, never a name. */
  kind: 'unassigned' | 'waiting';
  title: string;
  /** How many tickets this row stands for. Above one it is a folded group. */
  count: number;
}

/** Everything the model is given, and nothing else. */
export interface TodayFacts {
  counts: BriefingCounts;
  rows: TodayFactRow[];
}

function trimTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  return clean.length <= TITLE_CHARS ? clean : `${clean.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

/**
 * What the screen is showing, reduced to what may be sent.
 *
 * Built from `needsYou` rather than from the briefing's raw lists on purpose:
 * that function is what decides which rows are rendered and how repeats fold
 * into one, so anything it drops is a row the reader cannot see either. Access
 * requests carry a person's name and address and are therefore counted, never
 * named — the count is already in the library sentence.
 */
export function todayFacts(briefing: Briefing): TodayFacts {
  const rows: TodayFactRow[] = [];
  for (const item of needsYou(briefing)) {
    if (item.kind === 'access') continue;
    const title = trimTitle(item.title);
    if (title === '') continue;
    rows.push({ kind: item.kind, title, count: Math.max(1, Math.trunc(item.count)) });
    if (rows.length >= ROW_LIMIT) break;
  }
  return { counts: { ...briefing.counts }, rows };
}

/**
 * The facts as one deterministic string.
 *
 * Written by hand rather than with `JSON.stringify` so the order of the keys is
 * this module's decision and not the object literal's: a hash that changes
 * because a field moved would expire every cached line on the next deploy.
 */
export function todayFactsFingerprint(facts: TodayFacts): string {
  const { counts } = facts;
  const head = [
    `u=${counts.unassigned}`,
    `w=${counts.waiting}`,
    `m=${counts.mine}`,
    `a=${counts.accessRequests}`,
    `d=${counts.devicesDue}`,
  ].join('|');
  const rows = facts.rows
    .map((row) => `${row.kind}:${row.count}:${row.title.toLowerCase()}`)
    .join('|');
  return `v1|${head}|${rows}`;
}

/** The cache key: short, stable, and meaningless on its own. */
export function todayLineHash(facts: TodayFacts): string {
  return createHash('sha256').update(todayFactsFingerprint(facts)).digest('hex').slice(0, 32);
}

const KIND_WORDS: Record<TodayFactRow['kind'], string> = {
  unassigned: 'unclaimed',
  waiting: 'waiting on a reply',
};

/**
 * What the assistant is told about the job.
 *
 * Rules rather than a persona, in the same register as `prompt.ts`. The two
 * that matter most are the ban on inventing a fact — a sentence naming a room
 * the briefing never mentioned would be believed, and would be wrong — and the
 * instruction to answer with the sentence alone, because anything else is
 * thrown away by `acceptTodayLine` and the reader gets the library line for no
 * reason.
 */
export function todayLineInstructions(): string {
  return [
    'You write one line for the Today screen of Edison Helpdesk, a school IT helpdesk.',
    'It sits under the greeting and is the first thing a NetRider reads. It tells them what the day actually looks like.',
    '',
    'How to write it:',
    `- One sentence, at most ${TODAY_LINE_MAX_CHARS} characters including spaces and the full stop.`,
    '- Plain and calm, the way a senior colleague who has seen this before would say it. Sentence case.',
    '- Name the real situation rather than restating the counts. If several unclaimed tickets read like one fault, say that. If the queue is otherwise clear, say that.',
    '- Use only the facts you are given. Never invent a number, a room, a name, a ticket or a cause you were not told.',
    '',
    'Never:',
    '- An exclamation mark, an emoji, a greeting, a name, praise, or advice about how to feel.',
    '- Title case, capitals for emphasis, an arrow, a middle dot, markdown, or quotation marks around the line.',
    '- A second sentence, a preamble, a list of alternatives, or any explanation of your choice.',
    '',
    'Answer with the sentence and nothing else.',
  ].join('\n');
}

/**
 * The facts, as the model reads them.
 *
 * The counts come first because they are what the sentence has to stay true to,
 * and the rows follow because they are where an observation can come from. Both
 * are already on the screen beside the line being written.
 */
export function todayLineFactsMessage(facts: TodayFacts): string {
  const { counts } = facts;
  const lines = [
    'The numbers on this screen right now:',
    `- unclaimed tickets: ${counts.unassigned}`,
    `- your tickets waiting on a reply: ${counts.waiting}`,
    `- your own open tickets: ${counts.mine}`,
    `- people waiting for an administrator to approve access: ${counts.accessRequests}`,
    `- machines due back: ${counts.devicesDue}`,
  ];

  if (facts.rows.length === 0) {
    lines.push('', 'No ticket rows are listed on the screen.');
  } else {
    lines.push('', 'The rows listed on the screen, most urgent first:');
    for (const row of facts.rows) {
      const repeats = row.count > 1 ? ` (${row.count} reports of this, folded into one row)` : '';
      lines.push(`- ${KIND_WORDS[row.kind]}: ${row.title}${repeats}`);
    }
  }

  lines.push('', 'Write the line.');
  return lines.join('\n');
}

export interface TodayLinePrompt {
  instructions: string;
  message: string;
}

/** The whole request, as two strings. Nothing else is ever sent. */
export function todayLinePrompt(facts: TodayFacts): TodayLinePrompt {
  return { instructions: todayLineInstructions(), message: todayLineFactsMessage(facts) };
}

/**
 * Characters a line may contain.
 *
 * An allow-list rather than an emoji block-list, because "no emoji" is not a
 * property anybody can test for and "letters, digits and the punctuation this
 * application already writes" is. It is also what keeps a stray control
 * character or a right-to-left override out of the first sentence on the page.
 */
const ALLOWED = /^[\p{L}\p{N} .,;:'’()/%&+#–—-]+$/u;

/** Wrappers a model adds when it is being helpful. */
const FENCE = /^\s*```[a-z]*\s*|\s*```\s*$/gi;

/** The label a model writes in front of an answer when it is being tidy. */
const LABEL = /^(line|answer|output|sentence|result|briefing)\s*:\s*/i;

/**
 * The answer, or null.
 *
 * Null is not a failure path — it is the ordinary one whenever the model did
 * something other than write the sentence, and the caller's response to it is
 * always the same: keep the library line and say nothing. So everything here
 * returns null rather than throwing, and nothing is repaired beyond whitespace,
 * a wrapping quote and a missing full stop.
 */
export function acceptTodayLine(raw: string): string | null {
  let text = raw.trim().replace(FENCE, '').replace(/\s+/g, ' ').trim();
  if (text === '') return null;

  // "Line: ..." is a model being tidy, not a model failing. The label comes off
  // before the quotes, because it is usually written outside them.
  text = text.replace(LABEL, '').trim();

  // One pair of wrapping quotes, straight or curly. A model that quotes its own
  // answer is still answering.
  const quoted = /^["“'‘](.*)["”'’]$/.exec(text);
  if (quoted) text = quoted[1].trim();
  if (text === '') return null;

  if (text.includes('!')) return null;
  if (text.includes('|') || text.includes('*') || text.includes('`')) return null;

  if (!text.endsWith('.')) text = `${text}.`;
  // A second full stop means a second sentence. "St." and "3.5" do not appear
  // in a queue summary, and a sentence that needs them is not this one.
  if (text.slice(0, -1).includes('.')) return null;
  if (text.length > TODAY_LINE_MAX_CHARS) return null;
  if (!ALLOWED.test(text)) return null;
  // A sentence opens with a capital or with the number it is about, and it has
  // more than one word in it.
  if (!/^[\p{Lu}\p{N}]/u.test(text)) return null;
  if (!text.includes(' ')) return null;

  // A shout. Letters only, so "3 tickets" and an acronym inside a title do
  // not count; the whole sentence has to be one.
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length > 3 && letters === letters.toUpperCase()) return null;
  // Title Case. A name or a room label earns a capital or two; a headline
  // gives one to most of its words.
  const words = text.split(' ').filter((word) => /\p{L}/u.test(word));
  const capitalised = words.slice(1).filter((word) => /^\p{Lu}/u.test(word));
  if (capitalised.length > 2 && capitalised.length * 2 > words.length) return null;

  return text;
}

/** What `account_preferences.today_line` holds. */
export interface CachedTodayLine {
  /**
   * The sentence, or '' when the last ask about this queue came back with
   * nothing usable: that is remembered too, so a model that keeps failing
   * costs one call and not one per visit.
   */
  line: string;
  /** The fingerprint of the facts it was written from. */
  hash: string;
  /** When the database stamped it, ISO 8601. */
  generatedAt: string;
}

/**
 * The stored value, checked rather than cast.
 *
 * A row written by an older build, a hand-edited column or an empty default all
 * come back as null, which the caller reads as "there is nothing to reuse". An
 * empty line with a fingerprint is not that: it is the mark of an ask that
 * produced nothing, and it is kept.
 */
export function readCachedTodayLine(value: unknown): CachedTodayLine | null {
  if (!isRecord(value)) return null;
  const line = textOf(value.line).trim();
  const hash = textOf(value.hash).trim();
  const generatedAt = textOf(value.generated_at).trim();
  if (hash === '' || generatedAt === '') return null;
  return { line, hash, generatedAt };
}

/**
 * Whether the stored line may be shown without asking again.
 *
 * Two questions, and both have to answer yes. Is it about THIS queue — the hash
 * of the facts, so a claim expires it immediately — and is it young enough,
 * which is the only bound on a queue nobody is touching.
 *
 * A timestamp in the future is treated as stale rather than as infinitely
 * fresh. Clock skew between a database and a serverless region is real, and the
 * failure it must not cause is a line that never refreshes again.
 *
 * A stored failure is fresh for a shorter while: long enough that a hundred
 * visits cost one call, short enough that a model having a bad minute is asked
 * again soon.
 */
export function todayLineIsFresh(
  cached: CachedTodayLine | null,
  hash: string,
  nowMs: number,
): boolean {
  if (cached === null) return false;
  if (cached.hash !== hash) return false;
  const at = Date.parse(cached.generatedAt);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= 0 && age < (cached.line === '' ? TODAY_LINE_RETRY_MS : TODAY_LINE_TTL_MS);
}
