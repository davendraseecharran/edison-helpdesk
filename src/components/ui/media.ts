'use client';

import { useSyncExternalStore } from 'react';

/**
 * Subscribe to a CSS media query as an external store.
 *
 * The server snapshot is always `false`, and so is the first client render, so
 * markup never depends on the viewport during hydration. Components that
 * branch on the result must therefore be written so the `false` branch is a
 * correct (if less specific) render, not a broken one.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Viewport breakpoints, matching `shell.css`. */
export const PHONE_QUERY = '(max-width: 719.98px)';

export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/**
 * The resolved value of a design token, kept in step with the theme.
 *
 * For the rare library that needs a literal value rather than `var()`. The
 * snapshot re-reads the computed style whenever `data-theme` changes on the
 * root element, so a theme switch never leaves a stale colour behind.
 */
export function useTokenValue(name: string): string | undefined {
  return useSyncExternalStore(
    subscribeToTheme,
    () => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined,
    () => undefined,
  );
}

function subscribeToNothing(): () => void {
  return () => {};
}

/** Whether the visitor is on Apple hardware, for keyboard hints. False on the server. */
export function useApplePlatform(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => false,
  );
}
