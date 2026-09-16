'use client';

/**
 * The line under the greeting, asked for after the page is already readable.
 *
 * Today renders `briefingSentence` on the server and paints it with everything
 * else. Only then does this hook ask whether the reader's own assistant has a
 * better sentence for the same numbers. Nothing waits for the answer: no
 * suspense boundary, no skeleton, no spinner. The screen is finished before the
 * request is sent, and the sentence either improves a second later or does not.
 *
 * Null is the whole failure vocabulary. Not connected, no key on the server, a
 * refusal, a timeout, an answer that broke the voice's rules — all of them come
 * back as null and the library line stays. There is nothing to report, because
 * what is on screen is already right.
 *
 * The counts are the dependency, so claiming a ticket asks again rather than
 * leaving a sentence about a queue that no longer exists. The server's cache is
 * what makes that cheap: the same counts inside ten minutes cost one RPC.
 */

import { useEffect, useState } from 'react';
import { todayLineAction } from '@/lib/ai/today-line-actions';
import type { BriefingCounts } from '@/lib/domain/today';

export function useAssistantLine(counts: BriefingCounts, enabled: boolean): string | null {
  /*
   * The dependency, as one string. The counts object is rebuilt by every render
   * of the page above this one, so depending on it directly would re-ask on
   * every re-render; depending on what it SAYS re-asks when the queue changes,
   * which is the rule the cache is keyed on too.
   */
  const key = [
    counts.unassigned,
    counts.waiting,
    counts.mine,
    counts.accessRequests,
    counts.devicesDue,
  ].join(':');

  const [line, setLine] = useState<string | null>(null);

  /*
   * Back to the library line the moment the queue changes, adjusted during the
   * render rather than in an effect: the count and the sentence describing it
   * have to arrive in the same paint, or the screen briefly says "two things
   * need you" beside a sentence about three.
   */
  const [asked, setAsked] = useState(key);
  if (asked !== key) {
    setAsked(key);
    setLine(null);
  }

  useEffect(() => {
    if (!enabled) return;

    let live = true;
    void todayLineAction()
      .then((result) => {
        if (live) setLine(result.line);
      })
      .catch(() => {
        // The action already swallows everything it can; this is the network
        // between the browser and it, and the answer is the same.
      });
    return () => {
      live = false;
    };
  }, [enabled, key]);

  return line;
}
