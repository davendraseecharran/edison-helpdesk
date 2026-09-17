'use client';

/**
 * The desk's quick tickets, in the browser.
 *
 * Two surfaces want them and neither is server-rendered with them in hand: the
 * top bar's menu, which is mounted on every page, and the palette, which is
 * mounted only while it is open. Both read from here, so the list is fetched
 * ONCE per page rather than once per surface and never on a keystroke — the
 * palette filters what is already in memory.
 *
 * Module state rather than a context, for the same reason the assistant's draft
 * is: two components in different parts of the tree need the same answer, and a
 * provider around the whole shell to hold twelve rows is a provider that
 * re-renders the shell. Nothing here is private to an account — a preset is the
 * desk's, and only an account that works tickets is ever shown one — and a
 * sign-out is a full navigation, which discards the module with the page.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { listTicketPresetsAction } from '@/lib/data/ticket-preset-actions';
import type { TicketPreset } from '@/lib/domain/ticket-presets';

/** One stable empty array: a new one every render would re-render every reader. */
const NONE: TicketPreset[] = [];

let presets: TicketPreset[] = NONE;
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): TicketPreset[] {
  return presets;
}

/** The server renders no menu rows: the list arrives after hydration. */
function serverSnapshot(): TicketPreset[] {
  return NONE;
}

function load(force: boolean): void {
  if (inFlight) return;
  if (loaded && !force) return;
  inFlight = listTicketPresetsAction()
    .then((list) => {
      presets = list;
    })
    // A list that could not be read is an empty menu, not a broken page. The
    // "New ticket" button beside it still works, which is the whole fallback.
    .catch(() => {
      presets = NONE;
    })
    .finally(() => {
      loaded = true;
      inFlight = null;
      emit();
    });
}

/**
 * Ask for the list before it is needed.
 *
 * Called when the pointer reaches the menu's chevron or focus lands on it, so
 * the rows are usually there by the time it opens. Harmless to call repeatedly:
 * after the first answer it does nothing.
 */
export function primeTicketPresets(): void {
  load(false);
}

/** Read the list again, after something on the settings screen changed it. */
export function refreshTicketPresets(): void {
  load(true);
}

/**
 * The presets, fetching them the first time a caller says it wants them.
 *
 * `enabled` is how a surface says it is being looked at: the palette passes
 * true because it is mounted only while open, and the top bar's menu passes
 * whether it is open. A caller that never enables never costs a round trip.
 */
export function useTicketPresets(enabled: boolean): TicketPreset[] {
  const list = useSyncExternalStore(subscribe, snapshot, serverSnapshot);

  useEffect(() => {
    if (enabled) load(false);
  }, [enabled]);

  return list;
}
