'use server';

/**
 * The lookup's one network call.
 *
 * `app_search` is SECURITY INVOKER, so the rows it returns are exactly the
 * rows the caller's own policies allow: a technician who types a colleague's
 * ticket number gets nothing, and learns nothing from the absence. This action
 * adds no filtering of its own and passes nothing but the trimmed text.
 *
 * It never throws to the browser. A palette that crashed on a flaky request
 * would take the whole shell down with it, so every failure is an empty list,
 * logged server-side without the query text: what an operator types can be a
 * child's name or OSIS and does not belong in a log line.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { hitFromRow, SEARCH_MIN_LENGTH, type SearchHit } from './search';

/** Hits per kind. The palette shows a few of each, not a page. */
const SEARCH_LIMIT = 8;

export async function searchAction(query: string): Promise<SearchHit[]> {
  const term = typeof query === 'string' ? query.trim() : '';
  if (term.length < SEARCH_MIN_LENGTH) return [];

  try {
    const actor = await loadActor();
    if (actor.kind !== 'active') return [];

    const supabase = await createClient();
    const { data, error } = await supabase.rpc('app_search', {
      p_query: term,
      p_limit: SEARCH_LIMIT,
    });
    if (error) {
      console.error(`app_search failed (${error.code ?? 'no code'})`);
      return [];
    }

    const hits: SearchHit[] = [];
    for (const row of Array.isArray(data) ? data : []) {
      const hit = hitFromRow(row);
      if (hit) hits.push(hit);
    }
    return hits;
  } catch (cause) {
    console.error(`searchAction failed (${cause instanceof Error ? cause.name : 'unknown'})`);
    return [];
  }
}
