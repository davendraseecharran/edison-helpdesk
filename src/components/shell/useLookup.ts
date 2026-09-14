'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchAction } from '@/lib/data/search-actions';
import {
  groupHits,
  parseRecent,
  RECENT_STORAGE_KEY,
  rememberRecent,
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_LENGTH,
  ticketNumberFromQuery,
  type GroupedHits,
  type RecentItem,
  type SearchHit,
} from '@/lib/data/search';

export interface LookupState {
  query: string;
  setQuery: (query: string) => void;
  /** The trimmed query, what the search actually asks for. */
  term: string;
  /** Whether `term` is long enough to search. */
  searchable: boolean;
  /** Hits for the current term, or the previous term's while the new answer is on its way. */
  hits: SearchHit[];
  groups: GroupedHits;
  /** A request is pending or in flight for the current text. */
  loading: boolean;
  /** The current term has been searched and nothing came back. */
  empty: boolean;
  /** The ticket number the query names, if it looks like one. */
  ticketNumber: string | null;
  recent: RecentItem[];
  remember: (hit: SearchHit) => void;
  /** The hit for a ticket number, from the current results or a fresh search. */
  findTicket: (number: string) => Promise<SearchHit | null>;
}

function readRecent(): RecentItem[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeRecent(items: RecentItem[]): void {
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage refused: the list still applies to this page.
  }
}

function ticketHit(hits: SearchHit[], number: string): SearchHit | null {
  return hits.find((hit) => hit.kind === 'ticket' && hit.title.startsWith(`${number} `)) ?? null;
}

/**
 * The palette's state: the query, debounced search results, and the recent
 * list. Mount it with the palette and let it go with it; nothing here
 * survives a close, which is how the palette opens clean every time.
 *
 * Typing starts a 150ms timer; the search goes when it lands. Every request
 * carries a sequence number and a reply is dropped unless it is the latest,
 * so quick typing never paints an older answer over a newer one. `loading`
 * is true from the first searchable keystroke until the answer for the
 * current text arrives, which keeps the orb steady rather than flickering on
 * fast replies, and the previous answer stays on screen meanwhile rather
 * than blinking to nothing between keystrokes.
 */
export function useLookup(): LookupState {
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<RecentItem[]>(readRecent);
  /** The latest answer and the term it answers. */
  const [answer, setAnswer] = useState<{ term: string; hits: SearchHit[] }>({ term: '', hits: [] });
  const sequence = useRef(0);

  const term = query.trim();
  const searchable = term.length >= SEARCH_MIN_LENGTH;

  useEffect(() => {
    if (!searchable) return;
    const id = (sequence.current += 1);
    const timer = window.setTimeout(async () => {
      let hits: SearchHit[] = [];
      try {
        hits = await searchAction(term);
      } catch {
        // The action itself never throws; a lost connection can.
      }
      if (id === sequence.current) setAnswer({ term, hits });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [term, searchable]);

  const hits = useMemo(() => (searchable ? answer.hits : []), [searchable, answer.hits]);
  const groups = useMemo(() => groupHits(hits), [hits]);
  const loading = searchable && answer.term !== term;
  const empty = searchable && answer.term === term && hits.length === 0;
  const ticketNumber = useMemo(() => ticketNumberFromQuery(query), [query]);

  const remember = useCallback((hit: SearchHit) => {
    setRecent((current) => {
      const next = rememberRecent(current, hit, Date.now());
      writeRecent(next);
      return next;
    });
  }, []);

  const findTicket = useCallback(
    async (number: string): Promise<SearchHit | null> => {
      const known = ticketHit(answer.hits, number);
      if (known) return known;
      try {
        return ticketHit(await searchAction(number), number);
      } catch {
        return null;
      }
    },
    [answer.hits],
  );

  return {
    query,
    setQuery,
    term,
    searchable,
    hits,
    groups,
    loading,
    empty,
    ticketNumber,
    recent,
    remember,
    findTicket,
  };
}
