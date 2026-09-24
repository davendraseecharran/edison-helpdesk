'use client';

/**
 * Where the session's search index lives: module memory, one per tab, keyed
 * by the account it was read for so a different sign-in in the same tab never
 * searches the previous person's index. Read after the first page has painted
 * (`warmSearchIndex`), again when the palette opens on one older than five
 * minutes, and never written to storage.
 */

import { useSyncExternalStore } from 'react';
import { searchIndexAction } from '@/lib/data/search-actions';
import { buildIndex, type LocalIndex } from './local-index';

const MAX_AGE_MS = 5 * 60_000;

let current: { account: string; index: LocalIndex } | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

export function warmSearchIndex(account: string, force = false): Promise<void> {
  if (current && current.account !== account) {
    current = null;
    publish();
  }
  const fresh = current && Date.now() - current.index.loadedAt < MAX_AGE_MS;
  if ((fresh && !force) || inflight) return inflight ?? Promise.resolve();
  inflight = searchIndexAction()
    .then((rows) => {
      if (rows.length > 0) {
        current = { account, index: buildIndex(rows) };
        publish();
      }
    })
    .catch(() => {
      // The palette goes on asking the server; nothing is lost.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useSearchIndex(account: string): LocalIndex | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (current && current.account === account ? current.index : null),
    () => null,
  );
}
