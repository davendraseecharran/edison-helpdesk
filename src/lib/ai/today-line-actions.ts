'use server';

/**
 * The one call behind the line under the greeting.
 *
 * Today renders the library sentence on the server, immediately, exactly as it
 * always did. This action is what the screen asks afterwards, from the browser,
 * once it is already readable: "is there a better sentence for this?" A reply
 * swaps the line; anything else — no connection, no key, a refusal, a timeout,
 * an answer that broke the voice's rules — leaves the page as it is and says
 * nothing about it. There is no error state on the screen, because there is no
 * error: the sentence that is already there is correct.
 *
 * What goes out is decided by `today-line.ts` and is deliberately small: the
 * five counts and the titles of the rows the reader is looking at. No requester,
 * no address, no identifier, no body text, no history. The request runs on the
 * ordinary client with no attribution headers and NO TOOLS at all, because this
 * is a read — nothing it can produce is a change to the helpdesk, so nothing it
 * does is attributed to anybody.
 *
 * The answer is cached on the person's own preferences row, keyed by a hash of
 * the facts it was written from. That is what makes this affordable: a reload
 * costs nothing, a second tab costs nothing, and claiming a ticket is what buys
 * the next sentence.
 */

import { randomUUID } from 'node:crypto';
import { activeAccount } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { isRecord } from '@/lib/guards';
import { loadTodayBriefing } from '@/lib/data/today';
import { needsCount } from '@/lib/domain/today';
import { aiEnabled } from './crypto';
import { loadConnection } from './connections';
import { streamResponses } from './responses-client';
import {
  acceptTodayLine,
  readCachedTodayLine,
  todayFacts,
  todayLineHash,
  todayLineIsFresh,
  todayLinePrompt,
} from './today-line';

export interface TodayLineResult {
  /** The assistant's sentence, or null to keep the one already on screen. */
  line: string | null;
}

/** Nothing to say. The only answer this action ever gives when it cannot help. */
const SILENT: TodayLineResult = { line: null };

/**
 * How long the model gets.
 *
 * One short sentence at the lowest effort is a few seconds. Past twenty the
 * reader has finished reading the library line and started working, and a
 * sentence that arrives then is a page rewriting itself under them.
 */
const DEADLINE_MS = 20_000;

/**
 * The effort this asks for, regardless of the person's setting.
 *
 * Their reasoning preference is about the conversation in the panel, where they
 * are waiting for an answer and paying for it deliberately. This is ninety
 * characters written for a page they did not ask a question on, and spending
 * Max on it once every ten minutes would be spending their account's allowance
 * on a greeting.
 */
const EFFORT = 'low';

export async function todayLineAction(): Promise<TodayLineResult> {
  try {
    const account = await activeAccount();
    if (!account) return SILENT;
    // No key, no feature. The same gate the panel uses, checked before anything
    // is read, so a server without AI_TOKEN_KEY does no work at all here.
    if (!aiEnabled()) return SILENT;

    // Most readers have not connected an account, and for them the answer is
    // known before any of the briefing is read.
    const connection = await loadConnection(account.id);
    if (connection === null) return SILENT;

    const briefing = await loadTodayBriefing();
    // A briefing that could not be read has no facts to write from, and an empty
    // queue already has its own line in the interface's voice — one this is not
    // allowed to overwrite.
    if (!briefing.ok) return SILENT;
    if (needsCount(briefing.counts) === 0) return SILENT;

    const facts = todayFacts(briefing);
    const hash = todayLineHash(facts);

    const supabase = await createClient();
    const stored = await supabase.rpc('app_my_preferences');
    if (!stored.error) {
      const row = Array.isArray(stored.data) ? stored.data[0] : stored.data;
      const cached = readCachedTodayLine(isRecord(row) ? row.today_line : null);
      // A fresh empty line is an ask that came back with nothing, minutes ago:
      // the answer is the library line, without asking again.
      if (todayLineIsFresh(cached, hash, Date.now())) {
        return { line: cached !== null && cached.line !== '' ? cached.line : null };
      }
    }

    const prompt = todayLinePrompt(facts);
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DEADLINE_MS);

    let answer = '';
    let refused = false;
    // The stream ends quietly when it is aborted or when the server closes it
    // early; only `done` says the sentence is whole. Half a sentence passes
    // every check the validator makes, so it is never handed to it.
    let finished = false;
    try {
      for await (const event of streamResponses({
        tokens: connection.tokens,
        chatgptAccountId: connection.chatgptAccountId,
        instructions: prompt.instructions,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: prompt.message }],
          },
        ],
        // No tools. This cannot read a ticket, cannot claim one, and cannot be
        // talked into trying: there is nothing for a model to call.
        tools: [],
        reasoning: EFFORT,
        sessionId: randomUUID(),
        signal: controller.signal,
      })) {
        if (event.type === 'text_delta') answer += event.text;
        else if (event.type === 'error') refused = true;
        else if (event.type === 'done') finished = true;
        // A sentence this long cannot be legitimate; stop reading rather than
        // buffer a model that has decided to write an essay.
        if (answer.length > 2_000) break;
      }
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }

    const line = refused || timedOut || !finished ? null : acceptTodayLine(answer);

    // Stored either way: the sentence, to reuse for ten minutes, or an empty
    // line under the same fingerprint, which says this queue was asked about
    // and nothing usable came back, so the next visit in the next two minutes
    // does not pay for the same failure. Storing is best effort: a line that
    // was written and could not be saved is still the right line to show.
    const saved = await supabase.rpc('app_set_today_line', { p_line: line ?? '', p_hash: hash });
    if (saved.error) {
      console.error('[today] line cache write failed', { message: saved.error.message });
    }

    return { line };
  } catch (error) {
    // Deliberately swallowed, and deliberately logged without the driver's text
    // reaching the browser: the screen's answer to every one of these is the
    // library line it is already showing.
    console.error('[today] assistant line failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return SILENT;
  }
}
