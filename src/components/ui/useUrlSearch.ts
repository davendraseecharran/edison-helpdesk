'use client';

import { useEffect, useState } from 'react';

/**
 * What an arriving URL value means for a box that has sent `sent` (oldest
 * first): the echo of one of its own pushes, which drops that push and every
 * older one, or a change from elsewhere, which the box adopts.
 */
export function reconcileArrival(
  sent: readonly string[],
  urlValue: string,
): { adopt: boolean; sent: string[] } {
  const at = sent.indexOf(urlValue);
  return at === -1 ? { adopt: true, sent: [] } : { adopt: false, sent: sent.slice(at + 1) };
}

/**
 * A search box whose value lives in the URL, typed into locally and pushed
 * there after a pause.
 *
 * The box follows the URL when the URL changes from somewhere else — Clear
 * filters, the back button — but NOT when the change is the echo of its own
 * push. Without that distinction the box lost letters: type "Whi", the pause
 * sends it, keep typing "tney", and when the server's answer for "Whi" lands
 * the URL reads "Whi" and the box was set back to it, eating everything typed
 * while the page was loading. So the values sent are remembered until they come
 * back, and an arriving URL that matches one is recognised as ours and left
 * alone.
 *
 * Derived during render (React's pattern for state that follows a prop), with
 * state rather than a ref for the sent values because refs may not be read
 * while rendering.
 */
export function useUrlSearch(
  urlValue: string,
  push: (value: string) => void,
  delay = 250,
): {
  value: string;
  setValue: (value: string) => void;
  /** Push now, skipping the pause: Enter in the box. */
  commit: () => void;
} {
  const [value, setValue] = useState(urlValue);
  const [seen, setSeen] = useState(urlValue);
  // Every value pushed and not yet seen come back, oldest first. Two can be in
  // flight at once: "Whi" sent, "Whitney" sent before "Whi" has landed.
  const [sent, setSent] = useState<string[]>([]);

  if (seen !== urlValue) {
    setSeen(urlValue);
    const arrival = reconcileArrival(sent, urlValue);
    if (arrival.adopt) setValue(urlValue);
    setSent(arrival.sent);
  }

  function send(next: string) {
    setSent((prev) => [...prev, next]);
    push(next);
  }

  const lastSent = sent.length > 0 ? sent[sent.length - 1] : null;
  useEffect(() => {
    if (value === (lastSent ?? urlValue)) return;
    const timer = setTimeout(() => send(value), delay);
    return () => clearTimeout(timer);
    // `send` and `push` read the latest params themselves; re-running on every
    // params change would restart the pause mid-word.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, urlValue, lastSent, delay]);

  return {
    value,
    setValue,
    commit: () => {
      if (value !== (lastSent ?? urlValue)) send(value);
    },
  };
}
