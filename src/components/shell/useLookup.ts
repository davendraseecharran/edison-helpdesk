'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchAction } from '@/lib/data/search-actions';
import { useRuntime } from '@/components/AppRuntime';
import { mergeHits, searchLocal } from '@/lib/lookup/local-index';
import { useSearchIndex, warmSearchIndex } from '@/lib/lookup/local-store';
import { recognisePaste, type Recognition } from '@/lib/lookup/recognise';
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
  /**
   * The term the search actually asks for: the recognised identifier where the
   * text was one, otherwise the trimmed query. Typing `a91001` searches for
   * `A-91001`, which is the spelling the sticker does not have and the database
   * does.
   */
  term: string;
  /** What the text was read as: an asset tag, an OSIS, a ticket number, or nothing. */
  recognition: Recognition;
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
 *
 * People and machines answer before any of that: the session's index
 * (`local-index.ts`) is searched on every keystroke, so a name or a tag is
 * on screen as it is typed, and the server's answer — tickets, groups,
 * events, forms, and anything the index cannot know — lands on top of it.
 */
export function useLookup(): LookupState {
  const { actor } = useRuntime();
  const index = useSearchIndex(actor.id);
  // The palette opening is the moment an index older than five minutes is
  // worth reading again; the first read happens at launch (IntentPrefetch).
  useEffect(() => {
    void warmSearchIndex(actor.id);
  }, [actor.id]);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<RecentItem[]>(readRecent);
  /** The latest answer and the term it answers. */
  const [answer, setAnswer] = useState<{ term: string; hits: SearchHit[] }>({ term: '', hits: [] });
  const sequence = useRef(0);

  /*
   * What was typed or pasted, read before it is searched for.
   *
   * The recogniser is what lets a paste work at all: `a91001` and `A-91001`
   * are the same sticker, `edt1042` and `EDT-1042` the same ticket, and a whole
   * spreadsheet row pasted in one go is about the asset tag inside it. The
   * normalised value is what goes to the database, so none of those spellings
   * has to be a separate index.
   */
  const recognition = useMemo(() => recognisePaste(query), [query]);
  const term = recognition.value;
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

  const local = useMemo(() => (searchable ? searchLocal(index, term) : []), [index, term, searchable]);
  const answered = answer.term === term;
  const hits = useMemo(() => {
    if (!searchable) return [];
    if (answered) return mergeHits(local, answer.hits);
    // The server has not answered this text yet: what the index found, and the
    // previous answer's other kinds so the list does not blink between keys.
    if (local.length === 0) return answer.hits;
    return [...local, ...answer.hits.filter((hit) => hit.kind !== 'person' && hit.kind !== 'device')];
  }, [searchable, answered, local, answer.hits]);
  const groups = useMemo(() => groupHits(hits), [hits]);
  const loading = searchable && !answered && local.length === 0;
  const empty = searchable && answered && hits.length === 0;
  const ticketNumber = useMemo(
    () => (recognition.kind === 'ticket' ? recognition.value : ticketNumberFromQuery(query)),
    [recognition, query],
  );

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
    recognition,
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
