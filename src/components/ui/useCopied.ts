'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a copy control shows its check before it turns back into "copy". */
export const COPIED_MS = 1500;

/**
 * Put text on the clipboard and say so for a moment.
 *
 * Every copy control in the application answers the same way: the copy glyph
 * crosses into a check (`Button`'s `iconKey`), holds for 1.5 seconds and
 * crosses back. `copy` resolves `false` when the browser refused, so the
 * caller can tell the person what to do instead; nothing is claimed that did
 * not happen.
 */
export function useCopied(): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setCopied(false);
      return false;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    return true;
  }, []);

  return { copied, copy };
}
