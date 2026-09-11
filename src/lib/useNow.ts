'use client';

/**
 * Shared ticking clock for relative times ("4h ago").
 *
 * Modelled as an external store so the server snapshot is null: relative times
 * only appear after hydration, and before that every renderer shows the same
 * absolute timestamp. One interval serves every subscriber.
 */

import { useSyncExternalStore } from 'react';

/**
 * Shared ticking clock, modelled as an external store.
 *
 * The server snapshot is `null` so relative times ("4h ago") only appear after
 * hydration; before that, components render the absolute timestamp, which is
 * identical on both sides. One interval serves every subscriber.
 */
const CLOCK_INTERVAL_MS = 60_000;

let clockValue = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();

function subscribeToClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockValue = Date.now();
    clockTimer = setInterval(() => {
      clockValue = Date.now();
      for (const subscriber of clockListeners) subscriber();
    }, CLOCK_INTERVAL_MS);
  }

  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function readClock(): number {
  return clockValue;
}

function readServerClock(): number | null {
  return null;
}

export function useNow(): number | null {
  return useSyncExternalStore(subscribeToClock, readClock, readServerClock);
}
