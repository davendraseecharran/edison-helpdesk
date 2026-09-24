'use client';

/**
 * The desk's workflow shortcuts, in the browser, for the palette.
 *
 * The same shape as the quick-ticket store (`src/lib/presets/store.ts`): the
 * palette is mounted only while it is open and is not server-rendered with the
 * list in hand, so it is fetched once per page and filtered in memory rather
 * than asked for on every keystroke. A list that could not be read is an
 * empty list; the five workflows themselves are always offered.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { listWorkflowShortcutsAction } from '@/lib/data/workflow-actions';
import type { WorkflowShortcut } from '@/lib/domain/workflows';

const NONE: WorkflowShortcut[] = [];

let shortcuts: WorkflowShortcut[] = NONE;
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function load(): void {
  if (inFlight || loaded) return;
  inFlight = listWorkflowShortcutsAction()
    .then((list) => {
      shortcuts = list;
    })
    .catch(() => {
      shortcuts = NONE;
    })
    .finally(() => {
      loaded = true;
      inFlight = null;
      for (const listener of listeners) listener();
    });
}

/** The shortcuts, fetched the first time a caller that is showing asks. */
export function useWorkflowShortcuts(enabled: boolean): WorkflowShortcut[] {
  const list = useSyncExternalStore(
    subscribe,
    () => shortcuts,
    () => NONE,
  );
  useEffect(() => {
    if (enabled) load();
  }, [enabled]);
  return list;
}
